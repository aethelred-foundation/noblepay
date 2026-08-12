/**
 * Verifies that a liquidity settlement happened on chain.
 *
 * Same shape as treasury-execution: the API holds no key and submits nothing.
 * A provider adds or removes liquidity from their own wallet, then reports the
 * transaction, and the record is written only if the chain corroborates it.
 *
 * Flash liquidity is verified differently, and the difference is the point. A
 * flash loan is only safe because borrow and repayment occur in ONE
 * transaction; a borrow that settles without its repayment is not a slow flash
 * loan, it is theft. So the flash check requires both FlashLoanInitiated and
 * FlashLoanRepaid in the same receipt, for the same loan id. Two transactions,
 * each individually canonical, do not satisfy it.
 */

import { Interface, JsonRpcProvider } from "ethers";

import {
  assertCanonicalChainSnapshot,
  CanonicalTransactionError,
  getCanonicalTransaction,
} from "../lib/canonical-chain-transaction";
import type { NoblePayChainConfiguration } from "../lib/production-config";

export const LIQUIDITY_INTERFACE = new Interface([
  "event LiquidityAdded(bytes32 indexed positionId,bytes32 indexed poolId,address indexed provider,uint256 amountToken0,uint256 amountToken1,int24 tickLower,int24 tickUpper)",
  "event LiquidityRemoved(bytes32 indexed positionId,bytes32 indexed poolId,address indexed provider,uint256 amountToken0,uint256 amountToken1)",
  "event FlashLoanInitiated(bytes32 indexed flashLoanId,bytes32 indexed poolId,address indexed borrower,address token,uint256 amount,uint256 fee)",
  "event FlashLoanRepaid(bytes32 indexed flashLoanId,address indexed borrower)",
]);

export type LiquiditySettlementFailure =
  | "NO_POOL_CONFIGURED"
  | "SETTLEMENT_NOT_MINED"
  | "SETTLEMENT_REVERTED"
  | "SETTLEMENT_NOT_CONFIRMED"
  | "SETTLEMENT_RPC_UNAVAILABLE"
  | "SETTLEMENT_CHAIN_MISMATCH"
  | "SETTLEMENT_WRONG_TARGET"
  | "SETTLEMENT_EVENT_MISSING"
  | "SETTLEMENT_PROVIDER_MISMATCH"
  | "FLASH_LOAN_NOT_REPAID";

export class LiquiditySettlementError extends Error {
  constructor(
    public readonly reason: LiquiditySettlementFailure,
    message: string,
    public readonly statusCode = 422,
  ) {
    super(message);
    this.name = "LiquiditySettlementError";
  }
}

export interface VerifiedLiquiditySettlement {
  onChainPositionId: string;
  poolId: string;
  provider: string;
  txHash: string;
  blockNumber: number;
  amountToken0: string;
  amountToken1: string;
  settledAt: Date;
}

export interface VerifiedFlashLoan {
  flashLoanId: string;
  poolId: string;
  borrower: string;
  token: string;
  amount: string;
  fee: string;
  txHash: string;
  blockNumber: number;
  settledAt: Date;
}

/**
 * Optional by design, like the treasury address: the pool is not one of the
 * core contracts, so a deployment without one is valid rather than broken.
 */
export function resolveLiquidityPoolAddress(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.LIQUIDITY_POOL_ADDRESS?.trim();
  if (!raw) return null;
  if (!/^0x[a-fA-F0-9]{40}$/u.test(raw) || /^0x0{40}$/iu.test(raw)) return null;
  return raw;
}

/**
 * Shared preamble: resolve the pool, confirm the transaction is canonical on
 * the pinned network, and confirm it targeted the pool. Everything after this
 * differs per settlement kind.
 */
async function canonicalPoolTransaction(
  config: NoblePayChainConfiguration,
  txHash: string,
  env: NodeJS.ProcessEnv,
) {
  const pool = resolveLiquidityPoolAddress(env);
  if (!pool) {
    throw new LiquiditySettlementError(
      "NO_POOL_CONFIGURED",
      "No LiquidityPool address is configured for this environment; settlements cannot be verified",
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
        throw new LiquiditySettlementError(
          "SETTLEMENT_NOT_MINED",
          "The settlement transaction is not mined yet",
          409,
        );
      case "REVERTED":
        throw new LiquiditySettlementError(
          "SETTLEMENT_REVERTED",
          "The settlement transaction reverted; no liquidity moved",
        );
      case "INSUFFICIENT_CONFIRMATIONS":
        throw new LiquiditySettlementError(
          "SETTLEMENT_NOT_CONFIRMED",
          `The settlement transaction has not reached ${config.minimumConfirmations} confirmations`,
          409,
        );
      case "RPC_UNAVAILABLE":
        throw new LiquiditySettlementError(
          "SETTLEMENT_RPC_UNAVAILABLE",
          "Could not reach the configured RPC to verify the settlement",
          503,
        );
      default:
        throw new LiquiditySettlementError(
          "SETTLEMENT_CHAIN_MISMATCH",
          "The settlement transaction is not canonical on the configured network",
        );
    }
  }

  const { receipt, transaction } = canonical;

  try {
    await assertCanonicalChainSnapshot(
      provider,
      config,
      receipt.blockNumber,
      receipt.blockHash,
    );
  } catch {
    throw new LiquiditySettlementError(
      "SETTLEMENT_CHAIN_MISMATCH",
      "The settlement transaction is not on the operator-confirmed Aethelred network",
    );
  }

  if ((transaction.to ?? "").toLowerCase() !== pool.toLowerCase()) {
    throw new LiquiditySettlementError(
      "SETTLEMENT_WRONG_TARGET",
      "The transaction did not target the configured LiquidityPool",
    );
  }

  return { pool, canonical };
}

