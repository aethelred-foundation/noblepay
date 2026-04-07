import { PrismaClient, Payment, PaymentStatus, Prisma } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";
import { generateHexId } from "../lib/identifiers";
import { logger, maskIdentifier } from "../lib/logger";
import { paymentTotal, paymentAmount } from "../lib/metrics";
import { CreatePaymentInput, ListPaymentsInput } from "../middleware/validation";
import { AuditService } from "./audit";

export interface PaymentFilters {
  status?: PaymentStatus;
  sender?: string;
  recipient?: string;
  currency?: string;
  minAmount?: string;
  maxAmount?: string;
  from?: string;
  to?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface PaymentStats {
  totalPayments: number;
  totalVolume: string;
  averageAmount: string;
  byStatus: Record<string, number>;
  byCurrency: Record<string, { count: number; volume: string }>;
  last24h: { count: number; volume: string };
  last7d: { count: number; volume: string };
}

// Fee schedule (basis points)
const FEE_SCHEDULE: Record<string, number> = {
  STARTER: 50,      // 0.50%
  STANDARD: 30,     // 0.30%
  ENTERPRISE: 15,   // 0.15%
  INSTITUTIONAL: 5, // 0.05%
};

const MAX_BATCH_PAYMENTS = 100;

export class PaymentService {
  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
  ) {}

  /**
   * Create a new payment and generate a unique payment ID (bytes32 hash).
   */
  async createPayment(
    input: CreatePaymentInput,
    businessId: string,
  ): Promise<Payment> {
    const nonce = uuidv4();
    const paymentId = generateHexId();

    const payment = await this.prisma.payment.create({
      data: {
        paymentId,
        sender: input.sender,
        recipient: input.recipient,
        amount: new Prisma.Decimal(input.amount),
        currency: input.currency,
        purposeHash: input.purposeHash || null,
        status: "PENDING",
        businessId,
      },
    });

    // Record metrics
    paymentTotal.inc({ status: "PENDING", currency: input.currency });
    paymentAmount.observe({ currency: input.currency }, parseFloat(input.amount));

    // Audit log
    await this.auditService.createAuditEntry({
      eventType: "PAYMENT_CREATED",
      actor: input.sender,
      description: `Payment ${paymentId} created: ${input.amount} ${input.currency} from ${input.sender} to ${input.recipient}`,
      severity: "INFO",
      metadata: {
        paymentId,
        amount: input.amount,
        currency: input.currency,
        businessId,
      },
    });

    logger.info("Payment created", {
      paymentId,
      sender: input.sender,
      recipient: input.recipient,
      amount: input.amount,
      currency: input.currency,
    });

    return payment;
  }

  /**
   * Get a single payment by internal ID or paymentId hash.
   */
  async getPayment(id: string): Promise<Payment | null> {
    // Try UUID first, then paymentId hash
    if (id.startsWith("0x")) {
      return this.prisma.payment.findUnique({
        where: { paymentId: id },
        include: { screenings: true, travelRuleRecord: true },
      });
    }

    return this.prisma.payment.findUnique({
      where: { id },
      include: { screenings: true, travelRuleRecord: true },
    });
  }

