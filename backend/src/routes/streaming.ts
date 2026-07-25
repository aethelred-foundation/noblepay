import { Router, Response } from "express";
import { prisma } from "../lib/db";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { StreamingService, StreamError } from "../services/streaming";
import { AuditService } from "../services/audit";
import {
  extractRole,
  requirePermission,
  requireRole,
} from "../middleware/rbac";
import { logger } from "../lib/logger";
import {
  AdjustStreamRateSchema,
  AdvancedResourceParamsSchema,
  BatchStreamsSchema,
  CreateStreamSchema,
  EmptyBodySchema,
  StreamListQuerySchema,
  validate,
  type StreamListQuery,
} from "../middleware/validation";
import type {
  BatchStreamInput,
  CreateStreamInput,
} from "../services/streaming";

const auditService = new AuditService(prisma);
const streamingService = new StreamingService(prisma, auditService);

const router = Router();

router.post(
  "/",
  authenticateAPIKey,
  extractRole,
  requirePermission("streams:create"),
  validate(CreateStreamSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const stream = await streamingService.createStream(
        req.body as CreateStreamInput,
        req.businessId,
      );
      res.status(201).json({ success: true, data: stream });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/",
  authenticateAPIKey,
  extractRole,
  requirePermission("streams:read"),
  validate(StreamListQuerySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const query = req.query as unknown as StreamListQuery;
      const filters = { ...query, businessId: req.businessId };
      const streams = await streamingService.listStreams(filters);
      res.json({ success: true, data: streams });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/:id/balance",
  authenticateAPIKey,
  validate(AdvancedResourceParamsSchema, "params"),
  validate(EmptyBodySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const balance = await streamingService.getStreamBalance(
        req.params.id,
        req.businessId,
      );
      res.json({ success: true, data: balance });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/:id/pause",
  authenticateAPIKey,
  extractRole,
  requirePermission("streams:manage"),
  validate(AdvancedResourceParamsSchema, "params"),
  validate(EmptyBodySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const stream = await streamingService.pauseStream(
        req.params.id,
        req.businessId,
        req.businessId,
      );
      res.json({ success: true, data: stream });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/:id/resume",
  authenticateAPIKey,
  extractRole,
  requirePermission("streams:manage"),
  validate(AdvancedResourceParamsSchema, "params"),
  validate(EmptyBodySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const stream = await streamingService.resumeStream(
        req.params.id,
        req.businessId,
        req.businessId,
      );
      res.json({ success: true, data: stream });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/:id/cancel",
  authenticateAPIKey,
  extractRole,
  requirePermission("streams:manage"),
  validate(AdvancedResourceParamsSchema, "params"),
  validate(EmptyBodySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const result = await streamingService.cancelStream(
        req.params.id,
        req.businessId,
        req.businessId,
      );
      res.json({ success: true, data: result });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/:id/adjust-rate",
  authenticateAPIKey,
  extractRole,
  requirePermission("streams:manage"),
  validate(AdvancedResourceParamsSchema, "params"),
  validate(AdjustStreamRateSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const stream = await streamingService.adjustRate(
        req.params.id,
        req.body.ratePerSecond,
        req.businessId,
        req.businessId,
      );
      res.json({ success: true, data: stream });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/batch",
  authenticateAPIKey,
  extractRole,
  requirePermission("streams:create"),
  validate(BatchStreamsSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const result = await streamingService.createBatchStreams({
        ...(req.body as Omit<BatchStreamInput, "businessId">),
        businessId: req.businessId,
      });
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/analytics",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN", "ANALYST"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const analytics = await streamingService.getAnalytics(req.businessId);
      res.json({ success: true, data: analytics });
    } catch (error) {
      handleError(error, res);
    }
  },
);

function unauthorized(res: Response): void {
  res.status(401).json({
    error: "UNAUTHORIZED",
    message: "Authenticated business identity is required",
  });
}

function handleError(error: unknown, res: Response): void {
  if (error instanceof StreamError) {
    res
      .status(error.statusCode)
      .json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled streaming error", {
    error: (error as Error).message,
  });
  res
    .status(500)
    .json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
