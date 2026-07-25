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
    status: "ACTIVE",
    createdAt: new Date("2026-07-21T11:00:00.000Z"),
    ...overrides,
  };
}

function setup() {
  const prisma = {
    business: { findUnique: jest.fn() },
    paymentStream: { findMany: jest.fn(), findFirst: jest.fn() },
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

  it("fails every unverified stream mutation closed", async () => {
    const { service } = setup();
    await expect(
      service.createStream(
        {
          sender: wallet,
          recipient,
          totalAmount: "100",
          currency: "USDC",
          endTime: "2026-08-01T00:00:00.000Z",
        },
        "business-1",
      ),
    ).rejects.toMatchObject({ statusCode: 501 });
    await expect(
      service.pauseStream("stream-1", wallet, "business-1"),
    ).rejects.toMatchObject({
      code: "ONCHAIN_SETTLEMENT_UNAVAILABLE",
      statusCode: 501,
    });
    await expect(
      service.adjustRate("stream-1", "2", wallet, "business-1"),
    ).rejects.toMatchObject({ statusCode: 501 });
    await expect(
      service.createBatchStreams({
        businessId: "business-1",
        streams: [],
      }),
    ).rejects.toMatchObject({
      code: "ONCHAIN_SETTLEMENT_UNAVAILABLE",
      statusCode: 501,
    });
    await expect(
      service.resumeStream("stream-1", wallet, "business-1"),
    ).rejects.toMatchObject({ statusCode: 501 });
    await expect(
      service.cancelStream("stream-1", wallet, "business-1"),
    ).rejects.toMatchObject({ statusCode: 501 });
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
