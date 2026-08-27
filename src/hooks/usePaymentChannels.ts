import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useReadContract,
  useSignTypedData,
} from "wagmi";
import { formatUnits, getAddress, isAddress, parseUnits, type Hex } from "viem";
import { CONTRACT_ADDRESSES } from "@/config/chains";
import {
  attachChannelStateSignature,
  channelStateTypedData,
  createChannelStateArtifact,
  parseChannelStateArtifact,
  serializeChannelStateArtifact,
  validateChannelStateArtifact,
  type ChannelStateArtifact,
  type ChannelStateSignatureVerifier,
  type ChannelStateType,
  type ExpectedChannelState,
} from "@/lib/channel-state";
import { useSafeWriteContract } from "./useSafeWriteContract";

const CHANNEL_COMPONENTS = [
  { name: "channelId", type: "bytes32" },
  { name: "partyA", type: "address" },
  { name: "partyB", type: "address" },
  { name: "token", type: "address" },
  { name: "depositA", type: "uint256" },
  { name: "depositB", type: "uint256" },
  { name: "balanceA", type: "uint256" },
  { name: "balanceB", type: "uint256" },
  { name: "status", type: "uint8" },
  { name: "nonce", type: "uint256" },
  { name: "stateEpoch", type: "uint256" },
  { name: "openedAt", type: "uint256" },
  { name: "closingAt", type: "uint256" },
  { name: "closedAt", type: "uint256" },
  { name: "challengePeriod", type: "uint256" },
] as const;

const PAYMENT_CHANNELS_ABI = [
  {
    name: "getUserChannels",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "bytes32[]" }],
  },
  {
    name: "getChannel",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [{ name: "", type: "tuple", components: CHANNEL_COMPONENTS }],
  },
  {
    name: "getDispute",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "channelId", type: "bytes32" },
          { name: "challenger", type: "address" },
          { name: "challengeNonce", type: "uint256" },
          { name: "challengeBalanceA", type: "uint256" },
          { name: "challengeBalanceB", type: "uint256" },
          { name: "initiatedAt", type: "uint256" },
          { name: "expiresAt", type: "uint256" },
          { name: "resolved", type: "bool" },
        ],
      },
    ],
  },
  {
    name: "kycVerified",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "party", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "supportedTokens",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "openChannel",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "partyB", type: "address" },
      { name: "token", type: "address" },
      { name: "depositAmount", type: "uint256" },
      { name: "challengePeriod", type: "uint256" },
    ],
    outputs: [{ name: "channelId", type: "bytes32" }],
  },
  {
    name: "fundChannel",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "cancelOpenChannel",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "initiateCurrentStateClose",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "cooperativeClose",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "finalBalanceA", type: "uint256" },
      { name: "finalBalanceB", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "signatureA", type: "bytes" },
      { name: "signatureB", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "initiateUnilateralClose",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "balanceA", type: "uint256" },
      { name: "balanceB", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "counterDispute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "channelId", type: "bytes32" },
      { name: "balanceA", type: "uint256" },
      { name: "balanceB", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "finalizeClose",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [],
  },
] as const;

