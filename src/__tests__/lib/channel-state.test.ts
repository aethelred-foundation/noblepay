jest.mock("viem", () => jest.requireActual("viem"));

import { privateKeyToAccount } from "viem/accounts";
import {
  attachChannelStateSignature,
  channelStateTypedData,
  createChannelStateArtifact,
  parseChannelStateArtifact,
  serializeChannelStateArtifact,
  validateChannelStateArtifact,
  type ExpectedChannelState,
  type ChannelStateSignatureVerifier,
} from "@/lib/channel-state";

const partyA = privateKeyToAccount(`0x${"11".repeat(32)}`);
const partyB = privateKeyToAccount(`0x${"22".repeat(32)}`);
const outsider = privateKeyToAccount(`0x${"33".repeat(32)}`);
const verifyingContract = "0x0000000000000000000000000000000000000008";
const channelId = `0x${"aa".repeat(32)}`;

function expected(
  overrides: Partial<ExpectedChannelState> = {},
): ExpectedChannelState {
  return {
    chainId: 7332,
    verifyingContract,
    channelId,
    partyA: partyA.address,
    partyB: partyB.address,
    totalDeposit: 15_000_000n,
    minimumNonceExclusive: 3n,
    stateEpoch: 2n,
    stateType: "CLOSE",
    ...overrides,
  };
}

function artifact() {
  return createChannelStateArtifact({
    chainId: 7332,
    verifyingContract,
    channelId,
    balanceA: 8_000_000n,
    balanceB: 7_000_000n,
    nonce: 4n,
    stateEpoch: 2n,
    stateType: "CLOSE",
  });
}

describe("portable PaymentChannels state artifacts", () => {
  it("round-trips canonical JSON and verifies both EIP-712 party signatures", async () => {
    const base = artifact();
    const signatureA = await partyA.signTypedData(channelStateTypedData(base));
    const signedA = await attachChannelStateSignature(
      base,
      partyA.address,
      signatureA,
      expected(),
    );
    const signatureB = await partyB.signTypedData(
      channelStateTypedData(signedA),
    );
    const signed = await attachChannelStateSignature(
      signedA,
      partyB.address,
      signatureB,
      expected(),
    );

    const parsed = parseChannelStateArtifact(
      serializeChannelStateArtifact(signed),
    );
    await expect(
      validateChannelStateArtifact(parsed, expected()),
    ).resolves.toEqual({
      partyA: partyA.address,
      partyB: partyB.address,
    });
  });

  it("rejects artifacts from another chain or contract deployment", async () => {
    await expect(
      validateChannelStateArtifact(artifact(), expected({ chainId: 7333 })),
    ).rejects.toThrow("different chain");
    await expect(
      validateChannelStateArtifact(
        artifact(),
        expected({
          verifyingContract: "0x0000000000000000000000000000000000000009",
        }),
      ),
    ).rejects.toThrow("different Payment Channels deployment");
  });

  it("rejects stale nonces and balances that do not equal escrow", async () => {
    await expect(
      validateChannelStateArtifact(
        artifact(),
        expected({ minimumNonceExclusive: 4n }),
      ),
    ).rejects.toThrow("nonce is not newer");
    await expect(
      validateChannelStateArtifact(
        artifact(),
        expected({ totalDeposit: 14_000_000n }),
      ),
    ).rejects.toThrow("do not equal the channel escrow");
  });

  it("rejects an otherwise valid artifact after the on-chain state epoch changes", async () => {
    await expect(
      validateChannelStateArtifact(artifact(), expected({ stateEpoch: 3n })),
    ).rejects.toThrow("different on-chain state epoch");
  });

  it("refuses a valid signature from a wallet that is not a channel party", async () => {
    const base = artifact();
    const signature = await outsider.signTypedData(channelStateTypedData(base));
    await expect(
      attachChannelStateSignature(
        base,
        outsider.address,
        signature,
        expected(),
      ),
    ).rejects.toThrow("Only an on-chain channel party");
  });

  it("round-trips variable-length ERC-1271 signatures through a chain-aware verifier", async () => {
    const contractSignature = `0x${"ab".repeat(96)}` as `0x${string}`;
    const signed = {
      ...artifact(),
      signatures: { partyA: contractSignature, partyB: null },
    };
    const verifier: ChannelStateSignatureVerifier = jest.fn(
      async ({ address, signature }) =>
        address === partyA.address && signature === contractSignature,
    );

    const parsed = parseChannelStateArtifact(
      serializeChannelStateArtifact(signed),
    );
    await expect(
      validateChannelStateArtifact(parsed, expected(), verifier),
    ).resolves.toEqual({ partyA: partyA.address, partyB: null });
    expect(verifier).toHaveBeenCalledTimes(1);

    await expect(
      validateChannelStateArtifact(parsed, expected()),
    ).rejects.toThrow("party A signature does not match");
  });

  it("rejects malformed and oversized imported artifacts", () => {
    expect(() => parseChannelStateArtifact("not json")).toThrow(
      "not valid JSON",
    );
    expect(() => parseChannelStateArtifact("x".repeat(16_385))).toThrow(
      "exceeds 16 KiB",
    );
    expect(() =>
      serializeChannelStateArtifact({
        ...artifact(),
        signatures: {
          partyA: `0x${"ab".repeat(4097)}`,
          partyB: null,
        },
      }),
    ).toThrow("at most 4096 bytes");
  });
});