  /**
   * List payments with filtering and pagination.
   * When businessId is provided, results are scoped to that business.
   */
  async listPayments(
    params: ListPaymentsInput,
    businessId?: string,
  ): Promise<PaginatedResult<Payment>> {
    const { page, limit, sortBy, sortOrder, status, sender, recipient, currency, minAmount, maxAmount, from, to } = params;

    const where: Prisma.PaymentWhereInput = {};

    // Scope to the authenticated business when provided
    if (businessId) {
      where.businessId = businessId;
    }

    if (status) where.status = status as PaymentStatus;
    if (sender) where.sender = sender;
    if (recipient) where.recipient = recipient;
    if (currency) where.currency = currency;

    if (minAmount || maxAmount) {
      where.amount = {};
      if (minAmount) where.amount.gte = new Prisma.Decimal(minAmount);
      if (maxAmount) where.amount.lte = new Prisma.Decimal(maxAmount);
    }

    if (from || to) {
      where.initiatedAt = {};
      if (from) where.initiatedAt.gte = new Date(from);
      if (to) where.initiatedAt.lte = new Date(to);
    }

    const orderBy: Prisma.PaymentOrderByWithRelationInput = {};
    if (sortBy && sortBy in orderBy) {
      (orderBy as Record<string, string>)[sortBy] = sortOrder;
    } else {
      orderBy.initiatedAt = sortOrder;
    }

    const [data, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Cancel a pending payment.
   * The actor parameter is the businessId of the requesting business.
   */
  async cancelPayment(id: string, actor: string): Promise<Payment> {
    const payment = await this.getPayment(id);

    if (!payment) {
      throw new PaymentError("PAYMENT_NOT_FOUND", "Payment not found", 404);
    }

    // Verify the payment belongs to the requesting business
    if (payment.businessId && payment.businessId !== actor) {
      throw new PaymentError("FORBIDDEN", "You do not have permission to cancel this payment", 403);
    }

    if (payment.status !== "PENDING" && payment.status !== "SCREENING") {
      throw new PaymentError(
        "INVALID_STATE",
        `Cannot cancel payment in ${payment.status} status`,
        409,
      );
    }

    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: { status: "CANCELLED" },
    });

    paymentTotal.inc({ status: "CANCELLED", currency: payment.currency });

    await this.auditService.createAuditEntry({
      eventType: "PAYMENT_CANCELLED",
      actor,
      description: `Payment ${payment.paymentId} cancelled`,
      severity: "LOW",
      metadata: { paymentId: payment.paymentId },
    });

    logger.info("Payment cancelled", {
      paymentRef: maskIdentifier(payment.paymentId),
      actorRef: maskIdentifier(actor),
    });

    return updated;
  }

