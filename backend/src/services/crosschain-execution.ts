/**
 * Verifies that a cross-chain transfer was initiated or recovered on chain.
 *
 * Same shape as treasury-execution and liquidity-execution: the API holds no
 * key and submits nothing. The caller moves funds from their own wallet, then
 * reports the transaction, and the record is written only if the chain
 * corroborates it.
 *
 * WHAT THIS DOES AND DOES NOT PROVE
 *
 * Both operations verified here happen on the SOURCE chain — Aethelred, the
 * network whose anchor the operator has confirmed. `TransferInitiated` is the
 * escrow of funds; `TransferRecovered` is the refund of that escrow back to the
 * sender. Neither is a destination-chain event, so both can be verified at full
 * strength against the pinned network.
 *
 * Completion is a different matter and is deliberately not verified here. The
 * destination hash a transfer eventually carries comes from `TransferRelayed`,
 * where a relay asserts it — an assertion recorded on the source chain, not a
 * transaction this system has seen on the destination chain. Confirming it
 * would need a per-chain trust anchor, and `CROSSCHAIN_CHAINS_JSON` has no
 * field for one: it carries an rpcUrl, a chainId and a finality depth, all of
 * which an operator can misconfigure and none of which is an immutable
 * reference point. Marking a transfer COMPLETED therefore remains outside what
 * this module will attest to.
 */

