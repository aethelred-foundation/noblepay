import {
  createMockRequest,
  createMockResponse,
  createMockPrisma,
  resetAllMocks,
  VALID_ETH_ADDRESS,
  VALID_ETH_ADDRESS_2,
} from "../setup";

// Mock PrismaClient
const mockPrisma = createMockPrisma();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

// Mock services
const mockPaymentService = {
  createPayment: jest.fn(),
  getPayment: jest.fn(),
  listPayments: jest.fn(),
  cancelPayment: jest.fn(),
  refundPayment: jest.fn(),
  validateBusinessLimits: jest.fn(),
  calculateFees: jest.fn(),
  batchProcessPayments: jest.fn(),
  getStats: jest.fn(),
};

const mockAuditService = {
  createAuditEntry: jest.fn(),
};

jest.mock("../../services/payment", () => ({
  PaymentService: jest.fn(() => mockPaymentService),
  PaymentError: class PaymentError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.name = "PaymentError";
    }
  },
}));

jest.mock("../../services/audit", () => ({
  AuditService: jest.fn(() => mockAuditService),
}));

// Mock auth middleware to pass through and set businessId
jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: jest.fn((req: any, _res: any, next: any) => {
    req.businessId = req.businessId || "test-business-id";
    req.businessTier = "STANDARD";
    next();
  }),
  tierRateLimit: jest.fn((_req: any, _res: any, next: any) => next()),
}));

