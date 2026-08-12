import { Router, Response } from "express";
import { prisma } from "../lib/db";
import { getAddress } from "ethers";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { loadNoblePayChainConfiguration } from "../lib/production-config";
import { LiquiditySettlementError } from "../services/liquidity-execution";
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
      const wallet = walletSignerOrReject(req, res);
      if (!wallet) return;
      const body = req.body as AddLiquidityInput & {
        txHash: string;
        onChainPositionId: string;
      };
      const position = await liquidityService.addLiquidity(
        { ...body, poolId: req.params.id },
        wallet,
        req.businessId,
        { txHash: body.txHash, onChainPositionId: body.onChainPositionId },
        loadNoblePayChainConfiguration(),
      );
      res.status(201).json({ success: true, data: position });
    } catch (error) {
      handleSettlementError(error, res);
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
      const wallet = walletSignerOrReject(req, res);
      if (!wallet) return;
      const body = req.body as RemoveLiquidityInput & {
        txHash: string;
        onChainPositionId: string;
      };
      const result = await liquidityService.removeLiquidity(
        body,
        wallet,
        req.businessId,
        { txHash: body.txHash, onChainPositionId: body.onChainPositionId },
        loadNoblePayChainConfiguration(),
      );
      res.json({ success: true, data: result });
    } catch (error) {
      handleSettlementError(error, res);
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
      const wallet = walletSignerOrReject(req, res);
      if (!wallet) return;
      const body = req.body as {
        poolId: string;
        txHash: string;
        flashLoanId: string;
      };
      const result = await liquidityService.requestFlashLiquidity(
        body.poolId,
        wallet,
        req.businessId,
        { txHash: body.txHash, flashLoanId: body.flashLoanId },
        loadNoblePayChainConfiguration(),
      );
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      handleSettlementError(error, res);
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

/**
 * Liquidity settlements are attributed to a wallet address, not a business id.
 * LPPosition.provider holds an address — getPositions matches it against
 * business.address — and the on-chain event names an address too, so the
 * verifier can only compare like with like if the caller is identified by
 * wallet. The routes previously passed businessId into the provider slot; that
 * mismatch was never exercised because these methods threw 501 before reaching
 * it.
 */
function walletSignerOrReject(
  req: AuthenticatedRequest,
  res: Response,
): string | null {
  if (!req.signerId) {
    res.status(403).json({
      error: "SIGNER_REQUIRED",
      message: "A wallet-authenticated session is required for liquidity settlement",
    });
    return null;
  }
  if (req.apiKeyId || req.signerId.startsWith("apikey:")) {
    res.status(403).json({
      error: "WALLET_SESSION_REQUIRED",
      message:
        "API-key credentials cannot settle liquidity; a wallet session is required",
    });
    return null;
  }
  try {
    return getAddress(req.signerId);
  } catch {
    res.status(403).json({
      error: "WALLET_SESSION_REQUIRED",
      message: "The session signer is not a valid EVM address",
    });
    return null;
  }
}

function handleSettlementError(error: unknown, res: Response): void {
  if (error instanceof LiquiditySettlementError) {
    res
      .status(error.statusCode)
      .json({ error: error.reason, message: error.message });
    return;
  }
  handleError(error, res);
}

function unauthorized(res: Response): void {
  res.status(401).json({
    error: "UNAUTHORIZED",
    message: "Authenticated business identity is required",
  });
}

export default router;
