import {
  Prisma,
  PrismaClient,
  RegulatoryReport as PrismaRegulatoryReport,
} from "@prisma/client";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { AuditService } from "./audit";
import { readBoundedJsonResponse } from "../lib/bounded-response";

export type ReportType =
  | "SAR"
  | "CTR"
  | "STR"
  | "FATF_TRAVEL_RULE"
  | "SANCTIONS_SUMMARY"
  | "AML_QUARTERLY"
  | "RISK_ASSESSMENT"
  | "CUSTOM";
export type ReportStatus =
  "DRAFT" | "GENERATING" | "READY" | "SUBMITTED" | "ACKNOWLEDGED" | "REJECTED";

export interface ReportTemplate {
  id: string;
  type: ReportType;
  name: string;
  description: string;
  jurisdiction: string;
  requiredFields: string[];
  filingFrequency:
    "AD_HOC" | "DAILY" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUAL";
  regulatoryBody: string;
  format: "JSON";
}

export interface GenerateReportInput {
  templateId: string;
  dateFrom: string;
  dateTo: string;
  filters?: {
    currency?: string;
    status?: string;
  };
  notes?: string;
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
  contentHash: string | null;
  regulatorRef: string | null;
}

export type RegulatoryReportSummary = Omit<RegulatoryReport, "data">;

export interface PaginatedReportSummaries {
  data: RegulatoryReportSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
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
  reportsByType: Partial<Record<ReportType, number>>;
  reportsByStatus: Partial<Record<ReportStatus, number>>;
  complianceScore: number;
  upcomingDeadlines: FilingDeadline[];
  deadlinesAvailable: boolean;
  avgGenerationTime: number;
  submissionRate: number;
}

export interface RegulatorSubmissionReceipt {
  reference: string;
  status: "SUBMITTED" | "ACKNOWLEDGED";
  acknowledgedAt?: Date;
}

export interface RegulatoryGateway {
  submit(input: {
    reportId: string;
    businessId: string;
    reportType: ReportType;
    jurisdiction: string;
    contentHash: string;
    data: Record<string, unknown>;
    summary: ReportSummary;
  }): Promise<RegulatorSubmissionReceipt>;
}

interface PaymentSnapshot {
  paymentId: string;
  sender: string;
  recipient: string;
  amount: string;
  currency: string;
  status: string;
  riskScore: number | null;
  initiatedAt: string;
  screenings: Array<{
    sanctionsClear: boolean;
    amlRiskScore: number;
    travelRuleCompliant: boolean;
    status: string;
  }>;
  travelRuleRecorded: boolean;
}

type ReportSummaryRow = Pick<
  PrismaRegulatoryReport,
  | "id"
  | "templateId"
  | "businessId"
  | "jurisdiction"
  | "reportType"
  | "periodStart"
  | "periodEnd"
  | "status"
  | "contentHash"
  | "summary"
  | "generatedBy"
  | "notes"
  | "fileSizeBytes"
  | "submittedAt"
  | "acknowledgedAt"
  | "regulatorRef"
  | "createdAt"
>;

