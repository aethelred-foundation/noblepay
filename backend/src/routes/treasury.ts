import { Router, Response } from "express";
import { getAddress, JsonRpcProvider } from "ethers";
import { prisma } from "../lib/db";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import {
  extractRole,
  requireRole,
  requirePermission,
} from "../middleware/rbac";
import { TreasuryService, TreasuryError } from "../services/treasury";
import { TreasuryExecutionError } from "../services/treasury-execution";
import {
  readBudgets,
  readProposals,
  readTreasuryOverview,
} from "../services/treasury-chain";
import { loadNoblePayChainConfiguration } from "../lib/production-config";
import { AuditService } from "../services/audit";
import { logger } from "../lib/logger";
import {
  AdvancedPaginationSchema,
  AdvancedResourceParamsSchema,
  CreateTreasuryProposalSchema,
  EmptyBodySchema,
  ExecuteTreasuryProposalSchema,
  TreasuryAnalyticsQuerySchema,
  TreasuryProposalListQuerySchema,
  validate,
  type AdvancedPaginationQuery,
  type ExecuteTreasuryProposal,
  type TreasuryAnalyticsQuery,
  type TreasuryProposalListQuery,
} from "../middleware/validation";
import type { CreateProposalInput } from "../services/treasury";

const auditService = new AuditService(prisma);
const treasuryService = new TreasuryService(prisma, auditService);

const router = Router();

// ─── GET /v1/treasury/overview — Treasury overview ──────────────────────────

router.get(
  "/overview",
  authenticateAPIKey,
  extractRole,
  requirePermission("treasury:read"),
  validate(EmptyBodySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const overview = await treasuryService.getOverview(req.businessId);
      res.json({ success: true, data: overview });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/treasury/chain/overview — On-chain treasury state ─────────────
//
// Deliberately separate from /overview. That endpoint reports the database
// ledger (dataSource "DATABASE_LEDGER") — what NoblePay has recorded. This one
// reports what the MultiSigTreasury contract actually holds
// (dataSource "CHAIN_MULTISIG_TREASURY"). Merging them into one response would
// invite exactly the confusion the dataSource discriminator exists to prevent,
// and the two can legitimately disagree while an indexer lags.

router.get(
  "/chain/overview",
  authenticateAPIKey,
  extractRole,
  requirePermission("treasury:read"),
  validate(EmptyBodySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const config = loadNoblePayChainConfiguration();
      const overview = await readTreasuryOverview(config);
      res.json({ success: true, data: overview });
    } catch (error) {
      handleChainError(error, res);
    }
  },
);

// ─── GET /v1/treasury/chain/proposals — On-chain proposals ─────────────────

router.get(
  "/chain/proposals",
  authenticateAPIKey,
  extractRole,
  requirePermission("treasury:read"),
  validate(EmptyBodySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const config = loadNoblePayChainConfiguration();
      const overview = await readTreasuryOverview(config);
      if (!overview.configured) {
        res.json({ success: true, data: { configured: false, proposals: [] } });
        return;
      }
      const provider = new JsonRpcProvider(config.rpcUrl);
      const proposals = await readProposals(
        provider,
        overview.address,
        Number(overview.readAtBlock),
      );
      res.json({
        success: true,
        data: {
          configured: true,
          proposals,
          amountBasis: overview.amountBasis,
          dataSource: overview.dataSource,
          readAtBlock: overview.readAtBlock,
        },
      });
    } catch (error) {
      handleChainError(error, res);
    }
  },
);

// ─── GET /v1/treasury/chain/budgets — On-chain budgets ─────────────────────

router.get(
  "/chain/budgets",
  authenticateAPIKey,
  extractRole,
  requirePermission("treasury:read"),
  validate(EmptyBodySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const config = loadNoblePayChainConfiguration();
      const budgets = await readBudgets(config);
      res.json({
        success: true,
        data: {
          configured: budgets !== null,
          budgets: budgets ?? [],
          dataSource: "CHAIN_MULTISIG_TREASURY",
        },
      });
    } catch (error) {
      handleChainError(error, res);
    }
  },
);

// ─── POST /v1/treasury/proposals — Create proposal ─────────────────────────

