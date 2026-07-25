const mockReportingService = {
  getTemplates: jest.fn(),
  generateReport: jest.fn(),
  listReports: jest.fn(),
  getAnalytics: jest.fn(),
  getReport: jest.fn(),
  submitReport: jest.fn(),
};

jest.mock("../../lib/db", () => ({ prisma: {} }));
jest.mock("../../services/audit", () => ({ AuditService: jest.fn() }));
jest.mock("../../services/reporting", () => {
  class ReportingError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  }
  return {
    ReportingService: jest.fn(() => mockReportingService),
    ReportingError,
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
}));

import express from "express";
import request from "supertest";
import router from "../../routes/reporting";
import { ReportingError } from "../../services/reporting";

const app = express();
app.use(express.json());
app.use("/v1/reporting", router);

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR = "0x1111111111111111111111111111111111111111";
const REPORT_ID = "rpt-11111111-1111-4111-8111-111111111111";

describe("reporting routes", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns jurisdiction-filtered templates after authentication", async () => {
    mockReportingService.getTemplates.mockReturnValue([{ id: "tpl-sar" }]);
    const response = await request(app).get(
      "/v1/reporting/templates?jurisdiction=UAE",
    );
    expect(response.status).toBe(200);
    expect(mockReportingService.getTemplates).toHaveBeenCalledWith("UAE");
  });

  it("rejects unbounded template queries before service invocation", async () => {
    const response = await request(app).get(
      `/v1/reporting/templates?jurisdiction=${"x".repeat(101)}`,
    );
    expect(response.status).toBe(400);
    expect(mockReportingService.getTemplates).not.toHaveBeenCalled();
  });

  it("generates a validated report in the authenticated tenant", async () => {
    const body = {
      templateId: "tpl-sar",
      dateFrom: "2026-01-01",
      dateTo: "2026-03-31",
    };
    mockReportingService.generateReport.mockResolvedValue({
      id: REPORT_ID,
      status: "READY",
    });
    const response = await request(app).post("/v1/reporting").send(body);
    expect(response.status).toBe(201);
    expect(mockReportingService.generateReport).toHaveBeenCalledWith(
      body,
      ACTOR,
      BUSINESS_ID,
    );
  });

  it("rejects malformed generation payloads", async () => {
    const response = await request(app)
      .post("/v1/reporting")
      .send({ templateId: "tpl-sar", dateFrom: "not-a-date" });
    expect(response.status).toBe(400);
    expect(mockReportingService.generateReport).not.toHaveBeenCalled();
  });

  it("lists reports through tenant-scoped filters", async () => {
    mockReportingService.listReports.mockResolvedValue({
      data: [],
      pagination: { page: 2, limit: 10, total: 0, totalPages: 0 },
    });
    const response = await request(app).get(
      "/v1/reporting?type=SAR&status=READY&jurisdiction=UAE&page=2&limit=10",
    );
    expect(response.status).toBe(200);
    expect(mockReportingService.listReports).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      type: "SAR",
      status: "READY",
      jurisdiction: "UAE",
      page: 2,
      limit: 10,
    });
    expect(response.body.pagination).toEqual({
      page: 2,
      limit: 10,
      total: 0,
      totalPages: 0,
    });
  });

  it("rejects report pages above the bounded summary limit", async () => {
    const response = await request(app).get("/v1/reporting?limit=51");
    expect(response.status).toBe(400);
    expect(mockReportingService.listReports).not.toHaveBeenCalled();
  });

  it("does not expose an unimplemented regulator-calendar route", async () => {
    const response = await request(app).get("/v1/reporting/deadlines");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "NOT_FOUND", message: "Not found" });
  });

  it("returns analytics only for the authenticated tenant", async () => {
    mockReportingService.getAnalytics.mockResolvedValue({ totalReports: 2 });
    const response = await request(app).get("/v1/reporting/analytics");
    expect(response.status).toBe(200);
    expect(mockReportingService.getAnalytics).toHaveBeenCalledWith(BUSINESS_ID);
  });

  it("fetches an individual report through tenant scope", async () => {
    mockReportingService.getReport.mockResolvedValue({ id: REPORT_ID });
    const response = await request(app).get(`/v1/reporting/${REPORT_ID}`);
    expect(response.status).toBe(200);
    expect(mockReportingService.getReport).toHaveBeenCalledWith(
      REPORT_ID,
      BUSINESS_ID,
    );
  });

  it("rejects malformed report identifiers before lookup", async () => {
    const response = await request(app).get("/v1/reporting/not-a-report-id");
    expect(response.status).toBe(400);
    expect(mockReportingService.getReport).not.toHaveBeenCalled();
  });

  it("submits a report with the verified actor and tenant", async () => {
    mockReportingService.submitReport.mockResolvedValue({
      id: REPORT_ID,
      status: "SUBMITTED",
    });
    const response = await request(app).post(
      `/v1/reporting/${REPORT_ID}/submit`,
    );
    expect(response.status).toBe(200);
    expect(mockReportingService.submitReport).toHaveBeenCalledWith(
      REPORT_ID,
      ACTOR,
      BUSINESS_ID,
    );
  });

  it("does not expose report submission in production without a gateway", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousUrl = process.env.REGULATORY_REPORTING_URL;
    const previousKey = process.env.REGULATORY_REPORTING_API_KEY;
    process.env.NODE_ENV = "production";
    delete process.env.REGULATORY_REPORTING_URL;
    delete process.env.REGULATORY_REPORTING_API_KEY;
    try {
      const response = await request(app).post(
        `/v1/reporting/${REPORT_ID}/submit`,
      );
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: "NOT_FOUND",
        message: "Not found",
      });
      expect(mockReportingService.submitReport).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousUrl === undefined)
        delete process.env.REGULATORY_REPORTING_URL;
      else process.env.REGULATORY_REPORTING_URL = previousUrl;
      if (previousKey === undefined)
        delete process.env.REGULATORY_REPORTING_API_KEY;
      else process.env.REGULATORY_REPORTING_API_KEY = previousKey;
    }
  });

  it("maps typed and unexpected errors without leaking internals", async () => {
    mockReportingService.getReport
      .mockRejectedValueOnce(
        new ReportingError("REPORT_NOT_FOUND", "not found", 404),
      )
      .mockRejectedValueOnce(new Error("database password leaked"));
    const missing = await request(app).get(`/v1/reporting/${REPORT_ID}`);
    const failure = await request(app).get(`/v1/reporting/${REPORT_ID}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("REPORT_NOT_FOUND");
    expect(failure.status).toBe(500);
    expect(failure.body).toEqual({
      error: "INTERNAL_ERROR",
      message: "An internal error occurred",
    });
    expect(JSON.stringify(failure.body)).not.toContain("password");
  });
});
