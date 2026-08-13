/**
 * Verifies payment-stream receipts against StreamingPayments.
 *
 * Same shape as the other verifiers: the API holds no key, the sender acts from
 * their own wallet, and a record is written only if the receipt corroborates it.
 *
 * The thing to understand about streams specifically is that a balance is
 * derived from time, so a missed lifecycle event does not merely leave a record
 * stale — it makes every subsequent balance wrong. A resume that is not recorded
 * loses its pause interval permanently, and the API goes on reporting a stream
 * as further along than the contract will pay out (NP-STREAM-01). That is why
 * `pausedDuration` is taken from the StreamResumed event and accumulated rather
 * than recomputed from timestamps here: the contract's own arithmetic is the
 * only figure guaranteed to agree with what it will actually pay.
 */

import { Interface, JsonRpcProvider } from "ethers";

import {
  assertCanonicalChainSnapshot,
  CanonicalTransactionError,
  getCanonicalTransaction,
} from "../lib/canonical-chain-transaction";
import type { NoblePayChainConfiguration } from "../lib/production-config";

export const STREAM_INTERFACE = new Interface([
  "event StreamCreated(bytes32 indexed streamId,address indexed sender,address indexed recipient,address token,uint256 totalAmount,uint256 ratePerSecond,uint256 startTime,uint256 endTime,uint256 cliffEndTime)",
  "event StreamPaused(bytes32 indexed streamId,uint256 pausedAt)",
  "event StreamResumed(bytes32 indexed streamId,uint256 resumedAt,uint256 pausedDuration)",
  "event StreamCancelled(bytes32 indexed streamId,uint256 recipientAmount,uint256 senderRefund,uint256 cancelledAt)",
  "event StreamCompleted(bytes32 indexed streamId,uint256 completedAt)",
  "event Withdrawal(bytes32 indexed streamId,address indexed recipient,uint256 amount,uint256 timestamp)",
  "function getStream(bytes32 _streamId) view returns (tuple(address sender,address recipient,address token,uint256 totalAmount,uint256 withdrawnAmount,uint256 ratePerSecond,uint256 startTime,uint256 endTime,uint256 cliffEndTime,uint256 lastWithdrawTime,uint256 pausedAt,uint256 totalPausedDuration,uint8 status))",
]);

/**
 * The CONTRACT's ordering. It is not the database's, and the difference is not
 * cosmetic: index 2 is CANCELLED here and COMPLETED in the Prisma enum, with
 * index 3 the reverse. Decoding an on-chain uint8 through the database ordering
 * would report cancelled streams as completed. See docs/audit/NP-STREAM-01.
 */
export const CHAIN_STREAM_STATUS = [
  "ACTIVE",
  "PAUSED",
  "CANCELLED",
  "COMPLETED",
] as const;

export type ChainStreamStatus = (typeof CHAIN_STREAM_STATUS)[number];

/** Lifecycle transitions this module can verify. */
export const STREAM_EVENTS = [
  "PAUSED",
  "RESUMED",
  "CANCELLED",
  "COMPLETED",
] as const;

export type StreamEventKind = (typeof STREAM_EVENTS)[number];

const EVENT_FOR_KIND: Record<
  StreamEventKind,
  { event: string; terminalStatus: ChainStreamStatus }
> = {
  PAUSED: { event: "StreamPaused", terminalStatus: "PAUSED" },
  RESUMED: { event: "StreamResumed", terminalStatus: "ACTIVE" },
  CANCELLED: { event: "StreamCancelled", terminalStatus: "CANCELLED" },
  COMPLETED: { event: "StreamCompleted", terminalStatus: "COMPLETED" },
};

export type StreamExecutionFailure =
  | "NO_STREAMING_CONTRACT_CONFIGURED"
  | "STREAM_NOT_MINED"
  | "STREAM_REVERTED"
  | "STREAM_NOT_CONFIRMED"
  | "STREAM_RPC_UNAVAILABLE"
  | "STREAM_CHAIN_MISMATCH"
  | "STREAM_WRONG_TARGET"
  | "STREAM_EVENT_MISSING"
  | "STREAM_SENDER_MISMATCH"
  | "STREAM_RECIPIENT_MISMATCH"
  | "STREAM_UNKNOWN_ON_CHAIN"
  | "STREAM_STATUS_MISMATCH"
  | "STREAM_RATE_IMMUTABLE";

