import { renderHook } from "@testing-library/react";
import { useCrossChain } from "@/hooks/useCrossChain";

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

describe("useCrossChain", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockQueryStates).forEach((key) => delete mockQueryStates[key]);
    mockQueryStates["crosschain:chains"] = {
      data: [
        {
          id: "aethelred",
          chainId: 7332,
          name: "Aethelred Testnet",
          rpcUrl: "https://rpc.aethelred.example",
          explorer: "https://explorer.aethelred.example",
          avgBlockTime: 2,
          nativeToken: "AETHEL",
          supportedTokens: ["USDC"],
          status: "ONLINE",
          currentGasPrice: null,
        },
        {
          id: "ethereum",
          chainId: 11155111,
          name: "Ethereum Sepolia",
          rpcUrl: "https://rpc.ethereum.example",
          explorer: "https://explorer.ethereum.example",
          avgBlockTime: 12,
          nativeToken: "ETH",
          supportedTokens: ["USDC"],
          status: "OFFLINE",
          currentGasPrice: null,
        },
      ],
    };
    mockQueryStates["crosschain:transfers"] = {
      data: [
        {
          id: "transfer-1",
          sourceChain: "aethelred",
          destinationChain: "ethereum",
          token: "USDC",
          amount: "10",
          sender: "0x1111111111111111111111111111111111111111",
          recipient: "0x2222222222222222222222222222222222222222",
          status: "RELAYING",
          steps: [],
          bridgeFee: null,
          estimatedTime: null,
          createdAt: "2026-07-21T10:00:00.000Z",
          completedAt: null,
        },
      ],
    };
    mockQueryStates["crosschain:relays"] = {
      data: [
        {
          id: "relay-1",
          address: "0x3333333333333333333333333333333333333333",
          chains: ["aethelred", "ethereum"],
          stake: "500",
          uptime: null,
          successRate: 98.5,
          relayedCount: 10,
          avgLatency: 500,
          status: "ACTIVE",
        },
      ],
    };
  });

  it("maps verified chain, durable transfer, and relay data without fake values", () => {
    const { result } = renderHook(() => useCrossChain());

    expect(result.current.chains[0]).toEqual(
      expect.objectContaining({ status: "Online", gasPrice: null }),
    );
    expect(result.current.transfers[0]).toEqual(
      expect.objectContaining({
        sourceChainName: "Aethelred Testnet",
        destChainName: "Ethereum Sepolia",
        status: "Relaying",
        bridgeFee: null,
        estimatedTime: null,
      }),
    );
    expect(result.current.relayNodes[0]).toEqual(
      expect.objectContaining({
        successRate: 98.5,
        uptime: null,
        lastActiveAt: null,
      }),
    );
  });

  it("isolates chain RPC errors from durable history", () => {
    const chainsError = new Error("chain registry unavailable");
    mockQueryStates["crosschain:chains"] = { error: chainsError };
    const { result } = renderHook(() => useCrossChain());

    expect(result.current.chainsError).toBe(chainsError);
    expect(result.current.error).toBeNull();
    expect(result.current.transfers).toHaveLength(1);
  });

  it("uses only read endpoints and rejects quote/execution locally", async () => {
    const { result } = renderHook(() => useCrossChain());
    const signal = new AbortController().signal;
    await mockQueryOptions["crosschain:chains"].queryFn({ signal });
    await mockQueryOptions["crosschain:transfers"].queryFn({ signal });
    await mockQueryOptions["crosschain:relays"].queryFn({ signal });

    expect(mockApiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/v1/crosschain/chains",
      "/v1/crosschain/transfers",
      "/v1/crosschain/relays",
    ]);
    await expect(
      result.current.getRouteOptions(7332, 11155111, 10, "USDC"),
    ).rejects.toMatchObject({ status: 503, code: "ROUTE_QUOTE_UNAVAILABLE" });
    await expect(
      result.current.initiateTransfer({
        sourceChainId: 7332,
        destChainId: 11155111,
        recipient: "0x2222222222222222222222222222222222222222",
        tokenSymbol: "USDC",
        amount: 10,
        routeId: "disabled",
      }),
    ).rejects.toMatchObject({
      status: 501,
      code: "BRIDGE_EXECUTION_UNAVAILABLE",
    });
  });
});
