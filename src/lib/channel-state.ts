import { z } from "zod";
import {
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type Address,
  type Hex,
} from "viem";

export const CHANNEL_STATE_DOMAIN_NAME = "NoblePay PaymentChannels";
export const CHANNEL_STATE_DOMAIN_VERSION = "1";
export const CHANNEL_STATE_ARTIFACT_FORMAT = "noblepay-channel-state-v2";

export const CHANNEL_STATE_TYPES = {
  ChannelState: [
    { name: "channelId", type: "bytes32" },
    { name: "balanceA", type: "uint256" },
    { name: "balanceB", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "stateEpoch", type: "uint256" },
    { name: "stateType", type: "bytes32" },
  ],
} as const;

export type ChannelStateType = "CLOSE" | "STATE";

export interface ChannelStateArtifact {
  format: typeof CHANNEL_STATE_ARTIFACT_FORMAT;
  chainId: string;
  verifyingContract: Address;
  state: {
    channelId: Hex;
    balanceA: string;
    balanceB: string;
    nonce: string;
    stateEpoch: string;
    stateType: ChannelStateType;
  };
  signatures: {
    partyA: Hex | null;
    partyB: Hex | null;
  };
}

const bytes32 = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/u, "Expected a bytes32 value");
const address = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/u, "Expected an EVM address");
const unsignedInteger = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/u, "Expected an unsigned integer");
const signature = z
  .string()
  .regex(
    /^0x(?:[a-fA-F0-9]{2}){1,4096}$/u,
    "Expected a non-empty EVM signature of at most 4096 bytes",
  );

const ChannelStateArtifactSchema = z
  .object({
    format: z.literal(CHANNEL_STATE_ARTIFACT_FORMAT),
    chainId: unsignedInteger.refine(
      (value) => BigInt(value) > 0n,
      "Chain ID must be positive",
    ),
    verifyingContract: address,
    state: z
      .object({
        channelId: bytes32,
        balanceA: unsignedInteger,
        balanceB: unsignedInteger,
        nonce: unsignedInteger,
        stateEpoch: unsignedInteger,
        stateType: z.enum(["CLOSE", "STATE"]),
      })
      .strict(),
    signatures: z
      .object({
        partyA: signature.nullable(),
        partyB: signature.nullable(),
      })
      .strict(),
  })
  .strict();

function normalizeArtifact(
  value: z.infer<typeof ChannelStateArtifactSchema>,
): ChannelStateArtifact {
  return {
    format: CHANNEL_STATE_ARTIFACT_FORMAT,
    chainId: value.chainId,
    verifyingContract: getAddress(value.verifyingContract),
    state: {
      channelId: value.state.channelId.toLowerCase() as Hex,
      balanceA: value.state.balanceA,
      balanceB: value.state.balanceB,
      nonce: value.state.nonce,
      stateEpoch: value.state.stateEpoch,
      stateType: value.state.stateType,
    },
    signatures: {
      partyA:
        (value.signatures.partyA?.toLowerCase() as Hex | undefined) ?? null,
      partyB:
        (value.signatures.partyB?.toLowerCase() as Hex | undefined) ?? null,
    },
  };
}

export function createChannelStateArtifact(input: {
  chainId: number | bigint;
  verifyingContract: string;
  channelId: string;
  balanceA: bigint;
  balanceB: bigint;
  nonce: bigint;
  stateEpoch: bigint;
  stateType: ChannelStateType;
}): ChannelStateArtifact {
  if (BigInt(input.chainId) <= 0n)
    throw new Error("Channel-state chain ID must be positive.");
  if (input.balanceA < 0n || input.balanceB < 0n)
    throw new Error("Channel balances cannot be negative.");
  if (input.nonce <= 0n)
    throw new Error("Channel-state nonce must be positive.");
  return normalizeArtifact(
    ChannelStateArtifactSchema.parse({
      format: CHANNEL_STATE_ARTIFACT_FORMAT,
      chainId: BigInt(input.chainId).toString(),
      verifyingContract: input.verifyingContract,
      state: {
        channelId: input.channelId,
        balanceA: input.balanceA.toString(),
        balanceB: input.balanceB.toString(),
        nonce: input.nonce.toString(),
        stateEpoch: input.stateEpoch.toString(),
        stateType: input.stateType,
      },
      signatures: { partyA: null, partyB: null },
    }),
  );
}

