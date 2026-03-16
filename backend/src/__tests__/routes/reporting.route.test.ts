import {
  createMockPrisma,
  resetAllMocks,
} from "../setup";

const mockPrisma = createMockPrisma();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

const mockReportingService = {
  getTemplates: jest.fn(),
  generateReport: jest.fn(),
  listReports: jest.fn(),
  getDeadlines: jest.fn(),
  getAnalytics: jest.fn(),
  getReport: jest.fn(),
  submitReport: jest.fn(),
};

const mockAuditService = { createAuditEntry: jest.fn() };

jest.mock("../../services/reporting", () => ({
  ReportingService: jest.fn(() => mockReportingService),
  ReportingError: class ReportingError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
      this.name = "ReportingError";
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
  requirePermission: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

import express from "express";
import request from "supertest";
import reportingRouter from "../../routes/reporting";
import { ReportingError } from "../../services/reporting";

const app = express();
app.use(express.json());
app.use("/v1/reporting", reportingRouter);

beforeEach(() => {
  resetAllMocks();
});

describe("Reporting Routes", () => {
  describe("GET /v1/reporting/templates", () => {
    it("should return all templates", async () => {
      mockReportingService.getTemplates.mockReturnValue([
        { id: "tpl-sar", type: "SAR", jurisdiction: "UAE" },
      ]);

      const res = await request(app).get("/v1/reporting/templates");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should filter by jurisdiction", async () => {
      mockReportingService.getTemplates.mockReturnValue([]);

      await request(app).get("/v1/reporting/templates?jurisdiction=UAE");

      expect(mockReportingService.getTemplates).toHaveBeenCalledWith("UAE");
    });

    it("should handle ReportingError", async () => {
      mockReportingService.getTemplates.mockImplementation(() => {
        throw new ReportingError("TEMPLATE_ERROR", "Error", 400);
      });

      const res = await request(app).get("/v1/reporting/templates");

      expect(res.status).toBe(400);
    });

    it("should return 500 on unexpected error", async () => {
      mockReportingService.getTemplates.mockImplementation(() => {
        throw new Error("crash");
      });

      const res = await request(app).get("/v1/reporting/templates");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/reporting", () => {
    it("should generate a report", async () => {
      mockReportingService.generateReport.mockResolvedValue({
        id: "rpt-1",
        type: "SAR",
        status: "READY",
      });

      const res = await request(app)
        .post("/v1/reporting")
        .send({ templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2024-03-31" });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBe("rpt-1");
    });

    it("should return 500 on error", async () => {
      mockReportingService.generateReport.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/reporting").send({});

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/reporting", () => {
    it("should list reports", async () => {
      mockReportingService.listReports.mockReturnValue([
        { id: "rpt-1", type: "SAR", status: "READY" },
      ]);

      const res = await request(app).get("/v1/reporting");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should return 500 on error", async () => {
      mockReportingService.listReports.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/reporting");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/reporting/deadlines", () => {
    it("should return regulatory deadlines", async () => {
      mockReportingService.getDeadlines.mockReturnValue([
        { type: "SAR", deadline: new Date("2024-04-30"), jurisdiction: "UAE" },
      ]);

      const res = await request(app).get("/v1/reporting/deadlines");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("should return 500 on error", async () => {
      mockReportingService.getDeadlines.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/reporting/deadlines");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/reporting/analytics", () => {
    it("should return reporting analytics", async () => {
      mockReportingService.getAnalytics.mockReturnValue({
        totalReports: 25,
        complianceScore: 94.5,
      });

      const res = await request(app).get("/v1/reporting/analytics");

      expect(res.status).toBe(200);
      expect(res.body.data.totalReports).toBe(25);
    });

    it("should return 500 on error", async () => {
      mockReportingService.getAnalytics.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/reporting/analytics");

      expect(res.status).toBe(500);
    });
  });

  describe("GET /v1/reporting/:id", () => {
    it("should return a report by ID", async () => {
      mockReportingService.getReport.mockReturnValue({
        id: "rpt-1",
        type: "SAR",
        status: "READY",
      });

      const res = await request(app).get("/v1/reporting/rpt-1");

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("rpt-1");
    });

    it("should handle report not found", async () => {
      mockReportingService.getReport.mockImplementation(() => {
        throw new ReportingError("REPORT_NOT_FOUND", "Report not found", 404);
      });

      const res = await request(app).get("/v1/reporting/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("REPORT_NOT_FOUND");
    });

    it("should return 500 on unexpected error", async () => {
      mockReportingService.getReport.mockImplementation(() => { throw new Error("crash"); });

      const res = await request(app).get("/v1/reporting/rpt-1");

      expect(res.status).toBe(500);
    });
  });

  describe("POST /v1/reporting/:id/submit", () => {
    it("should submit a report", async () => {
      mockReportingService.submitReport.mockResolvedValue({
        id: "rpt-1",
        status: "SUBMITTED",
        submittedAt: new Date().toISOString(),
      });

      const res = await request(app).post("/v1/reporting/rpt-1/submit");

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("SUBMITTED");
    });

    it("should handle already-submitted error", async () => {
      mockReportingService.submitReport.mockRejectedValue(
        new ReportingError("INVALID_STATE", "Already submitted", 409),
      );

      const res = await request(app).post("/v1/reporting/rpt-1/submit");

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("INVALID_STATE");
    });

    it("should return 500 on unexpected error", async () => {
      mockReportingService.submitReport.mockRejectedValue(new Error("crash"));

      const res = await request(app).post("/v1/reporting/rpt-1/submit");

      expect(res.status).toBe(500);
    });
  });
});
