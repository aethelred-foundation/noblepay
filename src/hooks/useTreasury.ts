/**
 * Treasury Hooks — Custom React hooks for NoblePay treasury management.
 *
 * Provides typed hooks for treasury proposals, spending policies,
 * yield strategies, and treasury overview data.
 */

import { useState, useEffect, useCallback } from 'react';
import type {
  TreasuryProposal,
  SpendingPolicy,
  YieldStrategy,
  TreasuryOverview,
  ApprovalThreshold,
} from '@/types/treasury';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_OVERVIEW: TreasuryOverview = {
  totalBalance: 12_450_000,
  tokenBalances: [
    { symbol: 'USDC', amount: 8_200_000, valueUsd: 8_200_000 },
    { symbol: 'AET', amount: 2_500_000, valueUsd: 3_750_000 },
    { symbol: 'USDT', amount: 500_000, valueUsd: 500_000 },
  ],
  activeProposals: 3,
  monthlyYield: 42_500,
  deployedInYield: 5_000_000,
  monthlySpend: 320_000,
  pendingApprovals: 2,
};

const MOCK_PROPOSALS: TreasuryProposal[] = [
  {
    id: '0xprop001',
    title: 'Fund MENA Compliance Node Expansion',
    description: 'Allocate 500,000 USDC to deploy three additional TEE compliance nodes in the UAE and Saudi Arabia regions.',
    proposer: '0x1234567890abcdef1234567890abcdef12345678',
    recipient: '0xabcdef1234567890abcdef1234567890abcdef12',
    amount: 500_000,
    tokenSymbol: 'USDC',
    status: 'Active',
    votesFor: 1_250_000,
    votesAgainst: 320_000,
    quorum: 2_000_000,
    createdAt: Date.now() - 3 * 86_400_000,
    votingDeadline: Date.now() + 4 * 86_400_000,
    executedAt: 0,
  },
  {
    id: '0xprop002',
    title: 'Q2 Marketing Budget Allocation',
    description: 'Allocate 150,000 USDC for Q2 marketing and partnership initiatives across GCC markets.',
    proposer: '0x2345678901abcdef2345678901abcdef23456789',
    recipient: '0xbcdef1234567890abcdef1234567890abcdef1234',
    amount: 150_000,
    tokenSymbol: 'USDC',
    status: 'Active',
    votesFor: 800_000,
    votesAgainst: 150_000,
    quorum: 2_000_000,
    createdAt: Date.now() - 2 * 86_400_000,
    votingDeadline: Date.now() + 5 * 86_400_000,
    executedAt: 0,
  },
  {
    id: '0xprop003',
    title: 'Security Audit — Annual Retainer',
    description: 'Annual security audit retainer with Trail of Bits for continuous smart contract review.',
    proposer: '0x3456789012abcdef3456789012abcdef34567890',
    recipient: '0xcdef1234567890abcdef1234567890abcdef12345',
    amount: 200_000,
    tokenSymbol: 'USDC',
    status: 'Queued',
    votesFor: 2_100_000,
    votesAgainst: 180_000,
    quorum: 2_000_000,
    createdAt: Date.now() - 10 * 86_400_000,
    votingDeadline: Date.now() - 3 * 86_400_000,
    executedAt: 0,
  },
];

const MOCK_POLICIES: SpendingPolicy[] = [
  {
    id: 'pol-001',
    name: 'Operational Expenses',
    description: 'Day-to-day operational spending policy for approved vendors.',
    maxSingleTx: 25_000,
    dailyLimit: 50_000,
    monthlyLimit: 500_000,
    requiredApprovals: 2,
    enforcement: 'Strict',
    active: true,
    updatedAt: Date.now() - 30 * 86_400_000,
  },
  {
    id: 'pol-002',
    name: 'Strategic Investments',
    description: 'Policy for yield deployment and strategic protocol investments.',
    maxSingleTx: 500_000,
    dailyLimit: 1_000_000,
    monthlyLimit: 5_000_000,
    requiredApprovals: 4,
    enforcement: 'Strict',
    active: true,
    updatedAt: Date.now() - 15 * 86_400_000,
  },
];

