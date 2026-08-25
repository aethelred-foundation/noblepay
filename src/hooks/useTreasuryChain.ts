/**
 * Treasury state read from the MultiSigTreasury contract, served through the
 * backend's /v1/treasury/chain/* endpoints.
 *
 * Separate from useTreasury, which reads the database ledger. The two answer
 * different questions and can legitimately disagree, so they are kept as
 * distinct hooks with distinct query keys rather than merged behind one
 * interface — a component that shows chain state should have had to ask for it.
 *
 * Amounts arrive as decimal strings because they are uint256 values that
 * exceed Number.MAX_SAFE_INTEGER. They are kept as strings here and converted
 * only at the point of display; parsing them into numbers in the hook would
 * quietly lose precision on large balances.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { apiRequest } from "@/lib/api";

export type ChainProposalStatus =
  | "PENDING"
  | "APPROVED"
  | "EXECUTED"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED";

export type ChainTxTier = "SMALL" | "MEDIUM" | "LARGE" | "EMERGENCY";

export interface ChainProposal {
  proposalId: string;
  proposer: string;
  recipient: string;
  token: string;
  amount: string;
  category: string;
  description: string;
  tier: ChainTxTier;
  status: ChainProposalStatus;
  approvalCount: number;
  rejectionCount: number;
  requiredApprovals: number;
  createdAt: string;
  timelockExpiry: string;
  expiresAt: string;
  isEmergency: boolean;
  budgetId: string;
}

export interface ChainApprovalTier {
  tier: ChainTxTier;
  minAmount: string;
  maxAmount: string | null;
  requiredSignatures: number;
  timelockSeconds: number;
}

export interface ChainBudget {
  budgetId: string;
  name: string;
  category: string;
  totalAllocation: string;
  spent: string;
  dailyLimit: string;
  weeklyLimit: string;
  monthlyLimit: string;
  periodStart: string;
  periodEnd: string;
  active: boolean;
}

export interface ChainOverviewConfigured {
  configured: true;
  address: string;
  nativeBalance: string;
  signers: string[];
  signerCount: number;
  thresholds: {
    small: number;
    medium: number;
    large: number;
    emergency: number;
  };
  tiers: ChainApprovalTier[];
  proposalCounts: Record<ChainProposalStatus, number>;
  activeBudgets: number;
  amountBasis: string;
  dataSource: "CHAIN_MULTISIG_TREASURY";
  readAtBlock: string;
}

export interface ChainOverviewUnconfigured {
  configured: false;
  reason: string;
  dataSource: "CHAIN_MULTISIG_TREASURY";
}

export type ChainOverviewResponse =
  | ChainOverviewConfigured
  | ChainOverviewUnconfigured;

interface ChainProposalsResponse {
  configured: boolean;
  proposals: ChainProposal[];
  amountBasis?: string;
  dataSource?: string;
  readAtBlock?: string;
}

interface ChainBudgetsResponse {
  configured: boolean;
  budgets: ChainBudget[];
  dataSource: string;
}

/**
 * The tier bounds are only dollars for a six-decimal, dollar-pegged token.
 * MultiSigTreasury compares a proposal's raw amount against thresholds written
 * as USD at six decimals and then transfers that same number, so for any other
 * asset the tier is derived from that token's own base units. The backend
 * ships this as `amountBasis`; components should surface it rather than
 * formatting the bounds as currency. See
 * docs/audit/NP-TREASURY-01-tier-unit-conflation.md.
 */
export const TIER_BOUNDS_ARE_USD_ONLY_FOR_6DP_TOKENS =
  "RAW_TOKEN_BASE_UNITS_COMPARED_AGAINST_USD6_THRESHOLDS";

export function useTreasuryChain() {
  const queryClient = useQueryClient();

  const overviewQuery = useQuery({
    queryKey: ["treasury", "chain", "overview"],
    queryFn: ({ signal }) =>
      apiRequest<ChainOverviewResponse>("/v1/treasury/chain/overview", {
        signal,
      }),
  });

  const proposalsQuery = useQuery({
    queryKey: ["treasury", "chain", "proposals"],
    queryFn: ({ signal }) =>
      apiRequest<ChainProposalsResponse>("/v1/treasury/chain/proposals", {
        signal,
      }),
  });

  const budgetsQuery = useQuery({
    queryKey: ["treasury", "chain", "budgets"],
    queryFn: ({ signal }) =>
      apiRequest<ChainBudgetsResponse>("/v1/treasury/chain/budgets", { signal }),
  });

  const refetch = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["treasury", "chain"] });
  }, [queryClient]);

  const overview = overviewQuery.data ?? null;
  const configured = overview?.configured ?? null;

  /*
   * Narrow once, explicitly, into an annotated local.
   *
   * `overview?.configured ? overview : null` reads as if it narrows, and it
   * does inside this file. What it does NOT do is survive into the hook's
   * INFERRED return type: overviewQuery.data comes back through react-query's
   * generics, and from 5.101 those are deferred enough that the narrowing is
   * dropped when the return object's type is computed. Callers then saw the
   * full ChainOverviewResponse and every property access failed.
   *
   * The annotation below is what makes the type a fact rather than something
   * re-derived per call site, per library version.
   */
  const configuredOverview: ChainOverviewConfigured | null =
    overview !== null && overview.configured ? overview : null;

  return {
    /**
     * null while loading, false when no treasury address is deployed for this
     * environment, true otherwise. Three states rather than two: "we do not
     * know yet" and "there is no treasury" produce very different UI, and
     * collapsing them shows an empty treasury during the first render.
     */
    configured,
    overview: configuredOverview,
    proposals: proposalsQuery.data?.proposals ?? [],
    budgets: budgetsQuery.data?.budgets ?? [],
    amountBasis: configuredOverview?.amountBasis ?? null,
    readAtBlock: configuredOverview?.readAtBlock ?? null,
    isLoading:
      overviewQuery.isLoading ||
      proposalsQuery.isLoading ||
      budgetsQuery.isLoading,
    error:
      overviewQuery.error ?? proposalsQuery.error ?? budgetsQuery.error ?? null,
    refetch,
  };
}
