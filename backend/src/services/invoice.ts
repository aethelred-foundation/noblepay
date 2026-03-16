import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { AuditService } from "./audit";

// ─── Types ──────────────────────────────────────────────────────────────────

export type InvoiceStatus = "DRAFT" | "ISSUED" | "FINANCED" | "PARTIALLY_FINANCED" | "SETTLED" | "OVERDUE" | "DISPUTED" | "CANCELLED";
export type DisputeStatus = "OPEN" | "UNDER_REVIEW" | "RESOLVED" | "ESCALATED";

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
  businessId: string;
  issuer: string;
  debtor: string;
  debtorName: string;
  amount: string;
  currency: string;
  outstandingAmount: string;
  financedAmount: string;
  maturityDate: Date;
  status: InvoiceStatus;
  purchaseOrderRef: string | null;
  gracePeriodDays: number;
  latePenaltyRate: number;
  discountRate: number;
  creditScore: number;
  createdAt: Date;
  settledAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface FinancingRequest {
  invoiceId: string;
  amount: string;
  discountRate: number;
  netProceeds: string;
  factor: string;
  term: number;
  status: "PENDING" | "APPROVED" | "FUNDED" | "REPAID" | "DEFAULTED";
  createdAt: Date;
}

export interface CreditScoreRecord {
  businessId: string;
  score: number;
  grade: "AAA" | "AA" | "A" | "BBB" | "BB" | "B" | "CCC" | "D";
  factors: Array<{ name: string; impact: number; description: string }>;
  history: Array<{ date: string; score: number }>;
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
  byCurrency: Record<string, { total: string; financed: string; count: number }>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CREDIT_SCORE_GRADES: Record<string, { min: number; max: number }> = {
  AAA: { min: 850, max: 1000 },
  AA: { min: 750, max: 849 },
  A: { min: 650, max: 749 },
  BBB: { min: 550, max: 649 },
  BB: { min: 450, max: 549 },
  B: { min: 350, max: 449 },
  CCC: { min: 200, max: 349 },
  D: { min: 0, max: 199 },
};

const BASE_DISCOUNT_RATES: Record<string, number> = {
  AAA: 0.02, AA: 0.03, A: 0.04, BBB: 0.06, BB: 0.09, B: 0.12, CCC: 0.18, D: 0.30,
};

// ─── Service ────────────────────────────────────────────────────────────────

export class InvoiceService {
  private invoices: Map<string, InvoiceRecord> = new Map();
  private financingRequests: Map<string, FinancingRequest[]> = new Map();
  private creditScores: Map<string, CreditScoreRecord> = new Map();

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
  ) {}