export function parseChannelStateArtifact(
  serialized: string,
): ChannelStateArtifact {
  if (!serialized.trim())
    throw new Error("Paste or build a channel-state artifact first.");
  if (new TextEncoder().encode(serialized).length > 16_384) {
    throw new Error("Channel-state artifact exceeds 16 KiB.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Channel-state artifact is not valid JSON.");
  }
  const validated = ChannelStateArtifactSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Invalid channel-state artifact: ${validated.error.issues[0]?.message || "schema mismatch"}.`,
    );
  }
  return normalizeArtifact(validated.data);
}

export function serializeChannelStateArtifact(
  artifact: ChannelStateArtifact,
): string {
  return JSON.stringify(
    normalizeArtifact(ChannelStateArtifactSchema.parse(artifact)),
    null,
    2,
  );
}

export function channelStateTypedData(artifact: ChannelStateArtifact) {
  const normalized = normalizeArtifact(
    ChannelStateArtifactSchema.parse(artifact),
  );
  return {
    domain: {
      name: CHANNEL_STATE_DOMAIN_NAME,
      version: CHANNEL_STATE_DOMAIN_VERSION,
      chainId: BigInt(normalized.chainId),
      verifyingContract: normalized.verifyingContract,
    },
    types: CHANNEL_STATE_TYPES,
    primaryType: "ChannelState" as const,
    message: {
      channelId: normalized.state.channelId,
      balanceA: BigInt(normalized.state.balanceA),
      balanceB: BigInt(normalized.state.balanceB),
      nonce: BigInt(normalized.state.nonce),
      stateEpoch: BigInt(normalized.state.stateEpoch),
      stateType: keccak256(toBytes(normalized.state.stateType)),
    },
  };
}

export interface ExpectedChannelState {
  chainId: number | bigint;
  verifyingContract: string;
  channelId: string;
  partyA: string;
  partyB: string;
  totalDeposit: bigint;
  minimumNonceExclusive: bigint;
  stateEpoch: bigint;
  stateType: ChannelStateType;
}

export type ChannelStateSignatureVerifier = (input: {
  address: Address;
  signature: Hex;
  typedData: ReturnType<typeof channelStateTypedData>;
}) => Promise<boolean>;

async function verifyPartySignature(
  signature: Hex,
  expectedSigner: string,
  label: "party A" | "party B" | "wallet",
  typedData: ReturnType<typeof channelStateTypedData>,
  verifier?: ChannelStateSignatureVerifier,
): Promise<Address> {
  const expectedAddress = getAddress(expectedSigner);
  if (verifier) {
    let valid = false;
    try {
      valid = await verifier({
        address: expectedAddress,
        signature,
        typedData,
      });
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new Error(
        label === "wallet"
          ? "Wallet returned an invalid EOA or ERC-1271 signature."
          : `Artifact ${label} signature does not match the on-chain party.`,
      );
    }
    return expectedAddress;
  }

  try {
    const recovered = await recoverTypedDataAddress({
      ...typedData,
      signature,
    });
    if (recovered === expectedAddress) return recovered;
  } catch {
    // A caller without a chain-aware verifier can validate only EOA signatures.
  }
  throw new Error(
    label === "wallet"
      ? "Wallet returned an invalid EOA signature."
      : `Artifact ${label} signature does not match the on-chain party.`,
  );
}

export async function validateChannelStateArtifact(
  artifact: ChannelStateArtifact,
  expected: ExpectedChannelState,
  verifier?: ChannelStateSignatureVerifier,
): Promise<{ partyA: Address | null; partyB: Address | null }> {
  const normalized = normalizeArtifact(
    ChannelStateArtifactSchema.parse(artifact),
  );
  if (normalized.chainId !== BigInt(expected.chainId).toString()) {
    throw new Error("Channel-state artifact belongs to a different chain.");
  }
  if (normalized.verifyingContract !== getAddress(expected.verifyingContract)) {
    throw new Error(
      "Channel-state artifact belongs to a different Payment Channels deployment.",
    );
  }
  if (normalized.state.channelId !== expected.channelId.toLowerCase()) {
    throw new Error("Channel-state artifact belongs to a different channel.");
  }
  if (normalized.state.stateType !== expected.stateType) {
    throw new Error(`Channel-state artifact must use ${expected.stateType}.`);
  }
  if (BigInt(normalized.state.stateEpoch) !== expected.stateEpoch) {
    throw new Error(
      "Channel-state artifact belongs to a different on-chain state epoch.",
    );
  }
  const nonce = BigInt(normalized.state.nonce);
  if (nonce <= expected.minimumNonceExclusive) {
    throw new Error(
      "Channel-state artifact nonce is not newer than the on-chain state.",
    );
  }
  const balanceA = BigInt(normalized.state.balanceA);
  const balanceB = BigInt(normalized.state.balanceB);
  if (balanceA + balanceB !== expected.totalDeposit) {
    throw new Error("Channel-state balances do not equal the channel escrow.");
  }

  const typedData = channelStateTypedData(normalized);
  const recovered = { partyA: null, partyB: null } as {
    partyA: Address | null;
    partyB: Address | null;
  };
  if (normalized.signatures.partyA) {
    recovered.partyA = await verifyPartySignature(
      normalized.signatures.partyA,
      expected.partyA,
      "party A",
      typedData,
      verifier,
    );
  }
  if (normalized.signatures.partyB) {
    recovered.partyB = await verifyPartySignature(
      normalized.signatures.partyB,
      expected.partyB,
      "party B",
      typedData,
      verifier,
    );
  }
  return recovered;
}

export async function attachChannelStateSignature(
  artifact: ChannelStateArtifact,
  signer: string,
  signedValue: Hex,
  expected: ExpectedChannelState,
  verifier?: ChannelStateSignatureVerifier,
): Promise<ChannelStateArtifact> {
  await validateChannelStateArtifact(artifact, expected, verifier);
  const connectedSigner = getAddress(signer);
  const partyA = getAddress(expected.partyA);
  const partyB = getAddress(expected.partyB);
  if (connectedSigner !== partyA && connectedSigner !== partyB) {
    throw new Error("Only an on-chain channel party can sign this state.");
  }
  await verifyPartySignature(
    signedValue,
    connectedSigner,
    "wallet",
    channelStateTypedData(artifact),
    verifier,
  );
  return {
    ...artifact,
    signatures: {
      ...artifact.signatures,
      ...(connectedSigner === partyA
        ? { partyA: signedValue }
        : { partyB: signedValue }),
    },
  };
}