import { Interface, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";

import {
  assertCanonicalChainSnapshot,
  CanonicalTransactionError,
  getCanonicalTransaction,
} from "../lib/canonical-chain-transaction";
import type { NoblePayChainConfiguration } from "../lib/production-config";

export const ROUTER_INTERFACE = new Interface([
  "event TransferInitiated(bytes32 indexed transferId,address indexed sender,uint256 indexed destinationChainId,address sourceToken,uint256 amount,uint256 fee,bytes32 recipientHash)",
  "event TransferRecovered(bytes32 indexed transferId,address indexed sender,uint256 refundAmount,uint256 recoveredAt)",
  "function getTransfer(bytes32 _transferId) view returns (tuple(address sender,bytes32 recipientHash,address sourceToken,uint256 amount,uint256 fee,uint256 destinationChainId,bytes32 destinationTxHash,uint8 status,address assignedRelay,uint256 initiatedAt,uint256 completedAt,uint256 deadline,bytes relayProof,uint256 protocolFee))",
]);

/**
 * The contract's status enum, which is NOT the database's. The contract has six
 * states and the database seven (it adds STUCK and spells two of them in the
 * progressive tense). They are reported separately rather than coerced into one
 * another, for the same reason the FX position statuses are: a silent mapping
 * between two enums that merely look alike is how a UI ends up confidently
 * displaying a state the chain never reported.
 */
export const CHAIN_TRANSFER_STATUS = [
  "INITIATED",
  "RELAYED",
  "CONFIRMED",
  "COMPLETED",
  "FAILED",
  "RECOVERED",
] as const;

export type ChainTransferStatus = (typeof CHAIN_TRANSFER_STATUS)[number];

export type TransferVerificationFailure =
  | "NO_ROUTER_CONFIGURED"
  | "TRANSFER_NOT_MINED"
  | "TRANSFER_REVERTED"
  | "TRANSFER_NOT_CONFIRMED"
  | "TRANSFER_RPC_UNAVAILABLE"
  | "TRANSFER_CHAIN_MISMATCH"
  | "TRANSFER_WRONG_TARGET"
  | "TRANSFER_EVENT_MISSING"
  | "TRANSFER_SENDER_MISMATCH"
  | "TRANSFER_DESTINATION_MISMATCH"
  | "TRANSFER_RECIPIENT_MISMATCH"
  | "TRANSFER_UNKNOWN_ON_CHAIN"
  | "RECOVERY_STATUS_NOT_RECOVERED";

export class TransferVerificationError extends Error {
  constructor(
    public readonly reason: TransferVerificationFailure,
    message: string,
    public readonly statusCode = 422,
  ) {
    super(message);
    this.name = "TransferVerificationError";
  }
}

/**
 * The recipient commitment scheme.
 *
 * `CrossChainRouter` accepts `recipientHash` as an opaque parameter and never
 * derives or checks it (see docs/audit/NP-BRIDGE-01). Something has to define
 * the encoding, and until the contract does, this is it.
 *
 * UTF-8 over the lowercased string rather than abi.encodePacked(address),
 * because a destination may be a Cosmos bech32 address or another non-EVM
 * identifier that does not fit in 20 bytes — a cross-chain router cannot assume
 * its destinations are EVM. Any client calling initiateTransfer directly must
 * use this same encoding.
 */
export function recipientCommitment(recipient: string): string {
  return keccak256(toUtf8Bytes(recipient.trim().toLowerCase()));
}

export interface VerifiedTransferInitiation {
  onChainTransferId: string;
  sender: string;
  sourceToken: string;
  /**
   * Raw base units as emitted. Deliberately NOT compared against the amount the
   * caller claimed: that comparison needs the token's decimals, and doing it
   * without them is precisely the confusion behind NP-TREASURY-01, where a
   * 1e8-decimal amount was measured against a 1e6-decimal threshold. The chain
   * is authoritative here, so its figure is returned for recording rather than
   * used to grade the caller's.
   */
  amount: string;
  fee: string;
  destinationChainId: number;
  recipientHash: string;
  txHash: string;
  blockNumber: number;
  initiatedAt: Date;
  chainStatus: ChainTransferStatus;
}

export interface VerifiedTransferRecovery {
  onChainTransferId: string;
  sender: string;
  refundAmount: string;
  txHash: string;
  blockNumber: number;
  recoveredAt: Date;
}

/**
 * Optional by design, like the treasury and pool addresses: the router is not
 * one of the core contracts, so a deployment without one is valid rather than
 * broken.
 */
export function resolveRouterAddress(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.CROSSCHAIN_ROUTER_ADDRESS?.trim();
  if (!raw) return null;
  if (!/^0x[a-fA-F0-9]{40}$/u.test(raw) || /^0x0{40}$/iu.test(raw)) return null;
  return raw;
}

/**
 * Shared preamble: resolve the router, confirm the transaction is canonical on
 * the pinned network, and confirm it targeted the router.
 */
async function canonicalRouterTransaction(
  config: NoblePayChainConfiguration,
  txHash: string,
  env: NodeJS.ProcessEnv,
) {
  const router = resolveRouterAddress(env);
  if (!router) {
    throw new TransferVerificationError(
      "NO_ROUTER_CONFIGURED",
      "No CrossChainRouter address is configured for this environment; transfers cannot be verified",
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
        throw new TransferVerificationError(
          "TRANSFER_NOT_MINED",
          "The transfer transaction is not mined yet",
          409,
        );
      case "REVERTED":
        throw new TransferVerificationError(
          "TRANSFER_REVERTED",
          "The transfer transaction reverted; no funds were escrowed",
        );
      case "INSUFFICIENT_CONFIRMATIONS":
        throw new TransferVerificationError(
          "TRANSFER_NOT_CONFIRMED",
          `The transfer transaction has not reached ${config.minimumConfirmations} confirmations`,
          409,
        );
      case "RPC_UNAVAILABLE":
        throw new TransferVerificationError(
          "TRANSFER_RPC_UNAVAILABLE",
          "Could not reach the configured RPC to verify the transfer",
          503,
        );
      default:
        throw new TransferVerificationError(
          "TRANSFER_CHAIN_MISMATCH",
          "The transfer transaction is not canonical on the configured network",
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
    throw new TransferVerificationError(
      "TRANSFER_CHAIN_MISMATCH",
      "The transfer transaction is not on the operator-confirmed Aethelred network",
    );
  }

  if ((canonical.transaction.to ?? "").toLowerCase() !== router.toLowerCase()) {
    throw new TransferVerificationError(
      "TRANSFER_WRONG_TARGET",
      "The transaction did not target the configured CrossChainRouter",
    );
  }

  return { router, canonical, provider };
}

/** One event of the given name emitted by the router for this transfer id. */
function routerLog(
  receipt: {
    logs: readonly { address: string; topics: readonly string[]; data: string }[];
  },
  router: string,
  eventName: string,
  transferId: string,
) {
  const topic = ROUTER_INTERFACE.getEvent(eventName)?.topicHash;
  const wanted = transferId.toLowerCase();
  return receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === router.toLowerCase() &&
      log.topics[0] === topic &&
      log.topics[1]?.toLowerCase() === wanted,
  );
}

/** The contract's current view of a transfer, or null if it has none. */
async function readChainTransfer(
  provider: { call: (tx: { to: string; data: string }) => Promise<string> },
  router: string,
  transferId: string,
) {
  const raw = await provider.call({
    to: router,
    data: ROUTER_INTERFACE.encodeFunctionData("getTransfer", [transferId]),
  });
  const [row] = ROUTER_INTERFACE.decodeFunctionResult("getTransfer", raw);
  // An unknown id decodes to a zeroed struct rather than reverting, so the
  // sender is what distinguishes "no such transfer" from a real one.
  if (String(row.sender) === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  return {
    sender: String(row.sender),
    status: CHAIN_TRANSFER_STATUS[Number(row.status)] ?? "INITIATED",
  };
}

/**
 * Verify that a transfer was initiated on the source chain.
 *
 * `expectedSender` and `expectedRecipient` are checked against the event rather
 * than taken on trust, so one account cannot report another's transfer as its
 * own, and a caller cannot escrow funds against one recipient commitment while
 * recording a different recipient in the database.
 */
export async function verifyTransferInitiation(
  config: NoblePayChainConfiguration,
  input: {
    txHash: string;
    onChainTransferId: string;
    expectedSender: string;
    expectedRecipient: string;
    expectedDestinationChainId: number;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedTransferInitiation> {
  const { router, canonical, provider } = await canonicalRouterTransaction(
    config,
    input.txHash,
    env,
  );

  const log = routerLog(
    canonical.receipt,
    router,
    "TransferInitiated",
    input.onChainTransferId,
  );
  if (!log) {
    throw new TransferVerificationError(
      "TRANSFER_EVENT_MISSING",
      "The transaction did not emit TransferInitiated for this transfer",
    );
  }

  const parsed = ROUTER_INTERFACE.parseLog({
    topics: [...log.topics],
    data: log.data,
  });

  const sender = String(parsed?.args?.sender ?? "");
  if (sender.toLowerCase() !== input.expectedSender.toLowerCase()) {
    throw new TransferVerificationError(
      "TRANSFER_SENDER_MISMATCH",
      "The transfer was initiated by a different account than the caller",
      403,
    );
  }

  const destinationChainId = Number(parsed?.args?.destinationChainId ?? 0);
  if (destinationChainId !== input.expectedDestinationChainId) {
    throw new TransferVerificationError(
      "TRANSFER_DESTINATION_MISMATCH",
      "The transfer was escrowed for a different destination chain than the one recorded",
    );
  }

  // The NP-BRIDGE-01 check. The contract will not do this, so the API does.
  const recipientHash = String(parsed?.args?.recipientHash ?? "");
  if (
    recipientHash.toLowerCase() !==
    recipientCommitment(input.expectedRecipient).toLowerCase()
  ) {
    throw new TransferVerificationError(
      "TRANSFER_RECIPIENT_MISMATCH",
      "The on-chain recipient commitment does not match the recipient being recorded",
    );
  }

  const onChain = await readChainTransfer(
    provider,
    router,
    input.onChainTransferId,
  );
  if (!onChain) {
    throw new TransferVerificationError(
      "TRANSFER_UNKNOWN_ON_CHAIN",
      "The router does not have a transfer with this id",
    );
  }

  // Note what is NOT asserted: that the status is still INITIATED. Verification
  // can legitimately run after a relay has already advanced the transfer, and
  // demanding the initial state would reject exactly the transfers that are
  // progressing normally. The status is reported instead, so a caller can see
  // how far along the chain says it is.
  return {
    onChainTransferId: input.onChainTransferId.toLowerCase(),
    sender,
    sourceToken: String(parsed?.args?.sourceToken ?? ""),
    amount: String(parsed?.args?.amount ?? "0"),
    fee: String(parsed?.args?.fee ?? "0"),
    destinationChainId,
    recipientHash: recipientHash.toLowerCase(),
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    initiatedAt: new Date(Number(canonical.block.timestamp) * 1000),
    chainStatus: onChain.status,
  };
}

/**
 * Verify that a transfer's escrow was refunded on the source chain.
 *
 * Both the event and the contract's current status are required. The event is
 * the historical fact; the status is the contract agreeing that the transfer is
 * settled as RECOVERED and cannot be recovered again. Recording a refund on the
 * strength of the event alone would leave the record and the contract free to
 * disagree.
 */
export async function verifyTransferRecovery(
  config: NoblePayChainConfiguration,
  input: {
    txHash: string;
    onChainTransferId: string;
    expectedSender: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedTransferRecovery> {
  const { router, canonical, provider } = await canonicalRouterTransaction(
    config,
    input.txHash,
    env,
  );

  const log = routerLog(
    canonical.receipt,
    router,
    "TransferRecovered",
    input.onChainTransferId,
  );
  if (!log) {
    throw new TransferVerificationError(
      "TRANSFER_EVENT_MISSING",
      "The transaction did not emit TransferRecovered for this transfer",
    );
  }

  const parsed = ROUTER_INTERFACE.parseLog({
    topics: [...log.topics],
    data: log.data,
  });

  // The refund always goes to the original sender, even when an admin submits
  // the recovery, so this binds the refund to the account that owns the record
  // rather than to whoever sent the transaction.
  const sender = String(parsed?.args?.sender ?? "");
  if (sender.toLowerCase() !== input.expectedSender.toLowerCase()) {
    throw new TransferVerificationError(
      "TRANSFER_SENDER_MISMATCH",
      "The recovered funds were returned to a different account than the transfer sender",
      403,
    );
  }

  const onChain = await readChainTransfer(
    provider,
    router,
    input.onChainTransferId,
  );
  if (!onChain) {
    throw new TransferVerificationError(
      "TRANSFER_UNKNOWN_ON_CHAIN",
      "The router does not have a transfer with this id",
    );
  }
  if (onChain.status !== "RECOVERED") {
    throw new TransferVerificationError(
      "RECOVERY_STATUS_NOT_RECOVERED",
      "The router does not report this transfer as recovered",
    );
  }

  return {
    onChainTransferId: input.onChainTransferId.toLowerCase(),
    sender,
    refundAmount: String(parsed?.args?.refundAmount ?? "0"),
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    recoveredAt: new Date(Number(canonical.block.timestamp) * 1000),
  };
}
