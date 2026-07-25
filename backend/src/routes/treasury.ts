import { Router, Response } from "express";
import { getAddress } from "ethers";
import { prisma } from "../lib/db";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import {
  extractRole,
  requireRole,
  requirePermission,
} from "../middleware/rbac";
import { TreasuryService, TreasuryError } from "../services/treasury";
import { AuditService } from "../services/audit";
import { logger } from "../lib/logger";
import {
  AdvancedPaginationSchema,
  AdvancedResourceParamsSchema,
  CreateTreasuryProposalSchema,
  EmptyBodySchema,
  TreasuryAnalyticsQuerySchema,
  TreasuryProposalListQuerySchema,
  validate,
  type AdvancedPaginationQuery,
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

// ─── POST /v1/treasury/proposals/:id/execute — Execute proposal ────────────

router.post(
  "/proposals/:id/execute",
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
      const result = await treasuryService.executeProposal(
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
