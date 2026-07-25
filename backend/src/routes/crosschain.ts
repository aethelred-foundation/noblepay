import { Router, Response } from "express";
import { prisma } from "../lib/db";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { CrossChainService, CrossChainError } from "../services/crosschain";
import { AuditService } from "../services/audit";
import {
  extractRole,
  requirePermission,
  requireRole,
} from "../middleware/rbac";
import { logger } from "../lib/logger";
import {
  AdvancedPaginationSchema,
  AdvancedResourceParamsSchema,
  CreateCrossChainTransferSchema,
  CrossChainRouteQuerySchema,
  CrossChainTransferListQuerySchema,
  EmptyBodySchema,
  RecoverCrossChainTransferSchema,
  validate,
  type AdvancedPaginationQuery,
  type CrossChainRouteQuery,
  type CrossChainTransferListQuery,
} from "../middleware/validation";
import type { CrossChainTransferInput } from "../services/crosschain";

const auditService = new AuditService(prisma);
const crossChainService = new CrossChainService(prisma, auditService);

const router = Router();

router.get(
  "/chains",
  authenticateAPIKey,
  validate(EmptyBodySchema, "query"),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const chains = await crossChainService.getChains();
      res.json({ success: true, data: chains });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/routes",
  authenticateAPIKey,
  validate(CrossChainRouteQuerySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { source, destination, token, amount } =
        req.query as unknown as CrossChainRouteQuery;
      const routes = await crossChainService.getRoutes(
        source,
        destination,
        token,
        amount,
      );
      res.json({ success: true, data: routes });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/transfers",
  authenticateAPIKey,
  extractRole,
  requirePermission("crosschain:initiate"),
  validate(CreateCrossChainTransferSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const transfer = await crossChainService.initiateTransfer(
        req.body as CrossChainTransferInput,
        req.businessId,
        req.businessId,
      );
      res.status(201).json({ success: true, data: transfer });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/transfers",
  authenticateAPIKey,
  extractRole,
  requirePermission("crosschain:read"),
  validate(CrossChainTransferListQuerySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const query = req.query as unknown as CrossChainTransferListQuery;
      const filters = { ...query, businessId: req.businessId };
      const transfers = await crossChainService.listTransfers(filters);
      res.json({ success: true, data: transfers });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/transfers/:id",
  authenticateAPIKey,
  extractRole,
  requirePermission("crosschain:read"),
  validate(AdvancedResourceParamsSchema, "params"),
  validate(EmptyBodySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const transfer = await crossChainService.getTransfer(
        req.params.id,
        req.businessId,
      );
      res.json({ success: true, data: transfer });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/recover",
  authenticateAPIKey,
  extractRole,
  requirePermission("crosschain:manage"),
  validate(RecoverCrossChainTransferSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const result = await crossChainService.recoverTransfer(
        req.body.transferId,
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
  "/relays",
  authenticateAPIKey,
  validate(AdvancedPaginationSchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const pagination = req.query as unknown as AdvancedPaginationQuery;
      const nodes = await crossChainService.getRelayNodes(pagination);
      res.json({ success: true, data: nodes });
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
      const analytics = await crossChainService.getAnalytics(req.businessId);
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
  if (error instanceof CrossChainError) {
    res
      .status(error.statusCode)
      .json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled cross-chain error", {
    error: (error as Error).message,
  });
  res
    .status(500)
    .json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
