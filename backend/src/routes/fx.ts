import { Router, Response } from "express";
import { prisma } from "../lib/db";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { FXService, FXError } from "../services/fx";
import { readFXPairs, readHedgerPositions } from "../services/fx-chain";
import { loadNoblePayChainConfiguration } from "../lib/production-config";
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

// ─── GET /v1/fx/chain/pairs — On-chain currency pairs and oracle rates ─────
//
// Separate from /rates, which serves the database snapshot
// (dataSource "DATABASE_SNAPSHOT"). This reports the FXHedgingVault itself.
// The vault's enums are richer than the database's — three hedge types rather
// than the DB's FORWARD|OPTION|SWAP, and seven statuses including LIQUIDATED —
// so chain responses use the contract's own vocabulary rather than being
// squeezed into the DB's.

router.get(
  "/chain/pairs",
  authenticateAPIKey,
  extractRole,
  requirePermission("fx:read"),
  validate(EmptyBodySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      const config = loadNoblePayChainConfiguration();
      const result = await readFXPairs(config);
      res.json({ success: true, data: result });
    } catch (error) {
      handleChainError(error, res);
    }
  },
);

// ─── GET /v1/fx/chain/positions — On-chain positions for a hedger ──────────

router.get(
  "/chain/positions",
  authenticateAPIKey,
  extractRole,
  requirePermission("fx:read"),
  validate(EmptyBodySchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.businessId) return unauthorized(res);
      // Positions are keyed by hedger address on chain. Bind to the
      // wallet-authenticated signer rather than accepting an address from the
      // query, so one business cannot enumerate another's positions.
      const hedger = req.signerId;
      if (!hedger) {
        res.status(403).json({
          error: "WALLET_SESSION_REQUIRED",
          message:
            "A wallet-authenticated session is required to read on-chain positions",
        });
        return;
      }
      const config = loadNoblePayChainConfiguration();
      const result = await readHedgerPositions(config, hedger);
      res.json({ success: true, data: result });
    } catch (error) {
      handleChainError(error, res);
    }
  },
);

function handleChainError(error: unknown, res: Response): void {
  // Upstream availability, not a client error and not our bug: 503 tells the
  // caller to retry, which it cannot infer from a 500. The RPC message is
  // logged but withheld, since it can carry internal host addresses.
  logger.error("FX chain read failed", { error: (error as Error).message });
  res.status(503).json({
    error: "CHAIN_READ_FAILED",
    message: "Could not read the FX vault from the configured RPC",
  });
}

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