const MOCK_STRATEGIES: YieldStrategy[] = [
  {
    id: 'strat-001',
    name: 'USDC Lending',
    description: 'Lend USDC on Aave V3 for stable yield.',
    protocol: 'Aave',
    allocated: 3_000_000,
    apy: 4.2,
    risk: 'Conservative',
    active: true,
    earnedToDate: 126_000,
    lastRebalance: Date.now() - 7 * 86_400_000,
  },
  {
    id: 'strat-002',
    name: 'AET Staking',
    description: 'Stake AET tokens for network security rewards.',
    protocol: 'Aethelred Staking',
    allocated: 1_500_000,
    apy: 8.5,
    risk: 'Moderate',
    active: true,
    earnedToDate: 95_000,
    lastRebalance: Date.now() - 3 * 86_400_000,
  },
  {
    id: 'strat-003',
    name: 'Liquidity Provision',
    description: 'Provide USDC/AET liquidity on NoblePay DEX pools.',
    protocol: 'NoblePay LP',
    allocated: 500_000,
    apy: 12.3,
    risk: 'Aggressive',
    active: true,
    earnedToDate: 48_000,
    lastRebalance: Date.now() - 1 * 86_400_000,
  },
];

const MOCK_THRESHOLDS: ApprovalThreshold[] = [
  { tier: 'Low', minAmount: 0, maxAmount: 10_000, requiredSignatures: 1, timelockDelay: 0 },
  { tier: 'Medium', minAmount: 10_000, maxAmount: 100_000, requiredSignatures: 2, timelockDelay: 3600 },
  { tier: 'High', minAmount: 100_000, maxAmount: 1_000_000, requiredSignatures: 3, timelockDelay: 86_400 },
  { tier: 'Critical', minAmount: 1_000_000, maxAmount: Infinity, requiredSignatures: 5, timelockDelay: 172_800 },
];

// ---------------------------------------------------------------------------
// useTreasury — treasury overview, proposals, policies, yield strategies
// ---------------------------------------------------------------------------

export function useTreasury() {
  const [overview, setOverview] = useState<TreasuryOverview | null>(null);
  const [proposals, setProposals] = useState<TreasuryProposal[]>([]);
  const [policies, setPolicies] = useState<SpendingPolicy[]>([]);
  const [strategies, setStrategies] = useState<YieldStrategy[]>([]);
  const [thresholds, setThresholds] = useState<ApprovalThreshold[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setOverview(MOCK_OVERVIEW);
      setProposals(MOCK_PROPOSALS);
      setPolicies(MOCK_POLICIES);
      setStrategies(MOCK_STRATEGIES);
      setThresholds(MOCK_THRESHOLDS);
      setIsLoading(false);
    }, 600);
    return () => clearTimeout(timer);
  }, []);

  const voteOnProposal = useCallback(
    (proposalId: string, support: boolean) => {
      setProposals((prev) =>
        prev.map((p) =>
          p.id === proposalId
            ? {
                ...p,
                votesFor: support ? p.votesFor + 100_000 : p.votesFor,
                votesAgainst: support ? p.votesAgainst : p.votesAgainst + 100_000,
              }
            : p,
        ),
      );
    },
    [],
  );

  const createProposal = useCallback(
    (proposal: Omit<TreasuryProposal, 'id' | 'status' | 'votesFor' | 'votesAgainst' | 'createdAt' | 'executedAt'>) => {
      const newProposal: TreasuryProposal = {
        ...proposal,
        id: `0xprop${String(Date.now()).slice(-6)}`,
        status: 'Draft',
        votesFor: 0,
        votesAgainst: 0,
        createdAt: Date.now(),
        executedAt: 0,
      };
      setProposals((prev) => [newProposal, ...prev]);
    },
    [],
  );

  return {
    overview,
    proposals,
    policies,
    strategies,
    thresholds,
    isLoading,
    voteOnProposal,
    createProposal,
  };
}
