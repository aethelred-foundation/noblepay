import { Prisma, PrismaClient, type PaymentStream } from "@prisma/client";
import { AuditService } from "./audit";

export type StreamStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";

export interface CreateStreamInput {
  sender: string;
  recipient: string;
  totalAmount: string;
  currency: string;
  startTime?: string;
  endTime: string;
  cliffDuration?: number;
  ratePerSecond?: string;
  autoCompound?: boolean;
  metadata?: Record<string, unknown>;
}

export interface BatchStreamInput {
  businessId: string;
  streams: CreateStreamInput[];
  label?: string;
}

export interface StreamBalance {
  streamId: string;
  withdrawable: string;
  streamed: string;
  remaining: string;
  percentComplete: number;
  elapsedSeconds: number;
  totalSeconds: number;
  calculatedAt: Date;
  dataSource: "DATABASE_TERMS";
}

export interface StreamRecord {
  id: string;
  streamId: string;
  businessId: string;
  sender: string;
  recipient: string;
  totalAmount: string;
  streamedAmount: string;
  withdrawnAmount: string;
  currency: string;
  ratePerSecond: string;
  startTime: Date;
  endTime: Date;
  cliffEnd: Date | null;
  status: StreamStatus;
  autoCompound: null;
  lastWithdrawAt: null;
  createdAt: Date;
  metadata: Record<string, never>;
  dataSource: "DATABASE_TERMS";
}

export interface StreamAnalytics {
  totalActiveStreams: number;
  totalStreamedVolume: string;
  totalWithdrawn: string;
  dailyOutflow: string;
  weeklyOutflow: string;
  monthlyOutflow: string;
  byCurrency: Record<string, { count: number; volume: string }>;
  upcomingMilestones: Array<{
    streamId: string;
    event: string;
    date: Date;
  }>;
  calculatedAt: Date;
  dataSource: "DATABASE_TERMS";
}

interface StreamFilters {
  sender?: string;
  recipient?: string;
  status?: StreamStatus;
  currency?: string;
  businessId: string;
  page?: number;
  limit?: number;
}

function effectiveTime(stream: PaymentStream, now: Date): Date {
  if (stream.status === "PAUSED" && stream.pausedAt) return stream.pausedAt;
  if (stream.status === "CANCELLED" && stream.pausedAt) return stream.pausedAt;
  return now < stream.endTime ? now : stream.endTime;
}

function calculateBalance(
  stream: PaymentStream,
  now = new Date(),
): StreamBalance {
  const totalSeconds = Math.max(
    0,
    Math.floor((stream.endTime.getTime() - stream.startTime.getTime()) / 1000),
  );
  const effective = effectiveTime(stream, now);
  const elapsedSeconds = Math.max(
    0,
    Math.min(
      totalSeconds,
      Math.floor((effective.getTime() - stream.startTime.getTime()) / 1000),
    ),
  );
  const streamed = Prisma.Decimal.min(
    stream.totalAmount,
    stream.ratePerSecond.mul(elapsedSeconds),
  );
  const remaining = Prisma.Decimal.max(
    new Prisma.Decimal(0),
    stream.totalAmount.minus(streamed),
  );
  const cliffActive = Boolean(stream.cliffEnd && now < stream.cliffEnd);
  const withdrawable = cliffActive
    ? new Prisma.Decimal(0)
    : Prisma.Decimal.max(
        new Prisma.Decimal(0),
        streamed.minus(stream.withdrawn),
      );

  return {
    streamId: stream.id,
    withdrawable: withdrawable.toString(),
    streamed: streamed.toString(),
    remaining: remaining.toString(),
    percentComplete:
      totalSeconds > 0
        ? Math.min(100, (elapsedSeconds / totalSeconds) * 100)
        : 0,
    elapsedSeconds,
    totalSeconds,
    calculatedAt: now,
    dataSource: "DATABASE_TERMS",
  };
}

function streamRecord(
  stream: PaymentStream,
  businessId: string,
  now = new Date(),
): StreamRecord {
  const balance = calculateBalance(stream, now);
  return {
    id: stream.id,
    streamId: stream.id,
    businessId,
    sender: stream.sender,
    recipient: stream.recipient,
    totalAmount: stream.totalAmount.toString(),
    streamedAmount: balance.streamed,
    withdrawnAmount: stream.withdrawn.toString(),
    currency: stream.currency,
    ratePerSecond: stream.ratePerSecond.toString(),
    startTime: stream.startTime,
    endTime: stream.endTime,
    cliffEnd: stream.cliffEnd,
    status: stream.status,
    autoCompound: null,
    lastWithdrawAt: null,
    createdAt: stream.createdAt,
    metadata: {},
    dataSource: "DATABASE_TERMS",
  };
}

/**
 * Durable, tenant-scoped stream reads. Contract-changing operations are
 * intentionally disabled until a transaction receipt verifier is available.
 */
