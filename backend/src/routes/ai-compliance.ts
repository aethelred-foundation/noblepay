import { Router, Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { extractRole, requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validation";
import { AuditService } from "../services/audit";
import {
  AIComplianceError,
  AIComplianceService,
} from "../services/ai-compliance";
import { logger } from "../lib/logger";
import { prisma } from "../lib/db";

const auditService = new AuditService(prisma);
const aiService = new AIComplianceService(prisma, auditService);
const router = Router();

const outcome = z.enum(["APPROVE", "FLAG", "BLOCK", "ESCALATE"]);
const modelQuery = z
  .object({
    status: z
      .enum(["ACTIVE", "STAGING", "DEPRECATED", "UNDER_REVIEW"])
      .optional(),
  })
  .strict();
const modelParams = z.object({ id: z.string().min(1).max(100) }).strict();
const decisionParams = z
  .object({
    id: z
      .string()
      .min(5)
      .max(100)
      .regex(/^dec-[a-zA-Z0-9-]+$/),
  })
  .strict();
const appealParams = z.object({ id: z.string().uuid() }).strict();
const decisionQuery = z
  .object({
    modelId: z.string().min(1).max(100).optional(),
    paymentId: z.string().min(1).max(100).optional(),
    outcome: outcome.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const runDecisionSchema = z
  .object({
    modelId: z.string().min(1).max(100),
    paymentId: z.string().min(1).max(100),
  })
  .strict();
const overrideSchema = z
  .object({
    outcome,
    reason: z.string().trim().min(10).max(2_000),
  })
  .strict();
const appealSchema = z
  .object({ reason: z.string().trim().min(10).max(2_000) })
  .strict();
const resolveAppealSchema = z
  .object({
    outcome: z.enum(["UPHELD", "OVERTURNED", "DISMISSED"]),
    reviewNotes: z.string().trim().min(10).max(2_000),
    finalOutcome: outcome.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === "OVERTURNED" && !value.finalOutcome) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finalOutcome"],
        message: "finalOutcome is required when overturning an appeal",
      });
    }
  });

function tenant(req: AuthenticatedRequest): string {
  if (!req.businessId)
    throw new AIComplianceError(
      "TENANT_REQUIRED",
      "Authenticated business is required",
      401,
    );
  return req.businessId;
}

function actor(req: AuthenticatedRequest): string {
  return req.signerId || req.jwtPayload?.sub || "authenticated-user";
}

function idempotencyKey(req: AuthenticatedRequest): string {
  const value = req.headers["idempotency-key"];
  const key = Array.isArray(value) ? value[0] : value;
  if (typeof key !== "string" || !/^[A-Za-z0-9._~-]{8,120}$/.test(key)) {
    throw new AIComplianceError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "A valid Idempotency-Key header is required",
      400,
    );
  }
  return key;
}

router.get(
  "/models",
  authenticateAPIKey,
  extractRole,
  requirePermission("ai:read"),
  validate(modelQuery, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      tenant(req);
      const models = await aiService.getModels(req.query.status as never);
      res.json({ success: true, data: models });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/models/:id",
  authenticateAPIKey,
  extractRole,
  requirePermission("ai:read"),
  validate(modelParams, "params"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      tenant(req);
      const model = await aiService.getModel(req.params.id);
      res.json({ success: true, data: model });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/analytics",
  authenticateAPIKey,
  extractRole,
  requirePermission("ai:read"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const analytics = await aiService.getAnalytics(tenant(req));
      res.json({ success: true, data: analytics });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/bias-metrics",
  authenticateAPIKey,
  extractRole,
  requirePermission("ai:read"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const metrics = await aiService.getBiasMetrics(tenant(req));
      res.json({ success: true, data: metrics });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/review-queue",
  authenticateAPIKey,
  extractRole,
  requirePermission("ai:manage"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const decisions = await aiService.getHumanReviewQueue(tenant(req));
      res.json({ success: true, data: decisions });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/appeals",
  authenticateAPIKey,
  extractRole,
  requirePermission("ai:read"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const appeals = await aiService.listAppeals(tenant(req));
      res.json({ success: true, data: appeals });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/appeals/:id/resolve",
  authenticateAPIKey,
  extractRole,
  requirePermission("ai:override"),
  validate(appealParams, "params"),
  validate(resolveAppealSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const appeal = await aiService.resolveAppeal(
        req.params.id,
        actor(req),
        req.body.outcome,
        req.body.reviewNotes,
        tenant(req),
        req.body.finalOutcome,
      );
      res.json({ success: true, data: appeal });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/decisions",
  authenticateAPIKey,
  extractRole,
  requirePermission("ai:manage"),
  validate(runDecisionSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const decision = await aiService.runDecision(
        req.body.modelId,
        req.body.paymentId,
        tenant(req),
        idempotencyKey(req),
      );
      res.status(201).json({ success: true, data: decision });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/decisions",
  authenticateAPIKey,
  extractRole,
  requirePermission("ai:read"),
  validate(decisionQuery, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const decisions = await aiService.listDecisions({
        businessId: tenant(req),
        modelId: req.query.modelId as string | undefined,
        paymentId: req.query.paymentId as string | undefined,
        outcome: req.query.outcome as never,
        limit: Number(req.query.limit),
      });
      res.json({ success: true, data: decisions });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/decisions/:id",
  authenticateAPIKey,
  extractRole,
  requirePermission("ai:read"),
  validate(decisionParams, "params"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const decision = await aiService.getDecision(req.params.id, tenant(req));
      res.json({ success: true, data: decision });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/decisions/:id/override",
  authenticateAPIKey,
  extractRole,
  requirePermission("ai:override"),
  validate(decisionParams, "params"),
  validate(overrideSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const decision = await aiService.overrideDecision(
        req.params.id,
        req.body.outcome,
        actor(req),
        req.body.reason,
        tenant(req),
      );
      res.json({ success: true, data: decision });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/decisions/:id/appeals",
  authenticateAPIKey,
  extractRole,
  requirePermission("ai:manage"),
  validate(decisionParams, "params"),
  validate(appealSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const appeal = await aiService.submitAppeal(
        req.params.id,
        actor(req),
        req.body.reason,
        tenant(req),
      );
      res.status(201).json({ success: true, data: appeal });
    } catch (error) {
      handleError(error, res);
    }
  },
);

function handleError(error: unknown, res: Response): void {
  if (error instanceof AIComplianceError) {
    res
      .status(error.statusCode)
      .json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled AI compliance error", {
    error: (error as Error).message,
  });
  res
    .status(500)
    .json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
