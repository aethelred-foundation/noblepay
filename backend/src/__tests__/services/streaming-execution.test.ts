/**
 * Tests for payment-stream receipt verification.
 *
 * The distinctive risk in streaming is that a balance is derived from time, so
 * a wrong or missing lifecycle fact does not merely leave a record stale — it
 * makes every subsequent balance wrong, always in the direction of promising
 * money the contract will not pay. The pause-duration handling therefore gets
 * the most attention here.
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

import {
  STREAM_INTERFACE,
  StreamExecutionError,
  verifyStreamCreation,
  verifyStreamTransition,
  verifyWithdrawal,
} from "../../services/streaming-execution";

const CONTRACT = "0x7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f809";
const OTHER = "0x000000000000000000000000000000000000dead";
const SENDER = "0x2E8625F06A696b556B7B5e0C1b34B1cb55203af1";
const RECIPIENT = "0x5555555555555555555555555555555555555555";
const STRANGER = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x4444444444444444444444444444444444444444";
const STREAM_ID = `0x${"3a".repeat(32)}`;
const TX_HASH =
  "0xc62faafeb160571853128e25efc65388ca483c22504742b7b455dfcc8ade5faa";

const config = { rpcUrl: "http://rpc.invalid", minimumConfirmations: 3 } as never;
const env = { STREAMING_PAYMENTS_ADDRESS: CONTRACT } as NodeJS.ProcessEnv;

const START = 1_700_000_000;
const END = START + 100;

const log = (name: string, args: unknown[], address = CONTRACT) => {
  const encoded = STREAM_INTERFACE.encodeEventLog(name, args);
  return { address, topics: encoded.topics, data: encoded.data };
};

const createdLog = (
  over: { sender?: string; recipient?: string; streamId?: string } = {},
) =>
  log("StreamCreated", [
    over.streamId ?? STREAM_ID,
    over.sender ?? SENDER,
    over.recipient ?? RECIPIENT,
    TOKEN,
    100_000n,
    1_000n,
    START,
    END,
    0,
  ]);

const canonical = (logs: unknown[], to: string = CONTRACT) => ({
  receipt: { blockNumber: 7007, blockHash: "0xblock", logs },
  transaction: { to, from: SENDER, data: "0x" },
  block: { timestamp: START + 60 },
  confirmations: 5,
});

const chainStream = (
  over: {
    sender?: string;
    status?: number;
    totalPausedDuration?: number;
    withdrawnAmount?: bigint;
  } = {},
) =>
  STREAM_INTERFACE.encodeFunctionResult("getStream", [
    [
      over.sender ?? SENDER,
      RECIPIENT,
      TOKEN,
      100_000n,
      over.withdrawnAmount ?? 0n,
      1_000n,
      BigInt(START),
      BigInt(END),
      0n,
      0n,
      0n,
      BigInt(over.totalPausedDuration ?? 0),
      over.status ?? 0,
    ],
  ]);

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertCanonicalChainSnapshot.mockResolvedValue(undefined);
  mockGetCanonicalTransaction.mockResolvedValue(canonical([createdLog()]));
  mockCall.mockResolvedValue(chainStream());
});

const creationInput = {
  txHash: TX_HASH,
  onChainStreamId: STREAM_ID,
  expectedSender: SENDER,
  expectedRecipient: RECIPIENT,
};

describe("verifyStreamCreation", () => {
  it("takes the timings from the chain", async () => {
    // These drive every balance from here on, so they must come from the
    // escrow rather than from the request that described it.
    const result = await verifyStreamCreation(config, creationInput, env);
    expect(result.startTime.getTime()).toBe(START * 1000);
    expect(result.endTime.getTime()).toBe(END * 1000);
    expect(result.cliffEndTime).toBeNull();
    expect(result.ratePerSecond).toBe("1000");
  });

  it("refuses when no contract is configured", async () => {
    await expect(
      verifyStreamCreation(config, creationInput, {} as NodeJS.ProcessEnv),
    ).rejects.toMatchObject({
      reason: "NO_STREAMING_CONTRACT_CONFIGURED",
      statusCode: 501,
    });
  });

  it("treats an unmined transaction as 409", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("NOT_MINED"),
    );
    await expect(
      verifyStreamCreation(config, creationInput, env),
    ).rejects.toMatchObject({ reason: "STREAM_NOT_MINED", statusCode: 409 });
  });

  it("refuses a reverted transaction", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("REVERTED"),
    );
    await expect(
      verifyStreamCreation(config, creationInput, env),
    ).rejects.toMatchObject({ reason: "STREAM_REVERTED" });
  });

  it("reports an unreachable node as 503", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("RPC_UNAVAILABLE"),
    );
    await expect(
      verifyStreamCreation(config, creationInput, env),
    ).rejects.toMatchObject({ reason: "STREAM_RPC_UNAVAILABLE", statusCode: 503 });
  });

  it("refuses a receipt from a different network", async () => {
    mockAssertCanonicalChainSnapshot.mockRejectedValue(new Error("anchor"));
    await expect(
      verifyStreamCreation(config, creationInput, env),
    ).rejects.toMatchObject({ reason: "STREAM_CHAIN_MISMATCH" });
  });

  it("refuses a transaction sent to some other contract", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([createdLog()], OTHER),
    );
    await expect(
      verifyStreamCreation(config, creationInput, env),
    ).rejects.toMatchObject({ reason: "STREAM_WRONG_TARGET" });
  });

  it("refuses a stream created by a different account", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([createdLog({ sender: STRANGER })]),
    );
    await expect(
      verifyStreamCreation(config, creationInput, env),
    ).rejects.toMatchObject({ reason: "STREAM_SENDER_MISMATCH", statusCode: 403 });
  });

  it("refuses a stream that pays a DIFFERENT recipient", async () => {
    // A payroll run recorded against the wrong person on paper while the
    // contract pays someone else.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([createdLog({ recipient: STRANGER })]),
    );
    await expect(
      verifyStreamCreation(config, creationInput, env),
    ).rejects.toMatchObject({ reason: "STREAM_RECIPIENT_MISMATCH" });
  });

  it("refuses an event for a DIFFERENT stream", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([createdLog({ streamId: `0x${"bb".repeat(32)}` })]),
    );
    await expect(
      verifyStreamCreation(config, creationInput, env),
    ).rejects.toMatchObject({ reason: "STREAM_EVENT_MISSING" });
  });

  it("refuses when the contract has no such stream", async () => {
    mockCall.mockResolvedValue(
      chainStream({ sender: "0x0000000000000000000000000000000000000000" }),
    );
    await expect(
      verifyStreamCreation(config, creationInput, env),
    ).rejects.toMatchObject({ reason: "STREAM_UNKNOWN_ON_CHAIN" });
  });
});

describe("verifyStreamTransition", () => {
  const base = {
    txHash: TX_HASH,
    onChainStreamId: STREAM_ID,
    expectedSender: SENDER,
  };

  it("reports a pause", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("StreamPaused", [STREAM_ID, START + 10])]),
    );
    mockCall.mockResolvedValue(chainStream({ status: 1 }));
    const result = await verifyStreamTransition(
      config,
      { ...base, kind: "PAUSED" },
      env,
    );
    expect(result.chainStatus).toBe("PAUSED");
    expect(result.pausedDurationSeconds).toBeNull();
  });

  it("carries the pause duration off a resume", async () => {
    // The field NP-STREAM-01 turns on. Without it the API cannot know how long
    // the stream was paused and its balance drifts above what will be paid.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("StreamResumed", [STREAM_ID, START + 40, 30])]),
    );
    mockCall.mockResolvedValue(chainStream({ status: 0, totalPausedDuration: 30 }));
    const result = await verifyStreamTransition(
      config,
      { ...base, kind: "RESUMED" },
      env,
    );
    expect(result.pausedDurationSeconds).toBe(30);
    expect(result.totalPausedSeconds).toBe(30);
    expect(result.chainStatus).toBe("ACTIVE");
  });

  it("takes the running pause total from the CONTRACT, not the event", async () => {
    // If an earlier resume was never recorded here, the event's increment alone
    // would leave the record permanently short. The contract's running total
    // repairs it on the next transition.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("StreamResumed", [STREAM_ID, START + 80, 20])]),
    );
    mockCall.mockResolvedValue(chainStream({ status: 0, totalPausedDuration: 50 }));
    const result = await verifyStreamTransition(
      config,
      { ...base, kind: "RESUMED" },
      env,
    );
    expect(result.pausedDurationSeconds).toBe(20);
    expect(result.totalPausedSeconds).toBe(50);
  });

  it("reports a cancellation with its escrow split", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("StreamCancelled", [STREAM_ID, 30_000n, 70_000n, START + 30])]),
    );
    mockCall.mockResolvedValue(chainStream({ status: 2 }));
    const result = await verifyStreamTransition(
      config,
      { ...base, kind: "CANCELLED" },
      env,
    );
    expect(result.chainStatus).toBe("CANCELLED");
    expect(result.recipientAmount).toBe("30000");
    expect(result.senderRefund).toBe("70000");
  });

  it("does not confuse CANCELLED with COMPLETED", async () => {
    // The two enums disagree at exactly these indices. Status 2 is CANCELLED on
    // chain; reading it through the Prisma ordering would say COMPLETED.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("StreamCompleted", [STREAM_ID, END])]),
    );
    mockCall.mockResolvedValue(chainStream({ status: 3 }));
    const result = await verifyStreamTransition(
      config,
      { ...base, kind: "COMPLETED" },
      env,
    );
    expect(result.chainStatus).toBe("COMPLETED");
  });

  it("refuses when the contract's status contradicts the event", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("StreamPaused", [STREAM_ID, START + 10])]),
    );
    mockCall.mockResolvedValue(chainStream({ status: 0 })); // still ACTIVE
    await expect(
      verifyStreamTransition(config, { ...base, kind: "PAUSED" }, env),
    ).rejects.toMatchObject({ reason: "STREAM_STATUS_MISMATCH" });
  });

  it("binds ownership through the stream, since no transition event names one", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("StreamPaused", [STREAM_ID, START + 10])]),
    );
    mockCall.mockResolvedValue(chainStream({ status: 1, sender: STRANGER }));
    await expect(
      verifyStreamTransition(config, { ...base, kind: "PAUSED" }, env),
    ).rejects.toMatchObject({ reason: "STREAM_SENDER_MISMATCH", statusCode: 403 });
  });

  it("refuses when the named transition's event is absent", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("StreamPaused", [STREAM_ID, START + 10])]),
    );
    await expect(
      verifyStreamTransition(config, { ...base, kind: "RESUMED" }, env),
    ).rejects.toMatchObject({ reason: "STREAM_EVENT_MISSING" });
  });
});

describe("verifyWithdrawal", () => {
  const input = {
    txHash: TX_HASH,
    onChainStreamId: STREAM_ID,
    expectedRecipient: RECIPIENT,
  };

  beforeEach(() => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("Withdrawal", [STREAM_ID, RECIPIENT, 12_000n, START + 60])]),
    );
    mockCall.mockResolvedValue(chainStream({ withdrawnAmount: 42_000n }));
  });

  it("returns the contract's running total, not just the increment", async () => {
    // withdrawn feeds `withdrawable = streamed - withdrawn`. Accumulating
    // increments locally would drift the first time a receipt is replayed.
    const result = await verifyWithdrawal(config, input, env);
    expect(result.amount).toBe("12000");
    expect(result.withdrawnTotal).toBe("42000");
  });

  it("refuses a withdrawal paid to someone other than the recipient", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("Withdrawal", [STREAM_ID, STRANGER, 12_000n, START + 60])]),
    );
    await expect(verifyWithdrawal(config, input, env)).rejects.toMatchObject({
      reason: "STREAM_RECIPIENT_MISMATCH",
      statusCode: 403,
    });
  });

  it("refuses when Withdrawal was not emitted", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(canonical([createdLog()]));
    await expect(verifyWithdrawal(config, input, env)).rejects.toMatchObject({
      reason: "STREAM_EVENT_MISSING",
    });
  });
});

describe("StreamExecutionError", () => {
  it("defaults to 422", () => {
    expect(new StreamExecutionError("STREAM_REVERTED", "x").statusCode).toBe(422);
  });
});
