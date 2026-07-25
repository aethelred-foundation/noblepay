import { Prisma, PrismaClient } from "@prisma/client";
import { AuditService } from "./audit";

export type PoolStatus = "ACTIVE" | "PAUSED" | "DEPRECATED";
export type LPTier = "RETAIL" | "INSTITUTIONAL" | "MARKET_MAKER";
interface PaginationOptions {
  page: number;
  limit: number;
}

export interface LiquidityPoolRecord {
  id: string;
  pair: string;
  tokenA: string;
  tokenB: string;
  reserveA: string;
  reserveB: string;
  totalLiquidity: string;
  tvl: string;
  apy: null;
  feeRate: number;
  utilization: null;
  volume24h: string;
  volume7d: null;
  feesCollected: string;
  status: PoolStatus;
  minLiquidity: null;
  circuitBreakerThreshold: null;
  createdAt: Date;
  updatedAt: Date;
  dataSource: "DATABASE_SNAPSHOT";
}

export interface LPPositionRecord {
  id: string;
  businessId: string;
  poolId: string;
  provider: string;
  tier: null;
  liquidityAmount: string;
  sharePercentage: number;
  rangeMin: number;
  rangeMax: number;
  feesEarned: string;
  impermanentLoss: null;
  entryPrice: number | null;
  createdAt: Date;
  lastClaimedAt: null;
}

export interface AddLiquidityInput {
  poolId: string;
  amountA: string;
  amountB: string;
  rangeMin?: number;
  rangeMax?: number;
  tier?: LPTier;
}

export interface RemoveLiquidityInput {
  positionId: string;
  percentage: number;
}

export interface PoolAnalytics {
  totalTVL: string;
  totalVolume24h: string;
  totalFeesGenerated: string;
  poolCount: number;
  avgUtilization: null;
  topPools: Array<{
    pair: string;
    tvl: string;
    apy: null;
    volume24h: string;
  }>;
  rebalancingAlerts: [];
  asOf: Date | null;
  dataSource: "DATABASE_SNAPSHOT";
}

type PositionWithPool = Prisma.LPPositionGetPayload<{
  include: { pool: true };
}>;

function poolRecord(
  pool: Prisma.LiquidityPoolGetPayload<Record<string, never>>,
): LiquidityPoolRecord {
  return {
    id: pool.id,
    pair: `${pool.tokenA}/${pool.tokenB}`,
    tokenA: pool.tokenA,
    tokenB: pool.tokenB,
    reserveA: pool.reserveA.toString(),
    reserveB: pool.reserveB.toString(),
    totalLiquidity: pool.totalLiquidity.toString(),
    tvl: pool.totalLiquidity.toString(),
    apy: null,
    feeRate: pool.feeRate.toNumber(),
    utilization: null,
    volume24h: pool.volume24h.toString(),
    volume7d: null,
    feesCollected: pool.feesCollected.toString(),
    status: pool.isActive ? "ACTIVE" : "PAUSED",
    minLiquidity: null,
    circuitBreakerThreshold: null,
    createdAt: pool.createdAt,
    updatedAt: pool.updatedAt,
    dataSource: "DATABASE_SNAPSHOT",
  };
}

/**
 * Read-only view over durable liquidity snapshots.
 *
 * Pool and position mutations are contract transactions. Until the backend is
 * configured to submit and verify their receipts, every mutation fails closed
 * rather than changing database balances that did not move on-chain.
 */
