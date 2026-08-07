/**
 * Treasury hooks — real reads and writes against the deployed MultiSigTreasury.
 *
 * The treasury is a multi-signature approval system, NOT a token-weighted DAO.
 * A proposal is approved when enough SIGNER_ROLE holders call approveProposal;
 * there are no vote weights and no quorum. It then waits out a tier-dependent
 * timelock before it can be executed. Any UI that shows "votes for / against"
 * against a quorum bar is describing a contract that does not exist here.
 *
 * Identifiers are hash-derived, so most collections cannot be enumerated by
 * index. Proposals, yield protocols, supported tokens and recurring payments
 * are discovered from their creation events and then read back live; budgets
 * are the exception, since the contract keeps an activeBudgetIds array.
 *
 * Writes go through useSafeWriteContract (GAS-01 buffering).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useSafeWriteContract } from "./useSafeWriteContract";
import { useClientRef } from "./useClientRef";
import { CONTRACT_ADDRESSES, activeChain } from "@/config/chains";
import { ERC20_ABI } from "@/config/abis";
import { MULTISIG_TREASURY_ABI } from "@/config/abis.generated";

const TREASURY = CONTRACT_ADDRESSES.multisigTreasury as `0x${string}`;

/** Native asset sentinel used by the contract for non-ERC20 transfers. */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const;

/**
 * The treasury's view/pure function names, derived from the generated ABI.
 * Using this instead of `string` keeps a typo in a read a compile-time error.
 */
type TreasuryReadFn = Extract<
  (typeof MULTISIG_TREASURY_ABI)[number],
  { type: "function"; stateMutability: "view" | "pure" }
>["name"];

/**
 * De-duplicate raw event logs. The Aethelred node's eth_getLogs can return the
 * same log twice for one query, which would otherwise render one proposal as
 * two. Keyed by transactionHash + logIndex (unique per log).
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

// ---------------------------------------------------------------------------
// Contract enums — mirrored from MultiSigTreasury.sol. Order is significant:
// these are the on-chain uint8 values, so an entry may not be reordered.
// ---------------------------------------------------------------------------

export const PROPOSAL_STATUS = [
  "Pending",
  "Approved",
  "Executed",
  "Rejected",
  "Cancelled",
  "Expired",
] as const;

export const TX_TIER = ["Small", "Medium", "Large", "Emergency"] as const;

export const SPENDING_CATEGORY = [
  "Operations",
  "Payroll",
  "Infrastructure",
  "Marketing",
  "Legal",
  "Research",
  "Partnerships",
  "Other",
] as const;

export const PAYMENT_FREQUENCY = [
  "Daily",
  "Weekly",
  "Biweekly",
  "Monthly",
  "Quarterly",
] as const;

export type ProposalStatusName = (typeof PROPOSAL_STATUS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Proposal {
  proposalId: `0x${string}`;
  proposer: `0x${string}`;
  recipient: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  category: number;
  description: string;
  tier: number;
  status: number;
  approvalCount: number;
  rejectionCount: number;
  requiredApprovals: number;
  createdAt: number;
  timelockExpiry: number;
  expiresAt: number;
  isEmergency: boolean;
  budgetId: `0x${string}`;
}

export interface Budget {
  budgetId: `0x${string}`;
  name: string;
  category: number;
  totalAllocation: bigint;
  spent: bigint;
  dailyLimit: bigint;
  weeklyLimit: bigint;
  monthlyLimit: bigint;
  createdAt: number;
  periodStart: number;
  periodEnd: number;
  active: boolean;
  /** Live rolling spend, reset by the contract on period boundaries. */
  dailySpent: bigint;
  weeklySpent: bigint;
  monthlySpent: bigint;
}

export interface YieldProtocolInfo {
  protocolAddress: `0x${string}`;
  name: string;
  maxAllocation: bigint;
  currentAllocation: bigint;
  active: boolean;
}

export interface TokenHolding {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  balance: bigint;
}

export interface SignerConfig {
  totalSigners: number;
  smallThreshold: number;
  mediumThreshold: number;
  largeThreshold: number;
  emergencyThreshold: number;
}

export interface ApprovalTier {
  tier: (typeof TX_TIER)[number];
  /** Lower bound in USD-equivalent 6-decimal units, as the contract compares. */
  minAmount: bigint;
  /** Upper bound; null means unbounded. */
  maxAmount: bigint | null;
  requiredSignatures: number;
  timelockSeconds: number;
}

