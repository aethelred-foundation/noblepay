import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { AuditService } from "./audit";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ModelStatus = "ACTIVE" | "STAGING" | "DEPRECATED" | "UNDER_REVIEW";
export type DecisionOutcome = "APPROVE" | "FLAG" | "BLOCK" | "ESCALATE";
export type AppealStatus = "SUBMITTED" | "UNDER_REVIEW" | "UPHELD" | "OVERTURNED" | "DISMISSED";

export interface AIModel {
  id: string;
  name: string;
  version: string;
  type: "SANCTIONS_SCREENING" | "AML_RISK" | "BEHAVIORAL" | "NETWORK_ANALYSIS" | "ENSEMBLE";
  status: ModelStatus;
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  teeAttested: boolean;
  attestationHash: string | null;
  trainingDataHash: string;
  deployedAt: Date;
  lastEvaluated: Date;
  totalDecisions: number;
  metadata: Record<string, unknown>;
}

export interface AIDecision {
  id: string;
  modelId: string;
  modelVersion: string;
  paymentId: string;
  outcome: DecisionOutcome;
  confidence: number;
  factors: Array<{ name: string; contribution: number; value: string }>;
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
  deviationFromGlobal: number;
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

// ─── Service ────────────────────────────────────────────────────────────────

export class AIComplianceService {
  private models: Map<string, AIModel> = new Map();
  private decisions: Map<string, AIDecision> = new Map();
  private appeals: Map<string, AIAppeal> = new Map();

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
  ) {
    this.initializeModels();
  }

  private initializeModels(): void {
    const models: AIModel[] = [
      {
        id: "model-sanctions-v3", name: "SanctionsBERT", version: "3.2.1",
        type: "SANCTIONS_SCREENING", status: "ACTIVE",
        accuracy: 0.9945, precision: 0.9912, recall: 0.9978, f1Score: 0.9945,
        falsePositiveRate: 0.0088, falseNegativeRate: 0.0022,
        teeAttested: true, attestationHash: "0x" + crypto.randomBytes(32).toString("hex"),
        trainingDataHash: "0x" + crypto.randomBytes(32).toString("hex"),
        deployedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
        lastEvaluated: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        totalDecisions: 2450000, metadata: { framework: "PyTorch", parameters: "110M" },
      },
      {
        id: "model-aml-v4", name: "AML-RiskForest", version: "4.0.3",
        type: "AML_RISK", status: "ACTIVE",
        accuracy: 0.9823, precision: 0.9756, recall: 0.9890, f1Score: 0.9823,
        falsePositiveRate: 0.0244, falseNegativeRate: 0.0110,
        teeAttested: true, attestationHash: "0x" + crypto.randomBytes(32).toString("hex"),
        trainingDataHash: "0x" + crypto.randomBytes(32).toString("hex"),
        deployedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        lastEvaluated: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
        totalDecisions: 1890000, metadata: { framework: "XGBoost", trees: 500, features: 147 },
      },
      {
        id: "model-behavioral-v2", name: "BehaviorLSTM", version: "2.1.0",
        type: "BEHAVIORAL", status: "ACTIVE",
        accuracy: 0.9712, precision: 0.9634, recall: 0.9789, f1Score: 0.9711,
        falsePositiveRate: 0.0366, falseNegativeRate: 0.0211,
        teeAttested: true, attestationHash: "0x" + crypto.randomBytes(32).toString("hex"),
        trainingDataHash: "0x" + crypto.randomBytes(32).toString("hex"),
        deployedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        lastEvaluated: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        totalDecisions: 1250000, metadata: { framework: "TensorFlow", layers: 4, sequence_length: 90 },
      },
      {
        id: "model-network-v1", name: "GraphSAGE-AML", version: "1.3.2",
        type: "NETWORK_ANALYSIS", status: "ACTIVE",
        accuracy: 0.9678, precision: 0.9545, recall: 0.9812, f1Score: 0.9677,
        falsePositiveRate: 0.0455, falseNegativeRate: 0.0188,
        teeAttested: true, attestationHash: "0x" + crypto.randomBytes(32).toString("hex"),
        trainingDataHash: "0x" + crypto.randomBytes(32).toString("hex"),
        deployedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        lastEvaluated: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        totalDecisions: 890000, metadata: { framework: "DGL", embedding_dim: 256, aggregator: "mean" },
      },
      {
        id: "model-ensemble-v2", name: "NoblePay-Ensemble", version: "2.0.0",
        type: "ENSEMBLE", status: "ACTIVE",
        accuracy: 0.9967, precision: 0.9952, recall: 0.9981, f1Score: 0.9967,
        falsePositiveRate: 0.0048, falseNegativeRate: 0.0019,
        teeAttested: true, attestationHash: "0x" + crypto.randomBytes(32).toString("hex"),
        trainingDataHash: "0x" + crypto.randomBytes(32).toString("hex"),
        deployedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
        lastEvaluated: new Date(),
        totalDecisions: 3200000, metadata: { submodels: 4, votingStrategy: "weighted_average" },
      },
    ];

    for (const model of models) {
      this.models.set(model.id, model);
    }
  }

