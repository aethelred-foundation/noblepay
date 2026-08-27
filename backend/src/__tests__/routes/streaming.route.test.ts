const mockStreamingService = {
  createStream: jest.fn(),
  listStreams: jest.fn(),
  getStreamBalance: jest.fn(),
  pauseStream: jest.fn(),
  resumeStream: jest.fn(),
  cancelStream: jest.fn(),
  adjustRate: jest.fn(),
  createBatchStreams: jest.fn(),
  completeStream: jest.fn(),
  recordWithdrawal: jest.fn(),
  getAnalytics: jest.fn(),
};
jest.mock("../../lib/production-config", () => ({
  loadNoblePayChainConfiguration: () => ({
    rpcUrl: "http://rpc.invalid",
    minimumConfirmations: 3,
  }),
}));
let authenticated = true;

jest.mock("../../lib/db", () => ({ prisma: {} }));
jest.mock("../../services/audit", () => ({ AuditService: jest.fn() }));
jest.mock("../../services/streaming", () => {
  class StreamError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  }
  return {
    StreamingService: jest.fn(() => mockStreamingService),
    StreamError,
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
import router from "../../routes/streaming";
import { StreamError } from "../../services/streaming";

const app = express();
app.use(express.json());
app.use("/v1/streaming", router);

const TX_HASH = `0x${"c".repeat(64)}`;
const ON_CHAIN_ID = `0x${"d".repeat(64)}`;
const RECEIPT = { txHash: TX_HASH };

const streamInput = {
  sender: "0x1111111111111111111111111111111111111111",
  recipient: "0x2222222222222222222222222222222222222222",
  totalAmount: "100",
  currency: "USDC",
  startTime: "2026-07-21T10:00:00.000Z",
  endTime: "2026-08-21T10:00:00.000Z",
};

const validStream = {
  ...streamInput,
  txHash: TX_HASH,
  onChainStreamId: ON_CHAIN_ID,
};

describe("streaming routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authenticated = true;
  });

  it("passes a strict, bounded tenant filter to the durable list", async () => {
    mockStreamingService.listStreams.mockResolvedValue([]);

    const response = await request(app).get(
      "/v1/streaming?status=ACTIVE&currency=USDC&page=2&limit=10",
    );

    expect(response.status).toBe(200);
    expect(mockStreamingService.listStreams).toHaveBeenCalledWith({
      status: "ACTIVE",
      currency: "USDC",
      page: 2,
      limit: 10,
      businessId: "business-1",
    });
  });

  it("rejects invalid addresses, chronology, and unknown keys", async () => {
    const response = await request(app)
      .post("/v1/streaming")
      .send({
        ...validStream,
        recipient: validStream.sender,
        endTime: validStream.startTime,
        unexpected: true,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(mockStreamingService.createStream).not.toHaveBeenCalled();
  });

  it("splits the receipt out of the create request", async () => {
    mockStreamingService.createStream.mockResolvedValue({ id: "stream-1" });

    const response = await request(app).post("/v1/streaming").send(validStream);

    expect(response.status).toBe(201);
    expect(mockStreamingService.createStream).toHaveBeenCalledWith(
      streamInput,
      "business-1",
      { txHash: TX_HASH, onChainStreamId: ON_CHAIN_ID },
      expect.anything(),
    );
  });

  it("refuses a create with no receipt", async () => {
    const response = await request(app).post("/v1/streaming").send(streamInput);

    expect(response.status).toBe(400);
    expect(mockStreamingService.createStream).not.toHaveBeenCalled();
  });

  it("requires a receipt, and only a receipt, on state-changing actions", async () => {
    const unknownField = await request(app)
      .post("/v1/streaming/stream-1/pause")
      .send({ ...RECEIPT, pretendSuccess: true });
    expect(unknownField.status).toBe(400);

    const noReceipt = await request(app)
      .post("/v1/streaming/stream-1/pause")
      .send({});
    expect(noReceipt.status).toBe(400);

    expect(mockStreamingService.pauseStream).not.toHaveBeenCalled();
  });

  it("records a withdrawal so withdrawable stops over-reporting", async () => {
    mockStreamingService.recordWithdrawal.mockResolvedValue({ id: "stream-1" });

    const response = await request(app)
      .post("/v1/streaming/stream-1/withdrawals")
      .send(RECEIPT);

    expect(response.status).toBe(200);
    expect(mockStreamingService.recordWithdrawal).toHaveBeenCalledWith(
      "stream-1",
      "business-1",
      "business-1",
      RECEIPT,
      expect.anything(),
    );
  });

  it("passes tenant identity to balance reads", async () => {
    mockStreamingService.getStreamBalance.mockResolvedValue({
      streamId: "stream-1",
      withdrawable: "1",
    });

    const response = await request(app).get("/v1/streaming/stream-1/balance");

    expect(response.status).toBe(200);
    expect(mockStreamingService.getStreamBalance).toHaveBeenCalledWith(
      "stream-1",
      "business-1",
    );
  });

  it.each([
    ["pause", "pauseStream", "/v1/streaming/stream-1/pause"],
    ["resume", "resumeStream", "/v1/streaming/stream-1/resume"],
    ["cancel", "cancelStream", "/v1/streaming/stream-1/cancel"],
    ["complete", "completeStream", "/v1/streaming/stream-1/complete"],
  ])("passes the %s receipt to the service", async (_name, method, path) => {
    (mockStreamingService as any)[method].mockResolvedValue({ id: "stream-1" });

    const response = await request(app).post(path).send(RECEIPT);

    expect(response.status).toBe(200);
    expect((mockStreamingService as any)[method]).toHaveBeenCalledWith(
      "stream-1",
      "business-1",
      "business-1",
      RECEIPT,
      expect.anything(),
    );
  });

  it("surfaces a permanent rate refusal as 422, not a gate", async () => {
    // The contract has no rate-adjustment function, so this is never coming.
    mockStreamingService.adjustRate.mockRejectedValue(
      new StreamError(
        "STREAM_RATE_IMMUTABLE",
        "A stream's rate is fixed at creation",
        422,
      ),
    );

    const response = await request(app)
      .post("/v1/streaming/stream-1/adjust-rate")
      .send({ ratePerSecond: "2" });

    expect(response.status).toBe(422);
    expect(response.body.error).toBe("STREAM_RATE_IMMUTABLE");
  });

  it("surfaces the batch refusal with its own reason", async () => {
    mockStreamingService.createBatchStreams.mockRejectedValue(
      new StreamError(
        "BATCH_STREAM_UNVERIFIABLE",
        "BatchStreamsCreated does not identify the streams it created",
        501,
      ),
    );

    const response = await request(app)
      .post("/v1/streaming/batch")
      .send({ streams: [validStream], label: "payroll" });

    expect(response.status).toBe(501);
    expect(response.body.error).toBe("BATCH_STREAM_UNVERIFIABLE");
  });

  it("returns tenant-scoped stream analytics", async () => {
    mockStreamingService.getAnalytics.mockResolvedValue({
      totalActiveStreams: 2,
    });

    const response = await request(app).get("/v1/streaming/analytics");

    expect(response.status).toBe(200);
    expect(mockStreamingService.getAnalytics).toHaveBeenCalledWith(
      "business-1",
    );
  });

  it.each([
    ["create", "post", "/v1/streaming", validStream],
    ["list", "get", "/v1/streaming", undefined],
    ["balance", "get", "/v1/streaming/stream-1/balance", undefined],
    ["pause", "post", "/v1/streaming/stream-1/pause", RECEIPT],
    ["resume", "post", "/v1/streaming/stream-1/resume", RECEIPT],
    ["cancel", "post", "/v1/streaming/stream-1/cancel", RECEIPT],
    [
      "adjust",
      "post",
      "/v1/streaming/stream-1/adjust-rate",
      { ratePerSecond: "2" },
    ],
    ["batch", "post", "/v1/streaming/batch", { streams: [validStream] }],
    ["analytics", "get", "/v1/streaming/analytics", undefined],
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

  it("redacts unexpected stream service failures", async () => {
    mockStreamingService.listStreams.mockRejectedValue(
      new Error("database secret-value"),
    );

    const response = await request(app).get("/v1/streaming");

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("secret-value");
  });
});
