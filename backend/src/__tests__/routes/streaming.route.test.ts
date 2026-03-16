import {
  createMockPrisma,
  resetAllMocks,
} from "../setup";

const mockPrisma = createMockPrisma();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

const mockStreamingService = {
  createStream: jest.fn(),
  listStreams: jest.fn(),
  getStream: jest.fn(),
  getStreamBalance: jest.fn(),
  pauseStream: jest.fn(),
  resumeStream: jest.fn(),
  cancelStream: jest.fn(),
  adjustRate: jest.fn(),
  createBatchStreams: jest.fn(),
  getAnalytics: jest.fn(),
};

const mockAuditService = { createAuditEntry: jest.fn() };

jest.mock("../../services/streaming", () => ({
  StreamingService: jest.fn(() => mockStreamingService),
  StreamError: class StreamError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.name = "StreamError";
    }
  },
}));

jest.mock("../../services/audit", () => ({
  AuditService: jest.fn(() => mockAuditService),
}));

jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: jest.fn((_req: any, _res: any, next: any) => next()),
}));

jest.mock("../../middleware/rbac", () => ({
  extractRole: jest.fn((_req: any, _res: any, next: any) => next()),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  requirePermission: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

import express from "express";
import request from "supertest";
import streamingRouter from "../../routes/streaming";
import { StreamError } from "../../services/streaming";

const app = express();
app.use(express.json());
app.use("/v1/streaming", streamingRouter);

beforeEach(() => {
  resetAllMocks();
});

describe("Streaming Routes", () => {
  describe("POST /v1/streaming", () => {
    it("should create a stream", async () => {
      mockStreamingService.createStream.mockResolvedValue({
        id: "stream-1",
        status: "ACTIVE",
        ratePerSecond: "0.001",
      });

      const res = await request(app)
        .post("/v1/streaming")
        .send({ sender: "0x1", recipient: "0x2", totalAmount: "1000", ratePerSecond: "0.001" });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("stream-1");
    });

    it("should handle StreamError", async () => {
      mockStreamingService.createStream.mockRejectedValue(
        new StreamError("INVALID_RATE", "Rate too low", 400),
      );

      const res = await request(app).post("/v1/streaming").send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_RATE");
    });

    it("should return 500 on unexpected error", async () => {
      mockStreamingService.createStream.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/streaming").send({});

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/streaming", () => {
    it("should list streams", async () => {
      mockStreamingService.listStreams.mockReturnValue([
        { id: "stream-1", status: "ACTIVE" },
      ]);

      const res = await request(app).get("/v1/streaming");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should return 500 on error", async () => {
      mockStreamingService.listStreams.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/streaming");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/streaming/:id/balance", () => {
    it("should return stream balance", async () => {
      mockStreamingService.getStream.mockReturnValue({
        id: "stream-1",
        businessId: undefined,
      });
      mockStreamingService.getStreamBalance.mockReturnValue({
        streamed: "500",
        remaining: "500",
      });

      const res = await request(app).get("/v1/streaming/stream-1/balance");

      expect(res.status).toBe(200);
      expect(res.body.data.streamed).toBe("500");
    });

    it("should return 404 when stream not found", async () => {
      mockStreamingService.getStream.mockReturnValue(undefined);

      const res = await request(app).get("/v1/streaming/stream-1/balance");

      expect(res.status).toBe(404);
    });

    it("should return 500 on error", async () => {
      mockStreamingService.getStream.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/streaming/stream-1/balance");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/streaming/:id/pause", () => {
    it("should pause a stream", async () => {
      mockStreamingService.pauseStream.mockResolvedValue({ id: "stream-1", status: "PAUSED" });

      const res = await request(app).post("/v1/streaming/stream-1/pause");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("PAUSED");
    });

    it("should return 500 on error", async () => {
      mockStreamingService.pauseStream.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/streaming/stream-1/pause");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/streaming/:id/resume", () => {
    it("should resume a stream", async () => {
      mockStreamingService.resumeStream.mockResolvedValue({ id: "stream-1", status: "ACTIVE" });

      const res = await request(app).post("/v1/streaming/stream-1/resume");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("ACTIVE");
    });

    it("should return 500 on error", async () => {
      mockStreamingService.resumeStream.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/streaming/stream-1/resume");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/streaming/:id/cancel", () => {
    it("should cancel a stream", async () => {
      mockStreamingService.cancelStream.mockResolvedValue({ id: "stream-1", status: "CANCELLED" });

      const res = await request(app).post("/v1/streaming/stream-1/cancel");

      expect(res.status).toBe(200);
    });

    it("should return 500 on error", async () => {
      mockStreamingService.cancelStream.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/streaming/stream-1/cancel");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/streaming/:id/adjust-rate", () => {
    it("should adjust stream rate", async () => {
      mockStreamingService.adjustRate.mockResolvedValue({
        id: "stream-1",
        ratePerSecond: "0.002",
      });

      const res = await request(app)
        .post("/v1/streaming/stream-1/adjust-rate")
        .send({ ratePerSecond: "0.002" });

      expect(res.status).toBe(200);
      expect(res.body.data.ratePerSecond).toBe("0.002");
    });

    it("should return 500 on error", async () => {
      mockStreamingService.adjustRate.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/streaming/stream-1/adjust-rate").send({ ratePerSecond: "0.002" });

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/streaming/batch", () => {
    it("should batch create streams", async () => {
      mockStreamingService.createBatchStreams.mockResolvedValue({
        created: [{ id: "stream-1" }],
        failed: [],
      });

      const res = await request(app)
        .post("/v1/streaming/batch")
        .send({ streams: [{ sender: "0x1", recipient: "0x2" }] });

      expect(res.status).toBe(201);
    });

    it("should return 500 on error", async () => {
      mockStreamingService.createBatchStreams.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/streaming/batch").send({ streams: [] });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/streaming/analytics", () => {
    it("should return streaming analytics", async () => {
      mockStreamingService.getAnalytics.mockReturnValue({
        totalStreams: 10,
        activeStreams: 5,
      });

      const res = await request(app).get("/v1/streaming/analytics");

      expect(res.status).toBe(200);
      expect(res.body.data.totalStreams).toBe(10);
    });

    it("should return 500 on error", async () => {
      mockStreamingService.getAnalytics.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/streaming/analytics");

      expect(res.status).toBe(500);
    });
  });
});
