import { renderHook } from "@testing-library/react";
import { useFX } from "@/hooks/useFX";

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

describe("useFX", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockQueryStates).forEach((key) => delete mockQueryStates[key]);
    mockQueryStates["fx:rates"] = {
      data: [
        {
          pair: "USDC/AED",
          bid: 3.66,
          ask: 3.68,
          mid: 3.67,
          timestamp: "2026-07-21T10:00:00.000Z",
          change24h: null,
        },
      ],
    };
    mockQueryStates["fx:hedges"] = {
      data: [
        {
          id: "hedge-1",
          pair: "USDC/AED",
          notionalAmount: "1000",
          entryRate: 3.66,
          strikeRate: 3.7,
          currentRate: 3.66,
          expiryDate: "2026-08-21T10:00:00.000Z",
          status: "OPEN",
          marginDeposit: null,
          unrealizedPnL: null,
          createdAt: "2026-07-21T10:00:00.000Z",
        },
      ],
    };
    mockQueryStates["fx:exposure"] = {
      data: {
        totalExposure: "1000",
        byCurrency: {
          USDC: {
            exposure: "1000",
            hedged: "1000",
            unhedged: null,
            hedgeRatio: null,
          },
        },
        netExposure: null,
        valueAtRisk: null,
        calculatedAt: "2026-07-21T10:00:00.000Z",
      },
    };
  });

  it("maps verified oracle rates and durable hedge snapshots honestly", () => {
    const { result } = renderHook(() => useFX());

    expect(result.current.rates[0]).toEqual(
      expect.objectContaining({ pair: "USDC/AED", change24h: null }),
    );
    expect(result.current.hedges[0]).toEqual(
      expect.objectContaining({
        status: "Active",
        collateral: null,
        unrealizedPnl: null,
      }),
    );
    expect(result.current.exposure).toEqual(
      expect.objectContaining({
        totalExposure: 1000,
        hedgedPercentage: 100,
        unhedgedExposure: null,
        valueAtRisk: null,
      }),
    );
  });

  it("isolates oracle failure from durable hedge history", () => {
    const oracleError = new Error("oracle unavailable");
    mockQueryStates["fx:rates"] = { error: oracleError };
    const { result } = renderHook(() => useFX());

    expect(result.current.oracleError).toBe(oracleError);
    expect(result.current.error).toBeNull();
    expect(result.current.hedges).toHaveLength(1);
  });

  it("uses the FX read endpoints and exposes no pretend execution", async () => {
    const { result } = renderHook(() => useFX());
    const signal = new AbortController().signal;

    await mockQueryOptions["fx:rates"].queryFn({ signal });
    await mockQueryOptions["fx:hedges"].queryFn({ signal });
    await mockQueryOptions["fx:exposure"].queryFn({ signal });

    expect(mockApiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/v1/fx/rates",
      "/v1/fx/hedges",
      "/v1/fx/exposure",
    ]);
    expect(result.current.mutationsEnabled).toBe(false);
    await expect(result.current.createHedge()).rejects.toMatchObject({
      status: 501,
      code: "FX_EXECUTION_UNAVAILABLE",
    });
  });
});
