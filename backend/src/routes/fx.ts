import { Router, Response } from "express";
import { prisma } from "../lib/db";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { FXService, FXError } from "../services/fx";
import { AuditService } from "../services/audit";
import {
  extractRole,
  requirePermission,
  requireRole,
} from "../middleware/rbac";
import { logger } from "../lib/logger";
import {
  AdvancedResourceParamsSchema,
  CreateFXHedgeSchema,
  EmptyBodySchema,
  FXHedgeListQuerySchema,
  FXRatesQuerySchema,
  validate,
  type FXHedgeListQuery,
  type FXRatesQuery,
} from "../middleware/validation";
import type { CreateHedgeInput } from "../services/fx";

const auditService = new AuditService(prisma);
const fxService = new FXService(prisma, auditService);

const router = Router();

router.get(
  "/rates",
  authenticateAPIKey,
  validate(FXRatesQuerySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { pair } = req.query as unknown as FXRatesQuery;
      const rates = await fxService.getRates(pair);
      res.json({ success: true, data: rates });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/hedges",
  authenticateAPIKey,
  extractRole,
  requirePermission("fx:trade"),
  validate(CreateFXHedgeSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const position = await fxService.createHedge(
        req.body as CreateHedgeInput,
        req.businessId,
        req.businessId,
      );
      res.status(201).json({ success: true, data: position });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/hedges",
  authenticateAPIKey,
  extractRole,
  requirePermission("fx:read"),
  validate(FXHedgeListQuerySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const query = req.query as unknown as FXHedgeListQuery;
      const positions = await fxService.listPositions(req.businessId, query);
      res.json({ success: true, data: positions });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/hedges/:id/close",
  authenticateAPIKey,
  extractRole,
  requirePermission("fx:trade"),
  validate(AdvancedResourceParamsSchema, "params"),
  validate(EmptyBodySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const result = await fxService.closePosition(
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

router.get(
  "/exposure",
  authenticateAPIKey,
  extractRole,
  requirePermission("fx:read"),
  validate(EmptyBodySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const exposure = await fxService.getExposure(req.businessId);
      res.json({ success: true, data: exposure });
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
  validate(EmptyBodySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const analytics = await fxService.getAnalytics(req.businessId);
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
  if (error instanceof FXError) {
    res
      .status(error.statusCode)
      .json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled FX error", { error: (error as Error).message });
  res
    .status(500)
    .json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
