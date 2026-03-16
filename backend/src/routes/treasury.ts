import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { extractRole, requireRole, requirePermission } from "../middleware/rbac";
import { TreasuryService, TreasuryError } from "../services/treasury";
import { AuditService } from "../services/audit";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();
const auditService = new AuditService(prisma);
const treasuryService = new TreasuryService(prisma, auditService);

const router = Router();

// ─── GET /v1/treasury/overview — Treasury overview ──────────────────────────

router.get(
  "/overview",
  authenticateAPIKey,
  extractRole,
  requirePermission("treasury:read"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const overview = await treasuryService.getOverview(req.businessId || "default");
      res.json({ success: true, data: overview });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/treasury/proposals — Create proposal ─────────────────────────

router.post(
  "/proposals",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN", "TREASURY_MANAGER"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const proposal = await treasuryService.createProposal(
        req.body,
        req.businessId || "unknown",
        req.businessId || "default",
      );
      res.status(201).json({ success: true, data: proposal });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/treasury/proposals/:id/approve — Approve proposal ────────────

router.post(
  "/proposals/:id/approve",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN", "TREASURY_MANAGER"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.signerId) {
        res.status(401).json({ error: "UNAUTHORIZED", message: "Signer identity required for treasury approvals" });
        return;
      }
      const result = await treasuryService.approveProposal(
        req.params.id,
        req.signerId,
        req.businessId || "unknown",
      );
      res.json({ success: true, data: result });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/treasury/proposals/:id/execute — Execute proposal ────────────

router.post(
  "/proposals/:id/execute",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN", "TREASURY_MANAGER"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.signerId) {
        res.status(401).json({ error: "UNAUTHORIZED", message: "Signer identity required for treasury execution" });
        return;
      }
      const result = await treasuryService.executeProposal(
        req.params.id,
        req.signerId,
        req.businessId || "unknown",
      );
      res.json({ success: true, data: result });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/treasury/policies — Get spending policies ──────────────────────

router.get(
  "/policies",
  authenticateAPIKey,
  extractRole,
  requirePermission("treasury:read"),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const policies = treasuryService.getSpendingPolicies();
      res.json({ success: true, data: policies });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/treasury/yield — Get yield strategies ──────────────────────────

router.get(
  "/yield",
  authenticateAPIKey,
  extractRole,
  requirePermission("treasury:read"),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const strategies = treasuryService.getYieldStrategies();
      res.json({ success: true, data: strategies });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/treasury/analytics — Treasury analytics ────────────────────────

router.get(
  "/analytics",
  authenticateAPIKey,
  extractRole,
  requirePermission("treasury:read"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const period = (req.query.period as string) || "month";
      const analytics = await treasuryService.getAnalytics(
        req.businessId || "default",
        period as "day" | "week" | "month" | "quarter",
      );
      res.json({ success: true, data: analytics });
    } catch (error) {
      handleError(error, res);
    }
  },
);

function handleError(error: unknown, res: Response): void {
  if (error instanceof TreasuryError) {
    res.status(error.statusCode).json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled treasury error", { error: (error as Error).message });
  res.status(500).json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
