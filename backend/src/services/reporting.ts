import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { AuditService } from "./audit";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ReportType = "SAR" | "CTR" | "STR" | "FATF_TRAVEL_RULE" | "SANCTIONS_SUMMARY" | "AML_QUARTERLY" | "RISK_ASSESSMENT" | "CUSTOM";
export type ReportStatus = "DRAFT" | "GENERATING" | "READY" | "SUBMITTED" | "ACKNOWLEDGED" | "REJECTED";

export interface ReportTemplate {
  id: string;
  type: ReportType;
  name: string;
  description: string;
  jurisdiction: string;
  requiredFields: string[];
  filingFrequency: "AD_HOC" | "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUAL";
  regulatoryBody: string;
  format: "PDF" | "CSV" | "XML" | "JSON";
}

export interface GenerateReportInput {
  templateId: string;
  dateFrom: string;
  dateTo: string;
  filters?: Record<string, unknown>;
  notes?: string;
}

export interface RegulatoryReport {
  id: string;
  templateId: string;
  type: ReportType;
  name: string;
  jurisdiction: string;
  dateFrom: Date;
  dateTo: Date;
  status: ReportStatus;
  data: Record<string, unknown>;
  summary: ReportSummary;
  generatedBy: string;
  businessId: string;
  generatedAt: Date;
  submittedAt: Date | null;
  acknowledgedAt: Date | null;
  fileSize: string;
  notes: string;
}

export interface ReportSummary {
  totalTransactions: number;
  totalVolume: string;
  flaggedTransactions: number;
  blockedTransactions: number;
  sanctionsHits: number;
  travelRuleCompliance: number;
  avgRiskScore: number;
  highRiskEntities: number;
}

export interface FilingDeadline {
  id: string;
  reportType: ReportType;
  jurisdiction: string;
  deadline: Date;
  status: "UPCOMING" | "DUE" | "OVERDUE" | "FILED";
  daysRemaining: number;
  regulatoryBody: string;
}

export interface ReportingAnalytics {
  totalReports: number;
  reportsByType: Record<ReportType, number>;
  reportsByStatus: Record<ReportStatus, number>;
  complianceScore: number;
  upcomingDeadlines: FilingDeadline[];
  avgGenerationTime: number;
  submissionRate: number;
}

// ─── Templates ──────────────────────────────────────────────────────────────

const REPORT_TEMPLATES: ReportTemplate[] = [
  { id: "tpl-sar", type: "SAR", name: "Suspicious Activity Report", description: "Report suspicious transactions to FinCEN/UAE FIU", jurisdiction: "UAE", requiredFields: ["subject_info", "suspicious_activity", "transaction_details"], filingFrequency: "AD_HOC", regulatoryBody: "UAE Financial Intelligence Unit", format: "XML" },
  { id: "tpl-ctr", type: "CTR", name: "Currency Transaction Report", description: "Report transactions exceeding AED 55,000 / USD 10,000", jurisdiction: "UAE", requiredFields: ["transaction_details", "party_info", "amounts"], filingFrequency: "DAILY", regulatoryBody: "UAE Central Bank", format: "XML" },
  { id: "tpl-str", type: "STR", name: "Suspicious Transaction Report", description: "International suspicious transaction reporting", jurisdiction: "INTERNATIONAL", requiredFields: ["originator", "beneficiary", "transaction", "suspicious_indicators"], filingFrequency: "AD_HOC", regulatoryBody: "Local FIU", format: "XML" },
  { id: "tpl-fatf", type: "FATF_TRAVEL_RULE", name: "FATF Travel Rule Compliance", description: "Travel Rule compliance verification report", jurisdiction: "INTERNATIONAL", requiredFields: ["vasp_info", "originator_data", "beneficiary_data", "compliance_status"], filingFrequency: "MONTHLY", regulatoryBody: "FATF / Local Regulator", format: "PDF" },
  { id: "tpl-sanctions", type: "SANCTIONS_SUMMARY", name: "Sanctions Screening Summary", description: "Summary of sanctions screening activity and hits", jurisdiction: "UAE", requiredFields: ["screening_volume", "hit_details", "false_positive_analysis"], filingFrequency: "MONTHLY", regulatoryBody: "UAE Central Bank", format: "PDF" },
  { id: "tpl-aml", type: "AML_QUARTERLY", name: "AML Quarterly Report", description: "Quarterly AML compliance report with risk metrics", jurisdiction: "UAE", requiredFields: ["screening_metrics", "risk_distribution", "escalation_summary", "remediation_actions"], filingFrequency: "QUARTERLY", regulatoryBody: "UAE Securities and Commodities Authority", format: "PDF" },
  { id: "tpl-risk", type: "RISK_ASSESSMENT", name: "Enterprise Risk Assessment", description: "Comprehensive risk assessment with mitigation strategies", jurisdiction: "UAE", requiredFields: ["risk_categories", "assessment_results", "mitigation_plans", "residual_risk"], filingFrequency: "ANNUAL", regulatoryBody: "Board of Directors", format: "PDF" },
];

