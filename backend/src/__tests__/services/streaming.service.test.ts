import { Prisma } from "@prisma/client";
import { StreamingService } from "../../services/streaming";
import type { AuditService } from "../../services/audit";

const wallet = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";

function stream(overrides: Record<string, unknown> = {}) {
  return {
    id: "stream-1",
    sender: wallet,
    recipient,
    totalAmount: new Prisma.Decimal("100"),
    withdrawn: new Prisma.Decimal("5"),
    currency: "USDC",
    ratePerSecond: new Prisma.Decimal("1"),
    startTime: new Date("2026-07-21T11:59:00.000Z"),
    endTime: new Date("2026-07-21T12:01:00.000Z"),
    cliffEnd: null,
    pausedAt: null,
    totalPausedSeconds: 0,
    onChainStreamId: null,
    createTxHash: null,
    lastEventTxHash: null,
    status: "ACTIVE",
    createdAt: new Date("2026-07-21T11:00:00.000Z"),
    ...overrides,
  };
}

function setup() {
  const prisma = {
    business: { findUnique: jest.fn() },
    paymentStream: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };
  const service = new StreamingService(prisma as never, {} as AuditService);
  return { prisma, service };
}

describe("StreamingService production behavior", () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-21T12:00:00.000Z"));
  });

  afterEach(() => jest.useRealTimers());

  it("reads only streams linked to the authenticated wallet and paginates", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.paymentStream.findMany.mockResolvedValue([stream()]);

    const result = await service.listStreams({
      businessId: "business-1",
      status: "ACTIVE",
      page: 2,
      limit: 20,
    });

    expect(result[0]).toEqual(
      expect.objectContaining({
        id: "stream-1",
        businessId: "business-1",
        streamedAmount: "60",
        autoCompound: null,
        dataSource: "DATABASE_TERMS",
      }),
    );
    expect(prisma.paymentStream.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 20 }),
    );
    expect(
      prisma.paymentStream.findMany.mock.calls[0][0].where.AND[0].OR,
    ).toEqual([
      { sender: { equals: wallet, mode: "insensitive" } },
      { recipient: { equals: wallet, mode: "insensitive" } },
    ]);
  });

  it("derives a balance from persisted terms without writing state", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.paymentStream.findFirst.mockResolvedValue(stream());

    const balance = await service.getStreamBalance("stream-1", "business-1");

    expect(balance).toEqual(
      expect.objectContaining({
        streamed: "60",
        withdrawable: "55",
        remaining: "40",
        percentComplete: 50,
        dataSource: "DATABASE_TERMS",
      }),
    );
    expect(prisma.paymentStream.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "stream-1" }),
      }),
    );
  });

  it.each([
    [
      "before start",
      stream({
        startTime: new Date("2026-07-21T12:01:00.000Z"),
        endTime: new Date("2026-07-21T12:02:00.000Z"),
      }),
      { streamed: "0", remaining: "100", elapsedSeconds: 0 },
    ],
    [
      "after completion",
      stream({
        startTime: new Date("2026-07-21T11:00:00.000Z"),
        endTime: new Date("2026-07-21T11:01:00.000Z"),
      }),
      { streamed: "60", remaining: "40", percentComplete: 100 },
    ],
    [
      "paused",
      stream({
        status: "PAUSED",
        pausedAt: new Date("2026-07-21T11:59:20.000Z"),
      }),
      { streamed: "20", withdrawable: "15", elapsedSeconds: 20 },
    ],
    [
      "cancelled",
      stream({
        status: "CANCELLED",
        pausedAt: new Date("2026-07-21T11:59:30.000Z"),
      }),
      { streamed: "30", withdrawable: "25", elapsedSeconds: 30 },
    ],
    [
      "cliff locked",
      stream({ cliffEnd: new Date("2026-07-21T12:00:30.000Z") }),
      { streamed: "60", withdrawable: "0" },
    ],
    [
      "over-withdrawn snapshot",
      stream({ withdrawn: new Prisma.Decimal("90") }),
      { streamed: "60", withdrawable: "0" },
    ],
    [
      "zero-duration terms",
      stream({
        startTime: new Date("2026-07-21T12:00:00.000Z"),
        endTime: new Date("2026-07-21T12:00:00.000Z"),
      }),
      { totalSeconds: 0, percentComplete: 0, streamed: "0" },
    ],
  ])(
    "safely calculates a %s stream snapshot",
    async (_name, stored, expected) => {
      const { prisma, service } = setup();
      prisma.business.findUnique.mockResolvedValue({ address: wallet });
      prisma.paymentStream.findFirst.mockResolvedValue(stored);

      await expect(
        service.getStreamBalance("stream-1", "business-1"),
      ).resolves.toMatchObject(expected);
    },
  );

  it("maps a tenant-owned stream record without claiming unsupported fields", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.paymentStream.findFirst.mockResolvedValue(stream());

    await expect(
      service.getStream("stream-1", "business-1"),
    ).resolves.toMatchObject({
      id: "stream-1",
      businessId: "business-1",
      autoCompound: null,
      lastWithdrawAt: null,
      metadata: {},
      dataSource: "DATABASE_TERMS",
    });
  });

  it("returns not found when a stream is outside the tenant", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.paymentStream.findFirst.mockResolvedValue(null);

    await expect(
      service.getStream("stream-2", "business-1"),
    ).rejects.toMatchObject({ code: "STREAM_NOT_FOUND", statusCode: 404 });
  });

  it("fails closed before stream lookup when the business no longer exists", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue(null);

    await expect(
      service.getStream("stream-1", "missing-business"),
    ).rejects.toMatchObject({ code: "BUSINESS_NOT_FOUND", statusCode: 404 });
    expect(prisma.paymentStream.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a rate change permanently — the contract has no such function", async () => {
    // Not a gate awaiting a verifier. StreamingPayments has no rate-adjustment
    // function and no event for one: a stream's rate is fixed at creation so a
    // sender cannot renege after the fact. 422, not 501.
    const { service } = setup();
    await expect(
      service.adjustRate("stream-1", "2", wallet, "business-1"),
    ).rejects.toMatchObject({
      code: "STREAM_RATE_IMMUTABLE",
      statusCode: 422,
    });
  });

  it("refuses batch creation because the batch event identifies nothing", async () => {
    // BatchStreamsCreated reports a count and a total, not the stream ids.
    // Recording N streams on the strength of that would be evidence about none
    // of them; each stream has its own StreamCreated receipt instead.
    const { service } = setup();
    await expect(
      service.createBatchStreams({ businessId: "business-1", streams: [] }),
    ).rejects.toMatchObject({
      code: "BATCH_STREAM_UNVERIFIABLE",
      statusCode: 501,
    });
  });

  it("applies all optional filters while preserving wallet ownership", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.paymentStream.findMany.mockResolvedValue([]);

    await service.listStreams({
      businessId: "business-1",
      sender: wallet.toUpperCase(),
      recipient,
      status: "PAUSED",
      currency: "USDT",
    });

    expect(prisma.paymentStream.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {
              OR: [
                { sender: { equals: wallet, mode: "insensitive" } },
                { recipient: { equals: wallet, mode: "insensitive" } },
              ],
            },
            { sender: { equals: wallet.toUpperCase(), mode: "insensitive" } },
            { recipient: { equals: recipient, mode: "insensitive" } },
            { status: "PAUSED" },
            { currency: "USDT" },
          ],
        },
        skip: undefined,
        take: undefined,
      }),
    );
  });

  it("derives analytics from the tenant's durable records", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.paymentStream.findMany.mockResolvedValue([stream()]);

    const analytics = await service.getAnalytics("business-1");

    expect(analytics).toEqual(
      expect.objectContaining({
        totalActiveStreams: 1,
        totalStreamedVolume: "60",
        totalWithdrawn: "5",
        dailyOutflow: "86400",
        dataSource: "DATABASE_TERMS",
      }),
    );
  });

  it("groups currencies and orders only future active cliff milestones", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.paymentStream.findMany.mockResolvedValue([
      stream({
        id: "stream-later",
        cliffEnd: new Date("2026-07-23T12:00:00.000Z"),
      }),
      stream({
        id: "stream-sooner",
        currency: "USDT",
        totalAmount: new Prisma.Decimal("50"),
        cliffEnd: new Date("2026-07-22T12:00:00.000Z"),
      }),
      stream({
        id: "stream-paused",
        status: "PAUSED",
        cliffEnd: new Date("2026-07-22T00:00:00.000Z"),
        pausedAt: new Date("2026-07-21T11:59:30.000Z"),
      }),
    ]);

    const analytics = await service.getAnalytics("business-1");

    expect(analytics.totalActiveStreams).toBe(2);
    expect(analytics.byCurrency).toEqual({
      USDC: { count: 2, volume: "200" },
      USDT: { count: 1, volume: "50" },
    });
    expect(analytics.upcomingMilestones.map((item) => item.streamId)).toEqual([
      "stream-sooner",
      "stream-later",
    ]);
  });
});