const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    id: "tpl-sar",
    type: "SAR",
    name: "Suspicious Activity Evidence",
    description:
      "Review package for suspicious transactions; regulator-specific filing conversion remains an explicit governed step",
    jurisdiction: "UAE",
    requiredFields: [
      "subject_info",
      "suspicious_activity",
      "transaction_details",
    ],
    filingFrequency: "AD_HOC",
    regulatoryBody: "UAE Financial Intelligence Unit",
    format: "JSON",
  },
  {
    id: "tpl-ctr",
    type: "CTR",
    name: "Currency Transaction Evidence",
    description:
      "Review package for transactions exceeding the applicable configured threshold",
    jurisdiction: "UAE",
    requiredFields: ["transaction_details", "party_info", "amounts"],
    filingFrequency: "DAILY",
    regulatoryBody: "UAE Central Bank",
    format: "JSON",
  },
  {
    id: "tpl-str",
    type: "STR",
    name: "Suspicious Transaction Evidence",
    description:
      "Review package for international suspicious-transaction reporting",
    jurisdiction: "INTERNATIONAL",
    requiredFields: [
      "originator",
      "beneficiary",
      "transaction",
      "suspicious_indicators",
    ],
    filingFrequency: "AD_HOC",
    regulatoryBody: "Local FIU",
    format: "JSON",
  },
  {
    id: "tpl-fatf",
    type: "FATF_TRAVEL_RULE",
    name: "FATF Travel Rule Evidence",
    description: "Travel Rule compliance evidence from persisted records",
    jurisdiction: "INTERNATIONAL",
    requiredFields: [
      "vasp_info",
      "originator_data",
      "beneficiary_data",
      "compliance_status",
    ],
    filingFrequency: "MONTHLY",
    regulatoryBody: "FATF / Local Regulator",
    format: "JSON",
  },
  {
    id: "tpl-sanctions",
    type: "SANCTIONS_SUMMARY",
    name: "Sanctions Screening Evidence",
    description: "Summary of persisted sanctions screening activity and hits",
    jurisdiction: "UAE",
    requiredFields: [
      "screening_volume",
      "hit_details",
      "false_positive_analysis",
    ],
    filingFrequency: "MONTHLY",
    regulatoryBody: "UAE Central Bank",
    format: "JSON",
  },
  {
    id: "tpl-aml",
    type: "AML_QUARTERLY",
    name: "AML Quarterly Evidence",
    description: "Quarterly AML review package from persisted screening data",
    jurisdiction: "UAE",
    requiredFields: [
      "screening_metrics",
      "risk_distribution",
      "escalation_summary",
      "remediation_actions",
    ],
    filingFrequency: "QUARTERLY",
    regulatoryBody: "UAE Securities and Commodities Authority",
    format: "JSON",
  },
  {
    id: "tpl-risk",
    type: "RISK_ASSESSMENT",
    name: "Enterprise Risk Evidence",
    description:
      "Risk review package from persisted payment and screening outcomes",
    jurisdiction: "UAE",
    requiredFields: [
      "risk_categories",
      "assessment_results",
      "mitigation_plans",
      "residual_risk",
    ],
    filingFrequency: "ANNUAL",
    regulatoryBody: "Board of Directors",
    format: "JSON",
  },
];

const REPORT_STATUSES = new Set([
  "PENDING",
  "SCREENING",
  "APPROVED",
  "SETTLED",
  "CANCELLED",
  "REFUNDED",
  "FLAGGED",
  "REJECTED",
]);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Regulatory evidence packages are generated synchronously and retained in
 * PostgreSQL. These hard limits bound both the Prisma object graph and the
 * canonical JSON held in Node memory. Operators must split larger evidence
 * sets into adjacent periods or add a narrower currency/status filter.
 */
