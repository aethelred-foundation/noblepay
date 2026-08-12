/**
 * Verifies that a treasury proposal was executed on chain.
 *
 * The backend does not execute anything. It holds no treasury signing key and
 * should not: execution is authorised by SIGNER_ROLE holders and submitted from
 * their own wallets. What this module does is check, after the fact, that a
 * transaction someone claims settled a proposal actually did — and refuses to
 * record the claim otherwise.
 *
 * That asymmetry is the point. A caller can assert anything; the only thing
 * worth writing to the ledger is what the chain will corroborate.
 *
 * Verification reuses lib/canonical-chain-transaction, the same layer that
 * guards compliance submissions, rather than introducing a second notion of
 * "confirmed". It notably re-reads the receipt after the confirmation depth,
 * because a receipt observed once may have been orphaned while the head moved.
 *
 * Six things must hold. Each has its own failure code, because "we could not
 * verify this" and "this is not what you said it was" call for different
 * responses from whoever is looking at the screen.
 */

import { Interface, JsonRpcProvider } from "ethers";

import {
  assertCanonicalChainSnapshot,
  CanonicalTransactionError,
  getCanonicalTransaction,
} from "../lib/canonical-chain-transaction";
import type { NoblePayChainConfiguration } from "../lib/production-config";
import { resolveTreasuryAddress } from "./treasury-chain";

const EXECUTION_INTERFACE = new Interface([
  "function executeProposal(bytes32 _proposalId)",
  "function getProposal(bytes32 _proposalId) view returns (tuple(bytes32 proposalId,address proposer,address recipient,address token,uint256 amount,uint8 category,string description,uint8 tier,uint8 status,uint256 approvalCount,uint256 rejectionCount,uint256 requiredApprovals,uint256 createdAt,uint256 timelockExpiry,uint256 expiresAt,bool isEmergency,bytes32 budgetId))",
  "event ProposalExecuted(bytes32 indexed proposalId,address indexed executor,uint256 amount,uint256 timestamp)",
]);

/** MultiSigTreasury.ProposalStatus.EXECUTED */
const STATUS_EXECUTED = 2;

export type TreasuryExecutionFailure =
  | "NO_TREASURY_CONFIGURED"
  | "EXECUTION_NOT_MINED"
  | "EXECUTION_REVERTED"
  | "EXECUTION_NOT_CONFIRMED"
  | "EXECUTION_RPC_UNAVAILABLE"
  | "EXECUTION_CHAIN_MISMATCH"
  | "EXECUTION_WRONG_TARGET"
  | "EXECUTION_CALLDATA_MISMATCH"
  | "EXECUTION_EVENT_MISSING"
  | "EXECUTION_STATUS_NOT_EXECUTED";

export class TreasuryExecutionError extends Error {
  constructor(
    public readonly reason: TreasuryExecutionFailure,
    message: string,
    public readonly statusCode = 422,
  ) {
    super(message);
    this.name = "TreasuryExecutionError";
  }
}

export interface VerifiedTreasuryExecution {
  onChainProposalId: string;
  txHash: string;
  executor: string;
  blockNumber: number;
  blockHash: string;
  confirmations: number;
  /** Amount as reported by the ProposalExecuted event, in base units. */
  amount: string;
  executedAt: Date;
}

export interface VerifyExecutionInput {
  /** The transaction the caller says executed the proposal. */
  txHash: string;
  /** The MultiSigTreasury proposal id the caller says it executed. */
  onChainProposalId: string;
}

/**
 * Verify an execution transaction end to end.
 *
 * Returns the details worth recording, or throws with a reason naming which
 * check failed. Nothing here mutates state — the caller decides what to
 * persist once verification succeeds.
 */
