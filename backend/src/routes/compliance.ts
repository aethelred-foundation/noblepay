import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import {
  validate,
  ComplianceScreeningSchema,
  ReviewDecisionSchema,
} from "../middleware/validation";
import { ComplianceService, ComplianceError } from "../services/compliance";
import { AuditService } from "../services/audit";
import { extractRole, requirePermission, requireRole } from "../middleware/rbac";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();
const auditService = new AuditService(prisma);
const complianceService = new ComplianceService(prisma, auditService);

const router = Router();

// ─── POST /v1/compliance/screen — Submit payment for screening ──────────────

router.post(
  "/screen",
  authenticateAPIKey,
  extractRole,
  requirePermission("compliance:manage"),
  validate(ComplianceScreeningSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await complianceService.submitForScreening(req.body);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/compliance/status — Compliance engine status ───────────────────

router.get(
  "/status",
  authenticateAPIKey,
  extractRole,
  requirePermission("compliance:read"),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const sanctions = complianceService.getSanctionsStatus();
      const teeNodes = await prisma.tEENode.findMany({
        where: { status: "ACTIVE" },
      });

      res.json({
        success: true,
        data: {
          engineStatus: "operational",
          sanctions,
          activeTEENodes: teeNodes.length,
          teeNodes: teeNodes.map((n) => ({
            address: n.address,
            lastHeartbeat: n.lastHeartbeat,
            attestationValid: n.attestationValid,
          })),
        },
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/compliance/metrics — Screening metrics ─────────────────────────

router.get(
  "/metrics",
  authenticateAPIKey,
  extractRole,
  requirePermission("compliance:read"),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const metrics = await complianceService.getComplianceMetrics();

      res.json({
        success: true,
        data: metrics,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/compliance/screenings/:paymentId — Get screening result ────────

router.get(
  "/screenings/:paymentId",
  authenticateAPIKey,
  extractRole,
  requirePermission("compliance:read"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const screenings = await complianceService.getScreeningResult(
        req.params.paymentId,
      );

      res.json({
        success: true,
        data: screenings,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/compliance/sanctions/update — Trigger sanctions refresh ───────

router.post(
  "/sanctions/update",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN"),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await complianceService.updateSanctionsList();

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/compliance/sanctions/status — Sanctions list freshness ─────────

router.get(
  "/sanctions/status",
  authenticateAPIKey,
  extractRole,
  requirePermission("compliance:read"),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const status = complianceService.getSanctionsStatus();

      res.json({
        success: true,
        data: status,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/compliance/flagged — Flagged payments queue ────────────────────

router.get(
  "/flagged",
  authenticateAPIKey,
  extractRole,
  requirePermission("compliance:read"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;

      const result = await complianceService.getFlaggedPayments(page, limit);

      res.json({
        success: true,
        data: result.data.map((p) => ({
          ...p,
          amount: p.amount.toString(),
        })),
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/compliance/flagged/:id/review — Submit review decision ────────

router.post(
  "/flagged/:id/review",
  authenticateAPIKey,
  extractRole,
  requirePermission("compliance:override"),
  validate(ReviewDecisionSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await complianceService.reviewFlaggedPayment(
        req.params.id,
        req.body.decision,
        req.body.reason,
        req.body.reviewerAddress,
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── Error Handler ──────────────────────────────────────────────────────────

function handleError(error: unknown, res: Response): void {
  if (error instanceof ComplianceError) {
    res.status(error.statusCode).json({
      error: error.code,
      message: error.message,
    });
    return;
  }

  logger.error("Unhandled compliance error", {
    error: (error as Error).message,
    stack: (error as Error).stack,
  });

  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "An internal error occurred",
  });
}

export default router;
