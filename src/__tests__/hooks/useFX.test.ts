/**
 * Tests for the contract-backed FX hedging hooks.
 *
 * These replace a suite that asserted a mock's behaviour: that a timer fired,
 * that a simulated rate ticker kept a bid/ask spread, and that "closeHedge"
 * mutated local React state. It passed reliably against a vault that was never
 * contacted.
 *
 * What matters here is the translation between contract state and UI state —
 * enum ordering, bytes3 currency decoding, 8-decimal fixed point, and the
 * forward-versus-option distinction the contract actually enforces.
 */

import { renderHook, waitFor, act } from "@testing-library/react";

const mockReads = jest.fn();
const mockEvents = jest.fn();
const mockWriteContractAsync = jest.fn();

jest.mock("@/config/chains", () => ({
  activeChain: { id: 7332 },
  CONTRACT_ADDRESSES: {
    fxHedgingVault: "0xe7c2a73131dd48d8ac46dcd7ab80c8cbee5b410a",
    usdcToken: "0x65007c1351d9fbb88d49533c843cb1ef589557fe",
  },
}));

const mockPublicClient = {
  readContract: (args: any) => mockReads(args),
  getContractEvents: (args: any) => mockEvents(args),
};

jest.mock("wagmi", () => ({
  useAccount: () => ({ address: "0x1111111111111111111111111111111111111111" }),
  usePublicClient: () => mockPublicClient,
}));

jest.mock("@/hooks/useSafeWriteContract", () => ({
  useSafeWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
}));

import {
  useCurrencyPairs,
  useMyPositions,
  useFXActions,
  decodeCurrency,
  HEDGE_TYPE,
  POSITION_STATUS,
  RATE_DECIMALS,
} from "@/hooks/useFX";

const PAIR_ID = "0x42906ab0f0d1ab5e5e75df71ce5b26ae6c2d768eb83762ecbea1156a89d5cdc4";

const rawPair = (over: Partial<Record<string, unknown>> = {}) => ({
  baseCurrency: "0x414544", // "AED"
  quoteCurrency: "0x555344", // "USD"
  pairId: PAIR_ID,
  active: true,
  maxHedgeRatio: 10_000n,
  marginRequirementBps: 500n,
  maintenanceMarginBps: 300n,
  ...over,
});

