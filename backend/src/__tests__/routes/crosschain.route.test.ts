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
const SIGNER = "0x2E8625F06A696b556B7B5e0C1b34B1cb55203af1";

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
    req: { businessId?: string; signerId?: string; apiKeyId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    if (authenticated) {
      req.businessId = "business-1";
      // Transfer mutations now require a wallet-authenticated session, because
      // the chain receipt is bound to the signer's address.
      req.signerId = SIGNER;
    }
    next();
  },
}));
jest.mock("../../lib/production-config", () => ({
  loadNoblePayChainConfiguration: () => ({
    rpcUrl: "http://rpc.invalid",
    minimumConfirmations: 3,
  }),
}));
jest.mock("../../services/crosschain-execution", () => {
  class TransferVerificationError extends Error {
    constructor(
      public reason: string,
      message: string,
      public statusCode = 422,
    ) {
      super(message);
      this.name = "TransferVerificationError";
    }
  }
  return { TransferVerificationError };
});
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
import { TransferVerificationError } from "../../services/crosschain-execution";

const app = express();
app.use(express.json());
app.use("/v1/crosschain", router);

const transfer = {
  sourceChain: "aethelred",
  destinationChain: "ethereum",
  token: "USDC",
  amount: "100",
  recipient: "0x2222222222222222222222222222222222222222",
  txHash: `0x${"c".repeat(64)}`,
  onChainTransferId: `0x${"d".repeat(64)}`,
};

const recoverBody = {
  transferId: "transfer-1",
  txHash: `0x${"f".repeat(64)}`,
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

  it("validates a transfer and passes the receipt with the WALLET signer", async () => {
    mockCrossChainService.initiateTransfer.mockResolvedValue({
      id: "transfer-1",
      status: "INITIATED",
    });

    const invalid = await request(app)
      .post("/v1/crosschain/transfers")
      .send({ ...transfer, recipient: "not-an-address", extra: true });
    const valid = await request(app)
      .post("/v1/crosschain/transfers")
      .send(transfer);

    expect(invalid.status).toBe(400);
    expect(valid.status).toBe(201);

    // The receipt is split out of the transfer input, and the sender is the
    // wallet signer rather than the business id the route used to pass.
    const { txHash, onChainTransferId, ...input } = transfer;
    expect(mockCrossChainService.initiateTransfer).toHaveBeenCalledWith(
      input,
      SIGNER,
      "business-1",
      { txHash, onChainTransferId },
      expect.anything(),
    );
  });

  it("rejects an initiation with no receipt", async () => {
    // A transfer record without a receipt is an unverifiable claim that funds
    // moved, so the schema refuses it before the service is reached.
    const { txHash: _t, onChainTransferId: _o, ...noReceipt } = transfer;

    const response = await request(app)
      .post("/v1/crosschain/transfers")
      .send(noReceipt);

    expect(response.status).toBe(400);
    expect(mockCrossChainService.initiateTransfer).not.toHaveBeenCalled();
  });

  it("maps a verification failure to its own reason and status", async () => {
    mockCrossChainService.initiateTransfer.mockRejectedValue(
      new TransferVerificationError(
        "TRANSFER_RECIPIENT_MISMATCH",
        "commitment mismatch",
      ),
    );

    const response = await request(app)
      .post("/v1/crosschain/transfers")
      .send(transfer);

    expect(response.status).toBe(422);
    expect(response.body.error).toBe("TRANSFER_RECIPIENT_MISMATCH");
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

  it("passes the recovery receipt and the WALLET signer to the service", async () => {
    // The third argument used to be businessId, which the 501 gate concealed.
    // A chain receipt is bound to an address, so a business id in that slot
    // would have failed every verification.
    mockCrossChainService.recoverTransfer.mockResolvedValue({
      id: "transfer-1",
      status: "RECOVERED",
    });

    const response = await request(app)
      .post("/v1/crosschain/recover")
      .send(recoverBody);

    expect(response.status).toBe(200);
    expect(mockCrossChainService.recoverTransfer).toHaveBeenCalledWith(
      "transfer-1",
      SIGNER,
      "business-1",
      { txHash: recoverBody.txHash },
      expect.anything(),
    );
  });

  it("rejects a recovery with no receipt", async () => {
    const response = await request(app)
      .post("/v1/crosschain/recover")
      .send({ transferId: "transfer-1" });

    expect(response.status).toBe(400);
    expect(mockCrossChainService.recoverTransfer).not.toHaveBeenCalled();
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
    ["recovery", "post", "/v1/crosschain/recover", recoverBody],
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
