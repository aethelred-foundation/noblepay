import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "@/lib/api";
import type {
  ApprovalThreshold,
  SpendingPolicy,
  TreasuryOverview,
  TreasuryProposal,
  YieldStrategy,
} from "@/types/treasury";

interface ApiOverview {
  totalAUM: string;
  allocations: Record<string, string>;
  yieldEarned: string;
  pendingProposals: number;
  activeStrategies: number;
  signerCount: number;
  monthlySpend: Record<string, string>;
  valuationScope: "RECORDED_YIELD_ALLOCATIONS_ONLY";
}

interface ApiPolicy {
  id: string;
  category: string;
  dailyLimit: string;
  monthlyLimit: string;
  requiresApproval: boolean;
  minApprovals: number;
  active: boolean;
  updatedAt: string;
}

interface ApiYieldStrategy {
  id: string;
  protocol: string;
  name: string;
  allocation: string;
  currency: string;
  currentAPY: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  active: boolean;
  totalYieldEarned: string;
  lastHarvestAt: string | null;
}

interface ApiProposal {
  id: string;
  title: string;
  description: string;
  type: "TRANSFER" | "POLICY_CHANGE" | "YIELD_ALLOCATION" | "EMERGENCY";
  amount: string | null;
  currency: string | null;
  recipient: string | null;
  category: string | null;
  status: "PENDING" | "APPROVED" | "EXECUTED" | "REJECTED" | "EXPIRED";
  proposer: string;
  requiredApprovals: number;
  currentApprovals: number;
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
}

export interface CreateTreasuryProposalInput {
  title: string;
  description: string;
  recipient: string;
  amount: number;
  tokenSymbol: string;
  category: string;
}

