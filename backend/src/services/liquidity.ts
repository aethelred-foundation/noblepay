import { Prisma, PrismaClient } from "@prisma/client";
import { AuditService } from "./audit";
import {
  verifyFlashLoan,
  verifyLiquiditySettlement,
} from "./liquidity-execution";
import type { NoblePayChainConfiguration } from "../lib/production-config";

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

  /**
   * Record an on-chain liquidity addition.
   *
   * The service submits nothing. A provider adds liquidity from their own
   * wallet and reports the transaction; the position row is written only once
   * the chain corroborates it, and the provider on the event must match the
   * caller so one account cannot claim another's position.
   */
  async addLiquidity(
    input: AddLiquidityInput,
    provider: string,
    businessId: string,
    settlement: { txHash: string; onChainPositionId: string },
    config: NoblePayChainConfiguration,
  ): Promise<LPPositionRecord> {
    const pool = await this.prisma.liquidityPool.findUnique({
      where: { id: input.poolId },
    });
    if (!pool) {
      throw new LiquidityError("POOL_NOT_FOUND", "Pool not found", 404);
    }

    const existing = await this.prisma.lPPosition.findFirst({
      where: { settlementTxHash: settlement.txHash.toLowerCase() },
    });
    if (existing) {
      // Idempotent: the same settlement reported twice yields the same row
      // rather than a duplicate position.
      return this.toPositionRecord(existing, pool, businessId);
    }

    const verified = await verifyLiquiditySettlement(
      config,
      {
        txHash: settlement.txHash,
        onChainPositionId: settlement.onChainPositionId,
        kind: "ADD",
        expectedProvider: provider,
      },
      process.env,
    );

    const position = await this.prisma.lPPosition.create({
      data: {
        poolId: input.poolId,
        provider,
        // Amounts come from the event, not the request: the chain is the
        // authority on how much actually moved.
        liquidity: new Prisma.Decimal(verified.amountToken0).add(
          new Prisma.Decimal(verified.amountToken1),
        ),
        lowerTick: input.rangeMin ?? 0,
        upperTick: input.rangeMax ?? 0,
        onChainPositionId: verified.onChainPositionId,
        settlementTxHash: verified.txHash,
      },
    });

    await this._auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: provider,
      description: `Liquidity added on chain to pool ${input.poolId} via ${verified.txHash}`,
      severity: "MEDIUM",
      businessId,
      metadata: {
        poolId: input.poolId,
        onChainPositionId: verified.onChainPositionId,
        txHash: verified.txHash,
        blockNumber: verified.blockNumber,
        amountToken0: verified.amountToken0,
        amountToken1: verified.amountToken1,
      },
    });

    return this.toPositionRecord(position, pool, businessId);
  }

  /** Record an on-chain liquidity removal against an existing position. */
  async removeLiquidity(
    input: RemoveLiquidityInput,
    actor: string,
    businessId: string,
    settlement: { txHash: string; onChainPositionId: string },
    config: NoblePayChainConfiguration,
  ): Promise<{ positionId: string; txHash: string; blockNumber: number }> {
    const position = await this.prisma.lPPosition.findUnique({
      where: { id: input.positionId },
    });
    if (!position) {
      throw new LiquidityError("POSITION_NOT_FOUND", "Position not found", 404);
    }
    if (position.provider.toLowerCase() !== actor.toLowerCase()) {
      throw new LiquidityError(
        "NOT_POSITION_OWNER",
        "Only the position's provider may remove its liquidity",
        403,
      );
    }

    const verified = await verifyLiquiditySettlement(
      config,
      {
        txHash: settlement.txHash,
        onChainPositionId: settlement.onChainPositionId,
        kind: "REMOVE",
        expectedProvider: actor,
      },
      process.env,
    );

    await this.prisma.lPPosition.update({
      where: { id: position.id },
      data: { settlementTxHash: verified.txHash },
    });

    await this._auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `Liquidity removed on chain from position ${position.id} via ${verified.txHash}`,
      severity: "MEDIUM",
      businessId,
      metadata: {
        positionId: position.id,
        onChainPositionId: verified.onChainPositionId,
        txHash: verified.txHash,
        blockNumber: verified.blockNumber,
        percentage: input.percentage,
      },
    });

    return {
      positionId: position.id,
      txHash: verified.txHash,
      blockNumber: verified.blockNumber,
    };
  }

  /**
   * Record a completed flash loan.
   *
   * Verification requires the borrow AND its repayment in the same
   * transaction. That is the property that makes a flash loan safe, and a
   * receipt showing only the borrow describes value that left the pool
   * unsecured — so it is refused rather than recorded.
   */
  async requestFlashLiquidity(
    poolId: string,
    borrower: string,
    businessId: string,
    settlement: { txHash: string; flashLoanId: string },
    config: NoblePayChainConfiguration,
  ): Promise<{
    flashLoanId: string;
    amount: string;
    fee: string;
    txHash: string;
    blockNumber: number;
  }> {
    const verified = await verifyFlashLoan(
      config,
      {
        txHash: settlement.txHash,
        flashLoanId: settlement.flashLoanId,
        expectedBorrower: borrower,
      },
      process.env,
    );

    await this._auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: borrower,
      description: `Flash loan borrowed and repaid atomically in ${verified.txHash}`,
      severity: "HIGH",
      businessId,
      metadata: {
        poolId,
        flashLoanId: verified.flashLoanId,
        txHash: verified.txHash,
        blockNumber: verified.blockNumber,
        amount: verified.amount,
        fee: verified.fee,
        atomicRepaymentVerified: true,
      },
    });

    return {
      flashLoanId: verified.flashLoanId,
      amount: verified.amount,
      fee: verified.fee,
      txHash: verified.txHash,
      blockNumber: verified.blockNumber,
    };
  }

  /**
   * Map a stored position to the record shape getPositions already returns, so
   * a freshly settled position and a listed one are the same object to callers.
   */
  private toPositionRecord(
    position: {
      id: string;
      poolId: string;
      provider: string;
      liquidity: Prisma.Decimal;
      lowerTick: number;
      upperTick: number;
      feesEarned: Prisma.Decimal;
      createdAt: Date;
    },
    pool: {
      totalLiquidity: Prisma.Decimal;
      reserveA: Prisma.Decimal;
      reserveB: Prisma.Decimal;
    },
    businessId: string,
  ): LPPositionRecord {
    const total = pool.totalLiquidity.toNumber();
    const liquidity = position.liquidity.toNumber();
    const reserveA = pool.reserveA.toNumber();
    const reserveB = pool.reserveB.toNumber();
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
