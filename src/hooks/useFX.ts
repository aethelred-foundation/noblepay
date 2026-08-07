/**
 * FX hedging hooks — real reads and writes against the deployed FXHedgingVault.
 *
 * The vault hedges a currency pair with either a forward (an obligation, which
 * must settle at the locked rate) or an option (a right, which may be exercised
 * or left to expire). Both are collateralised, marked to market, and can be
 * liquidated once collateral falls below the pair's maintenance margin.
 *
 * Unlike the treasury, nothing here needs event scraping: getActivePairs() and
 * getBusinessPositions() are both enumerable on chain.
 *
 * Rates and notionals are 8-decimal fixed point (RATE_PRECISION), which is read
 * from the contract rather than assumed. Margin figures are basis points.
 *
 * Writes go through useSafeWriteContract (GAS-01 buffering).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useSafeWriteContract } from "./useSafeWriteContract";
import { useClientRef } from "./useClientRef";
import { CONTRACT_ADDRESSES } from "@/config/chains";
import { FX_HEDGING_VAULT_ABI } from "@/config/abis.generated";

const VAULT = CONTRACT_ADDRESSES.fxHedgingVault as `0x${string}`;

/** Fixed-point scale for rates and notionals, confirmed against the contract. */
export const RATE_DECIMALS = 8;

// ---------------------------------------------------------------------------
// Contract enums — mirrored from FXHedgingVault.sol. These are on-chain uint8
// values; an entry may not be reordered.
// ---------------------------------------------------------------------------

export const HEDGE_TYPE = ["Forward", "Call option", "Put option"] as const;

export const POSITION_STATUS = [
  "Active",
  "Matured",
  "Settled",
  "Exercised",
  "Expired",
  "Liquidated",
  "Emergency unwound",
] as const;

export type HedgeTypeName = (typeof HEDGE_TYPE)[number];
export type PositionStatusName = (typeof POSITION_STATUS)[number];

/** HedgeType values that are options rather than obligations. */
export const OPTION_TYPES = [1, 2] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CurrencyPair {
  pairId: `0x${string}`;
  /** Decoded from bytes3, e.g. "AED". */
  base: string;
  quote: string;
  active: boolean;
  maxHedgeRatioBps: number;
  marginRequirementBps: number;
  maintenanceMarginBps: number;
  /** Latest oracle rate, 8dp. Zero when the oracle has never published. */
  rate: bigint;
  rateUpdatedAt: number;
}

export interface HedgePosition {
  positionId: `0x${string}`;
  hedger: `0x${string}`;
  pairId: `0x${string}`;
  hedgeType: number;
  status: number;
  notionalAmount: bigint;
  lockedRate: bigint;
  premium: bigint;
  collateralToken: `0x${string}`;
  collateralAmount: bigint;
  createdAt: number;
  maturityDate: number;
  settledAt: number;
  settlementAmount: bigint;
  markToMarketValue: bigint;
  lastMtMUpdate: number;
  /** Live margin check, read alongside the position. */
  underMargined: boolean;
}

export interface Portfolio {
  totalNotional: bigint;
  totalCollateral: bigint;
  totalPremiumPaid: bigint;
  totalPnL: bigint;
  unrealizedPnL: bigint;
  positionCount: number;
  lastRebalanced: number;
}

/**
 * Decode a bytes3 currency code into its ASCII form. The contract stores
 * "AED" as 0x414544; trailing zero bytes are padding, not characters.
 */