router.post(
  "/proposals",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN", "TREASURY_MANAGER"),
  validate(CreateTreasuryProposalSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const walletSigner = walletSignerOrReject(req, res);
      if (!walletSigner) return;
      const proposal = await treasuryService.createProposal(
        req.body as CreateProposalInput,
        walletSigner,
        req.businessId,
      );
      res.status(201).json({ success: true, data: proposal });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/proposals",
  authenticateAPIKey,
  extractRole,
  requirePermission("treasury:read"),
  validate(TreasuryProposalListQuerySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const { status, page, limit } =
        req.query as unknown as TreasuryProposalListQuery;
      const proposals = await treasuryService.listProposals(
        req.businessId,
        status,
        { page, limit },
      );
      res.json({ success: true, data: proposals });
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
  validate(AdvancedResourceParamsSchema, "params"),
  validate(EmptyBodySchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const walletSigner = walletSignerOrReject(req, res);
      if (!walletSigner) return;
      const result = await treasuryService.approveProposal(
        req.params.id,
        walletSigner,
        req.businessId,
      );
      res.json({ success: true, data: result });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/treasury/proposals/:id/execute — Record an on-chain execution ─
//
// This endpoint does not execute the proposal. The API holds no treasury
// signing key: execution is authorised by SIGNER_ROLE holders and submitted
// from their own wallets. The caller reports the transaction that settled the
// proposal, and the record is written only if the chain corroborates it.

router.post(
  "/proposals/:id/execute",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN", "TREASURY_MANAGER"),
  validate(AdvancedResourceParamsSchema, "params"),
  validate(ExecuteTreasuryProposalSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const walletSigner = walletSignerOrReject(req, res);
      if (!walletSigner) return;
      const { txHash, onChainProposalId } =
        req.body as unknown as ExecuteTreasuryProposal;
      const result = await treasuryService.executeProposal(
        req.params.id,
        walletSigner,
        req.businessId,
        { txHash, onChainProposalId },
        loadNoblePayChainConfiguration(),
      );
      res.json({ success: true, data: result });
    } catch (error) {
      handleExecutionError(error, res);
    }
  },
);

// ─── GET /v1/treasury/policies — Get spending policies ──────────────────────

router.get(
  "/policies",
  authenticateAPIKey,
  extractRole,
  requirePermission("treasury:read"),
  validate(AdvancedPaginationSchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const pagination = req.query as unknown as AdvancedPaginationQuery;
      const policies = await treasuryService.getSpendingPolicies(pagination);
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
  validate(AdvancedPaginationSchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const pagination = req.query as unknown as AdvancedPaginationQuery;
      const strategies = await treasuryService.getYieldStrategies(pagination);
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
  validate(TreasuryAnalyticsQuerySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const { period } = req.query as unknown as TreasuryAnalyticsQuery;
      if (!req.businessId) return unauthorized(res);
      const analytics = await treasuryService.getAnalytics(
        req.businessId,
        period,
      );
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

function signerRequired(res: Response): void {
  res.status(401).json({
    error: "UNAUTHORIZED",
    message: "Signer identity required for treasury proposals",
  });
}

function walletSignerOrReject(
  req: AuthenticatedRequest,
  res: Response,
): string | null {
  if (!req.signerId) {
    signerRequired(res);
    return null;
  }
  if (req.apiKeyId || req.signerId.startsWith("apikey:")) {
    walletSessionRequired(res);
    return null;
  }
  try {
    return getAddress(req.signerId);
  } catch {
    walletSessionRequired(res);
    return null;
  }
}

function walletSessionRequired(res: Response): void {
  res.status(403).json({
    error: "WALLET_SESSION_REQUIRED",
    message:
      "A wallet-authenticated session bound to the registered business wallet is required for treasury mutations",
  });
}

/**
 * Execution failures carry a specific reason and a status that distinguishes
 * "not yet" from "not true". A caller retrying a NOT_MINED is behaving
 * correctly; a caller retrying a CALLDATA_MISMATCH is not, and flattening both
 * to 500 would hide which is which.
 */
function handleExecutionError(error: unknown, res: Response): void {
  if (error instanceof TreasuryExecutionError) {
    res
      .status(error.statusCode)
      .json({ error: error.reason, message: error.message });
    return;
  }
  handleError(error, res);
}

function handleChainError(error: unknown, res: Response): void {
  // A chain read failing is an upstream availability problem, not a client
  // error and not an internal fault. 503 lets a caller distinguish "the node
  // is unreachable" from "your request was wrong", which matters because the
  // correct response to the former is to retry and to the latter is not.
  logger.error("Treasury chain read failed", {
    error: (error as Error).message,
  });
  res.status(503).json({
    error: "CHAIN_READ_FAILED",
    message: "Could not read the treasury contract from the configured RPC",
  });
}

function handleError(error: unknown, res: Response): void {
  if (error instanceof TreasuryError) {
    res
      .status(error.statusCode)
      .json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled treasury error", { error: (error as Error).message });
  res
    .status(500)
    .json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
