import { Prisma, PrismaClient, type PaymentStream } from "@prisma/client";
import { AuditService } from "./audit";
import {
  verifyStreamCreation,
  verifyStreamTransition,
  verifyWithdrawal,
  type StreamEventKind,
} from "./streaming-execution";
import type { NoblePayChainConfiguration } from "../lib/production-config";

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
  // Pause time is excluded from BOTH figures, exactly as the contract does it
  // (StreamingPayments._effectiveElapsed and the totalDuration it compares
  // against). Subtracting it from only one — or from neither, as this did
  // before — makes the API report a stream as further along than the contract
  // will pay out. See docs/audit/NP-STREAM-01.
  const pausedSeconds = Math.max(0, stream.totalPausedSeconds ?? 0);
  const totalSeconds = Math.max(
    0,
    Math.floor(
      (stream.endTime.getTime() - stream.startTime.getTime()) / 1000,
    ) - pausedSeconds,
  );
  const effective = effectiveTime(stream, now);
  const rawElapsed = Math.floor(
    (effective.getTime() - stream.startTime.getTime()) / 1000,
  );
  const elapsedSeconds = Math.max(
    0,
    Math.min(totalSeconds, rawElapsed - pausedSeconds),
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
    private readonly auditService: AuditService,
  ) {}

  /**
   * Record a stream that has already been created on chain.
   *
   * The rate, amounts and timestamps come from the receipt rather than the
   * request, because they are what the contract will actually pay against. A
   * record built from the request could differ from the escrow it describes.
   */
  async createStream(
    input: CreateStreamInput,
    businessId: string,
    creation: { txHash: string; onChainStreamId: string },
    config: NoblePayChainConfiguration,
  ): Promise<StreamRecord> {
    const wallet = await this.businessWallet(businessId);

    const existing = await this.prisma.paymentStream.findFirst({
      where: { onChainStreamId: creation.onChainStreamId.toLowerCase() },
    });
    if (existing) {
      if (existing.createTxHash === creation.txHash.toLowerCase()) {
        return streamRecord(existing, businessId);
      }
      throw new StreamError(
        "STREAM_ALREADY_RECORDED",
        `This on-chain stream is already recorded under ${existing.createTxHash ?? "an unrecorded transaction"}`,
        409,
      );
    }

    const verified = await verifyStreamCreation(config, {
      txHash: creation.txHash,
      onChainStreamId: creation.onChainStreamId,
      expectedSender: wallet,
      expectedRecipient: input.recipient,
    });

    const created = await this.prisma.paymentStream.create({
      data: {
        sender: verified.sender,
        recipient: verified.recipient,
        // The caller's decimal figures stay in the columns that have always
        // held them; the chain's raw units would need token decimals to
        // convert, and guessing those is NP-TREASURY-01.
        totalAmount: new Prisma.Decimal(input.totalAmount),
        ratePerSecond: new Prisma.Decimal(input.ratePerSecond ?? 0),
        currency: input.currency,
        // Timings come from the chain: they drive every balance from here on.
        startTime: verified.startTime,
        endTime: verified.endTime,
        cliffEnd: verified.cliffEndTime,
        status: "ACTIVE",
        totalPausedSeconds: 0,
        onChainStreamId: verified.onChainStreamId,
        createTxHash: verified.txHash,
        lastEventTxHash: verified.txHash,
      },
    });

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: verified.sender,
      description: `Payment stream created on chain: ${verified.recipient} via ${verified.txHash}`,
      severity: "HIGH",
      businessId,
      metadata: {
        streamId: created.id,
        onChainStreamId: verified.onChainStreamId,
        txHash: verified.txHash,
        blockNumber: verified.blockNumber,
        amountBasis: "RAW_CONTRACT_UNITS",
      },
    });

    return streamRecord(created, businessId);
  }

  /**
   * Still closed, and not for want of a verifier.
   *
   * BatchStreamsCreated reports only a count and a total — it does not name the
   * individual stream ids. Each stream in a batch does emit its own
   * StreamCreated, so a batch can be recorded as N calls to createStream with
   * their own receipts. Adding a batch path that verified only the aggregate
   * would record N streams on the strength of evidence about none of them.
   */
  async createBatchStreams(_input: BatchStreamInput): Promise<never> {
    throw new StreamError(
      "BATCH_STREAM_UNVERIFIABLE",
      "BatchStreamsCreated does not identify the streams it created; record each stream individually with its own StreamCreated receipt",
      501,
    );
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
    streamId: string,
    actor: string,
    businessId: string,
    transition: { txHash: string },
    config: NoblePayChainConfiguration,
  ): Promise<StreamRecord> {
    return this.applyTransition(streamId, actor, businessId, "PAUSED", transition, config);
  }

  async resumeStream(
    streamId: string,
    actor: string,
    businessId: string,
    transition: { txHash: string },
    config: NoblePayChainConfiguration,
  ): Promise<StreamRecord> {
    return this.applyTransition(streamId, actor, businessId, "RESUMED", transition, config);
  }

  async cancelStream(
    streamId: string,
    actor: string,
    businessId: string,
    transition: { txHash: string },
    config: NoblePayChainConfiguration,
  ): Promise<StreamRecord> {
    return this.applyTransition(streamId, actor, businessId, "CANCELLED", transition, config);
  }

  async completeStream(
    streamId: string,
    actor: string,
    businessId: string,
    transition: { txHash: string },
    config: NoblePayChainConfiguration,
  ): Promise<StreamRecord> {
    return this.applyTransition(streamId, actor, businessId, "COMPLETED", transition, config);
  }

  /**
   * Permanently refused, not gated.
   *
   * StreamingPayments has no rate-adjustment function and no event for one. A
   * stream's ratePerSecond is fixed at creation by design: the recipient's
   * entitlement depends on it, so a sender able to lower it could renege after
   * the fact. There is no receipt to wait for, so this does not belong behind a
   * verifier gate. See docs/audit/NP-STREAM-01.
   */
  async adjustRate(
    _streamId: string,
    _newRatePerSecond: string,
    _actor: string,
    _businessId?: string,
  ): Promise<never> {
    throw new StreamError(
      "STREAM_RATE_IMMUTABLE",
      "A stream's rate is fixed at creation and cannot be changed; cancel the stream and create a new one",
      422,
    );
  }

  /**
   * Record a withdrawal so `withdrawable` stops over-reporting.
   *
   * `withdrawable` is `streamed - withdrawn`, and nothing advanced `withdrawn`
   * before this, so any stream drawn against reported more available than it
   * had. The contract's running total is stored rather than an increment, so a
   * replayed receipt cannot double-count.
   */
  async recordWithdrawal(
    streamId: string,
    actor: string,
    businessId: string,
    withdrawal: { txHash: string },
    config: NoblePayChainConfiguration,
  ): Promise<StreamRecord> {
    const stream = await this.findTenantStream(streamId, businessId);
    if (!stream.onChainStreamId) {
      throw new StreamError(
        "STREAM_NOT_ON_CHAIN",
        "This stream has no on-chain id, so a withdrawal receipt cannot be matched to it",
        409,
      );
    }

    const verified = await verifyWithdrawal(config, {
      txHash: withdrawal.txHash,
      onChainStreamId: stream.onChainStreamId,
      expectedRecipient: stream.recipient,
    });

    const updated = await this.prisma.paymentStream.update({
      where: { id: stream.id },
      data: {
        withdrawn: new Prisma.Decimal(verified.withdrawnTotal),
        lastEventTxHash: verified.txHash,
      },
    });

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `Stream withdrawal recorded on chain: ${stream.id} via ${verified.txHash}`,
      severity: "MEDIUM",
      businessId,
      metadata: {
        streamId: stream.id,
        onChainStreamId: verified.onChainStreamId,
        txHash: verified.txHash,
        amount: verified.amount,
        withdrawnTotal: verified.withdrawnTotal,
        amountBasis: "RAW_CONTRACT_UNITS",
      },
    });

    return streamRecord(updated, businessId);
  }

  /**
   * Shared path for the four lifecycle transitions.
   *
   * totalPausedSeconds is written from the contract's running total on EVERY
   * transition, not only on resume. If a resume receipt were never recorded
   * here, the next transition still repairs the figure — which matters because
   * a lost pause interval silently inflates every balance from that point on.
   */
  private async applyTransition(
    streamId: string,
    actor: string,
    businessId: string,
    kind: StreamEventKind,
    transition: { txHash: string },
    config: NoblePayChainConfiguration,
  ): Promise<StreamRecord> {
    const stream = await this.findTenantStream(streamId, businessId);
    if (!stream.onChainStreamId) {
      throw new StreamError(
        "STREAM_NOT_ON_CHAIN",
        "This stream has no on-chain id, so a receipt cannot be matched to it",
        409,
      );
    }

    const verified = await verifyStreamTransition(config, {
      txHash: transition.txHash,
      onChainStreamId: stream.onChainStreamId,
      kind,
      expectedSender: stream.sender,
    });

    const updated = await this.prisma.paymentStream.update({
      where: { id: stream.id },
      data: {
        status: verified.chainStatus as StreamStatus,
        pausedAt: kind === "PAUSED" ? verified.at : null,
        totalPausedSeconds: verified.totalPausedSeconds,
        lastEventTxHash: verified.txHash,
      },
    });

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `Payment stream ${kind.toLowerCase()} on chain: ${stream.id} via ${verified.txHash}`,
      severity: kind === "CANCELLED" ? "HIGH" : "MEDIUM",
      businessId,
      metadata: {
        streamId: stream.id,
        onChainStreamId: verified.onChainStreamId,
        txHash: verified.txHash,
        blockNumber: verified.blockNumber,
        chainStatus: verified.chainStatus,
        totalPausedSeconds: verified.totalPausedSeconds,
        recipientAmount: verified.recipientAmount,
        senderRefund: verified.senderRefund,
        amountBasis: "RAW_CONTRACT_UNITS",
      },
    });

    return streamRecord(updated, businessId);
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
