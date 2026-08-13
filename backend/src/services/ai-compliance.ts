import {
  AIAppeal as PrismaAIAppeal,
  AIDecision as PrismaAIDecision,
  AIModelRegistry,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { AuditService } from "./audit";
import {
  CHAIN_APPEAL_STATUS_TO_DB,
  CHAIN_OUTCOME_TO_DB,
  DECISION_PROVENANCE,
  verifyAppealFiling,
  verifyAppealResolution,
  verifyAppealReview,
  verifyDecisionOverride,
} from "./ai-compliance-execution";
import type { NoblePayChainConfiguration } from "../lib/production-config";

export type ModelStatus = "ACTIVE" | "STAGING" | "DEPRECATED" | "UNDER_REVIEW";
export type DecisionOutcome = "APPROVE" | "FLAG" | "BLOCK" | "ESCALATE";
export type AppealStatus =
  "SUBMITTED" | "UNDER_REVIEW" | "UPHELD" | "OVERTURNED" | "DISMISSED";

export interface AIModel {
  id: string;
  name: string;
  version: string;
  type: string;
  status: ModelStatus;
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
  teeAttested: boolean;
  attestationHash: string | null;
  trainingDataHash: string | null;
  deployedAt: Date;
  lastEvaluated: Date | null;
  totalDecisions: number;
  metadata: Record<string, unknown>;
}

export interface DecisionFactor {
  name: string;
  contribution: number;
  value: string;
}

export interface AIDecision {
  id: string;
  modelId: string;
  modelVersion: string;
  paymentId: string;
  outcome: DecisionOutcome;
  originalOutcome: DecisionOutcome;
  confidence: number;
  riskScore: number;
  factors: DecisionFactor[];
  explanation: string;
  processingTimeMs: number;
  teeAttestation: string | null;
  humanOverride: boolean;
  overrideBy: string | null;
  overrideReason: string | null;
  createdAt: Date;
}

export interface AIAppeal {
  id: string;
  decisionId: string;
  paymentId: string;
  submittedBy: string;
  reason: string;
  status: AppealStatus;
  externalReference: string;
  reviewer: string | null;
  reviewNotes: string | null;
  originalOutcome: DecisionOutcome;
  finalOutcome: DecisionOutcome | null;
  submittedAt: Date;
  resolvedAt: Date | null;
  onChainAppealId: string | null;
  reviewStartedAt: Date | null;
  /**
   * What the chain evidence covers. The appeal lifecycle is verified; the
   * decision it contests is an AI_OPERATOR_ROLE assertion, because
   * recordDecision checks no attestation and never reads the evidenceHash it
   * stores. Carried on the record so the distinction cannot be lost between
   * here and a compliance report. See docs/audit/NP-AI-01.
   */
  decisionProvenance: typeof DECISION_PROVENANCE | null;
}

export interface BiasMetric {
  jurisdiction: string;
  totalScreened: number;
  flagRate: number;
  blockRate: number;
  falsePositiveRate: number;
  avgProcessingTime: number;
  deviationFromGlobal: number | null;
}

export interface ModelPerformance {
  modelId: string;
  period: string;
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  totalDecisions: number;
  avgConfidence: number;
  avgProcessingTime: number;
  outcomeDistribution: Record<DecisionOutcome, number>;
}

export interface AIComplianceAnalytics {
  activeModels: number;
  totalDecisions: number;
  avgConfidence: number;
  avgProcessingTime: number;
  escalationRate: number;
  humanOverrideRate: number;
  appealRate: number;
  appealOverturnRate: number;
  modelPerformance: ModelPerformance[];
  biasMetrics: BiasMetric[];
  recentDecisions: AIDecision[];
}

const OUTCOMES = new Set<DecisionOutcome>([
  "APPROVE",
  "FLAG",
  "BLOCK",
  "ESCALATE",
]);
const MODEL_STATUSES = new Set<ModelStatus>([
  "ACTIVE",
  "STAGING",
  "DEPRECATED",
  "UNDER_REVIEW",
]);

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function parseFactors(value: Prisma.JsonValue): DecisionFactor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((factor) => {
    if (!factor || Array.isArray(factor) || typeof factor !== "object")
      return [];
    const object = factor as Record<string, unknown>;
    if (
      typeof object.name !== "string" ||
      typeof object.contribution !== "number" ||
      typeof object.value !== "string"
    )
      return [];
    return [
      {
        name: object.name,
        contribution: object.contribution,
        value: object.value,
      },
    ];
  });
}

