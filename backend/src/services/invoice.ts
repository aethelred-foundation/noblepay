import {
  Invoice as PrismaInvoice,
  InvoiceDispute as PrismaInvoiceDispute,
  InvoiceFinancingRequest as PrismaFinancingRequest,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { AuditService } from "./audit";
import { readBoundedJsonResponse } from "../lib/bounded-response";

export type InvoiceStatus =
  | "DRAFT"
  | "ISSUED"
  | "FINANCED"
  | "PARTIALLY_FINANCED"
  | "SETTLED"
  | "OVERDUE"
  | "DISPUTED"
  | "CANCELLED"
  | "WRITTEN_OFF";
export type DisputeStatus = "OPEN" | "UNDER_REVIEW" | "RESOLVED" | "ESCALATED";
export type FinancingStatus =
  "PENDING" | "APPROVED" | "FUNDED" | "REPAID" | "DEFAULTED" | "REJECTED";

export interface CreateInvoiceInput {
  debtor: string;
  debtorName: string;
  amount: string;
  currency: string;
  maturityDate: string;
  description: string;
  purchaseOrderRef?: string;
  gracePeriodDays?: number;
  latePenaltyRate?: number;
  metadata?: Record<string, unknown>;
}

export interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  businessId: string;
  issuer: string;
  debtor: string;
  debtorName: string;
  description: string;
  amount: string;
  currency: string;
  outstandingAmount: string;
  financedAmount: string;
  maturityDate: Date;
  status: InvoiceStatus;
  purchaseOrderRef: string | null;
  gracePeriodDays: number;
  latePenaltyRate: number;
  discountRate: number | null;
  creditScore: number | null;
  createdAt: Date;
  settledAt: Date | null;
  settlementReference: string | null;
  metadata: Record<string, unknown>;
}

export interface FinancingRequest {
  id: string;
  invoiceId: string;
  amount: string;
  discountRate: number | null;
  netProceeds: string | null;
  factor: string | null;
  term: number;
  status: FinancingStatus;
  externalReference: string | null;
  createdAt: Date;
}

export interface InvoiceDisputeRecord {
  id: string;
  invoiceId: string;
  reason: string;
  status: DisputeStatus;
  raisedBy: string;
  reviewer: string | null;
  resolution: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface CreditScoreRecord {
  businessId: string;
  score: number | null;
  grade: "AAA" | "AA" | "A" | "BBB" | "BB" | "B" | "CCC" | "D" | "UNRATED";
  sampleSize: number;
  factors: Array<{ name: string; value: number; description: string }>;
  history: Array<{ date: string; score: number }>;
  methodology: string;
  lastUpdated: Date;
}

export interface InvoiceAnalytics {
  totalReceivables: string;
  totalFinanced: string;
  totalOutstanding: string;
  avgDaysToPayment: number;
  overdueAmount: string;
  overdueCount: number;
  financingUtilization: number;
  agingBuckets: Array<{ range: string; amount: string; count: number }>;
  byCurrency: Record<
    string,
    { total: string; financed: string; count: number }
  >;
}

export interface InvoiceFinancingGateway {
  requestFinancing(input: {
    idempotencyKey: string;
    invoiceId: string;
    businessId: string;
    issuer: string;
    debtor: string;
    amount: string;
    currency: string;
    maturityDate: string;
  }): Promise<{
    externalReference: string;
    status: "PENDING" | "APPROVED" | "FUNDED" | "REJECTED";
    amount: string;
    discountRate?: string;
    netProceeds?: string;
    factor?: string;
  }>;
  verifySettlement(input: {
    invoiceId: string;
    businessId: string;
    settlementReference: string;
    amount: string;
    currency: string;
  }): Promise<{
    externalReference: string;
    status: "SETTLED";
    amount: string;
    currency: string;
    settledAt: Date;
  }>;
}

const CREDIT_SCORE_GRADES: Array<{
  grade: Exclude<CreditScoreRecord["grade"], "UNRATED">;
  min: number;
}> = [
  { grade: "AAA", min: 850 },
  { grade: "AA", min: 750 },
  { grade: "A", min: 650 },
  { grade: "BBB", min: 550 },
  { grade: "BB", min: 450 },
  { grade: "B", min: 350 },
  { grade: "CCC", min: 200 },
  { grade: "D", min: 0 },
];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MATURITY_MS = 3 * 366 * DAY_MS;
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function parsePositiveDecimal(value: string, field: string): Prisma.Decimal {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new InvoiceError(
      "INVALID_AMOUNT",
      `${field} must be a positive decimal`,
      400,
    );
  }
  const decimal = new Prisma.Decimal(value);
  // Decimal.js reports positive zero as `isPositive()`. Financial amounts
  // must be strictly greater than zero, so compare numerically instead.
  if (decimal.lte(0)) {
    throw new InvoiceError(
      "INVALID_AMOUNT",
      `${field} must be greater than zero`,
      400,
    );
  }
  return decimal;
}

