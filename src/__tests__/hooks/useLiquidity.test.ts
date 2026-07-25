import { renderHook } from "@testing-library/react";
import { useLiquidity } from "@/hooks/useLiquidity";

const mockRefetch = jest.fn().mockResolvedValue(undefined);
const mockApiRequest = jest.fn();
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
      refetch: mockRefetch,
    };
  },
}));
jest.mock("@/lib/api", () => ({
  ...jest.requireActual("@/lib/api"),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

describe("useLiquidity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockQueryStates).forEach((key) => delete mockQueryStates[key]);
    mockQueryStates["liquidity:pools"] = {
      data: [
        {
          id: "pool-1",
          pair: "USDC/USDT",
          tokenA: "USDC",
          tokenB: "USDT",
          reserveA: "1000",
          reserveB: "990",
          tvl: "1990",
          apy: null,
          feeRate: 0.003,
          volume24h: "250",
          status: "ACTIVE",
          createdAt: "2026-07-21T10:00:00.000Z",
        },
      ],
    };
    mockQueryStates["liquidity:positions"] = {
      data: [
        {
          id: "position-1",
          poolId: "pool-1",
          liquidityAmount: "199",
          sharePercentage: 10,
          feesEarned: "1.5",
          impermanentLoss: null,
          createdAt: "2026-07-21T11:00:00.000Z",
        },
      ],
    };
    mockQueryStates["liquidity:analytics"] = {
      data: {
        totalTVL: "1990",
        totalVolume24h: "250",
        totalFeesGenerated: "3.5",
        poolCount: 1,
      },
    };
  });

  it("maps durable API snapshots and leaves unavailable metrics null", () => {
    const { result } = renderHook(() => useLiquidity());

    expect(result.current.pools[0]).toEqual(
      expect.objectContaining({
        name: "USDC/USDT",
        tvl: 1990,
        apy: null,
        feeBps: 30,
        lpCount: 1,
      }),
    );
    expect(result.current.positions[0]).toEqual(
      expect.objectContaining({
        poolName: "USDC/USDT",
        valueUsd: null,
        impermanentLoss: null,
      }),
    );
    expect(result.current.analytics).toEqual(
      expect.objectContaining({ avgApy: null, totalFeesEarned24h: 3.5 }),
    );
  });

  it("uses the live advanced-service endpoints", async () => {
    renderHook(() => useLiquidity());
    const signal = new AbortController().signal;

    await mockQueryOptions["liquidity:pools"].queryFn({ signal });
    await mockQueryOptions["liquidity:positions"].queryFn({ signal });
    await mockQueryOptions["liquidity:analytics"].queryFn({ signal });

    expect(mockApiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/v1/liquidity/pools",
      "/v1/liquidity/positions",
      "/v1/liquidity/analytics",
    ]);
  });

  it("fails every unsupported mutation locally with the production code", async () => {
    const { result } = renderHook(() => useLiquidity());

    expect(result.current.mutationsEnabled).toBe(false);
    await expect(result.current.addLiquidity()).rejects.toMatchObject({
      status: 501,
      code: "ONCHAIN_SETTLEMENT_UNAVAILABLE",
    });
    await expect(result.current.removeLiquidity()).rejects.toMatchObject({
      status: 501,
    });
  });

  it("refetches all three authoritative reads", async () => {
    const { result } = renderHook(() => useLiquidity());
    await result.current.refetch();
    expect(mockRefetch).toHaveBeenCalledTimes(3);
  });
});
