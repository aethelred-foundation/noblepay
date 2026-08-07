/**
 * Tests for the contract-backed treasury hooks.
 *
 * These replace an earlier suite that asserted the behaviour of a mock: it
 * checked that a setTimeout fired, that three fabricated proposals appeared,
 * and that "voting" mutated local React state. All of that passed while the
 * page showed data no contract had ever produced.
 *
 * What is worth pinning instead is the translation layer between contract
 * state and UI state — status/tier enum ordering, the approval matrix built
 * from contract constants, native-vs-ERC20 call shape, and the log handling
 * that the Aethelred node's duplicate-log behaviour makes necessary.
 */

import { renderHook, waitFor, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// wagmi is mocked at the module boundary; the hooks only use publicClient +
// useAccount + the write hook, so a small fake client covers the surface.
// ---------------------------------------------------------------------------

// jest.mock factories are hoisted above const declarations, so anything they
// close over must be named mock* — that prefix is jest's documented escape
// hatch from the out-of-scope-variable guard.
const mockReads = jest.fn();
const mockEvents = jest.fn();
const mockGetBalance = jest.fn();
const mockWriteContractAsync = jest.fn();
// The chains factory runs at import time — before any const in this file has
// initialized — so its values must be literals, not references. The jest.fn()
// references above are fine: those factories only run during render.
jest.mock("@/config/chains", () => ({
  activeChain: { id: 7332 },
  CONTRACT_ADDRESSES: {
    multisigTreasury: "0x663f3ad617193148711d28f5334ee4ed07016602",
  },
}));

const mockClientMethods = () => ({
  readContract: (args: any) => mockReads(args),
  getContractEvents: (args: any) => mockEvents(args),
  getBalance: (args: any) => mockGetBalance(args),
});

const mockStableClient = mockClientMethods();

/**
 * Real wagmi returns a NEW client object on re-render. Default to the stable
 * instance for ordinary assertions, and flip this on for the regression test
 * that pins the behaviour under the real, unstable condition.
 */
let mockUnstableClient = false;

jest.mock("wagmi", () => ({
  useAccount: () => ({ address: "0x1111111111111111111111111111111111111111" }),
  usePublicClient: () =>
    mockUnstableClient ? mockClientMethods() : mockStableClient,
}));

jest.mock("@/hooks/useSafeWriteContract", () => ({
  useSafeWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
}));

const SIGNER = "0x1111111111111111111111111111111111111111";
const reads = mockReads;
const events = mockEvents;
const getBalance = mockGetBalance;
const writeContractAsync = mockWriteContractAsync;

import {
  useProposals,
  useSignerConfig,
  useTreasuryHoldings,
  useProposalActions,
  PROPOSAL_STATUS,
  TX_TIER,
  SPENDING_CATEGORY,
  NATIVE_TOKEN,
  NO_BUDGET,
} from "@/hooks/useTreasury";

/** Minimal Proposal struct as viem decodes a named tuple. */
const proposal = (over: Partial<Record<string, unknown>> = {}) => ({
  proposalId: "0xaaa",
  proposer: SIGNER,
  recipient: "0x2222222222222222222222222222222222222222",
  token: NATIVE_TOKEN,
  amount: 1000n,
  category: 0,
  description: "test",
  tier: 1,
  status: 0,
  approvalCount: 1n,
  rejectionCount: 0n,
  requiredApprovals: 2n,
  createdAt: 1_700_000_000n,
  timelockExpiry: 1_700_086_400n,
  expiresAt: 1_700_600_000n,
  isEmergency: false,
  budgetId: NO_BUDGET,
  ...over,
});

const log = (args: Record<string, unknown>, tx = "0x1", logIndex = 0) => ({
  args,
  transactionHash: tx,
  logIndex,
  blockNumber: 1n,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUnstableClient = false;
});

// ---------------------------------------------------------------------------
// Regression: the client identity churn that emptied the treasury console
// ---------------------------------------------------------------------------

describe("re-render stability", () => {
  /**
   * wagmi hands back a fresh client object on every commit. When the hooks
   * used that object as an effect dependency, each re-render tore down the
   * in-flight read, and the cleanup's `cancelled = true` discarded a result
   * that was about to commit. In the browser this rendered "Proposals (0)"
   * against a treasury that had one, with the event fetch succeeding on every
   * attempt.
   *
   * The lost-commit race itself is timing-dependent and does not reproduce
   * reliably under jsdom — a version of this test that merely re-renders and
   * waits passes against the buggy code too. What IS deterministic, and what
   * actually causes the race, is the effect re-firing on every render. That is
   * the invariant pinned below; it fails against the pre-fix hook.
   */
  it("does not refetch on every render", async () => {
    mockUnstableClient = true;
    mockEvents.mockResolvedValue([log({ proposalId: "0xaaa" })]);
    mockReads.mockResolvedValue(proposal());

    const { result, rerender } = renderHook(() => useProposals());
    await waitFor(() => expect(result.current.proposals).toHaveLength(1));

    const callsAfterLoad = mockEvents.mock.calls.length;
    rerender();
    rerender();
    expect(mockEvents.mock.calls.length).toBe(callsAfterLoad);
  });

  it("still refetches when explicitly asked", async () => {
    mockEvents.mockResolvedValue([log({ proposalId: "0xaaa" })]);
    mockReads.mockResolvedValue(proposal());

    const { result } = renderHook(() => useProposals());
    await waitFor(() => expect(result.current.proposals).toHaveLength(1));
    const before = mockEvents.mock.calls.length;

    await act(async () => {
      result.current.refetch();
    });
    await waitFor(() =>
      expect(mockEvents.mock.calls.length).toBeGreaterThan(before),
    );
  });
});

// ---------------------------------------------------------------------------
// Enum ordering — these are on-chain uint8 values; reordering silently
// mislabels every proposal in the UI.
// ---------------------------------------------------------------------------

describe("contract enum ordering", () => {
  it("matches MultiSigTreasury.ProposalStatus", () => {
    expect(PROPOSAL_STATUS).toEqual([
      "Pending",
      "Approved",
      "Executed",
      "Rejected",
      "Cancelled",
      "Expired",
    ]);
  });

  it("matches MultiSigTreasury.TxTier", () => {
    expect(TX_TIER).toEqual(["Small", "Medium", "Large", "Emergency"]);
  });

  it("matches MultiSigTreasury.SpendingCategory", () => {
    expect(SPENDING_CATEGORY).toEqual([
      "Operations",
      "Payroll",
      "Infrastructure",
      "Marketing",
      "Legal",
      "Research",
      "Partnerships",
      "Other",
    ]);
  });
});

// ---------------------------------------------------------------------------
// useProposals
// ---------------------------------------------------------------------------

describe("useProposals", () => {
  it("discovers proposals from ProposalCreated and reads each back", async () => {
    events.mockResolvedValue([
      log({ proposalId: "0xaaa" }, "0x1", 0),
      log({ proposalId: "0xbbb" }, "0x2", 0),
    ]);
    reads.mockImplementation(({ args }: any) =>
      Promise.resolve(proposal({ proposalId: args[0] })),
    );

    const { result } = renderHook(() => useProposals());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.proposals).toHaveLength(2);
    // Newest first: creation-event order is chain order, so it is reversed.
    expect(result.current.proposals[0].proposalId).toBe("0xbbb");
    expect(result.current.error).toBeNull();
  });

  it("collapses a log the RPC returned twice", async () => {
    // The Aethelred node can return the same log more than once for one query.
    const dup = log({ proposalId: "0xaaa" }, "0x1", 0);
    events.mockResolvedValue([dup, { ...dup }]);
    reads.mockResolvedValue(proposal());

    const { result } = renderHook(() => useProposals());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.proposals).toHaveLength(1);
  });

  it("converts contract seconds to milliseconds", async () => {
    events.mockResolvedValue([log({ proposalId: "0xaaa" })]);
    reads.mockResolvedValue(proposal({ createdAt: 1_700_000_000n }));

    const { result } = renderHook(() => useProposals());
    await waitFor(() => expect(result.current.proposals).toHaveLength(1));

    expect(result.current.proposals[0].createdAt).toBe(1_700_000_000_000);
  });

  it("surfaces a read failure instead of rendering empty", async () => {
    events.mockRejectedValue(new Error("rpc down"));

    const { result } = renderHook(() => useProposals());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.proposals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// useSignerConfig — the approval matrix must come from the contract, not the UI
// ---------------------------------------------------------------------------

describe("useSignerConfig", () => {
  const wireReads = () =>
    reads.mockImplementation(({ functionName }: any) => {
      switch (functionName) {
        case "getSignerConfig":
          return Promise.resolve({
            totalSigners: 5n,
            smallThreshold: 1n,
            mediumThreshold: 2n,
            largeThreshold: 3n,
            emergencyThreshold: 4n,
          });
        case "getSigners":
          return Promise.resolve([SIGNER]);
        case "SMALL_TX_THRESHOLD":
          return Promise.resolve(10_000_000_000n); // $10k, 6dp
        case "LARGE_TX_THRESHOLD":
          return Promise.resolve(100_000_000_000n); // $100k, 6dp
        case "STANDARD_TIMELOCK":
          return Promise.resolve(86_400n);
        case "LARGE_TIMELOCK":
          return Promise.resolve(172_800n);
        case "EMERGENCY_TIMELOCK":
          return Promise.resolve(3_600n);
        case "SIGNER_ROLE":
          return Promise.resolve("0xsigner");
        case "ADMIN_ROLE":
          return Promise.resolve("0xadmin");
        case "hasRole":
          return Promise.resolve(true);
        default:
          return Promise.resolve(undefined);
      }
    });

  it("builds the tier matrix from contract constants", async () => {
    wireReads();
    const { result } = renderHook(() => useSignerConfig());
    await waitFor(() => expect(result.current.tiers).toHaveLength(4));

    const [small, medium, large, emergency] = result.current.tiers;
    expect(small).toMatchObject({
      tier: "Small",
      minAmount: 0n,
      maxAmount: 10_000_000_000n,
      requiredSignatures: 1,
      timelockSeconds: 86_400,
    });
    expect(medium).toMatchObject({
      minAmount: 10_000_000_000n,
      maxAmount: 100_000_000_000n,
      requiredSignatures: 2,
    });
    // Large is unbounded above.
    expect(large.maxAmount).toBeNull();
    expect(large.timelockSeconds).toBe(172_800);
    // Emergency is a flag, not a size band, so it carries no bounds.
    expect(emergency.maxAmount).toBeNull();
    expect(emergency.requiredSignatures).toBe(4);
  });

  it("reports the connected account's signer and admin roles", async () => {
    wireReads();
    const { result } = renderHook(() => useSignerConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isSigner).toBe(true);
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.config?.totalSigners).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// useTreasuryHoldings
// ---------------------------------------------------------------------------

describe("useTreasuryHoldings", () => {
  it("excludes a token that was later toggled unsupported", async () => {
    getBalance.mockResolvedValue(5_000_000_000_000_000_000n);
    // Same token supported, then removed: the last event wins.
    events.mockResolvedValue([
      log({ token: "0xtok1", supported: true }, "0x1", 0),
      log({ token: "0xtok1", supported: false }, "0x2", 0),
      log({ token: "0xtok2", supported: true }, "0x3", 0),
    ]);
    reads.mockImplementation(({ functionName }: any) => {
      if (functionName === "symbol") return Promise.resolve("USDC");
      if (functionName === "decimals") return Promise.resolve(6);
      if (functionName === "balanceOf") return Promise.resolve(1_000_000n);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useTreasuryHoldings());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tokens.map((t) => t.token)).toEqual(["0xtok2"]);
    expect(result.current.nativeBalance).toBe(5_000_000_000_000_000_000n);
  });
});

// ---------------------------------------------------------------------------
// Writes — native and ERC20 proposals have different call shapes
// ---------------------------------------------------------------------------

describe("useProposalActions", () => {
  it("funds a native proposal with msg.value", async () => {
    writeContractAsync.mockResolvedValue("0xhash");
    const { result } = renderHook(() => useProposalActions());

    await act(async () => {
      await result.current.createProposal({
        recipient: "0x2222222222222222222222222222222222222222",
        token: NATIVE_TOKEN,
        amount: 42n,
        category: 0,
        description: "native",
        isEmergency: false,
        budgetId: NO_BUDGET,
      });
    });

    expect(writeContractAsync).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "createProposal", value: 42n }),
    );
  });

  it("does not attach value to an ERC20 proposal", async () => {
    writeContractAsync.mockResolvedValue("0xhash");
    const { result } = renderHook(() => useProposalActions());

    await act(async () => {
      await result.current.createProposal({
        recipient: "0x2222222222222222222222222222222222222222",
        token: "0x3333333333333333333333333333333333333333",
        amount: 42n,
        category: 0,
        description: "erc20",
        isEmergency: false,
        budgetId: NO_BUDGET,
      });
    });

    const call = writeContractAsync.mock.calls[0][0];
    expect(call.functionName).toBe("createProposal");
    expect(call).not.toHaveProperty("value");
  });

  it("sends the proposal id for each lifecycle action", async () => {
    writeContractAsync.mockResolvedValue("0xhash");
    const { result } = renderHook(() => useProposalActions());

    for (const [fn, name] of [
      [result.current.approveProposal, "approveProposal"],
      [result.current.rejectProposal, "rejectProposal"],
      [result.current.executeProposal, "executeProposal"],
      [result.current.cancelProposal, "cancelProposal"],
    ] as const) {
      writeContractAsync.mockClear();
      await act(async () => {
        await fn("0xaaa");
      });
      expect(writeContractAsync).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: name, args: ["0xaaa"] }),
      );
    }
  });

  it("clears the pending label after a write rejects", async () => {
    writeContractAsync.mockRejectedValue(new Error("user rejected"));
    const { result } = renderHook(() => useProposalActions());

    await act(async () => {
      await expect(result.current.approveProposal("0xaaa")).rejects.toThrow(
        "user rejected",
      );
    });

    expect(result.current.pending).toBeNull();
  });
});
