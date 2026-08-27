/**
 * Tests for cross-chain transfer verification.
 *
 * As with treasury and liquidity execution, the property under test is refusal:
 * a caller can claim any transaction escrowed any transfer, and what matters is
 * that each way of being wrong is caught and named separately.
 *
 * The recipient check carries the most weight here. CrossChainRouter accepts
 * `recipientHash` as an opaque parameter and never checks it (NP-BRIDGE-01), so
 * this verifier is the only thing standing between an on-chain escrow committed
 * to one destination and a database record naming another.
 */

const mockGetCanonicalTransaction = jest.fn();
const mockAssertCanonicalChainSnapshot = jest.fn();
const mockCall = jest.fn();

class MockCanonicalTransactionError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

jest.mock("../../lib/canonical-chain-transaction", () => ({
  getCanonicalTransaction: (...a: unknown[]) => mockGetCanonicalTransaction(...a),
  assertCanonicalChainSnapshot: (...a: unknown[]) =>
    mockAssertCanonicalChainSnapshot(...a),
  CanonicalTransactionError: MockCanonicalTransactionError,
}));

jest.mock("ethers", () => {
  const actual = jest.requireActual("ethers");
  return {
    ...actual,
    JsonRpcProvider: jest.fn(() => ({ call: (...a: unknown[]) => mockCall(...a) })),
  };
});

import { Interface, keccak256, toUtf8Bytes } from "ethers";

import {
  recipientCommitment,
  ROUTER_INTERFACE,
  TransferVerificationError,
  verifyTransferInitiation,
  verifyTransferRecovery,
} from "../../services/crosschain-execution";

const ROUTER = "0x9a7c1f3b5d2e4a6c8b0d1f3a5c7e9b1d3f5a7c9e";
const OTHER_CONTRACT = "0x000000000000000000000000000000000000dead";
const SENDER = "0x2E8625F06A696b556B7B5e0C1b34B1cb55203af1";
const STRANGER = "0x1111111111111111111111111111111111111111";
const SOURCE_TOKEN = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
const DESTINATION_CHAIN_ID = 137;

const TRANSFER_ID =
  "0x7f3d9c1a5e2b8f4d6a0c3e7b9d1f5a3c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f";
const TX_HASH =
  "0xc62faafeb160571853128e25efc65388ca483c22504742b7b455dfcc8ade5faa";

const config = {
  rpcUrl: "http://rpc.invalid",
  minimumConfirmations: 3,
} as never;

const env = { CROSSCHAIN_ROUTER_ADDRESS: ROUTER } as NodeJS.ProcessEnv;

const IFACE = new Interface([
  "event TransferInitiated(bytes32 indexed transferId,address indexed sender,uint256 indexed destinationChainId,address sourceToken,uint256 amount,uint256 fee,bytes32 recipientHash)",
  "event TransferRecovered(bytes32 indexed transferId,address indexed sender,uint256 refundAmount,uint256 recoveredAt)",
]);

const initiatedLog = (
  over: {
    transferId?: string;
    sender?: string;
    destinationChainId?: number;
    recipientHash?: string;
    address?: string;
  } = {},
) => {
  const encoded = IFACE.encodeEventLog("TransferInitiated", [
    over.transferId ?? TRANSFER_ID,
    over.sender ?? SENDER,
    over.destinationChainId ?? DESTINATION_CHAIN_ID,
    SOURCE_TOKEN,
    1_000_000n,
    2_500n,
    over.recipientHash ?? recipientCommitment(RECIPIENT),
  ]);
  return {
    address: over.address ?? ROUTER,
    topics: encoded.topics,
    data: encoded.data,
  };
};

const recoveredLog = (
  over: { transferId?: string; sender?: string; address?: string } = {},
) => {
  const encoded = IFACE.encodeEventLog("TransferRecovered", [
    over.transferId ?? TRANSFER_ID,
    over.sender ?? SENDER,
    1_002_500n,
    1_700_000_500n,
  ]);
  return {
    address: over.address ?? ROUTER,
    topics: encoded.topics,
    data: encoded.data,
  };
};

const canonical = (logs: unknown[] = [initiatedLog()], to: string = ROUTER) => ({
  receipt: { blockNumber: 8811, blockHash: "0xblock", logs },
  transaction: { to, from: SENDER, data: "0x" },
  block: { timestamp: 1_700_000_000 },
  confirmations: 5,
});

