import { Router, Response } from "express";
import { prisma } from "../lib/db";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import {
  LiquidityService,
  LiquidityError,
  type PoolStatus,
} from "../services/liquidity";
import { AuditService } from "../services/audit";
import {
  extractRole,
  requirePermission,
  requireRole,
} from "../middleware/rbac";
import { logger } from "../lib/logger";
import {
  AddLiquiditySchema,
  AdvancedResourceParamsSchema,
  FlashLiquiditySchema,
  LiquidityPoolsQuerySchema,
  LiquidityPositionQuerySchema,
  RemoveLiquiditySchema,
  validate,
  type LiquidityPoolsQuery,
  type LiquidityPositionQuery,
} from "../middleware/validation";
import type {
  AddLiquidityInput,
  RemoveLiquidityInput,
} from "../services/liquidity";

const auditService = new AuditService(prisma);
const liquidityService = new LiquidityService(prisma, auditService);

const router = Router();

router.get(
  "/pools",
  authenticateAPIKey,
  validate(LiquidityPoolsQuerySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { status, page, limit } =
        req.query as unknown as LiquidityPoolsQuery;
      const pools = await liquidityService.getPools(
        status as PoolStatus | undefined,
        { page, limit },
      );
      res.json({ success: true, data: pools });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/pools/:id",
  authenticateAPIKey,
  validate(AdvancedResourceParamsSchema, "params"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const pool = await liquidityService.getPool(req.params.id);
      res.json({ success: true, data: pool });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/pools/:id/add",
  authenticateAPIKey,
  extractRole,
  requirePermission("liquidity:manage"),
  validate(AdvancedResourceParamsSchema, "params"),
  validate(AddLiquiditySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const position = await liquidityService.addLiquidity(
        { ...(req.body as AddLiquidityInput), poolId: req.params.id },
        req.businessId,
        req.businessId,
      );
      res.status(201).json({ success: true, data: position });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/pools/:id/remove",
  authenticateAPIKey,
  extractRole,
  requirePermission("liquidity:manage"),
  validate(AdvancedResourceParamsSchema, "params"),
  validate(RemoveLiquiditySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const result = await liquidityService.removeLiquidity(
        req.body as RemoveLiquidityInput,
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
  "/positions",
  authenticateAPIKey,
  extractRole,
  requirePermission("liquidity:read"),
  validate(LiquidityPositionQuerySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { provider, page, limit } =
        req.query as unknown as LiquidityPositionQuery;
      if (!req.businessId) {
        res.status(401).json({
          error: "UNAUTHORIZED",
          message: "Authenticated business identity is required",
        });
        return;
      }
      const positions = await liquidityService.getPositions(
        req.businessId,
        provider,
        { page, limit },
      );
      res.json({ success: true, data: positions });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/flash",
  authenticateAPIKey,
  extractRole,
  requirePermission("liquidity:manage"),
  validate(FlashLiquiditySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const body = req.body as { poolId: string; amount: string };
      const result = await liquidityService.requestFlashLiquidity(
        body.poolId,
        body.amount,
        req.businessId,
      );
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
      const analytics = await liquidityService.getAnalytics(req.businessId);
      res.json({ success: true, data: analytics });
    } catch (error) {
      handleError(error, res);
    }
  },
);

function handleError(error: unknown, res: Response): void {
  if (error instanceof LiquidityError) {
    res
      .status(error.statusCode)
      .json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled liquidity error", {
    error: (error as Error).message,
  });
  res
    .status(500)
    .json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

function unauthorized(res: Response): void {
  res.status(401).json({
    error: "UNAUTHORIZED",
    message: "Authenticated business identity is required",
  });
}

export default router;
