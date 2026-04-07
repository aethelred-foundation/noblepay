import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { generateOpaqueId } from "../lib/identifiers";
import { logger } from "../lib/logger";
import { AuditService } from "./audit";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PoolStatus = "ACTIVE" | "PAUSED" | "DEPRECATED";
export type LPTier = "RETAIL" | "INSTITUTIONAL" | "MARKET_MAKER";

export interface LiquidityPoolRecord {
  id: string;
  pair: string;
  tokenA: string;
  tokenB: string;
  reserveA: string;
  reserveB: string;
  totalLiquidity: string;
  tvl: string;
  apy: number;
  feeRate: number;
  utilization: number;
  volume24h: string;
  volume7d: string;
  status: PoolStatus;
  minLiquidity: string;
  circuitBreakerThreshold: number;
  createdAt: Date;
}

export interface LPPositionRecord {
  id: string;
  businessId: string;
  poolId: string;
  provider: string;
  tier: LPTier;
  liquidityAmount: string;
  sharePercentage: number;
  rangeMin: number;
  rangeMax: number;
  feesEarned: string;
  impermanentLoss: string;
  entryPrice: number;
  createdAt: Date;
  lastClaimedAt: Date | null;
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
  percentage: number; // 1-100
}

export interface FlashLiquidityRequest {
  id: string;
  poolId: string;
  amount: string;
  currency: string;
  borrower: string;
  fee: string;
  status: "PENDING" | "FULFILLED" | "REPAID" | "DEFAULTED";
  createdAt: Date;
  dueAt: Date;
}

export interface PoolAnalytics {
  totalTVL: string;
  totalVolume24h: string;
  totalFeesGenerated: string;
  poolCount: number;
  avgUtilization: number;
  topPools: Array<{ pair: string; tvl: string; apy: number; volume24h: string }>;
  rebalancingAlerts: Array<{ poolId: string; pair: string; severity: string; message: string }>;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class LiquidityService {
  private pools: Map<string, LiquidityPoolRecord> = new Map();
  private positions: Map<string, LPPositionRecord> = new Map();
  private flashRequests: Map<string, FlashLiquidityRequest> = new Map();

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
  ) {
    this.initializeDefaultPools();
  }

