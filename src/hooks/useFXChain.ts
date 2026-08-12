/**
 * FX state read from the FXHedgingVault contract, served through the backend's
 * /v1/fx/chain/* endpoints.
 *
 * Separate from useFX, which reads the database snapshot. The vault's
 * vocabulary is richer than the database's — three hedge types rather than
 * FORWARD | OPTION | SWAP, and seven statuses rather than four — so the chain
 * types are declared independently here instead of reusing HedgeType and
 * HedgeStatus from useFX. Reusing them would force LIQUIDATED and
 * EMERGENCY_UNWOUND into "CLOSED", hiding the outcomes that matter most.
 *
 * Rates and notionals are decimal strings scaled by `rateDecimals` (8 on the
 * deployed vault). They stay strings here; formatting belongs at the point of
 * display, where the caller knows how many places to show.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { apiRequest } from "@/lib/api";

export type ChainHedgeType = "FORWARD" | "OPTION_CALL" | "OPTION_PUT";

export type ChainPositionStatus =
  | "ACTIVE"
  | "MATURED"
  | "SETTLED"
  | "EXERCISED"
  | "EXPIRED"
  | "LIQUIDATED"
  | "EMERGENCY_UNWOUND";

export interface ChainCurrencyPair {
  pairId: string;
  base: string;
  quote: string;
  active: boolean;
  maxHedgeRatioBps: number;
  marginRequirementBps: number;
  maintenanceMarginBps: number;
  /** null when the oracle has never published for this pair. */
  rate: string | null;
  rateUpdatedAt: string | null;
}

export interface ChainHedgePosition {
  positionId: string;
  hedger: string;
  pairId: string;
  hedgeType: ChainHedgeType;
  status: ChainPositionStatus;
  notionalAmount: string;
  lockedRate: string;
  premium: string;
  collateralToken: string;
  collateralAmount: string;
  createdAt: string;
  maturityDate: string;
  settledAt: string;
  settlementAmount: string;
  markToMarketValue: string;
  lastMtMUpdate: string;
  /** null when the margin check could not be evaluated. */
  underMargined: boolean | null;
}

export interface ChainPortfolio {
  totalNotional: string;
  totalCollateral: string;
  totalPremiumPaid: string;
  totalPnL: string;
  unrealizedPnL: string;
  positionCount: number;
  lastRebalanced: string;
}

interface ChainPairsConfigured {
  configured: true;
  address: string;
  rateDecimals: number;
  settlementFeeBps: number;
  pairs: ChainCurrencyPair[];
  dataSource: "CHAIN_FX_HEDGING_VAULT";
  readAtBlock: string;
}

interface ChainPairsUnconfigured {
  configured: false;
  reason: string;
  dataSource: "CHAIN_FX_HEDGING_VAULT";
}

type ChainPairsResponse = ChainPairsConfigured | ChainPairsUnconfigured;

interface ChainPositionsResponse {
  configured: boolean;
  positions: ChainHedgePosition[];
  portfolio: ChainPortfolio | null;
  dataSource: string;
}

/** Statuses that mean the position was closed against the hedger's interest. */
const ADVERSE_STATUSES: ChainPositionStatus[] = [
  "LIQUIDATED",
  "EMERGENCY_UNWOUND",
];

export function useFXChain() {
  const queryClient = useQueryClient();

  const pairsQuery = useQuery({
    queryKey: ["fx", "chain", "pairs"],
    queryFn: ({ signal }) =>
      apiRequest<ChainPairsResponse>("/v1/fx/chain/pairs", { signal }),
  });

  const positionsQuery = useQuery({
    queryKey: ["fx", "chain", "positions"],
    queryFn: ({ signal }) =>
      apiRequest<ChainPositionsResponse>("/v1/fx/chain/positions", { signal }),
  });

  const refetch = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["fx", "chain"] });
  }, [queryClient]);

  const pairsData = pairsQuery.data ?? null;
  const positions = positionsQuery.data?.positions ?? [];

  /**
   * Positions below maintenance margin. Only positions where the check
   * actually returned true — a null means the check could not be evaluated
   * (usually no published rate), and treating that as safe would understate
   * risk in exactly the case where least is known.
   */
  const underMargined = positions.filter(
    (p) => p.status === "ACTIVE" && p.underMargined === true,
  );

  /** Active positions whose margin state is unknown, surfaced separately. */
  const marginUnknown = positions.filter(
    (p) => p.status === "ACTIVE" && p.underMargined === null,
  );

  const adverselyClosed = positions.filter((p) =>
    ADVERSE_STATUSES.includes(p.status),
  );

  return {
    configured: pairsData?.configured ?? null,
    pairs: pairsData?.configured ? pairsData.pairs : [],
    rateDecimals: pairsData?.configured ? pairsData.rateDecimals : null,
    settlementFeeBps: pairsData?.configured ? pairsData.settlementFeeBps : null,
    positions,
    portfolio: positionsQuery.data?.portfolio ?? null,
    underMargined,
    marginUnknown,
    adverselyClosed,
    isLoading: pairsQuery.isLoading || positionsQuery.isLoading,
    error: pairsQuery.error ?? positionsQuery.error ?? null,
    refetch,
  };
}
