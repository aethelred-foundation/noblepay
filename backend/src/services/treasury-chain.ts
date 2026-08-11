/**
 * On-chain reads for the MultiSigTreasury.
 *
 * The treasury service alongside this one reports the database ledger, which is
 * the record of what NoblePay believes. This module reports what the contract
 * actually holds. They are different questions and the API keeps them
 * distinct: every result here carries dataSource "CHAIN_MULTISIG_TREASURY", so
 * a caller can never mistake one for the other.
 *
 * Reads go through ethers Interface + provider.call, matching the idiom in
 * compliance-chain.ts rather than introducing a second chain client library.
 *
 * The treasury sits outside CORE_CONTRACT_KEYS, so unlike the core contracts
 * its address is optional. A deployment without one is a valid deployment, not
 * a misconfiguration — callers get a null-ish "not configured" result instead
 * of a thrown ConfigurationError.
 */

import { Interface, JsonRpcProvider } from "ethers";

import type { NoblePayChainConfiguration } from "../lib/production-config";

/**
 * The fragments this service calls. Declared by hand in the style of
 * COMPLIANCE_INTERFACE, and pinned against the compiled artifact by
 * backend/src/__tests__/services/treasury-chain.abi.test.ts — a fragment that
 * drifts from the deployed contract decodes into the wrong fields rather than
 * failing loudly, which is the failure mode that guard exists to prevent.
 */
export const TREASURY_INTERFACE = new Interface([
  "function getSignerConfig() view returns (tuple(uint256 totalSigners,uint256 smallThreshold,uint256 mediumThreshold,uint256 largeThreshold,uint256 emergencyThreshold))",
  "function getSigners() view returns (address[])",
  "function getActiveBudgets() view returns (bytes32[])",
  "function getProposal(bytes32 _proposalId) view returns (tuple(bytes32 proposalId,address proposer,address recipient,address token,uint256 amount,uint8 category,string description,uint8 tier,uint8 status,uint256 approvalCount,uint256 rejectionCount,uint256 requiredApprovals,uint256 createdAt,uint256 timelockExpiry,uint256 expiresAt,bool isEmergency,bytes32 budgetId))",
  "function getBudget(bytes32 _budgetId) view returns (tuple(bytes32 budgetId,string name,uint8 category,uint256 totalAllocation,uint256 spent,uint256 dailyLimit,uint256 weeklyLimit,uint256 monthlyLimit,uint256 createdAt,uint256 periodStart,uint256 periodEnd,bool active))",
  "function yieldProtocols(address) view returns (address protocolAddress,string name,uint256 maxAllocation,uint256 currentAllocation,bool active)",
  "function SMALL_TX_THRESHOLD() view returns (uint256)",
  "function LARGE_TX_THRESHOLD() view returns (uint256)",
  "function STANDARD_TIMELOCK() view returns (uint256)",
  "function LARGE_TIMELOCK() view returns (uint256)",
  "function EMERGENCY_TIMELOCK() view returns (uint256)",
  "event ProposalCreated(bytes32 indexed proposalId,address indexed proposer,address indexed recipient,uint256 amount,uint8 tier,bool isEmergency)",
  "event YieldProtocolApproved(address indexed protocol,string name,uint256 maxAllocation)",
]);

/** Contract enum orderings. These are on-chain uint8 values; do not reorder. */
export const PROPOSAL_STATUS = [
  "PENDING",
  "APPROVED",
  "EXECUTED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
] as const;

export const TX_TIER = ["SMALL", "MEDIUM", "LARGE", "EMERGENCY"] as const;

export const SPENDING_CATEGORY = [
  "OPERATIONS",
  "PAYROLL",
  "INFRASTRUCTURE",
  "MARKETING",
  "LEGAL",
  "RESEARCH",
  "PARTNERSHIPS",
  "OTHER",
] as const;

export type ProposalStatusName = (typeof PROPOSAL_STATUS)[number];
export type TxTierName = (typeof TX_TIER)[number];

const CHAIN_SOURCE = "CHAIN_MULTISIG_TREASURY" as const;

