/**
 * Route tests for the chain-backed FX endpoints.
 *
 * Beyond the provenance and availability properties shared with the treasury
 * routes, the one that matters most here is authorisation scope: positions are
 * keyed by hedger address on chain, so the endpoint must bind to the
 * authenticated signer rather than trust an address supplied by the caller.
 */

const mockFXService = {
  getRates: jest.fn(),
  createHedge: jest.fn(),
  listHedges: jest.fn(),
  closeHedge: jest.fn(),
  getExposure: jest.fn(),
  getAnalytics: jest.fn(),
};
const mockReadFXPairs = jest.fn();
const mockReadHedgerPositions = jest.fn();

let injectedBusinessId: string | undefined = "business-1";
let injectedSignerId: string | undefined =
  "0x1111111111111111111111111111111111111111";

jest.mock("../../lib/db", () => ({ prisma: {} }));
jest.mock("../../services/audit", () => ({ AuditService: jest.fn() }));
jest.mock("../../services/fx", () => {
  class FXError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  }
  return { FXService: jest.fn(() => mockFXService), FXError };
});
jest.mock("../../services/fx-chain", () => ({
  readFXPairs: (...a: unknown[]) => mockReadFXPairs(...a),
  readHedgerPositions: (...a: unknown[]) => mockReadHedgerPositions(...a),
}));
jest.mock("../../lib/production-config", () => ({
  loadNoblePayChainConfiguration: () => ({ rpcUrl: "http://rpc.invalid" }),
}));
jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: (
    req: { businessId?: string; signerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.businessId = injectedBusinessId;
    req.signerId = injectedSignerId;
    next();
  },
}));
jest.mock("../../middleware/rbac", () => ({
  extractRole: (_r: unknown, _s: unknown, next: () => void) => next(),
  requireRole: () => (_r: unknown, _s: unknown, next: () => void) => next(),
  requirePermission: () => (_r: unknown, _s: unknown, next: () => void) => next(),
}));
jest.mock("../../middleware/validation", () => ({
  ...(jest.requireActual("../../middleware/validation") as object),
  validate: () => (_r: unknown, _s: unknown, next: () => void) => next(),
}));
jest.mock("../../lib/logger", () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import express from "express";
import request from "supertest";

import fxRouter from "../../routes/fx";

const app = express();
app.use(express.json());
app.use("/v1/fx", fxRouter);

const pairsPayload = {
  configured: true as const,
  address: "0xe7c2a73131dd48d8ac46dcd7ab80c8cbee5b410a",
  rateDecimals: 8,
  settlementFeeBps: 25,
  pairs: [
    {
      pairId: "0xpair1",
      base: "AED",
      quote: "USD",
      active: true,
      maxHedgeRatioBps: 10000,
      marginRequirementBps: 500,
      maintenanceMarginBps: 300,
      rate: "27230000",
      rateUpdatedAt: "1700000000",
    },
  ],
  dataSource: "CHAIN_FX_HEDGING_VAULT" as const,
  readAtBlock: "4242",
};

beforeEach(() => {
  jest.clearAllMocks();
  injectedBusinessId = "business-1";
  injectedSignerId = "0x1111111111111111111111111111111111111111";
});

describe("GET /v1/fx/chain/pairs", () => {
  it("labels the response as vault-sourced, not the database snapshot", async () => {
    mockReadFXPairs.mockResolvedValue(pairsPayload);
    const res = await request(app).get("/v1/fx/chain/pairs");
    expect(res.status).toBe(200);
    expect(res.body.data.dataSource).toBe("CHAIN_FX_HEDGING_VAULT");
    expect(res.body.data.dataSource).not.toBe("DATABASE_SNAPSHOT");
  });

  it("reports the rate precision so a client can scale the numbers", async () => {
    mockReadFXPairs.mockResolvedValue(pairsPayload);
    const res = await request(app).get("/v1/fx/chain/pairs");
    expect(res.body.data.rateDecimals).toBe(8);
  });

  it("passes through a null rate for a pair the oracle has not published", async () => {
    // The vault's constructor grants no ORACLE_ROLE, so on a fresh deployment
    // every pair is in this state. Null must not become 0 — a pair awaiting
    // its first rate is not a pair trading at zero.
    mockReadFXPairs.mockResolvedValue({
      ...pairsPayload,
      pairs: [{ ...pairsPayload.pairs[0], rate: null, rateUpdatedAt: null }],
    });
    const res = await request(app).get("/v1/fx/chain/pairs");
    expect(res.body.data.pairs[0].rate).toBeNull();
  });

  it("reports an unconfigured vault as a normal 200", async () => {
    mockReadFXPairs.mockResolvedValue({
      configured: false,
      reason: "NO_FX_VAULT_ADDRESS_CONFIGURED",
      dataSource: "CHAIN_FX_HEDGING_VAULT",
    });
    const res = await request(app).get("/v1/fx/chain/pairs");
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(false);
  });

  it("returns 503 when the node is unreachable", async () => {
    mockReadFXPairs.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(app).get("/v1/fx/chain/pairs");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("CHAIN_READ_FAILED");
  });

  it("does not leak the RPC host to the caller", async () => {
    mockReadFXPairs.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:8545"),
    );
    const res = await request(app).get("/v1/fx/chain/pairs");
    expect(JSON.stringify(res.body)).not.toContain("10.0.0.5");
  });
});