export function useTreasury() {
  const queryClient = useQueryClient();
  const overviewQuery = useQuery({
    queryKey: ["treasury", "overview"],
    queryFn: ({ signal }) =>
      apiRequest<ApiOverview>("/v1/treasury/overview", { signal }),
  });
  const policiesQuery = useQuery({
    queryKey: ["treasury", "policies"],
    queryFn: ({ signal }) =>
      apiRequest<ApiPolicy[]>("/v1/treasury/policies", { signal }),
  });
  const strategiesQuery = useQuery({
    queryKey: ["treasury", "yield"],
    queryFn: ({ signal }) =>
      apiRequest<ApiYieldStrategy[]>("/v1/treasury/yield", { signal }),
  });
  const proposalsQuery = useQuery({
    queryKey: ["treasury", "proposals"],
    queryFn: ({ signal }) =>
      apiRequest<ApiProposal[]>("/v1/treasury/proposals", { signal }),
  });

  const createMutation = useMutation({
    mutationFn: (proposal: CreateTreasuryProposalInput) =>
      apiRequest("/v1/treasury/proposals", {
        method: "POST",
        json: {
          title: proposal.title,
          description: proposal.description,
          type: "TRANSFER",
          amount: String(proposal.amount),
          currency: proposal.tokenSymbol,
          recipient: proposal.recipient,
          category: proposal.category,
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["treasury", "overview"] }),
        queryClient.invalidateQueries({ queryKey: ["treasury", "proposals"] }),
      ]);
    },
  });
  const approveMutation = useMutation({
    mutationFn: (proposalId: string) =>
      apiRequest(
        `/v1/treasury/proposals/${encodeURIComponent(proposalId)}/approve`,
        { method: "POST" },
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["treasury", "overview"] }),
        queryClient.invalidateQueries({ queryKey: ["treasury", "proposals"] }),
      ]);
    },
  });

  const overview: TreasuryOverview | null = overviewQuery.data
    ? {
        totalBalance: Number(overviewQuery.data.totalAUM),
        tokenBalances: Object.entries(overviewQuery.data.allocations).map(
          ([symbol, amount]) => ({
            symbol,
            amount: Number(amount),
            valueUsd: null,
          }),
        ),
        activeProposals: overviewQuery.data.pendingProposals,
        monthlyYield: Number(overviewQuery.data.yieldEarned),
        deployedInYield: Object.values(overviewQuery.data.allocations).reduce(
          (sum, value) => sum + Number(value),
          0,
        ),
        monthlySpend: Object.values(overviewQuery.data.monthlySpend).reduce(
          (sum, value) => sum + Number(value),
          0,
        ),
        pendingApprovals: overviewQuery.data.pendingProposals,
        activeStrategies: overviewQuery.data.activeStrategies,
        signerCount: overviewQuery.data.signerCount,
        valuationScope: overviewQuery.data.valuationScope,
      }
    : null;
  const policies = useMemo<SpendingPolicy[]>(
    () =>
      (policiesQuery.data || []).map((policy) => ({
        id: policy.id,
        name: policy.category,
        description: "",
        maxSingleTx: null,
        dailyLimit: Number(policy.dailyLimit),
        monthlyLimit: Number(policy.monthlyLimit),
        requiredApprovals: policy.minApprovals,
        enforcement: policy.requiresApproval ? "Strict" : "Advisory",
        active: policy.active,
        updatedAt: Date.parse(policy.updatedAt),
      })),
    [policiesQuery.data],
  );
  const strategies = useMemo<YieldStrategy[]>(
    () =>
      (strategiesQuery.data || []).map((strategy) => ({
        id: strategy.id,
        name: strategy.name,
        description: "",
        protocol: strategy.protocol,
        allocated: Number(strategy.allocation),
        apy: strategy.currentAPY,
        risk:
          strategy.riskLevel === "LOW"
            ? "Conservative"
            : strategy.riskLevel === "MEDIUM"
              ? "Moderate"
              : "Aggressive",
        active: strategy.active,
        earnedToDate: Number(strategy.totalYieldEarned),
        lastRebalance: strategy.lastHarvestAt
          ? Date.parse(strategy.lastHarvestAt)
          : null,
      })),
    [strategiesQuery.data],
  );
  const proposals = useMemo<TreasuryProposal[]>(
    () =>
      (proposalsQuery.data || []).map((proposal) => ({
        id: proposal.id,
        title: proposal.title,
        description: proposal.description,
        proposer: proposal.proposer,
        recipient: proposal.recipient,
        amount: proposal.amount === null ? null : Number(proposal.amount),
        tokenSymbol: proposal.currency,
        category: proposal.category,
        status:
          proposal.status === "PENDING"
            ? "Active"
            : proposal.status === "APPROVED"
              ? "Queued"
              : proposal.status === "EXECUTED"
                ? "Executed"
                : proposal.status === "REJECTED"
                  ? "Defeated"
                  : "Expired",
        votesFor: proposal.currentApprovals,
        votesAgainst: null,
        quorum: proposal.requiredApprovals,
        createdAt: Date.parse(proposal.createdAt),
        votingDeadline: Date.parse(proposal.expiresAt),
        executedAt: proposal.executedAt
          ? Date.parse(proposal.executedAt)
          : null,
      })),
    [proposalsQuery.data],
  );

  const voteOnProposal = useCallback(
    (proposalId: string, support: boolean) => {
      if (!support) {
        return Promise.reject(
          new ApiError("Proposal rejection is not available on the API", {
            status: 501,
            code: "TREASURY_REJECTION_UNAVAILABLE",
          }),
        );
      }
      return approveMutation.mutateAsync(proposalId);
    },
    [approveMutation],
  );
  const refetch = useCallback(async () => {
    createMutation.reset();
    approveMutation.reset();
    await Promise.all([
      overviewQuery.refetch(),
      policiesQuery.refetch(),
      strategiesQuery.refetch(),
      proposalsQuery.refetch(),
    ]);
  }, [
    approveMutation,
    createMutation,
    overviewQuery,
    policiesQuery,
    proposalsQuery,
    strategiesQuery,
  ]);

  return {
    overview,
    proposals,
    policies,
    strategies,
    thresholds: [] as ApprovalThreshold[],
    isLoading:
      overviewQuery.isLoading ||
      policiesQuery.isLoading ||
      strategiesQuery.isLoading ||
      proposalsQuery.isLoading,
    isMutating: createMutation.isPending || approveMutation.isPending,
    error:
      overviewQuery.error ||
      policiesQuery.error ||
      strategiesQuery.error ||
      proposalsQuery.error ||
      null,
    actionError: createMutation.error || approveMutation.error || null,
    refetch,
    voteOnProposal,
    createProposal: createMutation.mutateAsync,
  };
}