const ERC20_ABI = [
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const STATUS = [
  "OPEN",
  "FUNDED",
  "ACTIVE",
  "CLOSING",
  "DISPUTE",
  "CLOSED",
] as const;

interface RawChannel {
  channelId: `0x${string}`;
  partyA: `0x${string}`;
  partyB: `0x${string}`;
  token: `0x${string}`;
  depositA: bigint;
  depositB: bigint;
  balanceA: bigint;
  balanceB: bigint;
  status: number;
  nonce: bigint;
  stateEpoch: bigint;
  openedAt: bigint;
  closingAt: bigint;
  closedAt: bigint;
  challengePeriod: bigint;
}

interface RawDispute {
  challenger: `0x${string}`;
  challengeNonce: bigint;
  expiresAt: bigint;
  resolved: boolean;
}

export interface PaymentChannel extends RawChannel {
  tokenDecimals: number | null;
  tokenSymbol: "USDC" | "USDT" | null;
  depositADisplay: string | null;
  depositBDisplay: string | null;
  balanceADisplay: string | null;
  balanceBDisplay: string | null;
  statusLabel: (typeof STATUS)[number];
  disputeChallenger: `0x${string}` | null;
  disputeNonce: bigint | null;
  disputeExpiresAt: bigint | null;
}

export function paymentChannelTokenSymbol(
  token: string,
): "USDC" | "USDT" | null {
  const normalized = token.toLowerCase();
  if (
    CONTRACT_ADDRESSES.usdcToken &&
    CONTRACT_ADDRESSES.usdcToken.toLowerCase() === normalized
  ) {
    return "USDC";
  }
  if (
    CONTRACT_ADDRESSES.usdtToken &&
    CONTRACT_ADDRESSES.usdtToken.toLowerCase() === normalized
  ) {
    return "USDT";
  }
  return null;
}

function assertStablecoinToken(token: string): asserts token is `0x${string}` {
  if (!isAddress(token) || !paymentChannelTokenSymbol(token)) {
    throw new Error(
      "Payment channels support only the configured USDC and USDT stablecoins.",
    );
  }
}

function contractAddress(): `0x${string}` {
  const address = CONTRACT_ADDRESSES.paymentChannels;
  if (!address || !isAddress(address))
    throw new Error("Payment Channels contract address is not configured.");
  return address;
}

export function usePaymentChannels() {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { signTypedDataAsync } = useSignTypedData();
  const queryClient = useQueryClient();
  const { writeContractAsync } = useSafeWriteContract();
  const verifyStateSignature: ChannelStateSignatureVerifier = async ({
    address: signer,
    signature,
    typedData,
  }) => {
    if (!publicClient) throw new Error("Aethelred RPC client is unavailable.");
    return publicClient.verifyTypedData({
      address: signer,
      signature,
      ...typedData,
    });
  };
  const configured = Boolean(
    CONTRACT_ADDRESSES.paymentChannels &&
    isAddress(CONTRACT_ADDRESSES.paymentChannels),
  );
  const settlementTokensConfigured = Boolean(
    (CONTRACT_ADDRESSES.usdcToken && isAddress(CONTRACT_ADDRESSES.usdcToken)) ||
    (CONTRACT_ADDRESSES.usdtToken && isAddress(CONTRACT_ADDRESSES.usdtToken)),
  );

  const idsQuery = useReadContract({
    address: CONTRACT_ADDRESSES.paymentChannels as `0x${string}`,
    abi: PAYMENT_CHANNELS_ABI,
    functionName: "getUserChannels",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && configured) },
  });
  const kycQuery = useReadContract({
    address: CONTRACT_ADDRESSES.paymentChannels as `0x${string}`,
    abi: PAYMENT_CHANNELS_ABI,
    functionName: "kycVerified",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && configured) },
  });
  const ids = (idsQuery.data ?? []) as readonly `0x${string}`[];

  const channelsQuery = useQuery({
    queryKey: ["payment-channels", address, ids.join(",")],
    enabled: Boolean(publicClient && configured && ids.length),
    queryFn: async () => {
      if (!publicClient)
        throw new Error("Aethelred RPC client is unavailable.");
      return Promise.all(
        ids.map(async (id) => {
          const raw = (await publicClient.readContract({
            address: contractAddress(),
            abi: PAYMENT_CHANNELS_ABI,
            functionName: "getChannel",
            args: [id],
          })) as RawChannel;
          const dispute =
            raw.status === 3
              ? ((await publicClient.readContract({
                  address: contractAddress(),
                  abi: PAYMENT_CHANNELS_ABI,
                  functionName: "getDispute",
                  args: [id],
                })) as RawDispute)
              : null;
          const tokenSymbol = paymentChannelTokenSymbol(raw.token);
          const decimals = tokenSymbol
            ? Number(
                await publicClient.readContract({
                  address: raw.token,
                  abi: ERC20_ABI,
                  functionName: "decimals",
                }),
              )
            : null;
          return {
            ...raw,
            tokenDecimals: decimals,
            tokenSymbol,
            depositADisplay:
              decimals === null ? null : formatUnits(raw.depositA, decimals),
            depositBDisplay:
              decimals === null ? null : formatUnits(raw.depositB, decimals),
            balanceADisplay:
              decimals === null ? null : formatUnits(raw.balanceA, decimals),
            balanceBDisplay:
              decimals === null ? null : formatUnits(raw.balanceB, decimals),
            statusLabel: STATUS[raw.status] ?? "CLOSED",
            disputeChallenger: dispute?.challenger ?? null,
            disputeNonce: dispute?.challengeNonce ?? null,
            disputeExpiresAt: dispute?.expiresAt ?? null,
          } satisfies PaymentChannel;
        }),
      );
    },
    staleTime: 10_000,
  });

  async function approve(token: `0x${string}`, amount: bigint) {
    if (!address || !publicClient)
      throw new Error("Wallet or RPC client unavailable.");
    const spender = contractAddress();
    const allowance = (await publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [address, spender],
    })) as bigint;
    if (allowance === amount) return;

    // Use an exact allowance and support tokens such as USDT that require an
    // existing non-zero allowance to be reset before it can be changed.
    if (allowance > 0n) {
      const resetHash = await writeContractAsync({
        address: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, 0n],
      });
      const resetReceipt = await publicClient.waitForTransactionReceipt({
        hash: resetHash,
      });
      if (resetReceipt.status !== "success")
        throw new Error("Channel token allowance reset reverted.");
    }

    const approvalHash = await writeContractAsync({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, amount],
    });
    const approvalReceipt = await publicClient.waitForTransactionReceipt({
      hash: approvalHash,
    });
    if (approvalReceipt.status !== "success")
      throw new Error("Channel token approval reverted.");
  }

  async function write(functionName: string, args: readonly unknown[]) {
    if (!publicClient) throw new Error("Aethelred RPC client is unavailable.");
    const hash = await writeContractAsync({
      address: contractAddress(),
      abi: PAYMENT_CHANNELS_ABI,
      functionName,
      args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success")
      throw new Error(`${functionName} transaction reverted.`);
    await idsQuery.refetch();
    await queryClient.invalidateQueries({ queryKey: ["payment-channels"] });
    return hash;
  }

  function expectedState(
    channel: PaymentChannel,
    stateType: ChannelStateType,
  ): ExpectedChannelState {
    return {
      chainId,
      verifyingContract: contractAddress(),
      channelId: channel.channelId,
      partyA: channel.partyA,
      partyB: channel.partyB,
      totalDeposit: channel.depositA + channel.depositB,
      minimumNonceExclusive: channel.disputeNonce ?? channel.nonce,
      stateEpoch: channel.stateEpoch,
      stateType,
    };
  }

  async function buildStateArtifact(input: {
    channel: PaymentChannel;
    balanceA: string;
    balanceB: string;
    nonce: string;
    stateType: ChannelStateType;
  }): Promise<string> {
    if (input.channel.tokenDecimals === null) {
      throw new Error("Settlement token precision is unavailable.");
    }
    const artifact = createChannelStateArtifact({
      chainId,
      verifyingContract: contractAddress(),
      channelId: input.channel.channelId,
      balanceA: parseUnits(input.balanceA, input.channel.tokenDecimals),
      balanceB: parseUnits(input.balanceB, input.channel.tokenDecimals),
      nonce: BigInt(input.nonce),
      stateEpoch: input.channel.stateEpoch,
      stateType: input.stateType,
    });
    await validateChannelStateArtifact(
      artifact,
      expectedState(input.channel, input.stateType),
      verifyStateSignature,
    );
    return serializeChannelStateArtifact(artifact);
  }

  async function inspectStateArtifact(
    serialized: string,
    channel: PaymentChannel,
    stateType: ChannelStateType,
  ): Promise<{
    artifact: ChannelStateArtifact;
    balanceA: string;
    balanceB: string;
    nonce: string;
  }> {
    if (channel.tokenDecimals === null) {
      throw new Error("Settlement token precision is unavailable.");
    }
    const artifact = parseChannelStateArtifact(serialized);
    await validateChannelStateArtifact(
      artifact,
      expectedState(channel, stateType),
      verifyStateSignature,
    );
    return {
      artifact,
      balanceA: formatUnits(
        BigInt(artifact.state.balanceA),
        channel.tokenDecimals,
      ),
      balanceB: formatUnits(
        BigInt(artifact.state.balanceB),
        channel.tokenDecimals,
      ),
      nonce: artifact.state.nonce,
    };
  }

  async function signStateArtifact(
    serialized: string,
    channel: PaymentChannel,
    stateType: ChannelStateType,
  ): Promise<string> {
    if (!address)
      throw new Error("Connect a channel-party wallet before signing.");
    const artifact = parseChannelStateArtifact(serialized);
    const expected = expectedState(channel, stateType);
    await validateChannelStateArtifact(
      artifact,
      expected,
      verifyStateSignature,
    );
    const signature = await signTypedDataAsync(channelStateTypedData(artifact));
    const signed = await attachChannelStateSignature(
      artifact,
      address,
      signature as Hex,
      expected,
      verifyStateSignature,
    );
    return serializeChannelStateArtifact(signed);
  }

  async function validatedArtifact(
    serialized: string,
    channel: PaymentChannel,
    stateType: ChannelStateType,
  ): Promise<ChannelStateArtifact> {
    const artifact = parseChannelStateArtifact(serialized);
    await validateChannelStateArtifact(
      artifact,
      expectedState(channel, stateType),
      verifyStateSignature,
    );
    return artifact;
  }

  function counterpartySignature(
    artifact: ChannelStateArtifact,
    channel: PaymentChannel,
  ): Hex {
    if (!address)
      throw new Error(
        "Connect a channel-party wallet before submitting state.",
      );
    const connected = getAddress(address);
    if (
      connected === getAddress(channel.partyA) &&
      artifact.signatures.partyB
    ) {
      return artifact.signatures.partyB;
    }
    if (
      connected === getAddress(channel.partyB) &&
      artifact.signatures.partyA
    ) {
      return artifact.signatures.partyA;
    }
    if (
      connected !== getAddress(channel.partyA) &&
      connected !== getAddress(channel.partyB)
    ) {
      throw new Error("Only an on-chain channel party can submit this state.");
    }
    throw new Error(
      "The imported artifact needs the counterparty's valid signature.",
    );
  }

  const openMutation = useMutation({
    mutationFn: async ({
      counterparty,
      token,
      deposit,
      challengeHours,
    }: {
      counterparty: string;
      token: string;
      deposit: string;
      challengeHours: number;
    }) => {
      if (!address || !publicClient)
        throw new Error("Connect your wallet first.");
      if (
        !isAddress(counterparty) ||
        counterparty.toLowerCase() === address.toLowerCase()
      )
        throw new Error("Enter a different valid counterparty address.");
      assertStablecoinToken(token);
      if (challengeHours < 1 || challengeHours > 168)
        throw new Error("Challenge period must be between 1 and 168 hours.");
      const supported = await publicClient.readContract({
        address: contractAddress(),
        abi: PAYMENT_CHANNELS_ABI,
        functionName: "supportedTokens",
        args: [token],
      });
      if (!supported)
        throw new Error(
          "The selected token is not enabled by Payment Channels governance.",
        );
      const decimals = Number(
        await publicClient.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: "decimals",
        }),
      );
      const amount = parseUnits(deposit, decimals);
      if (amount <= 0n) throw new Error("Deposit must be greater than zero.");
      await approve(token, amount);
      return write("openChannel", [
        counterparty,
        token,
        amount,
        BigInt(challengeHours * 3600),
      ]);
    },
  });

  const fundMutation = useMutation({
    mutationFn: async ({
      channel,
      amount,
    }: {
      channel: PaymentChannel;
      amount: string;
    }) => {
      assertStablecoinToken(channel.token);
      if (!["OPEN", "FUNDED", "ACTIVE"].includes(channel.statusLabel)) {
        throw new Error(
          "Only open, funded, or active channels can accept funds.",
        );
      }
      if (channel.tokenDecimals === null)
        throw new Error("Settlement token precision is unavailable.");
      const value = parseUnits(amount, channel.tokenDecimals);
      if (value <= 0n)
        throw new Error("Funding amount must be greater than zero.");
      await approve(channel.token, value);
      return write("fundChannel", [channel.channelId, value]);
    },
  });

  const closeMutation = useMutation({
    mutationFn: async ({
      channel,
      artifact: serialized,
      mode,
    }: {
      channel: PaymentChannel;
      artifact: string;
      mode: "unilateral" | "cooperative";
    }) => {
      assertStablecoinToken(channel.token);
      if (mode === "cooperative") {
        const artifact = await validatedArtifact(serialized, channel, "CLOSE");
        if (!artifact.signatures.partyA || !artifact.signatures.partyB) {
          throw new Error(
            "The cooperative artifact requires valid signatures from both channel parties.",
          );
        }
        return write("cooperativeClose", [
          channel.channelId,
          BigInt(artifact.state.balanceA),
          BigInt(artifact.state.balanceB),
          BigInt(artifact.state.nonce),
          artifact.signatures.partyA,
          artifact.signatures.partyB,
        ]);
      }
      const artifact = await validatedArtifact(serialized, channel, "STATE");
      return write("initiateUnilateralClose", [
        channel.channelId,
        BigInt(artifact.state.balanceA),
        BigInt(artifact.state.balanceB),
        BigInt(artifact.state.nonce),
        counterpartySignature(artifact, channel),
      ]);
    },
  });

  const cancelOpenMutation = useMutation({
    mutationFn: (channel: PaymentChannel) => {
      if (!address || getAddress(address) !== getAddress(channel.partyA)) {
        throw new Error(
          "Only the channel opener can cancel an unfunded channel.",
        );
      }
      if (channel.statusLabel !== "OPEN" || channel.depositB !== 0n) {
        throw new Error(
          "Only an OPEN channel that the counterparty never funded can be cancelled.",
        );
      }
      return write("cancelOpenChannel", [channel.channelId]);
    },
  });

  const currentStateCloseMutation = useMutation({
    mutationFn: (channel: PaymentChannel) => {
      if (!address) throw new Error("Connect a channel-party wallet first.");
      const connected = getAddress(address);
      if (
        connected !== getAddress(channel.partyA) &&
        connected !== getAddress(channel.partyB)
      ) {
        throw new Error(
          "Only an on-chain channel party can close this channel.",
        );
      }
      if (channel.statusLabel !== "ACTIVE") {
        throw new Error(
          "Only an ACTIVE channel can start a current-state close.",
        );
      }
      return write("initiateCurrentStateClose", [channel.channelId]);
    },
  });

  const disputeMutation = useMutation({
    mutationFn: async ({
      channel,
      artifact: serialized,
    }: {
      channel: PaymentChannel;
      artifact: string;
    }) => {
      assertStablecoinToken(channel.token);
      if (channel.statusLabel !== "CLOSING")
        throw new Error("Only a closing channel can be counter-disputed.");
      const artifact = await validatedArtifact(serialized, channel, "STATE");
      return write("counterDispute", [
        channel.channelId,
        BigInt(artifact.state.balanceA),
        BigInt(artifact.state.balanceB),
        BigInt(artifact.state.nonce),
        counterpartySignature(artifact, channel),
      ]);
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: (channel: PaymentChannel) => {
      return write("finalizeClose", [channel.channelId]);
    },
  });

  return {
    configured,
    connectedAddress: address,
    settlementTokensConfigured,
    kycVerified: kycQuery.data as boolean | undefined,
    channels: channelsQuery.data ?? [],
    isLoading:
      idsQuery.isLoading || channelsQuery.isLoading || kycQuery.isLoading,
    error:
      idsQuery.error ||
      channelsQuery.error ||
      kycQuery.error ||
      openMutation.error ||
      fundMutation.error ||
      closeMutation.error ||
      cancelOpenMutation.error ||
      currentStateCloseMutation.error ||
      finalizeMutation.error ||
      null,
    refetch: async () => {
      await idsQuery.refetch();
      await channelsQuery.refetch();
    },
    openChannel: openMutation.mutateAsync,
    fundChannel: fundMutation.mutateAsync,
    closeChannel: closeMutation.mutateAsync,
    cancelOpenChannel: cancelOpenMutation.mutateAsync,
    initiateCurrentStateClose: currentStateCloseMutation.mutateAsync,
    counterDispute: disputeMutation.mutateAsync,
    buildStateArtifact,
    inspectStateArtifact,
    signStateArtifact,
    finalizeClose: finalizeMutation.mutateAsync,
    isMutating:
      openMutation.isPending ||
      fundMutation.isPending ||
      closeMutation.isPending ||
      cancelOpenMutation.isPending ||
      currentStateCloseMutation.isPending ||
      disputeMutation.isPending ||
      finalizeMutation.isPending,
    reset: () => {
      openMutation.reset();
      fundMutation.reset();
      closeMutation.reset();
      cancelOpenMutation.reset();
      currentStateCloseMutation.reset();
      disputeMutation.reset();
      finalizeMutation.reset();
    },
  };
}
