import {
  AIAppeal as PrismaAIAppeal,
  AIDecision as PrismaAIDecision,
  AIModelRegistry,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { AuditService } from "./audit";

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
    private readonly _auditService: AuditService,
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

  async overrideDecision(
    decisionId: string,
    newOutcome: DecisionOutcome,
    overrideBy: string,
    reason: string,
    businessId: string,
  ): Promise<never> {
    void decisionId;
    void newOutcome;
    void overrideBy;
    void reason;
    void businessId;
    throw new AIComplianceError(
      "AI_DECISION_MUTATIONS_UNAVAILABLE",
      "AI decision overrides are disabled until decisions have cryptographically verified provenance",
      501,
    );
  }

  async submitAppeal(
    decisionId: string,
    submittedBy: string,
    reason: string,
    businessId: string,
  ): Promise<never> {
    void decisionId;
    void submittedBy;
    void reason;
    void businessId;
    throw new AIComplianceError(
      "AI_APPEAL_VERIFICATION_UNAVAILABLE",
      "AI appeals are disabled until the underlying decision has cryptographically verified provenance",
      501,
    );
  }

  async resolveAppeal(
    appealId: string,
    reviewer: string,
    outcome: "UPHELD" | "OVERTURNED" | "DISMISSED",
    reviewNotes: string,
    businessId: string,
    finalOutcome?: DecisionOutcome,
  ): Promise<never> {
    void appealId;
    void reviewer;
    void outcome;
    void reviewNotes;
    void businessId;
    void finalOutcome;
    throw new AIComplianceError(
      "AI_APPEAL_VERIFICATION_UNAVAILABLE",
      "AI appeal resolution is disabled until the underlying decision has cryptographically verified provenance",
      501,
    );
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
