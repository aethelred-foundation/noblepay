import { Router, Response } from "express";
import { prisma } from "../lib/db";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import {
  validate,
  ComplianceScreeningSchema,
  FlaggedPaymentsQuerySchema,
  ReviewDecisionSchema,
  TravelRuleAuthorizationSchema,
  TravelRuleChallengeSchema,
} from "../middleware/validation";
import { ComplianceService, ComplianceError } from "../services/compliance";
import { AuditService } from "../services/audit";
import {
  extractRole,
  requireCurrentPlatformAdmin,
  requirePermission,
} from "../middleware/rbac";
import { logger } from "../lib/logger";
import { wsService, WSEventType, WSTenantChannel } from "../services/websocket";
import { TravelRuleError, TravelRuleService } from "../services/travel-rule";

const auditService = new AuditService(prisma);
const travelRuleService = new TravelRuleService(prisma);
const complianceService = new ComplianceService(
  prisma,
  auditService,
  undefined,
  travelRuleService,
);

const router = Router();

// ─── Travel Rule wallet authorization ──────────────────────────────────────

router.get(
  "/travel-rule/requirements/:paymentId",
  authenticateAPIKey,
  extractRole,
  requirePermission("compliance:manage"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await travelRuleService.getRequirement(
        req.params.paymentId,
        req.businessId!,
      );
      res.setHeader("Cache-Control", "no-store");
      res.json({ success: true, data: result });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/travel-rule/challenge",
  authenticateAPIKey,
  extractRole,
  requirePermission("compliance:manage"),
  validate(TravelRuleChallengeSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await travelRuleService.createChallenge({
        paymentRecordId: req.body.paymentId,
        data: req.body.data,
        businessId: req.businessId!,
        signerId: req.signerId,
        apiKeyId: req.apiKeyId,
      });
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/travel-rule/authorize",
  authenticateAPIKey,
  extractRole,
  requirePermission("compliance:manage"),
  validate(TravelRuleAuthorizationSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await travelRuleService.authorize({
        paymentRecordId: req.body.paymentId,
        challengeId: req.body.challengeId,
        signature: req.body.signature,
        data: req.body.data,
        businessId: req.businessId!,
        signerId: req.signerId,
        apiKeyId: req.apiKeyId,
      });
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/compliance/screen — Submit payment for screening ──────────────

router.post(
  "/screen",
  authenticateAPIKey,
  extractRole,
  requirePermission("compliance:manage"),
  validate(ComplianceScreeningSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await complianceService.submitForScreening(
        req.body,
        req.businessId!,
      );
      const event = {
        event: "screening_completed",
        screeningId: result.id,
        paymentId: result.paymentId,
        status: result.status,
        riskScore: result.amlRiskScore,
        sanctionsClear: result.sanctionsClear,
        travelRuleCompliant: result.travelRuleCompliant,
        submissionTxHash: result.submissionTxHash,
        submissionBlockNumber: result.submissionBlockNumber,
        confirmations: result.confirmations,
      };
      publishTenantEvent(
        "compliance",
        "compliance_decision",
        event,
        req.businessId!,
      );
      publishTenantEvent("risk", "risk_update", event, req.businessId!);

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
      const sanctions = await complianceService.getSanctionsStatus();
      const checkedAt = new Date().toISOString();

      res.json({
        success: true,
        data: {
          engineStatus: "healthy",
          checkedAt,
          settlementEvidence: "verified_per_submission",
          sanctions,
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
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const metrics = await complianceService.getComplianceMetrics(
        req.businessId!,
      );

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
        req.businessId!,
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
  requireCurrentPlatformAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await complianceService.updateSanctionsList(req.signerId!);

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
      const status = await complianceService.getSanctionsStatus();

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
  validate(FlaggedPaymentsQuerySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { page, limit } = req.query as unknown as {
        page: number;
        limit: number;
      };

      const result = await complianceService.getFlaggedPayments(
        req.businessId!,
        page,
        limit,
      );

      res.json({
        success: true,
        data: result.data.map((p) => ({
          ...p,
          amount: p.amount.toString(),
          blockNumber: p.blockNumber?.toString() || null,
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
        req.signerId!,
        req.businessId!,
      );
      const event = {
        event: "review_recorded",
        paymentId: result.paymentId,
        decision: result.decision,
        status: result.newStatus,
        reviewedAt:
          result.reviewedAt instanceof Date
            ? result.reviewedAt.toISOString()
            : result.reviewedAt,
      };
      publishTenantEvent(
        "compliance",
        "compliance_decision",
        event,
        req.businessId!,
      );
      publishTenantEvent("risk", "risk_update", event, req.businessId!);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

function publishTenantEvent(
  channel: WSTenantChannel,
  type: WSEventType,
  payload: Record<string, unknown>,
  businessId: string,
): void {
  const reportFailure = (_error: unknown) => {
    // The service transaction has committed. Live delivery is best-effort;
    // persisted screening and review records remain the source of truth.
    logger.warn("Compliance WebSocket notification failed", {
      channel,
    });
  };

  try {
    void Promise.resolve(
      wsService.broadcast(channel, type, payload, businessId),
    ).catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}

// ─── Error Handler ──────────────────────────────────────────────────────────

function handleError(error: unknown, res: Response): void {
  if (error instanceof ComplianceError || error instanceof TravelRuleError) {
    res.status(error.statusCode).json({
      error: error.code,
      message: error.message,
    });
    return;
  }

  logger.error("Unhandled compliance error");

  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "An internal error occurred",
  });
}

export default router;
