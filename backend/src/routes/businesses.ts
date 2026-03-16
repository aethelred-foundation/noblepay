import { Router, Response } from "express";
import { PrismaClient, KYCStatus, BusinessTier, Prisma } from "@prisma/client";
import { AuthenticatedRequest, authenticateAPIKey, generateAPIKey } from "../middleware/auth";
import {
  validate,
  CreateBusinessSchema,
  UpdateBusinessSchema,
  ListBusinessesSchema,
} from "../middleware/validation";
import { extractRole, requireOwnership, requirePermission, requireRole, RBACRequest } from "../middleware/rbac";
import { AuditService } from "../services/audit";
import { activeBusinesses } from "../lib/metrics";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();
const auditService = new AuditService(prisma);

const router = Router();

// Tier limits configuration
const TIER_LIMITS: Record<BusinessTier, { daily: number; monthly: number }> = {
  STARTER: { daily: 10000, monthly: 100000 },
  STANDARD: { daily: 50000, monthly: 500000 },
  ENTERPRISE: { daily: 500000, monthly: 5000000 },
  INSTITUTIONAL: { daily: 5000000, monthly: 50000000 },
};

// ─── POST /v1/businesses — Register new business ───────────────────────────

router.post(
  "/",
  validate(CreateBusinessSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      // Check for existing business with same address or license
      const existing = await prisma.business.findFirst({
        where: {
          OR: [
            { address: req.body.address },
            { licenseNumber: req.body.licenseNumber },
          ],
        },
      });

      if (existing) {
        res.status(409).json({
          error: "DUPLICATE_BUSINESS",
          message: "A business with this address or license number already exists",
        });
        return;
      }

      const business = await prisma.business.create({
        data: {
          address: req.body.address,
          licenseNumber: req.body.licenseNumber,
          businessName: req.body.businessName,
          jurisdiction: req.body.jurisdiction,
          businessType: req.body.businessType,
          complianceOfficer: req.body.complianceOfficer || null,
          contactEmail: req.body.contactEmail,
          kycStatus: "UNVERIFIED",
          tier: "STARTER",
          dailyLimit: TIER_LIMITS.STARTER.daily,
          monthlyLimit: TIER_LIMITS.STARTER.monthly,
        },
      });

      // Generate initial API key
      const { rawKey, keyHash } = generateAPIKey();
      await prisma.aPIKey.create({
        data: {
          businessId: business.id,
          keyHash,
          name: "Default API Key",
          status: "ACTIVE",
        },
      });

      await auditService.createAuditEntry({
        eventType: "BUSINESS_REGISTERED",
        actor: req.body.address,
        description: `Business "${req.body.businessName}" registered in ${req.body.jurisdiction}`,
        severity: "INFO",
        metadata: {
          businessId: business.id,
          jurisdiction: req.body.jurisdiction,
          businessType: req.body.businessType,
        },
      });

      logger.info("Business registered", {
        businessId: business.id,
        businessName: req.body.businessName,
      });

      res.status(201).json({
        success: true,
        data: {
          ...business,
          dailyLimit: business.dailyLimit.toString(),
          monthlyLimit: business.monthlyLimit.toString(),
        },
        apiKey: rawKey, // Only returned once at registration
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/businesses — List businesses ───────────────────────────────────

router.get(
  "/",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN"),
  validate(ListBusinessesSchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { page, limit, sortOrder, kycStatus, tier, jurisdiction } = req.query as any;

      const where: Prisma.BusinessWhereInput = {};
      if (kycStatus) where.kycStatus = kycStatus as KYCStatus;
      if (tier) where.tier = tier as BusinessTier;
      if (jurisdiction) where.jurisdiction = { contains: jurisdiction, mode: "insensitive" };

      const [data, total] = await Promise.all([
        prisma.business.findMany({
          where,
          orderBy: { registeredAt: sortOrder || "desc" },
          skip: ((page || 1) - 1) * (limit || 20),
          take: limit || 20,
        }),
        prisma.business.count({ where }),
      ]);

      res.json({
        success: true,
        data: data.map((b) => ({
          ...b,
          dailyLimit: b.dailyLimit.toString(),
          monthlyLimit: b.monthlyLimit.toString(),
        })),
        pagination: {
          page: page || 1,
          limit: limit || 20,
          total,
          totalPages: Math.ceil(total / (limit || 20)),
        },
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/businesses/:id — Get business details ──────────────────────────

router.get(
  "/:id",
  authenticateAPIKey,
  extractRole,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      // Tenant isolation: verify caller owns the resource or is admin
      if (!requireOwnership(req as RBACRequest, req.params.id)) {
        res.status(403).json({
          error: "FORBIDDEN",
          message: "You do not have access to this business record",
        });
        return;
      }

      const business = await prisma.business.findUnique({
        where: { id: req.params.id },
        include: {
          apiKeys: {
            select: {
              id: true,
              name: true,
              lastUsed: true,
              status: true,
              createdAt: true,
            },
          },
        },
      });

      if (!business) {
        res.status(404).json({
          error: "BUSINESS_NOT_FOUND",
          message: "Business not found",
        });
        return;
      }

      res.json({
        success: true,
        data: {
          ...business,
          dailyLimit: business.dailyLimit.toString(),
          monthlyLimit: business.monthlyLimit.toString(),
        },
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── PATCH /v1/businesses/:id — Update business ────────────────────────────

router.patch(
  "/:id",
  authenticateAPIKey,
  extractRole,
  requirePermission("businesses:manage"),
  validate(UpdateBusinessSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      // Tenant isolation: only the owning business can update its own record
      if (req.businessId !== req.params.id) {
        res.status(403).json({
          error: "FORBIDDEN",
          message: "You can only update your own business record",
        });
        return;
      }

      const business = await prisma.business.findUnique({
        where: { id: req.params.id },
      });

      if (!business) {
        res.status(404).json({
          error: "BUSINESS_NOT_FOUND",
          message: "Business not found",
        });
        return;
      }

      const updated = await prisma.business.update({
        where: { id: req.params.id },
        data: req.body,
      });

      res.json({
        success: true,
        data: {
          ...updated,
          dailyLimit: updated.dailyLimit.toString(),
          monthlyLimit: updated.monthlyLimit.toString(),
        },
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/businesses/:id/verify — Verify business KYC ──────────────────

router.post(
  "/:id/verify",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN", "COMPLIANCE_OFFICER"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const business = await prisma.business.findUnique({
        where: { id: req.params.id },
      });

      if (!business) {
        res.status(404).json({
          error: "BUSINESS_NOT_FOUND",
          message: "Business not found",
        });
        return;
      }

      if (business.kycStatus === "VERIFIED") {
        res.status(409).json({
          error: "ALREADY_VERIFIED",
          message: "Business is already verified",
        });
        return;
      }

      const updated = await prisma.business.update({
        where: { id: req.params.id },
        data: {
          kycStatus: "VERIFIED",
          lastVerified: new Date(),
        },
      });

      // Update active businesses metric
      const verifiedCount = await prisma.business.count({
        where: { kycStatus: "VERIFIED" },
      });
      activeBusinesses.set({ tier: updated.tier }, verifiedCount);

      await auditService.createAuditEntry({
        eventType: "BUSINESS_VERIFIED",
        actor: req.businessId || "system",
        description: `Business "${business.businessName}" KYC verified`,
        severity: "INFO",
        metadata: { businessId: business.id },
      });

      res.json({
        success: true,
        data: {
          ...updated,
          dailyLimit: updated.dailyLimit.toString(),
          monthlyLimit: updated.monthlyLimit.toString(),
        },
        message: "Business KYC verified successfully",
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/businesses/:id/suspend — Suspend business ────────────────────

router.post(
  "/:id/suspend",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const business = await prisma.business.findUnique({
        where: { id: req.params.id },
      });

      if (!business) {
        res.status(404).json({
          error: "BUSINESS_NOT_FOUND",
          message: "Business not found",
        });
        return;
      }

      if (business.kycStatus === "SUSPENDED") {
        res.status(409).json({
          error: "ALREADY_SUSPENDED",
          message: "Business is already suspended",
        });
        return;
      }

      const updated = await prisma.business.update({
        where: { id: req.params.id },
        data: { kycStatus: "SUSPENDED" },
      });

      // Revoke all active API keys
      await prisma.aPIKey.updateMany({
        where: { businessId: req.params.id, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: new Date() },
      });

      await auditService.createAuditEntry({
        eventType: "BUSINESS_SUSPENDED",
        actor: req.businessId || "system",
        description: `Business "${business.businessName}" suspended. All API keys revoked.`,
        severity: "HIGH",
        metadata: {
          businessId: business.id,
          reason: req.body.reason || "No reason provided",
        },
      });

      logger.warn("Business suspended", {
        businessId: business.id,
        businessName: business.businessName,
      });

      res.json({
        success: true,
        data: {
          ...updated,
          dailyLimit: updated.dailyLimit.toString(),
          monthlyLimit: updated.monthlyLimit.toString(),
        },
        message: "Business suspended. All API keys have been revoked.",
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/businesses/:id/upgrade — Upgrade business tier ────────────────

router.post(
  "/:id/upgrade",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const business = await prisma.business.findUnique({
        where: { id: req.params.id },
      });

      if (!business) {
        res.status(404).json({
          error: "BUSINESS_NOT_FOUND",
          message: "Business not found",
        });
        return;
      }

      if (business.kycStatus !== "VERIFIED") {
        res.status(403).json({
          error: "KYC_REQUIRED",
          message: "Business must be KYC verified before tier upgrade",
        });
        return;
      }

      const tierOrder: BusinessTier[] = ["STARTER", "STANDARD", "ENTERPRISE", "INSTITUTIONAL"];
      const currentIndex = tierOrder.indexOf(business.tier);

      if (currentIndex >= tierOrder.length - 1) {
        res.status(409).json({
          error: "MAX_TIER",
          message: "Business is already at the highest tier",
        });
        return;
      }

      const newTier = tierOrder[currentIndex + 1];
      const newLimits = TIER_LIMITS[newTier];

      const updated = await prisma.business.update({
        where: { id: req.params.id },
        data: {
          tier: newTier,
          dailyLimit: newLimits.daily,
          monthlyLimit: newLimits.monthly,
        },
      });

      await auditService.createAuditEntry({
        eventType: "BUSINESS_UPGRADED",
        actor: req.businessId || "system",
        description: `Business "${business.businessName}" upgraded from ${business.tier} to ${newTier}`,
        severity: "INFO",
        metadata: {
          businessId: business.id,
          previousTier: business.tier,
          newTier,
          dailyLimit: newLimits.daily,
          monthlyLimit: newLimits.monthly,
        },
      });

      res.json({
        success: true,
        data: {
          ...updated,
          dailyLimit: updated.dailyLimit.toString(),
          monthlyLimit: updated.monthlyLimit.toString(),
        },
        message: `Business upgraded to ${newTier} tier`,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/businesses/:id/limits — Get payment limits & usage ─────────────

router.get(
  "/:id/limits",
  authenticateAPIKey,
  extractRole,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      // Ownership check: caller must own the resource or be admin
      if (!requireOwnership(req as RBACRequest, req.params.id)) {
        res.status(403).json({
          error: "FORBIDDEN",
          message: "You do not have access to this business's limits",
        });
        return;
      }

      const business = await prisma.business.findUnique({
        where: { id: req.params.id },
      });

      if (!business) {
        res.status(404).json({
          error: "BUSINESS_NOT_FOUND",
          message: "Business not found",
        });
        return;
      }

      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const [dailyUsage, monthlyUsage] = await Promise.all([
        prisma.payment.aggregate({
          _sum: { amount: true },
          _count: { id: true },
          where: {
            sender: business.address,
            initiatedAt: { gte: startOfDay },
            status: { notIn: ["CANCELLED", "REFUNDED", "REJECTED"] },
          },
        }),
        prisma.payment.aggregate({
          _sum: { amount: true },
          _count: { id: true },
          where: {
            sender: business.address,
            initiatedAt: { gte: startOfMonth },
            status: { notIn: ["CANCELLED", "REFUNDED", "REJECTED"] },
          },
        }),
      ]);

      const dailyUsed = dailyUsage._sum.amount?.toString() || "0";
      const monthlyUsed = monthlyUsage._sum.amount?.toString() || "0";

      res.json({
        success: true,
        data: {
          tier: business.tier,
          daily: {
            limit: business.dailyLimit.toString(),
            used: dailyUsed,
            remaining: (
              parseFloat(business.dailyLimit.toString()) - parseFloat(dailyUsed)
            ).toString(),
            transactions: dailyUsage._count.id,
          },
          monthly: {
            limit: business.monthlyLimit.toString(),
            used: monthlyUsed,
            remaining: (
              parseFloat(business.monthlyLimit.toString()) - parseFloat(monthlyUsed)
            ).toString(),
            transactions: monthlyUsage._count.id,
          },
        },
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── Error Handler ──────────────────────────────────────────────────────────

function handleError(error: unknown, res: Response): void {
  logger.error("Unhandled business error", {
    error: (error as Error).message,
    stack: (error as Error).stack,
  });

  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "An internal error occurred",
  });
}

export default router;