describe("GET /v1/fx/chain/positions", () => {
  it("reads positions for the authenticated signer, not a caller-supplied address", async () => {
    mockReadHedgerPositions.mockResolvedValue({
      configured: true,
      positions: [],
      portfolio: null,
      dataSource: "CHAIN_FX_HEDGING_VAULT",
    });
    await request(app).get(
      "/v1/fx/chain/positions?hedger=0x2222222222222222222222222222222222222222",
    );
    // The query parameter must be ignored; the signer address is what counts.
    expect(mockReadHedgerPositions).toHaveBeenCalledWith(
      expect.anything(),
      "0x1111111111111111111111111111111111111111",
    );
  });

  it("requires a wallet session, since positions are per-address", async () => {
    injectedSignerId = undefined;
    const res = await request(app).get("/v1/fx/chain/positions");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("WALLET_SESSION_REQUIRED");
    expect(mockReadHedgerPositions).not.toHaveBeenCalled();
  });

  it("returns positions using the contract's status vocabulary", async () => {
    // LIQUIDATED has no equivalent in the database's four statuses; reporting
    // it as CLOSED would hide the outcome that matters most.
    mockReadHedgerPositions.mockResolvedValue({
      configured: true,
      positions: [
        {
          positionId: "0xpos1",
          hedgeType: "OPTION_CALL",
          status: "LIQUIDATED",
          underMargined: true,
        },
      ],
      portfolio: {
        totalNotional: "1000",
        totalCollateral: "50",
        totalPremiumPaid: "0",
        totalPnL: "0",
        unrealizedPnL: "0",
        positionCount: 1,
        lastRebalanced: "0",
      },
      dataSource: "CHAIN_FX_HEDGING_VAULT",
    });
    const res = await request(app).get("/v1/fx/chain/positions");
    expect(res.status).toBe(200);
    expect(res.body.data.positions[0].status).toBe("LIQUIDATED");
    expect(res.body.data.positions[0].hedgeType).toBe("OPTION_CALL");
  });

  it("preserves a null margin check rather than reporting it as safe", async () => {
    // null means "could not be evaluated" — usually no published rate.
    // Rendering that as false would understate risk.
    mockReadHedgerPositions.mockResolvedValue({
      configured: true,
      positions: [{ positionId: "0xpos1", underMargined: null }],
      portfolio: null,
      dataSource: "CHAIN_FX_HEDGING_VAULT",
    });
    const res = await request(app).get("/v1/fx/chain/positions");
    expect(res.body.data.positions[0].underMargined).toBeNull();
  });

  it("returns an empty result when no vault is configured", async () => {
    mockReadHedgerPositions.mockResolvedValue({
      configured: false,
      positions: [],
      portfolio: null,
      dataSource: "CHAIN_FX_HEDGING_VAULT",
    });
    const res = await request(app).get("/v1/fx/chain/positions");
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(false);
    expect(res.body.data.positions).toEqual([]);
  });
});
