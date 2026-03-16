import {
  createMockPrisma,
  resetAllMocks,
} from "../setup";

const mockPrisma = createMockPrisma();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

const mockFXService = {
  getRates: jest.fn(),
  createHedge: jest.fn(),
  markToMarket: jest.fn(),
  closePosition: jest.fn(),
  getExposure: jest.fn(),
  getAnalytics: jest.fn(),
};

const mockAuditService = { createAuditEntry: jest.fn() };

jest.mock("../../services/fx", () => ({
  FXService: jest.fn(() => mockFXService),
  FXError: class FXError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.name = "FXError";
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
import fxRouter from "../../routes/fx";
import { FXError } from "../../services/fx";

const app = express();
app.use(express.json());
app.use("/v1/fx", fxRouter);

beforeEach(() => {
  resetAllMocks();
});

describe("FX Routes", () => {
  describe("GET /v1/fx/rates", () => {
    it("should return all FX rates", async () => {
      mockFXService.getRates.mockReturnValue([
        { pair: "USDC/AED", rate: 3.6725 },
      ]);

      const res = await request(app).get("/v1/fx/rates");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should filter by pair", async () => {
      mockFXService.getRates.mockReturnValue([{ pair: "USDC/AED", rate: 3.6725 }]);

      await request(app).get("/v1/fx/rates?pair=USDC/AED");

      expect(mockFXService.getRates).toHaveBeenCalledWith("USDC/AED");
    });

    it("should handle FXError", async () => {
      mockFXService.getRates.mockImplementation(() => {
        throw new FXError("PAIR_NOT_FOUND", "Pair not found", 404);
      });

      const res = await request(app).get("/v1/fx/rates?pair=XXX/YYY");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("PAIR_NOT_FOUND");
    });

    it("should return 500 on unexpected error", async () => {
      mockFXService.getRates.mockImplementation(() => {
        throw new Error("crash");
      });

      const res = await request(app).get("/v1/fx/rates");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/fx/hedges", () => {
    it("should return 500 on error", async () => {
      mockFXService.createHedge.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/fx/hedges").send({});

      expect(res.status).toBe(500);
    });

    it("should create a hedge position", async () => {
      mockFXService.createHedge.mockResolvedValue({
        id: "hedge-1",
        pair: "USDC/AED",
        amount: "10000",
      });

      const res = await request(app)
        .post("/v1/fx/hedges")
        .send({ pair: "USDC/AED", amount: "10000", direction: "LONG" });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("hedge-1");
    });
  });

  describe("GET /v1/fx/hedges", () => {
    it("should return marked-to-market positions", async () => {
      mockFXService.markToMarket.mockReturnValue([
        { id: "hedge-1", unrealizedPnL: "50.25" },
      ]);

      const res = await request(app).get("/v1/fx/hedges");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should return 500 on error", async () => {
      mockFXService.markToMarket.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/fx/hedges");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/fx/hedges/:id/close", () => {
    it("should close a hedge position", async () => {
      mockFXService.closePosition.mockResolvedValue({
        id: "hedge-1",
        status: "CLOSED",
        realizedPnL: "75.50",
      });

      const res = await request(app).post("/v1/fx/hedges/hedge-1/close");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("CLOSED");
    });

    it("should return 500 on error", async () => {
      mockFXService.closePosition.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/fx/hedges/hedge-1/close");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/fx/exposure", () => {
    it("should return FX exposure", async () => {
      mockFXService.getExposure.mockReturnValue({
        totalExposure: "50000",
        byPair: { "USDC/AED": "30000" },
      });

      const res = await request(app).get("/v1/fx/exposure");

      expect(res.status).toBe(200);
      expect(res.body.data.totalExposure).toBe("50000");
    });

    it("should return 500 on error", async () => {
      mockFXService.getExposure.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/fx/exposure");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/fx/analytics", () => {
    it("should return FX analytics", async () => {
      mockFXService.getAnalytics.mockReturnValue({
        totalVolume: "1000000",
        activePairs: 5,
      });

      const res = await request(app).get("/v1/fx/analytics");

      expect(res.status).toBe(200);
      expect(res.body.data.totalVolume).toBe("1000000");
    });

    it("should return 500 on error", async () => {
      mockFXService.getAnalytics.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/fx/analytics");

      expect(res.status).toBe(500);
    });
  });
});
