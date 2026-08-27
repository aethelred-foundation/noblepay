import { Router, Response } from "express";
import { getAddress } from "ethers";
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
  type CreateCrossChainTransfer,
  type CrossChainRouteQuery,
  type CrossChainTransferListQuery,
  type RecoverCrossChainTransfer,
} from "../middleware/validation";
import type { CrossChainTransferInput } from "../services/crosschain";
import { TransferVerificationError } from "../services/crosschain-execution";
import { loadNoblePayChainConfiguration } from "../lib/production-config";

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
      const walletSigner = walletSignerOrReject(req, res);
      if (!walletSigner) return;
      const { txHash, onChainTransferId, ...input } =
        req.body as unknown as CreateCrossChainTransfer;
      const transfer = await crossChainService.initiateTransfer(
        input as CrossChainTransferInput,
        walletSigner,
        req.businessId,
        { txHash, onChainTransferId },
        loadNoblePayChainConfiguration(),
      );
      res.status(201).json({ success: true, data: transfer });
    } catch (error) {
      handleVerificationError(error, res);
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
      const walletSigner = walletSignerOrReject(req, res);
      if (!walletSigner) return;
      const { transferId, txHash } =
        req.body as unknown as RecoverCrossChainTransfer;
      const result = await crossChainService.recoverTransfer(
        transferId,
        walletSigner,
        req.businessId,
        { txHash },
        loadNoblePayChainConfiguration(),
      );
      res.json({ success: true, data: result });
    } catch (error) {
      handleVerificationError(error, res);
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

/**
 * A wallet-authenticated session is required for anything that writes a
 * transfer record. The previous code passed req.businessId where an address
 * belongs, which the 501 gate had been hiding: a business id is not a wallet,
 * and binding a chain receipt to one would have compared an on-chain sender to
 * a UUID and rejected every legitimate transfer.
 */
function walletSignerOrReject(
  req: AuthenticatedRequest,
  res: Response,
): string | null {
  if (!req.signerId) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Signer identity required for cross-chain transfers",
    });
    return null;
  }
  if (req.apiKeyId || req.signerId.startsWith("apikey:")) {
    return walletSessionRequired(res);
  }
  try {
    return getAddress(req.signerId);
  } catch {
    return walletSessionRequired(res);
  }
}

function walletSessionRequired(res: Response): null {
  res.status(403).json({
    error: "WALLET_SESSION_REQUIRED",
    message:
      "A wallet-authenticated session bound to the registered business wallet is required for cross-chain mutations",
  });
  return null;
}

/**
 * Verification failures carry a specific reason and a status that separates
 * "not yet" from "not true": a caller retrying TRANSFER_NOT_MINED is behaving
 * correctly, one retrying TRANSFER_RECIPIENT_MISMATCH is not.
 */
function handleVerificationError(error: unknown, res: Response): void {
  if (error instanceof TransferVerificationError) {
    res
      .status(error.statusCode)
      .json({ error: error.reason, message: error.message });
    return;
  }
  handleError(error, res);
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
