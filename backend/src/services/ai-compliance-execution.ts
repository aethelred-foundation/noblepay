/**
 * Verifies AI decision appeal and override receipts against AIComplianceModule.
 *
 * WHAT THIS PROVES, PRECISELY
 *
 * It proves the appeal lifecycle happened: that an appeal was filed by a
 * particular appellant against a particular decision, that a named compliance
 * officer took up the review, and that the appeal was resolved to a particular
 * outcome — each immutably, attributably, and in the order the contract
 * enforces.
 *
 * It does NOT prove anything about the decision being appealed. `recordDecision`
 * is `onlyRole(AI_OPERATOR_ROLE)`; it verifies no attestation and never reads
 * the `evidenceHash` it stores. An on-chain decision is an authorised operator's
 * assertion, not evidence a model ran. Everything returned here therefore
 * carries `decisionProvenance: "OPERATOR_ASSERTED"`, so the limitation travels
 * with the data instead of living only in docs/audit/NP-AI-01.
 *
 * That distinction is the whole reason this file is careful: an appeals process
 * is exactly where someone will be tempted to read "verified" as "proven".
 */

import { Interface, JsonRpcProvider } from "ethers";

import {
  assertCanonicalChainSnapshot,
  CanonicalTransactionError,
  getCanonicalTransaction,
} from "../lib/canonical-chain-transaction";
import type { NoblePayChainConfiguration } from "../lib/production-config";

export const AI_INTERFACE = new Interface([
  "event AppealFiled(bytes32 indexed appealId,bytes32 indexed decisionId,address indexed appellant,bytes32 groundsHash)",
  "event AppealReviewStarted(bytes32 indexed appealId,address indexed reviewer)",
  "event AppealResolved(bytes32 indexed appealId,bytes32 indexed decisionId,uint8 status,uint8 revisedOutcome)",
  "event DecisionOverridden(bytes32 indexed overrideId,bytes32 indexed decisionId,address indexed officer,uint8 originalOutcome,uint8 newOutcome)",
  "function getDecision(bytes32 _decisionId) view returns (tuple(bytes32 subjectHash,bytes32 modelId,uint8 outcome,uint8 confidenceScore,bytes32 evidenceHash,bytes32 reasonHash,address operator,uint256 timestamp,bool overridden,bool appealed))",
  "function getAppeal(bytes32 _appealId) view returns (tuple(bytes32 decisionId,address appellant,bytes32 groundsHash,uint8 status,address reviewer,bytes32 reviewReasonHash,uint8 revisedOutcome,uint256 filedAt,uint256 resolvedAt))",
]);

/** Contract enum orderings. On-chain uint8 values; do not reorder. */
export const CHAIN_DECISION_OUTCOME = [
  "APPROVED",
  "FLAGGED",
  "REJECTED",
  "ESCALATED",
] as const;

export const CHAIN_APPEAL_STATUS = [
  "PENDING",
  "UNDER_REVIEW",
  "UPHELD",
  "OVERTURNED",
  "DISMISSED",
] as const;

export type ChainDecisionOutcome = (typeof CHAIN_DECISION_OUTCOME)[number];
export type ChainAppealStatus = (typeof CHAIN_APPEAL_STATUS)[number];

/**
 * The database calls the initial state SUBMITTED where the contract calls it
 * PENDING; the other four names coincide. Unlike the FX enums this mapping is
 * total and lossless, so it is safe — but it is written out rather than assumed,
 * because "the names look the same" is how the FX statuses went wrong.
 */
export const CHAIN_APPEAL_STATUS_TO_DB: Record<ChainAppealStatus, string> = {
  PENDING: "SUBMITTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  UPHELD: "UPHELD",
  OVERTURNED: "OVERTURNED",
  DISMISSED: "DISMISSED",
};

/**
 * Contract outcome -> API outcome.
 *
 * Total and lossless, but not guessable: three differ only by tense while
 * REJECTED maps to BLOCK, a different word entirely. Written out so the
 * rename is visible rather than inferred by a future reader who assumes the
 * pattern holds.
 */