export class StreamingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly _auditService: AuditService,
  ) {}

  async createStream(
    _input: CreateStreamInput,
    _businessId: string,
  ): Promise<never> {
    throw this.settlementUnavailable();
  }

  async createBatchStreams(_input: BatchStreamInput): Promise<never> {
    throw this.settlementUnavailable();
  }

  async getStreamBalance(
    streamId: string,
    businessId: string,
  ): Promise<StreamBalance> {
    const stream = await this.findTenantStream(streamId, businessId);
    return calculateBalance(stream);
  }

  async getStream(streamId: string, businessId: string): Promise<StreamRecord> {
    return streamRecord(
      await this.findTenantStream(streamId, businessId),
      businessId,
    );
  }

  async pauseStream(
    _streamId: string,
    _actor: string,
    _businessId?: string,
  ): Promise<never> {
    throw this.settlementUnavailable();
  }

  async resumeStream(
    _streamId: string,
    _actor: string,
    _businessId?: string,
  ): Promise<never> {
    throw this.settlementUnavailable();
  }

  async cancelStream(
    _streamId: string,
    _actor: string,
    _businessId?: string,
  ): Promise<never> {
    throw this.settlementUnavailable();
  }

  async adjustRate(
    _streamId: string,
    _newRatePerSecond: string,
    _actor: string,
    _businessId?: string,
  ): Promise<never> {
    throw this.settlementUnavailable();
  }

  async listStreams(filters: StreamFilters): Promise<StreamRecord[]> {
    const wallet = await this.businessWallet(filters.businessId);
    const streams = await this.prisma.paymentStream.findMany({
      where: {
        AND: [
          {
            OR: [
              { sender: { equals: wallet, mode: "insensitive" } },
              { recipient: { equals: wallet, mode: "insensitive" } },
            ],
          },
          filters.sender
            ? { sender: { equals: filters.sender, mode: "insensitive" } }
            : {},
          filters.recipient
            ? {
                recipient: {
                  equals: filters.recipient,
                  mode: "insensitive",
                },
              }
            : {},
          filters.status ? { status: filters.status } : {},
          filters.currency ? { currency: filters.currency } : {},
        ],
      },
      orderBy: { createdAt: "desc" },
      skip:
        filters.page && filters.limit
          ? (filters.page - 1) * filters.limit
          : undefined,
      take: filters.limit,
    });
    const now = new Date();
    return streams.map((stream) =>
      streamRecord(stream, filters.businessId, now),
    );
  }

  async getAnalytics(businessId: string): Promise<StreamAnalytics> {
    const streams = await this.listStreams({ businessId });
    const activeStreams = streams.filter(
      (stream) => stream.status === "ACTIVE",
    );
    const now = new Date();
    const byCurrency: StreamAnalytics["byCurrency"] = {};
    let totalStreamed = new Prisma.Decimal(0);
    let totalWithdrawn = new Prisma.Decimal(0);
    let dailyOutflow = new Prisma.Decimal(0);

    for (const stream of streams) {
      totalStreamed = totalStreamed.add(stream.streamedAmount);
      totalWithdrawn = totalWithdrawn.add(stream.withdrawnAmount);
      const existing = byCurrency[stream.currency] ?? {
        count: 0,
        volume: "0",
      };
      existing.count += 1;
      existing.volume = new Prisma.Decimal(existing.volume)
        .add(stream.totalAmount)
        .toString();
      byCurrency[stream.currency] = existing;
    }
    for (const stream of activeStreams) {
      dailyOutflow = dailyOutflow.add(
        new Prisma.Decimal(stream.ratePerSecond).mul(86_400),
      );
    }

    return {
      totalActiveStreams: activeStreams.length,
      totalStreamedVolume: totalStreamed.toString(),
      totalWithdrawn: totalWithdrawn.toString(),
      dailyOutflow: dailyOutflow.toString(),
      weeklyOutflow: dailyOutflow.mul(7).toString(),
      monthlyOutflow: dailyOutflow.mul(30).toString(),
      byCurrency,
      upcomingMilestones: activeStreams
        .filter((stream) => stream.cliffEnd && stream.cliffEnd > now)
        .map((stream) => ({
          streamId: stream.streamId,
          event: "cliff_end",
          date: stream.cliffEnd as Date,
        }))
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .slice(0, 10),
      calculatedAt: now,
      dataSource: "DATABASE_TERMS",
    };
  }

  private async businessWallet(businessId: string): Promise<string> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { address: true },
    });
    if (!business) {
      throw new StreamError(
        "BUSINESS_NOT_FOUND",
        "Authenticated business was not found",
        404,
      );
    }
    return business.address;
  }

  private async findTenantStream(
    streamId: string,
    businessId: string,
  ): Promise<PaymentStream> {
    const wallet = await this.businessWallet(businessId);
    const stream = await this.prisma.paymentStream.findFirst({
      where: {
        id: streamId,
        OR: [
          { sender: { equals: wallet, mode: "insensitive" } },
          { recipient: { equals: wallet, mode: "insensitive" } },
        ],
      },
    });
    if (!stream) {
      throw new StreamError("STREAM_NOT_FOUND", "Stream not found", 404);
    }
    return stream;
  }

  private settlementUnavailable(): StreamError {
    return new StreamError(
      "ONCHAIN_SETTLEMENT_UNAVAILABLE",
      "Stream changes are disabled until the streaming contract transaction and receipt verifier are configured",
      501,
    );
  }
}

export class StreamError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "StreamError";
  }
}
