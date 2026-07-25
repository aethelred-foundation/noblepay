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
let injectedBusinessId: string | undefined = "business-1";
let injectedSignerId: string | undefined =
  "0x1111111111111111111111111111111111111111";
let injectedApiKeyId: string | undefined;

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
  return {
    TreasuryService: jest.fn(() => mockTreasuryService),
    TreasuryError,
  };
});
jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: (
    req: { businessId?: string; signerId?: string; apiKeyId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.businessId = injectedBusinessId;
    req.signerId = injectedSignerId;
    req.apiKeyId = injectedApiKeyId;
    next();
  },
}));
jest.mock("../../middleware/rbac", () => ({
  extractRole: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

import express from "express";
import request from "supertest";
import router from "../../routes/treasury";
import { TreasuryError } from "../../services/treasury";

const app = express();
app.use(express.json());
app.use("/v1/treasury", router);

const createProposal = {
  title: "Supplier payment",
  description: "Pay a verified infrastructure supplier",
  type: "TRANSFER",
  amount: "500",
  currency: "USDC",
  recipient: "0x2222222222222222222222222222222222222222",
  category: "INFRASTRUCTURE",
};
const BUSINESS_WALLET = "0x1111111111111111111111111111111111111111";

describe("treasury routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    injectedBusinessId = "business-1";
    injectedSignerId = BUSINESS_WALLET;
    injectedApiKeyId = undefined;
  });

  it("returns the tenant treasury overview", async () => {
    mockTreasuryService.getOverview.mockResolvedValue({ totalAUM: "1000" });
    const response = await request(app).get("/v1/treasury/overview");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: { totalAUM: "1000" },
    });
    expect(mockTreasuryService.getOverview).toHaveBeenCalledWith("business-1");
  });

  it("rejects unknown overview query fields", async () => {
    const response = await request(app).get(
      "/v1/treasury/overview?valuation=pretend",
    );

    expect(response.status).toBe(400);
    expect(mockTreasuryService.getOverview).not.toHaveBeenCalled();
  });

  it("passes tenant, status, and bounded pagination to proposal history", async () => {
    mockTreasuryService.listProposals.mockResolvedValue([]);

    const response = await request(app).get(
      "/v1/treasury/proposals?status=PENDING&page=2&limit=10",
    );

    expect(response.status).toBe(200);
    expect(mockTreasuryService.listProposals).toHaveBeenCalledWith(
      "business-1",
      "PENDING",
      { page: 2, limit: 10 },
    );
  });

  it("rejects incomplete and unknown proposal fields", async () => {
    const response = await request(app).post("/v1/treasury/proposals").send({
      title: "Bad proposal",
      description: "Missing recipient and category",
      type: "TRANSFER",
      amount: "10",
      currency: "USDC",
      fakeApprovalCount: 5,
    });

    expect(response.status).toBe(400);
    expect(mockTreasuryService.createProposal).not.toHaveBeenCalled();
  });

  it("persists a strictly validated proposal under signer and tenant identity", async () => {
    mockTreasuryService.createProposal.mockResolvedValue({ id: "proposal-1" });

    const response = await request(app)
      .post("/v1/treasury/proposals")
      .send(createProposal);

    expect(response.status).toBe(201);
    expect(mockTreasuryService.createProposal).toHaveBeenCalledWith(
      createProposal,
      BUSINESS_WALLET,
      "business-1",
    );
  });

  it("requires an empty approval body and surfaces service conflicts", async () => {
    const invalid = await request(app)
      .post("/v1/treasury/proposals/proposal-1/approve")
      .send({ approvals: 99 });
    mockTreasuryService.approveProposal.mockRejectedValue(
      new TreasuryError("DUPLICATE_APPROVAL", "Already approved", 409),
    );
    const conflict = await request(app)
      .post("/v1/treasury/proposals/proposal-1/approve")
      .send({});

    expect(invalid.status).toBe(400);
    expect(conflict.status).toBe(409);
    expect(mockTreasuryService.approveProposal).toHaveBeenCalledWith(
      "proposal-1",
      BUSINESS_WALLET,
      "business-1",
    );
  });

  it("passes bounded pagination to policy and yield registries", async () => {
    mockTreasuryService.getSpendingPolicies.mockResolvedValue([]);
    mockTreasuryService.getYieldStrategies.mockResolvedValue([]);

    const [policies, strategies] = await Promise.all([
      request(app).get("/v1/treasury/policies?limit=5"),
      request(app).get("/v1/treasury/yield?page=2&limit=5"),
    ]);

    expect(policies.status).toBe(200);
    expect(strategies.status).toBe(200);
    expect(mockTreasuryService.getSpendingPolicies).toHaveBeenCalledWith({
      page: 1,
      limit: 5,
    });
    expect(mockTreasuryService.getYieldStrategies).toHaveBeenCalledWith({
      page: 2,
      limit: 5,
    });
  });

  it.each([
    ["/overview", "get", undefined, BUSINESS_WALLET],
    ["/proposals", "post", "business-1", undefined],
    ["/proposals", "post", undefined, BUSINESS_WALLET],
    ["/proposals/proposal-1/approve", "post", "business-1", undefined],
    ["/proposals/proposal-1/approve", "post", undefined, BUSINESS_WALLET],
    ["/proposals/proposal-1/execute", "post", "business-1", undefined],
    ["/proposals/proposal-1/execute", "post", undefined, BUSINESS_WALLET],
    ["/analytics", "get", undefined, BUSINESS_WALLET],
  ] as const)(
    "fails closed when route %s lacks its required identity",
    async (path, method, businessId, signerId) => {
      injectedBusinessId = businessId;
      injectedSignerId = signerId;
      const routePath = `/v1/treasury${path}`;
      const operation =
        method === "get"
          ? request(app).get(routePath)
          : request(app).post(routePath);
      const response =
        method === "post" && path === "/proposals"
          ? await operation.send(createProposal)
          : await operation.send({});
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("UNAUTHORIZED");
    },
  );

  it.each([
    ["/proposals", createProposal],
    ["/proposals/proposal-1/approve", {}],
    ["/proposals/proposal-1/execute", {}],
  ])(
    "rejects API-key treasury mutation %s before service execution",
    async (path, body) => {
      injectedSignerId = "apikey:key-1";
      injectedApiKeyId = "key-1";

      const response = await request(app)
        .post(`/v1/treasury${path}`)
        .send(body);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("WALLET_SESSION_REQUIRED");
      expect(mockTreasuryService.createProposal).not.toHaveBeenCalled();
      expect(mockTreasuryService.approveProposal).not.toHaveBeenCalled();
      expect(mockTreasuryService.executeProposal).not.toHaveBeenCalled();
    },
  );

  it("does not treat two API-key credentials as independent approvers", async () => {
    for (const keyId of ["key-a", "key-b"]) {
      injectedSignerId = `apikey:${keyId}`;
      injectedApiKeyId = keyId;
      const response = await request(app)
        .post("/v1/treasury/proposals/proposal-1/approve")
        .send({});
      expect(response.status).toBe(403);
      expect(response.body.error).toBe("WALLET_SESSION_REQUIRED");
    }
    expect(mockTreasuryService.approveProposal).not.toHaveBeenCalled();
  });

  it("approves and executes proposals under signer and tenant identity", async () => {
    mockTreasuryService.approveProposal.mockResolvedValue({ approved: true });
    mockTreasuryService.executeProposal.mockResolvedValue({ executed: true });
    const [approved, executed] = await Promise.all([
      request(app).post("/v1/treasury/proposals/proposal-1/approve").send({}),
      request(app).post("/v1/treasury/proposals/proposal-1/execute").send({}),
    ]);
    expect(approved.status).toBe(200);
    expect(executed.status).toBe(200);
    expect(mockTreasuryService.executeProposal).toHaveBeenCalledWith(
      "proposal-1",
      BUSINESS_WALLET,
      "business-1",
    );
  });

  it("returns tenant treasury analytics for the validated period", async () => {
    mockTreasuryService.getAnalytics.mockResolvedValue({
      period: "quarter",
      totalOutflows: "500",
    });
    const response = await request(app).get(
      "/v1/treasury/analytics?period=quarter",
    );
    expect(response.status).toBe(200);
    expect(mockTreasuryService.getAnalytics).toHaveBeenCalledWith(
      "business-1",
      "quarter",
    );
  });

  it("maps unexpected service failures without exposing internals", async () => {
    mockTreasuryService.getOverview.mockRejectedValue(
      new Error("database password leaked"),
    );
    const response = await request(app).get("/v1/treasury/overview");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: "INTERNAL_ERROR",
      message: "An internal error occurred",
    });
    expect(JSON.stringify(response.body)).not.toContain("password");
  });
});