export const CHAIN_OUTCOME_TO_DB: Record<ChainDecisionOutcome, string> = {
  APPROVED: "APPROVE",
  FLAGGED: "FLAG",
  REJECTED: "BLOCK",
  ESCALATED: "ESCALATE",
};

/**
 * Attached to every verified result. The decision underlying any of these
 * events was asserted by an operator, not proven — see NP-AI-01.
 */
export const DECISION_PROVENANCE = "OPERATOR_ASSERTED" as const;

export type AIExecutionFailure =
  | "NO_AI_MODULE_CONFIGURED"
  | "AI_NOT_MINED"
  | "AI_REVERTED"
  | "AI_NOT_CONFIRMED"
  | "AI_RPC_UNAVAILABLE"
  | "AI_CHAIN_MISMATCH"
  | "AI_WRONG_TARGET"
  | "AI_EVENT_MISSING"
  | "AI_APPELLANT_MISMATCH"
  | "AI_REVIEWER_MISMATCH"
  | "AI_OFFICER_MISMATCH"
  | "AI_DECISION_MISMATCH"
  | "AI_DECISION_UNKNOWN"
  | "AI_APPEAL_UNKNOWN"
  | "AI_APPEAL_STATUS_MISMATCH"
  | "AI_OVERRIDE_NOT_RECORDED";

export class AIExecutionError extends Error {
  constructor(
    public readonly reason: AIExecutionFailure,
    message: string,
    public readonly statusCode = 422,
  ) {
    super(message);
    this.name = "AIExecutionError";
  }
}

interface VerifiedBase {
  txHash: string;
  blockNumber: number;
  at: Date;
  decisionProvenance: typeof DECISION_PROVENANCE;
}

export interface VerifiedAppealFiling extends VerifiedBase {
  onChainAppealId: string;
  onChainDecisionId: string;
  appellant: string;
  groundsHash: string;
  chainStatus: ChainAppealStatus;
}

export interface VerifiedAppealReview extends VerifiedBase {
  onChainAppealId: string;
  reviewer: string;
  chainStatus: ChainAppealStatus;
}

export interface VerifiedAppealResolution extends VerifiedBase {
  onChainAppealId: string;
  onChainDecisionId: string;
  chainStatus: ChainAppealStatus;
  revisedOutcome: ChainDecisionOutcome;
  reviewer: string;
}

export interface VerifiedDecisionOverride extends VerifiedBase {
  onChainOverrideId: string;
  onChainDecisionId: string;
  officer: string;
  originalOutcome: ChainDecisionOutcome;
  newOutcome: ChainDecisionOutcome;
}

export function resolveAIModuleAddress(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.AI_COMPLIANCE_MODULE_ADDRESS?.trim();
  if (!raw) return null;
  if (!/^0x[a-fA-F0-9]{40}$/u.test(raw) || /^0x0{40}$/iu.test(raw)) return null;
  return raw;
}

