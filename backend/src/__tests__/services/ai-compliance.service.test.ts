const mockVerifyFiling = jest.fn();
const mockVerifyReview = jest.fn();
const mockVerifyResolution = jest.fn();
const mockVerifyOverride = jest.fn();

jest.mock("../../services/ai-compliance-execution", () => {
  const actual = jest.requireActual("../../services/ai-compliance-execution");
  return {
    ...actual,
    verifyAppealFiling: (...a: unknown[]) => mockVerifyFiling(...a),
    verifyAppealReview: (...a: unknown[]) => mockVerifyReview(...a),
    verifyAppealResolution: (...a: unknown[]) => mockVerifyResolution(...a),
    verifyDecisionOverride: (...a: unknown[]) => mockVerifyOverride(...a),
  };
});

import { Prisma } from "@prisma/client";
import {
  AIComplianceError,
  AIComplianceService,
} from "../../services/ai-compliance";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-21T00:00:00.000Z");
const TEE_HASH = `0x${"a".repeat(64)}`;

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "model-1",
    name: "Imported model record",
    version: "1.2.3",
    type: "AML_RISK",
    status: "ACTIVE",
    isActive: true,
    accuracy: new Prisma.Decimal("0.95"),
    precision: new Prisma.Decimal("0.94"),
    recall: new Prisma.Decimal("0.93"),
    f1Score: new Prisma.Decimal("0.935"),
    falsePositiveRate: new Prisma.Decimal("0.02"),
    falseNegativeRate: new Prisma.Decimal("0.01"),
    teeAttested: false,
    attestationHash: null,
    trainingDataHash: TEE_HASH,
    deployedAt: NOW,
    lastEvaluated: null,
    totalDecisions: 4,
    metadata: { source: "durable-read-model" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as any;
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: "dec-1",
    businessId: BUSINESS_ID,
    modelId: "model-1",
    modelVersion: "1.2.3",
    paymentId: "pay-1",
    engineDecisionId: "historical-engine-ref",
    idempotencyKey: "historical-key",
    decision: "ESCALATE",
    originalDecision: "ESCALATE",
    confidence: new Prisma.Decimal("0.60"),
    riskScore: 70,
    explanation: "Historical durable decision",
    features: [{ name: "velocity", contribution: 0.4, value: "high" }],
    processingTimeMs: 20,
    teeAttestation: null,
    jurisdiction: "UAE",
    escalated: true,
    overriddenBy: null,
    overrideReason: null,
    overriddenAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as any;
}

