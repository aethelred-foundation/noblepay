/**
 * Tenant Isolation Integration Tests
 *
 * Proves that:
 *   - Business A cannot read Business B's data across all domains
 *   - VIEWER role cannot access admin-only routes
 *   - ANALYST role cannot access mutation routes
 *
 * Auth/RBAC middleware runs un-mocked. Only infrastructure (logger, metrics)
 * and data services are mocked so we can control responses without a live DB.
 */

// ─── Mock Logger & Metrics (infrastructure only) ────────────────────────────

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
};

jest.mock("../../lib/logger", () => ({
  logger: mockLogger,
  generateCorrelationId: jest.fn().mockReturnValue("tenant-iso-corr-id"),
  createRequestLogger: jest.fn().mockReturnValue(mockLogger),
}));

jest.mock("../../lib/metrics", () => ({
  paymentTotal: { inc: jest.fn() },
  paymentAmount: { observe: jest.fn() },
  screeningDuration: { observe: jest.fn() },
  compliancePassRate: { set: jest.fn() },
  flaggedPayments: { set: jest.fn() },
  activeBusinesses: { set: jest.fn() },
  httpRequestDuration: { observe: jest.fn() },
  httpRequestTotal: { inc: jest.fn() },
  teeAttestationFailures: { inc: jest.fn() },
  register: { metrics: jest.fn() },
}));

// ─── Mock Prisma ────────────────────────────────────────────────────────────

function createMockModel() {
  return {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
    upsert: jest.fn(),
  };
}

const mockPrisma: any = {
  payment: createMockModel(),
  business: createMockModel(),
  auditLog: createMockModel(),
  complianceScreening: createMockModel(),
  tEENode: createMockModel(),
  aPIKey: createMockModel(),
  travelRuleRecord: createMockModel(),
  treasuryProposal: createMockModel(),
  $connect: jest.fn(),
  $disconnect: jest.fn(),
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
};

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
  BusinessTier: {
    STARTER: "STARTER",
    STANDARD: "STANDARD",
    ENTERPRISE: "ENTERPRISE",
    INSTITUTIONAL: "INSTITUTIONAL",
  },
}));

// Authentication is chain-authoritative in production. These route tests keep
// that boundary intact while replacing RPC I/O with a verified registry
// snapshot for the registered wallet under test.
jest.mock("../../lib/business-registry-authorization", () => ({
  getCurrentBusinessRegistryAuthorization: jest.fn(async (address: string) => ({
    wallet: address,
    status: "VERIFIED",
    tier: "STANDARD",
    active: true,
    isAdmin: false,
    registeredAt: 1n,
    lastVerified: 1n,
    expiresAt: 2n,
    blockNumber: 100,
    blockHash: `0x${"ab".repeat(32)}`,
  })),
}));

// ─── Mock Services (data layer only, NOT auth/rbac) ─────────────────────────

const mockPaymentService = {
  createPayment: jest.fn(),
  listPayments: jest.fn(),
  getPayment: jest.fn(),
  getStats: jest.fn(),
  batchProcessPayments: jest.fn(),
  validateBusinessLimits: jest.fn(),
  calculateFees: jest.fn(),
};

const mockAuditService = {
  createAuditEntry: jest.fn(),
  listAuditEntries: jest.fn(),
  getAuditEntry: jest.fn(),
  verifyChainIntegrity: jest.fn(),
  getAuditStats: jest.fn(),
  generateExport: jest.fn(),
};

const mockInvoiceService = {
  createInvoice: jest.fn(),
  listInvoices: jest.fn(),
  getCreditScore: jest.fn(),
  getAnalytics: jest.fn(),
  requestFinancing: jest.fn(),
  settleInvoice: jest.fn(),
  raiseDispute: jest.fn(),
};

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

const mockFXService = {
  getRates: jest.fn(),
  createHedge: jest.fn(),
  listPositions: jest.fn(),
  markToMarket: jest.fn(),
  closePosition: jest.fn(),
  getExposure: jest.fn(),
  getAnalytics: jest.fn(),
};