export interface ChainProposal {
  proposalId: string;
  proposer: string;
  recipient: string;
  token: string;
  /** Base units as the contract stores them; see amountBasis below. */
  amount: string;
  category: string;
  description: string;
  tier: TxTierName;
  status: ProposalStatusName;
  approvalCount: number;
  rejectionCount: number;
  requiredApprovals: number;
  createdAt: string;
  timelockExpiry: string;
  expiresAt: string;
  isEmergency: boolean;
  budgetId: string;
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

export interface ChainApprovalTier {
  tier: TxTierName;
  /** Inclusive lower bound in the contract's comparison units. */
  minAmount: string;
  /** Exclusive upper bound; null means unbounded. */
  maxAmount: string | null;
  requiredSignatures: number;
  timelockSeconds: number;
}

export interface ChainTreasuryOverview {
  configured: true;
  address: string;
  /** Native balance in wei. */
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
  proposalCounts: Record<ProposalStatusName, number>;
  activeBudgets: number;
  /**
   * How to read the numbers in `tiers` and in each proposal's `amount`.
   *
   * MultiSigTreasury.createProposal compares the raw `_amount` against
   * SMALL_TX_THRESHOLD (10_000 * 1e6, written as USD at six decimals) and then
   * passes that same value to safeTransfer as the token quantity. The two
   * readings coincide only for a six-decimal, dollar-pegged token. For any
   * other asset the tier is computed from that token's own base units and does
   * not track the value being moved — see
   * docs/audit/NP-TREASURY-01-tier-unit-conflation.md.
   *
   * This is surfaced in the payload rather than left to documentation, because
   * a client that renders the tier bounds as dollars without knowing this will
   * mislead whoever reads the screen.
   */
  amountBasis: "RAW_TOKEN_BASE_UNITS_COMPARED_AGAINST_USD6_THRESHOLDS";
  dataSource: typeof CHAIN_SOURCE;
  readAtBlock: string;
}

export interface ChainTreasuryUnavailable {
  configured: false;
  reason: "NO_TREASURY_ADDRESS_CONFIGURED";
  dataSource: typeof CHAIN_SOURCE;
}

export type ChainTreasuryResult =
  | ChainTreasuryOverview
  | ChainTreasuryUnavailable;

const UNCONFIGURED: ChainTreasuryUnavailable = {
  configured: false,
  reason: "NO_TREASURY_ADDRESS_CONFIGURED",
  dataSource: CHAIN_SOURCE,
};

/**
 * Resolve the treasury address. Optional by design: the treasury is not one of
 * the core contracts, so its absence must not fail a request the way a missing
 * NOBLEPAY_CONTRACT_ADDRESS would.
 */
export function resolveTreasuryAddress(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.MULTISIG_TREASURY_ADDRESS?.trim();
  if (!raw) return null;
  if (!/^0x[a-fA-F0-9]{40}$/u.test(raw) || /^0x0{40}$/iu.test(raw)) return null;
  return raw;
}

function decodeCall<T>(fn: string, data: string): T {
  return TREASURY_INTERFACE.decodeFunctionResult(fn, data) as unknown as T;
}

/**
 * Read the treasury at a pinned block.
 *
 * Every call is issued against the same blockTag so the returned figures are
 * mutually consistent. Reading balances at head and proposals a few blocks
 * later would produce a snapshot that never existed on chain, which is the
 * sort of inconsistency that surfaces as an unreproducible support ticket.
 */
export async function readTreasuryOverview(
  config: Pick<NoblePayChainConfiguration, "rpcUrl">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChainTreasuryResult> {
  const address = resolveTreasuryAddress(env);
  if (!address) return UNCONFIGURED;

  const provider = new JsonRpcProvider(config.rpcUrl);
  const blockNumber = await provider.getBlockNumber();
  const blockTag = blockNumber;

  const call = async (fn: string, args: unknown[] = []) =>
    provider.call({
      to: address,
      data: TREASURY_INTERFACE.encodeFunctionData(fn, args),
      blockTag,
    });

  const [
    rawConfig,
    rawSigners,
    rawBudgets,
    rawSmall,
    rawLarge,
    rawStandardTimelock,
    rawLargeTimelock,
    rawEmergencyTimelock,
    nativeBalance,
  ] = await Promise.all([
    call("getSignerConfig"),
    call("getSigners"),
    call("getActiveBudgets"),
    call("SMALL_TX_THRESHOLD"),
    call("LARGE_TX_THRESHOLD"),
    call("STANDARD_TIMELOCK"),
    call("LARGE_TIMELOCK"),
    call("EMERGENCY_TIMELOCK"),
    provider.getBalance(address, blockTag),
  ]);

  const [cfg] = decodeCall<
    [
      {
        totalSigners: bigint;
        smallThreshold: bigint;
        mediumThreshold: bigint;
        largeThreshold: bigint;
        emergencyThreshold: bigint;
      },
    ]
  >("getSignerConfig", rawConfig);
  const [signers] = decodeCall<[string[]]>("getSigners", rawSigners);
  const [budgetIds] = decodeCall<[string[]]>("getActiveBudgets", rawBudgets);
  const [smallThreshold] = decodeCall<[bigint]>("SMALL_TX_THRESHOLD", rawSmall);
  const [largeThreshold] = decodeCall<[bigint]>("LARGE_TX_THRESHOLD", rawLarge);
  const [standardTimelock] = decodeCall<[bigint]>(
    "STANDARD_TIMELOCK",
    rawStandardTimelock,
  );
  const [largeTimelock] = decodeCall<[bigint]>("LARGE_TIMELOCK", rawLargeTimelock);
  const [emergencyTimelock] = decodeCall<[bigint]>(
    "EMERGENCY_TIMELOCK",
    rawEmergencyTimelock,
  );

  const proposals = await readProposals(provider, address, blockTag);
  const proposalCounts = PROPOSAL_STATUS.reduce(
    (acc, name) => {
      acc[name] = proposals.filter((p) => p.status === name).length;
      return acc;
    },
    {} as Record<ProposalStatusName, number>,
  );

  // Assembled from the contract's own constants rather than restated here, so
  // the reported matrix cannot drift from the one being enforced. Emergency is
  // a flag on the proposal, not a size band, so it carries no amount bounds.
  const tiers: ChainApprovalTier[] = [
    {
      tier: "SMALL",
      minAmount: "0",
      maxAmount: smallThreshold.toString(),
      requiredSignatures: Number(cfg.smallThreshold),
      timelockSeconds: Number(standardTimelock),
    },
    {
      tier: "MEDIUM",
      minAmount: smallThreshold.toString(),
      maxAmount: largeThreshold.toString(),
      requiredSignatures: Number(cfg.mediumThreshold),
      timelockSeconds: Number(standardTimelock),
    },
    {
      tier: "LARGE",
      minAmount: largeThreshold.toString(),
      maxAmount: null,
      requiredSignatures: Number(cfg.largeThreshold),
      timelockSeconds: Number(largeTimelock),
    },
    {
      tier: "EMERGENCY",
      minAmount: "0",
      maxAmount: null,
      requiredSignatures: Number(cfg.emergencyThreshold),
      timelockSeconds: Number(emergencyTimelock),
    },
  ];

  return {
    configured: true,
    address,
    nativeBalance: nativeBalance.toString(),
    signers: [...signers],
    signerCount: Number(cfg.totalSigners),
    thresholds: {
      small: Number(cfg.smallThreshold),
      medium: Number(cfg.mediumThreshold),
      large: Number(cfg.largeThreshold),
      emergency: Number(cfg.emergencyThreshold),
    },
    tiers,
    proposalCounts,
    activeBudgets: budgetIds.length,
    amountBasis: "RAW_TOKEN_BASE_UNITS_COMPARED_AGAINST_USD6_THRESHOLDS",
    dataSource: CHAIN_SOURCE,
    readAtBlock: blockNumber.toString(),
  };
}

/**
 * Proposals are discovered from ProposalCreated and then read back live.
 * Proposal ids are hash-derived, so there is no index to enumerate; the event
 * log is the only way to learn which ids exist.
 */
export async function readProposals(
  provider: JsonRpcProvider,
  address: string,
  blockTag: number,
): Promise<ChainProposal[]> {
  const topic = TREASURY_INTERFACE.getEvent("ProposalCreated")?.topicHash;
  if (!topic) return [];

  const logs = await provider.getLogs({
    address,
    topics: [topic],
    fromBlock: 0,
    toBlock: blockTag,
  });

  // The Aethelred node's eth_getLogs can return the same log twice for one
  // query, which would otherwise report a single proposal as two.
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const log of logs) {
    const key = `${log.transactionHash}:${log.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = log.topics[1];
    if (id) ids.push(id);
  }

  const proposals = await Promise.all(
    ids.map(async (id) => {
      const raw = await provider.call({
        to: address,
        data: TREASURY_INTERFACE.encodeFunctionData("getProposal", [id]),
        blockTag,
      });
      const [p] = decodeCall<
        [
          {
            proposalId: string;
            proposer: string;
            recipient: string;
            token: string;
            amount: bigint;
            category: bigint;
            description: string;
            tier: bigint;
            status: bigint;
            approvalCount: bigint;
            rejectionCount: bigint;
            requiredApprovals: bigint;
            createdAt: bigint;
            timelockExpiry: bigint;
            expiresAt: bigint;
            isEmergency: boolean;
            budgetId: string;
          },
        ]
      >("getProposal", raw);

      return {
        proposalId: p.proposalId,
        proposer: p.proposer,
        recipient: p.recipient,
        token: p.token,
        amount: p.amount.toString(),
        category: SPENDING_CATEGORY[Number(p.category)] ?? "UNKNOWN",
        description: p.description,
        tier: TX_TIER[Number(p.tier)] ?? ("UNKNOWN" as TxTierName),
        status: PROPOSAL_STATUS[Number(p.status)] ?? ("UNKNOWN" as ProposalStatusName),
        approvalCount: Number(p.approvalCount),
        rejectionCount: Number(p.rejectionCount),
        requiredApprovals: Number(p.requiredApprovals),
        createdAt: p.createdAt.toString(),
        timelockExpiry: p.timelockExpiry.toString(),
        expiresAt: p.expiresAt.toString(),
        isEmergency: p.isEmergency,
        budgetId: p.budgetId,
      } satisfies ChainProposal;
    }),
  );

  // Newest first; creation-event order is chain order.
  return proposals.reverse();
}

/** Active budgets with their allocation and recorded spend. */
export async function readBudgets(
  config: Pick<NoblePayChainConfiguration, "rpcUrl">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChainBudget[] | null> {
  const address = resolveTreasuryAddress(env);
  if (!address) return null;

  const provider = new JsonRpcProvider(config.rpcUrl);
  const blockTag = await provider.getBlockNumber();

  const rawIds = await provider.call({
    to: address,
    data: TREASURY_INTERFACE.encodeFunctionData("getActiveBudgets"),
    blockTag,
  });
  const [ids] = decodeCall<[string[]]>("getActiveBudgets", rawIds);

  return Promise.all(
    ids.map(async (id) => {
      const raw = await provider.call({
        to: address,
        data: TREASURY_INTERFACE.encodeFunctionData("getBudget", [id]),
        blockTag,
      });
      const [b] = decodeCall<
        [
          {
            budgetId: string;
            name: string;
            category: bigint;
            totalAllocation: bigint;
            spent: bigint;
            dailyLimit: bigint;
            weeklyLimit: bigint;
            monthlyLimit: bigint;
            createdAt: bigint;
            periodStart: bigint;
            periodEnd: bigint;
            active: boolean;
          },
        ]
      >("getBudget", raw);

      return {
        budgetId: b.budgetId,
        name: b.name,
        category: SPENDING_CATEGORY[Number(b.category)] ?? "UNKNOWN",
        totalAllocation: b.totalAllocation.toString(),
        spent: b.spent.toString(),
        dailyLimit: b.dailyLimit.toString(),
        weeklyLimit: b.weeklyLimit.toString(),
        monthlyLimit: b.monthlyLimit.toString(),
        periodStart: b.periodStart.toString(),
        periodEnd: b.periodEnd.toString(),
        active: b.active,
      } satisfies ChainBudget;
    }),
  );
}
