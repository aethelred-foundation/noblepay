import { act, renderHook } from "@testing-library/react";
import { usePaymentChannels } from "@/hooks/usePaymentChannels";

const ACCOUNT = "0x1234567890abcdef1234567890abcdef12345678";
const COUNTERPARTY = "0x1111111111111111111111111111111111111111";
const CHANNEL_CONTRACT = "0x0000000000000000000000000000000000000008";
const USDC = "0x0000000000000000000000000000000000000005";
const UNSUPPORTED_TOKEN = "0x0000000000000000000000000000000000000007";
const CHANNEL_ID =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SIG_A = `0x${"aa".repeat(65)}`;
const SIG_B = `0x${"bb".repeat(65)}`;

let mockAccount: { address?: string } = { address: ACCOUNT };
let mockChannelIds: readonly string[] = [CHANNEL_ID];
let mockKycVerified: boolean | undefined = true;
let mockChannelsData: unknown[] = [];
let mockChannelsQueryOptions: any;

const mockIdsRefetch = jest.fn();
const mockChannelsRefetch = jest.fn();
const mockInvalidateQueries = jest.fn();
const mockWriteContractAsync = jest.fn();
const mockReadContract = jest.fn();
const mockWaitForTransactionReceipt = jest.fn();
const mockVerifyTypedData = jest.fn();
const mockSignTypedDataAsync = jest.fn();
const mockResetMutation = jest.fn();

jest.mock("wagmi", () => ({
  useAccount: () => mockAccount,
  useChainId: () => 7332,
  usePublicClient: () => ({
    readContract: mockReadContract,
    waitForTransactionReceipt: mockWaitForTransactionReceipt,
    verifyTypedData: mockVerifyTypedData,
  }),
  useSignTypedData: () => ({ signTypedDataAsync: mockSignTypedDataAsync }),
  useReadContract: (options: any) => {
    if (options.functionName === "getUserChannels") {
      return {
        data: mockChannelIds,
        isLoading: false,
        error: null,
        refetch: mockIdsRefetch,
      };
    }
    return {
      data: mockKycVerified,
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    };
  },
}));

jest.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => {
    mockChannelsQueryOptions = options;
    return {
      data: mockChannelsData,
      isLoading: false,
      error: null,
      refetch: mockChannelsRefetch,
    };
  },
  useMutation: (options: any) => ({
    mutateAsync: async (variables: unknown) => options.mutationFn(variables),
    isPending: false,
    error: null,
    reset: mockResetMutation,
  }),
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
}));

jest.mock("@/hooks/useSafeWriteContract", () => ({
  useSafeWriteContract: () => ({ writeContractAsync: mockWriteContractAsync }),
}));

jest.mock("@/config/chains", () => ({
  CONTRACT_ADDRESSES: {
    paymentChannels: "0x0000000000000000000000000000000000000008",
    usdcToken: "0x0000000000000000000000000000000000000005",
    usdtToken: "0x0000000000000000000000000000000000000006",
  },
}));

jest.mock("viem", () => ({
  isAddress: (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value),
  getAddress: (value: string) => value.toLowerCase(),
  toBytes: (value: string) => new TextEncoder().encode(value),
  keccak256: () => `0x${"cc".repeat(32)}`,
  recoverTypedDataAddress: async ({ signature }: { signature: string }) =>
    signature === `0x${"aa".repeat(65)}`
      ? "0x1234567890abcdef1234567890abcdef12345678"
      : "0x1111111111111111111111111111111111111111",
  parseUnits: (value: string, decimals: number) => {
    const [whole, fraction = ""] = value.split(".");
    const padded = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
    return (
      BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0")
    );
  },
  formatUnits: (value: bigint, decimals: number) => {
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = (value % base)
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  },
}));

const rawChannel = {
  channelId: CHANNEL_ID,
  partyA: ACCOUNT,
  partyB: COUNTERPARTY,
  token: USDC,
  depositA: 10_000_000n,
  depositB: 5_000_000n,
  balanceA: 8_000_000n,
  balanceB: 7_000_000n,
  status: 2,
  nonce: 3n,
  stateEpoch: 2n,
  openedAt: 1n,
  closingAt: 0n,
  closedAt: 0n,
  challengePeriod: 86_400n,
};

const channel = {
  ...rawChannel,
  tokenDecimals: 6,
  tokenSymbol: "USDC" as const,
  depositADisplay: "10",
  depositBDisplay: "5",
  balanceADisplay: "8",
  balanceBDisplay: "7",
  statusLabel: "ACTIVE" as const,
  disputeChallenger: null,
  disputeNonce: null,
  disputeExpiresAt: null,
};