export class StreamExecutionError extends Error {
  constructor(
    public readonly reason: StreamExecutionFailure,
    message: string,
    public readonly statusCode = 422,
  ) {
    super(message);
    this.name = "StreamExecutionError";
  }
}

export interface VerifiedStreamCreation {
  onChainStreamId: string;
  sender: string;
  recipient: string;
  token: string;
  totalAmount: string;
  ratePerSecond: string;
  startTime: Date;
  endTime: Date;
  cliffEndTime: Date | null;
  txHash: string;
  blockNumber: number;
  chainStatus: ChainStreamStatus;
}

export interface VerifiedStreamTransition {
  onChainStreamId: string;
  kind: StreamEventKind;
  /**
   * Only a RESUMED transition carries one. It is the contract's own figure for
   * how long the stream was paused, and it is accumulated rather than
   * recalculated so the API's balance cannot drift from what the contract will
   * pay.
   */
  pausedDurationSeconds: number | null;
  /** Set for CANCELLED: how the escrow was split. Raw contract units. */
  recipientAmount: string | null;
  senderRefund: string | null;
  txHash: string;
  blockNumber: number;
  at: Date;
  chainStatus: ChainStreamStatus;
  totalPausedSeconds: number;
}

export interface VerifiedWithdrawal {
  onChainStreamId: string;
  recipient: string;
  amount: string;
  /** The contract's running total, not an increment to add locally. */
  withdrawnTotal: string;
  txHash: string;
  blockNumber: number;
  at: Date;
}

export function resolveStreamingAddress(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.STREAMING_PAYMENTS_ADDRESS?.trim();
  if (!raw) return null;
  if (!/^0x[a-fA-F0-9]{40}$/u.test(raw) || /^0x0{40}$/iu.test(raw)) return null;
  return raw;
}

async function canonicalStreamTransaction(
  config: NoblePayChainConfiguration,
  txHash: string,
  env: NodeJS.ProcessEnv,
) {
  const contract = resolveStreamingAddress(env);
  if (!contract) {
    throw new StreamExecutionError(
      "NO_STREAMING_CONTRACT_CONFIGURED",
      "No StreamingPayments address is configured for this environment; streams cannot be verified",
      501,
    );
  }

  const provider = new JsonRpcProvider(config.rpcUrl);

  let canonical;
  try {
    canonical = await getCanonicalTransaction(
      provider,
      txHash,
      config.minimumConfirmations,
    );
  } catch (error) {
    if (!(error instanceof CanonicalTransactionError)) throw error;
    switch (error.reason) {
      case "NOT_MINED":
        throw new StreamExecutionError(
          "STREAM_NOT_MINED",
          "The stream transaction is not mined yet",
          409,
        );
      case "REVERTED":
        throw new StreamExecutionError(
          "STREAM_REVERTED",
          "The stream transaction reverted; nothing changed",
        );
      case "INSUFFICIENT_CONFIRMATIONS":
        throw new StreamExecutionError(
          "STREAM_NOT_CONFIRMED",
          `The stream transaction has not reached ${config.minimumConfirmations} confirmations`,
          409,
        );
      case "RPC_UNAVAILABLE":
        throw new StreamExecutionError(
          "STREAM_RPC_UNAVAILABLE",
          "Could not reach the configured RPC to verify the stream",
          503,
        );
      default:
        throw new StreamExecutionError(
          "STREAM_CHAIN_MISMATCH",
          "The stream transaction is not canonical on the configured network",
        );
    }
  }

  try {
    await assertCanonicalChainSnapshot(
      provider,
      config,
      canonical.receipt.blockNumber,
      canonical.receipt.blockHash,
    );
  } catch {
    throw new StreamExecutionError(
      "STREAM_CHAIN_MISMATCH",
      "The stream transaction is not on the operator-confirmed Aethelred network",
    );
  }

  if ((canonical.transaction.to ?? "").toLowerCase() !== contract.toLowerCase()) {
    throw new StreamExecutionError(
      "STREAM_WRONG_TARGET",
      "The transaction did not target the configured StreamingPayments contract",
    );
  }

  return { contract, canonical, provider };
}