async function canonicalModuleTransaction(
  config: NoblePayChainConfiguration,
  txHash: string,
  env: NodeJS.ProcessEnv,
) {
  const moduleAddress = resolveAIModuleAddress(env);
  if (!moduleAddress) {
    throw new AIExecutionError(
      "NO_AI_MODULE_CONFIGURED",
      "No AIComplianceModule address is configured for this environment; appeals cannot be verified",
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
        throw new AIExecutionError(
          "AI_NOT_MINED",
          "The transaction is not mined yet",
          409,
        );
      case "REVERTED":
        throw new AIExecutionError(
          "AI_REVERTED",
          "The transaction reverted; nothing was recorded",
        );
      case "INSUFFICIENT_CONFIRMATIONS":
        throw new AIExecutionError(
          "AI_NOT_CONFIRMED",
          `The transaction has not reached ${config.minimumConfirmations} confirmations`,
          409,
        );
      case "RPC_UNAVAILABLE":
        throw new AIExecutionError(
          "AI_RPC_UNAVAILABLE",
          "Could not reach the configured RPC to verify the transaction",
          503,
        );
      default:
        throw new AIExecutionError(
          "AI_CHAIN_MISMATCH",
          "The transaction is not canonical on the configured network",
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
    throw new AIExecutionError(
      "AI_CHAIN_MISMATCH",
      "The transaction is not on the operator-confirmed Aethelred network",
    );
  }

  if (
    (canonical.transaction.to ?? "").toLowerCase() !==
    moduleAddress.toLowerCase()
  ) {
    throw new AIExecutionError(
      "AI_WRONG_TARGET",
      "The transaction did not target the configured AIComplianceModule",
    );
  }

  return { moduleAddress, canonical, provider };
}

function moduleLog(
  receipt: {
    logs: readonly { address: string; topics: readonly string[]; data: string }[];
  },
  moduleAddress: string,
  eventName: string,
  id: string,
) {
  const topic = AI_INTERFACE.getEvent(eventName)?.topicHash;
  const wanted = id.toLowerCase();
  return receipt.logs.find(
    (entry) =>
      entry.address.toLowerCase() === moduleAddress.toLowerCase() &&
      entry.topics[0] === topic &&
      entry.topics[1]?.toLowerCase() === wanted,
  );
}

async function readAppeal(
  provider: { call: (tx: { to: string; data: string }) => Promise<string> },
  moduleAddress: string,
  appealId: string,
) {
  const raw = await provider.call({
    to: moduleAddress,
    data: AI_INTERFACE.encodeFunctionData("getAppeal", [appealId]),
  });
  const [row] = AI_INTERFACE.decodeFunctionResult("getAppeal", raw);
  // An unknown id decodes to a zeroed struct rather than reverting.
  if (Number(row.filedAt) === 0) return null;
  return {
    decisionId: String(row.decisionId),
    appellant: String(row.appellant),
    reviewer: String(row.reviewer),
    status: CHAIN_APPEAL_STATUS[Number(row.status)] ?? "PENDING",
    revisedOutcome:
      CHAIN_DECISION_OUTCOME[Number(row.revisedOutcome)] ?? "APPROVED",
  };
}

async function readDecision(
  provider: { call: (tx: { to: string; data: string }) => Promise<string> },
  moduleAddress: string,
  decisionId: string,
) {
  const raw = await provider.call({
    to: moduleAddress,
    data: AI_INTERFACE.encodeFunctionData("getDecision", [decisionId]),
  });
  const [row] = AI_INTERFACE.decodeFunctionResult("getDecision", raw);
  if (Number(row.timestamp) === 0) return null;
  return {
    outcome: CHAIN_DECISION_OUTCOME[Number(row.outcome)] ?? "APPROVED",
    operator: String(row.operator),
    overridden: Boolean(row.overridden),
    appealed: Boolean(row.appealed),
  };
}

/**
 * Verify an appeal was filed on chain.
 *
 * The appellant is bound to the caller, and the decision the appeal names is
 * bound to the decision the record refers to — otherwise a real appeal against
 * decision B could be filed away as an appeal against decision A.
 */
export async function verifyAppealFiling(
  config: NoblePayChainConfiguration,
  input: {
    txHash: string;
    onChainAppealId: string;
    onChainDecisionId: string;
    expectedAppellant: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedAppealFiling> {
  const { moduleAddress, canonical, provider } =
    await canonicalModuleTransaction(config, input.txHash, env);

  const entry = moduleLog(
    canonical.receipt,
    moduleAddress,
    "AppealFiled",
    input.onChainAppealId,
  );
  if (!entry) {
    throw new AIExecutionError(
      "AI_EVENT_MISSING",
      "The transaction did not emit AppealFiled for this appeal",
    );
  }

  const parsed = AI_INTERFACE.parseLog({
    topics: [...entry.topics],
    data: entry.data,
  });

  const appellant = String(parsed?.args?.appellant ?? "");
  if (appellant.toLowerCase() !== input.expectedAppellant.toLowerCase()) {
    throw new AIExecutionError(
      "AI_APPELLANT_MISMATCH",
      "The appeal was filed by a different account than the caller",
      403,
    );
  }

  const eventDecisionId = String(parsed?.args?.decisionId ?? "");
  if (
    eventDecisionId.toLowerCase() !== input.onChainDecisionId.toLowerCase()
  ) {
    throw new AIExecutionError(
      "AI_DECISION_MISMATCH",
      "The appeal was filed against a different decision than the one recorded",
    );
  }

  const onChainDecision = await readDecision(
    provider,
    moduleAddress,
    input.onChainDecisionId,
  );
  if (!onChainDecision) {
    throw new AIExecutionError(
      "AI_DECISION_UNKNOWN",
      "The module does not have a decision with this id",
    );
  }

  const appeal = await readAppeal(
    provider,
    moduleAddress,
    input.onChainAppealId,
  );
  if (!appeal) {
    throw new AIExecutionError(
      "AI_APPEAL_UNKNOWN",
      "The module does not have an appeal with this id",
    );
  }

  return {
    onChainAppealId: input.onChainAppealId.toLowerCase(),
    onChainDecisionId: eventDecisionId.toLowerCase(),
    appellant,
    groundsHash: String(parsed?.args?.groundsHash ?? ""),
    // Reported, not required to still be PENDING: a review may already have
    // started by the time this runs, and rejecting that would fail exactly the
    // appeals that are progressing.
    chainStatus: appeal.status,
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    at: new Date(Number(canonical.block.timestamp) * 1000),
    decisionProvenance: DECISION_PROVENANCE,
  };
}

/**
 * Verify a compliance officer took up the review.
 *
 * This step exists on chain and had no counterpart in the API. It is the
 * auditable moment in an appeals process: a named officer accepting the review
 * is what shows the appeal received human consideration, and the contract will
 * not allow a resolution without it.
 */
export async function verifyAppealReview(
  config: NoblePayChainConfiguration,
  input: {
    txHash: string;
    onChainAppealId: string;
    expectedReviewer: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedAppealReview> {
  const { moduleAddress, canonical, provider } =
    await canonicalModuleTransaction(config, input.txHash, env);

  const entry = moduleLog(
    canonical.receipt,
    moduleAddress,
    "AppealReviewStarted",
    input.onChainAppealId,
  );
  if (!entry) {
    throw new AIExecutionError(
      "AI_EVENT_MISSING",
      "The transaction did not emit AppealReviewStarted for this appeal",
    );
  }

  const parsed = AI_INTERFACE.parseLog({
    topics: [...entry.topics],
    data: entry.data,
  });

  const reviewer = String(parsed?.args?.reviewer ?? "");
  if (reviewer.toLowerCase() !== input.expectedReviewer.toLowerCase()) {
    throw new AIExecutionError(
      "AI_REVIEWER_MISMATCH",
      "The review was started by a different officer than the caller",
      403,
    );
  }

  const appeal = await readAppeal(
    provider,
    moduleAddress,
    input.onChainAppealId,
  );
  if (!appeal) {
    throw new AIExecutionError(
      "AI_APPEAL_UNKNOWN",
      "The module does not have an appeal with this id",
    );
  }

  return {
    onChainAppealId: input.onChainAppealId.toLowerCase(),
    reviewer,
    chainStatus: appeal.status,
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    at: new Date(Number(canonical.block.timestamp) * 1000),
    decisionProvenance: DECISION_PROVENANCE,
  };
}

/**
 * Verify an appeal was resolved.
 *
 * The outcome comes from the chain rather than from the caller. Letting a
 * caller declare "this appeal was DISMISSED" while the receipt says OVERTURNED
 * would invert the result of a process whose entire purpose is to be
 * contestable.
 */
export async function verifyAppealResolution(
  config: NoblePayChainConfiguration,
  input: {
    txHash: string;
    onChainAppealId: string;
    expectedReviewer: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedAppealResolution> {
  const { moduleAddress, canonical, provider } =
    await canonicalModuleTransaction(config, input.txHash, env);

  const entry = moduleLog(
    canonical.receipt,
    moduleAddress,
    "AppealResolved",
    input.onChainAppealId,
  );
  if (!entry) {
    throw new AIExecutionError(
      "AI_EVENT_MISSING",
      "The transaction did not emit AppealResolved for this appeal",
    );
  }

  const parsed = AI_INTERFACE.parseLog({
    topics: [...entry.topics],
    data: entry.data,
  });

  const appeal = await readAppeal(
    provider,
    moduleAddress,
    input.onChainAppealId,
  );
  if (!appeal) {
    throw new AIExecutionError(
      "AI_APPEAL_UNKNOWN",
      "The module does not have an appeal with this id",
    );
  }

  // AppealResolved does not name the reviewer, so the binding comes from the
  // appeal record — which the contract set when the review was started.
  if (appeal.reviewer.toLowerCase() !== input.expectedReviewer.toLowerCase()) {
    throw new AIExecutionError(
      "AI_REVIEWER_MISMATCH",
      "The appeal was reviewed by a different officer than the caller",
      403,
    );
  }

  const eventStatus =
    CHAIN_APPEAL_STATUS[Number(parsed?.args?.status ?? -1)] ?? null;
  if (!eventStatus || eventStatus !== appeal.status) {
    throw new AIExecutionError(
      "AI_APPEAL_STATUS_MISMATCH",
      "The module's appeal status does not match the resolution event",
    );
  }

  return {
    onChainAppealId: input.onChainAppealId.toLowerCase(),
    onChainDecisionId: String(parsed?.args?.decisionId ?? "").toLowerCase(),
    chainStatus: eventStatus,
    revisedOutcome:
      CHAIN_DECISION_OUTCOME[Number(parsed?.args?.revisedOutcome ?? 0)] ??
      "APPROVED",
    reviewer: appeal.reviewer,
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    at: new Date(Number(canonical.block.timestamp) * 1000),
    decisionProvenance: DECISION_PROVENANCE,
  };
}

/**
 * Verify a human override of a decision.
 *
 * Both outcomes come from the event. The contract refuses an override that does
 * not change the outcome, so a recorded override that claims no change would be
 * describing a transaction that cannot exist.
 */
export async function verifyDecisionOverride(
  config: NoblePayChainConfiguration,
  input: {
    txHash: string;
    onChainOverrideId: string;
    onChainDecisionId: string;
    expectedOfficer: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedDecisionOverride> {
  const { moduleAddress, canonical, provider } =
    await canonicalModuleTransaction(config, input.txHash, env);

  const entry = moduleLog(
    canonical.receipt,
    moduleAddress,
    "DecisionOverridden",
    input.onChainOverrideId,
  );
  if (!entry) {
    throw new AIExecutionError(
      "AI_EVENT_MISSING",
      "The transaction did not emit DecisionOverridden for this override",
    );
  }

  const parsed = AI_INTERFACE.parseLog({
    topics: [...entry.topics],
    data: entry.data,
  });

  const officer = String(parsed?.args?.officer ?? "");
  if (officer.toLowerCase() !== input.expectedOfficer.toLowerCase()) {
    throw new AIExecutionError(
      "AI_OFFICER_MISMATCH",
      "The override was made by a different officer than the caller",
      403,
    );
  }

  const eventDecisionId = String(parsed?.args?.decisionId ?? "");
  if (eventDecisionId.toLowerCase() !== input.onChainDecisionId.toLowerCase()) {
    throw new AIExecutionError(
      "AI_DECISION_MISMATCH",
      "The override applies to a different decision than the one recorded",
    );
  }

  const decision = await readDecision(
    provider,
    moduleAddress,
    input.onChainDecisionId,
  );
  if (!decision) {
    throw new AIExecutionError(
      "AI_DECISION_UNKNOWN",
      "The module does not have a decision with this id",
    );
  }
  if (!decision.overridden) {
    throw new AIExecutionError(
      "AI_OVERRIDE_NOT_RECORDED",
      "The module does not report this decision as overridden",
    );
  }

  return {
    onChainOverrideId: input.onChainOverrideId.toLowerCase(),
    onChainDecisionId: eventDecisionId.toLowerCase(),
    officer,
    originalOutcome:
      CHAIN_DECISION_OUTCOME[Number(parsed?.args?.originalOutcome ?? 0)] ??
      "APPROVED",
    newOutcome:
      CHAIN_DECISION_OUTCOME[Number(parsed?.args?.newOutcome ?? 0)] ??
      "APPROVED",
    txHash: input.txHash.toLowerCase(),
    blockNumber: canonical.receipt.blockNumber,
    at: new Date(Number(canonical.block.timestamp) * 1000),
    decisionProvenance: DECISION_PROVENANCE,
  };
}