export class LiquidityService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly _auditService: AuditService,
  ) {}

  async getPools(
    status?: PoolStatus,
    pagination?: PaginationOptions,
  ): Promise<LiquidityPoolRecord[]> {
    if (status === "DEPRECATED") return [];
    const pools = await this.prisma.liquidityPool.findMany({
      where:
        status === "ACTIVE"
          ? { isActive: true }
          : status === "PAUSED"
            ? { isActive: false }
            : undefined,
      orderBy: { totalLiquidity: "desc" },
      skip: pagination ? (pagination.page - 1) * pagination.limit : undefined,
      take: pagination?.limit,
    });
    return pools.map(poolRecord);
  }

  async getPool(poolId: string): Promise<LiquidityPoolRecord> {
    const pool = await this.prisma.liquidityPool.findUnique({
      where: { id: poolId },
    });
    if (!pool) {
      throw new LiquidityError("POOL_NOT_FOUND", "Pool not found", 404);
    }
    return poolRecord(pool);
  }

  async getPositions(
    businessId: string,
    requestedProvider?: string,
    pagination?: PaginationOptions,
  ): Promise<LPPositionRecord[]> {
    const business = await this.prisma.business.findUnique({
      where: { id: businessId },
      select: { address: true },
    });
    if (!business) {
      throw new LiquidityError(
        "BUSINESS_NOT_FOUND",
        "Authenticated business was not found",
        404,
      );
    }
    if (
      requestedProvider &&
      requestedProvider.toLowerCase() !== business.address.toLowerCase()
    ) {
      throw new LiquidityError(
        "FORBIDDEN",
        "Liquidity positions can only be read for the authenticated wallet",
        403,
      );
    }

    const positions = await this.prisma.lPPosition.findMany({
      where: {
        provider: { equals: business.address, mode: "insensitive" },
      },
      include: { pool: true },
      orderBy: { createdAt: "desc" },
      skip: pagination ? (pagination.page - 1) * pagination.limit : undefined,
      take: pagination?.limit,
    });
    return positions.map((position: PositionWithPool) => {
      const total = position.pool.totalLiquidity.toNumber();
      const liquidity = position.liquidity.toNumber();
      const reserveA = position.pool.reserveA.toNumber();
      const reserveB = position.pool.reserveB.toNumber();
      return {
        id: position.id,
        businessId,
        poolId: position.poolId,
        provider: position.provider,
        tier: null,
        liquidityAmount: position.liquidity.toString(),
        sharePercentage: total > 0 ? (liquidity / total) * 100 : 0,
        rangeMin: position.lowerTick,
        rangeMax: position.upperTick,
        feesEarned: position.feesEarned.toString(),
        impermanentLoss: null,
        entryPrice: reserveA > 0 ? reserveB / reserveA : null,
        createdAt: position.createdAt,
        lastClaimedAt: null,
      };
    });
  }

  async addLiquidity(
    _input: AddLiquidityInput,
    _provider: string,
    _businessId: string,
  ): Promise<never> {
    throw this.settlementUnavailable();
  }

  async removeLiquidity(
    _input: RemoveLiquidityInput,
    _actor: string,
    _businessId?: string,
  ): Promise<never> {
    throw this.settlementUnavailable();
  }

  async requestFlashLiquidity(
    _poolId: string,
    _amount: string,
    _borrower: string,
  ): Promise<never> {
    throw new LiquidityError(
      "FLASH_LIQUIDITY_UNAVAILABLE",
      "Flash liquidity is disabled until an atomic contract receipt verifier is configured",
      501,
    );
  }

  async getAnalytics(_businessId?: string): Promise<PoolAnalytics> {
    const pools = await this.prisma.liquidityPool.findMany({
      where: { isActive: true },
      orderBy: { totalLiquidity: "desc" },
    });
    const totalTVL = pools.reduce(
      (sum, pool) => sum.add(pool.totalLiquidity),
      new Prisma.Decimal(0),
    );
    const totalVolume24h = pools.reduce(
      (sum, pool) => sum.add(pool.volume24h),
      new Prisma.Decimal(0),
    );
    const totalFees = pools.reduce(
      (sum, pool) => sum.add(pool.feesCollected),
      new Prisma.Decimal(0),
    );
    const asOf = pools.reduce<Date | null>(
      (latest, pool) =>
        !latest || pool.updatedAt > latest ? pool.updatedAt : latest,
      null,
    );

    return {
      totalTVL: totalTVL.toString(),
      totalVolume24h: totalVolume24h.toString(),
      totalFeesGenerated: totalFees.toString(),
      poolCount: pools.length,
      avgUtilization: null,
      topPools: pools.slice(0, 5).map((pool) => ({
        pair: `${pool.tokenA}/${pool.tokenB}`,
        tvl: pool.totalLiquidity.toString(),
        apy: null,
        volume24h: pool.volume24h.toString(),
      })),
      rebalancingAlerts: [],
      asOf,
      dataSource: "DATABASE_SNAPSHOT",
    };
  }

  private settlementUnavailable(): LiquidityError {
    return new LiquidityError(
      "ONCHAIN_SETTLEMENT_UNAVAILABLE",
      "Liquidity changes are disabled until the pool contract transaction and receipt verifier are configured",
      501,
    );
  }
}

export class LiquidityError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "LiquidityError";
  }
}
