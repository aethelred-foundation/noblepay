import { renderHook } from "@testing-library/react";
import { useTreasury } from "@/hooks/useTreasury";

const mockRefetch = jest.fn().mockResolvedValue(undefined);
const mockReset = jest.fn();
const mockInvalidate = jest.fn().mockResolvedValue(undefined);
const mockApiRequest = jest.fn().mockResolvedValue({});
const mockQueryOptions: Record<string, any> = {};
const mockQueryStates: Record<string, any> = {};
const mockMutationOptions: any[] = [];
let mockMutationIndex = 0;

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
  useMutation: (options: any) => {
    const index = mockMutationIndex++;
    mockMutationOptions[index] = options;
    return {
      mutateAsync: (value: unknown) => options.mutationFn(value),
      isPending: false,
      error: null,
      reset: mockReset,
    };
  },
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));
jest.mock("@/lib/api", () => ({
  ...jest.requireActual("@/lib/api"),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

describe("useTreasury", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMutationIndex = 0;
    mockMutationOptions.length = 0;
    Object.keys(mockQueryStates).forEach((key) => delete mockQueryStates[key]);
    mockQueryStates["treasury:overview"] = {
      data: {
        totalAUM: "1000",
        allocations: { USDC: "1000" },
        yieldEarned: "25",
        pendingProposals: 1,
        activeStrategies: 1,
        signerCount: 2,
        monthlySpend: { INFRASTRUCTURE: "100" },
        valuationScope: "RECORDED_YIELD_ALLOCATIONS_ONLY",
      },
    };
    mockQueryStates["treasury:policies"] = {
      data: [
        {
          id: "policy-1",
          category: "INFRASTRUCTURE",
          dailyLimit: "1000",
          monthlyLimit: "10000",
          requiresApproval: true,
          minApprovals: 2,
          active: true,
          updatedAt: "2026-07-21T10:00:00.000Z",
        },
      ],
    };
    mockQueryStates["treasury:yield"] = {
      data: [
        {
          id: "strategy-1",
          protocol: "VerifiedProtocol",
          name: "USDC reserve",
          allocation: "1000",
          currency: "USDC",
          currentAPY: 2.5,
          riskLevel: "LOW",
          active: true,
          totalYieldEarned: "25",
          lastHarvestAt: null,
        },
      ],
    };
    mockQueryStates["treasury:proposals"] = {
      data: [
        {
          id: "proposal-1",
          title: "Supplier payment",
          description: "Pay a verified supplier",
          type: "TRANSFER",
          amount: "500",
          currency: "USDC",
          recipient: "0x2222222222222222222222222222222222222222",
          category: "INFRASTRUCTURE",
          status: "PENDING",
          proposer: "signer-1",
          requiredApprovals: 2,
          currentApprovals: 1,
          createdAt: "2026-07-21T10:00:00.000Z",
          expiresAt: "2026-07-28T10:00:00.000Z",
          executedAt: null,
        },
      ],
    };
  });

  it("maps durable overview, policies, strategies, and proposal history", () => {
    const { result } = renderHook(() => useTreasury());

    expect(result.current.overview).toEqual(
      expect.objectContaining({
        tokenBalances: [{ symbol: "USDC", amount: 1000, valueUsd: null }],
        activeStrategies: 1,
        signerCount: 2,
        valuationScope: "RECORDED_YIELD_ALLOCATIONS_ONLY",
      }),
    );
    expect(result.current.policies[0]).toEqual(
      expect.objectContaining({ maxSingleTx: null, active: true }),
    );
    expect(result.current.strategies[0]).toEqual(
      expect.objectContaining({ earnedToDate: 25, lastRebalance: null }),
    );
    expect(result.current.proposals[0]).toEqual(
      expect.objectContaining({
        status: "Active",
        votesFor: 1,
        votesAgainst: null,
        quorum: 2,
        executedAt: null,
      }),
    );
  });

  it("uses all four authoritative treasury read endpoints", async () => {
    renderHook(() => useTreasury());
    const signal = new AbortController().signal;
    for (const key of [
      "treasury:overview",
      "treasury:policies",
      "treasury:yield",
      "treasury:proposals",
    ]) {
      await mockQueryOptions[key].queryFn({ signal });
    }
    expect(mockApiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/v1/treasury/overview",
      "/v1/treasury/policies",
      "/v1/treasury/yield",
      "/v1/treasury/proposals",
    ]);
  });

  it("creates and approves only through durable workflow endpoints", async () => {
    const { result } = renderHook(() => useTreasury());
    const input = {
      title: "Supplier payment",
      description: "Pay a verified supplier",
      recipient: "0x2222222222222222222222222222222222222222",
      amount: 500,
      tokenSymbol: "USDC",
      category: "INFRASTRUCTURE",
    };

    await result.current.createProposal(input);
    await result.current.voteOnProposal("proposal-1", true);

    expect(mockApiRequest).toHaveBeenNthCalledWith(
      1,
      "/v1/treasury/proposals",
      expect.objectContaining({
        method: "POST",
        json: expect.objectContaining({
          type: "TRANSFER",
          amount: "500",
          category: "INFRASTRUCTURE",
        }),
      }),
    );
    expect(mockApiRequest).toHaveBeenNthCalledWith(
      2,
      "/v1/treasury/proposals/proposal-1/approve",
      { method: "POST" },
    );
    await expect(
      result.current.voteOnProposal("proposal-1", false),
    ).rejects.toMatchObject({
      status: 501,
      code: "TREASURY_REJECTION_UNAVAILABLE",
    });
  });

  it("invalidates overview and proposal history after each durable mutation", async () => {
    renderHook(() => useTreasury());
    await mockMutationOptions[0].onSuccess();
    await mockMutationOptions[1].onSuccess();
    expect(mockInvalidate).toHaveBeenCalledTimes(4);
  });
});
