/**
 * Liquidity hooks — real reads and writes against the deployed LiquidityPool.
 *
 * Pools are discovered from PoolCreated events (pool ids are hash-derived and
 * cannot be enumerated), then enriched with live getPool / getPoolUtilization /
 * getPoolHealth state. The connected wallet's positions come from its
 * LiquidityAdded events, filtered to those still active on-chain.
 *
 * Writes go through useSafeWriteContract (GAS-01 buffering). Adding liquidity
 * is an approve-approve-deposit flow surfaced as one async call with a stage
 * indicator; allowances that already cover the amount are skipped.
 */

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { useSafeWriteContract } from "./useSafeWriteContract";
import { useClientRef } from "./useClientRef";
import { CONTRACT_ADDRESSES, activeChain } from "@/config/chains";
import { ERC20_ABI, LIQUIDITY_POOL_ABI } from "@/config/abis";

const POOL = CONTRACT_ADDRESSES.liquidityPool as `0x${string}`;

/**
 * De-duplicate raw event logs. The Aethelred node's eth_getLogs can return the
 * same log more than once for a single query, which would otherwise render one
 * pool/position as two. Keyed by transactionHash + logIndex (unique per log).
 */
function dedupeLogs<T extends { transactionHash?: string | null; logIndex?: number | null }>(
  logs: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const log of logs) {
    const key = `${log.transactionHash ?? ""}:${log.logIndex ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(log);
  }
  return out;
}

// Full-range position bounds (contract MIN_TICK/MAX_TICK, TICK_SPACING = 10).
export const FULL_RANGE_TICK_LOWER = -887220;
export const FULL_RANGE_TICK_UPPER = 887220;

export interface PoolInfo {
  poolId: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  reserve0: bigint;
  reserve1: bigint;
  feeRateBP: number;
  utilizationBP: number;
  /** Contract PoolHealthStatus enum: 0 Healthy, 1 Warning, 2 Critical. */
  health: number;
  active: boolean;
}

export interface PositionInfo {
  positionId: `0x${string}`;
  poolId: `0x${string}`;
  amount0: bigint;
  amount1: bigint;
  fees0: bigint;
  fees1: bigint;
  createdAt: number;
  active: boolean;
}

interface RawPool {
  token0: `0x${string}`;
  token1: `0x${string}`;
  reserveToken0: bigint;
  reserveToken1: bigint;
  totalLiquidity: bigint;
  feeRateBP: bigint;
  flashFeeRateBP: bigint;
  currentTick: number;
  createdAt: bigint;
  active: boolean;
}

interface RawPosition {
  provider: `0x${string}`;
  amountToken0: bigint;
  amountToken1: bigint;
  tickLower: number;
  tickUpper: number;
  feesEarnedToken0: bigint;
  feesEarnedToken1: bigint;
  createdAt: bigint;
  lastUpdatedAt: bigint;
  active: boolean;
}

export function usePools(): {
  pools: PoolInfo[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { ref: clientRef, ready } = useClientRef();
  const [pools, setPools] = useState<PoolInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !POOL) return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const created = await publicClient.getContractEvents({
          address: POOL,
          abi: LIQUIDITY_POOL_ABI,
          eventName: "PoolCreated",
          fromBlock: 0n,
          toBlock: "latest",
        });

        const tokenMetaCache = new Map<string, { symbol: string; decimals: number }>();
        const tokenMeta = async (token: `0x${string}`) => {
          const hit = tokenMetaCache.get(token);
          if (hit) return hit;
          const [symbol, decimals] = await Promise.all([
            publicClient.readContract({
              address: token,
              abi: ERC20_ABI,
              functionName: "symbol",
            }) as Promise<string>,
            publicClient.readContract({
              address: token,
              abi: ERC20_ABI,
              functionName: "decimals",
            }) as Promise<number>,
          ]);
          const meta = { symbol, decimals: Number(decimals) };
          tokenMetaCache.set(token, meta);
          return meta;
        };

        const out = await Promise.all(
          dedupeLogs(created).map(async (log) => {
            const poolId = (log.args as { poolId?: `0x${string}` }).poolId as `0x${string}`;
            const [pool, utilization, health] = await Promise.all([
              publicClient.readContract({
                address: POOL,
                abi: LIQUIDITY_POOL_ABI,
                functionName: "getPool",
                args: [poolId],
              }) as Promise<RawPool>,
              publicClient.readContract({
                address: POOL,
                abi: LIQUIDITY_POOL_ABI,
                functionName: "getPoolUtilization",
                args: [poolId],
              }) as Promise<bigint>,
              publicClient.readContract({
                address: POOL,
                abi: LIQUIDITY_POOL_ABI,
                functionName: "getPoolHealth",
                args: [poolId],
              }) as Promise<number>,
            ]);
            const [meta0, meta1] = await Promise.all([
              tokenMeta(pool.token0),
              tokenMeta(pool.token1),
            ]);
            return {
              poolId,
              token0: pool.token0,
              token1: pool.token1,
              symbol0: meta0.symbol,
              symbol1: meta1.symbol,
              decimals0: meta0.decimals,
              decimals1: meta1.decimals,
              reserve0: pool.reserveToken0,
              reserve1: pool.reserveToken1,
              feeRateBP: Number(pool.feeRateBP),
              utilizationBP: Number(utilization),
              health: Number(health),
              active: pool.active,
            } satisfies PoolInfo;
          }),
        );
        if (!cancelled) setPools(out);
      } catch (err) {
        if (!cancelled) setError(err as Error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientRef, ready, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { pools, isLoading, error, refetch };
}

export function useMyPositions(): {
  positions: PositionInfo[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { address } = useAccount();
  const { ref: clientRef, ready } = useClientRef();
  const [positions, setPositions] = useState<PositionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !POOL || !address) {
      setPositions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const added = await publicClient.getContractEvents({
          address: POOL,
          abi: LIQUIDITY_POOL_ABI,
          eventName: "LiquidityAdded",
          args: { provider: address },
          fromBlock: 0n,
          toBlock: "latest",
        });
        const out = await Promise.all(
          dedupeLogs(added).map(async (log) => {
            const a = log.args as { positionId?: `0x${string}`; poolId?: `0x${string}` };
            const positionId = a.positionId as `0x${string}`;
            const pos = (await publicClient.readContract({
              address: POOL,
              abi: LIQUIDITY_POOL_ABI,
              functionName: "getPosition",
              args: [positionId],
            })) as RawPosition;
            return {
              positionId,
              poolId: a.poolId as `0x${string}`,
              amount0: pos.amountToken0,
              amount1: pos.amountToken1,
              fees0: pos.feesEarnedToken0,
              fees1: pos.feesEarnedToken1,
              createdAt: Number(pos.createdAt),
              active: pos.active,
            } satisfies PositionInfo;
          }),
        );
        if (!cancelled) setPositions(out.filter((p) => p.active));
      } catch (err) {
        if (!cancelled) setError(err as Error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientRef, ready, address, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { positions, isLoading, error, refetch };
}

export type AddLiquidityStage = "idle" | "approve0" | "approve1" | "deposit";

export function useAddLiquidity() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: activeChain.id });
  const { writeContractAsync } = useSafeWriteContract();
  const [stage, setStage] = useState<AddLiquidityStage>("idle");

  /**
   * Approves both legs (skipping tokens whose allowance already covers the
   * amount) and opens a full-range position. Resolves with the addLiquidity
   * tx hash once it is mined successfully; throws on any failure.
   */
  const addLiquidity = useCallback(
    async (pool: PoolInfo, amount0: bigint, amount1: bigint) => {
      if (!publicClient) throw new Error("No RPC connection");
      if (!address) throw new Error("Wallet not connected");

      const ensureAllowance = async (
        token: `0x${string}`,
        amount: bigint,
        approveStage: AddLiquidityStage,
      ) => {
        if (amount === 0n) return;
        const allowance = (await publicClient.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [address, POOL],
        })) as bigint;
        if (allowance >= amount) return;
        setStage(approveStage);
        const hash = (await writeContractAsync({
          address: token,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [POOL, amount],
        })) as `0x${string}`;
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("Token approval reverted");
      };

      try {
        await ensureAllowance(pool.token0, amount0, "approve0");
        await ensureAllowance(pool.token1, amount1, "approve1");

        setStage("deposit");
        const hash = (await writeContractAsync({
          address: POOL,
          abi: LIQUIDITY_POOL_ABI,
          functionName: "addLiquidity",
          args: [pool.poolId, amount0, amount1, FULL_RANGE_TICK_LOWER, FULL_RANGE_TICK_UPPER],
        })) as `0x${string}`;
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("addLiquidity reverted");
        return hash;
      } finally {
        setStage("idle");
      }
    },
    [publicClient, address, writeContractAsync],
  );

  return { addLiquidity, stage };
}

export function useRemoveLiquidity() {
  const publicClient = usePublicClient({ chainId: activeChain.id });
  const { writeContractAsync } = useSafeWriteContract();
  const [isRemoving, setIsRemoving] = useState(false);

  const removeLiquidity = useCallback(
    async (poolId: `0x${string}`, positionId: `0x${string}`) => {
      if (!publicClient) throw new Error("No RPC connection");
      setIsRemoving(true);
      try {
        const hash = (await writeContractAsync({
          address: POOL,
          abi: LIQUIDITY_POOL_ABI,
          functionName: "removeLiquidity",
          args: [poolId, positionId],
        })) as `0x${string}`;
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("removeLiquidity reverted");
        return hash;
      } finally {
        setIsRemoving(false);
      }
    },
    [publicClient, writeContractAsync],
  );

  return { removeLiquidity, isRemoving };
}