jest.mock("../../middleware/rbac", () => ({
  extractRole: jest.fn((_req: any, _res: any, next: any) => next()),
  requireRole: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  requirePermission: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Mock validation middleware to pass through
jest.mock("../../middleware/validation", () => ({
  validate: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  CreatePaymentSchema: {},
  ListPaymentsSchema: {},
  BatchPaymentSchema: {},
}));

import express from "express";
import request from "supertest";
import paymentsRouter from "../../routes/payments";
import { PaymentError } from "../../services/payment";

const app = express();
app.use(express.json());
app.use("/v1/payments", paymentsRouter);

beforeEach(() => {
  resetAllMocks();
});

describe("Payments Routes", () => {
  // ─── POST /v1/payments ──────────────────────────────────────────────────────

  describe("POST /v1/payments", () => {
    it("should create a payment successfully", async () => {
      mockPaymentService.validateBusinessLimits.mockResolvedValue({ allowed: true });
      mockPaymentService.calculateFees.mockReturnValue({ flat: 0.5, percentage: 0.1, total: 0.6 });
      mockPaymentService.createPayment.mockResolvedValue({
        id: "pay-1",
        sender: VALID_ETH_ADDRESS,
        recipient: VALID_ETH_ADDRESS_2,
        amount: BigInt(10050),
        currency: "USDC",
        status: "PENDING",
      });

      const res = await request(app)
        .post("/v1/payments")
        .send({
          sender: VALID_ETH_ADDRESS,
          recipient: VALID_ETH_ADDRESS_2,
          amount: "100.50",
          currency: "USDC",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty("fees");
    });

    it("should return 403 when business limits exceeded", async () => {
      mockPaymentService.validateBusinessLimits.mockResolvedValue({
        allowed: false,
        reason: "Daily limit exceeded",
      });

      const res = await request(app)
        .post("/v1/payments")
        .send({
          sender: VALID_ETH_ADDRESS,
          recipient: VALID_ETH_ADDRESS_2,
          amount: "999999",
          currency: "USDC",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("LIMIT_EXCEEDED");
    });

    it("should return error status when PaymentError is thrown", async () => {
      mockPaymentService.validateBusinessLimits.mockRejectedValue(
        new PaymentError("VALIDATION_FAILED", "Invalid payment", 400),
      );

      const res = await request(app)
        .post("/v1/payments")
        .send({ sender: VALID_ETH_ADDRESS, recipient: VALID_ETH_ADDRESS_2, amount: "100", currency: "USDC" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("VALIDATION_FAILED");
    });

    it("should return 500 on unexpected error", async () => {
      mockPaymentService.validateBusinessLimits.mockRejectedValue(new Error("DB down"));

      const res = await request(app)
        .post("/v1/payments")
        .send({ sender: VALID_ETH_ADDRESS, recipient: VALID_ETH_ADDRESS_2, amount: "100", currency: "USDC" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("INTERNAL_ERROR");
    });
  });

  // ─── GET /v1/payments ───────────────────────────────────────────────────────

  describe("GET /v1/payments", () => {
    it("should list payments", async () => {
      mockPaymentService.listPayments.mockResolvedValue({
        data: [
          { id: "pay-1", amount: BigInt(100), status: "PENDING" },
          { id: "pay-2", amount: BigInt(200), status: "SETTLED" },
        ],
        pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
      });

      const res = await request(app).get("/v1/payments");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.pagination.total).toBe(2);
    });

    it("should return 500 on unexpected error", async () => {
      mockPaymentService.listPayments.mockRejectedValue(new Error("DB error"));

      const res = await request(app).get("/v1/payments");

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /v1/payments/stats ─────────────────────────────────────────────────

  describe("GET /v1/payments/stats", () => {
    it("should return payment statistics", async () => {
      mockPaymentService.getStats.mockResolvedValue({
        totalPayments: 100,
        totalVolume: "50000",
        avgPayment: "500",
      });

      const res = await request(app).get("/v1/payments/stats");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.totalPayments).toBe(100);
    });

    it("should return 500 on error", async () => {
      mockPaymentService.getStats.mockRejectedValue(new Error("crash"));

      const res = await request(app).get("/v1/payments/stats");

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /v1/payments/:id ───────────────────────────────────────────────────

  describe("GET /v1/payments/:id", () => {
    it("should return a payment by ID", async () => {
      mockPaymentService.getPayment.mockResolvedValue({
        id: "pay-1",
        amount: BigInt(100),
        status: "PENDING",
      });

      const res = await request(app).get("/v1/payments/pay-1");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe("pay-1");
    });

    it("should return 404 when payment not found", async () => {
      mockPaymentService.getPayment.mockResolvedValue(null);

      const res = await request(app).get("/v1/payments/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("PAYMENT_NOT_FOUND");
    });

    it("should return 500 on unexpected error", async () => {
      mockPaymentService.getPayment.mockRejectedValue(new Error("crash"));

      const res = await request(app).get("/v1/payments/pay-1");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("INTERNAL_ERROR");
    });
  });

  // ─── POST /v1/payments/:id/cancel ───────────────────────────────────────────

  describe("POST /v1/payments/:id/cancel", () => {
    it("should cancel a payment", async () => {
      mockPaymentService.cancelPayment.mockResolvedValue({
        id: "pay-1",
        amount: BigInt(100),
        status: "CANCELLED",
      });

      const res = await request(app).post("/v1/payments/pay-1/cancel");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Payment cancelled successfully");
    });

    it("should return error when cancel fails with PaymentError", async () => {
      mockPaymentService.cancelPayment.mockRejectedValue(
        new PaymentError("INVALID_STATUS", "Cannot cancel settled payment", 409),
      );

      const res = await request(app).post("/v1/payments/pay-1/cancel");

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("INVALID_STATUS");
    });
  });

  // ─── POST /v1/payments/:id/refund ───────────────────────────────────────────

  describe("POST /v1/payments/:id/refund", () => {
    it("should refund a payment", async () => {
      mockPaymentService.refundPayment.mockResolvedValue({
        id: "pay-1",
        amount: BigInt(100),
        status: "REFUNDED",
      });

      const res = await request(app).post("/v1/payments/pay-1/refund");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Payment refunded successfully");
    });

    it("should return 500 on error", async () => {
      mockPaymentService.refundPayment.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/payments/pay-1/refund");

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /v1/payments/batch ────────────────────────────────────────────────

  describe("POST /v1/payments/batch", () => {
    it("should batch process payments", async () => {
      mockPaymentService.batchProcessPayments.mockResolvedValue({
        succeeded: [{ id: "pay-1", amount: BigInt(100) }],
        failed: [{ index: 1, error: "Invalid address" }],
      });

      const res = await request(app)
        .post("/v1/payments/batch")
        .send({
          payments: [
            { sender: VALID_ETH_ADDRESS, recipient: VALID_ETH_ADDRESS_2, amount: "100", currency: "USDC" },
            { sender: "bad", recipient: VALID_ETH_ADDRESS_2, amount: "200", currency: "USDC" },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.succeeded).toHaveLength(1);
      expect(res.body.data.failed).toHaveLength(1);
      expect(res.body.summary.total).toBe(2);
    });

    it("should return 500 on error", async () => {
      mockPaymentService.batchProcessPayments.mockRejectedValue(new Error("crash"));

      const res = await request(app)
        .post("/v1/payments/batch")
        .send({ payments: [{ sender: VALID_ETH_ADDRESS, recipient: VALID_ETH_ADDRESS_2, amount: "100", currency: "USDC" }] });

      expect(res.status).toBe(500);
    });
  });

  // ─── NP-03: Payment tenant isolation tests ────────────────────────────────

  describe("Tenant isolation (NP-03)", () => {
    it("should scope payment listing to the authenticated business", async () => {
      mockPaymentService.listPayments.mockResolvedValue({
        data: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });

      await request(app).get("/v1/payments");

      // Verify listPayments was called with businessId parameter
      expect(mockPaymentService.listPayments).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String), // businessId should be passed
      );
    });

    it("should return 403 when payment belongs to different business", async () => {
      mockPaymentService.getPayment.mockResolvedValue({
        id: "pay-1",
        amount: BigInt(100),
        status: "PENDING",
        businessId: "biz-other", // Different business
      });

      const res = await request(app).get("/v1/payments/pay-1");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });
  });
});