export async function verifyTreasuryExecution(
  config: NoblePayChainConfiguration,
  input: VerifyExecutionInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedTreasuryExecution> {
  const treasury = resolveTreasuryAddress(env);
  if (!treasury) {
    throw new TreasuryExecutionError(
      "NO_TREASURY_CONFIGURED",
      "No MultiSigTreasury address is configured for this environment; on-chain execution cannot be verified",
      501,
    );
  }

  const provider = new JsonRpcProvider(config.rpcUrl);

  // 1. The transaction must be canonical: mined, successful, past the
  //    confirmation depth, and still canonical when re-read.
  let canonical;
  try {
    canonical = await getCanonicalTransaction(
      provider,
      input.txHash,
      config.minimumConfirmations,
    );
  } catch (error) {
    if (!(error instanceof CanonicalTransactionError)) throw error;
    switch (error.reason) {
      case "NOT_MINED":
        throw new TreasuryExecutionError(
          "EXECUTION_NOT_MINED",
          "The execution transaction is not mined yet",
          409,
        );
      case "REVERTED":
        throw new TreasuryExecutionError(
          "EXECUTION_REVERTED",
          "The execution transaction reverted; the proposal was not executed",
        );
      case "INSUFFICIENT_CONFIRMATIONS":
        throw new TreasuryExecutionError(
          "EXECUTION_NOT_CONFIRMED",
          `The execution transaction has not reached ${config.minimumConfirmations} confirmations`,
          409,
        );
      case "RPC_UNAVAILABLE":
        throw new TreasuryExecutionError(
          "EXECUTION_RPC_UNAVAILABLE",
          "Could not reach the configured RPC to verify the execution",
          503,
        );
      default:
        throw new TreasuryExecutionError(
          "EXECUTION_CHAIN_MISMATCH",
          "The execution transaction is not canonical on the configured network",
        );
    }
  }

  const { receipt, transaction } = canonical;

  // 2. The block it landed in must belong to the network this deployment is
  //    pinned to, so a receipt from a fork or a look-alike chain is rejected.
  try {
    await assertCanonicalChainSnapshot(
      provider,
      config,
      receipt.blockNumber,
      receipt.blockHash,
    );
  } catch {
    throw new TreasuryExecutionError(
      "EXECUTION_CHAIN_MISMATCH",
      "The execution transaction is not on the operator-confirmed Aethelred network",
    );
  }

  // 3. It must have targeted the treasury. A successful transaction to some
  //    other contract proves nothing about this proposal.
  if ((transaction.to ?? "").toLowerCase() !== treasury.toLowerCase()) {
    throw new TreasuryExecutionError(
      "EXECUTION_WRONG_TARGET",
      "The transaction did not target the configured MultiSigTreasury",
    );
  }

  // 4. Its calldata must be executeProposal for the proposal claimed. Decoding
  //    rather than trusting the caller means the claim is checked against what
  //    was actually signed, not merely restated.
  let calldataProposalId: string;
  try {
    const decoded = EXECUTION_INTERFACE.decodeFunctionData(
      "executeProposal",
      transaction.data,
    );
    calldataProposalId = String(decoded[0]).toLowerCase();
  } catch {
    throw new TreasuryExecutionError(
      "EXECUTION_CALLDATA_MISMATCH",
      "The transaction did not call executeProposal on the treasury",
    );
  }
  if (calldataProposalId !== input.onChainProposalId.toLowerCase()) {
    throw new TreasuryExecutionError(
      "EXECUTION_CALLDATA_MISMATCH",
      "The transaction executed a different proposal than the one claimed",
    );
  }

  // 5. ProposalExecuted must be present for that id, emitted by the treasury.
  //    Calldata shows intent; the event shows the contract agreed.
  const executedTopic = EXECUTION_INTERFACE.getEvent("ProposalExecuted")
    ?.topicHash;
  const log = receipt.logs.find(
    (entry) =>
      entry.address.toLowerCase() === treasury.toLowerCase() &&
      entry.topics[0] === executedTopic &&
      entry.topics[1]?.toLowerCase() === calldataProposalId,
  );
  if (!log) {
    throw new TreasuryExecutionError(
      "EXECUTION_EVENT_MISSING",
      "The transaction did not emit ProposalExecuted for this proposal",
    );
  }

  const parsed = EXECUTION_INTERFACE.parseLog({
    topics: [...log.topics],
    data: log.data,
  });
  const executor = String(parsed?.args?.executor ?? transaction.from);
  const amount = String(parsed?.args?.amount ?? "0");

  // 6. Finally, current contract state must agree. The event is historical; a
  //    status read now is the contract's own answer to "is this executed?".
  //    Both are checked because either alone can mislead — an event without a
  //    matching status would mean the read is pointed somewhere unexpected.
  const statusRaw = await provider.call({
    to: treasury,
    data: EXECUTION_INTERFACE.encodeFunctionData("getProposal", [
      input.onChainProposalId,
    ]),
  });
  const [proposal] = EXECUTION_INTERFACE.decodeFunctionResult(
    "getProposal",
    statusRaw,
  ) as unknown as [{ status: bigint }];
  if (Number(proposal.status) !== STATUS_EXECUTED) {
    throw new TreasuryExecutionError(
      "EXECUTION_STATUS_NOT_EXECUTED",
      "The treasury does not report this proposal as executed",
    );
  }

  return {
    onChainProposalId: input.onChainProposalId.toLowerCase(),
    txHash: input.txHash.toLowerCase(),
    executor,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    confirmations: canonical.confirmations,
    amount,
    executedAt: new Date(Number(canonical.block.timestamp) * 1000),
  };
}