function streamLog(
  receipt: {
    logs: readonly { address: string; topics: readonly string[]; data: string }[];
  },
  contract: string,
  eventName: string,
  streamId: string,
) {
  const topic = STREAM_INTERFACE.getEvent(eventName)?.topicHash;
  const wanted = streamId.toLowerCase();
  return receipt.logs.find(
    (entry) =>
      entry.address.toLowerCase() === contract.toLowerCase() &&
      entry.topics[0] === topic &&
      entry.topics[1]?.toLowerCase() === wanted,
  );
}

async function readStream(
  provider: { call: (tx: { to: string; data: string }) => Promise<string> },
  contract: string,
  streamId: string,
) {
  const raw = await provider.call({
    to: contract,
    data: STREAM_INTERFACE.encodeFunctionData("getStream", [streamId]),
  });
  const [row] = STREAM_INTERFACE.decodeFunctionResult("getStream", raw);
  if (String(row.sender) === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  return {
    sender: String(row.sender),
    recipient: String(row.recipient),
    withdrawnAmount: String(row.withdrawnAmount),
    totalPausedDuration: Number(row.totalPausedDuration),
    status: CHAIN_STREAM_STATUS[Number(row.status)] ?? "ACTIVE",
  };
}

/** Verify a stream was created on chain. */
export async function verifyStreamCreation(
  config: NoblePayChainConfiguration,
  input: {
    txHash: string;
    onChainStreamId: string;
    expectedSender: string;
    expectedRecipient: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedStreamCreation> {
  const { contract, canonical, provider } = await canonicalStreamTransaction(
    config,
    input.txHash,
    env,
  );

  const entry = streamLog(
    canonical.receipt,
    contract,
    "StreamCreated",
    input.onChainStreamId,
  );
  if (!entry) {
    throw new StreamExecutionError(
      "STREAM_EVENT_MISSING",
      "The transaction did not emit StreamCreated for this stream",
    );
  }

  const parsed = STREAM_INTERFACE.parseLog({
    topics: [...entry.topics],
    data: entry.data,
  });

  const sender = String(parsed?.args?.sender ?? "");
  if (sender.toLowerCase() !== input.expectedSender.toLowerCase()) {
    throw new StreamExecutionError(
      "STREAM_SENDER_MISMATCH",
      "The stream was created by a different account than the caller",
      403,
    );
  }

  // The recipient is who gets paid. A stream recorded against the wrong one
  // would send a payroll run to the wrong person on paper while the contract
  // pays someone else.
  const recipient = String(parsed?.args?.recipient ?? "");
  if (recipient.toLowerCase() !== input.expectedRecipient.toLowerCase()) {
    throw new StreamExecutionError(
      "STREAM_RECIPIENT_MISMATCH",
      "The stream pays a different recipient than the one recorded",
    );
  }

  const onChain = await readStream(provider, contract, input.onChainStreamId);
  if (!onChain) {
    throw new StreamExecutionError(
      "STREAM_UNKNOWN_ON_CHAIN",
      "The contract does not have a stream with this id",
    );
  }

  const cliff = Number(parsed?.args?.cliffEndTime ?? 0);

  return {
    onChainStreamId: input.onChainStreamId.toLowerCase(),
    sender,
    recipient,
    token: String(parsed?.args?.token ?? ""),
    totalAmount: String(parsed?.args?.totalAmount ?? "0"),
    ratePerSecond: String(parsed?.args?.ratePerSecond ?? "0"),
    startTime: new Date(Number(parsed?.args?.startTime ?? 0) * 1000),
    endTime: new Date(Number(parsed?.args?.endTime ?? 0) * 1000),
    cliffEndTime: cliff > 0 ? new Date(cliff * 1000) : null,
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    chainStatus: onChain.status,
  };
}

/**
 * Verify a pause, resume, cancellation or completion.
 *
 * `totalPausedSeconds` in the result is the contract's running total, not a
 * delta — the caller should store it rather than add to it, so a replayed or
 * out-of-order receipt cannot double-count a pause.
 */
export async function verifyStreamTransition(
  config: NoblePayChainConfiguration,
  input: {
    txHash: string;
    onChainStreamId: string;
    kind: StreamEventKind;
    expectedSender: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedStreamTransition> {
  const { contract, canonical, provider } = await canonicalStreamTransaction(
    config,
    input.txHash,
    env,
  );

  const spec = EVENT_FOR_KIND[input.kind];
  const entry = streamLog(
    canonical.receipt,
    contract,
    spec.event,
    input.onChainStreamId,
  );
  if (!entry) {
    throw new StreamExecutionError(
      "STREAM_EVENT_MISSING",
      `The transaction did not emit ${spec.event} for this stream`,
    );
  }

  const parsed = STREAM_INTERFACE.parseLog({
    topics: [...entry.topics],
    data: entry.data,
  });

  const onChain = await readStream(provider, contract, input.onChainStreamId);
  if (!onChain) {
    throw new StreamExecutionError(
      "STREAM_UNKNOWN_ON_CHAIN",
      "The contract does not have a stream with this id",
    );
  }

  // None of the transition events name an address, so ownership comes from the
  // stream itself.
  if (onChain.sender.toLowerCase() !== input.expectedSender.toLowerCase()) {
    throw new StreamExecutionError(
      "STREAM_SENDER_MISMATCH",
      "The stream belongs to a different account than the caller",
      403,
    );
  }

  if (onChain.status !== spec.terminalStatus) {
    throw new StreamExecutionError(
      "STREAM_STATUS_MISMATCH",
      `The contract reports this stream as ${onChain.status}, which does not match a ${input.kind} transition`,
    );
  }

  const pausedDuration = parsed?.args?.pausedDuration;

  return {
    onChainStreamId: input.onChainStreamId.toLowerCase(),
    kind: input.kind,
    pausedDurationSeconds:
      pausedDuration === undefined || pausedDuration === null
        ? null
        : Number(pausedDuration),
    recipientAmount:
      parsed?.args?.recipientAmount === undefined
        ? null
        : String(parsed.args.recipientAmount),
    senderRefund:
      parsed?.args?.senderRefund === undefined
        ? null
        : String(parsed.args.senderRefund),
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    at: new Date(Number(canonical.block.timestamp) * 1000),
    chainStatus: onChain.status,
    // Read from the contract rather than derived from the event, so this is
    // correct even if an earlier transition was never recorded here.
    totalPausedSeconds: onChain.totalPausedDuration,
  };
}

/**
 * Verify a withdrawal against a stream.
 *
 * Returns the contract's running `withdrawnAmount` alongside the event's
 * increment. The record should store the running total: `withdrawn` feeds
 * `withdrawable = streamed - withdrawn`, and accumulating increments locally
 * would drift from the contract the first time a receipt is replayed or missed.
 */
export async function verifyWithdrawal(
  config: NoblePayChainConfiguration,
  input: {
    txHash: string;
    onChainStreamId: string;
    expectedRecipient: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedWithdrawal> {
  const { contract, canonical, provider } = await canonicalStreamTransaction(
    config,
    input.txHash,
    env,
  );

  const entry = streamLog(
    canonical.receipt,
    contract,
    "Withdrawal",
    input.onChainStreamId,
  );
  if (!entry) {
    throw new StreamExecutionError(
      "STREAM_EVENT_MISSING",
      "The transaction did not emit Withdrawal for this stream",
    );
  }

  const parsed = STREAM_INTERFACE.parseLog({
    topics: [...entry.topics],
    data: entry.data,
  });

  const recipient = String(parsed?.args?.recipient ?? "");
  if (recipient.toLowerCase() !== input.expectedRecipient.toLowerCase()) {
    throw new StreamExecutionError(
      "STREAM_RECIPIENT_MISMATCH",
      "The withdrawal paid a different account than the stream recipient",
      403,
    );
  }

  const onChain = await readStream(provider, contract, input.onChainStreamId);
  if (!onChain) {
    throw new StreamExecutionError(
      "STREAM_UNKNOWN_ON_CHAIN",
      "The contract does not have a stream with this id",
    );
  }

  return {
    onChainStreamId: input.onChainStreamId.toLowerCase(),
    recipient,
    amount: String(parsed?.args?.amount ?? "0"),
    withdrawnTotal: onChain.withdrawnAmount,
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    at: new Date(Number(canonical.block.timestamp) * 1000),
  };
}
