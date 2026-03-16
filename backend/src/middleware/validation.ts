import { z } from "zod";
import { Request, Response, NextFunction } from "express";

// ─── Common Validators ─────────────────────────────────────────────────────

const ethereumAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address");

const bytes32Hash = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid bytes32 hash");

const positiveDecimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "Must be a positive decimal number")
  .refine((val) => parseFloat(val) > 0, "Amount must be greater than zero");

const currencyCode = z
  .string()
  .min(2)
  .max(10)
  .regex(/^[A-Z0-9]+$/, "Currency must be uppercase alphanumeric");

const paginationParams = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

const dateRange = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

// ─── Payment Schemas ────────────────────────────────────────────────────────

export const CreatePaymentSchema = z.object({
  sender: ethereumAddress,
  recipient: ethereumAddress,
  amount: positiveDecimal,
  currency: currencyCode,
  purposeHash: bytes32Hash.optional(),
  metadata: z.record(z.string()).optional(),
});

export const ListPaymentsSchema = paginationParams.merge(dateRange).extend({
  status: z.enum([
    "PENDING", "SCREENING", "APPROVED", "SETTLED",
    "CANCELLED", "REFUNDED", "FLAGGED", "REJECTED",
  ]).optional(),
  sender: ethereumAddress.optional(),
  recipient: ethereumAddress.optional(),
  currency: currencyCode.optional(),
  minAmount: positiveDecimal.optional(),
  maxAmount: positiveDecimal.optional(),
});

export const BatchPaymentSchema = z.object({
  payments: z.array(CreatePaymentSchema).min(1).max(100),
});

// ─── Business Schemas ───────────────────────────────────────────────────────

export const CreateBusinessSchema = z.object({
  address: ethereumAddress,
  licenseNumber: z.string().min(1).max(100),
  businessName: z.string().min(1).max(255),
  jurisdiction: z.string().min(2).max(100),
  businessType: z.string().min(1).max(100),
  complianceOfficer: z.string().max(255).optional(),
  contactEmail: z.string().email(),
});

export const UpdateBusinessSchema = z.object({
  businessName: z.string().min(1).max(255).optional(),
  complianceOfficer: z.string().max(255).optional(),
  contactEmail: z.string().email().optional(),
  businessType: z.string().min(1).max(100).optional(),
});

export const ListBusinessesSchema = paginationParams.extend({
  kycStatus: z.enum([
    "UNVERIFIED", "PENDING", "VERIFIED", "REJECTED", "EXPIRED", "SUSPENDED",
  ]).optional(),
  tier: z.enum(["STARTER", "STANDARD", "ENTERPRISE", "INSTITUTIONAL"]).optional(),
  jurisdiction: z.string().optional(),
});

// ─── Compliance Schemas ─────────────────────────────────────────────────────

export const ComplianceScreeningSchema = z.object({
  paymentId: z.string().uuid(),
  priority: z.enum(["normal", "high", "urgent"]).default("normal"),
});

export const ReviewDecisionSchema = z.object({
  decision: z.enum(["approve", "reject", "escalate"]),
  reason: z.string().min(1).max(1000),
  reviewerAddress: ethereumAddress,
});

// ─── Audit Schemas ──────────────────────────────────────────────────────────

export const ListAuditSchema = paginationParams.merge(dateRange).extend({
  eventType: z.enum([
    "PAYMENT_CREATED", "PAYMENT_SCREENED", "PAYMENT_APPROVED",
    "PAYMENT_SETTLED", "PAYMENT_CANCELLED", "PAYMENT_REFUNDED",
    "PAYMENT_FLAGGED", "COMPLIANCE_SCREENING", "COMPLIANCE_PASSED",
    "COMPLIANCE_FAILED", "COMPLIANCE_ESCALATED", "BUSINESS_REGISTERED",
    "BUSINESS_VERIFIED", "BUSINESS_SUSPENDED", "BUSINESS_UPGRADED",
    "SANCTIONS_UPDATED", "TEE_ATTESTATION", "API_KEY_CREATED",
    "API_KEY_REVOKED", "SYSTEM_EVENT",
  ]).optional(),
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  actor: z.string().optional(),
});

export const AuditExportSchema = z.object({
  format: z.enum(["json", "csv"]).default("json"),
  from: z.string().datetime(),
  to: z.string().datetime(),
  eventTypes: z.array(z.string()).optional(),
  includeMetadata: z.boolean().default(false),
});

// ─── Validation Middleware Factory ──────────────────────────────────────────

type SchemaLocation = "body" | "query" | "params";

/**
 * Creates Express middleware that validates request data against a Zod schema.
 * On failure, returns a 400 response with structured validation errors.
 */
export function validate<T extends z.ZodType>(
  schema: T,
  source: SchemaLocation = "body",
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      }));

      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: errors,
      });
      return;
    }

    // Replace the source data with parsed/coerced values
    (req as unknown as Record<string, unknown>)[source] = result.data;
    next();
  };
}

// ─── Type Exports ───────────────────────────────────────────────────────────

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type ListPaymentsInput = z.infer<typeof ListPaymentsSchema>;
export type BatchPaymentInput = z.infer<typeof BatchPaymentSchema>;
export type CreateBusinessInput = z.infer<typeof CreateBusinessSchema>;
export type UpdateBusinessInput = z.infer<typeof UpdateBusinessSchema>;
export type ComplianceScreeningInput = z.infer<typeof ComplianceScreeningSchema>;
export type ReviewDecisionInput = z.infer<typeof ReviewDecisionSchema>;
export type AuditExportInput = z.infer<typeof AuditExportSchema>;
