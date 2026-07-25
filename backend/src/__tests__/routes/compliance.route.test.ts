import { createMockPrisma, resetAllMocks } from "../setup";

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
const mockWSService = { broadcast: jest.fn() };
const mockFlaggedPaymentsQuerySchema = { name: "FlaggedPaymentsQuerySchema" };
const mockReviewDecisionSchema = { name: "ReviewDecisionSchema" };

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

jest.mock("../../services/websocket", () => ({
  wsService: mockWSService,
}));

jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: jest.fn((req: any, _res: any, next: any) => {
    req.businessId = "biz-1";
    req.signerId = "0x1111111111111111111111111111111111111111";
    next();
  }),
}));

jest.mock("../../middleware/rbac", () => ({
  extractRole: jest.fn((_req: any, _res: any, next: any) => next()),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  requirePermission: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  requireCurrentPlatformAdmin: jest.fn((_req: any, _res: any, next: any) =>
    next(),
  ),
}));

jest.mock("../../middleware/validation", () => ({
  validate: jest.fn(
    (schema: unknown, source = "body") =>
      (req: any, res: any, next: any) => {
        if (schema === mockFlaggedPaymentsQuerySchema && source === "query") {
          req.query = {
            page: req.query.page === undefined ? 1 : Number(req.query.page),
            limit: req.query.limit === undefined ? 20 : Number(req.query.limit),
          };
        }
        if (
          schema === mockReviewDecisionSchema &&
          req.body.decision !== "escalate"
        ) {
          res.status(400).json({ error: "VALIDATION_ERROR" });
          return;
        }
        next();
      },
  ),
  ComplianceScreeningSchema: {},
  FlaggedPaymentsQuerySchema: mockFlaggedPaymentsQuerySchema,
  ReviewDecisionSchema: mockReviewDecisionSchema,
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
        id: "screen-1",
        paymentId: "pay-1",
        status: "PASSED",
        amlRiskScore: 10,
        sanctionsClear: true,
        travelRuleCompliant: true,
        submissionTxHash: `0x${"a".repeat(64)}`,
        submissionBlockNumber: "100",
        confirmations: 3,
      });

      const res = await request(app)
        .post("/v1/compliance/screen")
        .send({ paymentId: "pay-1", priority: "normal" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("PASSED");
      expect(mockWSService.broadcast).toHaveBeenNthCalledWith(
        1,
        "compliance",
        "compliance_decision",
        expect.objectContaining({
          event: "screening_completed",
          screeningId: "screen-1",
          paymentId: "pay-1",
          status: "PASSED",
          riskScore: 10,
        }),
        "biz-1",
      );
      expect(mockWSService.broadcast).toHaveBeenNthCalledWith(
        2,
        "risk",
        "risk_update",
        expect.objectContaining({
          event: "screening_completed",
          paymentId: "pay-1",
        }),
        "biz-1",
      );
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
      expect(mockWSService.broadcast).not.toHaveBeenCalled();
    });

    it("should return 500 on unexpected error", async () => {
      mockComplianceService.submitForScreening.mockRejectedValue(
        new Error("crash"),
      );

      const res = await request(app)
        .post("/v1/compliance/screen")
        .send({ paymentId: "pay-1" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("INTERNAL_ERROR");
      expect(mockWSService.broadcast).not.toHaveBeenCalled();
    });

    it("keeps a persisted screening successful when live delivery fails", async () => {
      mockComplianceService.submitForScreening.mockResolvedValue({
        id: "screen-durable",
        paymentId: "pay-durable",
        status: "UNDER_REVIEW",
        amlRiskScore: 72,
        sanctionsClear: true,
        travelRuleCompliant: true,
        submissionTxHash: `0x${"b".repeat(64)}`,
        submissionBlockNumber: "101",
        confirmations: 4,
      });
      mockWSService.broadcast.mockImplementationOnce(() => {
        throw new Error("socket unavailable");
      });

      const res = await request(app)
        .post("/v1/compliance/screen")
        .send({ paymentId: "pay-durable", priority: "high" });

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("screen-durable");
      expect(mockWSService.broadcast).toHaveBeenCalledTimes(2);
    });
  });

  // ─── GET /v1/compliance/status ──────────────────────────────────────────────

  describe("GET /v1/compliance/status", () => {
    it("should return compliance engine status", async () => {
      mockComplianceService.getSanctionsStatus.mockReturnValue({
        lastUpdated: new Date().toISOString(),
        totalEntries: 1500,
      });
      const res = await request(app).get("/v1/compliance/status");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.engineStatus).toBe("healthy");
      expect(res.body.data.checkedAt).toEqual(expect.any(String));
      expect(res.body.data.settlementEvidence).toBe(
        "verified_per_submission",
      );
      expect(res.body.data).not.toHaveProperty("teeNodes");
      expect(res.body.data).not.toHaveProperty("activeTEENodes");
    });

    it("should return 500 on error", async () => {
      mockComplianceService.getSanctionsStatus.mockImplementation(() => {
        throw new Error("crash");
      });

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
      mockComplianceService.getComplianceMetrics.mockRejectedValue(
        new Error("crash"),
      );

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
      mockComplianceService.getScreeningResult.mockRejectedValue(
        new Error("crash"),
      );

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
      mockComplianceService.updateSanctionsList.mockRejectedValue(
        new Error("crash"),
      );

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
      mockComplianceService.getSanctionsStatus.mockImplementation(() => {
        throw new Error("crash");
      });

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

      expect(mockComplianceService.getFlaggedPayments).toHaveBeenCalledWith(
        "biz-1",
        2,
        10,
      );
    });

    it("should return 500 on error", async () => {
      mockComplianceService.getFlaggedPayments.mockRejectedValue(
        new Error("crash"),
      );

      const res = await request(app).get("/v1/compliance/flagged");

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /v1/compliance/flagged/:id/review ─────────────────────────────────

  describe("POST /v1/compliance/flagged/:id/review", () => {
    it("should submit a review decision", async () => {
      mockComplianceService.reviewFlaggedPayment.mockResolvedValue({
        paymentId: "pay-1",
        decision: "escalate",
        newStatus: "FLAGGED",
        reviewedAt: new Date("2026-07-22T08:00:00.000Z"),
      });

      const res = await request(app)
        .post("/v1/compliance/flagged/pay-1/review")
        .send({
          decision: "escalate",
          reason: "False positive",
          reviewerAddress: "0xreviewer",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.decision).toBe("escalate");
      expect(mockComplianceService.reviewFlaggedPayment).toHaveBeenCalledWith(
        "pay-1",
        "escalate",
        "False positive",
        "0x1111111111111111111111111111111111111111",
        "biz-1",
      );
      expect(mockWSService.broadcast).toHaveBeenNthCalledWith(
        1,
        "compliance",
        "compliance_decision",
        expect.objectContaining({
          event: "review_recorded",
          paymentId: "pay-1",
          decision: "escalate",
          status: "FLAGGED",
          reviewedAt: "2026-07-22T08:00:00.000Z",
        }),
        "biz-1",
      );
      expect(mockWSService.broadcast).toHaveBeenNthCalledWith(
        2,
        "risk",
        "risk_update",
        expect.objectContaining({
          event: "review_recorded",
          paymentId: "pay-1",
        }),
        "biz-1",
      );
    });

    it.each(["approve", "reject"])(
      "does not advertise the unsupported off-chain %s decision",
      async (decision) => {
        const res = await request(app)
          .post("/v1/compliance/flagged/pay-1/review")
          .send({ decision, reason: "Requires governed on-chain resolution" });

        expect(res.status).toBe(400);
        expect(
          mockComplianceService.reviewFlaggedPayment,
        ).not.toHaveBeenCalled();
      },
    );

    it("should return 500 on error", async () => {
      mockComplianceService.reviewFlaggedPayment.mockRejectedValue(
        new Error("crash"),
      );

      const res = await request(app)
        .post("/v1/compliance/flagged/pay-1/review")
        .send({ decision: "escalate", reason: "ok", reviewerAddress: "0x1" });

      expect(res.status).toBe(500);
      expect(mockWSService.broadcast).not.toHaveBeenCalled();
    });
  });
});