function parseRate(
  value: string | number | undefined,
  field: string,
): Prisma.Decimal | null {
  if (value === undefined) return null;
  let decimal: Prisma.Decimal;
  try {
    decimal = new Prisma.Decimal(value);
  } catch {
    throw new InvoiceError(
      "INVALID_GATEWAY_RESPONSE",
      `${field} is not a valid decimal`,
      503,
    );
  }
  if (decimal.isNegative() || decimal.gt(1)) {
    throw new InvoiceError(
      "INVALID_GATEWAY_RESPONSE",
      `${field} must be between 0 and 1`,
      503,
    );
  }
  return decimal;
}

function normalizeExternalReference(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new InvoiceError(
      "INVALID_GATEWAY_RESPONSE",
      "Financing gateway returned an invalid reference",
      503,
    );
  }
  return value;
}

function configuredGateway(): InvoiceFinancingGateway | null {
  const baseUrl = process.env.INVOICE_FINANCING_SERVICE_URL?.trim();
  const apiKey = process.env.INVOICE_FINANCING_API_KEY?.trim();
  if (!baseUrl && !apiKey) return null;

  const unavailable = (message: string): InvoiceFinancingGateway => ({
    async requestFinancing() {
      throw new InvoiceError("FINANCING_GATEWAY_MISCONFIGURED", message, 503);
    },
    async verifySettlement() {
      throw new InvoiceError("FINANCING_GATEWAY_MISCONFIGURED", message, 503);
    },
  });
  if (!baseUrl || !apiKey) {
    return unavailable(
      "Invoice financing requires both service URL and API key",
    );
  }

  let financingEndpoint: URL;
  let settlementEndpoint: URL;
  try {
    financingEndpoint = new URL("/v1/financing", baseUrl);
    settlementEndpoint = new URL("/v1/settlements/verify", baseUrl);
  } catch {
    return unavailable("Invoice financing service URL is invalid");
  }
  if (
    process.env.NODE_ENV === "production" &&
    (financingEndpoint.protocol !== "https:" ||
      settlementEndpoint.protocol !== "https:")
  ) {
    return unavailable("Invoice financing service URL must use HTTPS");
  }

  const post = async (
    endpoint: URL,
    body: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new InvoiceError(
          "FINANCING_GATEWAY_UNAVAILABLE",
          "Invoice financing gateway rejected the request",
          503,
        );
      }
      const parsed = await readBoundedJsonResponse(response);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new InvoiceError(
          "INVALID_GATEWAY_RESPONSE",
          "Invoice financing gateway returned invalid JSON",
          503,
        );
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof InvoiceError) throw error;
      throw new InvoiceError(
        "FINANCING_GATEWAY_UNAVAILABLE",
        "Invoice financing gateway is unavailable",
        503,
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    async requestFinancing(input) {
      const body = await post(financingEndpoint, input, input.idempotencyKey);
      const status = body.status;
      if (
        !["PENDING", "APPROVED", "FUNDED", "REJECTED"].includes(String(status))
      ) {
        throw new InvoiceError(
          "INVALID_GATEWAY_RESPONSE",
          "Financing gateway returned an invalid status",
          503,
        );
      }
      return {
        externalReference: normalizeExternalReference(body.externalReference),
        status: status as "PENDING" | "APPROVED" | "FUNDED" | "REJECTED",
        amount: String(body.amount || ""),
        discountRate:
          body.discountRate === undefined
            ? undefined
            : String(body.discountRate),
        netProceeds:
          body.netProceeds === undefined ? undefined : String(body.netProceeds),
        factor: body.factor === undefined ? undefined : String(body.factor),
      };
    },
    async verifySettlement(input) {
      const body = await post(settlementEndpoint, input);
      const settledAt = new Date(String(body.settledAt || ""));
      if (body.status !== "SETTLED" || !Number.isFinite(settledAt.getTime())) {
        throw new InvoiceError(
          "INVALID_GATEWAY_RESPONSE",
          "Settlement gateway did not confirm settlement",
          503,
        );
      }
      return {
        externalReference: normalizeExternalReference(body.externalReference),
        status: "SETTLED",
        amount: String(body.amount || ""),
        currency: String(body.currency || ""),
        settledAt,
      };
    },
  };
}

