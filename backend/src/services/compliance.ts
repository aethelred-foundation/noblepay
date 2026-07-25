import {
  PrismaClient,
  ComplianceStatus,
  PaymentStatus,
  Prisma,
  Payment,
  ComplianceSubmissionIntent,
} from "@prisma/client";
import { logger } from "../lib/logger";
import {
  screeningDuration,
  compliancePassRate,
  flaggedPayments,
} from "../lib/metrics";
import { AuditService } from "./audit";
import {
  configuredSanctionsMaxAgeMs,
  decimalToSmallestUnits,
  loadNoblePayChainConfiguration,
  parseExternalComplianceUrl,
  tokenForCurrency,
} from "../lib/production-config";
import {
  ComplianceSubmissionVerifier,
  ComplianceVerificationError,
  EthersComplianceSubmissionVerifier,
  VerifiedComplianceSubmission,
} from "./compliance-chain";
import { readBoundedJsonResponse } from "../lib/bounded-response";
import { AuthorizedTravelRulePayload, TravelRuleService } from "./travel-rule";

function complianceServiceUrl(): string | null {
  if (!process.env.COMPLIANCE_API_URL) return null;
  try {
    return parseExternalComplianceUrl(process.env.COMPLIANCE_API_URL).origin;
  } catch {
    return null;
  }
}

/**
 * Map Rust compliance engine status values (Passed/Flagged/Blocked) to
 * Prisma ComplianceStatus enum values (PENDING/PASSED/FAILED/UNDER_REVIEW/ESCALATED).
 * Also accepts already-mapped Prisma values for idempotency.
 */
function mapComplianceStatus(rustStatus: string): ComplianceStatus | null {
  const mapping: Record<string, ComplianceStatus> = {
    // Rust enum variants -> Prisma ComplianceStatus
    Passed: "PASSED" as ComplianceStatus,
    Flagged: "UNDER_REVIEW" as ComplianceStatus,
    Blocked: "FAILED" as ComplianceStatus,
    // Already-mapped Prisma values (idempotent passthrough)
    PENDING: "PENDING" as ComplianceStatus,
    PASSED: "PASSED" as ComplianceStatus,
    FAILED: "FAILED" as ComplianceStatus,
    UNDER_REVIEW: "UNDER_REVIEW" as ComplianceStatus,
    ESCALATED: "ESCALATED" as ComplianceStatus,
  };
  return mapping[rustStatus] || null;
}

export interface ScreeningRequest {
  paymentId: string;
  priority: "normal" | "high" | "urgent";
}

export interface ScreeningResult {
  id: string;
  paymentId: string;
  sanctionsClear: boolean;
  amlRiskScore: number;
  travelRuleCompliant: boolean;
  status: ComplianceStatus;
  flagReason: string | null;
  screenedBy: string;
  screeningDuration: number;
  submissionTxHash: string;
  submissionBlockNumber: string;
  confirmations: number;
}

export interface ComplianceMetrics {
  totalScreenings: number;
  passedScreenings: number;
  failedScreenings: number;
  averageRiskScore: number;
  averageScreeningDuration: number;
  passRate: number;
  flaggedCount: number;
  underReviewCount: number;
}

export interface SanctionsStatus {
  lastUpdated: Date;
  listsLoaded: string[];
  totalEntries: number;
  status: "fresh";
  source: string;
  datasetGeneratedAt: Date;
  datasetDigest: string;
}

interface VerifiedScreeningEvidence {
  requestId: string;
  sanctionsClear: boolean;
  amlRiskScore: number;
  travelRuleCompliant: boolean;
  status: ComplianceStatus;
  flagReason: string | null;
  investigationHash: string;
  attestation: string;
  screeningDuration: number;
  verified: VerifiedComplianceSubmission;
  travelRuleRequired: boolean;
  travelRuleRecordId: string | null;
  travelRulePayloadCommitment: string | null;
}

const REQUIRED_SANCTIONS_LISTS = [
  "OFAC",
  "UAE Central Bank",
  "UN",
  "EU",
] as const;

