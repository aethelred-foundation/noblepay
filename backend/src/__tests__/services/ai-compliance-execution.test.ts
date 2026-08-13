/**
 * Tests for AI appeal and override receipt verification.
 *
 * The recurring theme is that the chain decides the outcome, not the caller.
 * An appeals process exists to be contestable, so the two substitutions worth
 * guarding hardest are: filing an appeal against one decision and recording it
 * against another, and reporting a resolution as something other than what the
 * receipt says.
 *
 * Every result also carries decisionProvenance: "OPERATOR_ASSERTED", because
 * the decision underneath all of this was asserted by an AI_OPERATOR_ROLE
 * holder rather than proven — see docs/audit/NP-AI-01. There is a test that
 * this label is present, so it cannot quietly disappear.
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
  AIExecutionError,
  AI_INTERFACE,
  verifyAppealFiling,
  verifyAppealResolution,
  verifyAppealReview,
  verifyDecisionOverride,
} from "../../services/ai-compliance-execution";

const MODULE = "0x8a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4";
const OTHER = "0x000000000000000000000000000000000000dead";
const APPELLANT = "0x2E8625F06A696b556B7B5e0C1b34B1cb55203af1";
const OFFICER = "0x4444444444444444444444444444444444444444";
const STRANGER = "0x1111111111111111111111111111111111111111";

const APPEAL_ID = `0x${"a1".repeat(32)}`;
const DECISION_ID = `0x${"d2".repeat(32)}`;
const OVERRIDE_ID = `0x${"05".repeat(32)}`;
const GROUNDS = `0x${"9e".repeat(32)}`;
const TX_HASH =
  "0xc62faafeb160571853128e25efc65388ca483c22504742b7b455dfcc8ade5faa";

const config = {
  rpcUrl: "http://rpc.invalid",
  minimumConfirmations: 3,
} as never;

const env = { AI_COMPLIANCE_MODULE_ADDRESS: MODULE } as NodeJS.ProcessEnv;

const log = (name: string, args: unknown[], address = MODULE) => {
  const encoded = AI_INTERFACE.encodeEventLog(name, args);
  return { address, topics: encoded.topics, data: encoded.data };
};

const canonical = (logs: unknown[], to: string = MODULE) => ({
  receipt: { blockNumber: 9001, blockHash: "0xblock", logs },
  transaction: { to, from: APPELLANT, data: "0x" },
  block: { timestamp: 1_700_000_000 },
  confirmations: 6,
});

/** getAppeal returning a struct with the given reviewer/status. */
const chainAppeal = (
  over: {
    appellant?: string;
    reviewer?: string;
    status?: number;
    revisedOutcome?: number;
    filedAt?: number;
  } = {},
) =>
  AI_INTERFACE.encodeFunctionResult("getAppeal", [
    [
      DECISION_ID,
      over.appellant ?? APPELLANT,
      GROUNDS,
      over.status ?? 0, // PENDING
      over.reviewer ?? "0x0000000000000000000000000000000000000000",
      `0x${"0".repeat(64)}`,
      over.revisedOutcome ?? 0,
      BigInt(over.filedAt ?? 1_700_000_000),
      0n,
    ],
  ]);

/** getDecision returning a struct with the given overridden flag. */
const chainDecision = (
  over: { overridden?: boolean; timestamp?: number; outcome?: number } = {},
) =>
  AI_INTERFACE.encodeFunctionResult("getDecision", [
    [
      `0x${"5c".repeat(32)}`,
      `0x${"6d".repeat(32)}`,
      over.outcome ?? 1,
      88,
      `0x${"0".repeat(64)}`,
      `0x${"0".repeat(64)}`,
      OFFICER,
      BigInt(over.timestamp ?? 1_700_000_000),
      over.overridden ?? false,
      false,
    ],
  ]);

/** Routes getDecision and getAppeal to different fixtures in one mock. */
const routeCalls = (opts: { decision?: string; appeal?: string }) => {
  const decisionSelector = AI_INTERFACE.getFunction("getDecision")!.selector;
  mockCall.mockImplementation(async (tx: { data: string }) =>
    tx.data.startsWith(decisionSelector)
      ? (opts.decision ?? chainDecision())
      : (opts.appeal ?? chainAppeal()),
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertCanonicalChainSnapshot.mockResolvedValue(undefined);
  mockGetCanonicalTransaction.mockResolvedValue(
    canonical([
      log("AppealFiled", [APPEAL_ID, DECISION_ID, APPELLANT, GROUNDS]),
    ]),
  );
  routeCalls({});
});

const filingInput = {
  txHash: TX_HASH,
  onChainAppealId: APPEAL_ID,
  onChainDecisionId: DECISION_ID,
  expectedAppellant: APPELLANT,
};

