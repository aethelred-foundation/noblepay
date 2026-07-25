const mockCrossChainService = {
  getChains: jest.fn(),
  getRoutes: jest.fn(),
  initiateTransfer: jest.fn(),
  listTransfers: jest.fn(),
  getTransfer: jest.fn(),
  recoverTransfer: jest.fn(),
  getRelayNodes: jest.fn(),
  getAnalytics: jest.fn(),
};
let authenticated = true;

jest.mock("../../lib/db", () => ({ prisma: {} }));
jest.mock("../../services/audit", () => ({ AuditService: jest.fn() }));
jest.mock("../../services/crosschain", () => {
  class CrossChainError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  }
  return {
    CrossChainService: jest.fn(() => mockCrossChainService),
    CrossChainError,
  };
});
jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: (
    req: { businessId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    if (authenticated) req.businessId = "business-1";
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
import router from "../../routes/crosschain";
import { CrossChainError } from "../../services/crosschain";

const app = express();
app.use(express.json());
app.use("/v1/crosschain", router);

const transfer = {
  sourceChain: "aethelred",
  destinationChain: "ethereum",
  token: "USDC",
  amount: "100",
  recipient: "0x2222222222222222222222222222222222222222",
};

describe("cross-chain routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authenticated = true;
  });

  it("returns verified chain health from the service", async () => {
    mockCrossChainService.getChains.mockResolvedValue([
      { id: "aethelred", status: "ONLINE" },
    ]);

    const response = await request(app).get("/v1/crosschain/chains");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: [{ id: "aethelred", status: "ONLINE" }],
    });
  });

  it("rejects query injection on chain health and route discovery", async () => {
    const chains = await request(app).get("/v1/crosschain/chains?fake=true");
    const sameChain = await request(app).get(
      "/v1/crosschain/routes?source=aethelred&destination=aethelred&token=USDC&amount=1",
    );

    expect(chains.status).toBe(400);
    expect(sameChain.status).toBe(400);
    expect(mockCrossChainService.getChains).not.toHaveBeenCalled();
    expect(mockCrossChainService.getRoutes).not.toHaveBeenCalled();
  });

  it("passes a strict quote request and preserves its 503 fail-closed result", async () => {
    mockCrossChainService.getRoutes.mockRejectedValue(
      new CrossChainError(
        "ROUTE_QUOTE_UNAVAILABLE",
        "No signed quote provider",
        503,
      ),
    );

    const response = await request(app).get(
      "/v1/crosschain/routes?source=aethelred&destination=ethereum&token=USDC&amount=100",
    );

    expect(response.status).toBe(503);
    expect(mockCrossChainService.getRoutes).toHaveBeenCalledWith(
      "aethelred",
      "ethereum",
      "USDC",
      "100",
    );
  });

  it("validates a transfer before surfacing the execution-unavailable status", async () => {
    mockCrossChainService.initiateTransfer.mockRejectedValue(
      new CrossChainError(
        "BRIDGE_EXECUTION_UNAVAILABLE",
        "No receipt verifier",
        501,
      ),
    );

    const invalid = await request(app)
      .post("/v1/crosschain/transfers")
      .send({ ...transfer, recipient: "not-an-address", extra: true });
    const valid = await request(app)
      .post("/v1/crosschain/transfers")
      .send(transfer);

    expect(invalid.status).toBe(400);
    expect(valid.status).toBe(501);
    expect(mockCrossChainService.initiateTransfer).toHaveBeenCalledWith(
      transfer,
      "business-1",
      "business-1",
    );
  });

  it("passes bounded transfer filters with authenticated tenant identity", async () => {
    mockCrossChainService.listTransfers.mockResolvedValue([]);

    const response = await request(app).get(
      "/v1/crosschain/transfers?status=CONFIRMING&page=2&limit=5",
    );

    expect(response.status).toBe(200);
    expect(mockCrossChainService.listTransfers).toHaveBeenCalledWith({
      status: "CONFIRMING",
      page: 2,
      limit: 5,
      businessId: "business-1",
    });
  });

  it("reads one transfer only through the authenticated tenant", async () => {
    mockCrossChainService.getTransfer.mockResolvedValue({ id: "transfer-1" });

    const response = await request(app).get(
      "/v1/crosschain/transfers/transfer-1",
    );

    expect(response.status).toBe(200);
    expect(mockCrossChainService.getTransfer).toHaveBeenCalledWith(
      "transfer-1",
      "business-1",
    );
  });

  it("preserves the explicit fail-closed recovery status", async () => {
    mockCrossChainService.recoverTransfer.mockRejectedValue(
      new CrossChainError(
        "RECOVERY_EXECUTION_UNAVAILABLE",
        "No receipt verifier",
        501,
      ),
    );

    const response = await request(app)
      .post("/v1/crosschain/recover")
      .send({ transferId: "transfer-1" });

    expect(response.status).toBe(501);
    expect(response.body.error).toBe("RECOVERY_EXECUTION_UNAVAILABLE");
    expect(mockCrossChainService.recoverTransfer).toHaveBeenCalledWith(
      "transfer-1",
      "business-1",
      "business-1",
    );
  });

  it("bounds relay registry reads", async () => {
    mockCrossChainService.getRelayNodes.mockResolvedValue([]);

    const response = await request(app).get(
      "/v1/crosschain/relays?page=4&limit=10",
    );

    expect(response.status).toBe(200);
    expect(mockCrossChainService.getRelayNodes).toHaveBeenCalledWith({
      page: 4,
      limit: 10,
    });
  });

  it("returns tenant-scoped bridge analytics", async () => {
    mockCrossChainService.getAnalytics.mockResolvedValue({ totalTransfers: 3 });

    const response = await request(app).get("/v1/crosschain/analytics");

    expect(response.status).toBe(200);
    expect(mockCrossChainService.getAnalytics).toHaveBeenCalledWith(
      "business-1",
    );
  });

  it.each([
    ["initiation", "post", "/v1/crosschain/transfers", transfer],
    ["list", "get", "/v1/crosschain/transfers", undefined],
    ["record", "get", "/v1/crosschain/transfers/transfer-1", undefined],
    [
      "recovery",
      "post",
      "/v1/crosschain/recover",
      { transferId: "transfer-1" },
    ],
    ["analytics", "get", "/v1/crosschain/analytics", undefined],
  ])(
    "rejects %s without tenant identity",
    async (_name, method, path, body) => {
      authenticated = false;
      const operation = request(app)[method as "get" | "post"](path);
      if (body) operation.send(body);

      const response = await operation;

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("UNAUTHORIZED");
    },
  );

  it("does not leak unexpected chain service failures", async () => {
    mockCrossChainService.getChains.mockRejectedValue(
      new Error("RPC credential secret-value"),
    );

    const response = await request(app).get("/v1/crosschain/chains");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: "INTERNAL_ERROR",
      message: "An internal error occurred",
    });
    expect(JSON.stringify(response.body)).not.toContain("secret-value");
  });
});