  /**
   * Create a new invoice.
   */
  async createInvoice(
    input: CreateInvoiceInput,
    issuer: string,
    businessId: string,
  ): Promise<InvoiceRecord> {
    const invoiceId =
      "inv-" +
      crypto
        .createHash("sha256")
        .update(`${issuer}:${input.debtor}:${input.amount}:${Date.now()}`)
        .digest("hex")
        .slice(0, 16);

    const creditScore = this.getCreditScore(input.debtor);
    const discountRate = this.calculateDiscountRate(creditScore.score, input.maturityDate);

    const invoice: InvoiceRecord = {
      id: invoiceId,
      businessId,
      issuer,
      debtor: input.debtor,
      debtorName: input.debtorName,
      amount: input.amount,
      currency: input.currency,
      outstandingAmount: input.amount,
      financedAmount: "0",
      maturityDate: new Date(input.maturityDate),
      status: "ISSUED",
      purchaseOrderRef: input.purchaseOrderRef || null,
      gracePeriodDays: input.gracePeriodDays || 30,
      latePenaltyRate: input.latePenaltyRate || 0.015,
      discountRate,
      creditScore: creditScore.score,
      createdAt: new Date(),
      settledAt: null,
      metadata: input.metadata || {},
    };

    this.invoices.set(invoiceId, invoice);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: issuer,
      description: `Invoice created: ${input.amount} ${input.currency} from ${input.debtorName}, due ${input.maturityDate}`,
      severity: "INFO",
      metadata: { invoiceId, amount: input.amount, debtor: input.debtor },
    });

    logger.info("Invoice created", {
      invoiceId,
      issuer,
      debtor: input.debtor,
      amount: input.amount,
      maturityDate: input.maturityDate,
      discountRate,
    });

    return invoice;
  }

  /**
   * Get a single invoice by ID.
   */
  getInvoice(invoiceId: string): InvoiceRecord | undefined {
    return this.invoices.get(invoiceId);
  }

  /**
   * Request financing for an invoice (factoring).
   */
  async requestFinancing(
    invoiceId: string,
    amount: string,
    factor: string,
    businessId?: string,
  ): Promise<FinancingRequest> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      throw new InvoiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
    }
    if (businessId && invoice.businessId !== businessId) {
      throw new InvoiceError("FORBIDDEN", "You do not have permission to finance this invoice", 403);
    }
    if (invoice.status === "SETTLED" || invoice.status === "CANCELLED") {
      throw new InvoiceError("INVALID_STATE", `Cannot finance ${invoice.status} invoice`, 409);
    }

    const requestedAmount = parseFloat(amount);
    const maxFinanceable = parseFloat(invoice.outstandingAmount);
    if (requestedAmount > maxFinanceable) {
      throw new InvoiceError("EXCEEDS_OUTSTANDING", `Requested ${amount} exceeds outstanding ${invoice.outstandingAmount}`);
    }

    // Calculate net proceeds after discount
    const daysToMaturity = Math.max(0, Math.ceil(
      (invoice.maturityDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    ));
    const annualizedDiscount = invoice.discountRate;
    const periodDiscount = annualizedDiscount * (daysToMaturity / 365);
    const netProceeds = (requestedAmount * (1 - periodDiscount)).toFixed(2);

    const request: FinancingRequest = {
      invoiceId,
      amount,
      discountRate: annualizedDiscount,
      netProceeds,
      factor,
      term: daysToMaturity,
      status: "FUNDED",
      createdAt: new Date(),
    };

    // Update invoice
    invoice.financedAmount = (parseFloat(invoice.financedAmount) + requestedAmount).toFixed(2);
    invoice.outstandingAmount = (parseFloat(invoice.outstandingAmount) - requestedAmount).toFixed(2);
    invoice.status = parseFloat(invoice.outstandingAmount) <= 0 ? "FINANCED" : "PARTIALLY_FINANCED";
    this.invoices.set(invoiceId, invoice);

    const requests = this.financingRequests.get(invoiceId) || [];
    requests.push(request);
    this.financingRequests.set(invoiceId, requests);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: factor,
      description: `Invoice ${invoiceId} financed: ${amount} at ${(annualizedDiscount * 100).toFixed(2)}% discount. Net proceeds: ${netProceeds}`,
      severity: "MEDIUM",
      metadata: { invoiceId, amount, discountRate: annualizedDiscount, netProceeds },
    });

    logger.info("Invoice financing funded", {
      invoiceId,
      amount,
      discountRate: annualizedDiscount,
      netProceeds,
      daysToMaturity,
    });

    return request;
  }

  /**
   * Settle an invoice (mark as paid).
   */
  async settleInvoice(invoiceId: string, actor: string, businessId?: string): Promise<InvoiceRecord> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      throw new InvoiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
    }
    if (businessId && invoice.businessId !== businessId) {
      throw new InvoiceError("FORBIDDEN", "You do not have permission to settle this invoice", 403);
    }

    invoice.status = "SETTLED";
    invoice.settledAt = new Date();
    invoice.outstandingAmount = "0";
    this.invoices.set(invoiceId, invoice);

    // Update financing requests
    const requests = this.financingRequests.get(invoiceId) || [];
    for (const req of requests) {
      if (req.status === "FUNDED") req.status = "REPAID";
    }

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `Invoice ${invoiceId} settled: ${invoice.amount} ${invoice.currency}`,
      severity: "INFO",
      metadata: { invoiceId },
    });

    logger.info("Invoice settled", { invoiceId, actor });
    return invoice;
  }

  /**
   * Raise a dispute on an invoice.
   */
  async raiseDispute(
    invoiceId: string,
    reason: string,
    actor: string,
    businessId?: string,
  ): Promise<{ invoiceId: string; disputeId: string; status: DisputeStatus }> {
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) {
      throw new InvoiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
    }
    if (businessId && invoice.businessId !== businessId) {
      throw new InvoiceError("FORBIDDEN", "You do not have permission to dispute this invoice", 403);
    }

    invoice.status = "DISPUTED";
    this.invoices.set(invoiceId, invoice);

    const disputeId = "disp-" + crypto.randomBytes(8).toString("hex");

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `Dispute raised on invoice ${invoiceId}: ${reason}`,
      severity: "HIGH",
      metadata: { invoiceId, disputeId, reason },
    });

    logger.info("Invoice dispute raised", { invoiceId, disputeId, reason });
    return { invoiceId, disputeId, status: "OPEN" as DisputeStatus };
  }

  /**
   * List invoices with filters.
   */
  listInvoices(filters?: {
    issuer?: string;
    debtor?: string;
    status?: InvoiceStatus;
    currency?: string;
    businessId?: string;
  }): InvoiceRecord[] {
    let invoices = Array.from(this.invoices.values());

    if (filters?.businessId) invoices = invoices.filter((i) => i.businessId === filters.businessId);
    if (filters?.issuer) invoices = invoices.filter((i) => i.issuer === filters.issuer);
    if (filters?.debtor) invoices = invoices.filter((i) => i.debtor === filters.debtor);
    if (filters?.status) invoices = invoices.filter((i) => i.status === filters.status);
    if (filters?.currency) invoices = invoices.filter((i) => i.currency === filters.currency);

    return invoices.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Get or generate credit score for a business.
   */
  getCreditScore(businessId: string): CreditScoreRecord {
    if (this.creditScores.has(businessId)) {
      return this.creditScores.get(businessId)!;
    }

    // Generate a realistic credit score
    const score = 600 + Math.floor(Math.random() * 300);
    const grade = Object.entries(CREDIT_SCORE_GRADES).find(
      ([, range]) => score >= range.min && score <= range.max,
    )?.[0] as CreditScoreRecord["grade"] || "BBB";

    const record: CreditScoreRecord = {
      businessId,
      score,
      grade,
      factors: [
        { name: "Payment History", impact: 35, description: score > 700 ? "Excellent payment track record" : "Some late payments observed" },
        { name: "Credit Utilization", impact: 25, description: "Moderate credit line utilization" },
        { name: "Account Age", impact: 15, description: "Established business history" },
        { name: "Transaction Volume", impact: 15, description: "Consistent transaction patterns" },
        { name: "Industry Risk", impact: 10, description: "Standard industry risk profile" },
      ],
      history: Array.from({ length: 12 }, (_, i) => ({
        date: new Date(Date.now() - (11 - i) * 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        score: score + Math.floor((Math.random() - 0.5) * 40),
      })),
      lastUpdated: new Date(),
    };

    this.creditScores.set(businessId, record);
    return record;
  }

  /**
   * Calculate dynamic discount rate based on credit score and maturity.
   */
  private calculateDiscountRate(creditScore: number, maturityDate: string): number {
    const grade = Object.entries(CREDIT_SCORE_GRADES).find(
      ([, range]) => creditScore >= range.min && creditScore <= range.max,
    )?.[0] || "BBB";

    const baseRate = BASE_DISCOUNT_RATES[grade] || 0.06;
    const daysToMaturity = Math.max(0,
      (new Date(maturityDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000),
    );

    // Longer maturity = higher discount
    const maturityAdj = daysToMaturity > 90 ? 0.01 : daysToMaturity > 180 ? 0.02 : 0;
    return Math.round((baseRate + maturityAdj) * 10000) / 10000;
  }

  /**
   * Get invoice analytics.
   */
  getAnalytics(businessId?: string): InvoiceAnalytics {
    let invoices = Array.from(this.invoices.values());
    if (businessId) {
      invoices = invoices.filter((i) => i.businessId === businessId);
    }
    const now = new Date();

    let totalReceivables = 0;
    let totalFinanced = 0;
    let totalOutstanding = 0;
    let overdueAmount = 0;
    let overdueCount = 0;
    let totalDaysToPayment = 0;
    let settledCount = 0;

    const byCurrency: Record<string, { total: string; financed: string; count: number }> = {};

    for (const inv of invoices) {
      totalReceivables += parseFloat(inv.amount);
      totalFinanced += parseFloat(inv.financedAmount);
      totalOutstanding += parseFloat(inv.outstandingAmount);

      if (inv.maturityDate < now && inv.status !== "SETTLED" && inv.status !== "CANCELLED") {
        overdueAmount += parseFloat(inv.outstandingAmount);
        overdueCount++;
      }

      if (inv.settledAt) {
        totalDaysToPayment += (inv.settledAt.getTime() - inv.createdAt.getTime()) / (24 * 60 * 60 * 1000);
        settledCount++;
      }

      if (!byCurrency[inv.currency]) {
        byCurrency[inv.currency] = { total: "0", financed: "0", count: 0 };
      }
      byCurrency[inv.currency].total = (parseFloat(byCurrency[inv.currency].total) + parseFloat(inv.amount)).toFixed(2);
      byCurrency[inv.currency].financed = (parseFloat(byCurrency[inv.currency].financed) + parseFloat(inv.financedAmount)).toFixed(2);
      byCurrency[inv.currency].count++;
    }

    const agingBuckets = [
      { range: "0-30 days", amount: "0", count: 0 },
      { range: "31-60 days", amount: "0", count: 0 },
      { range: "61-90 days", amount: "0", count: 0 },
      { range: "90+ days", amount: "0", count: 0 },
    ];

    for (const inv of invoices.filter((i) => i.status !== "SETTLED" && i.status !== "CANCELLED")) {
      const age = (now.getTime() - inv.createdAt.getTime()) / (24 * 60 * 60 * 1000);
      const bucket = age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3;
      agingBuckets[bucket].amount = (parseFloat(agingBuckets[bucket].amount) + parseFloat(inv.outstandingAmount)).toFixed(2);
      agingBuckets[bucket].count++;
    }

    return {
      totalReceivables: totalReceivables.toFixed(2),
      totalFinanced: totalFinanced.toFixed(2),
      totalOutstanding: totalOutstanding.toFixed(2),
      avgDaysToPayment: settledCount > 0 ? Math.round(totalDaysToPayment / settledCount) : 0,
      overdueAmount: overdueAmount.toFixed(2),
      overdueCount,
      financingUtilization: totalReceivables > 0 ? totalFinanced / totalReceivables : 0,
      agingBuckets,
      byCurrency,
    };
  }
}

// ─── Error Class ────────────────────────────────────────────────────────────

export class InvoiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "InvoiceError";
  }
}