  private initializeDefaultPools(): void {
    const defaultPools: Omit<LiquidityPoolRecord, "id" | "createdAt">[] = [
      { pair: "AET/USDC", tokenA: "AET", tokenB: "USDC", reserveA: "2000000", reserveB: "4900000", totalLiquidity: "9800000", tvl: "9800000", apy: 12.5, feeRate: 0.003, utilization: 0.72, volume24h: "1250000", volume7d: "8750000", status: "ACTIVE", minLiquidity: "100000", circuitBreakerThreshold: 0.3 },
      { pair: "AET/AED", tokenA: "AET", tokenB: "AED", reserveA: "1500000", reserveB: "13511400", totalLiquidity: "7500000", tvl: "7500000", apy: 9.8, feeRate: 0.002, utilization: 0.58, volume24h: "890000", volume7d: "6230000", status: "ACTIVE", minLiquidity: "50000", circuitBreakerThreshold: 0.3 },
      { pair: "USDC/USDT", tokenA: "USDC", tokenB: "USDT", reserveA: "5000000", reserveB: "4998500", totalLiquidity: "10000000", tvl: "10000000", apy: 3.2, feeRate: 0.0005, utilization: 0.89, volume24h: "4500000", volume7d: "31500000", status: "ACTIVE", minLiquidity: "200000", circuitBreakerThreshold: 0.2 },
      { pair: "USDC/AED", tokenA: "USDC", tokenB: "AED", reserveA: "3000000", reserveB: "11017500", totalLiquidity: "6000000", tvl: "6000000", apy: 5.6, feeRate: 0.001, utilization: 0.65, volume24h: "750000", volume7d: "5250000", status: "ACTIVE", minLiquidity: "100000", circuitBreakerThreshold: 0.25 },
      { pair: "AET/USDT", tokenA: "AET", tokenB: "USDT", reserveA: "800000", reserveB: "1960000", totalLiquidity: "3920000", tvl: "3920000", apy: 14.2, feeRate: 0.003, utilization: 0.45, volume24h: "420000", volume7d: "2940000", status: "ACTIVE", minLiquidity: "50000", circuitBreakerThreshold: 0.3 },
    ];

    for (const pool of defaultPools) {
      const id = `pool-${pool.pair.replace("/", "-").toLowerCase()}`;
      this.pools.set(id, { ...pool, id, createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) });
    }
  }

  /**
   * Get all liquidity pools.
   */
  getPools(status?: PoolStatus): LiquidityPoolRecord[] {
    let pools = Array.from(this.pools.values());
    if (status) {
      pools = pools.filter((p) => p.status === status);
    }
    return pools.sort((a, b) => parseFloat(b.tvl) - parseFloat(a.tvl));
  }

  /**
   * Get a single pool by ID.
   */
  getPool(poolId: string): LiquidityPoolRecord {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new LiquidityError("POOL_NOT_FOUND", "Pool not found", 404);
    }
    return pool;
  }

  /**
   * Add liquidity to a pool with optional concentrated range.
   */
  async addLiquidity(
    input: AddLiquidityInput,
    provider: string,
    businessId: string,
  ): Promise<LPPositionRecord> {
    const pool = this.getPool(input.poolId);
    if (pool.status !== "ACTIVE") {
      throw new LiquidityError("POOL_INACTIVE", "Pool is not active", 409);
    }

    const positionId = generateOpaqueId("lp");

    const liquidityAmount = (parseFloat(input.amountA) + parseFloat(input.amountB)).toFixed(2);
    const sharePercentage = (parseFloat(liquidityAmount) / (parseFloat(pool.totalLiquidity) + parseFloat(liquidityAmount))) * 100;

    const position: LPPositionRecord = {
      id: positionId,
      businessId,
      poolId: input.poolId,
      provider,
      tier: input.tier || "RETAIL",
      liquidityAmount,
      sharePercentage,
      rangeMin: input.rangeMin || 0,
      rangeMax: input.rangeMax || Infinity,
      feesEarned: "0",
      impermanentLoss: "0",
      entryPrice: parseFloat(pool.reserveB) / parseFloat(pool.reserveA),
      createdAt: new Date(),
      lastClaimedAt: null,
    };

    // Update pool reserves
    pool.reserveA = (parseFloat(pool.reserveA) + parseFloat(input.amountA)).toFixed(2);
    pool.reserveB = (parseFloat(pool.reserveB) + parseFloat(input.amountB)).toFixed(2);
    pool.totalLiquidity = (parseFloat(pool.totalLiquidity) + parseFloat(liquidityAmount)).toFixed(2);
    pool.tvl = pool.totalLiquidity;
    this.pools.set(input.poolId, pool);
    this.positions.set(positionId, position);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: provider,
      description: `Liquidity added to ${pool.pair}: ${input.amountA} ${pool.tokenA} + ${input.amountB} ${pool.tokenB}`,
      severity: "INFO",
      metadata: { positionId, poolId: input.poolId, liquidityAmount },
    });

    logger.info("Liquidity added", {
      positionId,
      poolId: input.poolId,
      pair: pool.pair,
      liquidityAmount,
      sharePercentage: sharePercentage.toFixed(4),
    });

    return position;
  }

  /**
   * Remove liquidity from a position.
   */
  async removeLiquidity(
    input: RemoveLiquidityInput,
    actor: string,
    businessId?: string,
  ): Promise<{ amountA: string; amountB: string; feesCollected: string }> {
    const position = this.positions.get(input.positionId);
    if (!position) {
      throw new LiquidityError("POSITION_NOT_FOUND", "LP position not found", 404);
    }
    if (businessId && position.businessId !== businessId) {
      throw new LiquidityError("FORBIDDEN", "You do not have permission to remove this position", 403);
    }

    const pool = this.getPool(position.poolId);
    const removeFraction = input.percentage / 100;

    const amountA = (parseFloat(pool.reserveA) * position.sharePercentage / 100 * removeFraction).toFixed(2);
    const amountB = (parseFloat(pool.reserveB) * position.sharePercentage / 100 * removeFraction).toFixed(2);
    const feesCollected = (parseFloat(position.feesEarned) * removeFraction).toFixed(2);

    // Update pool
    pool.reserveA = (parseFloat(pool.reserveA) - parseFloat(amountA)).toFixed(2);
    pool.reserveB = (parseFloat(pool.reserveB) - parseFloat(amountB)).toFixed(2);
    pool.totalLiquidity = (parseFloat(pool.reserveA) + parseFloat(pool.reserveB)).toFixed(2);
    pool.tvl = pool.totalLiquidity;
    this.pools.set(position.poolId, pool);

    // Update or remove position
    if (input.percentage >= 100) {
      this.positions.delete(input.positionId);
    } else {
      position.liquidityAmount = (parseFloat(position.liquidityAmount) * (1 - removeFraction)).toFixed(2);
      position.sharePercentage *= 1 - removeFraction;
      position.feesEarned = (parseFloat(position.feesEarned) * (1 - removeFraction)).toFixed(2);
      this.positions.set(input.positionId, position);
    }

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `Liquidity removed from ${pool.pair}: ${amountA} ${pool.tokenA} + ${amountB} ${pool.tokenB}`,
      severity: "INFO",
      metadata: { positionId: input.positionId, percentage: input.percentage },
    });

    logger.info("Liquidity removed", {
      positionId: input.positionId,
      poolId: position.poolId,
      percentage: input.percentage,
      amountA,
      amountB,
    });

    return { amountA, amountB, feesCollected };
  }

  /**
   * Get LP positions for a provider.
   */
  getPositions(provider?: string, businessId?: string): LPPositionRecord[] {
    let positions = Array.from(this.positions.values());
    if (businessId) {
      positions = positions.filter((p) => p.businessId === businessId);
    }
    if (provider) {
      positions = positions.filter((p) => p.provider === provider);
    }
    return positions;
  }

  /**
   * Request flash liquidity for atomic settlement.
   */
  async requestFlashLiquidity(
    poolId: string,
    amount: string,
    borrower: string,
  ): Promise<FlashLiquidityRequest> {
    const pool = this.getPool(poolId);
    const fee = (parseFloat(amount) * 0.0009).toFixed(2); // 9 bps flash fee

    const request: FlashLiquidityRequest = {
      id: "flash-" + crypto.randomBytes(8).toString("hex"),
      poolId,
      amount,
      currency: pool.tokenA,
      borrower,
      fee,
      status: "FULFILLED",
      createdAt: new Date(),
      dueAt: new Date(Date.now() + 15 * 60 * 1000), // 15 min repayment window
    };

    this.flashRequests.set(request.id, request);

    logger.info("Flash liquidity fulfilled", {
      requestId: request.id,
      poolId,
      amount,
      fee,
    });

    return request;
  }

  /**
   * Get pool analytics across all pools.
   */
  getAnalytics(_businessId?: string): PoolAnalytics {
    const pools = this.getPools("ACTIVE");

    let totalTVL = 0;
    let totalVolume24h = 0;
    let totalFees = 0;
    let totalUtilization = 0;

    const rebalancingAlerts: PoolAnalytics["rebalancingAlerts"] = [];

    for (const pool of pools) {
      totalTVL += parseFloat(pool.tvl);
      totalVolume24h += parseFloat(pool.volume24h);
      totalFees += parseFloat(pool.volume24h) * pool.feeRate;
      totalUtilization += pool.utilization;

      // Check circuit breaker
      if (pool.utilization > 0.85) {
        rebalancingAlerts.push({
          poolId: pool.id,
          pair: pool.pair,
          severity: pool.utilization > 0.95 ? "CRITICAL" : "WARNING",
          message: `Pool utilization at ${(pool.utilization * 100).toFixed(1)}% — rebalancing recommended`,
        });
      }
    }

    return {
      totalTVL: totalTVL.toFixed(2),
      totalVolume24h: totalVolume24h.toFixed(2),
      totalFeesGenerated: totalFees.toFixed(2),
      poolCount: pools.length,
      avgUtilization: pools.length > 0 ? totalUtilization / pools.length : 0,
      topPools: pools
        .slice(0, 5)
        .map((p) => ({ pair: p.pair, tvl: p.tvl, apy: p.apy, volume24h: p.volume24h })),
      rebalancingAlerts,
    };
  }
}

// ─── Error Class ────────────────────────────────────────────────────────────

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
