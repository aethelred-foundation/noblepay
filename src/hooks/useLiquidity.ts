import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiRequest } from "@/lib/api";
import type { LiquidityPool, LPPosition } from "@/types/defi";

export interface PoolAnalytics {
  totalTvl: number;
  totalVolume24h: number;
  totalPools: number;
  avgApy: number | null;
  totalFeesEarned24h: number;
}

interface ApiPool {
  id: string;
  pair: string;
  tokenA: string;
  tokenB: string;
  reserveA: string;
  reserveB: string;
  tvl: string;
  apy: number | null;
  feeRate: number;
  volume24h: string;
  status: "ACTIVE" | "PAUSED" | "DEPRECATED";
  createdAt: string;
}

interface ApiPosition {
  id: string;
  poolId: string;
  liquidityAmount: string;
  sharePercentage: number;
  feesEarned: string;
  impermanentLoss: string | null;
  createdAt: string;
}

interface ApiAnalytics {
  totalTVL: string;
  totalVolume24h: string;
  totalFeesGenerated: string;
  poolCount: number;
}

export function useLiquidity() {
  const poolsQuery = useQuery({
    queryKey: ["liquidity", "pools"],
    queryFn: ({ signal }) =>
      apiRequest<ApiPool[]>("/v1/liquidity/pools", { signal }),
  });
  const positionsQuery = useQuery({
    queryKey: ["liquidity", "positions"],
    queryFn: ({ signal }) =>
      apiRequest<ApiPosition[]>("/v1/liquidity/positions", { signal }),
  });
  const analyticsQuery = useQuery({
    queryKey: ["liquidity", "analytics"],
    queryFn: ({ signal }) =>
      apiRequest<ApiAnalytics>("/v1/liquidity/analytics", { signal }),
  });

  const poolById = useMemo(
    () => new Map((poolsQuery.data || []).map((pool) => [pool.id, pool])),
    [poolsQuery.data],
  );
  const pools = useMemo<LiquidityPool[]>(
    () =>
      (poolsQuery.data || []).map((pool) => ({
        address: pool.id,
        name: pool.pair,
        tokenA: pool.tokenA,
        tokenB: pool.tokenB,
        tvl: Number(pool.tvl),
        volume24h: Number(pool.volume24h),
        apy: pool.apy,
        feeBps: pool.feeRate * 10_000,
        status:
          pool.status === "ACTIVE"
            ? "Active"
            : pool.status === "PAUSED"
              ? "Paused"
              : "Deprecated",
        reserveA: Number(pool.reserveA),
        reserveB: Number(pool.reserveB),
        lpCount: (positionsQuery.data || []).filter(
          (position) => position.poolId === pool.id,
        ).length,
        createdAt: Date.parse(pool.createdAt),
      })),
    [poolsQuery.data, positionsQuery.data],
  );
  const positions = useMemo<LPPosition[]>(
    () =>
      (positionsQuery.data || []).map((position) => ({
        id: position.id,
        poolAddress: position.poolId,
        poolName: poolById.get(position.poolId)?.pair || position.poolId,
        lpTokens: Number(position.liquidityAmount),
        poolShare: position.sharePercentage,
        valueUsd: null,
        unclaimedFees: Number(position.feesEarned),
        impermanentLoss:
          position.impermanentLoss === null
            ? null
            : Number(position.impermanentLoss),
        enteredAt: Date.parse(position.createdAt),
      })),
    [poolById, positionsQuery.data],
  );

  const unavailable = useCallback(async () => {
    throw new ApiError("Liquidity execution is not configured", {
      status: 501,
      code: "ONCHAIN_SETTLEMENT_UNAVAILABLE",
    });
  }, []);
  const refetch = useCallback(async () => {
    await Promise.all([
      poolsQuery.refetch(),
      positionsQuery.refetch(),
      analyticsQuery.refetch(),
    ]);
  }, [analyticsQuery, poolsQuery, positionsQuery]);
  const analytics: PoolAnalytics | null = analyticsQuery.data
    ? {
        totalTvl: Number(analyticsQuery.data.totalTVL),
        totalVolume24h: Number(analyticsQuery.data.totalVolume24h),
        totalPools: analyticsQuery.data.poolCount,
        avgApy: (() => {
          const quoted = pools.filter(
            (pool): pool is LiquidityPool & { apy: number } =>
              pool.apy !== null,
          );
          return quoted.length
            ? quoted.reduce((sum, pool) => sum + pool.apy, 0) / quoted.length
            : null;
        })(),
        totalFeesEarned24h: Number(analyticsQuery.data.totalFeesGenerated),
      }
    : null;

  return {
    pools,
    positions,
    analytics,
    isLoading:
      poolsQuery.isLoading ||
      positionsQuery.isLoading ||
      analyticsQuery.isLoading,
    isMutating: false,
    error:
      poolsQuery.error || positionsQuery.error || analyticsQuery.error || null,
    refetch,
    // The backend receipt verifier now exists, so the API accepts settlements.
    // This client still exposes no mutation helpers: liquidity is moved from
    // the provider's own wallet and then reported, so the write path belongs
    // to whichever surface holds the signer, not to this read hook.
    mutationsEnabled: false,
    mutationReason:
      "Liquidity is moved from your own wallet and then reported to the API, " +
      "which verifies the transaction receipt before recording it. This view " +
      "is read-only.",
    addLiquidity: unavailable,
    removeLiquidity: unavailable,
    claimFees: unavailable,
  };
}