  /**
   * Refund a settled payment.
   * The actor parameter is the businessId of the requesting business.
   */
  async refundPayment(id: string, actor: string): Promise<Payment> {
    const payment = await this.getPayment(id);

    if (!payment) {
      throw new PaymentError("PAYMENT_NOT_FOUND", "Payment not found", 404);
    }

    // Verify the payment belongs to the requesting business
    if (payment.businessId && payment.businessId !== actor) {
      throw new PaymentError("FORBIDDEN", "You do not have permission to refund this payment", 403);
    }

    if (payment.status !== "SETTLED") {
      throw new PaymentError(
        "INVALID_STATE",
        `Cannot refund payment in ${payment.status} status. Only SETTLED payments can be refunded.`,
        409,
      );
    }

    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "REFUNDED",
        refundedAt: new Date(),
      },
    });

    paymentTotal.inc({ status: "REFUNDED", currency: payment.currency });

    await this.auditService.createAuditEntry({
      eventType: "PAYMENT_REFUNDED",
      actor,
      description: `Payment ${payment.paymentId} refunded: ${payment.amount} ${payment.currency}`,
      severity: "MEDIUM",
      metadata: { paymentId: payment.paymentId, amount: payment.amount.toString() },
    });

    logger.info("Payment refunded", {
      paymentRef: maskIdentifier(payment.paymentId),
      actorRef: maskIdentifier(actor),
    });

    return updated;
  }

  /**
   * Validate that a business hasn't exceeded its daily/monthly limits.
   */
  async validateBusinessLimits(
    businessId: string,
    amount: string,
    currency: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business) {
      return { allowed: false, reason: "Business not found" };
    }

    if (business.kycStatus !== "VERIFIED") {
      return { allowed: false, reason: `Business KYC status is ${business.kycStatus}` };
    }

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Sum today's payments
    const dailyResult = await this.prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        sender: business.address,
        initiatedAt: { gte: startOfDay },
        status: { notIn: ["CANCELLED", "REFUNDED", "REJECTED"] },
      },
    });

    const dailyTotal = dailyResult._sum.amount
      ? parseFloat(dailyResult._sum.amount.toString())
      : 0;

    if (dailyTotal + parseFloat(amount) > parseFloat(business.dailyLimit.toString())) {
      return { allowed: false, reason: "Daily payment limit exceeded" };
    }

    // Sum this month's payments
    const monthlyResult = await this.prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        sender: business.address,
        initiatedAt: { gte: startOfMonth },
        status: { notIn: ["CANCELLED", "REFUNDED", "REJECTED"] },
      },
    });

    const monthlyTotal = monthlyResult._sum.amount
      ? parseFloat(monthlyResult._sum.amount.toString())
      : 0;

    if (monthlyTotal + parseFloat(amount) > parseFloat(business.monthlyLimit.toString())) {
      return { allowed: false, reason: "Monthly payment limit exceeded" };
    }

    return { allowed: true };
  }

  /**
   * Calculate fees for a payment based on business tier.
   */
  calculateFees(
    amount: string,
    tier: string,
  ): { fee: string; netAmount: string; basisPoints: number } {
    const basisPoints = FEE_SCHEDULE[tier] || FEE_SCHEDULE.STARTER;
    const amountNum = parseFloat(amount);
    const feeNum = amountNum * (basisPoints / 10000);
    const netAmount = amountNum - feeNum;

    return {
      fee: feeNum.toFixed(18),
      netAmount: netAmount.toFixed(18),
      basisPoints,
    };
  }

  /**
   * Process a batch of payments.
   */
  async batchProcessPayments(
    payments: CreatePaymentInput[],
    businessId: string,
  ): Promise<{ succeeded: Payment[]; failed: Array<{ index: number; error: string }> }> {
    if (payments.length > MAX_BATCH_PAYMENTS) {
      throw new PaymentError(
        "BATCH_TOO_LARGE",
        `Batch payment processing is limited to ${MAX_BATCH_PAYMENTS} payments per request`,
        400,
      );
    }

    const succeeded: Payment[] = [];
    const failed: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < payments.length; i++) {
      try {
        const payment = await this.createPayment(payments[i], businessId);
        succeeded.push(payment);
      } catch (error) {
        failed.push({
          index: i,
          error: (error as Error).message,
        });
      }
    }

    logger.info("Batch payment processing complete", {
      total: payments.length,
      succeeded: succeeded.length,
      failed: failed.length,
      businessRef: maskIdentifier(businessId),
    });

    return { succeeded, failed };
  }

  /**
   * Get dashboard statistics.
   */
  async getStats(businessId?: string): Promise<PaymentStats> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Scope all queries to the tenant's data when businessId is provided
    const scopeFilter: Prisma.PaymentWhereInput = businessId ? { businessId } : {};

    const [totalPayments, totalAgg, statusCounts, currencyAgg, last24hAgg, last7dAgg] =
      await Promise.all([
        this.prisma.payment.count({ where: scopeFilter }),
        this.prisma.payment.aggregate({
          _sum: { amount: true },
          _avg: { amount: true },
          where: scopeFilter,
        }),
        this.prisma.payment.groupBy({
          by: ["status"],
          _count: { id: true },
          where: scopeFilter,
        }),
        this.prisma.payment.groupBy({
          by: ["currency"],
          _count: { id: true },
          _sum: { amount: true },
          where: scopeFilter,
        }),
        this.prisma.payment.aggregate({
          _count: { id: true },
          _sum: { amount: true },
          where: { ...scopeFilter, initiatedAt: { gte: last24h } },
        }),
        this.prisma.payment.aggregate({
          _count: { id: true },
          _sum: { amount: true },
          where: { ...scopeFilter, initiatedAt: { gte: last7d } },
        }),
      ]);

    const byStatus: Record<string, number> = {};
    for (const s of statusCounts) {
      byStatus[s.status] = s._count.id;
    }

    const byCurrency: Record<string, { count: number; volume: string }> = {};
    for (const c of currencyAgg) {
      byCurrency[c.currency] = {
        count: c._count.id,
        volume: c._sum.amount?.toString() || "0",
      };
    }

    return {
      totalPayments,
      totalVolume: totalAgg._sum.amount?.toString() || "0",
      averageAmount: totalAgg._avg.amount?.toString() || "0",
      byStatus,
      byCurrency,
      last24h: {
        count: last24hAgg._count.id,
        volume: last24hAgg._sum.amount?.toString() || "0",
      },
      last7d: {
        count: last7dAgg._count.id,
        volume: last7dAgg._sum.amount?.toString() || "0",
      },
    };
  }
}

// ─── Error Class ────────────────────────────────────────────────────────────

export class PaymentError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}