describe("usePaymentChannels", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccount = { address: ACCOUNT };
    mockChannelIds = [CHANNEL_ID];
    mockKycVerified = true;
    mockChannelsData = [];
    mockIdsRefetch.mockResolvedValue({ data: mockChannelIds });
    mockChannelsRefetch.mockResolvedValue({ data: [] });
    mockInvalidateQueries.mockResolvedValue(undefined);
    mockWriteContractAsync
      .mockReset()
      .mockResolvedValueOnce("0xapprovalhash")
      .mockResolvedValueOnce("0xchannelhash");
    mockWaitForTransactionReceipt.mockResolvedValue({ status: "success" });
    mockVerifyTypedData.mockImplementation(
      ({ address, signature }: { address: string; signature: string }) =>
        address.toLowerCase() ===
        (signature === SIG_A ? ACCOUNT : COUNTERPARTY).toLowerCase(),
    );
    mockSignTypedDataAsync.mockResolvedValue(SIG_A);
    mockReadContract.mockImplementation(({ functionName }: any) => {
      if (functionName === "supportedTokens") return Promise.resolve(true);
      if (functionName === "decimals") return Promise.resolve(6);
      if (functionName === "allowance") return Promise.resolve(0n);
      if (functionName === "getChannel") return Promise.resolve(rawChannel);
      throw new Error(`Unexpected contract read: ${functionName}`);
    });
  });

  it("reads channel IDs and KYC from the configured contract", () => {
    mockChannelsData = [channel];
    const { result } = renderHook(() => usePaymentChannels());

    expect(result.current.configured).toBe(true);
    expect(result.current.settlementTokensConfigured).toBe(true);
    expect(result.current.kycVerified).toBe(true);
    expect(result.current.channels).toEqual([channel]);
    expect(mockChannelsQueryOptions.queryKey).toEqual([
      "payment-channels",
      ACCOUNT,
      CHANNEL_ID,
    ]);
    expect(mockChannelsQueryOptions.enabled).toBe(true);
  });

  it("hydrates raw contract state with token precision and labels", async () => {
    renderHook(() => usePaymentChannels());

    const hydrated = await mockChannelsQueryOptions.queryFn();

    expect(hydrated).toEqual([
      expect.objectContaining({
        channelId: CHANNEL_ID,
        tokenDecimals: 6,
        tokenSymbol: "USDC",
        depositADisplay: "10",
        depositBDisplay: "5",
        balanceADisplay: "8",
        balanceBDisplay: "7",
        statusLabel: "ACTIVE",
      }),
    ]);
    expect(mockReadContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: CHANNEL_CONTRACT,
        functionName: "getChannel",
        args: [CHANNEL_ID],
      }),
    );
  });

  it("approves the settlement token and opens a channel after confirmation", async () => {
    const { result } = renderHook(() => usePaymentChannels());
    let hash: unknown;

    await act(async () => {
      hash = await result.current.openChannel({
        counterparty: COUNTERPARTY,
        token: USDC,
        deposit: "125.5",
        challengeHours: 48,
      });
    });

    expect(hash).toBe("0xchannelhash");
    expect(mockWriteContractAsync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        address: USDC,
        functionName: "approve",
        args: [CHANNEL_CONTRACT, 125_500_000n],
      }),
    );
    expect(mockWriteContractAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        address: CHANNEL_CONTRACT,
        functionName: "openChannel",
        args: [COUNTERPARTY, USDC, 125_500_000n, 172_800n],
      }),
    );
    expect(mockWaitForTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(mockIdsRefetch).toHaveBeenCalled();
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["payment-channels"],
    });
  });

  it("resets a non-zero allowance before granting the exact channel allowance", async () => {
    mockWriteContractAsync
      .mockReset()
      .mockResolvedValueOnce("0xresethash")
      .mockResolvedValueOnce("0xapprovalhash")
      .mockResolvedValueOnce("0xchannelhash");
    mockReadContract.mockImplementation(({ functionName }: any) => {
      if (functionName === "supportedTokens") return Promise.resolve(true);
      if (functionName === "decimals") return Promise.resolve(6);
      if (functionName === "allowance") return Promise.resolve(1_000_000n);
      throw new Error(`Unexpected contract read: ${functionName}`);
    });
    const { result } = renderHook(() => usePaymentChannels());

    await act(async () => {
      await result.current.openChannel({
        counterparty: COUNTERPARTY,
        token: USDC,
        deposit: "10",
        challengeHours: 24,
      });
    });

    expect(mockWriteContractAsync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        address: USDC,
        functionName: "approve",
        args: [CHANNEL_CONTRACT, 0n],
      }),
    );
    expect(mockWriteContractAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        address: USDC,
        functionName: "approve",
        args: [CHANNEL_CONTRACT, 10_000_000n],
      }),
    );
    expect(mockWriteContractAsync).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ functionName: "openChannel" }),
    );
    expect(mockWaitForTransactionReceipt).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid counterparties and unsupported tokens before writing", async () => {
    const { result } = renderHook(() => usePaymentChannels());

    await expect(
      result.current.openChannel({
        counterparty: COUNTERPARTY,
        token: UNSUPPORTED_TOKEN,
        deposit: "10",
        challengeHours: 24,
      }),
    ).rejects.toThrow("only the configured USDC and USDT stablecoins");

    await expect(
      result.current.openChannel({
        counterparty: ACCOUNT,
        token: USDC,
        deposit: "10",
        challengeHours: 24,
      }),
    ).rejects.toThrow("different valid counterparty");

    mockReadContract.mockImplementation(({ functionName }: any) => {
      if (functionName === "supportedTokens") return Promise.resolve(false);
      throw new Error(`Unexpected contract read: ${functionName}`);
    });
    await expect(
      result.current.openChannel({
        counterparty: COUNTERPARTY,
        token: USDC,
        deposit: "10",
        challengeHours: 24,
      }),
    ).rejects.toThrow("not enabled by Payment Channels governance");
    expect(mockWriteContractAsync).not.toHaveBeenCalled();
  });

  it("does not transact for a legacy channel using an unsupported token", async () => {
    const { result } = renderHook(() => usePaymentChannels());
    const unsupportedChannel = {
      ...channel,
      token: UNSUPPORTED_TOKEN,
      tokenDecimals: null,
      tokenSymbol: null,
      depositADisplay: null,
      depositBDisplay: null,
      balanceADisplay: null,
      balanceBDisplay: null,
    };

    await expect(
      result.current.fundChannel({ channel: unsupportedChannel, amount: "1" }),
    ).rejects.toThrow("only the configured USDC and USDT stablecoins");
    expect(mockWriteContractAsync).not.toHaveBeenCalled();
  });

  it("submits guaranteed OPEN refunds and ACTIVE current-state closes without token metadata", async () => {
    mockWriteContractAsync.mockReset().mockResolvedValue("0xexithash");
    const { result } = renderHook(() => usePaymentChannels());
    const openChannel = {
      ...channel,
      status: 0,
      statusLabel: "OPEN" as const,
      depositB: 0n,
      token: UNSUPPORTED_TOKEN,
      tokenDecimals: null,
      tokenSymbol: null,
    };

    await expect(result.current.cancelOpenChannel(openChannel)).resolves.toBe(
      "0xexithash",
    );
    expect(mockWriteContractAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        functionName: "cancelOpenChannel",
        args: [CHANNEL_ID],
      }),
    );

    await expect(
      result.current.initiateCurrentStateClose(channel),
    ).resolves.toBe("0xexithash");
    expect(mockWriteContractAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        functionName: "initiateCurrentStateClose",
        args: [CHANNEL_ID],
      }),
    );
  });

  it("rejects guaranteed-exit calls from ineligible wallets or lifecycle states", async () => {
    const { result } = renderHook(() => usePaymentChannels());
    await expect(result.current.cancelOpenChannel(channel)).rejects.toThrow(
      "counterparty never funded",
    );

    mockAccount = {
      address: "0x9999999999999999999999999999999999999999",
    };
    const view = renderHook(() => usePaymentChannels());
    await expect(
      view.result.current.initiateCurrentStateClose(channel),
    ).rejects.toThrow("Only an on-chain channel party");
    expect(mockWriteContractAsync).not.toHaveBeenCalled();
  });

  it("submits exact cooperative close state and requires both signatures", async () => {
    mockWriteContractAsync.mockReset().mockResolvedValue("0xclosehash");
    const { result } = renderHook(() => usePaymentChannels());

    const unsigned = JSON.parse(
      await result.current.buildStateArtifact({
        channel,
        balanceA: "8",
        balanceB: "7",
        nonce: "4",
        stateType: "CLOSE",
      }),
    );
    const partyAOnly = JSON.stringify({
      ...unsigned,
      signatures: { partyA: SIG_A, partyB: null },
    });

    await expect(
      result.current.closeChannel({
        channel,
        mode: "cooperative",
        artifact: partyAOnly,
      }),
    ).rejects.toThrow("requires valid signatures from both channel parties");

    const signed = JSON.stringify({
      ...unsigned,
      signatures: { partyA: SIG_A, partyB: SIG_B },
    });

    let hash: unknown;
    await act(async () => {
      hash = await result.current.closeChannel({
        channel,
        mode: "cooperative",
        artifact: signed,
      });
    });
    expect(hash).toBe("0xclosehash");
    expect(mockWriteContractAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "cooperativeClose",
        args: [CHANNEL_ID, 8_000_000n, 7_000_000n, 4n, SIG_A, SIG_B],
      }),
    );
  });

  it("submits a higher signed state to counter a closing-channel dispute", async () => {
    mockWriteContractAsync.mockReset().mockResolvedValue("0xdisputehash");
    const { result } = renderHook(() => usePaymentChannels());
    const closingChannel = {
      ...channel,
      status: 3,
      statusLabel: "CLOSING" as const,
      disputeChallenger: COUNTERPARTY as `0x${string}`,
      disputeNonce: 3n,
      disputeExpiresAt: 2_000_000_000n,
    };

    await expect(
      result.current.fundChannel({ channel: closingChannel, amount: "1" }),
    ).rejects.toThrow("Only open, funded, or active channels");
    await expect(
      result.current.buildStateArtifact({
        channel: closingChannel,
        balanceA: "7",
        balanceB: "8",
        nonce: "3",
        stateType: "STATE",
      }),
    ).rejects.toThrow("nonce is not newer");

    const unsigned = JSON.parse(
      await result.current.buildStateArtifact({
        channel: closingChannel,
        balanceA: "7",
        balanceB: "8",
        nonce: "4",
        stateType: "STATE",
      }),
    );
    const signed = JSON.stringify({
      ...unsigned,
      signatures: { partyA: null, partyB: SIG_B },
    });

    let hash: unknown;
    await act(async () => {
      hash = await result.current.counterDispute({
        channel: closingChannel,
        artifact: signed,
      });
    });

    expect(hash).toBe("0xdisputehash");
    expect(mockWriteContractAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        address: CHANNEL_CONTRACT,
        functionName: "counterDispute",
        args: [CHANNEL_ID, 7_000_000n, 8_000_000n, 4n, SIG_B],
      }),
    );
  });

  it("creates and signs a chain-and-deployment-bound portable state artifact", async () => {
    const { result } = renderHook(() => usePaymentChannels());
    const unsigned = await result.current.buildStateArtifact({
      channel,
      balanceA: "8",
      balanceB: "7",
      nonce: "4",
      stateType: "CLOSE",
    });

    const signed = await result.current.signStateArtifact(
      unsigned,
      channel,
      "CLOSE",
    );
    const artifact = JSON.parse(signed);

    expect(artifact).toMatchObject({
      format: "noblepay-channel-state-v2",
      chainId: "7332",
      verifyingContract: CHANNEL_CONTRACT,
      state: {
        channelId: CHANNEL_ID,
        balanceA: "8000000",
        balanceB: "7000000",
        nonce: "4",
        stateEpoch: "2",
        stateType: "CLOSE",
      },
      signatures: { partyA: SIG_A, partyB: null },
    });
    expect(mockSignTypedDataAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: expect.objectContaining({
          name: "NoblePay PaymentChannels",
          version: "1",
          chainId: 7332n,
          verifyingContract: CHANNEL_CONTRACT,
        }),
        primaryType: "ChannelState",
        message: expect.objectContaining({ stateEpoch: 2n }),
      }),
    );
  });

  it("refuses to submit an artifact invalidated by a later on-chain balance mutation", async () => {
    const { result } = renderHook(() => usePaymentChannels());
    const unsigned = JSON.parse(
      await result.current.buildStateArtifact({
        channel,
        balanceA: "8",
        balanceB: "7",
        nonce: "4",
        stateType: "CLOSE",
      }),
    );
    const signed = JSON.stringify({
      ...unsigned,
      signatures: { partyA: SIG_A, partyB: SIG_B },
    });

    await expect(
      result.current.closeChannel({
        channel: { ...channel, stateEpoch: 3n },
        mode: "cooperative",
        artifact: signed,
      }),
    ).rejects.toThrow("different on-chain state epoch");
    expect(mockWriteContractAsync).not.toHaveBeenCalled();
  });

  it("refreshes both ID and hydrated-channel queries on demand", async () => {
    const { result } = renderHook(() => usePaymentChannels());

    await act(async () => {
      await result.current.refetch();
    });
    expect(mockIdsRefetch).toHaveBeenCalledTimes(1);
    expect(mockChannelsRefetch).toHaveBeenCalledTimes(1);

    act(() => result.current.reset());
    expect(mockResetMutation).toHaveBeenCalledTimes(7);
  });
});
