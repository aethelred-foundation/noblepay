/**
 * Verifies that an FX hedge was opened or closed on chain.
 *
 * Same shape as the treasury, liquidity and cross-chain verifiers: the API
 * holds no key and submits nothing. The hedger acts from their own wallet,
 * reports the transaction, and the record is written only if the chain
 * corroborates it.
 *
 * TWO THINGS MAKE THIS ONE DIFFERENT
 *
 * 1. Closing is not one event. A position can leave ACTIVE five ways —
 *    settled, exercised, expired, liquidated, or emergency-unwound — and they
 *    are not interchangeable. A liquidation is a margin failure with collateral
 *    seized; recording it as an ordinary close destroys the fact most likely to
 *    be asked about later. So the closing event is identified and reported, not
 *    flattened.
 *
 * 2. Three of those five events do not carry the hedger.
 *    - PositionSettled and OptionExercised are indexed by `hedger`, so the
 *      caller can be bound directly to the event.
 *    - OptionExpired carries only a position id, and EmergencyUnwind carries no
 *      address at all.
 *    - PositionLiquidated carries a `liquidator`, who by construction is NOT
 *      the hedger — binding the caller to that field would be actively wrong,
 *      since it would let a liquidator claim someone else's position, and
 *      reject the actual owner.
 *    For those three, ownership is established by reading the position from the
 *    contract instead. The rule differs per event because the events differ;
 *    one uniform check would be wrong for four of the five.
 */

import { Interface, JsonRpcProvider } from "ethers";

import {
  assertCanonicalChainSnapshot,
  CanonicalTransactionError,
  getCanonicalTransaction,
} from "../lib/canonical-chain-transaction";
import type { NoblePayChainConfiguration } from "../lib/production-config";
import {
  CHAIN_HEDGE_TYPE,
  CHAIN_POSITION_STATUS,
  FX_INTERFACE,
  type ChainHedgeType,
  type ChainPositionStatus,
} from "./fx-chain";

/**
 * Events only. The view fragments live in FX_INTERFACE, which is covered by an
 * ABI drift guard; these are kept beside it and covered by the same guard.
 */
export const FX_EVENT_INTERFACE = new Interface([
  "event ForwardCreated(bytes32 indexed positionId,address indexed hedger,bytes32 indexed pairId,uint256 notionalAmount,uint256 lockedRate,uint256 maturityDate)",
  "event OptionCreated(bytes32 indexed positionId,address indexed hedger,bytes32 indexed pairId,uint8 hedgeType,uint256 notionalAmount,uint256 strikeRate,uint256 premium)",
  "event PositionSettled(bytes32 indexed positionId,address indexed hedger,uint256 settlementAmount,int256 pnl)",
  "event OptionExercised(bytes32 indexed positionId,address indexed hedger,uint256 exerciseRate,uint256 settlementAmount)",
  "event OptionExpired(bytes32 indexed positionId)",
  "event PositionLiquidated(bytes32 indexed positionId,address indexed liquidator,uint256 collateralSeized,uint256 liquidationBonus)",
  "event EmergencyUnwind(bytes32 indexed positionId,uint256 unwindAmount,uint256 timestamp)",
]);

/** How a position left ACTIVE. Reported, never flattened into "closed". */
export const CLOSE_KINDS = [
  "SETTLED",
  "EXERCISED",
  "EXPIRED",
  "LIQUIDATED",
  "EMERGENCY_UNWOUND",
] as const;

export type CloseKind = (typeof CLOSE_KINDS)[number];

/**
 * Which event proves each close kind, and whether that event names the hedger.
 *
 * `hedgerInEvent: false` is not a weaker check — it routes ownership to
 * getPosition(), which is authoritative. For LIQUIDATED it is the only correct
 * route, because the address the event does carry belongs to someone else.
 */
const CLOSE_EVENTS: Record<
  CloseKind,
  { event: string; hedgerInEvent: boolean; terminalStatus: ChainPositionStatus }
