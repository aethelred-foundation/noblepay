import { createMockPrisma, resetAllMocks } from "../setup";
import { StreamingService, StreamError } from "../../services/streaming";
import { AuditService } from "../../services/audit";

let prisma: ReturnType<typeof createMockPrisma>;
let auditService: AuditService;
let streamingService: StreamingService;

beforeEach(() => {
  resetAllMocks();
  prisma = createMockPrisma();
  auditService = new AuditService(prisma);
  jest.spyOn(auditService, "createAuditEntry").mockResolvedValue({} as any);
  streamingService = new StreamingService(prisma, auditService);
});

describe("StreamingService", () => {
  const baseInput = {
    sender: "0x1234567890abcdef1234567890abcdef12345678",
    recipient: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    totalAmount: "86400",
    currency: "USDC",
    endTime: new Date(Date.now() + 86400 * 1000).toISOString(),
  };

  // ─── createStream ────────────────────────────────────────────────────────

  describe("createStream", () => {
    it("should create a stream with correct properties", async () => {
      const stream = await streamingService.createStream(baseInput, "biz-1");

      expect(stream.id).toMatch(/^stream-/);
      expect(stream.sender).toBe(baseInput.sender);
      expect(stream.recipient).toBe(baseInput.recipient);
      expect(stream.totalAmount).toBe("86400");
      expect(stream.currency).toBe("USDC");
      expect(stream.status).toBe("ACTIVE");
      expect(stream.streamedAmount).toBe("0");
      expect(stream.withdrawnAmount).toBe("0");
      expect(stream.autoCompound).toBe(false);
    });

    it("should calculate ratePerSecond from totalAmount and duration", async () => {
      const stream = await streamingService.createStream(baseInput, "biz-1");
      const rate = parseFloat(stream.ratePerSecond);
      expect(rate).toBeGreaterThan(0);
    });

    it("should use custom ratePerSecond when provided", async () => {
      const stream = await streamingService.createStream(
        { ...baseInput, ratePerSecond: "2.5" },
        "biz-1",
      );
      expect(stream.ratePerSecond).toBe("2.5");
    });

    it("should set cliff end when cliffDuration is provided", async () => {
      const stream = await streamingService.createStream(
        { ...baseInput, cliffDuration: 3600 },
        "biz-1",
      );
      expect(stream.cliffEnd).toBeInstanceOf(Date);
    });

    it("should throw INVALID_DURATION when endTime is before startTime", async () => {
      await expect(
        streamingService.createStream(
          { ...baseInput, endTime: new Date(Date.now() - 1000).toISOString() },
          "biz-1",
        ),
      ).rejects.toMatchObject({ code: "INVALID_DURATION" });
    });

    it("should set autoCompound when provided", async () => {
      const stream = await streamingService.createStream(
        { ...baseInput, autoCompound: true },
        "biz-1",
      );
      expect(stream.autoCompound).toBe(true);
    });
  });

  // ─── createBatchStreams ────────────────────────────────────────────────────

  describe("createBatchStreams", () => {
    it("should create multiple streams", async () => {
      const result = await streamingService.createBatchStreams({
        businessId: "biz-1",
        streams: [baseInput, baseInput],
      });

      expect(result.succeeded).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
    });

    it("should report failed streams", async () => {
      const badInput = {
        ...baseInput,
        endTime: new Date(Date.now() - 1000).toISOString(),
      };

      const result = await streamingService.createBatchStreams({
        businessId: "biz-1",
        streams: [baseInput, badInput],
      });

      expect(result.succeeded).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].index).toBe(1);
    });
  });

  // ─── getStreamBalance ──────────────────────────────────────────────────────

  describe("getStreamBalance", () => {
    it("should throw STREAM_NOT_FOUND for unknown stream", () => {
      expect(() =>
        streamingService.getStreamBalance("nonexistent"),
      ).toThrow(StreamError);
    });

    it("should return zero balance for future stream", async () => {
      const futureInput = {
        ...baseInput,
        startTime: new Date(Date.now() + 86400 * 1000).toISOString(),
        endTime: new Date(Date.now() + 2 * 86400 * 1000).toISOString(),
      };
      const stream = await streamingService.createStream(futureInput, "biz-1");
      // Override status to PENDING for this test
      (stream as any).status = "PENDING";
      const balance = streamingService.getStreamBalance(stream.id);
      expect(balance.withdrawable).toBe("0");
      expect(balance.streamed).toBe("0");
      expect(balance.percentComplete).toBe(0);
    });

    it("should calculate streamed amount for active stream", async () => {
      const stream = await streamingService.createStream(
        {
          ...baseInput,
          startTime: new Date(Date.now() - 43200 * 1000).toISOString(), // started 12h ago
        },
        "biz-1",
      );

      const balance = streamingService.getStreamBalance(stream.id);
      expect(parseFloat(balance.streamed)).toBeGreaterThan(0);
      expect(balance.percentComplete).toBeGreaterThan(0);
    });

    it("should return zero withdrawable during cliff period", async () => {
      const stream = await streamingService.createStream(
        {
          ...baseInput,
          startTime: new Date(Date.now() - 1800 * 1000).toISOString(), // started 30min ago
          cliffDuration: 7200, // 2 hour cliff (we're still in it)
        },
        "biz-1",
      );

      const balance = streamingService.getStreamBalance(stream.id);
      expect(balance.withdrawable).toBe("0");
      expect(parseFloat(balance.streamed)).toBeGreaterThan(0);
    });
  });

  // ─── pauseStream ───────────────────────────────────────────────────────────

  describe("pauseStream", () => {
    it("should pause an active stream", async () => {
      const stream = await streamingService.createStream(baseInput, "biz-1");
      const paused = await streamingService.pauseStream(stream.id, "actor");
      expect(paused.status).toBe("PAUSED");
    });

    it("should throw STREAM_NOT_FOUND for unknown stream", async () => {
      await expect(
        streamingService.pauseStream("nonexistent", "actor"),
      ).rejects.toMatchObject({ code: "STREAM_NOT_FOUND" });
    });

    it("should throw INVALID_STATE when stream is not ACTIVE", async () => {
      const stream = await streamingService.createStream(baseInput, "biz-1");
      await streamingService.pauseStream(stream.id, "actor");

      await expect(
        streamingService.pauseStream(stream.id, "actor"),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    });
  });

  // ─── resumeStream ──────────────────────────────────────────────────────────

  describe("resumeStream", () => {
    it("should resume a paused stream", async () => {
      const stream = await streamingService.createStream(baseInput, "biz-1");
      await streamingService.pauseStream(stream.id, "actor");
      const resumed = await streamingService.resumeStream(stream.id, "actor");
      expect(resumed.status).toBe("ACTIVE");
    });

    it("should throw STREAM_NOT_FOUND for unknown stream", async () => {
      await expect(
        streamingService.resumeStream("nonexistent", "actor"),
      ).rejects.toMatchObject({ code: "STREAM_NOT_FOUND" });
    });

    it("should throw INVALID_STATE when stream is ACTIVE", async () => {
      const stream = await streamingService.createStream(baseInput, "biz-1");

      await expect(
        streamingService.resumeStream(stream.id, "actor"),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    });
  });

  // ─── cancelStream ──────────────────────────────────────────────────────────

  describe("cancelStream", () => {
    it("should cancel an active stream and return settlement amounts", async () => {
      const stream = await streamingService.createStream(
        {
          ...baseInput,
          startTime: new Date(Date.now() - 43200 * 1000).toISOString(),
        },
        "biz-1",
      );

      const result = await streamingService.cancelStream(stream.id, "actor");

      expect(result.stream.status).toBe("CANCELLED");
      expect(result.settledAmount).toBeDefined();
      expect(result.refundedAmount).toBeDefined();
    });

    it("should throw STREAM_NOT_FOUND for unknown stream", async () => {
      await expect(
        streamingService.cancelStream("nonexistent", "actor"),
      ).rejects.toMatchObject({ code: "STREAM_NOT_FOUND" });
    });

    it("should throw for already cancelled stream", async () => {
      const stream = await streamingService.createStream(baseInput, "biz-1");
      await streamingService.cancelStream(stream.id, "actor");

      await expect(
        streamingService.cancelStream(stream.id, "actor"),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    });
  });

  // ─── adjustRate ────────────────────────────────────────────────────────────

  describe("adjustRate", () => {
    it("should throw STREAM_NOT_FOUND for unknown stream", async () => {
      await expect(
        streamingService.adjustRate("nonexistent", "5.0", "actor"),
      ).rejects.toMatchObject({ code: "STREAM_NOT_FOUND" });
    });

    it("should adjust rate of an active stream", async () => {
      const stream = await streamingService.createStream(baseInput, "biz-1");
      const adjusted = await streamingService.adjustRate(
        stream.id,
        "5.0",
        "actor",
      );

      expect(adjusted.ratePerSecond).toBe("5.0");
    });

    it("should adjust rate of a paused stream", async () => {
      const stream = await streamingService.createStream(baseInput, "biz-1");
      await streamingService.pauseStream(stream.id, "actor");
      const adjusted = await streamingService.adjustRate(
        stream.id,
        "3.0",
        "actor",
      );

      expect(adjusted.ratePerSecond).toBe("3.0");
    });

    it("should throw for completed stream", async () => {
      const stream = await streamingService.createStream(baseInput, "biz-1");
      await streamingService.cancelStream(stream.id, "actor");

      await expect(
        streamingService.adjustRate(stream.id, "2.0", "actor"),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    });
  });

  // ─── listStreams ───────────────────────────────────────────────────────────

  describe("listStreams", () => {
    it("should return all streams when no filters", async () => {
      await streamingService.createStream(baseInput, "biz-1");
      // Use a different recipient to avoid hash collision on same-ms calls
      await streamingService.createStream(
        { ...baseInput, recipient: "0x0000000000000000000000000000000000000001" },
        "biz-1",
      );

      const streams = streamingService.listStreams();
      expect(streams).toHaveLength(2);
    });

    it("should filter by sender", async () => {
      await streamingService.createStream(baseInput, "biz-1");
      const streams = streamingService.listStreams({
        sender: "0x0000000000000000000000000000000000000000",
      });
      expect(streams).toHaveLength(0);
    });

    it("should filter by status", async () => {
      const stream = await streamingService.createStream(baseInput, "biz-1");
      await streamingService.pauseStream(stream.id, "actor");
      await streamingService.createStream(
        { ...baseInput, recipient: "0x0000000000000000000000000000000000000002" },
        "biz-1",
      );

      const paused = streamingService.listStreams({ status: "PAUSED" });
      expect(paused).toHaveLength(1);
    });

    it("should filter by recipient", async () => {
      await streamingService.createStream(baseInput, "biz-1");

      const found = streamingService.listStreams({ recipient: baseInput.recipient });
      expect(found).toHaveLength(1);

      const notFound = streamingService.listStreams({ recipient: "0x0000000000000000000000000000000000000099" });
      expect(notFound).toHaveLength(0);
    });

    it("should filter by currency", async () => {
      await streamingService.createStream(baseInput, "biz-1");

      const found = streamingService.listStreams({ currency: "USDC" });
      expect(found).toHaveLength(1);

      const notFound = streamingService.listStreams({ currency: "AED" });
      expect(notFound).toHaveLength(0);
    });
  });

  // ─── getAnalytics ──────────────────────────────────────────────────────────

  describe("getAnalytics", () => {
    it("should return analytics with empty streams", () => {
      const analytics = streamingService.getAnalytics();
      expect(analytics.totalActiveStreams).toBe(0);
      expect(analytics.totalStreamedVolume).toBe("0.00");
    });

    it("should calculate analytics with active streams", async () => {
      await streamingService.createStream(
        {
          ...baseInput,
          startTime: new Date(Date.now() - 43200 * 1000).toISOString(),
        },
        "biz-1",
      );

      const analytics = streamingService.getAnalytics();
      expect(analytics.totalActiveStreams).toBe(1);
      expect(parseFloat(analytics.dailyOutflow)).toBeGreaterThan(0);
      expect(analytics.byCurrency).toHaveProperty("USDC");
    });

    it("should include upcoming milestones for streams with future cliff end", async () => {
      await streamingService.createStream(
        {
          ...baseInput,
          startTime: new Date(Date.now() - 1800 * 1000).toISOString(),
          cliffDuration: 7200, // cliff ends in 1.5 hours
        },
        "biz-1",
      );

      const analytics = streamingService.getAnalytics();
      expect(analytics.upcomingMilestones.length).toBeGreaterThanOrEqual(1);
      expect(analytics.upcomingMilestones[0].event).toBe("cliff_end");
    });
  });

  // ─── StreamError ───────────────────────────────────────────────────────────

  describe("StreamError", () => {
    it("should create error with correct properties", () => {
      const err = new StreamError("CODE", "msg", 409);
      expect(err.code).toBe("CODE");
      expect(err.statusCode).toBe(409);
      expect(err.name).toBe("StreamError");
    });
  });
});
