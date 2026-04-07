import { PrismaClient, Prisma } from "@prisma/client";
import { generateOpaqueId } from "../lib/identifiers";
import { logger, maskIdentifier } from "../lib/logger";
import { AuditService } from "./audit";

// ─── Types ──────────────────────────────────────────────────────────────────

export type StreamStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED" | "PENDING";

export interface CreateStreamInput {
  sender: string;
  recipient: string;
  totalAmount: string;
  currency: string;
  startTime?: string;
  endTime: string;
  cliffDuration?: number; // seconds
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
  autoCompound: boolean;
  lastWithdrawAt: Date | null;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

export interface StreamAnalytics {
  totalActiveStreams: number;
  totalStreamedVolume: string;
  totalWithdrawn: string;
  dailyOutflow: string;
  weeklyOutflow: string;
  monthlyOutflow: string;
  byCurrency: Record<string, { count: number; volume: string }>;
  upcomingMilestones: Array<{ streamId: string; event: string; date: Date }>;
}

const MAX_BATCH_STREAMS = 100;

// ─── Service ────────────────────────────────────────────────────────────────

export class StreamingService {
  private streams: Map<string, StreamRecord> = new Map();

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
  ) {}

  /**
   * Create a new payment stream with per-second settlement.
   */
  async createStream(
    input: CreateStreamInput,
    businessId: string,
  ): Promise<StreamRecord> {
    const streamId = generateOpaqueId("stream");

    const startTime = input.startTime ? new Date(input.startTime) : new Date();
    const endTime = new Date(input.endTime);
    const totalSeconds = Math.floor((endTime.getTime() - startTime.getTime()) / 1000);

    if (totalSeconds <= 0) {
      throw new StreamError("INVALID_DURATION", "End time must be after start time");
    }

    const totalAmount = parseFloat(input.totalAmount);
    const ratePerSecond = input.ratePerSecond
      ? input.ratePerSecond
      : (totalAmount / totalSeconds).toFixed(18);

    const cliffEnd = input.cliffDuration
      ? new Date(startTime.getTime() + input.cliffDuration * 1000)
      : null;

    const stream: StreamRecord = {
      id: streamId,
      streamId,
      businessId,
      sender: input.sender,
      recipient: input.recipient,
      totalAmount: input.totalAmount,
      streamedAmount: "0",
      withdrawnAmount: "0",
      currency: input.currency,
      ratePerSecond,
      startTime,
      endTime,
      cliffEnd,
      status: "ACTIVE",
      autoCompound: input.autoCompound || false,
      lastWithdrawAt: null,
      createdAt: new Date(),
      metadata: input.metadata || {},
    };

    this.streams.set(streamId, stream);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: input.sender,
      description: `Payment stream created: ${input.totalAmount} ${input.currency} to ${input.recipient} over ${totalSeconds}s`,
      severity: "INFO",
      metadata: { streamId, totalAmount: input.totalAmount, ratePerSecond },
    });

    logger.info("Payment stream created", {
      streamId,
      sender: input.sender,
      recipient: input.recipient,
      totalAmount: input.totalAmount,
      currency: input.currency,
      ratePerSecond,
      durationSeconds: totalSeconds,
    });

    return stream;
  }

  /**
   * Create multiple streams in a batch (e.g., payroll).
   */
  async createBatchStreams(
    input: BatchStreamInput,
  ): Promise<{ succeeded: StreamRecord[]; failed: Array<{ index: number; error: string }> }> {
    if (input.streams.length > MAX_BATCH_STREAMS) {
      throw new StreamError(
        "BATCH_TOO_LARGE",
        `Batch stream creation is limited to ${MAX_BATCH_STREAMS} streams per request`,
        400,
      );
    }

    const succeeded: StreamRecord[] = [];
    const failed: Array<{ index: number; error: string }> = [];

    for (let i = 0; i < input.streams.length; i++) {
      try {
        const stream = await this.createStream(input.streams[i], input.businessId);
        succeeded.push(stream);
      } catch (error) {
        failed.push({ index: i, error: (error as Error).message });
      }
    }

    logger.info("Batch stream creation complete", {
      label: input.label,
      total: input.streams.length,
      succeeded: succeeded.length,
      failed: failed.length,
    });

    return { succeeded, failed };
  }

  /**
   * Calculate the real-time balance of a stream.
   */
  getStreamBalance(streamId: string): StreamBalance {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new StreamError("STREAM_NOT_FOUND", "Stream not found", 404);
    }

    const now = Date.now();
    const startMs = stream.startTime.getTime();
    const endMs = stream.endTime.getTime();
    const totalSeconds = Math.floor((endMs - startMs) / 1000);

    if (now < startMs || stream.status === "PENDING") {
      return {
        streamId,
        withdrawable: "0",
        streamed: "0",
        remaining: stream.totalAmount,
        percentComplete: 0,
        elapsedSeconds: 0,
        totalSeconds,
      };
    }

    // Check cliff period
    if (stream.cliffEnd && now < stream.cliffEnd.getTime()) {
      const elapsedSeconds = Math.floor((now - startMs) / 1000);
      const streamed = (parseFloat(stream.ratePerSecond) * elapsedSeconds).toFixed(18);
      return {
        streamId,
        withdrawable: "0", // Cliff not reached yet
        streamed,
        remaining: (parseFloat(stream.totalAmount) - parseFloat(streamed)).toFixed(18),
        percentComplete: (elapsedSeconds / totalSeconds) * 100,
        elapsedSeconds,
        totalSeconds,
      };
    }

    const effectiveNow = Math.min(now, endMs);
    const elapsedSeconds = Math.floor((effectiveNow - startMs) / 1000);
    const rate = parseFloat(stream.ratePerSecond);
    const streamedAmount = Math.min(rate * elapsedSeconds, parseFloat(stream.totalAmount));
    const withdrawable = streamedAmount - parseFloat(stream.withdrawnAmount);

    return {
      streamId,
      withdrawable: withdrawable.toFixed(18),
      streamed: streamedAmount.toFixed(18),
      remaining: (parseFloat(stream.totalAmount) - streamedAmount).toFixed(18),
      percentComplete: Math.min((elapsedSeconds / totalSeconds) * 100, 100),
      elapsedSeconds,
      totalSeconds,
    };
  }

  /**
   * Get a single stream by ID.
   */
  getStream(streamId: string): StreamRecord | undefined {
    return this.streams.get(streamId);
  }

  /**
   * Pause an active stream.
   */
  async pauseStream(streamId: string, actor: string, businessId?: string): Promise<StreamRecord> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new StreamError("STREAM_NOT_FOUND", "Stream not found", 404);
    }
    if (businessId && stream.businessId !== businessId) {
      throw new StreamError("FORBIDDEN", "You do not have permission to pause this stream", 403);
    }
    if (stream.status !== "ACTIVE") {
      throw new StreamError("INVALID_STATE", `Cannot pause stream in ${stream.status} state`, 409);
    }

    stream.status = "PAUSED";
    this.streams.set(streamId, stream);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `Payment stream ${streamId} paused`,
      severity: "LOW",
      metadata: { streamId },
    });

    logger.info("Stream paused", { streamRef: maskIdentifier(streamId), actorRef: maskIdentifier(actor) });
    return stream;
  }

  /**
   * Resume a paused stream.
   */
  async resumeStream(streamId: string, actor: string, businessId?: string): Promise<StreamRecord> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new StreamError("STREAM_NOT_FOUND", "Stream not found", 404);
    }
    if (businessId && stream.businessId !== businessId) {
      throw new StreamError("FORBIDDEN", "You do not have permission to resume this stream", 403);
    }
    if (stream.status !== "PAUSED") {
      throw new StreamError("INVALID_STATE", `Cannot resume stream in ${stream.status} state`, 409);
    }

    stream.status = "ACTIVE";
    this.streams.set(streamId, stream);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `Payment stream ${streamId} resumed`,
      severity: "LOW",
      metadata: { streamId },
    });

    logger.info("Stream resumed", { streamRef: maskIdentifier(streamId), actorRef: maskIdentifier(actor) });
    return stream;
  }

  /**
   * Cancel a stream and settle the accrued amount.
   */
  async cancelStream(
    streamId: string,
    actor: string,
    businessId?: string,
  ): Promise<{ stream: StreamRecord; settledAmount: string; refundedAmount: string }> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new StreamError("STREAM_NOT_FOUND", "Stream not found", 404);
    }
    if (businessId && stream.businessId !== businessId) {
      throw new StreamError("FORBIDDEN", "You do not have permission to cancel this stream", 403);
    }
    if (stream.status === "COMPLETED" || stream.status === "CANCELLED") {
      throw new StreamError("INVALID_STATE", `Stream already ${stream.status}`, 409);
    }

    const balance = this.getStreamBalance(streamId);
    const settledAmount = balance.streamed;
    const refundedAmount = balance.remaining;

    stream.status = "CANCELLED";
    stream.streamedAmount = settledAmount;
    this.streams.set(streamId, stream);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `Payment stream ${streamId} cancelled. Settled: ${settledAmount} ${stream.currency}, Refunded: ${refundedAmount} ${stream.currency}`,
      severity: "MEDIUM",
      metadata: { streamId, settledAmount, refundedAmount },
    });

    logger.info("Stream cancelled", {
      streamRef: maskIdentifier(streamId),
      actorRef: maskIdentifier(actor),
      settledAmount,
      refundedAmount,
    });
    return { stream, settledAmount, refundedAmount };
  }

  /**
   * Adjust the rate of an active stream.
   */
  async adjustRate(
    streamId: string,
    newRatePerSecond: string,
    actor: string,
    businessId?: string,
  ): Promise<StreamRecord> {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new StreamError("STREAM_NOT_FOUND", "Stream not found", 404);
    }
    if (businessId && stream.businessId !== businessId) {
      throw new StreamError("FORBIDDEN", "You do not have permission to adjust this stream", 403);
    }
    if (stream.status !== "ACTIVE" && stream.status !== "PAUSED") {
      throw new StreamError("INVALID_STATE", `Cannot adjust rate for ${stream.status} stream`, 409);
    }

    const oldRate = stream.ratePerSecond;
    stream.ratePerSecond = newRatePerSecond;
    this.streams.set(streamId, stream);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `Stream ${streamId} rate adjusted from ${oldRate} to ${newRatePerSecond} per second`,
      severity: "LOW",
      metadata: { streamId, oldRate, newRate: newRatePerSecond },
    });

    logger.info("Stream rate adjusted", { streamId, oldRate, newRate: newRatePerSecond });
    return stream;
  }

  /**
   * List all streams with optional filters.
   */
  listStreams(filters?: {
    sender?: string;
    recipient?: string;
    status?: StreamStatus;
    currency?: string;
    businessId?: string;
  }): StreamRecord[] {
    let streams = Array.from(this.streams.values());

    if (filters?.businessId) streams = streams.filter((s) => s.businessId === filters.businessId);
    if (filters?.sender) streams = streams.filter((s) => s.sender === filters.sender);
    if (filters?.recipient) streams = streams.filter((s) => s.recipient === filters.recipient);
    if (filters?.status) streams = streams.filter((s) => s.status === filters.status);
    if (filters?.currency) streams = streams.filter((s) => s.currency === filters.currency);

    return streams.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Get streaming analytics.
   */
  getAnalytics(businessId?: string): StreamAnalytics {
    let allStreams = Array.from(this.streams.values());
    if (businessId) {
      allStreams = allStreams.filter((s) => s.businessId === businessId);
    }
    const activeStreams = allStreams.filter(
      (s) => s.status === "ACTIVE",
    );

    const byCurrency: Record<string, { count: number; volume: string }> = {};
    let totalStreamedVolume = 0;
    let totalWithdrawn = 0;
    let dailyOutflow = 0;

    for (const stream of activeStreams) {
      const balance = this.getStreamBalance(stream.streamId);
      totalStreamedVolume += parseFloat(balance.streamed);
      totalWithdrawn += parseFloat(stream.withdrawnAmount);
      dailyOutflow += parseFloat(stream.ratePerSecond) * 86400;

      if (!byCurrency[stream.currency]) {
        byCurrency[stream.currency] = { count: 0, volume: "0" };
      }
      byCurrency[stream.currency].count++;
      byCurrency[stream.currency].volume = (
        parseFloat(byCurrency[stream.currency].volume) + parseFloat(stream.totalAmount)
      ).toFixed(2);
    }

    return {
      totalActiveStreams: activeStreams.length,
      totalStreamedVolume: totalStreamedVolume.toFixed(2),
      totalWithdrawn: totalWithdrawn.toFixed(2),
      dailyOutflow: dailyOutflow.toFixed(2),
      weeklyOutflow: (dailyOutflow * 7).toFixed(2),
      monthlyOutflow: (dailyOutflow * 30).toFixed(2),
      byCurrency,
      upcomingMilestones: activeStreams
        .filter((s) => s.cliffEnd && s.cliffEnd > new Date())
        .map((s) => ({
          streamId: s.streamId,
          event: "cliff_end",
          date: s.cliffEnd!,
        }))
        .slice(0, 10),
    };
  }
}

// ─── Error Class ────────────────────────────────────────────────────────────

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