describe("verifyAppealFiling", () => {
  it("returns the filing details and labels the decision's provenance", async () => {
    const result = await verifyAppealFiling(config, filingInput, env);
    expect(result.onChainAppealId).toBe(APPEAL_ID.toLowerCase());
    expect(result.onChainDecisionId).toBe(DECISION_ID.toLowerCase());
    expect(result.groundsHash).toBe(GROUNDS);
    // The label must survive. It is the only thing distinguishing a verified
    // appeal over an asserted decision from a verified decision.
    expect(result.decisionProvenance).toBe("OPERATOR_ASSERTED");
  });

  it("refuses when no module is configured", async () => {
    await expect(
      verifyAppealFiling(config, filingInput, {} as NodeJS.ProcessEnv),
    ).rejects.toMatchObject({
      reason: "NO_AI_MODULE_CONFIGURED",
      statusCode: 501,
    });
  });

  it("treats an unmined transaction as 409", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("NOT_MINED"),
    );
    await expect(
      verifyAppealFiling(config, filingInput, env),
    ).rejects.toMatchObject({ reason: "AI_NOT_MINED", statusCode: 409 });
  });

  it("refuses a reverted transaction", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("REVERTED"),
    );
    await expect(
      verifyAppealFiling(config, filingInput, env),
    ).rejects.toMatchObject({ reason: "AI_REVERTED" });
  });

  it("reports an unreachable node as 503", async () => {
    mockGetCanonicalTransaction.mockRejectedValue(
      new MockCanonicalTransactionError("RPC_UNAVAILABLE"),
    );
    await expect(
      verifyAppealFiling(config, filingInput, env),
    ).rejects.toMatchObject({ reason: "AI_RPC_UNAVAILABLE", statusCode: 503 });
  });

  it("refuses a receipt from a different network", async () => {
    mockAssertCanonicalChainSnapshot.mockRejectedValue(new Error("anchor"));
    await expect(
      verifyAppealFiling(config, filingInput, env),
    ).rejects.toMatchObject({ reason: "AI_CHAIN_MISMATCH" });
  });

  it("refuses a transaction sent to some other contract", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical(
        [log("AppealFiled", [APPEAL_ID, DECISION_ID, APPELLANT, GROUNDS])],
        OTHER,
      ),
    );
    await expect(
      verifyAppealFiling(config, filingInput, env),
    ).rejects.toMatchObject({ reason: "AI_WRONG_TARGET" });
  });

  it("ignores an AppealFiled emitted by a different contract", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([
        log(
          "AppealFiled",
          [APPEAL_ID, DECISION_ID, APPELLANT, GROUNDS],
          OTHER,
        ),
      ]),
    );
    await expect(
      verifyAppealFiling(config, filingInput, env),
    ).rejects.toMatchObject({ reason: "AI_EVENT_MISSING" });
  });

  it("refuses an appeal filed by a different account", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("AppealFiled", [APPEAL_ID, DECISION_ID, STRANGER, GROUNDS])]),
    );
    await expect(
      verifyAppealFiling(config, filingInput, env),
    ).rejects.toMatchObject({
      reason: "AI_APPELLANT_MISMATCH",
      statusCode: 403,
    });
  });

  it("refuses an appeal filed against a DIFFERENT decision", async () => {
    // The substitution that matters most: a real appeal against decision B
    // must not be filed away as an appeal against decision A.
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([
        log(
          "AppealFiled",
          [APPEAL_ID, `0x${"bb".repeat(32)}`, APPELLANT, GROUNDS],
        ),
      ]),
    );
    await expect(
      verifyAppealFiling(config, filingInput, env),
    ).rejects.toMatchObject({ reason: "AI_DECISION_MISMATCH" });
  });

  it("refuses when the module has no such decision", async () => {
    routeCalls({ decision: chainDecision({ timestamp: 0 }) });
    await expect(
      verifyAppealFiling(config, filingInput, env),
    ).rejects.toMatchObject({ reason: "AI_DECISION_UNKNOWN" });
  });

  it("refuses when the module has no such appeal", async () => {
    routeCalls({ appeal: chainAppeal({ filedAt: 0 }) });
    await expect(
      verifyAppealFiling(config, filingInput, env),
    ).rejects.toMatchObject({ reason: "AI_APPEAL_UNKNOWN" });
  });

  it("accepts a filing whose review has already started", async () => {
    // Verification can run late. Requiring PENDING would reject exactly the
    // appeals that are progressing normally.
    routeCalls({ appeal: chainAppeal({ status: 1, reviewer: OFFICER }) });
    const result = await verifyAppealFiling(config, filingInput, env);
    expect(result.chainStatus).toBe("UNDER_REVIEW");
  });
});

describe("verifyAppealReview", () => {
  const reviewInput = {
    txHash: TX_HASH,
    onChainAppealId: APPEAL_ID,
    expectedReviewer: OFFICER,
  };

  beforeEach(() => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("AppealReviewStarted", [APPEAL_ID, OFFICER])]),
    );
    routeCalls({ appeal: chainAppeal({ status: 1, reviewer: OFFICER }) });
  });

  it("returns the reviewer and the resulting status", async () => {
    const result = await verifyAppealReview(config, reviewInput, env);
    expect(result.reviewer.toLowerCase()).toBe(OFFICER.toLowerCase());
    expect(result.chainStatus).toBe("UNDER_REVIEW");
  });

  it("refuses a review started by a different officer", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("AppealReviewStarted", [APPEAL_ID, STRANGER])]),
    );
    await expect(
      verifyAppealReview(config, reviewInput, env),
    ).rejects.toMatchObject({
      reason: "AI_REVIEWER_MISMATCH",
      statusCode: 403,
    });
  });

  it("refuses when AppealReviewStarted was not emitted", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(canonical([]));
    await expect(
      verifyAppealReview(config, reviewInput, env),
    ).rejects.toMatchObject({ reason: "AI_EVENT_MISSING" });
  });
});

