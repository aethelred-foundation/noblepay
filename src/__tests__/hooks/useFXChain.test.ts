import { renderHook } from "@testing-library/react";

import { useFXChain } from "@/hooks/useFXChain";

const mockInvalidate = jest.fn().mockResolvedValue(undefined);
const mockApiRequest = jest.fn().mockResolvedValue({});
const mockQueryOptions: Record<string, any> = {};
const mockQueryStates: Record<string, any> = {};

jest.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => {
    const key = options.queryKey.join(":");
    mockQueryOptions[key] = options;
    return {
      data: mockQueryStates[key]?.data,
      isLoading: mockQueryStates[key]?.isLoading ?? false,
      error: mockQueryStates[key]?.error ?? null,
    };
  },
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));
jest.mock("@/lib/api", () => ({
  ...jest.requireActual("@/lib/api"),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

const PAIRS = "fx:chain:pairs";
const POSITIONS = "fx:chain:positions";

const position = (over: Record<string, unknown> = {}) => ({
  positionId: "0xpos1",
  hedger: "0x1111",
  pairId: "0xpair1",
  hedgeType: "FORWARD",
  status: "ACTIVE",
  notionalAmount: "10000000000",
  lockedRate: "27230000",
  premium: "0",
  collateralToken: "0xusdc",
  collateralAmount: "500000000",
  createdAt: "1700000000",
  maturityDate: "1700600000",
  settledAt: "0",
  settlementAmount: "0",
  markToMarketValue: "0",
  lastMtMUpdate: "0",
  underMargined: false,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockQueryStates)) delete mockQueryStates[key];
});

describe("useFXChain", () => {
  it("reads the vault endpoints, not the database ones", () => {
    renderHook(() => useFXChain());
    mockQueryOptions[PAIRS].queryFn({ signal: undefined });
    mockQueryOptions[POSITIONS].queryFn({ signal: undefined });
    const paths = mockApiRequest.mock.calls.map((c) => c[0]);
    expect(paths).toEqual(["/v1/fx/chain/pairs", "/v1/fx/chain/positions"]);
    expect(paths).not.toContain("/v1/fx/rates");
  });

  it("exposes rateDecimals so callers can scale the fixed-point values", () => {
    mockQueryStates[PAIRS] = {
      data: {
        configured: true,
        address: "0xvault",
        rateDecimals: 8,
        settlementFeeBps: 25,
        pairs: [],
        dataSource: "CHAIN_FX_HEDGING_VAULT",
        readAtBlock: "1",
      },
    };
    const { result } = renderHook(() => useFXChain());
    expect(result.current.rateDecimals).toBe(8);
  });

  it("preserves a null rate for a pair the oracle has not published", () => {
    mockQueryStates[PAIRS] = {
      data: {
        configured: true,
        address: "0xvault",
        rateDecimals: 8,
        settlementFeeBps: 25,
        pairs: [{ pairId: "0xp", base: "AED", quote: "USD", rate: null }],
        dataSource: "CHAIN_FX_HEDGING_VAULT",
        readAtBlock: "1",
      },
    };
    const { result } = renderHook(() => useFXChain());
    expect(result.current.pairs[0].rate).toBeNull();
  });

  it("counts only positions the margin check actually flagged", () => {
    // underMargined === null means "could not be evaluated", usually because
    // the pair has no published rate. Counting it as safe would understate
    // risk; counting it as breached would cry wolf. It gets its own bucket.
    mockQueryStates[POSITIONS] = {
      data: {
        configured: true,
        positions: [
          position({ positionId: "0x1", underMargined: true }),
          position({ positionId: "0x2", underMargined: false }),
          position({ positionId: "0x3", underMargined: null }),
        ],
        portfolio: null,
      },
    };
    const { result } = renderHook(() => useFXChain());
    expect(result.current.underMargined.map((p) => p.positionId)).toEqual(["0x1"]);
    expect(result.current.marginUnknown.map((p) => p.positionId)).toEqual(["0x3"]);
  });

  it("does not flag margin state on positions that are no longer active", () => {
    mockQueryStates[POSITIONS] = {
      data: {
        configured: true,
        positions: [
          position({ status: "SETTLED", underMargined: true }),
          position({ status: "EXPIRED", underMargined: null }),
        ],
        portfolio: null,
      },
    };
    const { result } = renderHook(() => useFXChain());
    expect(result.current.underMargined).toHaveLength(0);
    expect(result.current.marginUnknown).toHaveLength(0);
  });

  it("surfaces liquidated and emergency-unwound positions separately", () => {
    // The database's four statuses cannot express these; they must not be
    // silently folded into a generic "closed".
    mockQueryStates[POSITIONS] = {
      data: {
        configured: true,
        positions: [
          position({ positionId: "0x1", status: "LIQUIDATED" }),
          position({ positionId: "0x2", status: "EMERGENCY_UNWOUND" }),
          position({ positionId: "0x3", status: "SETTLED" }),
        ],
        portfolio: null,
      },
    };
    const { result } = renderHook(() => useFXChain());
    expect(result.current.adverselyClosed.map((p) => p.positionId)).toEqual([
      "0x1",
      "0x2",
    ]);
  });

  it("distinguishes loading from 'no vault deployed'", () => {
    mockQueryStates[PAIRS] = { isLoading: true };
    const { result } = renderHook(() => useFXChain());
    expect(result.current.configured).toBeNull();
  });

  it("reports configured:false when no vault address is deployed", () => {
    mockQueryStates[PAIRS] = {
      data: {
        configured: false,
        reason: "NO_FX_VAULT_ADDRESS_CONFIGURED",
        dataSource: "CHAIN_FX_HEDGING_VAULT",
      },
    };
    const { result } = renderHook(() => useFXChain());
    expect(result.current.configured).toBe(false);
    expect(result.current.pairs).toEqual([]);
    expect(result.current.rateDecimals).toBeNull();
  });

  it("invalidates only the fx chain namespace on refetch", async () => {
    const { result } = renderHook(() => useFXChain());
    await result.current.refetch();
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["fx", "chain"] });
  });
});