export class InvoiceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly auditService: AuditService,
    private readonly gateway: InvoiceFinancingGateway | null = configuredGateway(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createInvoice(
    input: CreateInvoiceInput,
    actor: string,
    businessId: string,
  ): Promise<InvoiceRecord> {
    if (!businessId)
      throw new InvoiceError(
        "TENANT_REQUIRED",
        "Authenticated business is required",
        401,
      );
    const amount = parsePositiveDecimal(input.amount, "amount");
    const dueDate = new Date(input.maturityDate);
    const now = this.now();
    if (
      !Number.isFinite(dueDate.getTime()) ||
      dueDate <= now ||
      dueDate.getTime() - now.getTime() > MAX_MATURITY_MS
    ) {
      throw new InvoiceError(
        "INVALID_MATURITY",
        "Maturity must be in the future and within three years",
        400,
      );
    }
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { address: true, kycStatus: true },
    });
    if (!business)
      throw new InvoiceError("BUSINESS_NOT_FOUND", "Business not found", 404);
    if (business.kycStatus !== "VERIFIED") {
      throw new InvoiceError(
        "BUSINESS_NOT_VERIFIED",
        "Business must be KYC verified to issue invoices",
        403,
      );
    }

    const invoiceId = `inv-${crypto.randomUUID()}`;
    const created = await this.prisma.$transaction(
      async (transaction) => {
        const invoice = await transaction.invoice.create({
          data: {
            id: invoiceId,
            invoiceNumber: invoiceId,
            businessId,
            issuer: business.address,
            debtor: input.debtor,
            debtorName: input.debtorName,
            description: input.description,
            amount,
            currency: input.currency,
            issueDate: now,
            dueDate,
            status: "SUBMITTED",
            financedAmount: new Prisma.Decimal(0),
            purchaseOrderRef: input.purchaseOrderRef || null,
            gracePeriodDays: input.gracePeriodDays ?? 30,
            latePenaltyRate: new Prisma.Decimal(input.latePenaltyRate ?? 0.015),
            metadata: (input.metadata || {}) as Prisma.InputJsonValue,
          },
        });
        await this.auditService.createAuditEntryInTransaction(transaction, {
          businessId,
          eventType: "SYSTEM_EVENT",
          actor,
          description: `Invoice ${invoiceId} issued`,
          severity: "INFO",
          metadata: {
            invoiceId,
            amount: amount.toString(),
            currency: input.currency,
            debtor: input.debtor,
          },
        });
        return invoice;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    logger.info("Invoice issued");
    return this.toInvoice(created);
  }

  async getInvoice(
    invoiceId: string,
    businessId: string,
  ): Promise<InvoiceRecord> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, businessId },
    });
    if (!invoice)
      throw new InvoiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
    return this.toInvoice(invoice);
  }

  async requestFinancing(
    invoiceId: string,
    amountInput: string,
    actor: string,
    businessId: string,
    idempotencyKey: string,
  ): Promise<FinancingRequest> {
    if (!this.gateway) {
      throw new InvoiceError(
        "INVOICE_FINANCING_NOT_CONFIGURED",
        "Invoice financing is unavailable until a verified financing gateway is configured",
        501,
      );
    }
    const amount = parsePositiveDecimal(amountInput, "amount");
    const replay = await this.prisma.invoiceFinancingRequest.findFirst({
      where: { businessId, idempotencyKey },
    });
    if (replay) {
      if (replay.invoiceId !== invoiceId || !replay.amount.equals(amount)) {
        throw new InvoiceError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used for another financing request",
          409,
        );
      }
      return this.toFinancingRequest(replay);
    }

    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, businessId },
    });
    if (!invoice)
      throw new InvoiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
    if (!["SUBMITTED", "FINANCED"].includes(invoice.status)) {
      throw new InvoiceError(
        "INVALID_STATE",
        `Cannot finance ${invoice.status} invoice`,
        409,
      );
    }
    const outstanding = Prisma.Decimal.max(
      invoice.amount.minus(invoice.financedAmount),
      0,
    );
    if (amount.gt(outstanding)) {
      throw new InvoiceError(
        "EXCEEDS_OUTSTANDING",
        `Requested ${amount} exceeds outstanding ${outstanding}`,
        409,
      );
    }

    const termDays = Math.max(
      0,
      Math.ceil((invoice.dueDate.getTime() - this.now().getTime()) / DAY_MS),
    );
    const receipt = await this.gateway.requestFinancing({
      idempotencyKey,
      invoiceId,
      businessId,
      issuer: invoice.issuer,
      debtor: invoice.debtor,
      amount: amount.toString(),
      currency: invoice.currency,
      maturityDate: invoice.dueDate.toISOString(),
    });
    const confirmedAmount = parsePositiveDecimal(
      receipt.amount,
      "gateway amount",
    );
    if (!confirmedAmount.equals(amount)) {
      throw new InvoiceError(
        "GATEWAY_AMOUNT_MISMATCH",
        "Financing gateway amount does not match the request",
        503,
      );
    }
    const discountRate = parseRate(receipt.discountRate, "discountRate");
    const netProceeds =
      receipt.netProceeds === undefined
        ? null
        : parsePositiveDecimal(receipt.netProceeds, "netProceeds");
    if (receipt.status === "FUNDED") {
      if (
        !discountRate ||
        !netProceeds ||
        netProceeds.gt(amount) ||
        !receipt.factor
      ) {
        throw new InvoiceError(
          "INVALID_GATEWAY_RESPONSE",
          "Funded receipt is missing verified pricing or factor data",
          503,
        );
      }
    }

    const persisted = await this.prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${invoiceId}))`;
        const existing = await transaction.invoiceFinancingRequest.findFirst({
          where: { businessId, idempotencyKey },
        });
        if (existing) {
          if (
            existing.invoiceId !== invoiceId ||
            !existing.amount.equals(amount)
          ) {
            throw new InvoiceError(
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key was already used for another financing request",
              409,
            );
          }
          return existing;
        }
        const current = await transaction.invoice.findFirst({
          where: { id: invoiceId, businessId },
        });
        if (!current)
          throw new InvoiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
        const currentOutstanding = Prisma.Decimal.max(
          current.amount.minus(current.financedAmount),
          0,
        );
        if (amount.gt(currentOutstanding)) {
          throw new InvoiceError(
            "EXCEEDS_OUTSTANDING",
            "Concurrent financing exhausted the invoice balance",
            409,
          );
        }

        const request = await transaction.invoiceFinancingRequest.create({
          data: {
            invoiceId,
            businessId,
            idempotencyKey,
            amount,
            discountRate,
            netProceeds,
            factor: receipt.factor || null,
            termDays,
            status: receipt.status,
            externalReference: normalizeExternalReference(
              receipt.externalReference,
            ),
          },
        });
        if (receipt.status === "FUNDED") {
          const financedAmount = current.financedAmount.plus(amount);
          await transaction.invoice.update({
            where: { id: invoiceId },
            data: {
              financedAmount,
              discountRate,
              status: financedAmount.gte(current.amount)
                ? "FINANCED"
                : "SUBMITTED",
            },
          });
        }
        await this.auditService.createAuditEntryInTransaction(transaction, {
          businessId,
          eventType: "SYSTEM_EVENT",
          actor,
          description: `Invoice financing request ${request.id} recorded as ${receipt.status}`,
          severity: receipt.status === "FUNDED" ? "MEDIUM" : "INFO",
          metadata: {
            invoiceId,
            financingRequestId: request.id,
            amount: amount.toString(),
            status: receipt.status,
            externalReference: receipt.externalReference,
          },
        });
        return request;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    logger.info("Invoice financing receipt persisted");
    return this.toFinancingRequest(persisted);
  }

  async settleInvoice(
    invoiceId: string,
    actor: string,
    businessId: string,
    settlementReference: string,
  ): Promise<InvoiceRecord> {
    if (!this.gateway) {
      throw new InvoiceError(
        "INVOICE_SETTLEMENT_NOT_CONFIGURED",
        "Invoice settlement is unavailable until a verified settlement gateway is configured",
        501,
      );
    }
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, businessId },
    });
    if (!invoice)
      throw new InvoiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
    if (invoice.status === "SETTLED") return this.toInvoice(invoice);
    if (!["SUBMITTED", "FINANCED"].includes(invoice.status)) {
      throw new InvoiceError(
        "INVALID_STATE",
        `Cannot settle ${invoice.status} invoice`,
        409,
      );
    }

    const receipt = await this.gateway.verifySettlement({
      invoiceId,
      businessId,
      settlementReference,
      amount: invoice.amount.toString(),
      currency: invoice.currency,
    });
    if (
      !parsePositiveDecimal(receipt.amount, "settlement amount").equals(
        invoice.amount,
      ) ||
      receipt.currency !== invoice.currency ||
      receipt.externalReference !== settlementReference
    ) {
      throw new InvoiceError(
        "SETTLEMENT_MISMATCH",
        "Settlement receipt does not match the invoice",
        503,
      );
    }

    const settled = await this.prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${invoiceId}))`;
        const changed = await transaction.invoice.updateMany({
          where: {
            id: invoiceId,
            businessId,
            status: { in: ["SUBMITTED", "FINANCED"] },
          },
          data: {
            status: "SETTLED",
            settlementReference,
            settledAt: receipt.settledAt,
          },
        });
        if (changed.count !== 1) {
          throw new InvoiceError(
            "INVALID_STATE",
            "Invoice settlement state changed concurrently",
            409,
          );
        }
        await transaction.invoiceFinancingRequest.updateMany({
          where: { invoiceId, businessId, status: "FUNDED" },
          data: { status: "REPAID" },
        });
        const updated = await transaction.invoice.findUnique({
          where: { id: invoiceId },
        });
        if (!updated)
          throw new InvoiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
        await this.auditService.createAuditEntryInTransaction(transaction, {
          businessId,
          eventType: "SYSTEM_EVENT",
          actor,
          description: `Invoice ${invoiceId} settlement verified`,
          severity: "MEDIUM",
          metadata: { invoiceId, settlementReference },
        });
        return updated;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return this.toInvoice(settled);
  }

  async raiseDispute(
    invoiceId: string,
    reason: string,
    actor: string,
    businessId: string,
  ): Promise<InvoiceDisputeRecord> {
    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${invoiceId}))`;
        const invoice = await transaction.invoice.findFirst({
          where: { id: invoiceId, businessId },
        });
        if (!invoice)
          throw new InvoiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
        if (["SETTLED", "WRITTEN_OFF"].includes(invoice.status)) {
          throw new InvoiceError(
            "INVALID_STATE",
            `Cannot dispute ${invoice.status} invoice`,
            409,
          );
        }
        const existing = await transaction.invoiceDispute.findFirst({
          where: {
            invoiceId,
            businessId,
            status: { in: ["OPEN", "UNDER_REVIEW", "ESCALATED"] },
          },
        });
        if (existing)
          throw new InvoiceError(
            "DISPUTE_ALREADY_OPEN",
            "Invoice already has an active dispute",
            409,
          );

        const dispute = await transaction.invoiceDispute.create({
          data: {
            invoiceId,
            businessId,
            reason,
            raisedBy: actor,
            status: "OPEN",
          },
        });
        await transaction.invoice.update({
          where: { id: invoiceId },
          data: { status: "DISPUTED", disputeReason: reason },
        });
        await this.auditService.createAuditEntryInTransaction(transaction, {
          businessId,
          eventType: "SYSTEM_EVENT",
          actor,
          description: `Dispute ${dispute.id} raised on invoice ${invoiceId}`,
          severity: "HIGH",
          metadata: { invoiceId, disputeId: dispute.id, reason },
        });
        return this.toDispute(dispute);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async listInvoices(filters: {
    businessId: string;
    issuer?: string;
    debtor?: string;
    status?: InvoiceStatus;
    currency?: string;
  }): Promise<InvoiceRecord[]> {
    const databaseStatus = filters.status
      ? this.toDatabaseStatus(filters.status)
      : undefined;
    const invoices = await this.prisma.invoice.findMany({
      where: {
        businessId: filters.businessId,
        ...(filters.issuer ? { issuer: filters.issuer } : {}),
        ...(filters.debtor ? { debtor: filters.debtor } : {}),
        ...(filters.currency ? { currency: filters.currency } : {}),
        ...(databaseStatus ? { status: databaseStatus } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return invoices
      .map((invoice) => this.toInvoice(invoice))
      .filter(
        (invoice) => !filters.status || invoice.status === filters.status,
      );
  }

  async listFinancingRequests(
    invoiceId: string,
    businessId: string,
  ): Promise<FinancingRequest[]> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, businessId },
      select: { id: true },
    });
    if (!invoice)
      throw new InvoiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
    const requests = await this.prisma.invoiceFinancingRequest.findMany({
      where: { invoiceId, businessId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return requests.map((request) => this.toFinancingRequest(request));
  }

  async getCreditScore(businessId: string): Promise<CreditScoreRecord> {
    const invoices = await this.prisma.invoice.findMany({
      where: { businessId },
      orderBy: { createdAt: "asc" },
    });
    const now = this.now();
    const observed = invoices.filter(
      (invoice) =>
        invoice.status === "SETTLED" ||
        invoice.status === "WRITTEN_OFF" ||
        now.getTime() >
          invoice.dueDate.getTime() + invoice.gracePeriodDays * DAY_MS,
    );
    const settled = observed.filter(
      (invoice) => invoice.status === "SETTLED" && invoice.settledAt,
    );
    const onTime = settled.filter(
      (invoice) =>
        invoice.settledAt!.getTime() <=
        invoice.dueDate.getTime() + invoice.gracePeriodDays * DAY_MS,
    );
    const defaults = observed.filter(
      (invoice) => invoice.status === "WRITTEN_OFF",
    );
    const lateDays = settled.map((invoice) =>
      Math.max(
        0,
        (invoice.settledAt!.getTime() - invoice.dueDate.getTime()) / DAY_MS,
      ),
    );
    const avgDaysLate =
      lateDays.length > 0
        ? lateDays.reduce((sum, value) => sum + value, 0) / lateDays.length
        : 0;
    const onTimeRate = settled.length > 0 ? onTime.length / settled.length : 0;
    const defaultRate =
      observed.length > 0 ? defaults.length / observed.length : 0;
    const lastUpdated = now;

    if (observed.length < 3) {
      return {
        businessId,
        score: null,
        grade: "UNRATED",
        sampleSize: observed.length,
        factors: [
          {
            name: "Observed invoices",
            value: observed.length,
            description:
              "At least three matured invoices are required for a score",
          },
        ],
        history: [],
        methodology: "NoblePay observed invoice performance v1",
        lastUpdated,
      };
    }

    const score = Math.max(
      0,
      Math.min(
        1000,
        Math.round(
          300 +
            onTimeRate * 500 +
            (1 - defaultRate) * 200 -
            Math.min(100, avgDaysLate * 2),
        ),
      ),
    );
    const grade =
      CREDIT_SCORE_GRADES.find((candidate) => score >= candidate.min)?.grade ||
      "D";
    await this.prisma.creditScore.upsert({
      where: { businessId },
      create: {
        businessId,
        score,
        grade,
        paymentHistory: new Prisma.Decimal(onTimeRate * 100),
        avgDaysLate: new Prisma.Decimal(avgDaysLate),
        defaultRate: new Prisma.Decimal(defaultRate),
        totalInvoices: observed.length,
        lastUpdated,
      },
      update: {
        score,
        grade,
        paymentHistory: new Prisma.Decimal(onTimeRate * 100),
        avgDaysLate: new Prisma.Decimal(avgDaysLate),
        defaultRate: new Prisma.Decimal(defaultRate),
        totalInvoices: observed.length,
        lastUpdated,
      },
    });

    return {
      businessId,
      score,
      grade,
      sampleSize: observed.length,
      factors: [
        {
          name: "On-time payment rate",
          value: onTimeRate,
          description: `${onTime.length} of ${settled.length} settled invoices were on time`,
        },
        {
          name: "Default rate",
          value: defaultRate,
          description: `${defaults.length} of ${observed.length} observed invoices were written off`,
        },
        {
          name: "Average days late",
          value: avgDaysLate,
          description: "Average delay across settled invoices",
        },
      ],
      history: [],
      methodology: "NoblePay observed invoice performance v1",
      lastUpdated,
    };
  }

  async getAnalytics(businessId: string): Promise<InvoiceAnalytics> {
    const invoices = await this.prisma.invoice.findMany({
      where: { businessId },
    });
    const now = this.now();
    let totalReceivables = new Prisma.Decimal(0);
    let totalFinanced = new Prisma.Decimal(0);
    let totalOutstanding = new Prisma.Decimal(0);
    let overdueAmount = new Prisma.Decimal(0);
    let overdueCount = 0;
    let totalDaysToPayment = 0;
    let settledCount = 0;
    const byCurrency: InvoiceAnalytics["byCurrency"] = {};
    const agingBuckets: InvoiceAnalytics["agingBuckets"] = [
      { range: "0-30 days", amount: "0.00", count: 0 },
      { range: "31-60 days", amount: "0.00", count: 0 },
      { range: "61-90 days", amount: "0.00", count: 0 },
      { range: "90+ days", amount: "0.00", count: 0 },
    ];

    for (const invoice of invoices) {
      const outstanding = ["SETTLED", "WRITTEN_OFF"].includes(invoice.status)
        ? new Prisma.Decimal(0)
        : Prisma.Decimal.max(invoice.amount.minus(invoice.financedAmount), 0);
      totalReceivables = totalReceivables.plus(invoice.amount);
      totalFinanced = totalFinanced.plus(invoice.financedAmount);
      totalOutstanding = totalOutstanding.plus(outstanding);
      if (invoice.dueDate < now && outstanding.gt(0)) {
        overdueAmount = overdueAmount.plus(outstanding);
        overdueCount++;
      }
      if (invoice.settledAt) {
        totalDaysToPayment += Math.max(
          0,
          (invoice.settledAt.getTime() - invoice.issueDate.getTime()) / DAY_MS,
        );
        settledCount++;
      }

      const currentCurrency = byCurrency[invoice.currency] || {
        total: "0.00",
        financed: "0.00",
        count: 0,
      };
      byCurrency[invoice.currency] = {
        total: new Prisma.Decimal(currentCurrency.total)
          .plus(invoice.amount)
          .toFixed(2),
        financed: new Prisma.Decimal(currentCurrency.financed)
          .plus(invoice.financedAmount)
          .toFixed(2),
        count: currentCurrency.count + 1,
      };

      if (outstanding.gt(0)) {
        const ageDays = Math.max(
          0,
          (now.getTime() - invoice.issueDate.getTime()) / DAY_MS,
        );
        const bucketIndex =
          ageDays <= 30 ? 0 : ageDays <= 60 ? 1 : ageDays <= 90 ? 2 : 3;
        agingBuckets[bucketIndex].amount = new Prisma.Decimal(
          agingBuckets[bucketIndex].amount,
        )
          .plus(outstanding)
          .toFixed(2);
        agingBuckets[bucketIndex].count++;
      }
    }

    return {
      totalReceivables: totalReceivables.toFixed(2),
      totalFinanced: totalFinanced.toFixed(2),
      totalOutstanding: totalOutstanding.toFixed(2),
      avgDaysToPayment:
        settledCount > 0
          ? Math.round((totalDaysToPayment / settledCount) * 100) / 100
          : 0,
      overdueAmount: overdueAmount.toFixed(2),
      overdueCount,
      financingUtilization: totalReceivables.gt(0)
        ? Number(
            totalFinanced.div(totalReceivables).toDecimalPlaces(6).toString(),
          )
        : 0,
      agingBuckets,
      byCurrency,
    };
  }

  private toDatabaseStatus(
    status: InvoiceStatus,
  ): PrismaInvoice["status"] | undefined {
    switch (status) {
      case "DRAFT":
        return "DRAFT";
      case "ISSUED":
        return "SUBMITTED";
      case "FINANCED":
        return "FINANCED";
      case "SETTLED":
        return "SETTLED";
      case "OVERDUE":
        return "OVERDUE";
      case "DISPUTED":
        return "DISPUTED";
      case "WRITTEN_OFF":
        return "WRITTEN_OFF";
      case "PARTIALLY_FINANCED":
        return "SUBMITTED";
      default:
        return undefined;
    }
  }

  private toInvoice(invoice: PrismaInvoice): InvoiceRecord {
    const outstanding = ["SETTLED", "WRITTEN_OFF"].includes(invoice.status)
      ? new Prisma.Decimal(0)
      : Prisma.Decimal.max(invoice.amount.minus(invoice.financedAmount), 0);
    let status: InvoiceStatus =
      invoice.status === "SUBMITTED" ? "ISSUED" : invoice.status;
    if (invoice.status === "SUBMITTED" && invoice.financedAmount.gt(0))
      status = "PARTIALLY_FINANCED";
    if (invoice.status === "DRAFT") status = "DRAFT";
    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      businessId: invoice.businessId || "",
      issuer: invoice.issuer,
      debtor: invoice.debtor,
      debtorName: invoice.debtorName,
      description: invoice.description,
      amount: invoice.amount.toString(),
      currency: invoice.currency,
      outstandingAmount: outstanding.toString(),
      financedAmount: invoice.financedAmount.toString(),
      maturityDate: invoice.dueDate,
      status,
      purchaseOrderRef: invoice.purchaseOrderRef,
      gracePeriodDays: invoice.gracePeriodDays,
      latePenaltyRate: Number(invoice.latePenaltyRate.toString()),
      discountRate:
        invoice.discountRate === null
          ? null
          : Number(invoice.discountRate.toString()),
      creditScore:
        invoice.creditScore === null ? null : Number(invoice.creditScore),
      createdAt: invoice.issueDate,
      settledAt: invoice.settledAt,
      settlementReference: invoice.settlementReference,
      metadata: jsonObject(invoice.metadata),
    };
  }

  private toFinancingRequest(
    request: PrismaFinancingRequest,
  ): FinancingRequest {
    return {
      id: request.id,
      invoiceId: request.invoiceId,
      amount: request.amount.toString(),
      discountRate:
        request.discountRate === null
          ? null
          : Number(request.discountRate.toString()),
      netProceeds: request.netProceeds?.toString() || null,
      factor: request.factor,
      term: request.termDays,
      status: request.status,
      externalReference: request.externalReference,
      createdAt: request.createdAt,
    };
  }

  private toDispute(dispute: PrismaInvoiceDispute): InvoiceDisputeRecord {
    return {
      id: dispute.id,
      invoiceId: dispute.invoiceId,
      reason: dispute.reason,
      status: dispute.status,
      raisedBy: dispute.raisedBy,
      reviewer: dispute.reviewer,
      resolution: dispute.resolution,
      createdAt: dispute.createdAt,
      resolvedAt: dispute.resolvedAt,
    };
  }
}

export class InvoiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "InvoiceError";
  }
}