/**
 * Regression for NP-STREAM-01.
 *
 * The bug: calculateBalance ignored accumulated pause time, so a stream that
 * had been paused and resumed reported the whole pause interval as streamed.
 * It was unreachable while pause/resume were gated, and opening those gates is
 * what would have made it reachable — so this pins the arithmetic rather than
 * trusting that the fix stays.
 */
describe("stream balance excludes paused time", () => {
  const START = new Date("2026-07-21T12:00:00.000Z");
  const END = new Date("2026-07-21T12:01:40.000Z"); // 100 seconds

  // Read the balance 60 seconds into the stream.
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-21T12:01:00.000Z"));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const paused = (totalPausedSeconds: number) =>
    stream({
      startTime: START,
      endTime: END,
      totalAmount: new Prisma.Decimal("100"),
      ratePerSecond: new Prisma.Decimal("1"),
      withdrawn: new Prisma.Decimal("0"),
      totalPausedSeconds,
      status: "ACTIVE",
      pausedAt: null,
    });

  it("reports 30 streamed, not 60, after a 30 second pause", async () => {
    // The worked example from the finding: 100 tokens over 100s at 1/s, paused
    // at t=10 for 30s, read at t=60. The contract pays 30. Before the fix this
    // said 60 — the API promising money that does not exist.
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.paymentStream.findFirst.mockResolvedValue(paused(30));

    const balance = await service.getStreamBalance("stream-1", "business-1");

    // 60s wall clock minus 30s paused.
    expect(balance.elapsedSeconds).toBe(30);
    expect(balance.streamed).toBe("30");
    expect(balance.withdrawable).toBe("30");
  });

  it("shortens the total duration by the pause as well", async () => {
    // The contract subtracts pause time from BOTH elapsed and total. Taking it
    // off only one would leave percentComplete wrong even where streamed is
    // right.
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.paymentStream.findFirst.mockResolvedValue(paused(30));

    const balance = await service.getStreamBalance("stream-1", "business-1");

    expect(balance.totalSeconds).toBe(70);
    expect(balance.percentComplete).toBeCloseTo((30 / 70) * 100, 6);
  });

  it("is unchanged for a stream that was never paused", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.paymentStream.findFirst.mockResolvedValue(paused(0));

    const balance = await service.getStreamBalance("stream-1", "business-1");

    expect(balance.totalSeconds).toBe(100);
    expect(balance.streamed).toBe("60");
  });

  it("never reports negative progress if the pause exceeds the elapsed time", async () => {
    // Defensive: a clock skew or a repaired totalPausedSeconds larger than the
    // wall-clock elapsed must clamp to zero, not go negative and invert the
    // arithmetic.
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.paymentStream.findFirst.mockResolvedValue(paused(90));

    const balance = await service.getStreamBalance("stream-1", "business-1");

    expect(balance.elapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(Number(balance.streamed)).toBeGreaterThanOrEqual(0);
  });
});