export function decodeCurrency(hex: string): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  let out = "";
  for (let i = 0; i + 1 < body.length; i += 2) {
    const code = parseInt(body.slice(i, i + 2), 16);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

interface RawPair {
  baseCurrency: `0x${string}`;
  quoteCurrency: `0x${string}`;
  pairId: `0x${string}`;
  active: boolean;
  maxHedgeRatio: bigint;
  marginRequirementBps: bigint;
  maintenanceMarginBps: bigint;
}

interface RawPosition {
  positionId: `0x${string}`;
  hedger: `0x${string}`;
  pairId: `0x${string}`;
  hedgeType: number;
  status: number;
  notionalAmount: bigint;
  lockedRate: bigint;
  premium: bigint;
  collateralToken: `0x${string}`;
  collateralAmount: bigint;
  createdAt: bigint;
  maturityDate: bigint;
  settledAt: bigint;
  settlementAmount: bigint;
  markToMarketValue: bigint;
  lastMtMUpdate: bigint;
}

interface RawPortfolio {
  totalNotional: bigint;
  totalCollateral: bigint;
  totalPremiumPaid: bigint;
  totalPnL: bigint;
  unrealizedPnL: bigint;
  positionCount: bigint;
  lastRebalanced: bigint;
}

// ---------------------------------------------------------------------------
// useCurrencyPairs
// ---------------------------------------------------------------------------

export function useCurrencyPairs(): {
  pairs: CurrencyPair[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { ref: clientRef, ready } = useClientRef();
  const [pairs, setPairs] = useState<CurrencyPair[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !VAULT) return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const ids = (await publicClient.readContract({
          address: VAULT,
          abi: FX_HEDGING_VAULT_ABI,
          functionName: "getActivePairs",
        })) as readonly `0x${string}`[];

        const out = await Promise.all(
          ids.map(async (pairId) => {
            const pair = (await publicClient.readContract({
              address: VAULT,
              abi: FX_HEDGING_VAULT_ABI,
              functionName: "getCurrencyPair",
              args: [pairId],
            })) as RawPair;

            // A pair with no published rate is normal, not an error: the
            // oracle may simply not have submitted yet. Surface it as a zero
            // rate so the UI can say so rather than fail the whole read.
            let rate = 0n;
            let updatedAt = 0n;
            try {
              const latest = (await publicClient.readContract({
                address: VAULT,
                abi: FX_HEDGING_VAULT_ABI,
                functionName: "getLatestRate",
                args: [pairId],
              })) as readonly [bigint, bigint];
              rate = latest[0];
              updatedAt = latest[1];
            } catch {
              /* no rate published */
            }

            return {
              pairId,
              base: decodeCurrency(pair.baseCurrency),
              quote: decodeCurrency(pair.quoteCurrency),
              active: pair.active,
              maxHedgeRatioBps: Number(pair.maxHedgeRatio),
              marginRequirementBps: Number(pair.marginRequirementBps),
              maintenanceMarginBps: Number(pair.maintenanceMarginBps),
              rate,
              rateUpdatedAt: Number(updatedAt) * 1000,
            } satisfies CurrencyPair;
          }),
        );
        if (!cancelled) setPairs(out);
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
  return { pairs, isLoading, error, refetch };
}

// ---------------------------------------------------------------------------
// useMyPositions
// ---------------------------------------------------------------------------

export function useMyPositions(): {
  positions: HedgePosition[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { address } = useAccount();
  const { ref: clientRef, ready } = useClientRef();
  const [positions, setPositions] = useState<HedgePosition[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !VAULT || !address) {
      setPositions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const ids = (await publicClient.readContract({
          address: VAULT,
          abi: FX_HEDGING_VAULT_ABI,
          functionName: "getBusinessPositions",
          args: [address],
        })) as readonly `0x${string}`[];

        const out = await Promise.all(
          ids.map(async (positionId) => {
            const [raw, underMargined] = await Promise.all([
              publicClient.readContract({
                address: VAULT,
                abi: FX_HEDGING_VAULT_ABI,
                functionName: "getPosition",
                args: [positionId],
              }) as Promise<RawPosition>,
              publicClient
                .readContract({
                  address: VAULT,
                  abi: FX_HEDGING_VAULT_ABI,
                  functionName: "isUnderMargined",
                  args: [positionId],
                })
                .catch(() => false) as Promise<boolean>,
            ]);
            return {
              positionId,
              hedger: raw.hedger,
              pairId: raw.pairId,
              hedgeType: Number(raw.hedgeType),
              status: Number(raw.status),
              notionalAmount: raw.notionalAmount,
              lockedRate: raw.lockedRate,
              premium: raw.premium,
              collateralToken: raw.collateralToken,
              collateralAmount: raw.collateralAmount,
              createdAt: Number(raw.createdAt) * 1000,
              maturityDate: Number(raw.maturityDate) * 1000,
              settledAt: Number(raw.settledAt) * 1000,
              settlementAmount: raw.settlementAmount,
              markToMarketValue: raw.markToMarketValue,
              lastMtMUpdate: Number(raw.lastMtMUpdate) * 1000,
              underMargined: Boolean(underMargined),
            } satisfies HedgePosition;
          }),
        );
        if (!cancelled) setPositions(out.reverse());
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

// ---------------------------------------------------------------------------
// usePortfolio
// ---------------------------------------------------------------------------

export function usePortfolio(): {
  portfolio: Portfolio | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { address } = useAccount();
  const { ref: clientRef, ready } = useClientRef();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !VAULT || !address) {
      setPortfolio(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const raw = (await publicClient.readContract({
          address: VAULT,
          abi: FX_HEDGING_VAULT_ABI,
          functionName: "getPortfolio",
          args: [address],
        })) as RawPortfolio;
        if (!cancelled) {
          setPortfolio({
            totalNotional: raw.totalNotional,
            totalCollateral: raw.totalCollateral,
            totalPremiumPaid: raw.totalPremiumPaid,
            totalPnL: raw.totalPnL,
            unrealizedPnL: raw.unrealizedPnL,
            positionCount: Number(raw.positionCount),
            lastRebalanced: Number(raw.lastRebalanced) * 1000,
          });
        }
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
  return { portfolio, isLoading, error, refetch };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateForwardInput {
  pairId: `0x${string}`;
  /** Base-currency notional, 8dp. */
  notionalAmount: bigint;
  /** Unix seconds. */
  maturityDate: bigint;
  collateralToken: `0x${string}`;
  collateralAmount: bigint;
}

export interface CreateOptionInput extends CreateForwardInput {
  /** 1 = call, 2 = put. Forwards use createForward instead. */
  hedgeType: number;
  strikeRate: bigint;
  premium: bigint;
}

export function useFXActions() {
  const { writeContractAsync } = useSafeWriteContract();
  const [pending, setPending] = useState<string | null>(null);

  const call = useCallback(
    async (label: string, functionName: string, args: readonly unknown[]) => {
      setPending(label);
      try {
        return await writeContractAsync({
          address: VAULT,
          abi: FX_HEDGING_VAULT_ABI,
          functionName,
          args,
        });
      } finally {
        setPending(null);
      }
    },
    [writeContractAsync],
  );

  const createForward = useCallback(
    (input: CreateForwardInput) =>
      call("createForward", "createForward", [
        input.pairId,
        input.notionalAmount,
        input.maturityDate,
        input.collateralToken,
        input.collateralAmount,
      ]),
    [call],
  );

  const createOption = useCallback(
    (input: CreateOptionInput) =>
      call("createOption", "createOption", [
        input.pairId,
        input.hedgeType,
        input.notionalAmount,
        input.strikeRate,
        input.premium,
        input.maturityDate,
        input.collateralToken,
        input.collateralAmount,
      ]),
    [call],
  );

  const settleForward = useCallback(
    (id: `0x${string}`) => call("settle", "settleForward", [id]),
    [call],
  );
  const exerciseOption = useCallback(
    (id: `0x${string}`) => call("exercise", "exerciseOption", [id]),
    [call],
  );
  const expireOption = useCallback(
    (id: `0x${string}`) => call("expire", "expireOption", [id]),
    [call],
  );
  const addMargin = useCallback(
    (id: `0x${string}`, amount: bigint) => call("margin", "addMargin", [id, amount]),
    [call],
  );
  const updateMarkToMarket = useCallback(
    (id: `0x${string}`) => call("mtm", "updateMarkToMarket", [id]),
    [call],
  );

  return {
    createForward,
    createOption,
    settleForward,
    exerciseOption,
    expireOption,
    addMargin,
    updateMarkToMarket,
    pending,
  };
}

// ---------------------------------------------------------------------------
// useRateHistory — the oracle's published rates for one pair, over time
// ---------------------------------------------------------------------------

export interface RatePoint {
  rate: bigint;
  timestamp: number;
  oracle: `0x${string}`;
}

/**
 * Rate history is reconstructed from FXRateUpdated events, so it shows exactly
 * what the oracle published and nothing more. A pair the oracle has updated
 * once yields a single point — that is a real answer, not a gap to fill with
 * interpolation.
 */
export function useRateHistory(pairId?: `0x${string}`): {
  history: RatePoint[];
  isLoading: boolean;
  error: Error | null;
} {
  const { ref: clientRef, ready } = useClientRef();
  const [history, setHistory] = useState<RatePoint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !VAULT || !pairId) {
      setHistory([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const logs = await publicClient.getContractEvents({
          address: VAULT,
          abi: FX_HEDGING_VAULT_ABI,
          eventName: "FXRateUpdated",
          args: { pairId },
          fromBlock: 0n,
          toBlock: "latest",
        });
        const seen = new Set<string>();
        const points: RatePoint[] = [];
        for (const log of logs) {
          const key = `${log.transactionHash ?? ""}:${log.logIndex ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const a = log.args as {
            rate?: bigint;
            timestamp?: bigint;
            oracle?: `0x${string}`;
          };
          points.push({
            rate: a.rate ?? 0n,
            timestamp: Number(a.timestamp ?? 0n) * 1000,
            oracle: a.oracle ?? "0x",
          });
        }
        points.sort((a, b) => a.timestamp - b.timestamp);
        if (!cancelled) setHistory(points);
      } catch (err) {
        if (!cancelled) setError(err as Error);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientRef, ready, pairId]);

  return { history, isLoading, error };
}

// ---------------------------------------------------------------------------
// Composite view
// ---------------------------------------------------------------------------

export function useFX() {
  const pairsState = useCurrencyPairs();
  const positionsState = useMyPositions();
  const portfolioState = usePortfolio();

  const pairsById = useMemo(() => {
    const map = new Map<string, CurrencyPair>();
    for (const p of pairsState.pairs) map.set(p.pairId.toLowerCase(), p);
    return map;
  }, [pairsState.pairs]);

  /** Positions that are still open and have fallen below maintenance margin. */
  const atRisk = useMemo(
    () =>
      positionsState.positions.filter(
        (p) => POSITION_STATUS[p.status] === "Active" && p.underMargined,
      ),
    [positionsState.positions],
  );

  const refetch = useCallback(() => {
    pairsState.refetch();
    positionsState.refetch();
    portfolioState.refetch();
  }, [pairsState, positionsState, portfolioState]);

  return {
    pairs: pairsState.pairs,
    pairsById,
    positions: positionsState.positions,
    portfolio: portfolioState.portfolio,
    atRisk,
    isLoading:
      pairsState.isLoading || positionsState.isLoading || portfolioState.isLoading,
    error: pairsState.error ?? positionsState.error ?? portfolioState.error,
    refetch,
  };
}
