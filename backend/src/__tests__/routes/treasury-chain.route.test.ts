/**
 * Route tests for the chain-backed treasury endpoints.
 *
 * The properties worth pinning are the ones that keep a caller from
 * misreading the response: that chain data is never confused with the database
 * ledger, that an unconfigured treasury is a normal answer rather than an
 * error, that an unreachable node is distinguishable from a bad request, and
 * that the tier-basis caveat travels with the numbers it qualifies.
 */

const mockTreasuryService = {
  getOverview: jest.fn(),
  listProposals: jest.fn(),
  createProposal: jest.fn(),
  approveProposal: jest.fn(),
  executeProposal: jest.fn(),
  getSpendingPolicies: jest.fn(),
  getYieldStrategies: jest.fn(),
  getAnalytics: jest.fn(),
};
const mockReadTreasuryOverview = jest.fn();
const mockReadProposals = jest.fn();
const mockReadBudgets = jest.fn();

let injectedBusinessId: string | undefined = "business-1";

jest.mock("../../lib/db", () => ({ prisma: {} }));
jest.mock("../../services/audit", () => ({ AuditService: jest.fn() }));
jest.mock("../../services/treasury", () => {
  class TreasuryError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  }
  return { TreasuryService: jest.fn(() => mockTreasuryService), TreasuryError };
});
jest.mock("../../services/treasury-chain", () => ({
  readTreasuryOverview: (...a: unknown[]) => mockReadTreasuryOverview(...a),
  readProposals: (...a: unknown[]) => mockReadProposals(...a),
  readBudgets: (...a: unknown[]) => mockReadBudgets(...a),
}));
jest.mock("../../lib/production-config", () => ({
  loadNoblePayChainConfiguration: () => ({ rpcUrl: "http://rpc.invalid" }),
}));
jest.mock("ethers", () => ({
  ...(jest.requireActual("ethers") as object),
  JsonRpcProvider: jest.fn(() => ({})),
}));
jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: (
    req: { businessId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.businessId = injectedBusinessId;
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

import treasuryRouter from "../../routes/treasury";

const app = express();
app.use(express.json());
app.use("/v1/treasury", treasuryRouter);

const configuredOverview = {
  configured: true as const,
  address: "0xf87ea237cca6f4c932f13983f7df05c0b842b128",
  nativeBalance: "5000000000000000000",
  signers: ["0xaaa", "0xbbb", "0xccc"],
  signerCount: 3,
  thresholds: { small: 1, medium: 2, large: 3, emergency: 2 },
  tiers: [],
  proposalCounts: {
    PENDING: 1,
    APPROVED: 0,
    EXECUTED: 0,
    REJECTED: 0,
    CANCELLED: 0,
    EXPIRED: 0,
  },
  activeBudgets: 0,
  amountBasis: "RAW_TOKEN_BASE_UNITS_COMPARED_AGAINST_USD6_THRESHOLDS" as const,
  dataSource: "CHAIN_MULTISIG_TREASURY" as const,
  readAtBlock: "4242",
};

beforeEach(() => {
  jest.clearAllMocks();
  injectedBusinessId = "business-1";
});

describe("GET /v1/treasury/chain/overview", () => {
  it("labels the response as chain-sourced, not the database ledger", async () => {
    mockReadTreasuryOverview.mockResolvedValue(configuredOverview);
    const res = await request(app).get("/v1/treasury/chain/overview");
    expect(res.status).toBe(200);
    expect(res.body.data.dataSource).toBe("CHAIN_MULTISIG_TREASURY");
    expect(res.body.data.dataSource).not.toBe("DATABASE_LEDGER");
  });

  it("carries the tier-basis caveat alongside the numbers", async () => {
    // Without this a client renders the tier bounds as dollars, which is only
    // true for a six-decimal dollar-pegged token (NP-TREASURY-01).
    mockReadTreasuryOverview.mockResolvedValue(configuredOverview);
    const res = await request(app).get("/v1/treasury/chain/overview");
    expect(res.body.data.amountBasis).toBe(
      "RAW_TOKEN_BASE_UNITS_COMPARED_AGAINST_USD6_THRESHOLDS",
    );
  });

  it("pins the block the snapshot was read at", async () => {
    mockReadTreasuryOverview.mockResolvedValue(configuredOverview);
    const res = await request(app).get("/v1/treasury/chain/overview");
    expect(res.body.data.readAtBlock).toBe("4242");
  });

  it("reports an unconfigured treasury as a normal 200, not an error", async () => {
    // The treasury is outside CORE_CONTRACT_KEYS; a deployment without one is
    // valid, so this must not look like a failure.
    mockReadTreasuryOverview.mockResolvedValue({
      configured: false,
      reason: "NO_TREASURY_ADDRESS_CONFIGURED",
      dataSource: "CHAIN_MULTISIG_TREASURY",
    });
    const res = await request(app).get("/v1/treasury/chain/overview");
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(false);
    expect(res.body.data.reason).toBe("NO_TREASURY_ADDRESS_CONFIGURED");
  });

  it("returns 503 when the node is unreachable, not 500", async () => {
    // A caller should be able to tell "retry later" from "your request is
    // wrong" and from "we have a bug".
    mockReadTreasuryOverview.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await request(app).get("/v1/treasury/chain/overview");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("CHAIN_READ_FAILED");
  });

  it("does not leak the RPC error text to the caller", async () => {
    mockReadTreasuryOverview.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.5:8545"),
    );
    const res = await request(app).get("/v1/treasury/chain/overview");
    expect(JSON.stringify(res.body)).not.toContain("10.0.0.5");
  });

  it("rejects an unauthenticated caller", async () => {
    injectedBusinessId = undefined;
    mockReadTreasuryOverview.mockResolvedValue(configuredOverview);
    const res = await request(app).get("/v1/treasury/chain/overview");
    expect(res.status).toBe(401);
    expect(mockReadTreasuryOverview).not.toHaveBeenCalled();
  });
});

describe("GET /v1/treasury/chain/proposals", () => {
  it("reads proposals at the same block as the overview snapshot", async () => {
    mockReadTreasuryOverview.mockResolvedValue(configuredOverview);
    mockReadProposals.mockResolvedValue([]);
    await request(app).get("/v1/treasury/chain/proposals");
    expect(mockReadProposals).toHaveBeenCalledWith(
      expect.anything(),
      configuredOverview.address,
      4242,
    );
  });

  it("returns the proposals with their chain provenance", async () => {
    mockReadTreasuryOverview.mockResolvedValue(configuredOverview);
    mockReadProposals.mockResolvedValue([
      {
        proposalId: "0xc62f",
        status: "APPROVED",
        tier: "MEDIUM",
        approvalCount: 2,
        requiredApprovals: 2,
      },
    ]);
    const res = await request(app).get("/v1/treasury/chain/proposals");
    expect(res.status).toBe(200);
    expect(res.body.data.proposals).toHaveLength(1);
    expect(res.body.data.proposals[0].status).toBe("APPROVED");
    expect(res.body.data.dataSource).toBe("CHAIN_MULTISIG_TREASURY");
  });

  it("returns an empty list rather than erroring when unconfigured", async () => {
    mockReadTreasuryOverview.mockResolvedValue({
      configured: false,
      reason: "NO_TREASURY_ADDRESS_CONFIGURED",
      dataSource: "CHAIN_MULTISIG_TREASURY",
    });
    const res = await request(app).get("/v1/treasury/chain/proposals");
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(false);
    expect(res.body.data.proposals).toEqual([]);
    expect(mockReadProposals).not.toHaveBeenCalled();
  });
});

describe("GET /v1/treasury/chain/budgets", () => {
  it("returns budgets with chain provenance", async () => {
    mockReadBudgets.mockResolvedValue([
      { budgetId: "0xb1", name: "Infrastructure", active: true },
    ]);
    const res = await request(app).get("/v1/treasury/chain/budgets");
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(true);
    expect(res.body.data.budgets).toHaveLength(1);
    expect(res.body.data.dataSource).toBe("CHAIN_MULTISIG_TREASURY");
  });

  it("distinguishes 'no treasury configured' from 'no budgets'", async () => {
    // null means unconfigured; [] means configured with nothing in it. A
    // client showing "no budgets" for the former would be wrong.
    mockReadBudgets.mockResolvedValue(null);
    const res = await request(app).get("/v1/treasury/chain/budgets");
    expect(res.body.data.configured).toBe(false);

    mockReadBudgets.mockResolvedValue([]);
    const res2 = await request(app).get("/v1/treasury/chain/budgets");
    expect(res2.body.data.configured).toBe(true);
    expect(res2.body.data.budgets).toEqual([]);
  });
});