> = {
  SETTLED: {
    event: "PositionSettled",
    hedgerInEvent: true,
    terminalStatus: "SETTLED",
  },
  EXERCISED: {
    event: "OptionExercised",
    hedgerInEvent: true,
    terminalStatus: "EXERCISED",
  },
  EXPIRED: {
    event: "OptionExpired",
    hedgerInEvent: false,
    terminalStatus: "EXPIRED",
  },
  LIQUIDATED: {
    event: "PositionLiquidated",
    hedgerInEvent: false,
    terminalStatus: "LIQUIDATED",
  },
  EMERGENCY_UNWOUND: {
    event: "EmergencyUnwind",
    hedgerInEvent: false,
    terminalStatus: "EMERGENCY_UNWOUND",
  },
};

export type FXExecutionFailure =
  | "NO_VAULT_CONFIGURED"
  | "FX_UNSUPPORTED_HEDGE_TYPE"
  | "FX_NOT_MINED"
  | "FX_REVERTED"
  | "FX_NOT_CONFIRMED"
  | "FX_RPC_UNAVAILABLE"
  | "FX_CHAIN_MISMATCH"
  | "FX_WRONG_TARGET"
  | "FX_EVENT_MISSING"
  | "FX_HEDGER_MISMATCH"
  | "FX_TYPE_MISMATCH"
  | "FX_POSITION_UNKNOWN"
  | "FX_STATUS_NOT_TERMINAL"
  | "FX_POSITION_NOT_OPEN";

export class FXExecutionError extends Error {
  constructor(
    public readonly reason: FXExecutionFailure,
    message: string,
    public readonly statusCode = 422,
  ) {
    super(message);
    this.name = "FXExecutionError";
  }
}

export interface VerifiedHedgeOpen {
  onChainPositionId: string;
  hedger: string;
  pairId: string;
  hedgeType: ChainHedgeType;
  /** Raw contract units. Not compared against the caller's decimal notional. */
  notionalAmount: string;
  /** Locked rate for a forward, strike for an option; RATE_PRECISION units. */
  rate: string;
  premium: string;
  maturityDate: Date | null;
  txHash: string;
  blockNumber: number;
  openedAt: Date;
  chainStatus: ChainPositionStatus;
}

export interface VerifiedHedgeClose {
  onChainPositionId: string;
  hedger: string;
  closeKind: CloseKind;
  /**
   * Signed. int256 on chain, and a loss is negative — coercing it to unsigned
   * would turn a loss into a gain of the same size. Null for close kinds whose
   * event carries no P&L.
   */
  pnl: string | null;
  settlementAmount: string | null;
  txHash: string;
  blockNumber: number;
  closedAt: Date;
  chainStatus: ChainPositionStatus;
}

/**
 * Optional by design, like the other contract addresses: a deployment without a
 * hedging vault is valid rather than broken.
 */
export function resolveVaultAddress(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.FX_HEDGING_VAULT_ADDRESS?.trim();
  if (!raw) return null;
  if (!/^0x[a-fA-F0-9]{40}$/u.test(raw) || /^0x0{40}$/iu.test(raw)) return null;
  return raw;
}