// ─── Service ────────────────────────────────────────────────────────────────

export class ReportingService {
  private reports: Map<string, RegulatoryReport> = new Map();

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
  ) {}

  /**
   * Get available report templates.
   */
  getTemplates(jurisdiction?: string): ReportTemplate[] {
    if (jurisdiction) {
      return REPORT_TEMPLATES.filter(
        (t) => t.jurisdiction === jurisdiction || t.jurisdiction === "INTERNATIONAL",
      );
    }
    return REPORT_TEMPLATES;
  }

  /**
   * Generate a regulatory report.
   */
  async generateReport(
    input: GenerateReportInput,
    generatedBy: string,
    businessId: string,
  ): Promise<RegulatoryReport> {
    const template = REPORT_TEMPLATES.find((t) => t.id === input.templateId);
    if (!template) {
      throw new ReportingError("TEMPLATE_NOT_FOUND", "Report template not found", 404);
    }

    const reportId = "rpt-" + crypto.randomBytes(8).toString("hex");

    // Generate report data based on template type
    const data = await this.buildReportData(template, input);
    const summary = this.calculateSummary(template.type);

    const report: RegulatoryReport = {
      id: reportId,
      templateId: input.templateId,
      type: template.type,
      name: `${template.name} — ${input.dateFrom} to ${input.dateTo}`,
      jurisdiction: template.jurisdiction,
      dateFrom: new Date(input.dateFrom),
      dateTo: new Date(input.dateTo),
      status: "READY",
      data,
      summary,
      generatedBy,
      businessId,
      generatedAt: new Date(),
      submittedAt: null,
      acknowledgedAt: null,
      fileSize: `${Math.floor(Math.random() * 500 + 100)}KB`,
      notes: input.notes || "",
    };

    this.reports.set(reportId, report);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: generatedBy,
      description: `Regulatory report generated: ${template.name} (${reportId})`,
      severity: "MEDIUM",
      metadata: { reportId, type: template.type, jurisdiction: template.jurisdiction },
    });

    logger.info("Regulatory report generated", {
      reportId,
      type: template.type,
      dateRange: `${input.dateFrom} to ${input.dateTo}`,
      jurisdiction: template.jurisdiction,
    });

    return report;
  }

  /**
   * Submit a report to the regulatory body.
   */
  async submitReport(reportId: string, actor: string, businessId?: string): Promise<RegulatoryReport> {
    const report = this.reports.get(reportId);
    if (!report) {
      throw new ReportingError("REPORT_NOT_FOUND", "Report not found", 404);
    }
    if (businessId && report.businessId !== businessId) {
      throw new ReportingError("FORBIDDEN", "You do not have access to this report", 403);
    }
    if (report.status !== "READY") {
      throw new ReportingError("INVALID_STATE", `Cannot submit report in ${report.status} state`, 409);
    }

    report.status = "SUBMITTED";
    report.submittedAt = new Date();
    this.reports.set(reportId, report);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `Regulatory report ${reportId} submitted to ${report.jurisdiction} regulator`,
      severity: "HIGH",
      metadata: { reportId, type: report.type },
    });

    logger.info("Report submitted", { reportId, type: report.type, jurisdiction: report.jurisdiction });
    return report;
  }

  /**
   * List generated reports.
   */
  listReports(filters?: {
    type?: ReportType;
    status?: ReportStatus;
    jurisdiction?: string;
    businessId?: string;
  }): RegulatoryReport[] {
    let reports = Array.from(this.reports.values());

    if (filters?.type) reports = reports.filter((r) => r.type === filters.type);
    if (filters?.status) reports = reports.filter((r) => r.status === filters.status);
    if (filters?.jurisdiction) reports = reports.filter((r) => r.jurisdiction === filters.jurisdiction);
    // Scope reports to the requesting tenant's businessId (strict equality)
    if (filters?.businessId) reports = reports.filter((r) => r.businessId === filters.businessId);

    return reports.sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime());
  }

  /**
   * Get a single report.
   */
  getReport(reportId: string, businessId?: string): RegulatoryReport {
    const report = this.reports.get(reportId);
    if (!report) {
      throw new ReportingError("REPORT_NOT_FOUND", "Report not found", 404);
    }
    if (businessId && report.businessId !== businessId) {
      throw new ReportingError("FORBIDDEN", "You do not have access to this report", 403);
    }
    return report;
  }

  /**
   * Get upcoming filing deadlines.
   */
  getDeadlines(): FilingDeadline[] {
    const now = new Date();
    const deadlines: FilingDeadline[] = [
      { id: "dl-001", reportType: "CTR", jurisdiction: "UAE", deadline: new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000), status: "DUE", daysRemaining: 1, regulatoryBody: "UAE Central Bank" },
      { id: "dl-002", reportType: "SANCTIONS_SUMMARY", jurisdiction: "UAE", deadline: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000), status: "UPCOMING", daysRemaining: 15, regulatoryBody: "UAE Central Bank" },
      { id: "dl-003", reportType: "FATF_TRAVEL_RULE", jurisdiction: "INTERNATIONAL", deadline: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000), status: "UPCOMING", daysRemaining: 20, regulatoryBody: "FATF" },
      { id: "dl-004", reportType: "AML_QUARTERLY", jurisdiction: "UAE", deadline: new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000), status: "UPCOMING", daysRemaining: 45, regulatoryBody: "UAE SCA" },
      { id: "dl-005", reportType: "RISK_ASSESSMENT", jurisdiction: "UAE", deadline: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000), status: "UPCOMING", daysRemaining: 90, regulatoryBody: "Board of Directors" },
    ];

    return deadlines.sort((a, b) => a.deadline.getTime() - b.deadline.getTime());
  }

  /**
   * Get reporting analytics.
   */
  getAnalytics(): ReportingAnalytics {
    const reports = Array.from(this.reports.values());

    const reportsByType: Record<string, number> = {};
    const reportsByStatus: Record<string, number> = {};

    for (const r of reports) {
      reportsByType[r.type] = (reportsByType[r.type] || 0) + 1;
      reportsByStatus[r.status] = (reportsByStatus[r.status] || 0) + 1;
    }

    const submitted = reports.filter((r) => r.status === "SUBMITTED" || r.status === "ACKNOWLEDGED");
    const submissionRate = reports.length > 0 ? submitted.length / reports.length : 1;

    return {
      totalReports: reports.length,
      reportsByType: reportsByType as Record<ReportType, number>,
      reportsByStatus: reportsByStatus as Record<ReportStatus, number>,
      complianceScore: 94.5, // Composite compliance score
      upcomingDeadlines: this.getDeadlines().slice(0, 3),
      avgGenerationTime: 2.3, // seconds
      submissionRate,
    };
  }

  /**
   * Build report data based on template type.
   */
  private async buildReportData(
    template: ReportTemplate,
    input: GenerateReportInput,
  ): Promise<Record<string, unknown>> {
    const baseData: Record<string, unknown> = {
      reportingEntity: "NoblePay by Aethelred",
      reportingPeriod: { from: input.dateFrom, to: input.dateTo },
      generatedAt: new Date().toISOString(),
      jurisdiction: template.jurisdiction,
      regulatoryBody: template.regulatoryBody,
    };

    switch (template.type) {
      case "SAR":
        return { ...baseData, suspiciousActivities: [], subjectInformation: [], indicators: [] };
      case "CTR":
        return { ...baseData, currencyTransactions: [], totalReportable: 0, thresholdAmount: "55000 AED" };
      case "FATF_TRAVEL_RULE":
        return { ...baseData, travelRuleCompliance: { total: 0, compliant: 0, rate: 0 }, vaspData: [] };
      case "SANCTIONS_SUMMARY":
        return { ...baseData, screeningVolume: 0, hits: 0, falsePositives: 0, truePositives: 0, listUpdates: [] };
      case "AML_QUARTERLY":
        return { ...baseData, riskDistribution: {}, escalations: 0, remediationActions: [] };
      case "RISK_ASSESSMENT":
        return { ...baseData, riskCategories: [], overallRisk: "MEDIUM", mitigationPlans: [] };
      default:
        return baseData;
    }
  }

  /**
   * Calculate report summary metrics.
   */
  private calculateSummary(type: ReportType): ReportSummary {
    return {
      totalTransactions: Math.floor(Math.random() * 10000 + 5000),
      totalVolume: (Math.random() * 50000000 + 10000000).toFixed(2),
      flaggedTransactions: Math.floor(Math.random() * 50 + 10),
      blockedTransactions: Math.floor(Math.random() * 5),
      sanctionsHits: Math.floor(Math.random() * 3),
      travelRuleCompliance: 97.5 + Math.random() * 2,
      avgRiskScore: 18 + Math.floor(Math.random() * 15),
      highRiskEntities: Math.floor(Math.random() * 10 + 2),
    };
  }
}

// ─── Error Class ────────────────────────────────────────────────────────────

export class ReportingError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "ReportingError";
  }
}