// ---------------------------------------------------------------------------
// Raw decode shapes. viem returns named-tuple outputs as objects, but public
// mapping getters as positional arrays — the two need different handling.
// ---------------------------------------------------------------------------

interface RawProposal {
  proposalId: `0x${string}`;
  proposer: `0x${string}`;
  recipient: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  category: number;
  description: string;
  tier: number;
  status: number;
  approvalCount: bigint;
  rejectionCount: bigint;
  requiredApprovals: bigint;
  createdAt: bigint;
  timelockExpiry: bigint;
  expiresAt: bigint;
  isEmergency: boolean;
  budgetId: `0x${string}`;
}

interface RawBudget {
  budgetId: `0x${string}`;
  name: string;
  category: number;
  totalAllocation: bigint;
  spent: bigint;
  dailyLimit: bigint;
  weeklyLimit: bigint;
  monthlyLimit: bigint;
  createdAt: bigint;
  periodStart: bigint;
  periodEnd: bigint;
  active: boolean;
}

interface RawSpendingTracker {
  dailySpent: bigint;
  weeklySpent: bigint;
  monthlySpent: bigint;
  lastDayReset: bigint;
  lastWeekReset: bigint;
  lastMonthReset: bigint;
}

interface RawSignerConfig {
  totalSigners: bigint;
  smallThreshold: bigint;
  mediumThreshold: bigint;
  largeThreshold: bigint;
  emergencyThreshold: bigint;
}

function toProposal(raw: RawProposal): Proposal {
  return {
    proposalId: raw.proposalId,
    proposer: raw.proposer,
    recipient: raw.recipient,
    token: raw.token,
    amount: raw.amount,
    category: Number(raw.category),
    description: raw.description,
    tier: Number(raw.tier),
    status: Number(raw.status),
    approvalCount: Number(raw.approvalCount),
    rejectionCount: Number(raw.rejectionCount),
    requiredApprovals: Number(raw.requiredApprovals),
    createdAt: Number(raw.createdAt) * 1000,
    timelockExpiry: Number(raw.timelockExpiry) * 1000,
    expiresAt: Number(raw.expiresAt) * 1000,
    isEmergency: raw.isEmergency,
    budgetId: raw.budgetId,
  };
}

// ---------------------------------------------------------------------------
// useProposals — every proposal, discovered from ProposalCreated events
// ---------------------------------------------------------------------------

export function useProposals(): {
  proposals: Proposal[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { ref: clientRef, ready } = useClientRef();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !TREASURY) return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const created = await publicClient.getContractEvents({
          address: TREASURY,
          abi: MULTISIG_TREASURY_ABI,
          eventName: "ProposalCreated",
          fromBlock: 0n,
          toBlock: "latest",
        });

        const ids = dedupeLogs(created)
          .map((log) => (log.args as { proposalId?: `0x${string}` }).proposalId)
          .filter((id): id is `0x${string}` => Boolean(id));
        console.log("[probe] TREASURY", TREASURY, "logs", created.length, "ids", ids);

        const out = await Promise.all(
          ids.map(async (id) => {
            const raw = (await publicClient.readContract({
              address: TREASURY,
              abi: MULTISIG_TREASURY_ABI,
              functionName: "getProposal",
              args: [id],
            })) as RawProposal;
            return toProposal(raw);
          }),
        );
        // Newest first — the creation event order is chain order.
        if (!cancelled) setProposals(out.reverse());
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
  return { proposals, isLoading, error, refetch };
}

// ---------------------------------------------------------------------------
// useBudgets — active budgets plus their live rolling spend
// ---------------------------------------------------------------------------