async function canonicalVaultTransaction(
  config: NoblePayChainConfiguration,
  txHash: string,
  env: NodeJS.ProcessEnv,
) {
  const vault = resolveVaultAddress(env);
  if (!vault) {
    throw new FXExecutionError(
      "NO_VAULT_CONFIGURED",
      "No FXHedgingVault address is configured for this environment; hedges cannot be verified",
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
        throw new FXExecutionError(
          "FX_NOT_MINED",
          "The hedge transaction is not mined yet",
          409,
        );
      case "REVERTED":
        throw new FXExecutionError(
          "FX_REVERTED",
          "The hedge transaction reverted; no position changed",
        );
      case "INSUFFICIENT_CONFIRMATIONS":
        throw new FXExecutionError(
          "FX_NOT_CONFIRMED",
          `The hedge transaction has not reached ${config.minimumConfirmations} confirmations`,
          409,
        );
      case "RPC_UNAVAILABLE":
        throw new FXExecutionError(
          "FX_RPC_UNAVAILABLE",
          "Could not reach the configured RPC to verify the hedge",
          503,
        );
      default:
        throw new FXExecutionError(
          "FX_CHAIN_MISMATCH",
          "The hedge transaction is not canonical on the configured network",
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
    throw new FXExecutionError(
      "FX_CHAIN_MISMATCH",
      "The hedge transaction is not on the operator-confirmed Aethelred network",
    );
  }

  if ((canonical.transaction.to ?? "").toLowerCase() !== vault.toLowerCase()) {
    throw new FXExecutionError(
      "FX_WRONG_TARGET",
      "The transaction did not target the configured FXHedgingVault",
    );
  }

  return { vault, canonical, provider };
}

function vaultLog(
  receipt: {
    logs: readonly { address: string; topics: readonly string[]; data: string }[];
  },
  vault: string,
  eventName: string,
  positionId: string,
) {
  const topic = FX_EVENT_INTERFACE.getEvent(eventName)?.topicHash;
  const wanted = positionId.toLowerCase();
  return receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === vault.toLowerCase() &&
      log.topics[0] === topic &&
      log.topics[1]?.toLowerCase() === wanted,
  );
}

/** The contract's current view of a position, or null if it has none. */
async function readChainPosition(
  provider: { call: (tx: { to: string; data: string }) => Promise<string> },
  vault: string,
  positionId: string,
) {
  const raw = await provider.call({
    to: vault,
    data: FX_INTERFACE.encodeFunctionData("getPosition", [positionId]),
  });
  const [row] = FX_INTERFACE.decodeFunctionResult("getPosition", raw);
  // An unknown id decodes to a zeroed struct rather than reverting.
  if (String(row.hedger) === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  return {
    hedger: String(row.hedger),
    hedgeType: CHAIN_HEDGE_TYPE[Number(row.hedgeType)] ?? "FORWARD",
    status: CHAIN_POSITION_STATUS[Number(row.status)] ?? "ACTIVE",
    notionalAmount: String(row.notionalAmount),
  };
}

/**
 * Verify that a hedge position was opened on chain.
 *
 * `expectedHedgeType` is the CONTRACT's type, not the database's. The database
 * enum cannot distinguish a call from a put and has a SWAP value the vault
 * cannot produce at all (NP-FX-01), so the caller states which of the three
 * on-chain types they mean and it is checked against the event.
 */
export async function verifyHedgeOpen(
  config: NoblePayChainConfiguration,
  input: {
    txHash: string;
    onChainPositionId: string;
    expectedHedger: string;
    expectedHedgeType: ChainHedgeType;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedHedgeOpen> {
  if (!CHAIN_HEDGE_TYPE.includes(input.expectedHedgeType)) {
    throw new FXExecutionError(
      "FX_UNSUPPORTED_HEDGE_TYPE",
      `FXHedgingVault creates ${CHAIN_HEDGE_TYPE.join(", ")}; it cannot create ${input.expectedHedgeType}`,
      422,
    );
  }

  const { vault, canonical, provider } = await canonicalVaultTransaction(
    config,
    input.txHash,
    env,
  );

  const isForward = input.expectedHedgeType === "FORWARD";
  const eventName = isForward ? "ForwardCreated" : "OptionCreated";
  const log = vaultLog(
    canonical.receipt,
    vault,
    eventName,
    input.onChainPositionId,
  );
  if (!log) {
    throw new FXExecutionError(
      "FX_EVENT_MISSING",
      `The transaction did not emit ${eventName} for this position`,
    );
  }

  const parsed = FX_EVENT_INTERFACE.parseLog({
    topics: [...log.topics],
    data: log.data,
  });

  const hedger = String(parsed?.args?.hedger ?? "");
  if (hedger.toLowerCase() !== input.expectedHedger.toLowerCase()) {
    throw new FXExecutionError(
      "FX_HEDGER_MISMATCH",
      "The position was opened by a different account than the caller",
      403,
    );
  }

  // A call and a put are opposite bets, so an OptionCreated that does not match
  // the claimed direction is not a near miss.
  if (!isForward) {
    const onChainType =
      CHAIN_HEDGE_TYPE[Number(parsed?.args?.hedgeType ?? -1)] ?? null;
    if (onChainType !== input.expectedHedgeType) {
      throw new FXExecutionError(
        "FX_TYPE_MISMATCH",
        `The position was opened as ${onChainType ?? "an unknown type"}, not ${input.expectedHedgeType}`,
      );
    }
  }

  const onChain = await readChainPosition(
    provider,
    vault,
    input.onChainPositionId,
  );
  if (!onChain) {
    throw new FXExecutionError(
      "FX_POSITION_UNKNOWN",
      "The vault does not have a position with this id",
    );
  }
  if (onChain.hedgeType !== input.expectedHedgeType) {
    throw new FXExecutionError(
      "FX_TYPE_MISMATCH",
      `The vault reports this position as ${onChain.hedgeType}, not ${input.expectedHedgeType}`,
    );
  }

  const maturityRaw = Number(parsed?.args?.maturityDate ?? 0);

  return {
    onChainPositionId: input.onChainPositionId.toLowerCase(),
    hedger,
    pairId: String(parsed?.args?.pairId ?? ""),
    hedgeType: input.expectedHedgeType,
    notionalAmount: String(parsed?.args?.notionalAmount ?? "0"),
    rate: String(
      (isForward ? parsed?.args?.lockedRate : parsed?.args?.strikeRate) ?? "0",
    ),
    premium: String(parsed?.args?.premium ?? "0"),
    // Forwards carry a maturity; options do not put one in the event.
    maturityDate: maturityRaw > 0 ? new Date(maturityRaw * 1000) : null,
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    openedAt: new Date(Number(canonical.block.timestamp) * 1000),
    chainStatus: onChain.status,
  };
}

/**
 * Verify that a position left ACTIVE, and determine how.
 *
 * The caller does not state the close kind — the chain does. Letting a caller
 * declare "this was settled" when the receipt says it was liquidated is exactly
 * the substitution this is here to prevent, so every close event is searched
 * and the one actually present decides.
 */
export async function verifyHedgeClose(
  config: NoblePayChainConfiguration,
  input: {
    txHash: string;
    onChainPositionId: string;
    expectedHedger: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedHedgeClose> {
  const { vault, canonical, provider } = await canonicalVaultTransaction(
    config,
    input.txHash,
    env,
  );

  let found: { kind: CloseKind; log: NonNullable<ReturnType<typeof vaultLog>> } | null =
    null;
  for (const kind of CLOSE_KINDS) {
    const log = vaultLog(
      canonical.receipt,
      vault,
      CLOSE_EVENTS[kind].event,
      input.onChainPositionId,
    );
    if (log) {
      found = { kind, log };
      break;
    }
  }
  if (!found) {
    throw new FXExecutionError(
      "FX_EVENT_MISSING",
      "The transaction did not close this position in any recognised way",
    );
  }

  const spec = CLOSE_EVENTS[found.kind];
  const parsed = FX_EVENT_INTERFACE.parseLog({
    topics: [...found.log.topics],
    data: found.log.data,
  });

  const onChain = await readChainPosition(
    provider,
    vault,
    input.onChainPositionId,
  );
  if (!onChain) {
    throw new FXExecutionError(
      "FX_POSITION_UNKNOWN",
      "The vault does not have a position with this id",
    );
  }

  // Ownership: from the event where it names the hedger, from the position
  // otherwise. For LIQUIDATED the event's address is the liquidator, so using
  // it here would both admit a stranger and reject the real owner.
  const hedger = spec.hedgerInEvent
    ? String(parsed?.args?.hedger ?? "")
    : onChain.hedger;
  if (hedger.toLowerCase() !== input.expectedHedger.toLowerCase()) {
    throw new FXExecutionError(
      "FX_HEDGER_MISMATCH",
      "The position belongs to a different account than the caller",
      403,
    );
  }

  if (onChain.status !== spec.terminalStatus) {
    throw new FXExecutionError(
      "FX_STATUS_NOT_TERMINAL",
      `The vault reports this position as ${onChain.status}, which does not match a ${found.kind} close`,
    );
  }

  // Signed on purpose: pnl is int256 and a loss is negative.
  const rawPnl = parsed?.args?.pnl;

  return {
    onChainPositionId: input.onChainPositionId.toLowerCase(),
    hedger,
    closeKind: found.kind,
    pnl: rawPnl === undefined || rawPnl === null ? null : String(rawPnl),
    settlementAmount:
      parsed?.args?.settlementAmount === undefined
        ? null
        : String(parsed.args.settlementAmount),
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    closedAt: new Date(Number(canonical.block.timestamp) * 1000),
    chainStatus: onChain.status,
  };
}