export const REPORT_GENERATION_LIMITS = Object.freeze({
  maxRangeMs: 93 * DAY_MS,
  maxPayments: 2_000,
  maxScreeningsPerPayment: 10,
  maxBytes: 5 * 1024 * 1024,
});
const HEX_32 = /^0x[a-fA-F0-9]{64}$/;

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (["string", "number", "boolean"].includes(typeof value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function parseBoundary(value: string, endOfDay: boolean): Date {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = dateOnly
    ? new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`)
    : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ReportingError(
      "INVALID_DATE_RANGE",
      "Report dates must be valid ISO-8601 values",
      400,
    );
  }
  return parsed;
}

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function numberFromJson(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringFromJson(value: unknown): string {
  return typeof value === "string" ? value : "0";
}

function normalizeSummary(value: Prisma.JsonValue | null): ReportSummary {
  const summary = jsonObject(value);
  return {
    totalTransactions: numberFromJson(summary.totalTransactions),
    totalVolume: stringFromJson(summary.totalVolume),
    flaggedTransactions: numberFromJson(summary.flaggedTransactions),
    blockedTransactions: numberFromJson(summary.blockedTransactions),
    sanctionsHits: numberFromJson(summary.sanctionsHits),
    travelRuleCompliance: numberFromJson(summary.travelRuleCompliance),
    avgRiskScore: numberFromJson(summary.avgRiskScore),
    highRiskEntities: numberFromJson(summary.highRiskEntities),
  };
}

function mapStatus(status: PrismaRegulatoryReport["status"]): ReportStatus {
  switch (status) {
    case "GENERATED":
      return "READY";
    case "SUBMITTED":
      return "SUBMITTED";
    case "ACKNOWLEDGED":
      return "ACKNOWLEDGED";
    case "REJECTED_BY_REGULATOR":
      return "REJECTED";
    default:
      return "DRAFT";
  }
}

function configuredRegulatoryGateway(): RegulatoryGateway | null {
  const baseUrl = process.env.REGULATORY_REPORTING_URL?.trim();
  const apiKey = process.env.REGULATORY_REPORTING_API_KEY?.trim();
  if (!baseUrl && !apiKey) return null;
  if (!baseUrl || !apiKey) {
    return {
      async submit() {
        throw new ReportingError(
          "REGULATORY_GATEWAY_MISCONFIGURED",
          "Regulatory submission requires both REGULATORY_REPORTING_URL and REGULATORY_REPORTING_API_KEY",
          503,
        );
      },
    };
  }

  let endpoint: URL;
  try {
    endpoint = new URL("/v1/reports", baseUrl);
  } catch {
    return {
      async submit() {
        throw new ReportingError(
          "REGULATORY_GATEWAY_MISCONFIGURED",
          "Regulatory reporting URL is invalid",
          503,
        );
      },
    };
  }

  if (process.env.NODE_ENV === "production" && endpoint.protocol !== "https:") {
    return {
      async submit() {
        throw new ReportingError(
          "REGULATORY_GATEWAY_MISCONFIGURED",
          "Regulatory reporting URL must use HTTPS",
          503,
        );
      },
    };
  }

  return {
    async submit(input) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": apiKey,
            "Idempotency-Key": input.contentHash,
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new ReportingError(
            "REGULATORY_GATEWAY_UNAVAILABLE",
            "Regulatory gateway rejected the submission",
            503,
          );
        }
        const body =
          await readBoundedJsonResponse<Record<string, unknown>>(response);
        const reference = body.reference;
        const status = body.status;
        if (
          typeof reference !== "string" ||
          reference.length < 1 ||
          reference.length > 200 ||
          (status !== "SUBMITTED" && status !== "ACKNOWLEDGED")
        ) {
          throw new ReportingError(
            "REGULATORY_GATEWAY_INVALID_RESPONSE",
            "Regulatory gateway returned an invalid receipt",
            503,
          );
        }
        const acknowledgedAt =
          typeof body.acknowledgedAt === "string"
            ? new Date(body.acknowledgedAt)
            : undefined;
        if (acknowledgedAt && !Number.isFinite(acknowledgedAt.getTime())) {
          throw new ReportingError(
            "REGULATORY_GATEWAY_INVALID_RESPONSE",
            "Regulatory gateway returned an invalid acknowledgement time",
            503,
          );
        }
        return { reference, status, acknowledgedAt };
      } catch (error) {
        if (error instanceof ReportingError) throw error;
        throw new ReportingError(
          "REGULATORY_GATEWAY_UNAVAILABLE",
          "Regulatory gateway is unavailable",
          503,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export class ReportingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly auditService: AuditService,
    private readonly regulatoryGateway: RegulatoryGateway | null = configuredRegulatoryGateway(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  getTemplates(jurisdiction?: string): ReportTemplate[] {
    if (!jurisdiction)
      return REPORT_TEMPLATES.map((template) => ({ ...template }));
    return REPORT_TEMPLATES.filter(
      (template) =>
        template.jurisdiction === jurisdiction ||
        template.jurisdiction === "INTERNATIONAL",
    ).map((template) => ({ ...template }));
  }

  async generateReport(
    input: GenerateReportInput,
    generatedBy: string,
    businessId: string,
  ): Promise<RegulatoryReport> {
    const template = REPORT_TEMPLATES.find(
      (candidate) => candidate.id === input.templateId,
    );
    if (!template)
      throw new ReportingError(
        "TEMPLATE_NOT_FOUND",
        "Report template not found",
        404,
      );
    if (!businessId)
      throw new ReportingError(
        "TENANT_REQUIRED",
        "Authenticated business is required",
        401,
      );

    const periodStart = parseBoundary(input.dateFrom, false);
    const periodEnd = parseBoundary(input.dateTo, true);
    if (
      periodStart > periodEnd ||
      periodEnd.getTime() - periodStart.getTime() >
        REPORT_GENERATION_LIMITS.maxRangeMs
    ) {
      throw new ReportingError(
        "INVALID_DATE_RANGE",
        "Report range must be ordered and no longer than 93 days",
        400,
      );
    }
    if (input.filters?.status && !REPORT_STATUSES.has(input.filters.status)) {
      throw new ReportingError(
        "INVALID_FILTER",
        "Unsupported payment status filter",
        400,
      );
    }

    const startedAt = this.now();
    const rows = await this.prisma.payment.findMany({
      where: {
        businessId,
        initiatedAt: { gte: periodStart, lte: periodEnd },
        ...(input.filters?.currency
          ? { currency: input.filters.currency }
          : {}),
        ...(input.filters?.status
          ? { status: input.filters.status as never }
          : {}),
      },
      orderBy: [{ initiatedAt: "asc" }, { id: "asc" }],
      take: REPORT_GENERATION_LIMITS.maxPayments + 1,
      select: {
        paymentId: true,
        sender: true,
        recipient: true,
        amount: true,
        currency: true,
        status: true,
        riskScore: true,
        initiatedAt: true,
        screenings: {
          orderBy: { id: "asc" },
          take: REPORT_GENERATION_LIMITS.maxScreeningsPerPayment + 1,
          select: {
            sanctionsClear: true,
            amlRiskScore: true,
            travelRuleCompliant: true,
            status: true,
          },
        },
        travelRuleRecord: { select: { id: true } },
      },
    });

    if (rows.length > REPORT_GENERATION_LIMITS.maxPayments) {
      throw new ReportingError(
        "REPORT_ROW_LIMIT_EXCEEDED",
        "A report may contain at most 2,000 payments; narrow the period or filters",
        413,
      );
    }
    if (
      rows.some(
        (payment) =>
          payment.screenings.length >
          REPORT_GENERATION_LIMITS.maxScreeningsPerPayment,
      )
    ) {
      throw new ReportingError(
        "REPORT_SCREENING_LIMIT_EXCEEDED",
        "A payment has more than 10 screening records; use the governed asynchronous evidence pipeline",
        413,
      );
    }

    const payments: PaymentSnapshot[] = rows.map((payment) => ({
      paymentId: payment.paymentId,
      sender: payment.sender,
      recipient: payment.recipient,
      amount: payment.amount.toString(),
      currency: payment.currency,
      status: payment.status,
      riskScore: payment.riskScore,
      initiatedAt: payment.initiatedAt.toISOString(),
      screenings: payment.screenings.map((screening) => ({
        sanctionsClear: screening.sanctionsClear,
        amlRiskScore: screening.amlRiskScore,
        travelRuleCompliant: screening.travelRuleCompliant,
        status: screening.status,
      })),
      travelRuleRecorded: Boolean(payment.travelRuleRecord),
    }));

    const summary = this.calculateSummary(payments);
    const data = this.buildReportData(
      template,
      input,
      payments,
      summary,
      startedAt,
    );
    const reportId = `rpt-${crypto.randomUUID()}`;
    const content = {
      schemaVersion: 1,
      reportId,
      businessId,
      templateId: template.id,
      reportType: template.type,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      data,
      summary,
    };
    const serializedContent = canonicalize(content);
    const serializedBytes = Buffer.byteLength(serializedContent, "utf8");
    if (serializedBytes > REPORT_GENERATION_LIMITS.maxBytes) {
      throw new ReportingError(
        "REPORT_SIZE_LIMIT_EXCEEDED",
        "Report content exceeds the 5 MiB synchronous generation limit; narrow the period or filters",
        413,
      );
    }
    const contentHash = `0x${crypto.createHash("sha256").update(serializedContent).digest("hex")}`;
    const generationDurationMs = Math.max(
      0,
      this.now().getTime() - startedAt.getTime(),
    );

    const created = await this.prisma.$transaction(
      async (transaction) => {
        const report = await transaction.regulatoryReport.create({
          data: {
            id: reportId,
            templateId: template.id,
            businessId,
            jurisdiction: template.jurisdiction,
            reportType: template.type,
            periodStart,
            periodEnd,
            status: "GENERATED",
            contentHash,
            reportData: data as Prisma.InputJsonValue,
            summary: summary as unknown as Prisma.InputJsonValue,
            generatedBy,
            notes: input.notes || null,
            fileSizeBytes: serializedBytes,
            generationDurationMs,
            metadata: { schemaVersion: 1, format: template.format },
          },
        });
        await this.auditService.createAuditEntryInTransaction(transaction, {
          businessId,
          eventType: "SYSTEM_EVENT",
          actor: generatedBy,
          description: `Regulatory report generated: ${template.name} (${reportId})`,
          severity: "MEDIUM",
          metadata: { reportId, type: template.type, contentHash },
        });
        return report;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    logger.info("Regulatory report generated");
    return this.toReport(created);
  }

  async submitReport(
    reportId: string,
    actor: string,
    businessId: string,
  ): Promise<RegulatoryReport> {
    const report = await this.prisma.regulatoryReport.findFirst({
      where: {
        id: reportId,
        businessId,
        fileSizeBytes: {
          not: null,
          lte: REPORT_GENERATION_LIMITS.maxBytes,
        },
      },
    });
    if (!report)
      throw new ReportingError("REPORT_NOT_FOUND", "Report not found", 404);
    if (report.status !== "GENERATED") {
      throw new ReportingError(
        "INVALID_STATE",
        `Cannot submit report in ${mapStatus(report.status)} state`,
        409,
      );
    }
    if (!this.regulatoryGateway) {
      throw new ReportingError(
        "REGULATORY_SUBMISSION_NOT_CONFIGURED",
        "Regulatory submission is unavailable until a regulator gateway is configured",
        501,
      );
    }
    if (!report.contentHash || !HEX_32.test(report.contentHash)) {
      throw new ReportingError(
        "REPORT_INTEGRITY_INVALID",
        "Report has no valid content hash",
        409,
      );
    }

    const mapped = this.toReport(report);
    const receipt = await this.regulatoryGateway.submit({
      reportId: report.id,
      businessId,
      reportType: mapped.type,
      jurisdiction: report.jurisdiction,
      contentHash: report.contentHash,
      data: mapped.data,
      summary: mapped.summary,
    });
    const submittedAt = this.now();
    const acknowledgedAt =
      receipt.status === "ACKNOWLEDGED"
        ? receipt.acknowledgedAt || submittedAt
        : null;

    const updated = await this.prisma.$transaction(
      async (transaction) => {
        const changed = await transaction.regulatoryReport.updateMany({
          where: { id: reportId, businessId, status: "GENERATED" },
          data: {
            status: receipt.status,
            submittedAt,
            acknowledgedAt,
            submittedBy: actor,
            regulatorRef: receipt.reference,
          },
        });
        if (changed.count !== 1) {
          throw new ReportingError(
            "INVALID_STATE",
            "Report submission state changed concurrently",
            409,
          );
        }
        const persisted = await transaction.regulatoryReport.findUnique({
          where: { id: reportId },
        });
        if (!persisted)
          throw new ReportingError("REPORT_NOT_FOUND", "Report not found", 404);
        await this.auditService.createAuditEntryInTransaction(transaction, {
          businessId,
          eventType: "SYSTEM_EVENT",
          actor,
          description: `Regulatory report ${reportId} submitted`,
          severity: "HIGH",
          metadata: {
            reportId,
            type: report.reportType,
            regulatorRef: receipt.reference,
            status: receipt.status,
          },
        });
        return persisted;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    logger.info("Regulatory report submitted");
    return this.toReport(updated);
  }

  async listReports(filters: {
    businessId: string;
    type?: ReportType;
    status?: ReportStatus;
    jurisdiction?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedReportSummaries> {
    if (!filters.businessId)
      throw new ReportingError(
        "TENANT_REQUIRED",
        "Authenticated business is required",
        401,
      );
    const databaseStatus = filters.status
      ? this.toDatabaseStatus(filters.status)
      : undefined;
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 1_000_000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    ) {
      throw new ReportingError(
        "INVALID_PAGINATION",
        "Report pages must be between 1 and 1,000,000 and contain at most 50 summaries",
        400,
      );
    }
    const where: Prisma.RegulatoryReportWhereInput = {
      businessId: filters.businessId,
      ...(filters.type ? { reportType: filters.type } : {}),
      ...(databaseStatus ? { status: databaseStatus } : {}),
      ...(filters.jurisdiction ? { jurisdiction: filters.jurisdiction } : {}),
    };
    const [reports, total] = await Promise.all([
      this.prisma.regulatoryReport.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        // List responses deliberately exclude the bounded-but-potentially-large
        // reportData JSON. GET /:id retrieves one complete evidence package.
        select: {
          id: true,
          templateId: true,
          businessId: true,
          jurisdiction: true,
          reportType: true,
          periodStart: true,
          periodEnd: true,
          status: true,
          contentHash: true,
          summary: true,
          generatedBy: true,
          notes: true,
          fileSizeBytes: true,
          submittedAt: true,
          acknowledgedAt: true,
          regulatorRef: true,
          createdAt: true,
        },
      }),
      this.prisma.regulatoryReport.count({ where }),
    ]);
    return {
      data: reports.map((report) => this.toReportSummary(report)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getReport(
    reportId: string,
    businessId: string,
  ): Promise<RegulatoryReport> {
    const report = await this.prisma.regulatoryReport.findFirst({
      where: {
        id: reportId,
        businessId,
        // Apply the scalar bound in PostgreSQL before Prisma materializes the
        // JSON column. Legacy/untrusted oversized reports remain concealed.
        fileSizeBytes: {
          not: null,
          lte: REPORT_GENERATION_LIMITS.maxBytes,
        },
      },
    });
    if (!report)
      throw new ReportingError("REPORT_NOT_FOUND", "Report not found", 404);
    return this.toReport(report);
  }

  async getAnalytics(businessId: string): Promise<ReportingAnalytics> {
    if (!businessId)
      throw new ReportingError(
        "TENANT_REQUIRED",
        "Authenticated business is required",
        401,
      );
    const reportsByType: Partial<Record<ReportType, number>> = {};
    const reportsByStatus: Partial<Record<ReportStatus, number>> = {};
    const scope = { businessId };
    const [
      totalReports,
      byType,
      byStatus,
      generationDuration,
      submitted,
      rejected,
    ] = await Promise.all([
      this.prisma.regulatoryReport.count({ where: scope }),
      this.prisma.regulatoryReport.groupBy({
        by: ["reportType"],
        where: scope,
        _count: { id: true },
      }),
      this.prisma.regulatoryReport.groupBy({
        by: ["status"],
        where: scope,
        _count: { id: true },
      }),
      this.prisma.regulatoryReport.aggregate({
        where: scope,
        _avg: { generationDurationMs: true },
      }),
      this.prisma.regulatoryReport.count({
        where: { ...scope, status: { in: ["SUBMITTED", "ACKNOWLEDGED"] } },
      }),
      this.prisma.regulatoryReport.count({
        where: { ...scope, status: "REJECTED_BY_REGULATOR" },
      }),
    ]);
    for (const report of byType) {
      const type = report.reportType as ReportType;
      reportsByType[type] = (reportsByType[type] || 0) + report._count.id;
    }
    for (const report of byStatus) {
      const status = mapStatus(report.status);
      reportsByStatus[status] =
        (reportsByStatus[status] || 0) + report._count.id;
    }

    const submissionRate = totalReports > 0 ? submitted / totalReports : 0;
    const complianceScore =
      totalReports > 0
        ? Math.max(0, ((submitted - rejected) / totalReports) * 100)
        : 0;

    return {
      totalReports,
      reportsByType,
      reportsByStatus,
      complianceScore,
      upcomingDeadlines: [],
      deadlinesAvailable: false,
      avgGenerationTime:
        (generationDuration._avg.generationDurationMs || 0) / 1000,
      submissionRate,
    };
  }

  private calculateSummary(payments: PaymentSnapshot[]): ReportSummary {
    let totalVolume = new Prisma.Decimal(0);
    let flaggedTransactions = 0;
    let blockedTransactions = 0;
    let sanctionsHits = 0;
    let travelRuleScreened = 0;
    let travelRuleCompliant = 0;
    let riskTotal = 0;
    let riskCount = 0;
    const highRiskEntities = new Set<string>();

    for (const payment of payments) {
      totalVolume = totalVolume.plus(payment.amount);
      const screeningFailed = payment.screenings.some(
        (screening) =>
          screening.status === "FAILED" || screening.status === "ESCALATED",
      );
      if (
        payment.status === "FLAGGED" ||
        payment.status === "REJECTED" ||
        screeningFailed
      )
        flaggedTransactions++;
      if (payment.status === "REJECTED") blockedTransactions++;
      if (payment.screenings.some((screening) => !screening.sanctionsClear))
        sanctionsHits++;
      for (const screening of payment.screenings) {
        travelRuleScreened++;
        if (screening.travelRuleCompliant) travelRuleCompliant++;
      }
      if (payment.riskScore !== null) {
        riskTotal += payment.riskScore;
        riskCount++;
        if (payment.riskScore >= 70) {
          highRiskEntities.add(payment.sender.toLowerCase());
          highRiskEntities.add(payment.recipient.toLowerCase());
        }
      }
    }

    return {
      totalTransactions: payments.length,
      totalVolume: totalVolume.toFixed(2),
      flaggedTransactions,
      blockedTransactions,
      sanctionsHits,
      travelRuleCompliance:
        travelRuleScreened > 0
          ? Math.round((travelRuleCompliant / travelRuleScreened) * 10_000) /
            100
          : 0,
      avgRiskScore:
        riskCount > 0 ? Math.round((riskTotal / riskCount) * 100) / 100 : 0,
      highRiskEntities: highRiskEntities.size,
    };
  }

  private buildReportData(
    template: ReportTemplate,
    input: GenerateReportInput,
    payments: PaymentSnapshot[],
    summary: ReportSummary,
    generatedAt: Date,
  ): Record<string, unknown> {
    const volumeByCurrency: Record<string, string> = {};
    for (const payment of payments) {
      volumeByCurrency[payment.currency] = new Prisma.Decimal(
        volumeByCurrency[payment.currency] || 0,
      )
        .plus(payment.amount)
        .toFixed(2);
    }
    const suspicious = payments.filter(
      (payment) =>
        payment.status === "FLAGGED" ||
        payment.status === "REJECTED" ||
        payment.screenings.some(
          (screening) =>
            screening.status === "FAILED" || screening.status === "ESCALATED",
        ),
    );
    const base: Record<string, unknown> = {
      schemaVersion: 1,
      reportingEntity: "NoblePay by Aethelred",
      reportingPeriod: { from: input.dateFrom, to: input.dateTo },
      generatedAt: generatedAt.toISOString(),
      jurisdiction: template.jurisdiction,
      regulatoryBody: template.regulatoryBody,
      volumeByCurrency,
      filters: input.filters || {},
    };

    switch (template.type) {
      case "SAR":
      case "STR":
        return {
          ...base,
          suspiciousActivities: suspicious,
          suspiciousActivityCount: suspicious.length,
        };
      case "CTR": {
        const reportable = payments.filter((payment) => {
          const amount = new Prisma.Decimal(payment.amount);
          return (
            (payment.currency === "AED" && amount.gte(55_000)) ||
            (payment.currency === "USD" && amount.gte(10_000))
          );
        });
        return {
          ...base,
          currencyTransactions: reportable,
          totalReportable: reportable.length,
          thresholds: { AED: "55000", USD: "10000" },
          unsupportedCurrencies: [
            ...new Set(
              payments
                .map((payment) => payment.currency)
                .filter((currency) => currency !== "AED" && currency !== "USD"),
            ),
          ],
        };
      }
      case "FATF_TRAVEL_RULE": {
        const screened = payments.filter(
          (payment) => payment.screenings.length > 0,
        );
        const compliant = screened.filter((payment) =>
          payment.screenings.every(
            (screening) => screening.travelRuleCompliant,
          ),
        );
        return {
          ...base,
          travelRuleCompliance: {
            total: screened.length,
            compliant: compliant.length,
            rate: summary.travelRuleCompliance,
          },
          missingTravelRuleRecords: payments
            .filter((payment) => !payment.travelRuleRecorded)
            .map((payment) => payment.paymentId),
        };
      }
      case "SANCTIONS_SUMMARY":
        return {
          ...base,
          screeningVolume: payments.filter(
            (payment) => payment.screenings.length > 0,
          ).length,
          hits: payments
            .filter((payment) =>
              payment.screenings.some((screening) => !screening.sanctionsClear),
            )
            .map((payment) => payment.paymentId),
          sanctionsHits: summary.sanctionsHits,
        };
      case "AML_QUARTERLY":
        return {
          ...base,
          riskDistribution: {
            low: payments.filter(
              (payment) => payment.riskScore !== null && payment.riskScore < 30,
            ).length,
            medium: payments.filter(
              (payment) =>
                payment.riskScore !== null &&
                payment.riskScore >= 30 &&
                payment.riskScore < 70,
            ).length,
            high: payments.filter(
              (payment) =>
                payment.riskScore !== null && payment.riskScore >= 70,
            ).length,
            unscored: payments.filter((payment) => payment.riskScore === null)
              .length,
          },
          escalations: payments.filter((payment) =>
            payment.screenings.some(
              (screening) => screening.status === "ESCALATED",
            ),
          ).length,
        };
      case "RISK_ASSESSMENT":
        return {
          ...base,
          observedMetrics: summary,
          highRiskPayments: payments
            .filter((payment) => (payment.riskScore || 0) >= 70)
            .map((payment) => payment.paymentId),
          unscoredPayments: payments
            .filter((payment) => payment.riskScore === null)
            .map((payment) => payment.paymentId),
        };
      default:
        return { ...base, transactions: payments };
    }
  }

  private toDatabaseStatus(
    status: ReportStatus,
  ): PrismaRegulatoryReport["status"] | undefined {
    switch (status) {
      case "DRAFT":
        return "DRAFT";
      case "READY":
        return "GENERATED";
      case "SUBMITTED":
        return "SUBMITTED";
      case "ACKNOWLEDGED":
        return "ACKNOWLEDGED";
      case "REJECTED":
        return "REJECTED_BY_REGULATOR";
      default:
        return undefined;
    }
  }

  private toReportSummary(report: ReportSummaryRow): RegulatoryReportSummary {
    const template = REPORT_TEMPLATES.find(
      (candidate) => candidate.id === report.templateId,
    );
    return {
      id: report.id,
      templateId: report.templateId,
      type: (template?.type || report.reportType) as ReportType,
      name: template?.name || report.reportType,
      jurisdiction: report.jurisdiction,
      dateFrom: report.periodStart,
      dateTo: report.periodEnd,
      status: mapStatus(report.status),
      summary: normalizeSummary(report.summary),
      generatedBy: report.generatedBy || "",
      businessId: report.businessId,
      generatedAt: report.createdAt,
      submittedAt: report.submittedAt,
      acknowledgedAt: report.acknowledgedAt,
      fileSize:
        report.fileSizeBytes === null
          ? "unknown"
          : `${report.fileSizeBytes} bytes`,
      notes: report.notes || "",
      contentHash: report.contentHash,
      regulatorRef: report.regulatorRef,
    };
  }

  private toReport(report: PrismaRegulatoryReport): RegulatoryReport {
    const template = REPORT_TEMPLATES.find(
      (candidate) => candidate.id === report.templateId,
    );
    return {
      id: report.id,
      templateId: report.templateId,
      type: (template?.type || report.reportType) as ReportType,
      name: template?.name || report.reportType,
      jurisdiction: report.jurisdiction,
      dateFrom: report.periodStart,
      dateTo: report.periodEnd,
      status: mapStatus(report.status),
      data: jsonObject(report.reportData),
      summary: normalizeSummary(report.summary),
      generatedBy: report.generatedBy || "",
      businessId: report.businessId,
      generatedAt: report.createdAt,
      submittedAt: report.submittedAt,
      acknowledgedAt: report.acknowledgedAt,
      fileSize:
        report.fileSizeBytes === null
          ? "unknown"
          : `${report.fileSizeBytes} bytes`,
      notes: report.notes || "",
      contentHash: report.contentHash,
      regulatorRef: report.regulatorRef,
    };
  }
}

export class ReportingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ReportingError";
  }
}