/** Logs emitted by the pool matching one event name. */
function poolLogs(
  receipt: { logs: readonly { address: string; topics: readonly string[]; data: string }[] },
  pool: string,
  eventName: string,
) {
  const topic = LIQUIDITY_INTERFACE.getEvent(eventName)?.topicHash;
  return receipt.logs.filter(
    (log) =>
      log.address.toLowerCase() === pool.toLowerCase() && log.topics[0] === topic,
  );
}

/**
 * Verify a LiquidityAdded or LiquidityRemoved settlement.
 *
 * `expectedProvider` is checked against the event rather than taken on trust,
 * so one account cannot report another's settlement as its own and attach the
 * resulting position to its own records.
 */
export async function verifyLiquiditySettlement(
  config: NoblePayChainConfiguration,
  input: {
    txHash: string;
    onChainPositionId: string;
    kind: "ADD" | "REMOVE";
    expectedProvider: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedLiquiditySettlement> {
  const { pool, canonical } = await canonicalPoolTransaction(
    config,
    input.txHash,
    env,
  );
  const eventName = input.kind === "ADD" ? "LiquidityAdded" : "LiquidityRemoved";
  const wanted = input.onChainPositionId.toLowerCase();

  const log = poolLogs(canonical.receipt, pool, eventName).find(
    (entry) => entry.topics[1]?.toLowerCase() === wanted,
  );
  if (!log) {
    throw new LiquiditySettlementError(
      "SETTLEMENT_EVENT_MISSING",
      `The transaction did not emit ${eventName} for this position`,
    );
  }

  const parsed = LIQUIDITY_INTERFACE.parseLog({
    topics: [...log.topics],
    data: log.data,
  });
  const eventProvider = String(parsed?.args?.provider ?? "");
  if (eventProvider.toLowerCase() !== input.expectedProvider.toLowerCase()) {
    throw new LiquiditySettlementError(
      "SETTLEMENT_PROVIDER_MISMATCH",
      "The settlement was made by a different provider than the caller",
      403,
    );
  }

  return {
    onChainPositionId: wanted,
    poolId: String(parsed?.args?.poolId ?? ""),
    provider: eventProvider,
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    amountToken0: String(parsed?.args?.amountToken0 ?? "0"),
    amountToken1: String(parsed?.args?.amountToken1 ?? "0"),
    settledAt: new Date(Number(canonical.block.timestamp) * 1000),
  };
}

/**
 * Verify a flash loan was both taken and repaid in one transaction.
 *
 * The atomicity requirement is what makes this different from every other
 * settlement here. FlashLoanInitiated alone means value left the pool;
 * FlashLoanRepaid in a LATER transaction would mean it left unsecured in
 * between, which the contract is designed to make impossible. Requiring both
 * in one receipt, keyed by the same loan id, is the direct evidence that the
 * invariant held — and it is cheap to check, which is why there is no excuse
 * for recording a flash loan without it.
 */
export async function verifyFlashLoan(
  config: NoblePayChainConfiguration,
  input: { txHash: string; flashLoanId: string; expectedBorrower: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedFlashLoan> {
  const { pool, canonical } = await canonicalPoolTransaction(
    config,
    input.txHash,
    env,
  );
  const wanted = input.flashLoanId.toLowerCase();

  const initiated = poolLogs(canonical.receipt, pool, "FlashLoanInitiated").find(
    (entry) => entry.topics[1]?.toLowerCase() === wanted,
  );
  if (!initiated) {
    throw new LiquiditySettlementError(
      "SETTLEMENT_EVENT_MISSING",
      "The transaction did not emit FlashLoanInitiated for this loan",
    );
  }

  const repaid = poolLogs(canonical.receipt, pool, "FlashLoanRepaid").find(
    (entry) => entry.topics[1]?.toLowerCase() === wanted,
  );
  if (!repaid) {
    throw new LiquiditySettlementError(
      "FLASH_LOAN_NOT_REPAID",
      "The transaction initiated a flash loan without repaying it in the same transaction",
    );
  }

  const parsed = LIQUIDITY_INTERFACE.parseLog({
    topics: [...initiated.topics],
    data: initiated.data,
  });
  const borrower = String(parsed?.args?.borrower ?? "");
  if (borrower.toLowerCase() !== input.expectedBorrower.toLowerCase()) {
    throw new LiquiditySettlementError(
      "SETTLEMENT_PROVIDER_MISMATCH",
      "The flash loan was taken by a different borrower than the caller",
      403,
    );
  }

  return {
    flashLoanId: wanted,
    poolId: String(parsed?.args?.poolId ?? ""),
    borrower,
    token: String(parsed?.args?.token ?? ""),
    amount: String(parsed?.args?.amount ?? "0"),
    fee: String(parsed?.args?.fee ?? "0"),
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    settledAt: new Date(Number(canonical.block.timestamp) * 1000),
  };
}
