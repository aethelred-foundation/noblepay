import {
  createMockPrisma,
  resetAllMocks,
} from "../setup";

const mockPrisma = createMockPrisma();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

const mockTreasuryService = {
  getOverview: jest.fn(),
  createProposal: jest.fn(),
  approveProposal: jest.fn(),
  executeProposal: jest.fn(),
  getSpendingPolicies: jest.fn(),
  getYieldStrategies: jest.fn(),
  getAnalytics: jest.fn(),
};

const mockAuditService = { createAuditEntry: jest.fn() };

jest.mock("../../services/treasury", () => ({
  TreasuryService: jest.fn(() => mockTreasuryService),
  TreasuryError: class TreasuryError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.name = "TreasuryError";
    }
  },
}));

jest.mock("../../services/audit", () => ({
  AuditService: jest.fn(() => mockAuditService),
}));

jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: jest.fn((req: any, _res: any, next: any) => {
    req.signerId = req.signerId || "test-signer-1";
    req.businessId = req.businessId || "test-biz-1";
    next();
  }),
}));

jest.mock("../../middleware/rbac", () => ({
  extractRole: jest.fn((_req: any, _res: any, next: any) => next()),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  requirePermission: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

import express from "express";
import request from "supertest";
import treasuryRouter from "../../routes/treasury";
import { TreasuryError } from "../../services/treasury";

const app = express();
app.use(express.json());
app.use("/v1/treasury", treasuryRouter);

beforeEach(() => {
  resetAllMocks();
});

describe("Treasury Routes", () => {
  describe("GET /v1/treasury/overview", () => {
    it("should return treasury overview", async () => {
      mockTreasuryService.getOverview.mockResolvedValue({
        totalBalance: "5000000",
        reserves: [],
      });

      const res = await request(app).get("/v1/treasury/overview");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.totalBalance).toBe("5000000");
    });

    it("should return error on TreasuryError", async () => {
      mockTreasuryService.getOverview.mockRejectedValue(
        new TreasuryError("NOT_FOUND", "Treasury not found", 404),
      );

      const res = await request(app).get("/v1/treasury/overview");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("NOT_FOUND");
    });

    it("should return 500 on unexpected error", async () => {
      mockTreasuryService.getOverview.mockRejectedValue(new Error("crash"));

      const res = await request(app).get("/v1/treasury/overview");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/treasury/proposals", () => {
    it("should create a proposal", async () => {
      mockTreasuryService.createProposal.mockResolvedValue({
        id: "prop-1",
        type: "TRANSFER",
        status: "PENDING",
      });

      const res = await request(app)
        .post("/v1/treasury/proposals")
        .send({ type: "TRANSFER", amount: "10000", description: "Test" });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("prop-1");
    });

    it("should return 500 on error", async () => {
      mockTreasuryService.createProposal.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/treasury/proposals").send({});

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/treasury/proposals/:id/approve", () => {
    it("should approve a proposal", async () => {
      mockTreasuryService.approveProposal.mockResolvedValue({
        id: "prop-1",
        approvals: 2,
        status: "APPROVED",
      });

      const res = await request(app).post("/v1/treasury/proposals/prop-1/approve");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("APPROVED");
    });

    it("should return 500 on error", async () => {
      mockTreasuryService.approveProposal.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/treasury/proposals/prop-1/approve");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/treasury/proposals/:id/execute", () => {
    it("should execute a proposal", async () => {
      mockTreasuryService.executeProposal.mockResolvedValue({
        id: "prop-1",
        status: "EXECUTED",
      });

      const res = await request(app).post("/v1/treasury/proposals/prop-1/execute");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("EXECUTED");
    });

    it("should return 500 on error", async () => {
      mockTreasuryService.executeProposal.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/treasury/proposals/prop-1/execute");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/treasury/policies", () => {
    it("should return spending policies", async () => {
      mockTreasuryService.getSpendingPolicies.mockReturnValue([
        { id: "pol-1", name: "Default", maxAmount: 10000 },
      ]);

      const res = await request(app).get("/v1/treasury/policies");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should return 500 on error", async () => {
      mockTreasuryService.getSpendingPolicies.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/treasury/policies");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/treasury/yield", () => {
    it("should return yield strategies", async () => {
      mockTreasuryService.getYieldStrategies.mockReturnValue([
        { id: "strat-1", name: "Conservative", apy: 3.5 },
      ]);

      const res = await request(app).get("/v1/treasury/yield");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should return 500 on error", async () => {
      mockTreasuryService.getYieldStrategies.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/treasury/yield");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/treasury/analytics", () => {
    it("should return treasury analytics", async () => {
      mockTreasuryService.getAnalytics.mockResolvedValue({
        totalInflows: "1000000",
        totalOutflows: "500000",
      });

      const res = await request(app).get("/v1/treasury/analytics?period=month");

      expect(res.status).toBe(200);
      expect(res.body.data.totalInflows).toBe("1000000");
    });

    it("should default period to month", async () => {
      mockTreasuryService.getAnalytics.mockResolvedValue({});

      await request(app).get("/v1/treasury/analytics");

      expect(mockTreasuryService.getAnalytics).toHaveBeenCalledWith(
        expect.any(String),
        "month",
      );
    });

    it("should return 500 on error", async () => {
      mockTreasuryService.getAnalytics.mockRejectedValue(new Error("crash"));

      const res = await request(app).get("/v1/treasury/analytics");

      expect(res.status).toBe(500);
    });
  });
});
