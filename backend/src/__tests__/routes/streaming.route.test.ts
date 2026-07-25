const mockStreamingService = {
  createStream: jest.fn(),
  listStreams: jest.fn(),
  getStreamBalance: jest.fn(),
  pauseStream: jest.fn(),
  resumeStream: jest.fn(),
  cancelStream: jest.fn(),
  adjustRate: jest.fn(),
  createBatchStreams: jest.fn(),
  getAnalytics: jest.fn(),
};
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

const validStream = {
  sender: "0x1111111111111111111111111111111111111111",
  recipient: "0x2222222222222222222222222222222222222222",
  totalAmount: "100",
  currency: "USDC",
  startTime: "2026-07-21T10:00:00.000Z",
  endTime: "2026-08-21T10:00:00.000Z",
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

  it("validates a create request before surfacing the fail-closed response", async () => {
    mockStreamingService.createStream.mockRejectedValue(
      new StreamError(
        "ONCHAIN_SETTLEMENT_UNAVAILABLE",
        "Receipt verifier unavailable",
        501,
      ),
    );

    const response = await request(app).post("/v1/streaming").send(validStream);

    expect(response.status).toBe(501);
    expect(mockStreamingService.createStream).toHaveBeenCalledWith(
      validStream,
      "business-1",
    );
  });

  it("requires empty bodies for state-changing stream actions", async () => {
    const invalid = await request(app)
      .post("/v1/streaming/stream-1/pause")
      .send({ pretendSuccess: true });

    expect(invalid.status).toBe(400);
    expect(mockStreamingService.pauseStream).not.toHaveBeenCalled();
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
    [
      "pause",
      "pauseStream",
      "/v1/streaming/stream-1/pause",
      {},
      ["stream-1", "business-1", "business-1"],
    ],
    [
      "resume",
      "resumeStream",
      "/v1/streaming/stream-1/resume",
      {},
      ["stream-1", "business-1", "business-1"],
    ],
    [
      "cancel",
      "cancelStream",
      "/v1/streaming/stream-1/cancel",
      {},
      ["stream-1", "business-1", "business-1"],
    ],
    [
      "rate adjustment",
      "adjustRate",
      "/v1/streaming/stream-1/adjust-rate",
      { ratePerSecond: "2" },
      ["stream-1", "2", "business-1", "business-1"],
    ],
    [
      "batch creation",
      "createBatchStreams",
      "/v1/streaming/batch",
      { streams: [validStream], label: "payroll" },
      [{ streams: [validStream], label: "payroll", businessId: "business-1" }],
    ],
  ])(
    "validates %s and preserves the settlement-unavailable result",
    async (_name, method, path, body, expectedArgs) => {
      (mockStreamingService as any)[method].mockRejectedValue(
        new StreamError(
          "ONCHAIN_SETTLEMENT_UNAVAILABLE",
          "Receipt verifier unavailable",
          501,
        ),
      );

      const response = await request(app).post(path).send(body);

      expect(response.status).toBe(501);
      expect(response.body.error).toBe("ONCHAIN_SETTLEMENT_UNAVAILABLE");
      expect((mockStreamingService as any)[method]).toHaveBeenCalledWith(
        ...expectedArgs,
      );
    },
  );

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
    ["pause", "post", "/v1/streaming/stream-1/pause", {}],
    ["resume", "post", "/v1/streaming/stream-1/resume", {}],
    ["cancel", "post", "/v1/streaming/stream-1/cancel", {}],
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