const mockLiquidityService = {
  getPools: jest.fn(),
  getPool: jest.fn(),
  addLiquidity: jest.fn(),
  removeLiquidity: jest.fn(),
  getPositions: jest.fn(),
  requestFlashLiquidity: jest.fn(),
  getAnalytics: jest.fn(),
};

jest.mock("../../services/payment", () => {
  const actual = jest.requireActual("../../services/payment");
  return { ...actual, PaymentService: jest.fn(() => mockPaymentService) };
});

jest.mock("../../services/audit", () => ({
  AuditService: jest.fn(() => mockAuditService),
}));

jest.mock("../../services/invoice", () => {
  const actual = jest.requireActual("../../services/invoice");
  return { ...actual, InvoiceService: jest.fn(() => mockInvoiceService) };
});

jest.mock("../../services/streaming", () => {
  const actual = jest.requireActual("../../services/streaming");
  return { ...actual, StreamingService: jest.fn(() => mockStreamingService) };
});

jest.mock("../../services/crosschain", () => {
  const actual = jest.requireActual("../../services/crosschain");
  return { ...actual, CrossChainService: jest.fn(() => mockCrossChainService) };
});

jest.mock("../../services/fx", () => {
  const actual = jest.requireActual("../../services/fx");
  return { ...actual, FXService: jest.fn(() => mockFXService) };
});

jest.mock("../../services/liquidity", () => {
  const actual = jest.requireActual("../../services/liquidity");
  return { ...actual, LiquidityService: jest.fn(() => mockLiquidityService) };
});

// ─── NOTE: auth.ts and rbac.ts are NOT mocked ──────────────────────────────

import express from "express";
import request from "supertest";
import { generateJWT } from "../../middleware/auth";

import paymentRouter from "../../routes/payments";
import invoiceRouter from "../../routes/invoices";
import streamingRouter from "../../routes/streaming";
import crosschainRouter from "../../routes/crosschain";
import fxRouter from "../../routes/fx";
import liquidityRouter from "../../routes/liquidity";
import businessRouter from "../../routes/businesses";
import auditRouter from "../../routes/audit";
import complianceRouter from "../../routes/compliance";
import reportingRouter from "../../routes/reporting";
import treasuryRouter from "../../routes/treasury";

// ─── App Setup ──────────────────────────────────────────────────────────────

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/payments", paymentRouter);
  app.use("/v1/invoices", invoiceRouter);
  app.use("/v1/streams", streamingRouter);
  app.use("/v1/crosschain", crosschainRouter);
  app.use("/v1/fx", fxRouter);
  app.use("/v1/liquidity", liquidityRouter);
  app.use("/v1/businesses", businessRouter);
  app.use("/v1/audit", auditRouter);
  app.use("/v1/compliance", complianceRouter);
  app.use("/v1/reports", reportingRouter);
  app.use("/v1/treasury", treasuryRouter);
  return app;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const BIZ_A = "business-a-id";
const BIZ_B = "business-b-id";
const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";
const PAYMENT_A = "11111111-1111-4111-8111-111111111111";
const PAYMENT_B = "22222222-2222-4222-8222-222222222222";

