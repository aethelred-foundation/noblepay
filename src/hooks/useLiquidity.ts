/**
 * Liquidity Hooks — Custom React hooks for NoblePay liquidity pools.
 *
 * Provides typed hooks for liquidity pool data, LP positions,
 * and pool analytics.
 */

import { useState, useEffect, useCallback } from 'react';
import type { LiquidityPool, LPPosition } from '@/types/defi';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_POOLS: LiquidityPool[] = [
  {
    address: '0xpool001',
    name: 'USDC / AET',
    tokenA: 'USDC',
    tokenB: 'AET',
    tvl: 8_500_000,
    volume24h: 1_200_000,
    apy: 12.3,
    feeBps: 30,
    status: 'Active',
    reserveA: 4_250_000,
    reserveB: 2_833_333,
    lpCount: 142,
    createdAt: Date.now() - 90 * 86_400_000,
  },
  {
    address: '0xpool002',
    name: 'USDC / USDT',
    tokenA: 'USDC',
    tokenB: 'USDT',
    tvl: 15_200_000,
    volume24h: 3_400_000,
    apy: 4.8,
    feeBps: 5,
    status: 'Active',
    reserveA: 7_600_000,
    reserveB: 7_600_000,
    lpCount: 315,
    createdAt: Date.now() - 120 * 86_400_000,
  },
  {
    address: '0xpool003',
    name: 'AET / AED',
    tokenA: 'AET',
    tokenB: 'AED',
    tvl: 2_100_000,
    volume24h: 450_000,
    apy: 18.7,
    feeBps: 50,
    status: 'Active',
    reserveA: 700_000,
    reserveB: 1_400_000,
    lpCount: 67,
    createdAt: Date.now() - 45 * 86_400_000,
  },
  {
    address: '0xpool004',
    name: 'USDC / AED',
    tokenA: 'USDC',
    tokenB: 'AED',
    tvl: 5_600_000,
    volume24h: 890_000,
    apy: 6.2,
    feeBps: 10,
    status: 'Active',
    reserveA: 2_800_000,
    reserveB: 10_290_000,
    lpCount: 198,
    createdAt: Date.now() - 60 * 86_400_000,
  },
];

const MOCK_POSITIONS: LPPosition[] = [
  {
    id: 'pos-001',
    poolAddress: '0xpool001',
    poolName: 'USDC / AET',
    lpTokens: 45_000,
    poolShare: 2.1,
    valueUsd: 178_500,
    unclaimedFees: 1_240,
    impermanentLoss: -0.8,
    enteredAt: Date.now() - 30 * 86_400_000,
  },
  {
    id: 'pos-002',
    poolAddress: '0xpool002',
    poolName: 'USDC / USDT',
    lpTokens: 120_000,
    poolShare: 0.79,
    valueUsd: 120_080,
    unclaimedFees: 480,
    impermanentLoss: -0.01,
    enteredAt: Date.now() - 60 * 86_400_000,
  },
];

// ---------------------------------------------------------------------------
// Pool analytics type
// ---------------------------------------------------------------------------

export interface PoolAnalytics {
  totalTvl: number;
  totalVolume24h: number;
  totalPools: number;
  avgApy: number;
  totalFeesEarned24h: number;
}

// ---------------------------------------------------------------------------
// useLiquidity — pool data, positions, and analytics
// ---------------------------------------------------------------------------

export function useLiquidity() {
  const [pools, setPools] = useState<LiquidityPool[]>([]);
  const [positions, setPositions] = useState<LPPosition[]>([]);
  const [analytics, setAnalytics] = useState<PoolAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPools(MOCK_POOLS);
      setPositions(MOCK_POSITIONS);
      setAnalytics({
        totalTvl: MOCK_POOLS.reduce((sum, p) => sum + p.tvl, 0),
        totalVolume24h: MOCK_POOLS.reduce((sum, p) => sum + p.volume24h, 0),
        totalPools: MOCK_POOLS.length,
        avgApy: MOCK_POOLS.reduce((sum, p) => sum + p.apy, 0) / MOCK_POOLS.length,
        totalFeesEarned24h: MOCK_POOLS.reduce((sum, p) => sum + (p.volume24h * p.feeBps) / 10_000, 0),
      });
      setIsLoading(false);
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  const addLiquidity = useCallback(
    (poolAddress: string, amountA: number, amountB: number) => {
      setPools((prev) =>
        prev.map((p) =>
          p.address === poolAddress
            ? { ...p, tvl: p.tvl + amountA + amountB, reserveA: p.reserveA + amountA, reserveB: p.reserveB + amountB }
            : p,
        ),
      );
    },
    [],
  );

  const removeLiquidity = useCallback(
    (positionId: string) => {
      setPositions((prev) => prev.filter((p) => p.id !== positionId));
    },
    [],
  );

  const claimFees = useCallback(
    (positionId: string) => {
      setPositions((prev) =>
        prev.map((p) =>
          p.id === positionId ? { ...p, unclaimedFees: 0 } : p,
        ),
      );
    },
    [],
  );

  return {
    pools,
    positions,
    analytics,
    isLoading,
    addLiquidity,
    removeLiquidity,
    claimFees,
  };
}
