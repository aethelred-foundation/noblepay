import { createMockPrisma, resetAllMocks } from "../setup";
import { ReportingService, ReportingError } from "../../services/reporting";
import { AuditService } from "../../services/audit";

let prisma: ReturnType<typeof createMockPrisma>;
let auditService: AuditService;
let reportingService: ReportingService;

beforeEach(() => {
  resetAllMocks();
  prisma = createMockPrisma();
  auditService = new AuditService(prisma);
  jest.spyOn(auditService, "createAuditEntry").mockResolvedValue({} as any);
  reportingService = new ReportingService(prisma, auditService);
});

describe("ReportingService", () => {
  // ─── getTemplates ──────────────────────────────────────────────────────────

  describe("getTemplates", () => {
    it("should return all templates", () => {
      const templates = reportingService.getTemplates();
      expect(templates.length).toBeGreaterThan(0);
      expect(templates[0]).toHaveProperty("id");
      expect(templates[0]).toHaveProperty("type");
    });

    it("should filter by jurisdiction", () => {
      const uae = reportingService.getTemplates("UAE");
      expect(uae.every((t) => t.jurisdiction === "UAE" || t.jurisdiction === "INTERNATIONAL")).toBe(true);
    });

    it("should include INTERNATIONAL templates for any jurisdiction", () => {
      const uae = reportingService.getTemplates("UAE");
      const international = uae.filter((t) => t.jurisdiction === "INTERNATIONAL");
      expect(international.length).toBeGreaterThan(0);
    });
  });

  // ─── generateReport ───────────────────────────────────────────────────────

  describe("generateReport", () => {
    it("should generate a report from template", async () => {
      const report = await reportingService.generateReport(
        {
          templateId: "tpl-sar",
          dateFrom: "2024-01-01",
          dateTo: "2024-03-31",
        },
        "0xgenerator",
        "biz-1",
      );

      expect(report.id).toMatch(/^rpt-/);
      expect(report.type).toBe("SAR");
      expect(report.status).toBe("READY");
      expect(report.generatedBy).toBe("0xgenerator");
      expect(report.data).toBeDefined();
      expect(report.summary).toBeDefined();
      expect(report.summary.totalTransactions).toBeGreaterThan(0);
    });

    it("should generate different data for different template types", async () => {
      const sar = await reportingService.generateReport(
        { templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );
      const ctr = await reportingService.generateReport(
        { templateId: "tpl-ctr", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );

      expect(sar.data).toHaveProperty("suspiciousActivities");
      expect(ctr.data).toHaveProperty("currencyTransactions");
    });

    it("should throw TEMPLATE_NOT_FOUND for unknown template", async () => {
      await expect(
        reportingService.generateReport(
          { templateId: "nonexistent", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
          "0xgen",
          "biz-1",
        ),
      ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND", statusCode: 404 });
    });

    it("should generate default report data for STR template (default switch case)", async () => {
      const report = await reportingService.generateReport(
        { templateId: "tpl-str", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );

      expect(report.type).toBe("STR");
      expect(report.data).toHaveProperty("reportingEntity");
      // STR hits the default case, so no extra properties like suspiciousActivities
      expect(report.data).not.toHaveProperty("suspiciousActivities");
    });

    it("should generate report with each template type covering all switch cases", async () => {
      const templates = ["tpl-fatf", "tpl-sanctions", "tpl-aml", "tpl-risk"];
      for (const tplId of templates) {
        const report = await reportingService.generateReport(
          { templateId: tplId, dateFrom: "2024-01-01", dateTo: "2024-03-31" },
          "0xgen",
          "biz-1",
        );
        expect(report.data).toHaveProperty("reportingEntity");
      }
    });

    it("should include notes in report", async () => {
      const report = await reportingService.generateReport(
        {
          templateId: "tpl-sar",
          dateFrom: "2024-01-01",
          dateTo: "2024-03-31",
          notes: "Quarterly review",
        },
        "0xgen",
        "biz-1",
      );

      expect(report.notes).toBe("Quarterly review");
    });
  });

  // ─── submitReport ──────────────────────────────────────────────────────────

  describe("submitReport", () => {
    it("should submit a READY report", async () => {
      const report = await reportingService.generateReport(
        { templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );

      const submitted = await reportingService.submitReport(
        report.id,
        "0xsubmitter",
      );

      expect(submitted.status).toBe("SUBMITTED");
      expect(submitted.submittedAt).toBeInstanceOf(Date);
    });

    it("should throw REPORT_NOT_FOUND for unknown report", async () => {
      await expect(
        reportingService.submitReport("nonexistent", "0xactor"),
      ).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
    });

    it("should throw INVALID_STATE for already submitted report", async () => {
      const report = await reportingService.generateReport(
        { templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );
      await reportingService.submitReport(report.id, "0xsubmitter");

      await expect(
        reportingService.submitReport(report.id, "0xsubmitter"),
      ).rejects.toMatchObject({ code: "INVALID_STATE", statusCode: 409 });
    });
  });

  // ─── listReports ───────────────────────────────────────────────────────────

  describe("listReports", () => {
    it("should return all reports", async () => {
      await reportingService.generateReport(
        { templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );

      const reports = reportingService.listReports();
      expect(reports).toHaveLength(1);
    });

    it("should filter by type", async () => {
      await reportingService.generateReport(
        { templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );
      await reportingService.generateReport(
        { templateId: "tpl-ctr", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );

      const sarOnly = reportingService.listReports({ type: "SAR" });
      expect(sarOnly).toHaveLength(1);
      expect(sarOnly[0].type).toBe("SAR");
    });

    it("should filter by status", async () => {
      const report = await reportingService.generateReport(
        { templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );
      await reportingService.submitReport(report.id, "0xsubmitter");

      const submitted = reportingService.listReports({ status: "SUBMITTED" });
      expect(submitted).toHaveLength(1);
    });

    it("should filter by jurisdiction with matches", async () => {
      await reportingService.generateReport(
        { templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );

      const uaeReports = reportingService.listReports({ jurisdiction: "UAE" });
      expect(uaeReports).toHaveLength(1);
      expect(uaeReports[0].jurisdiction).toBe("UAE");

      const noMatch = reportingService.listReports({ jurisdiction: "NONEXISTENT" });
      expect(noMatch).toHaveLength(0);
    });

    it("should sort multiple reports by generatedAt descending", async () => {
      await reportingService.generateReport(
        { templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );
      await reportingService.generateReport(
        { templateId: "tpl-ctr", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );

      const reports = reportingService.listReports();
      expect(reports).toHaveLength(2);
      expect(reports[0].generatedAt.getTime()).toBeGreaterThanOrEqual(
        reports[1].generatedAt.getTime(),
      );
    });
  });

  // ─── getReport ─────────────────────────────────────────────────────────────

  describe("getReport", () => {
    it("should return report by ID", async () => {
      const created = await reportingService.generateReport(
        { templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );

      const report = reportingService.getReport(created.id);
      expect(report.id).toBe(created.id);
    });

    it("should throw REPORT_NOT_FOUND", () => {
      expect(() => reportingService.getReport("nonexistent")).toThrow(
        ReportingError,
      );
    });
  });

  // ─── getDeadlines ──────────────────────────────────────────────────────────

  describe("getDeadlines", () => {
    it("should return deadlines sorted by date", () => {
      const deadlines = reportingService.getDeadlines();
      expect(deadlines.length).toBeGreaterThan(0);
      for (let i = 1; i < deadlines.length; i++) {
        expect(deadlines[i - 1].deadline.getTime()).toBeLessThanOrEqual(
          deadlines[i].deadline.getTime(),
        );
      }
    });
  });

  // ─── getAnalytics ──────────────────────────────────────────────────────────

  describe("getAnalytics", () => {
    it("should return analytics with no reports", () => {
      const analytics = reportingService.getAnalytics();
      expect(analytics.totalReports).toBe(0);
      expect(analytics.submissionRate).toBe(1); // default
      expect(analytics.complianceScore).toBe(94.5);
    });

    it("should calculate analytics with reports", async () => {
      await reportingService.generateReport(
        { templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );

      const analytics = reportingService.getAnalytics();
      expect(analytics.totalReports).toBe(1);
      expect(analytics.reportsByType).toHaveProperty("SAR");
    });

    it("should calculate submission rate with submitted reports", async () => {
      const report = await reportingService.generateReport(
        { templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2024-03-31" },
        "0xgen",
        "biz-1",
      );
      await reportingService.submitReport(report.id, "0xsubmitter");

      const analytics = reportingService.getAnalytics();
      expect(analytics.totalReports).toBe(1);
      expect(analytics.submissionRate).toBe(1); // 1 submitted out of 1
      expect(analytics.reportsByStatus).toHaveProperty("SUBMITTED");
    });
  });

  // ─── ReportingError ────────────────────────────────────────────────────────

  describe("ReportingError", () => {
    it("should set properties correctly", () => {
      const err = new ReportingError("CODE", "msg", 404);
      expect(err.code).toBe("CODE");
      expect(err.statusCode).toBe(404);
      expect(err.name).toBe("ReportingError");
    });

    it("should default statusCode to 400", () => {
      const err = new ReportingError("CODE", "msg");
      expect(err.statusCode).toBe(400);
    });
  });
});