/** getTransfer returning a struct with the given sender and status. */
const chainTransfer = (status: number, sender: string = SENDER) =>
  ROUTER_INTERFACE.encodeFunctionResult("getTransfer", [
    [
      sender,
      recipientCommitment(RECIPIENT),
      SOURCE_TOKEN,
      1_000_000n,
      2_500n,
      BigInt(DESTINATION_CHAIN_ID),
      `0x${"0".repeat(64)}`,
      status,
      "0x0000000000000000000000000000000000000000",
      1_700_000_000n,
      0n,
      1_700_086_400n,
      "0x",
      500n,
    ],
  ]);

const ZERO_TRANSFER = chainTransfer(
  0,
  "0x0000000000000000000000000000000000000000",
);

const initiationInput = {
  txHash: TX_HASH,
  onChainTransferId: TRANSFER_ID,
  expectedSender: SENDER,
  expectedRecipient: RECIPIENT,
  expectedDestinationChainId: DESTINATION_CHAIN_ID,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCanonicalTransaction.mockResolvedValue(canonical());
  mockAssertCanonicalChainSnapshot.mockResolvedValue(undefined);
  mockCall.mockResolvedValue(chainTransfer(0)); // INITIATED
});

describe("recipientCommitment", () => {
  it("is the encoding the router refuses to define", () => {
    // Pinned deliberately: the contract accepts any bytes32, so this function
    // IS the convention. Changing it silently invalidates every stored record.
    expect(recipientCommitment(RECIPIENT)).toBe(
      keccak256(toUtf8Bytes(RECIPIENT.toLowerCase())),
    );
  });

  it("ignores address casing and surrounding whitespace", () => {
    // EIP-55 checksumming means the same address arrives cased differently from
    // different clients; that must not produce a different commitment.
    expect(recipientCommitment(`  ${RECIPIENT.toUpperCase()}  `)).toBe(
      recipientCommitment(RECIPIENT.toLowerCase()),
    );
  });

  it("distinguishes different recipients", () => {
    expect(recipientCommitment(RECIPIENT)).not.toBe(
      recipientCommitment(STRANGER),
    );
  });
});

describe("verifyTransferInitiation — the happy path", () => {
  it("returns the escrow details worth recording", async () => {
    const result = await verifyTransferInitiation(config, initiationInput, env);
    expect(result.onChainTransferId).toBe(TRANSFER_ID.toLowerCase());
    expect(result.txHash).toBe(TX_HASH.toLowerCase());
    expect(result.blockNumber).toBe(8811);
    expect(result.amount).toBe("1000000");
    expect(result.fee).toBe("2500");
    expect(result.destinationChainId).toBe(DESTINATION_CHAIN_ID);
  });

  it("reports the chain's own status rather than assuming INITIATED", async () => {
    // Verification can legitimately run after a relay has advanced the
    // transfer. Demanding the initial state would reject exactly the transfers
    // that are progressing normally.
    mockCall.mockResolvedValue(chainTransfer(1)); // RELAYED
    const result = await verifyTransferInitiation(config, initiationInput, env);
    expect(result.chainStatus).toBe("RELAYED");
  });

  it("enforces the configured confirmation depth", async () => {
    await verifyTransferInitiation(config, initiationInput, env);
    expect(mockGetCanonicalTransaction).toHaveBeenCalledWith(
      expect.anything(),
      TX_HASH,
      3,
    );
  });
});

