import { renderHook } from "@testing-library/react";
import { useStreaming } from "@/hooks/useStreaming";

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

const wallet = "0x1111111111111111111111111111111111111111";

describe("useStreaming", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockQueryStates).forEach((key) => delete mockQueryStates[key]);
    mockQueryStates[`streams:list:${wallet}`] = {
      data: [
        {
          id: "stream-1",
          streamId: "stream-1",
          sender: wallet,
          recipient: "0x2222222222222222222222222222222222222222",
          totalAmount: "100",
          streamedAmount: "60",
          withdrawnAmount: "5",
          currency: "USDC",
          ratePerSecond: "1",
          startTime: "2026-07-21T10:00:00.000Z",
          endTime: "2026-07-21T11:00:00.000Z",
          status: "ACTIVE",
          lastWithdrawAt: null,
        },
      ],
    };
    mockQueryStates["streams:balances:stream-1"] = {
      data: [
        {
          streamId: "stream-1",
          withdrawable: "55",
          streamed: "60",
          remaining: "40",
          calculatedAt: "2026-07-21T10:30:00.000Z",
        },
      ],
    };
    mockQueryStates["streams:analytics"] = {
      data: { totalActiveStreams: 1, totalStreamedVolume: "60" },
    };
  });

  it("maps durable stream terms, balances, and tenant analytics", () => {
    const { result } = renderHook(() => useStreaming(wallet));

    expect(result.current.streams[0]).toEqual(
      expect.objectContaining({
        id: "stream-1",
        status: "Active",
        cancelable: false,
        lastWithdrawal: null,
      }),
    );
    expect(result.current.balances.get("stream-1")).toEqual(
      expect.objectContaining({
        withdrawable: 55,
        remaining: 40,
        withdrawn: 5,
      }),
    );
    expect(result.current.analytics).toEqual(
      expect.objectContaining({
        totalActiveStreams: 1,
        outgoingStreams: 1,
        incomingStreams: 0,
      }),
    );
  });

  it("uses list, per-stream balance, and analytics API endpoints", async () => {
    renderHook(() => useStreaming(wallet));
    const signal = new AbortController().signal;

    await mockQueryOptions[`streams:list:${wallet}`].queryFn({ signal });
    await mockQueryOptions["streams:balances:stream-1"].queryFn({ signal });
    await mockQueryOptions["streams:analytics"].queryFn({ signal });

    expect(mockApiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/v1/streams",
      "/v1/streams/stream-1/balance",
      "/v1/streams/analytics",
    ]);
  });

  it("does not expose pretend stream writes", async () => {
    const { result } = renderHook(() => useStreaming(wallet));

    expect(result.current.mutationsEnabled).toBe(false);
    await expect(result.current.createStream()).rejects.toMatchObject({
      status: 501,
      code: "ONCHAIN_SETTLEMENT_UNAVAILABLE",
    });
    await expect(result.current.cancelStream()).rejects.toMatchObject({
      status: 501,
    });
  });

  it("surfaces authoritative query failures without fallback records", () => {
    mockQueryStates[`streams:list:${wallet}`] = {
      error: new Error("backend unavailable"),
    };
    const { result } = renderHook(() => useStreaming(wallet));

    expect(result.current.streams).toEqual([]);
    expect(result.current.error).toEqual(new Error("backend unavailable"));
  });
});
