import { Router, Response } from "express";
import { Business, KYCStatus, BusinessTier, Prisma } from "@prisma/client";
import { prisma } from "../lib/db";
import {
  AuthenticatedRequest,
  authenticateAPIKey,
  createPublicRateLimit,
} from "../middleware/auth";
import {
  validate,
  CreateBusinessSchema,
  UpdateBusinessSchema,
  ListBusinessesSchema,
  BusinessVerificationSchema,
  BusinessTierUpgradeSchema,
  type ListBusinessesInput,
} from "../middleware/validation";
import {
  extractRole,
  requireCurrentPlatformAdmin,
  requireOwnership,
  requirePermission,
  revalidatePlatformAdmin,
  RBACRequest,
} from "../middleware/rbac";
import { AuditService } from "../services/audit";
import { activeBusinesses } from "../lib/metrics";
import { logger } from "../lib/logger";
import {
  BusinessRegistrationError,
  BusinessRegistrationService,
} from "../services/business-registration";
import {
  BusinessReconciliationError,
  BusinessReconciliationService,
} from "../services/business-reconciliation";

const auditService = new AuditService(prisma);
const registrationService = new BusinessRegistrationService(
  prisma,
  auditService,
);
const reconciliationService = new BusinessReconciliationService(
  prisma,
  auditService,
);

const router = Router();
const registrationLimiter = createPublicRateLimit({
  scope: "business-registration",
  limit: 5,
  key: (req) =>
    typeof req.body?.address === "string" ? req.body.address : req.ip,
});

// ─── POST /v1/businesses — Register new business ───────────────────────────

router.post(
  "/",
  registrationLimiter,
  validate(CreateBusinessSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await registrationService.register(req.body);
      res.status(result.replayed ? 200 : 201).json({
        success: true,
        data: {
          business: {
            ...result.business,
            dailyLimit: result.business.dailyLimit.toString(),
            monthlyLimit: result.business.monthlyLimit.toString(),
            registrationBlockNumber:
              result.business.registrationBlockNumber?.toString() || null,
          },
          apiKey: result.apiKey,
          replayed: result.replayed,
          confirmations: result.confirmations,
          chainId: result.chainId,
        },
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
  requireCurrentPlatformAdmin,
  validate(ListBusinessesSchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { page, limit, sortOrder, kycStatus, tier, jurisdiction, search } =
        req.query as unknown as ListBusinessesInput;

      const where: Prisma.BusinessWhereInput = {};
      if (kycStatus) where.kycStatus = kycStatus as KYCStatus;
      if (tier) where.tier = tier as BusinessTier;
      if (jurisdiction)
        where.jurisdiction = { contains: jurisdiction, mode: "insensitive" };
      if (search) {
        where.OR = [
          { businessName: { contains: search, mode: "insensitive" } },
          { licenseNumber: { contains: search, mode: "insensitive" } },
          { address: { contains: search, mode: "insensitive" } },
        ];
      }

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
          registrationBlockNumber:
            b.registrationBlockNumber?.toString() || null,
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
  revalidatePlatformAdmin,
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
          registrationBlockNumber:
            business.registrationBlockNumber?.toString() || null,
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
          registrationBlockNumber:
            updated.registrationBlockNumber?.toString() || null,
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
  requireCurrentPlatformAdmin,
  validate(BusinessVerificationSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await reconciliationService.reconcileVerification(
        req.params.id,
        req.body.txHash,
      );
      const verifiedCount = await prisma.business.count({
        where: { kycStatus: "VERIFIED", tier: result.business.tier },
      });
      activeBusinesses.set({ tier: result.business.tier }, verifiedCount);

      res.json({
        success: true,
        data: {
          business: serializeBusiness(result.business),
          replayed: result.replayed,
          txHash: result.txHash,
          confirmations: result.confirmations,
          chainId: result.chainId,
        },
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

for (const [path, reconcile] of [
  [
    "suspend",
    reconciliationService.reconcileSuspension.bind(reconciliationService),
  ],
  [
    "reinstate",
    reconciliationService.reconcileReinstatement.bind(reconciliationService),
  ],
  [
    "revoke",
    reconciliationService.reconcileRevocation.bind(reconciliationService),
  ],
] as const) {
  router.post(
    `/:id/${path}`,
    authenticateAPIKey,
    extractRole,
    requirePermission("businesses:manage"),
    requireCurrentPlatformAdmin,
    validate(BusinessVerificationSchema),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      try {
        const result = await reconcile(req.params.id, req.body.txHash);
        res.json({
          success: true,
          data: {
            business: serializeBusiness(result.business),
            replayed: result.replayed,
            txHash: result.txHash,
            confirmations: result.confirmations,
            chainId: result.chainId,
          },
        });
      } catch (error) {
        handleError(error, res);
      }
    },
  );
}

// ─── POST /v1/businesses/:id/upgrade — Upgrade business tier ────────────────

router.post(
  "/:id/upgrade",
  authenticateAPIKey,
  extractRole,
  requirePermission("businesses:manage"),
  requireCurrentPlatformAdmin,
  validate(BusinessTierUpgradeSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await reconciliationService.reconcileTierUpgrade(
        req.params.id,
        req.body.newTier,
        req.body.txHash,
      );

      res.json({
        success: true,
        data: {
          business: serializeBusiness(result.business),
          replayed: result.replayed,
          txHash: result.txHash,
          confirmations: result.confirmations,
          chainId: result.chainId,
        },
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
  revalidatePlatformAdmin,
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

      const limits = await reconciliationService.getOnChainLimits(
        req.params.id,
      );
      res.json({
        success: true,
        data: limits,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── Error Handler ──────────────────────────────────────────────────────────

function handleError(error: unknown, res: Response): void {
  if (
    error instanceof BusinessRegistrationError ||
    error instanceof BusinessReconciliationError
  ) {
    res
      .status(error.statusCode)
      .json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled business error", {
    error: (error as Error).message,
    stack: (error as Error).stack,
  });

  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "An internal error occurred",
  });
}

function serializeBusiness(business: Business): Record<string, unknown> {
  return {
    ...business,
    dailyLimit: business.dailyLimit.toString(),
    monthlyLimit: business.monthlyLimit.toString(),
    registrationBlockNumber:
      business.registrationBlockNumber?.toString() || null,
  };
}

export default router;