describe("verifyAppealResolution", () => {
  const resolutionInput = {
    txHash: TX_HASH,
    onChainAppealId: APPEAL_ID,
    expectedReviewer: OFFICER,
  };

  beforeEach(() => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("AppealResolved", [APPEAL_ID, DECISION_ID, 3, 2])]),
    );
    // OVERTURNED, revised to REJECTED
    routeCalls({
      appeal: chainAppeal({ status: 3, reviewer: OFFICER, revisedOutcome: 2 }),
    });
  });

  it("reports the outcome the chain recorded", async () => {
    const result = await verifyAppealResolution(config, resolutionInput, env);
    expect(result.chainStatus).toBe("OVERTURNED");
    expect(result.revisedOutcome).toBe("REJECTED");
    expect(result.decisionProvenance).toBe("OPERATOR_ASSERTED");
  });

  it("binds the reviewer through the appeal, since the event omits one", async () => {
    // AppealResolved carries no reviewer, so ownership comes from getAppeal —
    // set when the review was started.
    await expect(
      verifyAppealResolution(
        config,
        { ...resolutionInput, expectedReviewer: STRANGER },
        env,
      ),
    ).rejects.toMatchObject({
      reason: "AI_REVIEWER_MISMATCH",
      statusCode: 403,
    });
  });

  it("refuses when the event and the module disagree about the outcome", async () => {
    // Event says OVERTURNED (3); the module says DISMISSED (4). Recording
    // either would be a guess about a contested decision.
    routeCalls({
      appeal: chainAppeal({ status: 4, reviewer: OFFICER }),
    });
    await expect(
      verifyAppealResolution(config, resolutionInput, env),
    ).rejects.toMatchObject({ reason: "AI_APPEAL_STATUS_MISMATCH" });
  });

  it("refuses when AppealResolved was not emitted", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([log("AppealReviewStarted", [APPEAL_ID, OFFICER])]),
    );
    await expect(
      verifyAppealResolution(config, resolutionInput, env),
    ).rejects.toMatchObject({ reason: "AI_EVENT_MISSING" });
  });
});

describe("verifyDecisionOverride", () => {
  const overrideInput = {
    txHash: TX_HASH,
    onChainOverrideId: OVERRIDE_ID,
    onChainDecisionId: DECISION_ID,
    expectedOfficer: OFFICER,
  };

  beforeEach(() => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([
        log("DecisionOverridden", [OVERRIDE_ID, DECISION_ID, OFFICER, 1, 0]),
      ]),
    );
    routeCalls({ decision: chainDecision({ overridden: true }) });
  });

  it("reports both outcomes from the event", async () => {
    const result = await verifyDecisionOverride(config, overrideInput, env);
    expect(result.originalOutcome).toBe("FLAGGED");
    expect(result.newOutcome).toBe("APPROVED");
    expect(result.decisionProvenance).toBe("OPERATOR_ASSERTED");
  });

  it("refuses an override made by a different officer", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([
        log("DecisionOverridden", [OVERRIDE_ID, DECISION_ID, STRANGER, 1, 0]),
      ]),
    );
    await expect(
      verifyDecisionOverride(config, overrideInput, env),
    ).rejects.toMatchObject({
      reason: "AI_OFFICER_MISMATCH",
      statusCode: 403,
    });
  });

  it("refuses an override that applies to a DIFFERENT decision", async () => {
    mockGetCanonicalTransaction.mockResolvedValue(
      canonical([
        log("DecisionOverridden", [
          OVERRIDE_ID,
          `0x${"bb".repeat(32)}`,
          OFFICER,
          1,
          0,
        ]),
      ]),
    );
    await expect(
      verifyDecisionOverride(config, overrideInput, env),
    ).rejects.toMatchObject({ reason: "AI_DECISION_MISMATCH" });
  });

  it("refuses when the module does not report the decision as overridden", async () => {
    // The event is history; the flag is the contract agreeing.
    routeCalls({ decision: chainDecision({ overridden: false }) });
    await expect(
      verifyDecisionOverride(config, overrideInput, env),
    ).rejects.toMatchObject({ reason: "AI_OVERRIDE_NOT_RECORDED" });
  });

  it("refuses when the module has no such decision", async () => {
    routeCalls({ decision: chainDecision({ timestamp: 0 }) });
    await expect(
      verifyDecisionOverride(config, overrideInput, env),
    ).rejects.toMatchObject({ reason: "AI_DECISION_UNKNOWN" });
  });
});

describe("AIExecutionError", () => {
  it("defaults to 422", () => {
    expect(new AIExecutionError("AI_REVERTED", "x").statusCode).toBe(422);
  });
});