/**
 * Durable, tenant-scoped read model for historical AI compliance records.
 *
 * Mutations intentionally fail closed. The retired HTTPS adapter authenticated
 * a service but could not prove that a decision came from a provisioned model
 * measurement or bind the response to an on-chain TEE receipt. Re-enabling a
 * mutation requires a concrete verifier implementation, not an environment
 * switch or test-only bypass.
 */
export class AIComplianceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly auditService: AuditService,
    private readonly _unsupportedEngine: null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getModels(status?: ModelStatus): Promise<AIModel[]> {
    const models = await this.prisma.aIModelRegistry.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ deployedAt: "desc" }, { id: "asc" }],
    });
    return models.map((model) => this.toModel(model));
  }

  async getModel(modelId: string): Promise<AIModel> {
    const model = await this.prisma.aIModelRegistry.findUnique({
      where: { id: modelId },
    });
    if (!model)
      throw new AIComplianceError("MODEL_NOT_FOUND", "AI model not found", 404);
    return this.toModel(model);
  }

  async runDecision(
    modelId: string,
    paymentId: string,
    businessId: string,
    idempotencyKey: string,
  ): Promise<never> {
    void modelId;
    void paymentId;
    void businessId;
    void idempotencyKey;
    throw new AIComplianceError(
      "AI_DECISION_VERIFICATION_UNAVAILABLE",
      "AI decision execution is disabled until model provisioning and cryptographic TEE/on-chain receipt verification are configured",
      501,
    );
  }

  /**
   * Record a human override that has already been made on chain.
   *
   * The new outcome comes from the receipt, not from the caller. The contract
   * refuses an override that does not change the outcome, so a caller-supplied
   * outcome could only ever agree with the chain or be wrong.
   */
  async overrideDecision(
    decisionId: string,
    overrideBy: string,
    reason: string,
    businessId: string,
    override: { txHash: string; onChainOverrideId: string },
    config: NoblePayChainConfiguration,
  ): Promise<AIDecision> {
    const decision = await this.prisma.aIDecision.findFirst({
      where: { id: decisionId, businessId },
    });
    if (!decision) {
      throw new AIComplianceError("DECISION_NOT_FOUND", "Decision not found", 404);
    }
    if (!decision.onChainDecisionId) {
      throw new AIComplianceError(
        "DECISION_NOT_ON_CHAIN",
        "This decision has no on-chain id, so an override receipt cannot be matched to it",
        409,
      );
    }
    if (decision.overriddenAt) {
      return this.toDecision(decision);
    }

    const verified = await verifyDecisionOverride(config, {
      txHash: override.txHash,
      onChainOverrideId: override.onChainOverrideId,
      onChainDecisionId: decision.onChainDecisionId,
      expectedOfficer: overrideBy,
    });

    const updated = await this.prisma.aIDecision.update({
      where: { id: decision.id },
      data: {
        originalDecision: CHAIN_OUTCOME_TO_DB[verified.originalOutcome],
        decision: CHAIN_OUTCOME_TO_DB[verified.newOutcome],
        overriddenBy: verified.officer,
        overrideReason: reason,
        overriddenAt: verified.at,
        onChainOverrideId: verified.onChainOverrideId,
        overrideTxHash: verified.txHash,
      },
    });

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: overrideBy,
      description: `AI decision overridden on chain: ${decision.id} ${verified.originalOutcome} to ${verified.newOutcome} via ${verified.txHash}`,
      severity: "HIGH",
      businessId,
      metadata: {
        decisionId: decision.id,
        onChainOverrideId: verified.onChainOverrideId,
        txHash: verified.txHash,
        blockNumber: verified.blockNumber,
        decisionProvenance: verified.decisionProvenance,
      },
    });

    return this.toDecision(updated);
  }

  /**
   * Record an appeal that has already been filed on chain.
   *
   * The appellant is bound to the caller by the receipt, so an appeal cannot be
   * filed on someone else's behalf and recorded as theirs.
   */
  async submitAppeal(
    decisionId: string,
    submittedBy: string,
    reason: string,
    businessId: string,
    filing: { txHash: string; onChainAppealId: string },
    config: NoblePayChainConfiguration,
  ): Promise<AIAppeal> {
    const decision = await this.prisma.aIDecision.findFirst({
      where: { id: decisionId, businessId },
    });
    if (!decision) {
      throw new AIComplianceError("DECISION_NOT_FOUND", "Decision not found", 404);
    }
    if (!decision.onChainDecisionId) {
      throw new AIComplianceError(
        "DECISION_NOT_ON_CHAIN",
        "This decision has no on-chain id, so an appeal receipt cannot be matched to it",
        409,
      );
    }

    const existing = await this.prisma.aIAppeal.findFirst({
      where: { onChainAppealId: filing.onChainAppealId.toLowerCase() },
    });
    if (existing) {
      if (existing.filedTxHash === filing.txHash.toLowerCase()) {
        return this.toAppeal(existing);
      }
      throw new AIComplianceError(
        "APPEAL_ALREADY_RECORDED",
        `This on-chain appeal is already recorded under ${existing.filedTxHash ?? "an unrecorded transaction"}`,
        409,
      );
    }

    const verified = await verifyAppealFiling(config, {
      txHash: filing.txHash,
      onChainAppealId: filing.onChainAppealId,
      onChainDecisionId: decision.onChainDecisionId,
      expectedAppellant: submittedBy,
    });

    const created = await this.prisma.aIAppeal.create({
      data: {
        decisionId: decision.id,
        businessId,
        paymentId: decision.paymentId,
        submittedBy: verified.appellant,
        reason,
        status: CHAIN_APPEAL_STATUS_TO_DB[verified.chainStatus] as AppealStatus,
        externalReference: verified.onChainAppealId,
        originalOutcome: decision.decision,
        submittedAt: verified.at,
        onChainAppealId: verified.onChainAppealId,
        filedTxHash: verified.txHash,
      },
    });

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: submittedBy,
      description: `AI decision appealed on chain: ${decision.id} via ${verified.txHash}`,
      severity: "HIGH",
      businessId,
      metadata: {
        appealId: created.id,
        onChainAppealId: verified.onChainAppealId,
        txHash: verified.txHash,
        blockNumber: verified.blockNumber,
        decisionProvenance: verified.decisionProvenance,
      },
    });

    return this.toAppeal(created);
  }

  /**
   * Record a compliance officer taking up an appeal review.
   *
   * This step had no API counterpart even though the contract requires it: an
   * appeal cannot be resolved until it reaches UNDER_REVIEW, and only a
   * COMPLIANCE_OFFICER_ROLE holder can put it there. Without this method an
   * appeal record would jump straight from SUBMITTED to a final outcome, losing
   * the one step that shows the appeal received human consideration.
   */
  async startAppealReview(
    appealId: string,
    reviewer: string,
    businessId: string,
    review: { txHash: string },
    config: NoblePayChainConfiguration,
  ): Promise<AIAppeal> {
    const appeal = await this.prisma.aIAppeal.findFirst({
      where: { id: appealId, businessId },
    });
    if (!appeal) {
      throw new AIComplianceError("APPEAL_NOT_FOUND", "Appeal not found", 404);
    }
    if (!appeal.onChainAppealId) {
      throw new AIComplianceError(
        "APPEAL_NOT_ON_CHAIN",
        "This appeal has no on-chain id, so a review receipt cannot be matched to it",
        409,
      );
    }
    if (appeal.status !== "SUBMITTED") {
      return this.toAppeal(appeal);
    }

    const verified = await verifyAppealReview(config, {
      txHash: review.txHash,
      onChainAppealId: appeal.onChainAppealId,
      expectedReviewer: reviewer,
    });

    const updated = await this.prisma.aIAppeal.update({
      where: { id: appeal.id },
      data: {
        status: "UNDER_REVIEW",
        reviewer: verified.reviewer,
        reviewStartedAt: verified.at,
        reviewTxHash: verified.txHash,
      },
    });

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: reviewer,
      description: `AI appeal review started on chain: ${appeal.id} via ${verified.txHash}`,
      severity: "MEDIUM",
      businessId,
      metadata: {
        appealId: appeal.id,
        onChainAppealId: verified.onChainAppealId,
        txHash: verified.txHash,
        blockNumber: verified.blockNumber,
      },
    });

    return this.toAppeal(updated);
  }

  /**
   * Record an appeal resolution that has already happened on chain.
   *
   * The outcome is taken from the receipt rather than the caller. An appeals
   * process exists to be contestable; letting the caller declare DISMISSED
   * while the chain says OVERTURNED would invert its result.
   */
  async resolveAppeal(
    appealId: string,
    reviewer: string,
    reviewNotes: string,
    businessId: string,
    resolution: { txHash: string },
    config: NoblePayChainConfiguration,
  ): Promise<AIAppeal> {
    const appeal = await this.prisma.aIAppeal.findFirst({
      where: { id: appealId, businessId },
    });
    if (!appeal) {
      throw new AIComplianceError("APPEAL_NOT_FOUND", "Appeal not found", 404);
    }
    if (!appeal.onChainAppealId) {
      throw new AIComplianceError(
        "APPEAL_NOT_ON_CHAIN",
        "This appeal has no on-chain id, so a resolution receipt cannot be matched to it",
        409,
      );
    }
    if (appeal.resolvedAt) {
      return this.toAppeal(appeal);
    }
    if (appeal.status !== "UNDER_REVIEW") {
      // The contract will not resolve an appeal that never entered review, so a
      // record in any other state means the review step was missed here.
      throw new AIComplianceError(
        "APPEAL_NOT_UNDER_REVIEW",
        `Appeal is ${appeal.status}; it must pass through review before it can be resolved`,
        409,
      );
    }

    const verified = await verifyAppealResolution(config, {
      txHash: resolution.txHash,
      onChainAppealId: appeal.onChainAppealId,
      expectedReviewer: reviewer,
    });

    const updated = await this.prisma.aIAppeal.update({
      where: { id: appeal.id },
      data: {
        status: CHAIN_APPEAL_STATUS_TO_DB[verified.chainStatus] as AppealStatus,
        reviewer: verified.reviewer,
        reviewNotes,
        finalOutcome: CHAIN_OUTCOME_TO_DB[verified.revisedOutcome],
        resolvedAt: verified.at,
        resolvedTxHash: verified.txHash,
      },
    });

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: reviewer,
      description: `AI appeal resolved on chain as ${verified.chainStatus}: ${appeal.id} via ${verified.txHash}`,
      // An overturned appeal means the automated decision was wrong, which is
      // the outcome a regulator will look for first.
      severity: verified.chainStatus === "OVERTURNED" ? "CRITICAL" : "HIGH",
      businessId,
      metadata: {
        appealId: appeal.id,
        onChainAppealId: verified.onChainAppealId,
        txHash: verified.txHash,
        blockNumber: verified.blockNumber,
        chainStatus: verified.chainStatus,
        revisedOutcome: verified.revisedOutcome,
        decisionProvenance: verified.decisionProvenance,
      },
    });

    return this.toAppeal(updated);
  }

  async listDecisions(filters: {
    businessId: string;
    modelId?: string;
    paymentId?: string;
    outcome?: DecisionOutcome;
    limit?: number;
  }): Promise<AIDecision[]> {
    const decisions = await this.prisma.aIDecision.findMany({
      where: {
        businessId: filters.businessId,
        ...(filters.modelId ? { modelId: filters.modelId } : {}),
        ...(filters.paymentId ? { paymentId: filters.paymentId } : {}),
        ...(filters.outcome ? { decision: filters.outcome } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: filters.limit || 50,
    });
    return decisions.map((decision) => this.toDecision(decision));
  }

  async getDecision(
    decisionId: string,
    businessId: string,
  ): Promise<AIDecision> {
    const decision = await this.prisma.aIDecision.findFirst({
      where: { id: decisionId, businessId },
    });
    if (!decision)
      throw new AIComplianceError(
        "DECISION_NOT_FOUND",
        "Decision not found",
        404,
      );
    return this.toDecision(decision);
  }

  async getHumanReviewQueue(businessId: string): Promise<AIDecision[]> {
    const decisions = await this.prisma.aIDecision.findMany({
      where: { businessId, escalated: true, overriddenBy: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
    });
    return decisions.map((decision) => this.toDecision(decision));
  }

  async listAppeals(businessId: string): Promise<AIAppeal[]> {
    const appeals = await this.prisma.aIAppeal.findMany({
      where: { businessId },
      orderBy: [{ submittedAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    return appeals.map((appeal) => this.toAppeal(appeal));
  }

  async getBiasMetrics(businessId: string): Promise<BiasMetric[]> {
    const [business, total, grouped, average, appeals, overturned] =
      await Promise.all([
        this.prisma.business.findUnique({
          where: { id: businessId },
          select: { jurisdiction: true },
        }),
        this.prisma.aIDecision.count({ where: { businessId } }),
        this.prisma.aIDecision.groupBy({
          by: ["decision"],
          where: { businessId },
          _count: { _all: true },
        }),
        this.prisma.aIDecision.aggregate({
          where: { businessId },
          _avg: { processingTimeMs: true },
        }),
        this.prisma.aIAppeal.count({ where: { businessId } }),
        this.prisma.aIAppeal.count({
          where: { businessId, status: "OVERTURNED" },
        }),
      ]);
    if (!business || total === 0) return [];
    const counts = Object.fromEntries(
      grouped.map((row) => [row.decision, row._count._all]),
    );
    return [
      {
        jurisdiction: business.jurisdiction,
        totalScreened: total,
        flagRate: ((counts.FLAG || 0) + (counts.ESCALATE || 0)) / total,
        blockRate: (counts.BLOCK || 0) / total,
        falsePositiveRate: appeals > 0 ? overturned / appeals : 0,
        avgProcessingTime: average._avg.processingTimeMs || 0,
        deviationFromGlobal: null,
      },
    ];
  }

  async getAnalytics(businessId: string): Promise<AIComplianceAnalytics> {
    const since = new Date(this.now().getTime() - 30 * 24 * 60 * 60 * 1000);
    const [
      models,
      total,
      average,
      escalations,
      overrides,
      appealCount,
      overturned,
      groups,
      recent,
      biasMetrics,
    ] = await Promise.all([
      this.prisma.aIModelRegistry.findMany({
        where: { isActive: true, status: "ACTIVE" },
        orderBy: { id: "asc" },
      }),
      this.prisma.aIDecision.count({ where: { businessId } }),
      this.prisma.aIDecision.aggregate({
        where: { businessId },
        _avg: { confidence: true, processingTimeMs: true },
      }),
      this.prisma.aIDecision.count({ where: { businessId, escalated: true } }),
      this.prisma.aIDecision.count({
        where: { businessId, overriddenBy: { not: null } },
      }),
      this.prisma.aIAppeal.count({ where: { businessId } }),
      this.prisma.aIAppeal.count({
        where: { businessId, status: "OVERTURNED" },
      }),
      this.prisma.aIDecision.groupBy({
        by: ["modelId", "decision"],
        where: { businessId, createdAt: { gte: since } },
        _count: { _all: true },
        _avg: { confidence: true, processingTimeMs: true },
      }),
      this.prisma.aIDecision.findMany({
        where: { businessId },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      this.getBiasMetrics(businessId),
    ]);

    const modelPerformance = models.map((model) => {
      const modelGroups = groups.filter((group) => group.modelId === model.id);
      const outcomeDistribution: Record<DecisionOutcome, number> = {
        APPROVE: 0,
        FLAG: 0,
        BLOCK: 0,
        ESCALATE: 0,
      };
      let decisions = 0;
      let confidenceTotal = 0;
      let processingTotal = 0;
      for (const group of modelGroups) {
        const count = group._count._all;
        if (OUTCOMES.has(group.decision as DecisionOutcome)) {
          outcomeDistribution[group.decision as DecisionOutcome] = count;
        }
        decisions += count;
        confidenceTotal +=
          Number(group._avg.confidence?.toString() || 0) * count;
        processingTotal += (group._avg.processingTimeMs || 0) * count;
      }
      return {
        modelId: model.id,
        period: "last_30d",
        accuracy: Number(model.accuracy.toString()),
        precision: Number(model.precision.toString()),
        recall: Number(model.recall.toString()),
        f1Score: Number(model.f1Score.toString()),
        totalDecisions: decisions,
        avgConfidence: decisions > 0 ? confidenceTotal / decisions : 0,
        avgProcessingTime: decisions > 0 ? processingTotal / decisions : 0,
        outcomeDistribution,
      };
    });

    return {
      activeModels: models.length,
      totalDecisions: total,
      avgConfidence: Number(average._avg.confidence?.toString() || 0),
      avgProcessingTime: average._avg.processingTimeMs || 0,
      escalationRate: total > 0 ? escalations / total : 0,
      humanOverrideRate: total > 0 ? overrides / total : 0,
      appealRate: total > 0 ? appealCount / total : 0,
      appealOverturnRate: appealCount > 0 ? overturned / appealCount : 0,
      modelPerformance,
      biasMetrics,
      recentDecisions: recent.map((decision) => this.toDecision(decision)),
    };
  }

  private toModel(model: AIModelRegistry): AIModel {
    const status = MODEL_STATUSES.has(model.status as ModelStatus)
      ? (model.status as ModelStatus)
      : "UNDER_REVIEW";
    return {
      id: model.id,
      name: model.name,
      version: model.version,
      type: model.type,
      status,
      accuracy: Number(model.accuracy.toString()),
      precision: Number(model.precision.toString()),
      recall: Number(model.recall.toString()),
      f1Score: Number(model.f1Score.toString()),
      falsePositiveRate:
        model.falsePositiveRate === null
          ? null
          : Number(model.falsePositiveRate.toString()),
      falseNegativeRate:
        model.falseNegativeRate === null
          ? null
          : Number(model.falseNegativeRate.toString()),
      teeAttested: model.teeAttested,
      attestationHash: model.attestationHash,
      trainingDataHash: model.trainingDataHash,
      deployedAt: model.deployedAt,
      lastEvaluated: model.lastEvaluated,
      totalDecisions: model.totalDecisions,
      metadata: jsonObject(model.metadata),
    };
  }

  private toDecision(decision: PrismaAIDecision): AIDecision {
    const outcome = OUTCOMES.has(decision.decision as DecisionOutcome)
      ? (decision.decision as DecisionOutcome)
      : "ESCALATE";
    const originalOutcome = OUTCOMES.has(
      decision.originalDecision as DecisionOutcome,
    )
      ? (decision.originalDecision as DecisionOutcome)
      : outcome;
    return {
      id: decision.id,
      modelId: decision.modelId,
      modelVersion: decision.modelVersion,
      paymentId: decision.paymentId,
      outcome,
      originalOutcome,
      confidence: Number(decision.confidence.toString()),
      riskScore: decision.riskScore,
      factors: parseFactors(decision.features),
      explanation: decision.explanation,
      processingTimeMs: decision.processingTimeMs,
      teeAttestation: decision.teeAttestation,
      humanOverride: Boolean(decision.overriddenBy),
      overrideBy: decision.overriddenBy,
      overrideReason: decision.overrideReason,
      createdAt: decision.createdAt,
    };
  }

  private toAppeal(appeal: PrismaAIAppeal): AIAppeal {
    return {
      id: appeal.id,
      decisionId: appeal.decisionId,
      paymentId: appeal.paymentId,
      submittedBy: appeal.submittedBy,
      reason: appeal.reason,
      status: appeal.status,
      externalReference: appeal.externalReference,
      reviewer: appeal.reviewer,
      reviewNotes: appeal.reviewNotes,
      originalOutcome: appeal.originalOutcome as DecisionOutcome,
      finalOutcome: appeal.finalOutcome as DecisionOutcome | null,
      submittedAt: appeal.submittedAt,
      resolvedAt: appeal.resolvedAt,
      onChainAppealId: appeal.onChainAppealId,
      reviewStartedAt: appeal.reviewStartedAt,
      decisionProvenance: appeal.onChainAppealId ? DECISION_PROVENANCE : null,
    };
  }
}

export class AIComplianceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "AIComplianceError";
  }
}
