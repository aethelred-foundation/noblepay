import {
  createMockPrisma,
  resetAllMocks,
} from "../setup";

const mockPrisma = createMockPrisma();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

const mockComplianceService = {
  submitForScreening: jest.fn(),
  getSanctionsStatus: jest.fn(),
  getComplianceMetrics: jest.fn(),
  getScreeningResult: jest.fn(),
  updateSanctionsList: jest.fn(),
  getFlaggedPayments: jest.fn(),
  reviewFlaggedPayment: jest.fn(),
};

const mockAuditService = { createAuditEntry: jest.fn() };

jest.mock("../../services/compliance", () => ({
  ComplianceService: jest.fn(() => mockComplianceService),
  ComplianceError: class ComplianceError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.name = "ComplianceError";
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

jest.mock("../../middleware/validation", () => ({
  validate: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  ComplianceScreeningSchema: {},
  ReviewDecisionSchema: {},
}));

import express from "express";
import request from "supertest";
import complianceRouter from "../../routes/compliance";
import { ComplianceError } from "../../services/compliance";

const app = express();
app.use(express.json());
app.use("/v1/compliance", complianceRouter);

beforeEach(() => {
  resetAllMocks();
});

describe("Compliance Routes", () => {
  // ─── POST /v1/compliance/screen ─────────────────────────────────────────────

  describe("POST /v1/compliance/screen", () => {
    it("should submit a payment for screening", async () => {
      mockComplianceService.submitForScreening.mockResolvedValue({
        paymentId: "pay-1",
        result: "PASS",
        riskScore: 0.1,
      });

      const res = await request(app)
        .post("/v1/compliance/screen")
        .send({ paymentId: "pay-1", priority: "normal" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.result).toBe("PASS");
    });

    it("should return error status on ComplianceError", async () => {
      mockComplianceService.submitForScreening.mockRejectedValue(
        new ComplianceError("SCREENING_FAILED", "TEE unavailable", 503),
      );

      const res = await request(app)
        .post("/v1/compliance/screen")
        .send({ paymentId: "pay-1" });

      expect(res.status).toBe(503);
      expect(res.body.error).toBe("SCREENING_FAILED");
    });

    it("should return 500 on unexpected error", async () => {
      mockComplianceService.submitForScreening.mockRejectedValue(new Error("crash"));

      const res = await request(app)
        .post("/v1/compliance/screen")
        .send({ paymentId: "pay-1" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("INTERNAL_ERROR");
    });
  });

  // ─── GET /v1/compliance/status ──────────────────────────────────────────────

  describe("GET /v1/compliance/status", () => {
    it("should return compliance engine status", async () => {
      mockComplianceService.getSanctionsStatus.mockReturnValue({
        lastUpdated: new Date().toISOString(),
        totalEntries: 1500,
      });
      mockPrisma.tEENode.findMany.mockResolvedValue([
        { address: "0xnode1", lastHeartbeat: new Date(), attestationValid: true },
      ]);

      const res = await request(app).get("/v1/compliance/status");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.engineStatus).toBe("operational");
      expect(res.body.data.activeTEENodes).toBe(1);
    });

    it("should return 500 on error", async () => {
      mockComplianceService.getSanctionsStatus.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/compliance/status");

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /v1/compliance/metrics ─────────────────────────────────────────────

  describe("GET /v1/compliance/metrics", () => {
    it("should return screening metrics", async () => {
      mockComplianceService.getComplianceMetrics.mockResolvedValue({
        totalScreenings: 500,
        passRate: 0.95,
      });

      const res = await request(app).get("/v1/compliance/metrics");

      expect(res.status).toBe(200);
      expect(res.body.data.totalScreenings).toBe(500);
    });

    it("should return 500 on error", async () => {
      mockComplianceService.getComplianceMetrics.mockRejectedValue(new Error("crash"));

      const res = await request(app).get("/v1/compliance/metrics");

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /v1/compliance/screenings/:paymentId ───────────────────────────────

  describe("GET /v1/compliance/screenings/:paymentId", () => {
    it("should return screening result for a payment", async () => {
      mockComplianceService.getScreeningResult.mockResolvedValue({
        paymentId: "pay-1",
        result: "PASS",
      });

      const res = await request(app).get("/v1/compliance/screenings/pay-1");

      expect(res.status).toBe(200);
      expect(res.body.data.paymentId).toBe("pay-1");
    });

    it("should return 500 on error", async () => {
      mockComplianceService.getScreeningResult.mockRejectedValue(new Error("crash"));

      const res = await request(app).get("/v1/compliance/screenings/pay-1");

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /v1/compliance/sanctions/update ───────────────────────────────────

  describe("POST /v1/compliance/sanctions/update", () => {
    it("should trigger sanctions list update", async () => {
      mockComplianceService.updateSanctionsList.mockResolvedValue({
        updated: true,
        entries: 1600,
      });

      const res = await request(app).post("/v1/compliance/sanctions/update");

      expect(res.status).toBe(200);
      expect(res.body.data.updated).toBe(true);
    });

    it("should return 500 on error", async () => {
      mockComplianceService.updateSanctionsList.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/compliance/sanctions/update");

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /v1/compliance/sanctions/status ────────────────────────────────────

  describe("GET /v1/compliance/sanctions/status", () => {
    it("should return sanctions list status", async () => {
      mockComplianceService.getSanctionsStatus.mockReturnValue({
        lastUpdated: "2024-01-01",
        totalEntries: 1500,
      });

      const res = await request(app).get("/v1/compliance/sanctions/status");

      expect(res.status).toBe(200);
      expect(res.body.data.totalEntries).toBe(1500);
    });

    it("should return 500 on error", async () => {
      mockComplianceService.getSanctionsStatus.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/compliance/sanctions/status");

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /v1/compliance/flagged ─────────────────────────────────────────────

  describe("GET /v1/compliance/flagged", () => {
    it("should return flagged payments", async () => {
      mockComplianceService.getFlaggedPayments.mockResolvedValue({
        data: [{ id: "pay-1", amount: BigInt(500), status: "FLAGGED" }],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      });

      const res = await request(app).get("/v1/compliance/flagged");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should parse page and limit from query", async () => {
      mockComplianceService.getFlaggedPayments.mockResolvedValue({
        data: [],
        pagination: { page: 2, limit: 10, total: 0, totalPages: 0 },
      });

      await request(app).get("/v1/compliance/flagged?page=2&limit=10");

      expect(mockComplianceService.getFlaggedPayments).toHaveBeenCalledWith(2, 10);
    });

    it("should return 500 on error", async () => {
      mockComplianceService.getFlaggedPayments.mockRejectedValue(new Error("crash"));

      const res = await request(app).get("/v1/compliance/flagged");

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /v1/compliance/flagged/:id/review ─────────────────────────────────

  describe("POST /v1/compliance/flagged/:id/review", () => {
    it("should submit a review decision", async () => {
      mockComplianceService.reviewFlaggedPayment.mockResolvedValue({
        paymentId: "pay-1",
        decision: "approve",
        reviewedAt: new Date().toISOString(),
      });

      const res = await request(app)
        .post("/v1/compliance/flagged/pay-1/review")
        .send({
          decision: "approve",
          reason: "False positive",
          reviewerAddress: "0xreviewer",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.decision).toBe("approve");
    });

    it("should return 500 on error", async () => {
      mockComplianceService.reviewFlaggedPayment.mockRejectedValue(new Error("crash"));

      const res = await request(app)
        .post("/v1/compliance/flagged/pay-1/review")
        .send({ decision: "approve", reason: "ok", reviewerAddress: "0x1" });

      expect(res.status).toBe(500);
    });
  });
});