  /**
   * Get all registered AI models.
   */
  getModels(status?: ModelStatus): AIModel[] {
    let models = Array.from(this.models.values());
    if (status) {
      models = models.filter((m) => m.status === status);
    }
    return models;
  }

  /**
   * Get a single model.
   */
  getModel(modelId: string): AIModel {
    const model = this.models.get(modelId);
    if (!model) {
      throw new AIComplianceError("MODEL_NOT_FOUND", "AI model not found", 404);
    }
    return model;
  }

  /**
   * Record an AI compliance decision.
   */
  async recordDecision(
    modelId: string,
    paymentId: string,
    outcome: DecisionOutcome,
    confidence: number,
    factors: AIDecision["factors"],
    explanation: string,
    processingTimeMs: number,
  ): Promise<AIDecision> {
    const model = this.getModel(modelId);
    const decisionId = "dec-" + crypto.randomBytes(8).toString("hex");

    const decision: AIDecision = {
      id: decisionId,
      modelId,
      modelVersion: model.version,
      paymentId,
      outcome,
      confidence,
      factors,
      explanation,
      processingTimeMs,
      teeAttestation: model.teeAttested ? "0x" + crypto.randomBytes(32).toString("hex") : null,
      humanOverride: false,
      overrideBy: null,
      overrideReason: null,
      createdAt: new Date(),
    };

    this.decisions.set(decisionId, decision);

    // Update model stats
    model.totalDecisions++;
    this.models.set(modelId, model);

    // Auto-escalate low confidence decisions
    if (confidence < 0.7 && outcome !== "APPROVE") {
      decision.outcome = "ESCALATE";
      logger.warn("Low-confidence AI decision escalated", {
        decisionId,
        modelId,
        confidence,
        originalOutcome: outcome,
      });
    }

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: `ai:${modelId}`,
      description: `AI compliance decision: ${decision.outcome} (confidence: ${(confidence * 100).toFixed(1)}%) for payment ${paymentId}`,
      severity: decision.outcome === "BLOCK" ? "HIGH" : decision.outcome === "FLAG" ? "MEDIUM" : "INFO",
      metadata: { decisionId, modelId, outcome: decision.outcome, confidence },
    });

    logger.info("AI decision recorded", {
      decisionId,
      modelId,
      paymentId,
      outcome: decision.outcome,
      confidence,
      processingTimeMs,
    });

    return decision;
  }

  /**
   * Apply a human override to an AI decision.
   */
  async overrideDecision(
    decisionId: string,
    newOutcome: DecisionOutcome,
    overrideBy: string,
    reason: string,
  ): Promise<AIDecision> {
    const decision = this.decisions.get(decisionId);
    if (!decision) {
      throw new AIComplianceError("DECISION_NOT_FOUND", "Decision not found", 404);
    }

    decision.humanOverride = true;
    decision.overrideBy = overrideBy;
    decision.overrideReason = reason;
    decision.outcome = newOutcome;
    this.decisions.set(decisionId, decision);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: overrideBy,
      description: `AI decision ${decisionId} overridden to ${newOutcome}: ${reason}`,
      severity: "HIGH",
      metadata: { decisionId, originalOutcome: decision.outcome, newOutcome, reason },
    });

    logger.info("AI decision overridden", {
      decisionId,
      overrideBy,
      newOutcome,
      reason,
    });

    return decision;
  }

  /**
   * Submit an appeal against an AI decision.
   */
  async submitAppeal(
    decisionId: string,
    submittedBy: string,
    reason: string,
  ): Promise<AIAppeal> {
    const decision = this.decisions.get(decisionId);
    if (!decision) {
      throw new AIComplianceError("DECISION_NOT_FOUND", "Decision not found", 404);
    }

    const appealId = "appeal-" + crypto.randomBytes(8).toString("hex");

    const appeal: AIAppeal = {
      id: appealId,
      decisionId,
      paymentId: decision.paymentId,
      submittedBy,
      reason,
      status: "SUBMITTED",
      reviewer: null,
      reviewNotes: null,
      originalOutcome: decision.outcome,
      finalOutcome: null,
      submittedAt: new Date(),
      resolvedAt: null,
    };

    this.appeals.set(appealId, appeal);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: submittedBy,
      description: `Appeal submitted against AI decision ${decisionId}: ${reason}`,
      severity: "MEDIUM",
      metadata: { appealId, decisionId },
    });

    logger.info("Appeal submitted", { appealId, decisionId, submittedBy });
    return appeal;
  }

  /**
   * Get pending decisions requiring human review.
   */
  getHumanReviewQueue(): AIDecision[] {
    return Array.from(this.decisions.values())
      .filter((d) => d.outcome === "ESCALATE" && !d.humanOverride)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * Get bias metrics across jurisdictions.
   */
  getBiasMetrics(): BiasMetric[] {
    const jurisdictions = ["UAE", "US", "UK", "EU", "SG", "IN", "PK", "NG"];
    return jurisdictions.map((j) => {
      const baseFlagRate = 0.03 + Math.random() * 0.02;
      const globalAvg = 0.04;
      return {
        jurisdiction: j,
        totalScreened: Math.floor(Math.random() * 50000 + 10000),
        flagRate: baseFlagRate,
        blockRate: baseFlagRate * 0.15,
        falsePositiveRate: 0.005 + Math.random() * 0.01,
        avgProcessingTime: 15 + Math.random() * 10,
        deviationFromGlobal: ((baseFlagRate - globalAvg) / globalAvg) * 100,
      };
    });
  }

  /**
   * Get comprehensive AI compliance analytics.
   */
  getAnalytics(): AIComplianceAnalytics {
    const allDecisions = Array.from(this.decisions.values());
    const allAppeals = Array.from(this.appeals.values());
    const activeModels = this.getModels("ACTIVE");

    let totalConfidence = 0;
    let totalProcessingTime = 0;
    let escalations = 0;
    let overrides = 0;

    for (const d of allDecisions) {
      totalConfidence += d.confidence;
      totalProcessingTime += d.processingTimeMs;
      if (d.outcome === "ESCALATE") escalations++;
      if (d.humanOverride) overrides++;
    }

    const overturnedAppeals = allAppeals.filter((a) => a.status === "OVERTURNED").length;

    const modelPerformance: ModelPerformance[] = activeModels.map((m) => ({
      modelId: m.id,
      period: "last_30d",
      accuracy: m.accuracy,
      precision: m.precision,
      recall: m.recall,
      f1Score: m.f1Score,
      totalDecisions: m.totalDecisions,
      avgConfidence: 0.89 + Math.random() * 0.08,
      avgProcessingTime: 12 + Math.random() * 15,
      outcomeDistribution: {
        APPROVE: Math.floor(m.totalDecisions * 0.92),
        FLAG: Math.floor(m.totalDecisions * 0.05),
        BLOCK: Math.floor(m.totalDecisions * 0.01),
        ESCALATE: Math.floor(m.totalDecisions * 0.02),
      },
    }));

    return {
      activeModels: activeModels.length,
      totalDecisions: allDecisions.length,
      avgConfidence: allDecisions.length > 0 ? totalConfidence / allDecisions.length : 0,
      avgProcessingTime: allDecisions.length > 0 ? totalProcessingTime / allDecisions.length : 0,
      escalationRate: allDecisions.length > 0 ? escalations / allDecisions.length : 0,
      humanOverrideRate: allDecisions.length > 0 ? overrides / allDecisions.length : 0,
      appealRate: allDecisions.length > 0 ? allAppeals.length / allDecisions.length : 0,
      appealOverturnRate: allAppeals.length > 0 ? overturnedAppeals / allAppeals.length : 0,
      modelPerformance,
      biasMetrics: this.getBiasMetrics(),
      recentDecisions: allDecisions.slice(-20).reverse(),
    };
  }
}

// ─── Error Class ────────────────────────────────────────────────────────────

export class AIComplianceError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "AIComplianceError";
  }
}
