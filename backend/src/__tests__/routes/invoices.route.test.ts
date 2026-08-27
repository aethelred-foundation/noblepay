const mockInvoiceService = {
  createInvoice: jest.fn(),
  listInvoices: jest.fn(),
  getInvoice: jest.fn(),
  requestFinancing: jest.fn(),
  listFinancingRequests: jest.fn(),
  settleInvoice: jest.fn(),
  raiseDispute: jest.fn(),
  getCreditScore: jest.fn(),
  getAnalytics: jest.fn(),
};
let ownershipAllowed = true;

jest.mock("../../lib/db", () => ({ prisma: {} }));
jest.mock("../../services/audit", () => ({ AuditService: jest.fn() }));
jest.mock("../../services/invoice", () => {
  class InvoiceError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  }
  return {
    InvoiceService: jest.fn(() => mockInvoiceService),
    InvoiceError,
  };
});
jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: (req: any, _res: unknown, next: () => void) => {
    req.businessId = "11111111-1111-4111-8111-111111111111";
    req.signerId = "0x1111111111111111111111111111111111111111";
    next();
  },
}));
jest.mock("../../middleware/rbac", () => ({
  extractRole: (_req: unknown, _res: unknown, next: () => void) => next(),
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireOwnership: () => ownershipAllowed,
}));

import express from "express";
import request from "supertest";
import router from "../../routes/invoices";
import { InvoiceError } from "../../services/invoice";

const app = express();
app.use(express.json());
app.use("/v1/invoices", router);

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR = "0x1111111111111111111111111111111111111111";
const INVOICE_ID = "inv-11111111-1111-4111-8111-111111111111";
const validInvoice = {
  debtor: "0x2222222222222222222222222222222222222222",
  debtorName: "Acme Buyer",
  amount: "1000.50",
  currency: "USDC",
  maturityDate: "2027-07-21T00:00:00.000Z",
  description: "Verified trade receivable",
};

describe("invoice routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ownershipAllowed = true;
  });

  it("creates a validated tenant invoice", async () => {
    mockInvoiceService.createInvoice.mockResolvedValue({
      id: INVOICE_ID,
      status: "ISSUED",
    });
    const response = await request(app).post("/v1/invoices").send(validInvoice);
    expect(response.status).toBe(201);
    expect(mockInvoiceService.createInvoice).toHaveBeenCalledWith(
      validInvoice,
      ACTOR,
      BUSINESS_ID,
    );
  });

  it("rejects malformed invoice input before the service", async () => {
    const response = await request(app)
      .post("/v1/invoices")
      .send({ ...validInvoice, amount: "-1", unexpected: true });
    expect(response.status).toBe(400);
    expect(mockInvoiceService.createInvoice).not.toHaveBeenCalled();
  });

  it("lists only the authenticated tenant's invoices", async () => {
    mockInvoiceService.listInvoices.mockResolvedValue([]);
    const response = await request(app).get(
      "/v1/invoices?status=ISSUED&currency=USDC",
    );
    expect(response.status).toBe(200);
    expect(mockInvoiceService.listInvoices).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      issuer: undefined,
      debtor: undefined,
      status: "ISSUED",
      currency: "USDC",
    });
  });

  it("requires a bounded idempotency key for financing", async () => {
    const response = await request(app)
      .post(`/v1/invoices/${INVOICE_ID}/finance`)
      .send({ amount: "500" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(mockInvoiceService.requestFinancing).not.toHaveBeenCalled();
  });

  it("passes tenant, actor and idempotency evidence to financing", async () => {
    mockInvoiceService.requestFinancing.mockResolvedValue({
      id: "finance-1",
      status: "PENDING",
    });
    const response = await request(app)
      .post(`/v1/invoices/${INVOICE_ID}/finance`)
      .set("Idempotency-Key", "finance-request-001")
      .send({ amount: "500" });
    expect(response.status).toBe(201);
    expect(mockInvoiceService.requestFinancing).toHaveBeenCalledWith(
      INVOICE_ID,
      "500",
      ACTOR,
      BUSINESS_ID,
      "finance-request-001",
    );
  });

  it("lists financing receipts through the tenant scope", async () => {
    mockInvoiceService.listFinancingRequests.mockResolvedValue([]);
    const response = await request(app).get(
      `/v1/invoices/${INVOICE_ID}/financing`,
    );
    expect(response.status).toBe(200);
    expect(mockInvoiceService.listFinancingRequests).toHaveBeenCalledWith(
      INVOICE_ID,
      BUSINESS_ID,
    );
  });

  it("settles only against an explicit external reference", async () => {
    mockInvoiceService.settleInvoice.mockResolvedValue({
      id: INVOICE_ID,
      status: "SETTLED",
    });
    const response = await request(app)
      .post(`/v1/invoices/${INVOICE_ID}/settle`)
      .send({ settlementReference: "settlement-provider-123" });
    expect(response.status).toBe(200);
    expect(mockInvoiceService.settleInvoice).toHaveBeenCalledWith(
      INVOICE_ID,
      ACTOR,
      BUSINESS_ID,
      "settlement-provider-123",
    );
  });

  it("raises a bounded dispute in the tenant context", async () => {
    mockInvoiceService.raiseDispute.mockResolvedValue({
      id: "dispute-1",
      status: "OPEN",
    });
    const response = await request(app)
      .post(`/v1/invoices/${INVOICE_ID}/dispute`)
      .send({ reason: "The delivered goods do not match the invoice" });
    expect(response.status).toBe(201);
    expect(mockInvoiceService.raiseDispute).toHaveBeenCalledWith(
      INVOICE_ID,
      "The delivered goods do not match the invoice",
      ACTOR,
      BUSINESS_ID,
    );
  });

  it("conceals another tenant's credit score", async () => {
    ownershipAllowed = false;
    const response = await request(app).get(
      "/v1/invoices/credit-score/22222222-2222-4222-8222-222222222222",
    );
    expect(response.status).toBe(403);
    expect(mockInvoiceService.getCreditScore).not.toHaveBeenCalled();
  });

  it("returns tenant analytics and individual invoices", async () => {
    mockInvoiceService.getAnalytics.mockResolvedValue({
      totalReceivables: "10.00",
    });
    mockInvoiceService.getInvoice.mockResolvedValue({ id: INVOICE_ID });
    const analytics = await request(app).get("/v1/invoices/analytics");
    const invoice = await request(app).get(`/v1/invoices/${INVOICE_ID}`);
    expect(analytics.status).toBe(200);
    expect(invoice.status).toBe(200);
    expect(mockInvoiceService.getAnalytics).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mockInvoiceService.getInvoice).toHaveBeenCalledWith(
      INVOICE_ID,
      BUSINESS_ID,
    );
  });

  it("preserves fail-closed gateway errors", async () => {
    mockInvoiceService.requestFinancing.mockRejectedValue(
      new InvoiceError(
        "INVOICE_FINANCING_NOT_CONFIGURED",
        "verified gateway required",
        501,
      ),
    );
    const response = await request(app)
      .post(`/v1/invoices/${INVOICE_ID}/finance`)
      .set("Idempotency-Key", "finance-request-002")
      .send({ amount: "500" });
    expect(response.status).toBe(501);
    expect(response.body.error).toBe("INVOICE_FINANCING_NOT_CONFIGURED");
  });
});