export function useBudgets(): {
  budgets: Budget[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { ref: clientRef, ready } = useClientRef();
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !TREASURY) return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const ids = (await publicClient.readContract({
          address: TREASURY,
          abi: MULTISIG_TREASURY_ABI,
          functionName: "getActiveBudgets",
        })) as readonly `0x${string}`[];

        const out = await Promise.all(
          ids.map(async (id) => {
            const [budget, tracker] = await Promise.all([
              publicClient.readContract({
                address: TREASURY,
                abi: MULTISIG_TREASURY_ABI,
                functionName: "getBudget",
                args: [id],
              }) as Promise<RawBudget>,
              publicClient.readContract({
                address: TREASURY,
                abi: MULTISIG_TREASURY_ABI,
                functionName: "getSpendingTracker",
                args: [id],
              }) as Promise<RawSpendingTracker>,
            ]);
            return {
              budgetId: budget.budgetId,
              name: budget.name,
              category: Number(budget.category),
              totalAllocation: budget.totalAllocation,
              spent: budget.spent,
              dailyLimit: budget.dailyLimit,
              weeklyLimit: budget.weeklyLimit,
              monthlyLimit: budget.monthlyLimit,
              createdAt: Number(budget.createdAt) * 1000,
              periodStart: Number(budget.periodStart) * 1000,
              periodEnd: Number(budget.periodEnd) * 1000,
              active: budget.active,
              dailySpent: tracker.dailySpent,
              weeklySpent: tracker.weeklySpent,
              monthlySpent: tracker.monthlySpent,
            } satisfies Budget;
          }),
        );
        if (!cancelled) setBudgets(out);
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
  return { budgets, isLoading, error, refetch };
}

// ---------------------------------------------------------------------------
// useYieldProtocols — approved DeFi venues and their live allocation
// ---------------------------------------------------------------------------

export function useYieldProtocols(): {
  protocols: YieldProtocolInfo[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { ref: clientRef, ready } = useClientRef();
  const [protocols, setProtocols] = useState<YieldProtocolInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !TREASURY) return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const approved = await publicClient.getContractEvents({
          address: TREASURY,
          abi: MULTISIG_TREASURY_ABI,
          eventName: "YieldProtocolApproved",
          fromBlock: 0n,
          toBlock: "latest",
        });

        const addresses = [
          ...new Set(
            dedupeLogs(approved)
              .map((log) => (log.args as { protocol?: `0x${string}` }).protocol)
              .filter((a): a is `0x${string}` => Boolean(a)),
          ),
        ];

        const out = await Promise.all(
          addresses.map(async (addr) => {
            // Public mapping getter — positional array, not a named object.
            const raw = (await publicClient.readContract({
              address: TREASURY,
              abi: MULTISIG_TREASURY_ABI,
              functionName: "yieldProtocols",
              args: [addr],
            })) as readonly [`0x${string}`, string, bigint, bigint, boolean];
            return {
              protocolAddress: raw[0],
              name: raw[1],
              maxAllocation: raw[2],
              currentAllocation: raw[3],
              active: raw[4],
            } satisfies YieldProtocolInfo;
          }),
        );
        if (!cancelled) setProtocols(out);
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
  return { protocols, isLoading, error, refetch };
}

// ---------------------------------------------------------------------------
// useTreasuryHoldings — native balance plus every supported ERC20
// ---------------------------------------------------------------------------

