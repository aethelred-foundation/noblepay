import { renderHook } from "@testing-library/react";

import { useTreasuryChain } from "@/hooks/useTreasuryChain";

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

const OVERVIEW = "treasury:chain:overview";
const PROPOSALS = "treasury:chain:proposals";
const BUDGETS = "treasury:chain:budgets";

const configuredOverview = {
  configured: true,
  address: "0xf87ea237cca6f4c932f13983f7df05c0b842b128",
  nativeBalance: "5000000000000000000",
  signers: ["0xaaa", "0xbbb", "0xccc"],
  signerCount: 3,
  thresholds: { small: 1, medium: 2, large: 3, emergency: 2 },
  tiers: [],
  proposalCounts: {
    PENDING: 1,
    APPROVED: 0,
    EXECUTED: 0,
    REJECTED: 0,
    CANCELLED: 0,
    EXPIRED: 0,
  },
  activeBudgets: 0,
  amountBasis: "RAW_TOKEN_BASE_UNITS_COMPARED_AGAINST_USD6_THRESHOLDS",
  dataSource: "CHAIN_MULTISIG_TREASURY",
  readAtBlock: "4242",
};

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockQueryStates)) delete mockQueryStates[key];
});

describe("useTreasuryChain", () => {
  it("reads from the chain endpoints, not the ledger ones", () => {
    renderHook(() => useTreasuryChain());
    mockQueryOptions[OVERVIEW].queryFn({ signal: undefined });
    mockQueryOptions[PROPOSALS].queryFn({ signal: undefined });
    mockQueryOptions[BUDGETS].queryFn({ signal: undefined });

    const paths = mockApiRequest.mock.calls.map((c) => c[0]);
    expect(paths).toEqual([
      "/v1/treasury/chain/overview",
      "/v1/treasury/chain/proposals",
      "/v1/treasury/chain/budgets",
    ]);
    // The database-ledger endpoint must not be touched by this hook.
    expect(paths).not.toContain("/v1/treasury/overview");
  });

  it("namespaces its query keys under chain so it cannot collide with useTreasury", () => {
    renderHook(() => useTreasuryChain());
    expect(mockQueryOptions[OVERVIEW].queryKey).toEqual([
      "treasury",
      "chain",
      "overview",
    ]);
  });

  it("distinguishes loading from 'no treasury deployed'", () => {
    // Three states, not two. Collapsing unknown into false renders an empty
    // treasury during the first paint of a perfectly healthy deployment.
    mockQueryStates[OVERVIEW] = { isLoading: true };
    const { result } = renderHook(() => useTreasuryChain());
    expect(result.current.configured).toBeNull();
  });

  it("reports configured:false when no treasury address is deployed", () => {
    mockQueryStates[OVERVIEW] = {
      data: {
        configured: false,
        reason: "NO_TREASURY_ADDRESS_CONFIGURED",
        dataSource: "CHAIN_MULTISIG_TREASURY",
      },
    };
    const { result } = renderHook(() => useTreasuryChain());
    expect(result.current.configured).toBe(false);
    expect(result.current.overview).toBeNull();
  });

  it("exposes the overview once configured", () => {
    mockQueryStates[OVERVIEW] = { data: configuredOverview };
    const { result } = renderHook(() => useTreasuryChain());
    expect(result.current.configured).toBe(true);
    expect(result.current.overview?.signerCount).toBe(3);
    expect(result.current.readAtBlock).toBe("4242");
  });

  it("surfaces amountBasis so a component cannot render tiers as dollars unwarned", () => {
    mockQueryStates[OVERVIEW] = { data: configuredOverview };
    const { result } = renderHook(() => useTreasuryChain());
    expect(result.current.amountBasis).toBe(
      "RAW_TOKEN_BASE_UNITS_COMPARED_AGAINST_USD6_THRESHOLDS",
    );
  });

  it("keeps uint256 amounts as strings", () => {
    // Parsing these into numbers loses precision above 2^53; a wei balance
    // exceeds that routinely.
    mockQueryStates[PROPOSALS] = {
      data: {
        configured: true,
        proposals: [{ proposalId: "0xa", amount: "115792089237316195423570985" }],
      },
    };
    const { result } = renderHook(() => useTreasuryChain());
    expect(typeof result.current.proposals[0].amount).toBe("string");
    expect(result.current.proposals[0].amount).toBe(
      "115792089237316195423570985",
    );
  });

  it("returns empty collections rather than undefined before data arrives", () => {
    const { result } = renderHook(() => useTreasuryChain());
    expect(result.current.proposals).toEqual([]);
    expect(result.current.budgets).toEqual([]);
  });

  it("surfaces the first error across the three queries", () => {
    mockQueryStates[PROPOSALS] = { error: new Error("CHAIN_READ_FAILED") };
    const { result } = renderHook(() => useTreasuryChain());
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("invalidates only the chain namespace on refetch", async () => {
    const { result } = renderHook(() => useTreasuryChain());
    await result.current.refetch();
    expect(mockInvalidate).toHaveBeenCalledWith({
      queryKey: ["treasury", "chain"],
    });
  });
});
