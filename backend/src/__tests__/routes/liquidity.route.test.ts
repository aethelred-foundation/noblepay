import {
  createMockPrisma,
  resetAllMocks,
} from "../setup";

const mockPrisma = createMockPrisma();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

const mockLiquidityService = {
  getPools: jest.fn(),
  getPool: jest.fn(),
  addLiquidity: jest.fn(),
  removeLiquidity: jest.fn(),
  getPositions: jest.fn(),
  requestFlashLiquidity: jest.fn(),
  getAnalytics: jest.fn(),
};

const mockAuditService = { createAuditEntry: jest.fn() };

jest.mock("../../services/liquidity", () => ({
  LiquidityService: jest.fn(() => mockLiquidityService),
  LiquidityError: class LiquidityError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.name = "LiquidityError";
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
import liquidityRouter from "../../routes/liquidity";
import { LiquidityError } from "../../services/liquidity";

const app = express();
app.use(express.json());
app.use("/v1/liquidity", liquidityRouter);

beforeEach(() => {
  resetAllMocks();
});

describe("Liquidity Routes", () => {
  describe("GET /v1/liquidity/pools", () => {
    it("should return all pools", async () => {
      mockLiquidityService.getPools.mockReturnValue([
        { id: "pool-1", pair: "USDC/AED", totalLiquidity: "1000000" },
      ]);

      const res = await request(app).get("/v1/liquidity/pools");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should filter by status", async () => {
      mockLiquidityService.getPools.mockReturnValue([]);

      await request(app).get("/v1/liquidity/pools?status=ACTIVE");

      expect(mockLiquidityService.getPools).toHaveBeenCalledWith("ACTIVE");
    });

    it("should handle LiquidityError", async () => {
      mockLiquidityService.getPools.mockImplementation(() => {
        throw new LiquidityError("POOL_ERROR", "Error", 400);
      });

      const res = await request(app).get("/v1/liquidity/pools");

      expect(res.status).toBe(400);
    });

    it("should return 500 on unexpected error", async () => {
      mockLiquidityService.getPools.mockImplementation(() => {
        throw new Error("crash");
      });

      const res = await request(app).get("/v1/liquidity/pools");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/liquidity/pools/:id", () => {
    it("should return a pool by ID", async () => {
      mockLiquidityService.getPool.mockReturnValue({
        id: "pool-1",
        pair: "USDC/AED",
      });

      const res = await request(app).get("/v1/liquidity/pools/pool-1");

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("pool-1");
    });

    it("should return 500 on error", async () => {
      mockLiquidityService.getPool.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/liquidity/pools/pool-1");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/liquidity/pools/:id/add", () => {
    it("should add liquidity to a pool", async () => {
      mockLiquidityService.addLiquidity.mockResolvedValue({
        id: "pos-1",
        poolId: "pool-1",
        amount: "50000",
      });

      const res = await request(app)
        .post("/v1/liquidity/pools/pool-1/add")
        .send({ amount: "50000", provider: "0xprovider" });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("pos-1");
    });

    it("should return 500 on error", async () => {
      mockLiquidityService.addLiquidity.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/liquidity/pools/pool-1/add").send({ amount: "50000" });

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/liquidity/pools/:id/remove", () => {
    it("should remove liquidity from a pool", async () => {
      mockLiquidityService.removeLiquidity.mockResolvedValue({
        returned: "25000",
        fees: "50",
      });

      const res = await request(app)
        .post("/v1/liquidity/pools/pool-1/remove")
        .send({ positionId: "pos-1", amount: "25000" });

      expect(res.status).toBe(200);
      expect(res.body.data.returned).toBe("25000");
    });

    it("should return 500 on error", async () => {
      mockLiquidityService.removeLiquidity.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/liquidity/pools/pool-1/remove").send({ positionId: "pos-1" });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/liquidity/positions", () => {
    it("should return all positions", async () => {
      mockLiquidityService.getPositions.mockReturnValue([
        { id: "pos-1", poolId: "pool-1" },
      ]);

      const res = await request(app).get("/v1/liquidity/positions");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should filter by provider", async () => {
      mockLiquidityService.getPositions.mockReturnValue([]);

      await request(app).get("/v1/liquidity/positions?provider=0xprovider");

      expect(mockLiquidityService.getPositions).toHaveBeenCalledWith("0xprovider", undefined);
    });

    it("should return 500 on error", async () => {
      mockLiquidityService.getPositions.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/liquidity/positions");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/liquidity/flash", () => {
    it("should request flash liquidity", async () => {
      mockLiquidityService.requestFlashLiquidity.mockResolvedValue({
        id: "flash-1",
        amount: "100000",
        fee: "100",
      });

      const res = await request(app)
        .post("/v1/liquidity/flash")
        .send({ poolId: "pool-1", amount: "100000" });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("flash-1");
    });

    it("should return 500 on error", async () => {
      mockLiquidityService.requestFlashLiquidity.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/liquidity/flash").send({ poolId: "pool-1", amount: "100000" });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/liquidity/analytics", () => {
    it("should return liquidity analytics", async () => {
      mockLiquidityService.getAnalytics.mockReturnValue({
        totalLiquidity: "5000000",
        activePools: 3,
      });

      const res = await request(app).get("/v1/liquidity/analytics");

      expect(res.status).toBe(200);
      expect(res.body.data.totalLiquidity).toBe("5000000");
    });

    it("should return 500 on error", async () => {
      mockLiquidityService.getAnalytics.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/liquidity/analytics");

      expect(res.status).toBe(500);
    });
  });
});