/** Validate the exact health metadata emitted by the Rust compliance service. */
export function validateSanctionsMetadata(
  payload: Record<string, unknown>,
  now = Date.now(),
  maxAgeMs = configuredSanctionsMaxAgeMs(),
): SanctionsStatus {
  const totalEntries = payload.total_entries;
  const lastUpdatedValues = payload.last_updated;
  const source = payload.source;
  const generatedAtValue = payload.dataset_generated_at;
  const datasetDigest = payload.dataset_digest;
  if (
    typeof totalEntries !== "number" ||
    !Number.isSafeInteger(totalEntries) ||
    totalEntries <= 0 ||
    !lastUpdatedValues ||
    typeof lastUpdatedValues !== "object" ||
    Array.isArray(lastUpdatedValues) ||
    typeof source !== "string" ||
    !source.trim() ||
    /(?:mock|test|fixture)/i.test(source) ||
    typeof generatedAtValue !== "string" ||
    typeof datasetDigest !== "string" ||
    !/^(?:sha256:)?[a-fA-F0-9]{64}$/.test(datasetDigest)
  ) {
    throw new ComplianceError(
      "SANCTIONS_DATASET_INVALID",
      "Sanctions service returned incomplete or non-production dataset metadata",
      503,
    );
  }

  const timestamps = lastUpdatedValues as Record<string, unknown>;
  const parsedListDates = REQUIRED_SANCTIONS_LISTS.map((list) => {
    const raw = timestamps[list];
    if (typeof raw !== "string") {
      throw new ComplianceError(
        "SANCTIONS_DATASET_INVALID",
        `Sanctions service is missing ${list} freshness metadata`,
        503,
      );
    }
    const parsed = new Date(raw);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getTime() > now + 5 * 60 * 1000 ||
      now - parsed.getTime() > maxAgeMs
    ) {
      throw new ComplianceError(
        "SANCTIONS_DATASET_STALE",
        `${list} sanctions data is stale`,
        503,
      );
    }

    return parsed;
  });
  const datasetGeneratedAt = new Date(generatedAtValue);
  if (
    Number.isNaN(datasetGeneratedAt.getTime()) ||
    datasetGeneratedAt.getTime() > now + 5 * 60 * 1000 ||
    now - datasetGeneratedAt.getTime() > maxAgeMs
  ) {
    throw new ComplianceError(
      "SANCTIONS_DATASET_STALE",
      "Sanctions dataset generation timestamp is stale",
      503,
    );
  }

  return {
    lastUpdated: new Date(
      Math.min(...parsedListDates.map((value) => value.getTime())),
    ),
    listsLoaded: [...REQUIRED_SANCTIONS_LISTS],
    totalEntries,
    status: "fresh",
    source: source.trim(),
    datasetGeneratedAt,
    datasetDigest: datasetDigest.toLowerCase(),
  };
}