function tokenFor(businessId: string, role: string): string {
  return generateJWT(
    businessId,
    "STANDARD" as any,
    role,
    businessId === BIZ_A ? WALLET_A : WALLET_B,
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Tenant Isolation Integration Tests", () => {
  let app: express.Express;

  beforeAll(() => {
    process.env.NODE_ENV = "test";
    app = buildApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockPrisma.business.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => {
        const address =
          where.id === BIZ_A ? WALLET_A : where.id === BIZ_B ? WALLET_B : null;
        return address ? { id: where.id, address } : null;
      },
    );

    // ── Default stubs: all services return data scoped to the caller ────
    mockPaymentService.listPayments.mockImplementation(
      (_filters: any, businessId?: string) => ({
        data:
          businessId === BIZ_A
            ? [
                {
                  id: PAYMENT_A,
                  businessId: BIZ_A,
                  amount: 100n,
                  currency: "USDC",
                },
              ]
            : [],
        pagination: { page: 1, limit: 20, total: businessId === BIZ_A ? 1 : 0 },
      }),
    );

    mockPaymentService.getPayment.mockImplementation(
      (id: string, businessId?: string) => {
        if (id === PAYMENT_A && businessId === BIZ_A) {
          return { id: PAYMENT_A, businessId: BIZ_A, amount: 100n };
        }
        if (id === PAYMENT_B && businessId === BIZ_B) {
          return { id: PAYMENT_B, businessId: BIZ_B, amount: 200n };
        }
        return null;
      },
    );

    mockInvoiceService.listInvoices.mockImplementation((filters: any) =>
      filters?.businessId === BIZ_A
        ? [{ id: "inv-a-1", businessId: BIZ_A }]
        : [],
    );

    mockStreamingService.listStreams.mockImplementation((filters: any) =>
      filters?.businessId === BIZ_A
        ? [{ id: "stream-a-1", businessId: BIZ_A }]
        : [],
    );

    mockCrossChainService.listTransfers.mockImplementation((filters: any) =>
      filters?.businessId === BIZ_A
        ? [{ id: "xfer-a-1", businessId: BIZ_A }]
        : [],
    );

    mockCrossChainService.getTransfer.mockImplementation(
      (id: string, businessId?: string) => {
        if (id === "xfer-a-1" && businessId === BIZ_A)
          return { id: "xfer-a-1", businessId: BIZ_A };
        if (id === "xfer-a-1" && businessId !== BIZ_A) {
          const err = new (jest.requireActual(
            "../../services/crosschain",
          ).CrossChainError)(
            "FORBIDDEN",
            "You do not have access to this transfer",
            403,
          );
          throw err;
        }
        return null;
      },
    );

    mockFXService.listPositions.mockImplementation((businessId?: string) =>
      businessId === BIZ_A ? [{ id: "fx-a-1", businessId: BIZ_A }] : [],
    );

    mockLiquidityService.getPositions.mockImplementation(
      (businessId?: string) =>
        businessId === BIZ_A ? [{ id: "lp-a-1", businessId: BIZ_A }] : [],
    );

    mockFXService.getExposure.mockImplementation((businessId: string) => ({
      businessId,
      totalNotional: businessId === BIZ_A ? "50000" : "0",
      positions: [],
    }));

    // Stubs for mutation routes (so they succeed for authorized callers)
    mockPaymentService.validateBusinessLimits.mockResolvedValue({
      allowed: true,
    });
    mockPaymentService.calculateFees.mockReturnValue({
      baseFee: "0.01",
      totalFee: "0.01",
    });
    mockPaymentService.createPayment.mockResolvedValue({
      id: "pay-new",
      businessId: BIZ_A,
      amount: 100n,
      currency: "USDC",
      status: "PENDING",
    });

    mockStreamingService.createStream.mockResolvedValue({
      id: "stream-new",
      businessId: BIZ_A,
      status: "ACTIVE",
    });

    mockCrossChainService.initiateTransfer.mockResolvedValue({
      id: "xfer-new",
      businessId: BIZ_A,
      status: "INITIATED",
    });

    mockFXService.createHedge.mockResolvedValue({
      id: "fx-new",
      businessId: BIZ_A,
    });

    mockInvoiceService.createInvoice.mockResolvedValue({
      id: "inv-new",
      businessId: BIZ_A,
    });

    mockLiquidityService.addLiquidity.mockResolvedValue({
      id: "lp-new",
      businessId: BIZ_A,
    });

    mockAuditService.listAuditEntries.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 20, total: 0 },
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. TENANT ISOLATION: Business A cannot read Business B's data
  // ─────────────────────────────────────────────────────────────────────────

  describe("Cross-tenant data isolation", () => {
    it("Business A cannot read Business B's payments via list", async () => {
      const tokenA = tokenFor(BIZ_A, "ADMIN");
      const tokenB = tokenFor(BIZ_B, "ADMIN");

      // Business A sees its own data
      const resA = await request(app)
        .get("/v1/payments")
        .set("Authorization", `Bearer ${tokenA}`);

      expect(resA.status).toBe(200);
      expect(resA.body.data).toHaveLength(1);
      expect(resA.body.data[0].id).toBe(PAYMENT_A);

      // Business B sees empty (no cross-tenant leak)
      const resB = await request(app)
        .get("/v1/payments")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(resB.status).toBe(200);
      expect(resB.body.data).toHaveLength(0);

      // Verify the service was called with the correct businessId scoping
      expect(mockPaymentService.listPayments).toHaveBeenCalledWith(
        expect.anything(),
        BIZ_A,
      );
      expect(mockPaymentService.listPayments).toHaveBeenCalledWith(
        expect.anything(),
        BIZ_B,
      );
    });

    it("Business B cannot read Business A's payment by ID", async () => {
      const tokenB = tokenFor(BIZ_B, "ADMIN");

      const res = await request(app)
        .get(`/v1/payments/${PAYMENT_A}`)
        .set("Authorization", `Bearer ${tokenB}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("PAYMENT_NOT_FOUND");
      expect(mockPaymentService.getPayment).toHaveBeenCalledWith(
        PAYMENT_A,
        BIZ_B,
      );
    });

    it("Business A cannot read Business B's invoices", async () => {
      const tokenB = tokenFor(BIZ_B, "ADMIN");

      const resB = await request(app)
        .get("/v1/invoices")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(resB.status).toBe(200);
      expect(resB.body.data).toHaveLength(0);

      expect(mockInvoiceService.listInvoices).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BIZ_B }),
      );
    });

    it("Business A cannot read Business B's streaming payments", async () => {
      const tokenB = tokenFor(BIZ_B, "ADMIN");

      const resB = await request(app)
        .get("/v1/streams")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(resB.status).toBe(200);
      expect(resB.body.data).toHaveLength(0);

      expect(mockStreamingService.listStreams).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BIZ_B }),
      );
    });

    it("Business A cannot read Business B's cross-chain transfers", async () => {
      const tokenB = tokenFor(BIZ_B, "ADMIN");

      const resB = await request(app)
        .get("/v1/crosschain/transfers")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(resB.status).toBe(200);
      expect(resB.body.data).toHaveLength(0);

      expect(mockCrossChainService.listTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BIZ_B }),
      );
    });

    it("Business B cannot read Business A's cross-chain transfer by ID", async () => {
      const tokenB = tokenFor(BIZ_B, "ADMIN");

      const resB = await request(app)
        .get("/v1/crosschain/transfers/xfer-a-1")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(resB.status).toBe(403);
      expect(resB.body.error).toBe("FORBIDDEN");
    });

    it("Business A cannot read Business B's FX transactions", async () => {
      const tokenB = tokenFor(BIZ_B, "ADMIN");

      const resB = await request(app)
        .get("/v1/fx/hedges")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(resB.status).toBe(200);
      expect(resB.body.data).toHaveLength(0);

      expect(mockFXService.listPositions).toHaveBeenCalledWith(BIZ_B, {
        page: 1,
        limit: 50,
      });
    });

    it("Business A cannot read Business B's liquidity positions", async () => {
      const tokenB = tokenFor(BIZ_B, "ADMIN");

      const resB = await request(app)
        .get("/v1/liquidity/positions")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(resB.status).toBe(200);
      expect(resB.body.data).toHaveLength(0);

      expect(mockLiquidityService.getPositions).toHaveBeenCalledWith(
        BIZ_B,
        undefined,
        { page: 1, limit: 50 },
      );
    });

    it("Business B cannot access Business A's FX exposure", async () => {
      const tokenB = tokenFor(BIZ_B, "ADMIN");

      const resB = await request(app)
        .get("/v1/fx/exposure")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(resB.status).toBe(200);
      expect(resB.body.data.totalNotional).toBe("0");
      expect(mockFXService.getExposure).toHaveBeenCalledWith(BIZ_B);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. VIEWER role denied access to admin/mutation routes
  // ─────────────────────────────────────────────────────────────────────────

  describe("VIEWER role denied access to admin routes", () => {
    const viewerToken = () => tokenFor(BIZ_A, "VIEWER");

    it("VIEWER denied POST /v1/businesses/:id/verify (ADMIN only)", async () => {
      const res = await request(app)
        .post(`/v1/businesses/${BIZ_A}/verify`)
        .set("Authorization", `Bearer ${viewerToken()}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("denies the supported business suspension mutation to VIEWER", async () => {
      const res = await request(app)
        .post(`/v1/businesses/${BIZ_A}/suspend`)
        .set("Authorization", `Bearer ${viewerToken()}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("VIEWER denied POST /v1/businesses/:id/upgrade (ADMIN only)", async () => {
      const res = await request(app)
        .post(`/v1/businesses/${BIZ_A}/upgrade`)
        .set("Authorization", `Bearer ${viewerToken()}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("VIEWER denied GET /v1/businesses (ADMIN list all)", async () => {
      const res = await request(app)
        .get("/v1/businesses")
        .set("Authorization", `Bearer ${viewerToken()}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("VIEWER denied POST /v1/compliance/sanctions/update (ADMIN only)", async () => {
      const res = await request(app)
        .post("/v1/compliance/sanctions/update")
        .set("Authorization", `Bearer ${viewerToken()}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("VIEWER denied POST /v1/treasury/proposals (mutation)", async () => {
      const res = await request(app)
        .post("/v1/treasury/proposals")
        .set("Authorization", `Bearer ${viewerToken()}`)
        .send({ title: "Nope", description: "No", type: "TRANSFER" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("VIEWER denied PATCH /v1/businesses/:id (businesses:manage)", async () => {
      const res = await request(app)
        .patch(`/v1/businesses/${BIZ_A}`)
        .set("Authorization", `Bearer ${viewerToken()}`)
        .send({ businessName: "Hacked" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("VIEWER denied POST /v1/compliance/flagged/:id/review (compliance:override)", async () => {
      const res = await request(app)
        .post("/v1/compliance/flagged/some-id/review")
        .set("Authorization", `Bearer ${viewerToken()}`)
        .send({
          decision: "approve",
          reason: "test",
          reviewerAddress: "0x1234567890123456789012345678901234567890",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("VIEWER denied POST /v1/audit/export (audit:export)", async () => {
      const res = await request(app)
        .post("/v1/audit/export")
        .set("Authorization", `Bearer ${viewerToken()}`)
        .send({
          format: "json",
          from: "2026-01-01T00:00:00Z",
          to: "2026-03-01T00:00:00Z",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. ANALYST role denied access to mutation routes
  // ─────────────────────────────────────────────────────────────────────────

  describe("ANALYST role denied access to mutation routes", () => {
    const analystToken = () => tokenFor(BIZ_A, "ANALYST");

    it("ANALYST denied POST /v1/payments (payments:create)", async () => {
      const res = await request(app)
        .post("/v1/payments")
        .set("Authorization", `Bearer ${analystToken()}`)
        .send({
          sender: "0x1234567890123456789012345678901234567890",
          recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          amount: "100.00",
          currency: "USDC",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("ANALYST denied POST /v1/payments/:id/cancel (payments:cancel)", async () => {
      const res = await request(app)
        .post("/v1/payments/pay-a-1/cancel")
        .set("Authorization", `Bearer ${analystToken()}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("ANALYST denied POST /v1/payments/:id/refund (payments:refund)", async () => {
      const res = await request(app)
        .post("/v1/payments/pay-a-1/refund")
        .set("Authorization", `Bearer ${analystToken()}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("ANALYST denied POST /v1/payments/batch (payments:create)", async () => {
      const res = await request(app)
        .post("/v1/payments/batch")
        .set("Authorization", `Bearer ${analystToken()}`)
        .send({
          payments: [
            {
              sender: "0x1234567890123456789012345678901234567890",
              recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
              amount: "50.00",
              currency: "USDC",
            },
          ],
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("ANALYST denied POST /v1/streams (streams:create)", async () => {
      const res = await request(app)
        .post("/v1/streams")
        .set("Authorization", `Bearer ${analystToken()}`)
        .send({ recipient: "0x1234", token: "USDC", ratePerSecond: "0.001" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("ANALYST denied POST /v1/crosschain/transfers (crosschain:initiate)", async () => {
      const res = await request(app)
        .post("/v1/crosschain/transfers")
        .set("Authorization", `Bearer ${analystToken()}`)
        .send({
          source: "ethereum",
          destination: "noble",
          token: "USDC",
          amount: "1000",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("ANALYST denied POST /v1/fx/hedges (fx:trade)", async () => {
      const res = await request(app)
        .post("/v1/fx/hedges")
        .set("Authorization", `Bearer ${analystToken()}`)
        .send({ pair: "USDC/EUR", notionalAmount: "10000", direction: "BUY" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("ANALYST denied POST /v1/invoices (invoices:create)", async () => {
      const res = await request(app)
        .post("/v1/invoices")
        .set("Authorization", `Bearer ${analystToken()}`)
        .send({ amount: "5000", currency: "USDC", debtor: "biz-debtor" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("ANALYST denied POST /v1/liquidity/pools/:id/add (liquidity:manage)", async () => {
      const res = await request(app)
        .post("/v1/liquidity/pools/pool-1/add")
        .set("Authorization", `Bearer ${analystToken()}`)
        .send({ amount: "10000", token: "USDC" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("ANALYST denied POST /v1/treasury/proposals (requireRole ADMIN/TREASURY_MANAGER)", async () => {
      const res = await request(app)
        .post("/v1/treasury/proposals")
        .set("Authorization", `Bearer ${analystToken()}`)
        .send({ title: "Nope", description: "No access", type: "TRANSFER" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("ANALYST allowed GET /v1/payments (payments:read)", async () => {
      const res = await request(app)
        .get("/v1/payments")
        .set("Authorization", `Bearer ${analystToken()}`);

      expect(res.status).toBe(200);
    });

    it("ANALYST allowed GET /v1/invoices (invoices:read)", async () => {
      const res = await request(app)
        .get("/v1/invoices")
        .set("Authorization", `Bearer ${analystToken()}`);

      expect(res.status).toBe(200);
    });

    it("ANALYST allowed GET /v1/streams (streams:read)", async () => {
      const res = await request(app)
        .get("/v1/streams")
        .set("Authorization", `Bearer ${analystToken()}`);

      expect(res.status).toBe(200);
    });

    it("ANALYST allowed GET /v1/crosschain/transfers (crosschain:read)", async () => {
      const res = await request(app)
        .get("/v1/crosschain/transfers")
        .set("Authorization", `Bearer ${analystToken()}`);

      expect(res.status).toBe(200);
    });

    it("ANALYST allowed GET /v1/fx/hedges (fx:read)", async () => {
      const res = await request(app)
        .get("/v1/fx/hedges")
        .set("Authorization", `Bearer ${analystToken()}`);

      expect(res.status).toBe(200);
    });

    it("ANALYST allowed GET /v1/liquidity/positions (liquidity:read)", async () => {
      const res = await request(app)
        .get("/v1/liquidity/positions")
        .set("Authorization", `Bearer ${analystToken()}`);

      expect(res.status).toBe(200);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Unauthenticated requests rejected
  // ─────────────────────────────────────────────────────────────────────────

  describe("Unauthenticated requests", () => {
    const routes = [
      { method: "get" as const, path: "/v1/payments" },
      { method: "get" as const, path: "/v1/invoices" },
      { method: "get" as const, path: "/v1/streams" },
      { method: "get" as const, path: "/v1/crosschain/transfers" },
      { method: "get" as const, path: "/v1/fx/hedges" },
      { method: "get" as const, path: "/v1/liquidity/positions" },
      { method: "post" as const, path: "/v1/payments" },
      { method: "post" as const, path: "/v1/streams" },
      { method: "post" as const, path: "/v1/crosschain/transfers" },
    ];

    for (const { method, path } of routes) {
      it(`should return 401 for unauthenticated ${method.toUpperCase()} ${path}`, async () => {
        const res = await request(app)[method](path);
        expect(res.status).toBe(401);
        expect(res.body.error).toBe("UNAUTHORIZED");
      });
    }
  });
});
