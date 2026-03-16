import {
  createMockPrisma,
  resetAllMocks,
} from "../setup";

const mockPrisma = createMockPrisma();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

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

const mockAuditService = { createAuditEntry: jest.fn() };

jest.mock("../../services/crosschain", () => ({
  CrossChainService: jest.fn(() => mockCrossChainService),
  CrossChainError: class CrossChainError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.name = "CrossChainError";
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
import crosschainRouter from "../../routes/crosschain";
import { CrossChainError } from "../../services/crosschain";

const app = express();
app.use(express.json());
app.use("/v1/crosschain", crosschainRouter);

beforeEach(() => {
  resetAllMocks();
});

describe("CrossChain Routes", () => {
  describe("GET /v1/crosschain/chains", () => {
    it("should return supported chains", async () => {
      mockCrossChainService.getChains.mockReturnValue([
        { id: "ethereum", name: "Ethereum", status: "ACTIVE" },
        { id: "noble", name: "Noble", status: "ACTIVE" },
      ]);

      const res = await request(app).get("/v1/crosschain/chains");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it("should handle CrossChainError", async () => {
      mockCrossChainService.getChains.mockImplementation(() => {
        throw new CrossChainError("SERVICE_DOWN", "Chain service down", 503);
      });

      const res = await request(app).get("/v1/crosschain/chains");

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("SERVICE_DOWN");
    });

    it("should return 500 on unexpected error", async () => {
      mockCrossChainService.getChains.mockImplementation(() => {
        throw new Error("crash");
      });

      const res = await request(app).get("/v1/crosschain/chains");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/crosschain/routes", () => {
    it("should return routing options", async () => {
      mockCrossChainService.getRoutes.mockReturnValue([
        { protocol: "IBC", estimatedTime: "5m", fee: "0.1" },
      ]);

      const res = await request(app).get(
        "/v1/crosschain/routes?source=ethereum&destination=noble&token=USDC&amount=1000",
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should return 500 on error", async () => {
      mockCrossChainService.getRoutes.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/crosschain/routes?source=x&destination=y&token=USDC&amount=1000");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/crosschain/transfers", () => {
    it("should initiate a cross-chain transfer", async () => {
      mockCrossChainService.initiateTransfer.mockResolvedValue({
        id: "xfer-1",
        sourceChain: "ethereum",
        destChain: "noble",
        status: "PENDING",
      });

      const res = await request(app)
        .post("/v1/crosschain/transfers")
        .send({ sourceChain: "ethereum", destChain: "noble", token: "USDC", amount: "1000" });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("xfer-1");
    });

    it("should return 500 on error", async () => {
      mockCrossChainService.initiateTransfer.mockRejectedValue(new Error("crash"));

      const res = await request(app)
        .post("/v1/crosschain/transfers")
        .send({ sourceChain: "ethereum", destChain: "noble", token: "USDC", amount: "1000" });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/crosschain/transfers", () => {
    it("should list transfers", async () => {
      mockCrossChainService.listTransfers.mockReturnValue([
        { id: "xfer-1", status: "COMPLETED" },
      ]);

      const res = await request(app).get("/v1/crosschain/transfers");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should return 500 on error", async () => {
      mockCrossChainService.listTransfers.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/crosschain/transfers");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/crosschain/transfers/:id", () => {
    it("should return a specific transfer", async () => {
      mockCrossChainService.getTransfer.mockReturnValue({
        id: "xfer-1",
        status: "COMPLETED",
      });

      const res = await request(app).get("/v1/crosschain/transfers/xfer-1");

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("xfer-1");
    });

    it("should return 500 on error", async () => {
      mockCrossChainService.getTransfer.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/crosschain/transfers/xfer-1");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/crosschain/recover", () => {
    it("should recover a stuck transfer", async () => {
      mockCrossChainService.recoverTransfer.mockResolvedValue({
        id: "xfer-1",
        status: "RECOVERED",
      });

      const res = await request(app)
        .post("/v1/crosschain/recover")
        .send({ transferId: "xfer-1" });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("RECOVERED");
    });

    it("should return 500 on error", async () => {
      mockCrossChainService.recoverTransfer.mockRejectedValue(new Error("crash"));

      const res = await request(app)
        .post("/v1/crosschain/recover")
        .send({ transferId: "xfer-1" });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/crosschain/relays", () => {
    it("should return relay nodes", async () => {
      mockCrossChainService.getRelayNodes.mockReturnValue([
        { id: "relay-1", status: "ACTIVE" },
      ]);

      const res = await request(app).get("/v1/crosschain/relays");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should return 500 on error", async () => {
      mockCrossChainService.getRelayNodes.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/crosschain/relays");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/crosschain/analytics", () => {
    it("should return cross-chain analytics", async () => {
      mockCrossChainService.getAnalytics.mockReturnValue({
        totalTransfers: 100,
        totalVolume: "5000000",
      });

      const res = await request(app).get("/v1/crosschain/analytics");

      expect(res.status).toBe(200);
      expect(res.body.data.totalTransfers).toBe(100);
    });

    it("should return 500 on error", async () => {
      mockCrossChainService.getAnalytics.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/crosschain/analytics");

      expect(res.status).toBe(500);
    });
  });
});