describe("verifyTransferInitiation — each way of being wrong", () => {
  it("refuses when no router is configured", async () => {
    await expect(
      verifyTransferInitiation(config, initiationInput, {} as NodeJS.ProcessEnv),
    ).rejects.toMatchObject({
      reason: "NO_ROUTER_CONFIGURED",
      statusCode: 501,
    });
  });

  it("treats an unmined transaction as 409, not a permanent failure", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("NOT_MINED"),
    );
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_NOT_MINED", statusCode: 409 });
  });

  it("refuses a reverted transaction", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("REVERTED"),
    );
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_REVERTED" });
  });

  it("refuses below the confirmation depth", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("INSUFFICIENT_CONFIRMATIONS"),
    );
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({
      reason: "TRANSFER_NOT_CONFIRMED",
      statusCode: 409,
    });
  });

  it("reports an unreachable node as 503 rather than a verification failure", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("RPC_UNAVAILABLE"),
    );
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({
      reason: "TRANSFER_RPC_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("refuses a receipt from a different network", async () => {
    mockAssertCanonicalChainSnapshot.mockRejectedValue(new Error("anchor"));
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_CHAIN_MISMATCH" });
  });

  it("refuses a transaction sent to some other contract", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([initiatedLog()], OTHER_CONTRACT),
    );
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_WRONG_TARGET" });
  });

  it("refuses when TransferInitiated was not emitted", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(canonical([]));
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_EVENT_MISSING" });
  });

  it("ignores a TransferInitiated emitted by a different contract", async () => {
    // An impostor contract can emit any event it likes.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([initiatedLog({ address: OTHER_CONTRACT })]),
    );
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_EVENT_MISSING" });
  });

  it("refuses when the transaction escrowed a DIFFERENT transfer", async () => {
    // A real, canonical, successful escrow of transfer B is not evidence for A.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([initiatedLog({ transferId: `0x${"a".repeat(64)}` })]),
    );
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_EVENT_MISSING" });
  });

  it("refuses a transfer escrowed by a different account", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([initiatedLog({ sender: STRANGER })]),
    );
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({
      reason: "TRANSFER_SENDER_MISMATCH",
      statusCode: 403,
    });
  });

  it("refuses when the escrow named a different destination chain", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([initiatedLog({ destinationChainId: 42161 })]),
    );
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_DESTINATION_MISMATCH" });
  });

  it("refuses when the recorded recipient is not the one committed on chain", async () => {
    // The NP-BRIDGE-01 check, and the reason this verifier exists. The escrow
    // below is entirely valid: right transfer id, right sender, right chain,
    // mined and confirmed. Only the recipient differs from what is about to be
    // written to the database, and that alone must stop it.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([
        initiatedLog({ recipientHash: recipientCommitment(STRANGER) }),
      ]),
    );
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_RECIPIENT_MISMATCH" });
  });

  it("refuses an all-zero recipient commitment", async () => {
    // The contract accepts bytes32(0) as readily as a real commitment.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([initiatedLog({ recipientHash: `0x${"0".repeat(64)}` })]),
    );
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_RECIPIENT_MISMATCH" });
  });

  it("refuses when the router has no such transfer", async () => {
    // The event is history; getTransfer is the contract's current agreement.
    // Disagreement means the read is pointed somewhere unexpected.
    mockCall.mockResolvedValue(ZERO_TRANSFER);
    await expect(
      verifyTransferInitiation(config, initiationInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_UNKNOWN_ON_CHAIN" });
  });
});

describe("verifyTransferRecovery", () => {
  const recoveryInput = {
    txHash: TX_HASH,
    onChainTransferId: TRANSFER_ID,
    expectedSender: SENDER,
  };

  beforeEach(() => {
    mockGetCanonicalTransaction.mockResolvedValue(canonical([recoveredLog()]));
    mockCall.mockResolvedValue(chainTransfer(5)); // RECOVERED
  });

  it("returns the refund details worth recording", async () => {
    const result = await verifyTransferRecovery(config, recoveryInput, env);
    expect(result.onChainTransferId).toBe(TRANSFER_ID.toLowerCase());
    expect(result.refundAmount).toBe("1002500");
    expect(result.txHash).toBe(TX_HASH.toLowerCase());
    expect(result.blockNumber).toBe(8811);
  });

  it("refuses when TransferRecovered was not emitted", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(canonical([initiatedLog()]));
    await expect(
      verifyTransferRecovery(config, recoveryInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_EVENT_MISSING" });
  });

  it("refuses when the refund went to a different account", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([recoveredLog({ sender: STRANGER })]),
    );
    await expect(
      verifyTransferRecovery(config, recoveryInput, env),
    ).rejects.toMatchObject({
      reason: "TRANSFER_SENDER_MISMATCH",
      statusCode: 403,
    });
  });

  it("refuses when the router does not report the transfer as recovered", async () => {
    // A TransferRecovered event without a RECOVERED status means the read and
    // the log disagree, and a refund is not something to record on a guess.
    mockCall.mockResolvedValue(chainTransfer(0)); // INITIATED
    await expect(
      verifyTransferRecovery(config, recoveryInput, env),
    ).rejects.toMatchObject({ reason: "RECOVERY_STATUS_NOT_RECOVERED" });
  });

  it("refuses when the router has no such transfer", async () => {
    mockCall.mockResolvedValue(ZERO_TRANSFER);
    await expect(
      verifyTransferRecovery(config, recoveryInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_UNKNOWN_ON_CHAIN" });
  });

  it("refuses a recovery receipt aimed at another contract", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([recoveredLog()], OTHER_CONTRACT),
    );
    await expect(
      verifyTransferRecovery(config, recoveryInput, env),
    ).rejects.toMatchObject({ reason: "TRANSFER_WRONG_TARGET" });
  });
});

describe("TransferVerificationError", () => {
  it("defaults to 422 — a claim that failed verification is not a server fault", () => {
    expect(new TransferVerificationError("TRANSFER_REVERTED", "x").statusCode).toBe(
      422,
    );
  });
});