const rawPosition = (over: Partial<Record<string, unknown>> = {}) => ({
  positionId: "0xpos1",
  hedger: "0x1111111111111111111111111111111111111111",
  pairId: PAIR_ID,
  hedgeType: 0,
  status: 0,
  notionalAmount: 100_000_00000000n, // 100,000 at 8dp
  lockedRate: 27_230_000n, // 0.2723
  premium: 0n,
  collateralToken: "0x65007c1351d9fbb88d49533c843cb1ef589557fe",
  collateralAmount: 5_000_00000000n,
  createdAt: 1_700_000_000n,
  maturityDate: 1_700_600_000n,
  settledAt: 0n,
  settlementAmount: 0n,
  markToMarketValue: 0n,
  lastMtMUpdate: 0n,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe("contract enum ordering", () => {
  it("matches FXHedgingVault.HedgeType", () => {
    expect(HEDGE_TYPE).toEqual(["Forward", "Call option", "Put option"]);
  });

  it("matches FXHedgingVault.PositionStatus", () => {
    expect(POSITION_STATUS).toEqual([
      "Active",
      "Matured",
      "Settled",
      "Exercised",
      "Expired",
      "Liquidated",
      "Emergency unwound",
    ]);
  });

  it("uses the contract's 8-decimal rate precision", () => {
    // RATE_PRECISION() reads 100000000 on the deployed vault.
    expect(RATE_DECIMALS).toBe(8);
  });
});

describe("decodeCurrency", () => {
  it("decodes a bytes3 ASCII code", () => {
    expect(decodeCurrency("0x414544")).toBe("AED");
    expect(decodeCurrency("0x555344")).toBe("USD");
  });

  it("stops at padding rather than emitting NUL characters", () => {
    expect(decodeCurrency("0x555300")).toBe("US");
  });

  it("tolerates a missing 0x prefix", () => {
    expect(decodeCurrency("474250")).toBe("GBP");
  });
});

describe("useCurrencyPairs", () => {
  it("reads active pairs and their latest rate", async () => {
    mockReads.mockImplementation(({ functionName }: any) => {
      if (functionName === "getActivePairs") return Promise.resolve([PAIR_ID]);
      if (functionName === "getCurrencyPair") return Promise.resolve(rawPair());
      if (functionName === "getLatestRate")
        return Promise.resolve([27_230_000n, 1_700_000_000n]);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useCurrencyPairs());
    await waitFor(() => expect(result.current.pairs).toHaveLength(1));

    const pair = result.current.pairs[0];
    expect(pair.base).toBe("AED");
    expect(pair.quote).toBe("USD");
    expect(pair.rate).toBe(27_230_000n);
    expect(pair.marginRequirementBps).toBe(500);
    expect(pair.maintenanceMarginBps).toBe(300);
  });

  it("treats an unpublished rate as zero rather than failing the whole read", async () => {
    // getLatestRate reverts when the oracle has never submitted. That is a
    // normal state for a new pair, not an error for the page.
    mockReads.mockImplementation(({ functionName }: any) => {
      if (functionName === "getActivePairs") return Promise.resolve([PAIR_ID]);
      if (functionName === "getCurrencyPair") return Promise.resolve(rawPair());
      if (functionName === "getLatestRate") return Promise.reject(new Error("stale"));
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useCurrencyPairs());
    await waitFor(() => expect(result.current.pairs).toHaveLength(1));

    expect(result.current.pairs[0].rate).toBe(0n);
    expect(result.current.error).toBeNull();
  });

  it("surfaces a failure to list pairs", async () => {
    mockReads.mockRejectedValue(new Error("rpc down"));
    const { result } = renderHook(() => useCurrencyPairs());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
  });
});

describe("useMyPositions", () => {
  it("reads the connected account's positions with their margin state", async () => {
    mockReads.mockImplementation(({ functionName }: any) => {
      if (functionName === "getBusinessPositions") return Promise.resolve(["0xpos1"]);
      if (functionName === "getPosition") return Promise.resolve(rawPosition());
      if (functionName === "isUnderMargined") return Promise.resolve(true);
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useMyPositions());
    await waitFor(() => expect(result.current.positions).toHaveLength(1));

    const p = result.current.positions[0];
    expect(p.underMargined).toBe(true);
    expect(p.hedgeType).toBe(0);
    expect(p.createdAt).toBe(1_700_000_000_000); // seconds -> ms
  });

  it("does not fail the position when the margin check reverts", async () => {
    mockReads.mockImplementation(({ functionName }: any) => {
      if (functionName === "getBusinessPositions") return Promise.resolve(["0xpos1"]);
      if (functionName === "getPosition") return Promise.resolve(rawPosition());
      if (functionName === "isUnderMargined") return Promise.reject(new Error("no rate"));
      return Promise.resolve(undefined);
    });

    const { result } = renderHook(() => useMyPositions());
    await waitFor(() => expect(result.current.positions).toHaveLength(1));
    expect(result.current.positions[0].underMargined).toBe(false);
  });
});

describe("useFXActions", () => {
  it("sends createForward without strike or premium", async () => {
    mockWriteContractAsync.mockResolvedValue("0xhash");
    const { result } = renderHook(() => useFXActions());

    await act(async () => {
      await result.current.createForward({
        pairId: PAIR_ID as `0x${string}`,
        notionalAmount: 1000n,
        maturityDate: 1_800_000_000n,
        collateralToken: "0x65007c1351d9fbb88d49533c843cb1ef589557fe",
        collateralAmount: 50n,
      });
    });

    const call = mockWriteContractAsync.mock.calls[0][0];
    expect(call.functionName).toBe("createForward");
    // A forward is an obligation at the locked rate: five arguments, no strike.
    expect(call.args).toHaveLength(5);
  });

  it("sends createOption with hedge type, strike and premium", async () => {
    mockWriteContractAsync.mockResolvedValue("0xhash");
    const { result } = renderHook(() => useFXActions());

    await act(async () => {
      await result.current.createOption({
        pairId: PAIR_ID as `0x${string}`,
        hedgeType: 1,
        notionalAmount: 1000n,
        strikeRate: 27_230_000n,
        premium: 10n,
        maturityDate: 1_800_000_000n,
        collateralToken: "0x65007c1351d9fbb88d49533c843cb1ef589557fe",
        collateralAmount: 50n,
      });
    });

    const call = mockWriteContractAsync.mock.calls[0][0];
    expect(call.functionName).toBe("createOption");
    expect(call.args).toHaveLength(8);
    expect(call.args[1]).toBe(1); // call option
    expect(call.args[3]).toBe(27_230_000n); // strike
  });

  it("passes the position id for each lifecycle action", async () => {
    mockWriteContractAsync.mockResolvedValue("0xhash");
    const { result } = renderHook(() => useFXActions());

    for (const [fn, name] of [
      [result.current.settleForward, "settleForward"],
      [result.current.exerciseOption, "exerciseOption"],
      [result.current.expireOption, "expireOption"],
      [result.current.updateMarkToMarket, "updateMarkToMarket"],
    ] as const) {
      mockWriteContractAsync.mockClear();
      await act(async () => {
        await fn("0xpos1");
      });
      expect(mockWriteContractAsync).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: name, args: ["0xpos1"] }),
      );
    }
  });

  it("clears the pending label after a rejected write", async () => {
    mockWriteContractAsync.mockRejectedValue(new Error("user rejected"));
    const { result } = renderHook(() => useFXActions());

    await act(async () => {
      await expect(result.current.settleForward("0xpos1")).rejects.toThrow(
        "user rejected",
      );
    });

    expect(result.current.pending).toBeNull();
  });
});