export class ComplianceService {
  private readonly submissionVerifier: ComplianceSubmissionVerifier;
  private readonly travelRuleService: TravelRuleService;

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
    submissionVerifier?: ComplianceSubmissionVerifier,
    travelRuleService?: TravelRuleService,
  ) {
    this.submissionVerifier =
      submissionVerifier || new EthersComplianceSubmissionVerifier();
    this.travelRuleService =
      travelRuleService || new TravelRuleService(this.prisma);
  }

  /**
   * Submit a payment for compliance screening via TEE compliance engine.
   */
  async submitForScreening(
    request: ScreeningRequest,
    businessId = "__unauthenticated__",
  ): Promise<ScreeningResult> {
    const startTime = Date.now();

    const payment = await this.prisma.payment.findFirst({
      where: { id: request.paymentId, businessId },
    });

    if (!payment) {
      throw new ComplianceError("PAYMENT_NOT_FOUND", "Payment not found", 404);
    }

    if (payment.status !== "PENDING") {
      const [existing, completedIntent] = await Promise.all([
        this.prisma.complianceScreening.findFirst({
          where: {
            paymentId: payment.paymentId,
            payment: { businessId },
            submissionTxHash: { not: null },
          },
          orderBy: { createdAt: "desc" },
        }),
        this.prisma.complianceSubmissionIntent.findUnique({
          where: { paymentId: payment.id },
        }),
      ]);
      if (
        existing?.submissionTxHash &&
        existing.submissionBlockNumber !== null
      ) {
        return {
          id: existing.id,
          paymentId: payment.paymentId,
          sanctionsClear: existing.sanctionsClear,
          amlRiskScore: existing.amlRiskScore,
          travelRuleCompliant: existing.travelRuleCompliant,
          status: existing.status,
          flagReason: existing.flagReason,
          screenedBy: existing.screenedBy,
          screeningDuration: existing.screeningDuration,
          submissionTxHash: existing.submissionTxHash,
          submissionBlockNumber: existing.submissionBlockNumber.toString(),
          confirmations:
            completedIntent?.submissionTxHash?.toLowerCase() ===
            existing.submissionTxHash.toLowerCase()
              ? (completedIntent.confirmations ?? 0)
              : 0,
        };
      }
      throw new ComplianceError(
        "INVALID_STATE",
        `Payment is in ${payment.status} state, expected PENDING`,
        409,
      );
    }

    // Configuration validation is local and may fail before an intent is
    // needed. The durable intent is still guaranteed to exist before the
    // first request crosses into the external operator.
    if (!complianceServiceUrl() || !process.env.COMPLIANCE_API_KEY) {
      throw new ComplianceError(
        "COMPLIANCE_SUBMISSION_NOT_CONFIGURED",
        "The audited compliance submission service is not configured",
        501,
      );
    }

    // Persist the deterministic request before crossing the external trust
    // boundary. A retry always reuses the payment DB UUID, allowing the
    // operator to replay its original transaction instead of submitting again.
    const intent = await this.prisma.complianceSubmissionIntent.upsert({
      where: { paymentId: payment.id },
      create: { paymentId: payment.id, requestId: payment.id },
      update: {},
    });
    if (intent.requestId !== payment.id) {
      throw new ComplianceError(
        "COMPLIANCE_INTENT_CORRUPT",
        "Compliance request identity does not match the payment",
        503,
      );
    }

    let screeningResult: VerifiedScreeningEvidence;
    if (intent.state === "PENDING") {
      const submitted = await this.requestVerifiedComplianceSubmission(
        payment,
        intent.requestId,
      );
      screeningResult = await this.persistVerifiedComplianceEvidence(payment, {
        ...submitted,
        screeningDuration: Date.now() - startTime,
      });
    } else {
      screeningResult = await this.recoverVerifiedComplianceEvidence(
        payment,
        intent,
      );
    }
    screeningResult = await this.revalidateComplianceEvidence(
      payment,
      screeningResult,
    );
    const elapsed = screeningResult.screeningDuration;

    let newStatus: PaymentStatus;
    if (screeningResult.status === "PASSED") {
      newStatus = "APPROVED";
    } else if (screeningResult.status === "FAILED") {
      newStatus = "REJECTED";
    } else {
      newStatus = "FLAGGED";
    }

    const screening = await this.prisma.$transaction(
      async (transaction) => {
        const current = await transaction.payment.findFirst({
          where: { id: payment.id, businessId, status: "PENDING" },
        });
        if (!current) {
          const replay = await transaction.complianceScreening.findUnique({
            where: { submissionTxHash: screeningResult.verified.txHash },
          });
          if (replay) {
            await transaction.complianceSubmissionIntent.updateMany({
              where: {
                paymentId: payment.id,
                submissionTxHash: screeningResult.verified.txHash,
              },
              data: { state: "COMPLETED", completedAt: new Date() },
            });
            return replay;
          }
          throw new ComplianceError(
            "PAYMENT_STATE_CHANGED",
            "Payment state changed during screening",
            409,
          );
        }

        const created = await transaction.complianceScreening.create({
          data: {
            paymentId: payment.paymentId,
            sanctionsClear: screeningResult.sanctionsClear,
            amlRiskScore: screeningResult.amlRiskScore,
            travelRuleCompliant: screeningResult.travelRuleCompliant,
            status: screeningResult.status,
            flagReason: screeningResult.flagReason,
            investigationHash: screeningResult.investigationHash,
            attestation: screeningResult.attestation,
            engineRequestId: screeningResult.requestId,
            submissionTxHash: screeningResult.verified.txHash,
            submissionBlockNumber: screeningResult.verified.blockNumber,
            screenedBy: screeningResult.verified.signer,
            screeningDuration: elapsed,
          },
        });
        await transaction.payment.update({
          where: { id: payment.id },
          data: {
            status: newStatus,
            riskScore: screeningResult.amlRiskScore,
            teeAttestation: screeningResult.attestation,
            screenedAt: new Date(),
          },
        });
        await transaction.complianceSubmissionIntent.update({
          where: { paymentId: payment.id },
          data: { state: "COMPLETED", completedAt: new Date() },
        });
        if (
          screeningResult.travelRuleRequired &&
          screeningResult.travelRuleRecordId &&
          screeningResult.travelRulePayloadCommitment
        ) {
          const shared = await transaction.travelRuleRecord.updateMany({
            where: {
              id: screeningResult.travelRuleRecordId,
              paymentId: payment.paymentId,
              payloadCommitment: screeningResult.travelRulePayloadCommitment,
              shared: false,
            },
            data: {
              shared: true,
              sharedWith: [complianceServiceUrl()!],
              sharedAt: new Date(),
              submissionTxHash: screeningResult.verified.txHash.toLowerCase(),
              submissionBlockNumber: screeningResult.verified.blockNumber,
            },
          });
          if (shared.count !== 1) {
            throw new ComplianceError(
              "TRAVEL_RULE_SHARE_STATE_CHANGED",
              "Travel Rule sharing state changed during compliance commit",
              409,
            );
          }
        }

        const eventType =
          screeningResult.status === "PASSED"
            ? "COMPLIANCE_PASSED"
            : screeningResult.status === "FAILED"
              ? "COMPLIANCE_FAILED"
              : "COMPLIANCE_ESCALATED";
        await this.auditService.createAuditEntryInTransaction(transaction, {
          businessId,
          eventType,
          actor: screeningResult.verified.signer,
          description: `Verified on-chain compliance ${screeningResult.status} for payment ${payment.paymentId}`,
          severity: screeningResult.status === "PASSED" ? "INFO" : "HIGH",
          blockNumber: screeningResult.verified.blockNumber,
          txHash: screeningResult.verified.txHash,
          metadata: {
            paymentId: payment.paymentId,
            amlRiskScore: screeningResult.amlRiskScore,
            sanctionsClear: screeningResult.sanctionsClear,
            travelRuleCompliant: screeningResult.travelRuleCompliant,
            engineRequestId: screeningResult.requestId,
            confirmations: screeningResult.verified.confirmations,
          },
        });
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    // Record metrics
    const resultLabel =
      screeningResult.status === "PASSED" ? "passed" : "failed";
    screeningDuration.observe({ result: resultLabel }, elapsed / 1000);

    // Update pass rate gauge
    await this.updatePassRateMetric();

    logger.info("Verified on-chain compliance screening complete", {
      paymentId: payment.paymentId,
      status: screeningResult.status,
      riskScore: screeningResult.amlRiskScore,
      duration: elapsed,
      txHash: screeningResult.verified.txHash,
    });

    return {
      id: screening.id,
      paymentId: payment.paymentId,
      sanctionsClear: screeningResult.sanctionsClear,
      amlRiskScore: screeningResult.amlRiskScore,
      travelRuleCompliant: screeningResult.travelRuleCompliant,
      status: screeningResult.status,
      flagReason: screeningResult.flagReason,
      screenedBy: screeningResult.verified.signer,
      screeningDuration: elapsed,
      submissionTxHash: screeningResult.verified.txHash,
      submissionBlockNumber: screeningResult.verified.blockNumber.toString(),
      confirmations: screeningResult.verified.confirmations,
    };
  }

  /**
   * Get screening result for a payment.
   */
  async getScreeningResult(
    paymentId: string,
    businessId = "__unauthenticated__",
  ) {
    const screenings = await this.prisma.complianceScreening.findMany({
      where: { paymentId, payment: { businessId } },
      orderBy: { createdAt: "desc" },
    });

    if (screenings.length === 0) {
      throw new ComplianceError(
        "SCREENING_NOT_FOUND",
        "No screening found for this payment",
        404,
      );
    }

    return screenings;
  }

  /**
   * Get compliance metrics.
   */
  async getComplianceMetrics(
    businessId = "__unauthenticated__",
  ): Promise<ComplianceMetrics> {
    const screeningScope: Prisma.ComplianceScreeningWhereInput = {
      payment: { businessId },
    };
    const [
      total,
      passed,
      failed,
      avgRisk,
      avgDuration,
      flaggedCount,
      underReview,
    ] = await Promise.all([
      this.prisma.complianceScreening.count({ where: screeningScope }),
      this.prisma.complianceScreening.count({
        where: { ...screeningScope, status: "PASSED" },
      }),
      this.prisma.complianceScreening.count({
        where: { ...screeningScope, status: "FAILED" },
      }),
      this.prisma.complianceScreening.aggregate({
        where: screeningScope,
        _avg: { amlRiskScore: true },
      }),
      this.prisma.complianceScreening.aggregate({
        where: screeningScope,
        _avg: { screeningDuration: true },
      }),
      this.prisma.payment.count({ where: { businessId, status: "FLAGGED" } }),
      this.prisma.complianceScreening.count({
        where: { ...screeningScope, status: "UNDER_REVIEW" },
      }),
    ]);

    const passRate = total > 0 ? passed / total : 0;

    return {
      totalScreenings: total,
      passedScreenings: passed,
      failedScreenings: failed,
      averageRiskScore: avgRisk._avg.amlRiskScore || 0,
      averageScreeningDuration: avgDuration._avg.screeningDuration || 0,
      passRate,
      flaggedCount,
      underReviewCount: underReview,
    };
  }

  /**
   * Trigger a sanctions list refresh.
   */
  async updateSanctionsList(actor = "__unauthenticated__"): Promise<{
    status: "updated";
    totalEntries: number;
    updatedAt: Date;
    source: string;
    datasetGeneratedAt: Date;
    datasetDigest: string;
  }> {
    const serviceUrl = complianceServiceUrl();
    if (!serviceUrl || !process.env.COMPLIANCE_API_KEY) {
      throw new ComplianceError(
        "SANCTIONS_SERVICE_UNAVAILABLE",
        "Sanctions service is not configured",
        503,
      );
    }

    try {
      const response = await fetch(`${serviceUrl}/v1/sanctions/update`, {
        method: "POST",
        headers: { "X-API-Key": process.env.COMPLIANCE_API_KEY },
        signal: AbortSignal.timeout(30_000),
      });
      const payload =
        await readBoundedJsonResponse<Record<string, unknown>>(response);
      if (!response.ok || payload.success !== true) {
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `HTTP ${response.status}`,
        );
      }
    } catch (error) {
      logger.error("Sanctions list update failed closed", {
        error: (error as Error).message,
      });
      throw new ComplianceError(
        "SANCTIONS_SERVICE_UNAVAILABLE",
        "Sanctions list update could not be verified",
        503,
      );
    }

    // A successful refresh acknowledgement alone is insufficient. Re-read
    // health and verify freshness for every required source before reporting
    // the update as usable.
    const parsed = await this.getSanctionsStatus();

    await this.auditService.createAuditEntry({
      eventType: "SANCTIONS_UPDATED",
      actor,
      description: `Sanctions dataset updated from ${parsed.source}`,
      severity: "INFO",
      metadata: {
        totalEntries: parsed.totalEntries,
        updatedAt: parsed.lastUpdated.toISOString(),
        source: parsed.source,
        datasetGeneratedAt: parsed.datasetGeneratedAt.toISOString(),
        datasetDigest: parsed.datasetDigest,
      },
    });

    return {
      status: "updated",
      totalEntries: parsed.totalEntries,
      updatedAt: parsed.lastUpdated,
      source: parsed.source,
      datasetGeneratedAt: parsed.datasetGeneratedAt,
      datasetDigest: parsed.datasetDigest,
    };
  }

  /**
   * Get sanctions list freshness status.
   */
  async getSanctionsStatus(): Promise<SanctionsStatus> {
    const serviceUrl = complianceServiceUrl();
    if (!serviceUrl) {
      throw new ComplianceError(
        "SANCTIONS_SERVICE_UNAVAILABLE",
        "Sanctions service is not configured",
        503,
      );
    }

    let payload: Record<string, unknown>;
    try {
      const response = await fetch(`${serviceUrl}/v1/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      payload = await readBoundedJsonResponse<Record<string, unknown>>(
        response,
        256 * 1024,
      );
      if (!response.ok || payload.status !== "healthy")
        throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      logger.error("Sanctions health check failed closed", {
        error: (error as Error).message,
      });
      throw new ComplianceError(
        "SANCTIONS_SERVICE_UNAVAILABLE",
        "Sanctions dataset health could not be verified",
        503,
      );
    }

    const metadata = payload.sanctions_lists;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new ComplianceError(
        "SANCTIONS_DATASET_INVALID",
        "Sanctions service returned incomplete dataset metadata",
        503,
      );
    }
    return validateSanctionsMetadata(metadata as Record<string, unknown>);
  }

  /**
   * Get flagged payments awaiting review.
   */
  async getFlaggedPayments(
    businessIdOrPage: string | number = "__unauthenticated__",
    pageOrLimit: number = 1,
    explicitLimit: number = 20,
  ) {
    const businessId =
      typeof businessIdOrPage === "string"
        ? businessIdOrPage
        : "__unauthenticated__";
    const page =
      typeof businessIdOrPage === "number" ? businessIdOrPage : pageOrLimit;
    const limit =
      typeof businessIdOrPage === "number" ? pageOrLimit : explicitLimit;
    const [data, total] = await Promise.all([
      this.prisma.payment.findMany({
        where: { businessId, status: "FLAGGED" },
        include: { screenings: true },
        orderBy: { initiatedAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where: { businessId, status: "FLAGGED" } }),
    ]);

    flaggedPayments.set(total);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Review a flagged payment and submit a decision.
   */
  async reviewFlaggedPayment(
    paymentId: string,
    decision: "escalate",
    reason: string,
    reviewerAddress: string,
    businessId = "__unauthenticated__",
  ) {
    const payment = await this.prisma.payment.findFirst({
      where: { id: paymentId, businessId },
    });

    if (!payment) {
      throw new ComplianceError("PAYMENT_NOT_FOUND", "Payment not found", 404);
    }

    if (payment.status !== "FLAGGED") {
      throw new ComplianceError(
        "INVALID_STATE",
        `Payment is in ${payment.status} state, expected FLAGGED`,
        409,
      );
    }

    const latestScreening = await this.prisma.complianceScreening.findFirst({
      where: { paymentId: payment.paymentId, payment: { businessId } },
      orderBy: { createdAt: "desc" },
    });
    if (!latestScreening) {
      throw new ComplianceError(
        "SCREENING_NOT_FOUND",
        "Verified screening record was not found",
        404,
      );
    }

    await this.prisma.$transaction(
      async (transaction) => {
        await transaction.complianceScreening.update({
          where: { id: latestScreening.id },
          data: { status: "ESCALATED", flagReason: reason },
        });
        await this.auditService.createAuditEntryInTransaction(transaction, {
          businessId,
          eventType: "COMPLIANCE_ESCALATED",
          actor: reviewerAddress,
          description: `Flagged payment ${payment.paymentId} escalated for human/on-chain resolution — ${reason}`,
          severity: "HIGH",
          metadata: { paymentId: payment.paymentId, decision, reason },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    logger.info("Flagged payment reviewed", {
      paymentId: payment.paymentId,
      decision,
      reviewer: reviewerAddress,
    });

    return {
      paymentId: payment.paymentId,
      decision,
      newStatus: "FLAGGED" as PaymentStatus,
      reviewedBy: reviewerAddress,
      reviewedAt: new Date(),
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private async requestVerifiedComplianceSubmission(
    payment: Payment,
    requestId: string,
  ): Promise<{
    requestId: string;
    sanctionsClear: boolean;
    amlRiskScore: number;
    travelRuleCompliant: boolean;
    status: ComplianceStatus;
    flagReason: string | null;
    investigationHash: string;
    attestation: string;
    verified: VerifiedComplianceSubmission;
    travelRuleRequired: boolean;
    travelRuleRecordId: string | null;
    travelRulePayloadCommitment: string | null;
  }> {
    const serviceUrl = complianceServiceUrl();
    const apiKey = process.env.COMPLIANCE_API_KEY;
    if (!serviceUrl || !apiKey) {
      throw new ComplianceError(
        "COMPLIANCE_SUBMISSION_NOT_CONFIGURED",
        "The audited compliance submission service is not configured",
        501,
      );
    }

    let config;
    let smallestUnitAmount: string;
    try {
      config = loadNoblePayChainConfiguration();
      const token = tokenForCurrency(payment.currency, config.tokens);
      smallestUnitAmount = decimalToSmallestUnits(
        payment.amount.toString(),
        token.decimals,
      );
    } catch (error) {
      throw new ComplianceError(
        "COMPLIANCE_SUBMISSION_MISCONFIGURED",
        (error as Error).message,
        503,
      );
    }

    let travelRule:
      AuthorizedTravelRulePayload | { required: false; data: null };
    try {
      travelRule = await this.travelRuleService.loadAuthorizedPayload(payment);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        "statusCode" in error
      ) {
        throw error;
      }
      throw new ComplianceError(
        "TRAVEL_RULE_UNAVAILABLE",
        "Travel Rule authorization could not be verified",
        503,
      );
    }

    if (travelRule.required) {
      await this.travelRuleService.recordOutboundAttempt({
        paymentRecordId: payment.id,
        businessId: payment.businessId,
        recordId: travelRule.recordId,
        payloadCommitment: travelRule.payloadCommitment,
        requestId,
        destination: serviceUrl,
      });
    }

    let envelope: Record<string, unknown>;
    try {
      const response = await fetch(`${serviceUrl}/v1/screen`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
          "X-Request-Id": requestId,
          "Idempotency-Key": requestId,
        },
        body: JSON.stringify({
          request_id: requestId,
          payment: {
            id: payment.paymentId,
            sender: payment.sender,
            recipient: payment.recipient,
            amount: smallestUnitAmount,
            currency: payment.currency,
            purpose_hash: payment.purposeHash,
            metadata: {},
            timestamp: payment.initiatedAt.toISOString(),
          },
          chain_id: config.chainId.toString(10),
          contract_address: config.contractAddress,
          travel_rule_data: travelRule.data,
          travel_rule_required: travelRule.required,
          travel_rule_payload_commitment: travelRule.required
            ? travelRule.payloadCommitment
            : null,
          timeout_ms: 30_000,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      envelope =
        await readBoundedJsonResponse<Record<string, unknown>>(response);
      if (!response.ok || envelope.success !== true) {
        throw new Error(
          typeof envelope.error === "string"
            ? envelope.error
            : `HTTP ${response.status}`,
        );
      }
    } catch (error) {
      logger.error("Compliance submission service failed closed", {
        // The remote operator has seen the cleartext Travel Rule payload and
        // may echo it in an error string. Never copy an untrusted response or
        // transport message into application logs.
        failureType:
          error instanceof Error && error.name
            ? error.name
            : "UnknownComplianceSubmissionFailure",
        paymentId: payment.paymentId,
      });
      throw new ComplianceError(
        "COMPLIANCE_SUBMISSION_UNAVAILABLE",
        "The compliance result could not be submitted and verified on-chain",
        503,
      );
    }

    const result = envelope.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new ComplianceError(
        "INVALID_COMPLIANCE_RESPONSE",
        "Compliance response is missing its result",
        503,
      );
    }
    const values = result as Record<string, unknown>;
    const sanctionsClear = values.sanctions_clear;
    const amlRiskScore = values.aml_risk_score;
    const travelRuleCompliant = values.travel_rule_compliant;
    const resultStatus = values.status;
    const attestation = values.attestation;
    const investigationHash = values.investigation_hash;
    const submissionTxHash = envelope.submission_tx_hash;
    const responsePaymentId = envelope.payment_id ?? values.payment_id;
    const responseRequestId = envelope.request_id;
    const responseChainId = envelope.chain_id;
    const responseContract = envelope.contract_address;

    if (
      responseRequestId !== requestId ||
      typeof responsePaymentId !== "string" ||
      responsePaymentId.toLowerCase() !== payment.paymentId.toLowerCase() ||
      String(responseChainId) !== config.chainId.toString(10) ||
      typeof responseContract !== "string" ||
      responseContract.toLowerCase() !== config.contractAddress.toLowerCase() ||
      typeof submissionTxHash !== "string" ||
      !/^0x[a-fA-F0-9]{64}$/.test(submissionTxHash) ||
      typeof sanctionsClear !== "boolean" ||
      !Number.isInteger(amlRiskScore) ||
      (amlRiskScore as number) < 0 ||
      (amlRiskScore as number) > 100 ||
      typeof travelRuleCompliant !== "boolean" ||
      typeof resultStatus !== "string" ||
      typeof attestation !== "string" ||
      !/^(?:0x)?(?:[a-fA-F0-9]{2})+$/.test(attestation) ||
      typeof investigationHash !== "string" ||
      !/^0x[a-fA-F0-9]{64}$/.test(investigationHash)
    ) {
      throw new ComplianceError(
        "INVALID_COMPLIANCE_RESPONSE",
        "Compliance response identifiers or evidence are invalid",
        503,
      );
    }

    const mappedStatus = mapComplianceStatus(resultStatus);
    const expectedStatus: ComplianceStatus = !sanctionsClear
      ? "FAILED"
      : (amlRiskScore as number) > 70 || !travelRuleCompliant
        ? "UNDER_REVIEW"
        : "PASSED";
    if (!mappedStatus || mappedStatus !== expectedStatus) {
      throw new ComplianceError(
        "COMPLIANCE_DISPOSITION_MISMATCH",
        "Compliance service disposition does not match NoblePay contract rules",
        422,
      );
    }

    let verified: VerifiedComplianceSubmission;
    try {
      verified = await this.submissionVerifier.verify({
        txHash: submissionTxHash,
        paymentId: payment.paymentId,
        sanctionsClear,
        amlRiskScore: amlRiskScore as number,
        travelRuleCompliant,
        investigationHash,
        attestation,
      });
    } catch (error) {
      if (error instanceof ComplianceVerificationError) {
        throw new ComplianceError(error.code, error.message, error.statusCode);
      }
      throw new ComplianceError(
        "COMPLIANCE_VERIFICATION_UNAVAILABLE",
        "On-chain verification failed",
        503,
      );
    }
    if (verified.disposition !== expectedStatus) {
      throw new ComplianceError(
        "COMPLIANCE_DISPOSITION_MISMATCH",
        "Verified chain disposition is inconsistent",
        422,
      );
    }

    const riskFactors = Array.isArray(values.risk_factors)
      ? values.risk_factors
          .slice(0, 20)
          .map((factor) =>
            typeof factor === "string" ? factor : JSON.stringify(factor),
          )
      : [];
    return {
      requestId,
      sanctionsClear,
      amlRiskScore: amlRiskScore as number,
      travelRuleCompliant,
      status: expectedStatus,
      flagReason:
        riskFactors.length > 0 ? riskFactors.join("; ").slice(0, 2000) : null,
      investigationHash: investigationHash.toLowerCase(),
      attestation: attestation.startsWith("0x")
        ? attestation.toLowerCase()
        : `0x${attestation.toLowerCase()}`,
      verified,
      travelRuleRequired: travelRule.required,
      travelRuleRecordId: travelRule.required ? travelRule.recordId : null,
      travelRulePayloadCommitment: travelRule.required
        ? travelRule.payloadCommitment
        : null,
    };
  }

  /**
   * Save independently verified chain evidence before the transaction that
   * creates the final screening and advances the payment. If another worker
   * won the race, recover and validate that worker's durable evidence.
   */
  private async persistVerifiedComplianceEvidence(
    payment: Payment,
    evidence: VerifiedScreeningEvidence,
  ): Promise<VerifiedScreeningEvidence> {
    evidence = await this.revalidateComplianceEvidence(payment, evidence);
    let persisted;
    try {
      persisted = await this.prisma.complianceSubmissionIntent.updateMany({
        where: {
          paymentId: payment.id,
          requestId: evidence.requestId,
          state: "PENDING",
        },
        data: {
          state: "VERIFIED",
          sanctionsClear: evidence.sanctionsClear,
          amlRiskScore: evidence.amlRiskScore,
          travelRuleCompliant: evidence.travelRuleCompliant,
          disposition: evidence.status,
          flagReason: evidence.flagReason,
          investigationHash: evidence.investigationHash,
          attestation: evidence.attestation,
          submissionTxHash: evidence.verified.txHash,
          submissionBlockNumber: evidence.verified.blockNumber,
          screenedBy: evidence.verified.signer,
          confirmations: evidence.verified.confirmations,
          screeningDuration: evidence.screeningDuration,
          travelRuleRecordId: evidence.travelRuleRecordId,
          travelRulePayloadCommitment: evidence.travelRulePayloadCommitment,
          verifiedAt: new Date(),
        },
      });
    } catch (error) {
      logger.error("Verified compliance evidence could not be persisted", {
        error: (error as Error).message,
        paymentId: payment.paymentId,
        requestId: evidence.requestId,
        txHash: evidence.verified.txHash,
      });
      throw new ComplianceError(
        "COMPLIANCE_EVIDENCE_PERSIST_FAILED",
        "Verified compliance evidence could not be saved; retry with the same request identity",
        503,
      );
    }

    if (persisted.count === 1) return evidence;

    const durable = await this.prisma.complianceSubmissionIntent.findUnique({
      where: { paymentId: payment.id },
    });
    if (!durable) {
      throw new ComplianceError(
        "COMPLIANCE_INTENT_MISSING",
        "Compliance submission intent disappeared during verification",
        503,
      );
    }
    return this.recoverVerifiedComplianceEvidence(payment, durable);
  }

  /**
   * Repeat the complete chain verification immediately before a durable state
   * transition. The verifier performs a final chain-id, immutable-anchor,
   * receipt, transaction and receipt-block check after its pinned role/event
   * reads. Comparing that result with the previously accepted evidence keeps
   * a late reorg from advancing the intent, payment, or Travel Rule record.
   */
  private async revalidateComplianceEvidence(
    payment: Payment,
    evidence: VerifiedScreeningEvidence,
  ): Promise<VerifiedScreeningEvidence> {
    let verified: VerifiedComplianceSubmission;
    try {
      verified = await this.submissionVerifier.verify({
        txHash: evidence.verified.txHash,
        paymentId: payment.paymentId,
        sanctionsClear: evidence.sanctionsClear,
        amlRiskScore: evidence.amlRiskScore,
        travelRuleCompliant: evidence.travelRuleCompliant,
        investigationHash: evidence.investigationHash,
        attestation: evidence.attestation,
      });
    } catch (error) {
      if (error instanceof ComplianceVerificationError) {
        throw new ComplianceError(error.code, error.message, error.statusCode);
      }
      throw new ComplianceError(
        "COMPLIANCE_VERIFICATION_UNAVAILABLE",
        "On-chain compliance evidence could not be revalidated",
        503,
      );
    }

    if (
      verified.txHash.toLowerCase() !== evidence.verified.txHash.toLowerCase() ||
      verified.blockNumber !== evidence.verified.blockNumber ||
      verified.signer.toLowerCase() !== evidence.verified.signer.toLowerCase() ||
      verified.disposition !== evidence.verified.disposition
    ) {
      throw new ComplianceError(
        "COMPLIANCE_EVIDENCE_CHANGED",
        "Compliance evidence changed before the durable state transition",
        409,
      );
    }

    return { ...evidence, verified };
  }

  /** Re-verify persisted evidence so a retry can safely finish local state. */
  private async recoverVerifiedComplianceEvidence(
    payment: Payment,
    intent: ComplianceSubmissionIntent,
  ): Promise<VerifiedScreeningEvidence> {
    if (
      intent.state === "PENDING" ||
      intent.requestId !== payment.id ||
      typeof intent.sanctionsClear !== "boolean" ||
      intent.amlRiskScore === null ||
      !Number.isInteger(intent.amlRiskScore) ||
      typeof intent.travelRuleCompliant !== "boolean" ||
      !intent.disposition ||
      !intent.investigationHash ||
      !intent.attestation ||
      !intent.submissionTxHash ||
      intent.submissionBlockNumber === null ||
      !intent.screenedBy ||
      intent.confirmations === null ||
      !Number.isInteger(intent.confirmations) ||
      intent.confirmations < 0 ||
      intent.screeningDuration === null ||
      !Number.isInteger(intent.screeningDuration) ||
      intent.screeningDuration < 0
    ) {
      throw new ComplianceError(
        "COMPLIANCE_EVIDENCE_CORRUPT",
        "Persisted compliance evidence is incomplete",
        503,
      );
    }

    let travelRule:
      AuthorizedTravelRulePayload | { required: false; data: null };
    try {
      travelRule = await this.travelRuleService.loadAuthorizedPayload(payment);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        "statusCode" in error
      ) {
        throw error;
      }
      throw new ComplianceError(
        "TRAVEL_RULE_UNAVAILABLE",
        "Travel Rule authorization could not be revalidated",
        503,
      );
    }
    if (
      (travelRule.required &&
        (intent.travelRuleRecordId !== travelRule.recordId ||
          intent.travelRulePayloadCommitment?.toLowerCase() !==
            travelRule.payloadCommitment)) ||
      (!travelRule.required &&
        (intent.travelRuleRecordId !== null ||
          intent.travelRulePayloadCommitment !== null))
    ) {
      throw new ComplianceError(
        "COMPLIANCE_EVIDENCE_CORRUPT",
        "Persisted compliance evidence has inconsistent Travel Rule authorization",
        503,
      );
    }

    let verified: VerifiedComplianceSubmission;
    try {
      verified = await this.submissionVerifier.verify({
        txHash: intent.submissionTxHash,
        paymentId: payment.paymentId,
        sanctionsClear: intent.sanctionsClear,
        amlRiskScore: intent.amlRiskScore,
        travelRuleCompliant: intent.travelRuleCompliant,
        investigationHash: intent.investigationHash,
        attestation: intent.attestation,
      });
    } catch (error) {
      if (error instanceof ComplianceVerificationError) {
        throw new ComplianceError(error.code, error.message, error.statusCode);
      }
      throw new ComplianceError(
        "COMPLIANCE_VERIFICATION_UNAVAILABLE",
        "On-chain verification failed",
        503,
      );
    }

    if (
      verified.txHash.toLowerCase() !== intent.submissionTxHash.toLowerCase() ||
      verified.blockNumber !== intent.submissionBlockNumber ||
      verified.signer.toLowerCase() !== intent.screenedBy.toLowerCase() ||
      verified.disposition !== intent.disposition
    ) {
      throw new ComplianceError(
        "COMPLIANCE_EVIDENCE_CHANGED",
        "Persisted compliance evidence no longer matches the finalized chain",
        409,
      );
    }

    return {
      requestId: intent.requestId,
      sanctionsClear: intent.sanctionsClear,
      amlRiskScore: intent.amlRiskScore,
      travelRuleCompliant: intent.travelRuleCompliant,
      status: intent.disposition,
      flagReason: intent.flagReason,
      investigationHash: intent.investigationHash,
      attestation: intent.attestation,
      screeningDuration: intent.screeningDuration,
      verified,
      travelRuleRequired: travelRule.required,
      travelRuleRecordId: travelRule.required ? travelRule.recordId : null,
      travelRulePayloadCommitment: travelRule.required
        ? travelRule.payloadCommitment
        : null,
    };
  }

  private async updatePassRateMetric(): Promise<void> {
    const [total, passed] = await Promise.all([
      this.prisma.complianceScreening.count(),
      this.prisma.complianceScreening.count({ where: { status: "PASSED" } }),
    ]);

    if (total > 0) {
      compliancePassRate.set(passed / total);
    }
  }
}

// ─── Error Class ────────────────────────────────────────────────────────────

export class ComplianceError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "ComplianceError";
  }
}
