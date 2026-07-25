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

const mockReconciliationService = {
  reconcile: jest.fn(),
  reconcileLifecycle: jest.fn(),
};

const mockWSService = {
  broadcast: jest.fn(),
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

jest.mock("../../services/payment-reconciliation", () => ({
  PaymentReconciliationService: jest.fn(() => mockReconciliationService),
}));

jest.mock("../../services/websocket", () => ({
  wsService: mockWSService,
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
  ReconcilePaymentSchema: {},
  PaymentIdentifierParamsSchema: {},
  PaymentLifecycleSchema: {},
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
  mockWSService.broadcast.mockResolvedValue(undefined);
});

describe("Payments Routes", () => {
  // ─── POST /v1/payments ──────────────────────────────────────────────────────

  describe("POST /v1/payments", () => {
    it("retires database-only payment creation", async () => {
      const res = await request(app).post("/v1/payments").send({
        sender: VALID_ETH_ADDRESS,
        recipient: VALID_ETH_ADDRESS_2,
        amount: "100.50",
        currency: "USDC",
      });

      expect(res.status).toBe(410);
      expect(res.body.error).toBe("ON_CHAIN_INITIATION_REQUIRED");
      expect(res.body.reconcileEndpoint).toBe("/v1/payments/reconcile");
      expect(mockPaymentService.createPayment).not.toHaveBeenCalled();
    });

    it("does not trust off-chain limit checks as payment authorization", async () => {
      mockPaymentService.validateBusinessLimits.mockResolvedValue({
        allowed: false,
        reason: "Daily limit exceeded",
      });

      const res = await request(app).post("/v1/payments").send({
        sender: VALID_ETH_ADDRESS,
        recipient: VALID_ETH_ADDRESS_2,
        amount: "999999",
        currency: "USDC",
      });

      expect(res.status).toBe(410);
      expect(mockPaymentService.validateBusinessLimits).not.toHaveBeenCalled();
    });

    it("does not invoke the retired service even when it is configured to throw", async () => {
      mockPaymentService.validateBusinessLimits.mockRejectedValue(
        new PaymentError("VALIDATION_FAILED", "Invalid payment", 400),
      );

      const res = await request(app).post("/v1/payments").send({
        sender: VALID_ETH_ADDRESS,
        recipient: VALID_ETH_ADDRESS_2,
        amount: "100",
        currency: "USDC",
      });

      expect(res.status).toBe(410);
      expect(mockPaymentService.validateBusinessLimits).not.toHaveBeenCalled();
    });

    it("returns the deterministic migration response without touching the database", async () => {
      mockPaymentService.validateBusinessLimits.mockRejectedValue(
        new Error("DB down"),
      );

      const res = await request(app).post("/v1/payments").send({
        sender: VALID_ETH_ADDRESS,
        recipient: VALID_ETH_ADDRESS_2,
        amount: "100",
        currency: "USDC",
      });

      expect(res.status).toBe(410);
      expect(res.body.error).toBe("ON_CHAIN_INITIATION_REQUIRED");
    });
  });

  describe("POST /v1/payments/reconcile", () => {
    it.each([
      [false, 201, 456n],
      [true, 200, null],
    ])(
      "returns a normalized verified receipt (replayed=%s)",
      async (replayed, status, blockNumber) => {
        mockReconciliationService.reconcile.mockResolvedValue({
          payment: {
            id: "pay-1",
            amount: { toString: () => "1.5" },
            blockNumber,
            status: "PENDING",
          },
          replayed,
          confirmations: 3,
          chainId: "7332",
        });
        const body = {
          txHash: `0x${"a".repeat(64)}`,
          recipient: VALID_ETH_ADDRESS_2,
          amount: "1.5",
          currency: "USDC",
          purposeHash: `0x${"b".repeat(64)}`,
        };
        const res = await request(app)
          .post("/v1/payments/reconcile")
          .send(body);
        expect(res.status).toBe(status);
        expect(res.body.data).toMatchObject({
          amount: "1.5",
          blockNumber: blockNumber === null ? null : "456",
          replayed,
          confirmations: 3,
          chainId: "7332",
        });
        expect(mockReconciliationService.reconcile).toHaveBeenCalledWith(
          body,
          "test-business-id",
        );
        expect(mockWSService.broadcast).toHaveBeenCalledWith(
          "payments",
          "payment_update",
          expect.objectContaining({
            event: "payment_reconciled",
            recordId: "pay-1",
            status: "PENDING",
            replayed,
            confirmations: 3,
            chainId: "7332",
          }),
          "test-business-id",
        );
      },
    );

    it("preserves a reconciliation validation error", async () => {
      mockReconciliationService.reconcile.mockRejectedValue(
        new PaymentError(
          "PAYMENT_CLAIM_MISMATCH",
          "Claim does not match chain evidence",
          422,
        ),
      );
      const res = await request(app)
        .post("/v1/payments/reconcile")
        .send({ txHash: "invalid" });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("PAYMENT_CLAIM_MISMATCH");
      expect(mockWSService.broadcast).not.toHaveBeenCalled();
    });

    it("keeps a durable reconciliation successful when live delivery fails", async () => {
      mockReconciliationService.reconcile.mockResolvedValue({
        payment: {
          id: "pay-durable",
          paymentId: `0x${"c".repeat(64)}`,
          amount: { toString: () => "2" },
          blockNumber: 99n,
          status: "PENDING",
          txHash: `0x${"d".repeat(64)}`,
        },
        replayed: false,
        confirmations: 4,
        chainId: "7332",
      });
      mockWSService.broadcast.mockRejectedValueOnce(
        new Error("socket unavailable"),
      );

      const res = await request(app)
        .post("/v1/payments/reconcile")
        .send({
          txHash: `0x${"d".repeat(64)}`,
          recipient: VALID_ETH_ADDRESS_2,
          amount: "2",
          currency: "USDC",
          purposeHash: `0x${"e".repeat(64)}`,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("pay-durable");
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
        travelRuleRecord: {
          shared: false,
          sharedAt: null,
          encryptedPayload: Buffer.from("private ciphertext"),
          encryptionIv: Buffer.alloc(12),
          authenticationTag: Buffer.alloc(16),
          encryptionKeyId: "private-key-id",
          authorizationSignature: `0x${"ab".repeat(65)}`,
          challengeId: "private-challenge",
          originatorHash: `0x${"cd".repeat(32)}`,
        },
      });

      const res = await request(app).get("/v1/payments/pay-1");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe("pay-1");
      expect(res.body.data.travelRule).toEqual({
        authorized: true,
        shared: false,
        sharedAt: null,
      });
      expect(res.body.data.travelRuleRecord).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain("private");
      expect(JSON.stringify(res.body)).not.toContain("abababab");
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
    it("should reconcile a verified cancellation", async () => {
      mockReconciliationService.reconcileLifecycle.mockResolvedValue({
        payment: {
          id: "pay-1",
          amount: { toString: () => "100" },
          blockNumber: 12n,
          status: "CANCELLED",
        },
        action: "cancel",
        txHash: `0x${"a".repeat(64)}`,
        confirmations: 12,
        chainId: "7332",
        replayed: false,
      });

      const res = await request(app)
        .post("/v1/payments/pay-1/cancel")
        .send({ txHash: `0x${"a".repeat(64)}` });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.action).toBe("cancel");
      expect(mockReconciliationService.reconcileLifecycle).toHaveBeenCalledWith(
        "pay-1",
        "cancel",
        `0x${"a".repeat(64)}`,
        "test-business-id",
      );
      expect(mockWSService.broadcast).toHaveBeenCalledWith(
        "payments",
        "payment_update",
        expect.objectContaining({
          event: "payment_cancel",
          status: "CANCELLED",
        }),
        "test-business-id",
      );
    });

    it("should preserve a reconciliation PaymentError", async () => {
      mockReconciliationService.reconcileLifecycle.mockRejectedValue(
        new PaymentError(
          "INVALID_STATUS",
          "Cannot cancel settled payment",
          409,
        ),
      );

      const res = await request(app)
        .post("/v1/payments/pay-1/cancel")
        .send({ txHash: `0x${"b".repeat(64)}` });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("INVALID_STATUS");
      expect(mockWSService.broadcast).not.toHaveBeenCalled();
    });
  });

  // ─── POST /v1/payments/:id/refund ───────────────────────────────────────────

  describe("POST /v1/payments/:id/refund", () => {
    it("should expose the verified delayed-recovery method", async () => {
      mockReconciliationService.reconcileLifecycle.mockResolvedValue({
        payment: {
          id: "pay-1",
          amount: { toString: () => "100" },
          blockNumber: null,
          status: "REFUNDED",
        },
        action: "refund",
        method: "executeSettlementRecovery",
        txHash: `0x${"c".repeat(64)}`,
        confirmations: 12,
        chainId: "7332",
        replayed: false,
      });

      const res = await request(app)
        .post("/v1/payments/pay-1/refund")
        .send({ txHash: `0x${"c".repeat(64)}` });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.action).toBe("refund");
      expect(res.body.data.method).toBe("executeSettlementRecovery");
      expect(mockWSService.broadcast).toHaveBeenCalledWith(
        "payments",
        "payment_update",
        expect.objectContaining({
          event: "payment_refund",
          method: "executeSettlementRecovery",
          status: "REFUNDED",
        }),
        "test-business-id",
      );
    });

    it("should return 500 on an unexpected reconciliation error", async () => {
      mockReconciliationService.reconcileLifecycle.mockRejectedValue(
        new Error("crash"),
      );

      const res = await request(app)
        .post("/v1/payments/pay-1/refund")
        .send({ txHash: `0x${"d".repeat(64)}` });

      expect(res.status).toBe(500);
      expect(mockWSService.broadcast).not.toHaveBeenCalled();
    });
  });

  describe("POST /v1/payments/:id/settle", () => {
    it("returns 200 for an idempotent verified settlement replay", async () => {
      mockReconciliationService.reconcileLifecycle.mockResolvedValue({
        payment: {
          id: "pay-1",
          amount: { toString: () => "100" },
          blockNumber: 12n,
          status: "SETTLED",
        },
        action: "settle",
        txHash: `0x${"e".repeat(64)}`,
        confirmations: 12,
        chainId: "7332",
        replayed: true,
      });
      const res = await request(app)
        .post("/v1/payments/pay-1/settle")
        .send({ txHash: `0x${"e".repeat(64)}` });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ action: "settle", replayed: true });
      expect(mockWSService.broadcast).toHaveBeenCalledWith(
        "payments",
        "payment_update",
        expect.objectContaining({
          event: "payment_settle",
          status: "SETTLED",
          replayed: true,
        }),
        "test-business-id",
      );
    });
  });

  // ─── POST /v1/payments/batch ────────────────────────────────────────────────

  describe("POST /v1/payments/batch", () => {
    it("retires unverified database-only batches", async () => {
      mockPaymentService.batchProcessPayments.mockResolvedValue({
        succeeded: [{ id: "pay-1", amount: BigInt(100) }],
        failed: [{ index: 1, error: "Invalid address" }],
      });

      const res = await request(app)
        .post("/v1/payments/batch")
        .send({
          payments: [
            {
              sender: VALID_ETH_ADDRESS,
              recipient: VALID_ETH_ADDRESS_2,
              amount: "100",
              currency: "USDC",
            },
            {
              sender: "bad",
              recipient: VALID_ETH_ADDRESS_2,
              amount: "200",
              currency: "USDC",
            },
          ],
        });

      expect(res.status).toBe(410);
      expect(res.body.error).toBe("ON_CHAIN_BATCH_INITIATION_REQUIRED");
      expect(mockPaymentService.batchProcessPayments).not.toHaveBeenCalled();
    });

    it("returns the deterministic migration response without invoking the old service", async () => {
      mockPaymentService.batchProcessPayments.mockRejectedValue(
        new Error("crash"),
      );

      const res = await request(app)
        .post("/v1/payments/batch")
        .send({
          payments: [
            {
              sender: VALID_ETH_ADDRESS,
              recipient: VALID_ETH_ADDRESS_2,
              amount: "100",
              currency: "USDC",
            },
          ],
        });

      expect(res.status).toBe(410);
      expect(mockPaymentService.batchProcessPayments).not.toHaveBeenCalled();
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

    it("should conceal a payment outside the authenticated tenant", async () => {
      mockPaymentService.getPayment.mockResolvedValue(null);

      const res = await request(app).get("/v1/payments/pay-1");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("PAYMENT_NOT_FOUND");
      expect(mockPaymentService.getPayment).toHaveBeenCalledWith(
        "pay-1",
        "test-business-id",
      );
    });
  });
});