export function useTreasuryHoldings(): {
  nativeBalance: bigint;
  tokens: TokenHolding[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { ref: clientRef, ready } = useClientRef();
  const [nativeBalance, setNativeBalance] = useState(0n);
  const [tokens, setTokens] = useState<TokenHolding[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !TREASURY) return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [native, supportedEvents] = await Promise.all([
          publicClient.getBalance({ address: TREASURY }),
          publicClient.getContractEvents({
            address: TREASURY,
            abi: MULTISIG_TREASURY_ABI,
            eventName: "TokenSupported",
            fromBlock: 0n,
            toBlock: "latest",
          }),
        ]);

        // A token can be toggled on and off; last event per address wins.
        const state = new Map<`0x${string}`, boolean>();
        for (const log of dedupeLogs(supportedEvents)) {
          const args = log.args as { token?: `0x${string}`; supported?: boolean };
          if (args.token) state.set(args.token, Boolean(args.supported));
        }
        const active = [...state.entries()]
          .filter(([, on]) => on)
          .map(([token]) => token);

        const holdings = await Promise.all(
          active.map(async (token) => {
            const [symbol, decimals, balance] = await Promise.all([
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
              publicClient.readContract({
                address: token,
                abi: ERC20_ABI,
                functionName: "balanceOf",
                args: [TREASURY],
              }) as Promise<bigint>,
            ]);
            return { token, symbol, decimals: Number(decimals), balance } satisfies TokenHolding;
          }),
        );

        if (!cancelled) {
          setNativeBalance(native);
          setTokens(holdings);
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
  }, [clientRef, ready, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { nativeBalance, tokens, isLoading, error, refetch };
}

// ---------------------------------------------------------------------------
// useSignerConfig — thresholds, signer set, and the caller's own signer status
// ---------------------------------------------------------------------------

export function useSignerConfig(): {
  config: SignerConfig | null;
  signers: `0x${string}`[];
  tiers: ApprovalTier[];
  isSigner: boolean;
  isAdmin: boolean;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { ref: clientRef, ready } = useClientRef();
  const { address } = useAccount();
  const [config, setConfig] = useState<SignerConfig | null>(null);
  const [signers, setSigners] = useState<`0x${string}`[]>([]);
  const [bounds, setBounds] = useState<{ small: bigint; large: bigint } | null>(null);
  const [timelocks, setTimelocks] = useState<{
    standard: number;
    large: number;
    emergency: number;
  } | null>(null);
  const [isSigner, setIsSigner] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !TREASURY) return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        // Generic over the ABI's own function-name union rather than `string`,
        // so a misspelled name is a build error instead of a runtime revert.
        // This is the payoff of generating the ABI with `as const`.
        const read = <N extends TreasuryReadFn>(
          functionName: N,
          args: readonly unknown[] = [],
        ) =>
          publicClient.readContract({
            address: TREASURY,
            abi: MULTISIG_TREASURY_ABI,
            functionName,
            args,
          } as Parameters<typeof publicClient.readContract>[0]);

        const [
          rawConfig,
          signerList,
          smallThreshold,
          largeThreshold,
          standardTimelock,
          largeTimelock,
          emergencyTimelock,
          signerRole,
          adminRole,
        ] = (await Promise.all([
          read("getSignerConfig"),
          read("getSigners"),
          read("SMALL_TX_THRESHOLD"),
          read("LARGE_TX_THRESHOLD"),
          read("STANDARD_TIMELOCK"),
          read("LARGE_TIMELOCK"),
          read("EMERGENCY_TIMELOCK"),
          read("SIGNER_ROLE"),
          read("ADMIN_ROLE"),
        ])) as [
          RawSignerConfig,
          readonly `0x${string}`[],
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          `0x${string}`,
          `0x${string}`,
        ];

        let signerFlag = false;
        let adminFlag = false;
        if (address) {
          [signerFlag, adminFlag] = (await Promise.all([
            read("hasRole", [signerRole, address]),
            read("hasRole", [adminRole, address]),
          ])) as [boolean, boolean];
        }

        if (cancelled) return;
        setConfig({
          totalSigners: Number(rawConfig.totalSigners),
          smallThreshold: Number(rawConfig.smallThreshold),
          mediumThreshold: Number(rawConfig.mediumThreshold),
          largeThreshold: Number(rawConfig.largeThreshold),
          emergencyThreshold: Number(rawConfig.emergencyThreshold),
        });
        setSigners([...signerList]);
        setBounds({ small: smallThreshold, large: largeThreshold });
        setTimelocks({
          standard: Number(standardTimelock),
          large: Number(largeTimelock),
          emergency: Number(emergencyTimelock),
        });
        setIsSigner(signerFlag);
        setIsAdmin(adminFlag);
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

  /**
   * The approval matrix the contract actually enforces, assembled from its own
   * constants rather than restated in the UI. Emergency is not a size band —
   * it is a flag on the proposal — so it carries no amount bounds.
   */
  const tiers = useMemo<ApprovalTier[]>(() => {
    if (!config || !bounds || !timelocks) return [];
    return [
      {
        tier: "Small",
        minAmount: 0n,
        maxAmount: bounds.small,
        requiredSignatures: config.smallThreshold,
        timelockSeconds: timelocks.standard,
      },
      {
        tier: "Medium",
        minAmount: bounds.small,
        maxAmount: bounds.large,
        requiredSignatures: config.mediumThreshold,
        timelockSeconds: timelocks.standard,
      },
      {
        tier: "Large",
        minAmount: bounds.large,
        maxAmount: null,
        requiredSignatures: config.largeThreshold,
        timelockSeconds: timelocks.large,
      },
      {
        tier: "Emergency",
        minAmount: 0n,
        maxAmount: null,
        requiredSignatures: config.emergencyThreshold,
        timelockSeconds: timelocks.emergency,
      },
    ];
  }, [config, bounds, timelocks]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { config, signers, tiers, isSigner, isAdmin, isLoading, error, refetch };
}

// ---------------------------------------------------------------------------
// useHasApproved — whether the connected signer already approved a proposal
// ---------------------------------------------------------------------------

export function useHasApproved(proposalId?: `0x${string}`): boolean {
  const { ref: clientRef, ready } = useClientRef();
  const { address } = useAccount();
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !TREASURY || !proposalId || !address) {
      setApproved(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = (await publicClient.readContract({
          address: TREASURY,
          abi: MULTISIG_TREASURY_ABI,
          functionName: "hasApproved",
          args: [proposalId, address],
        })) as boolean;
        if (!cancelled) setApproved(result);
      } catch {
        if (!cancelled) setApproved(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientRef, ready, proposalId, address]);

  return approved;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateProposalInput {
  recipient: `0x${string}`;
  /** address(0) for the native asset. */
  token: `0x${string}`;
  amount: bigint;
  category: number;
  description: string;
  isEmergency: boolean;
  /** 32 zero bytes when the proposal is not charged to a budget. */
  budgetId: `0x${string}`;
}

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export const NO_BUDGET = ZERO_BYTES32;

/**
 * Proposal lifecycle actions. Each returns the transaction hash so the caller
 * can wait for the receipt before refetching.
 */
export function useProposalActions() {
  const { writeContractAsync } = useSafeWriteContract();
  const [pending, setPending] = useState<string | null>(null);

  const call = useCallback(
    async (label: string, functionName: string, args: readonly unknown[], value?: bigint) => {
      setPending(label);
      try {
        return await writeContractAsync({
          address: TREASURY,
          abi: MULTISIG_TREASURY_ABI,
          functionName,
          args,
          ...(value !== undefined ? { value } : {}),
        });
      } finally {
        setPending(null);
      }
    },
    [writeContractAsync],
  );

  const createProposal = useCallback(
    (input: CreateProposalInput) =>
      call(
        "create",
        "createProposal",
        [
          input.recipient,
          input.token,
          input.amount,
          input.category,
          input.description,
          input.isEmergency,
          input.budgetId,
        ],
        // Native proposals must be funded at creation time; ERC20 proposals
        // draw on the treasury's existing token balance.
        input.token === NATIVE_TOKEN ? input.amount : undefined,
      ),
    [call],
  );

  const approveProposal = useCallback(
    (id: `0x${string}`) => call("approve", "approveProposal", [id]),
    [call],
  );
  const rejectProposal = useCallback(
    (id: `0x${string}`) => call("reject", "rejectProposal", [id]),
    [call],
  );
  const executeProposal = useCallback(
    (id: `0x${string}`) => call("execute", "executeProposal", [id]),
    [call],
  );
  const cancelProposal = useCallback(
    (id: `0x${string}`) => call("cancel", "cancelProposal", [id]),
    [call],
  );

  return {
    createProposal,
    approveProposal,
    rejectProposal,
    executeProposal,
    cancelProposal,
    pending,
  };
}

export interface CreateBudgetInput {
  name: string;
  category: number;
  /** USD-equivalent, 6 decimals, matching the contract's accounting unit. */
  totalAllocation: bigint;
  dailyLimit: bigint;
  weeklyLimit: bigint;
  monthlyLimit: bigint;
  /** Budget period length in seconds. */
  periodDuration: bigint;
}

export function useBudgetActions() {
  const { writeContractAsync } = useSafeWriteContract();
  const [pending, setPending] = useState(false);

  const createBudget = useCallback(
    async (input: CreateBudgetInput) => {
      setPending(true);
      try {
        return await writeContractAsync({
          address: TREASURY,
          abi: MULTISIG_TREASURY_ABI,
          functionName: "createBudget",
          args: [
            input.name,
            input.category,
            input.totalAllocation,
            input.dailyLimit,
            input.weeklyLimit,
            input.monthlyLimit,
            input.periodDuration,
          ],
        });
      } finally {
        setPending(false);
      }
    },
    [writeContractAsync],
  );

  return { createBudget, pending };
}

export function useYieldActions() {
  const { writeContractAsync } = useSafeWriteContract();
  const [pending, setPending] = useState(false);

  const allocateToYield = useCallback(
    async (protocol: `0x${string}`, token: `0x${string}`, amount: bigint) => {
      setPending(true);
      try {
        return await writeContractAsync({
          address: TREASURY,
          abi: MULTISIG_TREASURY_ABI,
          functionName: "allocateToYield",
          args: [protocol, token, amount],
        });
      } finally {
        setPending(false);
      }
    },
    [writeContractAsync],
  );

  return { allocateToYield, pending };
}

// ---------------------------------------------------------------------------
// useTreasuryActivity — a merged, chronological feed of treasury events
// ---------------------------------------------------------------------------

export interface ActivityEntry {
  kind:
    | "ProposalCreated"
    | "ProposalApproved"
    | "ProposalRejected"
    | "ProposalExecuted"
    | "ProposalCancelled"
    | "BudgetCreated"
    | "BudgetSpent"
    | "YieldAllocated"
    | "SignerAdded"
    | "SignerRemoved";
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  args: Record<string, unknown>;
}

const ACTIVITY_EVENTS: ActivityEntry["kind"][] = [
  "ProposalCreated",
  "ProposalApproved",
  "ProposalRejected",
  "ProposalExecuted",
  "ProposalCancelled",
  "BudgetCreated",
  "BudgetSpent",
  "YieldAllocated",
  "SignerAdded",
  "SignerRemoved",
];

export function useTreasuryActivity(): {
  activity: ActivityEntry[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const { ref: clientRef, ready } = useClientRef();
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const publicClient = clientRef.current;
    if (!publicClient || !TREASURY) return;
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setError(null);
      try {
        const batches = await Promise.all(
          ACTIVITY_EVENTS.map(async (eventName) => {
            const logs = await publicClient.getContractEvents({
              address: TREASURY,
              abi: MULTISIG_TREASURY_ABI,
              eventName,
              fromBlock: 0n,
              toBlock: "latest",
            });
            return dedupeLogs(logs).map((log) => ({
              kind: eventName,
              blockNumber: log.blockNumber ?? 0n,
              transactionHash: (log.transactionHash ?? "0x") as `0x${string}`,
              args: (log.args ?? {}) as Record<string, unknown>,
            }));
          }),
        );
        const merged = batches
          .flat()
          .sort((a, b) => (a.blockNumber === b.blockNumber ? 0 : a.blockNumber > b.blockNumber ? -1 : 1));
        if (!cancelled) setActivity(merged);
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
  return { activity, isLoading, error, refetch };
}

// ---------------------------------------------------------------------------
// Derived treasury summary
// ---------------------------------------------------------------------------

export interface TreasurySummary {
  /** Native asset held by the treasury, in wei. */
  nativeBalance: bigint;
  tokens: TokenHolding[];
  pendingProposals: number;
  approvedAwaitingExecution: number;
  executedProposals: number;
  totalSigners: number;
  activeBudgets: number;
  /** Sum of currentAllocation across active yield protocols. */
  deployedInYield: bigint;
}

/**
 * Composite view backing the overview tab. Every field is derived from live
 * contract state — there is no independent source of truth to reconcile.
 */
export function useTreasury() {
  const holdings = useTreasuryHoldings();
  const { proposals, isLoading: proposalsLoading, error: proposalsError, refetch: refetchProposals } =
    useProposals();
  const { budgets, isLoading: budgetsLoading, refetch: refetchBudgets } = useBudgets();
  const { protocols, isLoading: yieldLoading, refetch: refetchYield } = useYieldProtocols();
  const signerState = useSignerConfig();

  const summary = useMemo<TreasurySummary>(() => {
    const byStatus = (name: ProposalStatusName) =>
      proposals.filter((p) => PROPOSAL_STATUS[p.status] === name).length;
    return {
      nativeBalance: holdings.nativeBalance,
      tokens: holdings.tokens,
      pendingProposals: byStatus("Pending"),
      approvedAwaitingExecution: byStatus("Approved"),
      executedProposals: byStatus("Executed"),
      totalSigners: signerState.config?.totalSigners ?? 0,
      activeBudgets: budgets.filter((b) => b.active).length,
      deployedInYield: protocols
        .filter((p) => p.active)
        .reduce((sum, p) => sum + p.currentAllocation, 0n),
    };
  }, [holdings, proposals, budgets, protocols, signerState.config]);

  const refetchAll = useCallback(() => {
    holdings.refetch();
    refetchProposals();
    refetchBudgets();
    refetchYield();
    signerState.refetch();
  }, [holdings, refetchProposals, refetchBudgets, refetchYield, signerState]);

  return {
    summary,
    proposals,
    budgets,
    protocols,
    signers: signerState.signers,
    signerConfig: signerState.config,
    tiers: signerState.tiers,
    isSigner: signerState.isSigner,
    isAdmin: signerState.isAdmin,
    isLoading:
      holdings.isLoading ||
      proposalsLoading ||
      budgetsLoading ||
      yieldLoading ||
      signerState.isLoading,
    error: holdings.error ?? proposalsError ?? signerState.error,
    refetch: refetchAll,
  };
}
