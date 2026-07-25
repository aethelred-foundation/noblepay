// ============================================================
// NoblePay Treasury Type Definitions
// Types for DAO treasury management, spending policies, and yield
// ============================================================

// ---------------------------------------------------------------------------
// Proposal Types
// ---------------------------------------------------------------------------

/** Treasury proposal status */
export type ProposalStatus =
  | "Draft"
  | "Active"
  | "Queued"
  | "Executed"
  | "Defeated"
  | "Expired"
  | "Cancelled";

/** A DAO treasury spending proposal */
export interface TreasuryProposal {
  /** Unique proposal identifier (bytes32) */
  id: string;
  /** Proposal title */
  title: string;
  /** Markdown-formatted description */
  description: string;
  /** Proposer wallet address */
  proposer: string;
  /** Recipient of the funds */
  recipient: string | null;
  /** Requested amount (human-readable) */
  amount: number | null;
  /** Token symbol for the request (e.g. 'USDC', 'AETHEL') */
  tokenSymbol: string | null;
  /** Current proposal status */
  status: ProposalStatus;
  /** Number of votes in favor */
  votesFor: number;
  /** Number of votes against */
  votesAgainst: number | null;
  /** Quorum threshold required */
  quorum: number;
  /** Proposal creation timestamp (Unix ms) */
  createdAt: number;
  /** Voting deadline timestamp (Unix ms) */
  votingDeadline: number;
  /** Execution timestamp (Unix ms), 0 if not executed */
  executedAt: number | null;
  /** Durable spending-policy category, when present */
  category?: string | null;
  /** On-chain transaction hash, if executed */
  txHash?: string;
}

// ---------------------------------------------------------------------------
// Spending Policy Types
// ---------------------------------------------------------------------------

/** Spending policy enforcement mode */
export type PolicyEnforcement = "Strict" | "Advisory" | "Disabled";

/** Treasury spending policy configuration */
export interface SpendingPolicy {
  /** Policy identifier */
  id: string;
  /** Human-readable policy name */
  name: string;
  /** Policy description */
  description: string;
  /** Maximum single transaction amount (USD) */
  maxSingleTx: number | null;
  /** Daily spending limit (USD) */
  dailyLimit: number;
  /** Monthly spending limit (USD) */
  monthlyLimit: number;
  /** Number of required approvals for execution */
  requiredApprovals: number;
  /** Enforcement mode */
  enforcement: PolicyEnforcement;
  /** Whether this policy is currently active */
  active: boolean;
  /** Last updated timestamp (Unix ms) */
  updatedAt: number;
}

/** Approval threshold for multi-sig treasury operations */
export interface ApprovalThreshold {
  /** Threshold tier name (e.g. 'Low', 'Medium', 'High') */
  tier: string;
  /** Minimum amount (USD) that triggers this tier */
  minAmount: number;
  /** Maximum amount (USD) for this tier */
  maxAmount: number;
  /** Number of signatures required */
  requiredSignatures: number;
  /** Timelock delay in seconds before execution */
  timelockDelay: number;
}

// ---------------------------------------------------------------------------
// Yield Strategy Types
// ---------------------------------------------------------------------------

/** Yield strategy risk level */
export type YieldRisk = "Conservative" | "Moderate" | "Aggressive";

/** Treasury yield strategy allocation */
export interface YieldStrategy {
  /** Strategy identifier */
  id: string;
  /** Strategy name */
  name: string;
  /** Strategy description */
  description: string;
  /** Protocol used (e.g. 'Aave', 'Compound', 'Lido') */
  protocol: string;
  /** Allocated amount (USD) */
  allocated: number;
  /** Current APY percentage */
  apy: number;
  /** Risk classification */
  risk: YieldRisk;
  /** Whether the strategy is currently active */
  active: boolean;
  /** Earned yield to date (USD) */
  earnedToDate: number;
  /** Last rebalance timestamp (Unix ms) */
  lastRebalance: number | null;
}

// ---------------------------------------------------------------------------
// Treasury Overview
// ---------------------------------------------------------------------------

/** Aggregated treasury overview for dashboard display */
export interface TreasuryOverview {
  /** Total treasury balance (USD) */
  totalBalance: number;
  /** Balance breakdown by token */
  tokenBalances: {
    symbol: string;
    amount: number;
    valueUsd: number | null;
  }[];
  /** Active proposal count */
  activeProposals: number;
  /** Total yield earned this month (USD) */
  monthlyYield: number;
  /** Total amount deployed in yield strategies (USD) */
  deployedInYield: number;
  /** Amount spent this month (USD) */
  monthlySpend: number;
  /** Pending approval count */
  pendingApprovals: number;
  /** Number of active durable yield-strategy records */
  activeStrategies: number;
  /** Number of distinct recorded proposal approvers */
  signerCount: number;
  /** Clarifies that the amounts are raw recorded allocations, not fiat-valued AUM. */
  valuationScope: "RECORDED_YIELD_ALLOCATIONS_ONLY";
}
