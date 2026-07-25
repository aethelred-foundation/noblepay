import { Prisma } from "@prisma/client";
import { LiquidityService } from "../../services/liquidity";
import type { AuditService } from "../../services/audit";

const wallet = "0x1111111111111111111111111111111111111111";
const now = new Date("2026-07-21T12:00:00.000Z");

function pool(overrides: Record<string, unknown> = {}) {
  return {
    id: "pool-usdc-usdt",
    tokenA: "USDC",
    tokenB: "USDT",
    reserveA: new Prisma.Decimal("1000"),
    reserveB: new Prisma.Decimal("990"),
    totalLiquidity: new Prisma.Decimal("1990"),
    feeRate: new Prisma.Decimal("0.003"),
    volume24h: new Prisma.Decimal("250"),
    feesCollected: new Prisma.Decimal("3.5"),
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setup() {
  const prisma = {
    liquidityPool: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    lPPosition: { findMany: jest.fn() },
    business: { findUnique: jest.fn() },
  };
  const service = new LiquidityService(prisma as never, {} as AuditService);
  return { prisma, service };
}

describe("LiquidityService production behavior", () => {
  it("maps durable pool snapshots without inventing APY or utilization", async () => {
    const { prisma, service } = setup();
    prisma.liquidityPool.findMany.mockResolvedValue([pool()]);

    const result = await service.getPools("ACTIVE", { page: 2, limit: 25 });

    expect(result).toEqual([
      expect.objectContaining({
        id: "pool-usdc-usdt",
        tvl: "1990",
        apy: null,
        utilization: null,
        dataSource: "DATABASE_SNAPSHOT",
      }),
    ]);
    expect(prisma.liquidityPool.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true },
        skip: 25,
        take: 25,
      }),
    );
  });

  it("maps paused pools, unfiltered snapshots, and deprecated as an empty view", async () => {
    const { prisma, service } = setup();
    prisma.liquidityPool.findMany.mockResolvedValue([
      pool({ id: "paused-pool", isActive: false }),
    ]);

    await expect(service.getPools("PAUSED")).resolves.toEqual([
      expect.objectContaining({ id: "paused-pool", status: "PAUSED" }),
    ]);
    expect(prisma.liquidityPool.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { isActive: false },
        skip: undefined,
        take: undefined,
      }),
    );

    prisma.liquidityPool.findMany.mockClear();
    await expect(service.getPools("DEPRECATED")).resolves.toEqual([]);
    expect(prisma.liquidityPool.findMany).not.toHaveBeenCalled();

    prisma.liquidityPool.findMany.mockResolvedValue([]);
    await service.getPools();
    expect(prisma.liquidityPool.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });

  it("returns a durable pool by ID and a stable missing-pool error", async () => {
    const { prisma, service } = setup();
    prisma.liquidityPool.findUnique.mockResolvedValueOnce(pool());

    await expect(service.getPool("pool-usdc-usdt")).resolves.toMatchObject({
      id: "pool-usdc-usdt",
      dataSource: "DATABASE_SNAPSHOT",
    });
    expect(prisma.liquidityPool.findUnique).toHaveBeenCalledWith({
      where: { id: "pool-usdc-usdt" },
    });

    prisma.liquidityPool.findUnique.mockResolvedValueOnce(null);
    await expect(service.getPool("missing-pool")).rejects.toMatchObject({
      code: "POOL_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("tenant-scopes positions to the authenticated business wallet", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.lPPosition.findMany.mockResolvedValue([
      {
        id: "position-1",
        poolId: "pool-usdc-usdt",
        provider: wallet,
        liquidity: new Prisma.Decimal("199"),
        lowerTick: -10,
        upperTick: 10,
        feesEarned: new Prisma.Decimal("1.25"),
        createdAt: now,
        pool: pool(),
      },
    ]);

    const positions = await service.getPositions("business-1", wallet, {
      page: 1,
      limit: 10,
    });

    expect(positions[0]).toEqual(
      expect.objectContaining({
        businessId: "business-1",
        provider: wallet,
        sharePercentage: 10,
        impermanentLoss: null,
      }),
    );
    expect(prisma.lPPosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider: { equals: wallet, mode: "insensitive" } },
        take: 10,
      }),
    );
  });

  it("rejects a provider filter that does not match the tenant", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });

    await expect(
      service.getPositions(
        "business-1",
        "0x2222222222222222222222222222222222222222",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(prisma.lPPosition.findMany).not.toHaveBeenCalled();
  });

  it("fails before querying positions when the business is missing", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue(null);

    await expect(
      service.getPositions("missing-business"),
    ).rejects.toMatchObject({ code: "BUSINESS_NOT_FOUND", statusCode: 404 });
    expect(prisma.lPPosition.findMany).not.toHaveBeenCalled();
  });

  it("handles empty-pool math without dividing by zero", async () => {
    const { prisma, service } = setup();
    prisma.business.findUnique.mockResolvedValue({ address: wallet });
    prisma.lPPosition.findMany.mockResolvedValue([
      {
        id: "position-empty-pool",
        poolId: "empty-pool",
        provider: wallet,
        liquidity: new Prisma.Decimal("0"),
        lowerTick: -10,
        upperTick: 10,
        feesEarned: new Prisma.Decimal("0"),
        createdAt: now,
        pool: pool({
          id: "empty-pool",
          totalLiquidity: new Prisma.Decimal("0"),
          reserveA: new Prisma.Decimal("0"),
          reserveB: new Prisma.Decimal("0"),
        }),
      },
    ]);

    const positions = await service.getPositions("business-1");

    expect(positions[0]).toMatchObject({
      sharePercentage: 0,
      entryPrice: null,
    });
    expect(prisma.lPPosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: undefined, take: undefined }),
    );
  });

  it("fails every unverified liquidity mutation closed", async () => {
    const { service } = setup();
    await expect(
      service.addLiquidity(
        { poolId: "pool-1", amountA: "1", amountB: "1" },
        wallet,
        "business-1",
      ),
    ).rejects.toMatchObject({
      code: "ONCHAIN_SETTLEMENT_UNAVAILABLE",
      statusCode: 501,
    });
    await expect(
      service.removeLiquidity(
        { positionId: "position-1", percentage: 100 },
        wallet,
        "business-1",
      ),
    ).rejects.toMatchObject({ statusCode: 501 });
    await expect(
      service.requestFlashLiquidity("pool-1", "100", wallet),
    ).rejects.toMatchObject({
      code: "FLASH_LIQUIDITY_UNAVAILABLE",
      statusCode: 501,
    });
  });

  it("derives analytics only from persisted pool snapshots", async () => {
    const { prisma, service } = setup();
    prisma.liquidityPool.findMany.mockResolvedValue([
      pool(),
      pool({
        id: "pool-2",
        totalLiquidity: new Prisma.Decimal("10"),
        volume24h: new Prisma.Decimal("5"),
        feesCollected: new Prisma.Decimal("0.5"),
      }),
    ]);

    const analytics = await service.getAnalytics("business-1");

    expect(analytics).toEqual(
      expect.objectContaining({
        totalTVL: "2000",
        totalVolume24h: "255",
        totalFeesGenerated: "4",
        avgUtilization: null,
        rebalancingAlerts: [],
      }),
    );
  });

  it("reports the latest snapshot timestamp and an explicit null for no pools", async () => {
    const { prisma, service } = setup();
    const earlier = new Date("2026-07-20T12:00:00.000Z");
    prisma.liquidityPool.findMany.mockResolvedValue([
      pool({ id: "newer", updatedAt: now }),
      pool({ id: "older", updatedAt: earlier }),
    ]);

    await expect(service.getAnalytics()).resolves.toMatchObject({ asOf: now });

    prisma.liquidityPool.findMany.mockResolvedValue([]);
    await expect(service.getAnalytics()).resolves.toMatchObject({
      poolCount: 0,
      totalTVL: "0",
      asOf: null,
      topPools: [],
    });
  });
});