function appeal(overrides: Record<string, unknown> = {}) {
  return {
    id: "appeal-1",
    businessId: BUSINESS_ID,
    decisionId: "dec-1",
    paymentId: "pay-1",
    submittedBy: "user-1",
    reason: "Historical appeal",
    status: "SUBMITTED",
    externalReference: "historical-appeal-ref",
    reviewer: null,
    reviewNotes: null,
    originalOutcome: "ESCALATE",
    finalOutcome: null,
    submittedAt: NOW,
    resolvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as any;
}

function database() {
  const db: any = {
    aIModelRegistry: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    aIDecision: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      aggregate: jest.fn(),
      groupBy: jest.fn(),
    },
    aIAppeal: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    payment: { findFirst: jest.fn() },
    business: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  return db;
}

describe("AIComplianceService production-safe read model", () => {
  let db: ReturnType<typeof database>;
  let service: AIComplianceService;
  let audit: { createAuditEntry: jest.Mock; createAuditEntryInTransaction: jest.Mock };

  beforeEach(() => {
    db = database();
    audit = {
      createAuditEntry: jest.fn(),
      createAuditEntryInTransaction: jest.fn(),
    };
    service = new AIComplianceService(db, audit as any, null, () => NOW);
  });

  it("loads model records from durable storage without claiming TEE verification", async () => {
    db.aIModelRegistry.findMany.mockResolvedValue([model()]);
    const models = await service.getModels("ACTIVE");
    expect(models[0]).toMatchObject({
      id: "model-1",
      accuracy: 0.95,
      teeAttested: false,
    });
    expect(db.aIModelRegistry.findMany).toHaveBeenCalledWith({
      where: { status: "ACTIVE" },
      orderBy: [{ deployedAt: "desc" }, { id: "asc" }],
    });
  });

  it("normalizes imported model metadata and unknown statuses conservatively", async () => {
    db.aIModelRegistry.findMany.mockResolvedValue([
      model({
        status: "UNRECOGNIZED",
        falsePositiveRate: null,
        falseNegativeRate: null,
        metadata: ["not", "an", "object"],
      }),
    ]);

    const models = await service.getModels();

    expect(models[0]).toMatchObject({
      status: "UNDER_REVIEW",
      falsePositiveRate: null,
      falseNegativeRate: null,
      metadata: {},
    });
    expect(db.aIModelRegistry.findMany).toHaveBeenCalledWith({
      where: undefined,
      orderBy: [{ deployedAt: "desc" }, { id: "asc" }],
    });
  });

  it("loads one known model with object metadata", async () => {
    db.aIModelRegistry.findUnique.mockResolvedValue(model());

    await expect(service.getModel("model-1")).resolves.toMatchObject({
      id: "model-1",
      status: "ACTIVE",
      metadata: { source: "durable-read-model" },
    });
  });

  it("returns a stable not-found error for an unknown model", async () => {
    db.aIModelRegistry.findUnique.mockResolvedValue(null);
    await expect(service.getModel("unknown")).rejects.toMatchObject({
      code: "MODEL_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("still fails decision execution closed — no verifier can supply a model", async () => {
    // runDecision is not blocked on a receipt. It is blocked on there being a
    // model to run, and on recordDecision verifying an attestation it does not
    // verify. Opening it would mean inventing an outcome. See NP-AI-01.
    await expect(
      service.runDecision("model-1", "pay-1", BUSINESS_ID, "key"),
    ).rejects.toMatchObject({
      code: "AI_DECISION_VERIFICATION_UNAVAILABLE",
      statusCode: 501,
    });
    expect(db.aIDecision.create).not.toHaveBeenCalled();
  });

  describe("appeal and override receipts", () => {
    const chainCfg = { rpcUrl: "http://rpc.invalid", minimumConfirmations: 3 };
    const WALLET = "0x2E8625F06A696b556B7B5e0C1b34B1cb55203af1";
    const TX = `0x${"c".repeat(64)}`;
    const CHAIN_ID = `0x${"d".repeat(64)}`;

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("refuses to attach an appeal receipt to a decision with no chain id", async () => {
      db.aIDecision.findFirst.mockResolvedValue(
        decision({ onChainDecisionId: null }),
      );
      await expect(
        service.submitAppeal(
          "dec-1",
          WALLET,
          "reason",
          BUSINESS_ID,
          { txHash: TX, onChainAppealId: CHAIN_ID },
          chainCfg as never,
        ),
      ).rejects.toMatchObject({
        code: "DECISION_NOT_ON_CHAIN",
        statusCode: 409,
      });
      expect(mockVerifyFiling).not.toHaveBeenCalled();
      expect(db.aIAppeal.create).not.toHaveBeenCalled();
    });

    it("records an appeal against the decision's OWN chain id", async () => {
      // The decision id passed to the verifier must come from the record, not
      // from the caller — otherwise an appeal against decision B could be
      // filed away against decision A.
      db.aIDecision.findFirst.mockResolvedValue(
        decision({ onChainDecisionId: `0x${"e".repeat(64)}` }),
      );
      db.aIAppeal.findFirst.mockResolvedValue(null);
      db.aIAppeal.create.mockResolvedValue(appeal());
      mockVerifyFiling.mockResolvedValue({
        onChainAppealId: CHAIN_ID,
        onChainDecisionId: `0x${"e".repeat(64)}`,
        appellant: WALLET,
        groundsHash: `0x${"0".repeat(64)}`,
        chainStatus: "PENDING",
        txHash: TX,
        blockNumber: 10,
        at: new Date("2026-08-01T00:00:00.000Z"),
        decisionProvenance: "OPERATOR_ASSERTED",
      });

      await service.submitAppeal(
        "dec-1",
        WALLET,
        "reason",
        BUSINESS_ID,
        { txHash: TX, onChainAppealId: CHAIN_ID },
        chainCfg as never,
      );

      expect(mockVerifyFiling).toHaveBeenCalledWith(
        chainCfg,
        expect.objectContaining({
          onChainDecisionId: `0x${"e".repeat(64)}`,
          expectedAppellant: WALLET,
        }),
      );
      // PENDING on chain is SUBMITTED here.
      expect(db.aIAppeal.create.mock.calls[0][0].data.status).toBe("SUBMITTED");
    });

    it("will not resolve an appeal that never entered review", async () => {
      // The contract reverts with AppealNotUnderReview; the API must not be
      // able to record a resolution the chain would have refused.
      db.aIAppeal.findFirst.mockResolvedValue(
        appeal({ status: "SUBMITTED", onChainAppealId: CHAIN_ID }),
      );
      await expect(
        service.resolveAppeal(
          "appeal-1",
          WALLET,
          "notes",
          BUSINESS_ID,
          { txHash: TX },
          chainCfg as never,
        ),
      ).rejects.toMatchObject({
        code: "APPEAL_NOT_UNDER_REVIEW",
        statusCode: 409,
      });
      expect(mockVerifyResolution).not.toHaveBeenCalled();
    });

    it("takes the resolution outcome from the chain, not the caller", async () => {
      db.aIAppeal.findFirst.mockResolvedValue(
        appeal({ status: "UNDER_REVIEW", onChainAppealId: CHAIN_ID }),
      );
      db.aIAppeal.update.mockResolvedValue(appeal({ status: "OVERTURNED" }));
      mockVerifyResolution.mockResolvedValue({
        onChainAppealId: CHAIN_ID,
        onChainDecisionId: `0x${"e".repeat(64)}`,
        chainStatus: "OVERTURNED",
        revisedOutcome: "REJECTED",
        reviewer: WALLET,
        txHash: TX,
        blockNumber: 12,
        at: new Date("2026-08-02T00:00:00.000Z"),
        decisionProvenance: "OPERATOR_ASSERTED",
      });

      await service.resolveAppeal(
        "appeal-1",
        WALLET,
        "notes",
        BUSINESS_ID,
        { txHash: TX },
        chainCfg as never,
      );

      const written = db.aIAppeal.update.mock.calls[0][0].data;
      expect(written.status).toBe("OVERTURNED");
      // REJECTED on chain is BLOCK in the API vocabulary — the one mapping
      // that is a rename rather than a tense change.
      expect(written.finalOutcome).toBe("BLOCK");
    });

    it("logs an overturned appeal as CRITICAL", async () => {
      // An overturned appeal means the automated decision was wrong. That is
      // the entry a regulator looks for first.
      db.aIAppeal.findFirst.mockResolvedValue(
        appeal({ status: "UNDER_REVIEW", onChainAppealId: CHAIN_ID }),
      );
      db.aIAppeal.update.mockResolvedValue(appeal({ status: "OVERTURNED" }));
      mockVerifyResolution.mockResolvedValue({
        onChainAppealId: CHAIN_ID,
        onChainDecisionId: `0x${"e".repeat(64)}`,
        chainStatus: "OVERTURNED",
        revisedOutcome: "APPROVED",
        reviewer: WALLET,
        txHash: TX,
        blockNumber: 12,
        at: new Date("2026-08-02T00:00:00.000Z"),
        decisionProvenance: "OPERATOR_ASSERTED",
      });

      await service.resolveAppeal(
        "appeal-1",
        WALLET,
        "notes",
        BUSINESS_ID,
        { txHash: TX },
        chainCfg as never,
      );

      expect(audit.createAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({ severity: "CRITICAL" }),
      );
    });

    it("takes both override outcomes from the chain", async () => {
      db.aIDecision.findFirst.mockResolvedValue(
        decision({ onChainDecisionId: `0x${"e".repeat(64)}` }),
      );
      db.aIDecision.update.mockResolvedValue(decision());
      mockVerifyOverride.mockResolvedValue({
        onChainOverrideId: CHAIN_ID,
        onChainDecisionId: `0x${"e".repeat(64)}`,
        officer: WALLET,
        originalOutcome: "FLAGGED",
        newOutcome: "APPROVED",
        txHash: TX,
        blockNumber: 14,
        at: new Date("2026-08-03T00:00:00.000Z"),
        decisionProvenance: "OPERATOR_ASSERTED",
      });

      await service.overrideDecision(
        "dec-1",
        WALLET,
        "reason enough to override",
        BUSINESS_ID,
        { txHash: TX, onChainOverrideId: CHAIN_ID },
        chainCfg as never,
      );

      const written = db.aIDecision.update.mock.calls[0][0].data;
      expect(written.originalDecision).toBe("FLAG");
      expect(written.decision).toBe("APPROVE");
    });
  });

  it("uses authenticated-tenant predicates for durable decision history", async () => {
    db.aIDecision.findMany.mockResolvedValue([decision()]);
    const results = await service.listDecisions({
      businessId: BUSINESS_ID,
      outcome: "ESCALATE",
      limit: 10,
    });
    expect(results[0]).toMatchObject({
      id: "dec-1",
      outcome: "ESCALATE",
      humanOverride: false,
    });
    expect(db.aIDecision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId: BUSINESS_ID, decision: "ESCALATE" },
        take: 10,
      }),
    );
  });

  it("uses default limits and sanitizes untrusted imported decision fields", async () => {
    db.aIDecision.findMany.mockResolvedValue([
      decision({
        decision: "UNKNOWN",
        originalDecision: "UNKNOWN",
        overriddenBy: "reviewer-1",
        overrideReason: "historic override",
        features: [
          null,
          ["nested"],
          { name: "missing-value", contribution: 1 },
          { name: "velocity", contribution: 0.4, value: "high" },
        ],
      }),
    ]);

    const results = await service.listDecisions({ businessId: BUSINESS_ID });

    expect(results[0]).toMatchObject({
      outcome: "ESCALATE",
      originalOutcome: "ESCALATE",
      humanOverride: true,
      overrideBy: "reviewer-1",
      factors: [{ name: "velocity", contribution: 0.4, value: "high" }],
    });
    expect(db.aIDecision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId: BUSINESS_ID },
        take: 50,
      }),
    );
  });

  it("applies every optional tenant decision filter", async () => {
    db.aIDecision.findMany.mockResolvedValue([]);

    await service.listDecisions({
      businessId: BUSINESS_ID,
      modelId: "model-1",
      paymentId: "pay-1",
      outcome: "BLOCK",
      limit: 5,
    });

    expect(db.aIDecision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          businessId: BUSINESS_ID,
          modelId: "model-1",
          paymentId: "pay-1",
          decision: "BLOCK",
        },
        take: 5,
      }),
    );
  });

  it("returns a tenant-owned decision with its original valid outcome", async () => {
    db.aIDecision.findFirst.mockResolvedValue(
      decision({ decision: "APPROVE", originalDecision: "FLAG" }),
    );

    await expect(
      service.getDecision("dec-1", BUSINESS_ID),
    ).resolves.toMatchObject({
      outcome: "APPROVE",
      originalOutcome: "FLAG",
    });
  });

  it("conceals a foreign decision through a tenant-scoped lookup", async () => {
    db.aIDecision.findFirst.mockResolvedValue(null);
    await expect(
      service.getDecision("dec-foreign", BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "DECISION_NOT_FOUND",
      statusCode: 404,
    });
    expect(db.aIDecision.findFirst).toHaveBeenCalledWith({
      where: { id: "dec-foreign", businessId: BUSINESS_ID },
    });
  });

  it("reads only unresolved escalations into the human review queue", async () => {
    db.aIDecision.findMany.mockResolvedValue([decision()]);
    const queue = await service.getHumanReviewQueue(BUSINESS_ID);
    expect(queue).toHaveLength(1);
    expect(db.aIDecision.findMany).toHaveBeenCalledWith({
      where: { businessId: BUSINESS_ID, escalated: true, overriddenBy: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
    });
  });

  it("reads appeal history only within the authenticated tenant", async () => {
    db.aIAppeal.findMany.mockResolvedValue([appeal()]);
    const results = await service.listAppeals(BUSINESS_ID);
    expect(results[0]).toMatchObject({ id: "appeal-1", status: "SUBMITTED" });
    expect(db.aIAppeal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId: BUSINESS_ID } }),
    );
  });

  it("maps resolved appeal evidence without mutating it", async () => {
    db.aIAppeal.findMany.mockResolvedValue([
      appeal({
        status: "OVERTURNED",
        reviewer: "reviewer-1",
        reviewNotes: "Imported historical evidence",
        finalOutcome: "APPROVE",
        resolvedAt: NOW,
      }),
    ]);

    const results = await service.listAppeals(BUSINESS_ID);

    expect(results[0]).toMatchObject({
      reviewer: "reviewer-1",
      finalOutcome: "APPROVE",
      resolvedAt: NOW,
    });
  });

  it("derives jurisdiction metrics exclusively from persisted tenant outcomes", async () => {
    db.business.findUnique.mockResolvedValue({ jurisdiction: "UAE" });
    db.aIDecision.count.mockResolvedValue(4);
    db.aIDecision.groupBy.mockResolvedValue([
      { decision: "FLAG", _count: { _all: 1 } },
      { decision: "BLOCK", _count: { _all: 1 } },
      { decision: "APPROVE", _count: { _all: 2 } },
    ]);
    db.aIDecision.aggregate.mockResolvedValue({
      _avg: { processingTimeMs: 20 },
    });
    db.aIAppeal.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const metrics = await service.getBiasMetrics(BUSINESS_ID);
    expect(metrics[0]).toMatchObject({
      jurisdiction: "UAE",
      totalScreened: 4,
      flagRate: 0.25,
      blockRate: 0.25,
      falsePositiveRate: 0.5,
      avgProcessingTime: 20,
    });
  });

  it("returns no bias claim without a tenant record or screened decisions", async () => {
    db.business.findUnique.mockResolvedValue(null);
    db.aIDecision.count.mockResolvedValue(0);
    db.aIDecision.groupBy.mockResolvedValue([]);
    db.aIDecision.aggregate.mockResolvedValue({
      _avg: { processingTimeMs: null },
    });
    db.aIAppeal.count.mockResolvedValue(0);

    await expect(service.getBiasMetrics(BUSINESS_ID)).resolves.toEqual([]);
  });

  it("uses zero false-positive and processing rates when no evidence exists", async () => {
    db.business.findUnique.mockResolvedValue({ jurisdiction: "UAE" });
    db.aIDecision.count.mockResolvedValue(2);
    db.aIDecision.groupBy.mockResolvedValue([
      { decision: "ESCALATE", _count: { _all: 1 } },
      { decision: "APPROVE", _count: { _all: 1 } },
    ]);
    db.aIDecision.aggregate.mockResolvedValue({
      _avg: { processingTimeMs: null },
    });
    db.aIAppeal.count.mockResolvedValue(0);

    await expect(service.getBiasMetrics(BUSINESS_ID)).resolves.toEqual([
      expect.objectContaining({
        flagRate: 0.5,
        blockRate: 0,
        falsePositiveRate: 0,
        avgProcessingTime: 0,
      }),
    ]);
  });

  it("derives model performance and tenant rates from durable 30-day evidence", async () => {
    db.aIModelRegistry.findMany.mockResolvedValue([model()]);
    db.aIDecision.count
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(4);
    db.aIDecision.aggregate
      .mockResolvedValueOnce({
        _avg: { confidence: new Prisma.Decimal("0.75"), processingTimeMs: 25 },
      })
      .mockResolvedValueOnce({ _avg: { processingTimeMs: 25 } });
    db.aIAppeal.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    db.aIDecision.groupBy
      .mockResolvedValueOnce([
        {
          modelId: "model-1",
          decision: "APPROVE",
          _count: { _all: 3 },
          _avg: { confidence: new Prisma.Decimal("0.8"), processingTimeMs: 20 },
        },
        {
          modelId: "model-1",
          decision: "UNKNOWN",
          _count: { _all: 1 },
          _avg: { confidence: null, processingTimeMs: null },
        },
      ])
      .mockResolvedValueOnce([
        { decision: "APPROVE", _count: { _all: 3 } },
        { decision: "ESCALATE", _count: { _all: 1 } },
      ]);
    db.aIDecision.findMany.mockResolvedValue([decision()]);
    db.business.findUnique.mockResolvedValue({ jurisdiction: "UAE" });

    const analytics = await service.getAnalytics(BUSINESS_ID);

    expect(analytics).toMatchObject({
      activeModels: 1,
      totalDecisions: 4,
      avgConfidence: 0.75,
      avgProcessingTime: 25,
      escalationRate: 0.25,
      humanOverrideRate: 0.5,
      appealRate: 0.5,
      appealOverturnRate: 0.5,
    });
    expect(analytics.modelPerformance[0]).toMatchObject({
      modelId: "model-1",
      totalDecisions: 4,
      avgProcessingTime: 15,
      outcomeDistribution: {
        APPROVE: 3,
        FLAG: 0,
        BLOCK: 0,
        ESCALATE: 0,
      },
    });
    expect(analytics.modelPerformance[0].avgConfidence).toBeCloseTo(0.6);
    expect(analytics.biasMetrics[0]).toMatchObject({ jurisdiction: "UAE" });
    expect(analytics.recentDecisions).toHaveLength(1);
    expect(db.aIDecision.groupBy.mock.calls[0][0].where.createdAt.gte).toEqual(
      new Date("2026-06-21T00:00:00.000Z"),
    );
  });

  it("uses zero rates for an empty analytics period", async () => {
    db.aIModelRegistry.findMany.mockResolvedValue([model()]);
    db.aIDecision.count.mockResolvedValue(0);
    db.aIDecision.aggregate.mockResolvedValue({
      _avg: { confidence: null, processingTimeMs: null },
    });
    db.aIAppeal.count.mockResolvedValue(0);
    db.aIDecision.groupBy.mockResolvedValue([]);
    db.aIDecision.findMany.mockResolvedValue([]);
    db.business.findUnique.mockResolvedValue({ jurisdiction: "UAE" });

    const analytics = await service.getAnalytics(BUSINESS_ID);

    expect(analytics).toMatchObject({
      totalDecisions: 0,
      avgConfidence: 0,
      avgProcessingTime: 0,
      escalationRate: 0,
      humanOverrideRate: 0,
      appealRate: 0,
      appealOverturnRate: 0,
    });
    expect(analytics.modelPerformance[0]).toMatchObject({
      totalDecisions: 0,
      avgConfidence: 0,
      avgProcessingTime: 0,
    });
  });

  it("exposes stable typed error metadata", () => {
    const error = new AIComplianceError("MODEL_NOT_FOUND", "missing", 404);
    expect(error).toMatchObject({
      name: "AIComplianceError",
      code: "MODEL_NOT_FOUND",
      statusCode: 404,
    });
  });
});
