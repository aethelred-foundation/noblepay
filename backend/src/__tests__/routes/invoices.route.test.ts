import {
  createMockPrisma,
  resetAllMocks,
} from "../setup";

const mockPrisma = createMockPrisma();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

const mockInvoiceService = {
  createInvoice: jest.fn(),
  listInvoices: jest.fn(),
  getInvoice: jest.fn(),
  requestFinancing: jest.fn(),
  settleInvoice: jest.fn(),
  raiseDispute: jest.fn(),
  getCreditScore: jest.fn(),
  getAnalytics: jest.fn(),
};

const mockAuditService = { createAuditEntry: jest.fn() };

jest.mock("../../services/invoice", () => ({
  InvoiceService: jest.fn(() => mockInvoiceService),
  InvoiceError: class InvoiceError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.name = "InvoiceError";
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
  requireOwnership: jest.fn(() => true),
}));

import express from "express";
import request from "supertest";
import invoicesRouter from "../../routes/invoices";
import { InvoiceError } from "../../services/invoice";

const app = express();
app.use(express.json());
app.use("/v1/invoices", invoicesRouter);

beforeEach(() => {
  resetAllMocks();
});

describe("Invoices Routes", () => {
  describe("POST /v1/invoices", () => {
    it("should create an invoice", async () => {
      mockInvoiceService.createInvoice.mockResolvedValue({
        id: "inv-1",
        amount: "10000",
        status: "PENDING",
      });

      const res = await request(app)
        .post("/v1/invoices")
        .send({ debtor: "0xdebtor", amount: "10000", dueDate: "2024-06-01" });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("inv-1");
    });

    it("should handle InvoiceError", async () => {
      mockInvoiceService.createInvoice.mockRejectedValue(
        new InvoiceError("INVALID_AMOUNT", "Amount too low", 400),
      );

      const res = await request(app).post("/v1/invoices").send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INVALID_AMOUNT");
    });

    it("should return 500 on unexpected error", async () => {
      mockInvoiceService.createInvoice.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/invoices").send({});

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/invoices", () => {
    it("should list invoices", async () => {
      mockInvoiceService.listInvoices.mockReturnValue([
        { id: "inv-1", status: "PENDING" },
      ]);

      const res = await request(app).get("/v1/invoices");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should return 500 on error", async () => {
      mockInvoiceService.listInvoices.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/invoices");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/invoices/:id/finance", () => {
    it("should request financing for an invoice", async () => {
      mockInvoiceService.requestFinancing.mockResolvedValue({
        invoiceId: "inv-1",
        financingAmount: "8000",
        fee: "200",
      });

      const res = await request(app)
        .post("/v1/invoices/inv-1/finance")
        .send({ amount: "8000" });

      expect(res.status).toBe(201);
      expect(res.body.data.financingAmount).toBe("8000");
    });

    it("should return 500 on error", async () => {
      mockInvoiceService.requestFinancing.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/invoices/inv-1/finance").send({ amount: "8000" });

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/invoices/:id/settle", () => {
    it("should settle an invoice", async () => {
      mockInvoiceService.settleInvoice.mockResolvedValue({
        id: "inv-1",
        status: "SETTLED",
      });

      const res = await request(app).post("/v1/invoices/inv-1/settle");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("SETTLED");
    });

    it("should return 500 on error", async () => {
      mockInvoiceService.settleInvoice.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/invoices/inv-1/settle");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/invoices/:id/dispute", () => {
    it("should raise a dispute", async () => {
      mockInvoiceService.raiseDispute.mockResolvedValue({
        invoiceId: "inv-1",
        disputeId: "disp-1",
        status: "DISPUTED",
      });

      const res = await request(app)
        .post("/v1/invoices/inv-1/dispute")
        .send({ reason: "Goods not delivered" });

      expect(res.status).toBe(200);
      expect(res.body.data.disputeId).toBe("disp-1");
    });

    it("should return 500 on error", async () => {
      mockInvoiceService.raiseDispute.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/invoices/inv-1/dispute").send({ reason: "bad" });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/invoices/credit-score/:businessId", () => {
    it("should return credit score", async () => {
      mockInvoiceService.getCreditScore.mockReturnValue({
        businessId: "biz-1",
        score: 750,
        rating: "A",
      });

      const res = await request(app).get("/v1/invoices/credit-score/biz-1");

      expect(res.status).toBe(200);
      expect(res.body.data.score).toBe(750);
    });

    it("should return 500 on error", async () => {
      mockInvoiceService.getCreditScore.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/invoices/credit-score/biz-1");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/invoices/analytics", () => {
    it("should return invoice analytics", async () => {
      mockInvoiceService.getAnalytics.mockReturnValue({
        totalInvoices: 50,
        totalFinanced: "200000",
      });

      const res = await request(app).get("/v1/invoices/analytics");

      expect(res.status).toBe(200);
      expect(res.body.data.totalInvoices).toBe(50);
    });

    it("should return 500 on error", async () => {
      mockInvoiceService.getAnalytics.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/invoices/analytics");

      expect(res.status).toBe(500);
    });
  });
});
