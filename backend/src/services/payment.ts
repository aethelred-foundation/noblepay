import {
  PrismaClient,
  Payment,
  PaymentStatus,
  Prisma,
  ComplianceScreening,
} from "@prisma/client";
import {
  CreatePaymentInput,
  ListPaymentsInput,
} from "../middleware/validation";
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

export interface IdempotentPaymentResult {
  payment: Payment;
  replayed: boolean;
}

export type PaymentDetailRecord = Payment & {
  screenings: ComplianceScreening[];
  travelRuleRecord: { shared: boolean; sharedAt: Date | null } | null;
};

// Fee schedule (basis points)
const FEE_SCHEDULE: Record<string, number> = {
  STANDARD: 30, // 0.30%
  PREMIUM: 15, // 0.15%
  ENTERPRISE: 5, // 0.05%
};

export class PaymentService {
  constructor(
    private prisma: PrismaClient,
    private _auditService: AuditService,
  ) {}

  /**
   * Create a new payment and generate a unique payment ID (bytes32 hash).
   */
  async createPayment(
    _input: CreatePaymentInput,
    _businessId: string,
    _idempotencyKey?: string,
  ): Promise<Payment> {
    throw new PaymentError(
      "ON_CHAIN_INITIATION_REQUIRED",
      "Database-only payment creation has been retired; reconcile a confirmed NoblePay transaction",
      410,
    );
  }

  async createPaymentWithIdempotency(
    _input: CreatePaymentInput,
    _businessId: string,
    _idempotencyKey?: string,
  ): Promise<IdempotentPaymentResult> {
    throw new PaymentError(
      "ON_CHAIN_INITIATION_REQUIRED",
      "Database-only payment creation has been retired; reconcile a confirmed NoblePay transaction",
      410,
    );
  }

  /**
   * Get a single payment by internal ID or paymentId hash.
   */
  async getPayment(
    id: string,
    businessId?: string,
  ): Promise<PaymentDetailRecord | null> {
    return this.prisma.payment.findFirst({
      where: {
        ...(id.startsWith("0x") ? { paymentId: id } : { id }),
        ...(businessId ? { businessId } : {}),
      },
      include: {
        screenings: true,
        travelRuleRecord: { select: { shared: true, sharedAt: true } },
      },
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
    const {
      page,
      limit,
      sortBy,
      sortOrder,
      status,
      sender,
      recipient,
      currency,
      minAmount,
      maxAmount,
      from,
      to,
      search,
      riskLevel,
    } = params;

    const where: Prisma.PaymentWhereInput = {};

    // Scope to the authenticated business when provided
    if (businessId) {
      where.businessId = businessId;
    }

    if (status) where.status = status as PaymentStatus;
    if (sender) where.sender = sender;
    if (recipient) where.recipient = recipient;
    if (currency) where.currency = currency;
    if (search) {
      where.OR = [
        { paymentId: { contains: search, mode: "insensitive" } },
        { sender: { contains: search, mode: "insensitive" } },
        { recipient: { contains: search, mode: "insensitive" } },
      ];
    }
    if (riskLevel) {
      const ranges: Record<string, { gte?: number; lt?: number }> = {
        Low: { gte: 0, lt: 25 },
        Medium: { gte: 25, lt: 55 },
        High: { gte: 55, lt: 80 },
        Critical: { gte: 80 },
      };
      where.riskScore = ranges[riskLevel];
    }

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
   * Validate that a business hasn't exceeded its daily/monthly limits.
   */
  async validateBusinessLimits(
    businessId: string,
    amount: string,
    _currency: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
    });

    if (!business) {
      return { allowed: false, reason: "Business not found" };
    }

    if (business.kycStatus !== "VERIFIED") {
      return {
        allowed: false,
        reason: `Business KYC status is ${business.kycStatus}`,
      };
    }

    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const startOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const incomingAmount = new Prisma.Decimal(amount);

    // Sum today's payments
    const dailyResult = await this.prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        businessId,
        initiatedAt: { gte: startOfDay },
        status: { notIn: ["CANCELLED", "REFUNDED", "REJECTED"] },
      },
    });

    const dailyTotal = new Prisma.Decimal(
      dailyResult._sum.amount?.toString() || "0",
    );

    if (
      dailyTotal
        .plus(incomingAmount)
        .greaterThan(new Prisma.Decimal(business.dailyLimit.toString()))
    ) {
      return { allowed: false, reason: "Daily payment limit exceeded" };
    }

    // Sum this month's payments
    const monthlyResult = await this.prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        businessId,
        initiatedAt: { gte: startOfMonth },
        status: { notIn: ["CANCELLED", "REFUNDED", "REJECTED"] },
      },
    });

    const monthlyTotal = new Prisma.Decimal(
      monthlyResult._sum.amount?.toString() || "0",
    );

    if (
      monthlyTotal
        .plus(incomingAmount)
        .greaterThan(new Prisma.Decimal(business.monthlyLimit.toString()))
    ) {
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
    const basisPoints = FEE_SCHEDULE[tier] || FEE_SCHEDULE.STANDARD;
    const amountDecimal = new Prisma.Decimal(amount);
    const fee = amountDecimal.mul(basisPoints).div(10_000);
    const netAmount = amountDecimal.minus(fee);

    return {
      fee: fee.toFixed(18),
      netAmount: netAmount.toFixed(18),
      basisPoints,
    };
  }

  /**
   * Process a batch of payments.
   */
  async batchProcessPayments(
    _payments: CreatePaymentInput[],
    _businessId: string,
    _idempotencyKey?: string,
  ): Promise<{
    succeeded: Payment[];
    failed: Array<{ index: number; error: string }>;
    replayed: boolean;
  }> {
    throw new PaymentError(
      "ON_CHAIN_BATCH_INITIATION_REQUIRED",
      "Database-only batch creation has been retired; reconcile confirmed NoblePay transactions",
      410,
    );
  }

  /**
   * Get dashboard statistics.
   */
  async getStats(businessId?: string): Promise<PaymentStats> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Scope all queries to the tenant's data when businessId is provided
    const scopeFilter: Prisma.PaymentWhereInput = businessId
      ? { businessId }
      : {};

    const [
      totalPayments,
      totalAgg,
      statusCounts,
      currencyAgg,
      last24hAgg,
      last7dAgg,
    ] = await Promise.all([
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
