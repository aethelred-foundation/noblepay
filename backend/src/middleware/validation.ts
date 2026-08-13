import { z } from "zod";
import { TravelRuleDataSchema } from "../lib/travel-rule";
import { Request, Response, NextFunction } from "express";

// ─── Common Validators ─────────────────────────────────────────────────────

const ethereumAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address");

const bytes32Hash = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid bytes32 hash");

const paymentIdentifier = z.union([z.string().uuid(), bytes32Hash]);

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

export const ListPaymentsSchema = paginationParams
  .merge(dateRange)
  .extend({
    status: z
      .enum([
        "PENDING",
        "SCREENING",
        "APPROVED",
        "SETTLED",
        "CANCELLED",
        "REFUNDED",
        "FLAGGED",
        "REJECTED",
      ])
      .optional(),
    sender: ethereumAddress.optional(),
    recipient: ethereumAddress.optional(),
    currency: currencyCode.optional(),
    minAmount: positiveDecimal.optional(),
    maxAmount: positiveDecimal.optional(),
    search: z.string().trim().min(1).max(100).optional(),
    riskLevel: z.enum(["Low", "Medium", "High", "Critical"]).optional(),
  })
  .strict();

export const BatchPaymentSchema = z.object({
  payments: z.array(CreatePaymentSchema).min(1).max(100),
});

export const ReconcilePaymentSchema = z
  .object({
    txHash: bytes32Hash,
    paymentId: bytes32Hash.optional(),
    recipient: ethereumAddress,
    amount: positiveDecimal,
    currency: currencyCode,
    purposeHash: bytes32Hash,
  })
  .strict();

export const PaymentIdentifierParamsSchema = z
  .object({
    id: paymentIdentifier,
  })
  .strict();

export const PaymentLifecycleSchema = z
  .object({
    txHash: bytes32Hash,
  })
  .strict();

// ─── Business Schemas ───────────────────────────────────────────────────────

const businessRegistrationProfileShape = {
  licenseNumber: z.string().trim(),
  businessName: z.string().trim().min(1).max(255),
  jurisdiction: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .pipe(z.enum(["UAE", "INTERNATIONAL"])),
  businessType: z.string().trim().min(1).max(100),
  complianceOfficer: ethereumAddress,
  contactEmail: z.string().trim().toLowerCase().email(),
};

function validateBusinessLicense(
  value: { licenseNumber: string; jurisdiction: "UAE" | "INTERNATIONAL" },
  context: z.RefinementCtx,
): void {
  const licenseBytes = Buffer.byteLength(value.licenseNumber, "utf8");
  if (licenseBytes < 6 || licenseBytes > 20) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["licenseNumber"],
      message: "License number must be between 6 and 20 UTF-8 bytes",
    });
  }
  if (
    value.jurisdiction === "UAE" &&
    !/^[A-Za-z0-9-]+$/.test(value.licenseNumber)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["licenseNumber"],
      message:
        "UAE license numbers may contain only letters, digits, and hyphens",
    });
  }
}

export const BusinessRegistrationProfileSchema = z
  .object({
    ...businessRegistrationProfileShape,
  })
  .strict()
  .superRefine(validateBusinessLicense);

export const CreateBusinessSchema = z
  .object({
    address: ethereumAddress,
    ...businessRegistrationProfileShape,
    txHash: bytes32Hash,
    challengeId: z.string().uuid(),
    signature: z
      .string()
      .min(4)
      .max(32_770)
      .regex(/^0x(?:[a-fA-F0-9]{2})+$/, "Invalid EVM signature"),
  })
  .strict()
  .superRefine(validateBusinessLicense);

export const UpdateBusinessSchema = z
  .object({
    contactEmail: z.string().email().optional(),
    businessType: z.string().min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one off-chain profile field is required",
  );

export const BusinessVerificationSchema = z
  .object({
    txHash: bytes32Hash,
  })
  .strict();

export const BusinessTierUpgradeSchema = z
  .object({
    txHash: bytes32Hash,
    newTier: z.enum(["PREMIUM", "ENTERPRISE"]),
  })
  .strict();

export const ListBusinessesSchema = paginationParams.extend({
  kycStatus: z
    .enum([
      "UNVERIFIED",
      "PENDING",
      "VERIFIED",
      "REJECTED",
      "EXPIRED",
      "SUSPENDED",
      "REVOKED",
    ])
    .optional(),
  tier: z.enum(["STANDARD", "PREMIUM", "ENTERPRISE"]).optional(),
  jurisdiction: z.string().optional(),
  search: z.string().trim().min(1).max(100).optional(),
});

// ─── Compliance Schemas ─────────────────────────────────────────────────────

export const ComplianceScreeningSchema = z
  .object({
    paymentId: z.string().uuid(),
    priority: z.enum(["normal", "high", "urgent"]).default("normal"),
  })
  .strict();

export const TravelRuleChallengeSchema = z
  .object({
    paymentId: z.string().uuid(),
    data: TravelRuleDataSchema,
  })
  .strict();

export const TravelRuleAuthorizationSchema = z
  .object({
    paymentId: z.string().uuid(),
    challengeId: z.string().uuid(),
    signature: z
      .string()
      .min(4)
      .max(32_770)
      .regex(/^0x(?:[a-fA-F0-9]{2})+$/, "Invalid EVM signature"),
    data: TravelRuleDataSchema,
  })
  .strict();

export const FlaggedPaymentsQuerySchema = paginationParams
  .pick({ page: true, limit: true })
  .strict();

export const ReviewDecisionSchema = z.object({
  // Approval/rejection are not off-chain API operations. They require a
  // separately deployed, receipt-verified governance transaction flow.
  decision: z.literal("escalate"),
  reason: z.string().min(1).max(1000),
});

// ─── Audit Schemas ──────────────────────────────────────────────────────────

export const ListAuditSchema = paginationParams.merge(dateRange).extend({
  eventType: z
    .enum([
      "PAYMENT_CREATED",
      "PAYMENT_SCREENED",
      "PAYMENT_APPROVED",
      "PAYMENT_SETTLED",
      "PAYMENT_CANCELLED",
      "PAYMENT_REFUNDED",
      "PAYMENT_FLAGGED",
      "COMPLIANCE_SCREENING",
      "COMPLIANCE_PASSED",
      "COMPLIANCE_FAILED",
      "COMPLIANCE_ESCALATED",
      "BUSINESS_REGISTERED",
      "BUSINESS_VERIFIED",
      "BUSINESS_SUSPENDED",
      "BUSINESS_REINSTATED",
      "BUSINESS_REVOKED",
      "BUSINESS_UPGRADED",
      "SANCTIONS_UPDATED",
      "TEE_ATTESTATION",
      "API_KEY_CREATED",
      "API_KEY_REVOKED",
      "SYSTEM_EVENT",
    ])
    .optional(),
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  actor: z.string().optional(),
});

const auditExportEventTypes = [
  "PAYMENT_CREATED",
  "PAYMENT_SCREENED",
  "PAYMENT_APPROVED",
  "PAYMENT_SETTLED",
  "PAYMENT_CANCELLED",
  "PAYMENT_REFUNDED",
  "PAYMENT_FLAGGED",
  "COMPLIANCE_SCREENING",
  "COMPLIANCE_PASSED",
  "COMPLIANCE_FAILED",
  "COMPLIANCE_ESCALATED",
  "BUSINESS_REGISTERED",
  "BUSINESS_VERIFIED",
  "BUSINESS_SUSPENDED",
  "BUSINESS_REINSTATED",
  "BUSINESS_REVOKED",
  "BUSINESS_UPGRADED",
  "SANCTIONS_UPDATED",
  "TEE_ATTESTATION",
  "API_KEY_CREATED",
  "API_KEY_REVOKED",
  "SYSTEM_EVENT",
] as const;

export const AuditExportSchema = z
  .object({
    format: z.enum(["json", "csv"]).default("json"),
    from: z.string().datetime(),
    to: z.string().datetime(),
    eventTypes: z.array(z.enum(auditExportEventTypes)).max(22).optional(),
    includeMetadata: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    const from = new Date(value.from);
    const to = new Date(value.to);
    if (from > to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "Audit export range must be ordered",
      });
      return;
    }
    if (to.getTime() - from.getTime() > 93 * 24 * 60 * 60 * 1000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "Audit exports are limited to 93 days",
      });
    }
  });

// ─── Advanced service schemas ───────────────────────────────────────────────

const opaqueResourceId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "Identifier contains unsupported characters",
  );

const advancedPositiveDecimal = z
  .string()
  .max(100)
  .regex(
    /^(?:0|[1-9]\d{0,77})(?:\.\d{1,18})?$/,
    "Must be a positive base-10 decimal with at most 18 decimal places",
  )
  .refine((value) => value !== "0" && !/^0\.0+$/.test(value), {
    message: "Amount must be greater than zero",
  });

const currencyPair = z
  .string()
  .trim()
  .regex(
    /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/,
    "Pair must use BASE/QUOTE uppercase symbols",
  );

const metadataScalar = z.union([
  z.string().max(1_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const boundedMetadata = z
  .record(
    z
      .string()
      .min(1)
      .max(100)
      .refine(
        (key) => !["__proto__", "constructor", "prototype"].includes(key),
        "Unsafe metadata key",
      ),
    metadataScalar,
  )
  .refine((value) => Object.keys(value).length <= 50, {
    message: "Metadata may contain at most 50 entries",
  })
  .optional();

const page = z.coerce.number().int().min(1).max(1_000_000).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(50);
const isoDate = z.string().datetime();

export const AdvancedResourceParamsSchema = z
  .object({ id: opaqueResourceId })
  .strict();
export const EmptyBodySchema = z.object({}).strict();

export const LiquidityPoolsQuerySchema = z
  .object({
    status: z.enum(["ACTIVE", "PAUSED", "DEPRECATED"]).optional(),
    page,
    limit,
  })
  .strict();
export const LiquidityPositionQuerySchema = z
  .object({ provider: ethereumAddress.optional(), page, limit })
  .strict();
/**
 * Liquidity settlements are reported, not requested: the provider moves
 * liquidity from their own wallet and names the transaction. Both fields are
 * verified against the chain before anything is written.
 */
export const LiquiditySettlementSchema = z
  .object({
    txHash: bytes32Hash,
    onChainPositionId: bytes32Hash,
  })
  .strict();

export const FlashLoanSettlementSchema = z
  .object({
    txHash: bytes32Hash,
    flashLoanId: bytes32Hash,
  })
  .strict();

export type LiquiditySettlement = z.infer<typeof LiquiditySettlementSchema>;
export type FlashLoanSettlement = z.infer<typeof FlashLoanSettlementSchema>;

export const AddLiquiditySchema = z
  .object({
    txHash: bytes32Hash,
    onChainPositionId: bytes32Hash,
    amountA: advancedPositiveDecimal,
    amountB: advancedPositiveDecimal,
    rangeMin: z.number().int().min(-887_272).max(887_272).optional(),
    rangeMax: z.number().int().min(-887_272).max(887_272).optional(),
    tier: z.enum(["RETAIL", "INSTITUTIONAL", "MARKET_MAKER"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.rangeMin !== undefined &&
      value.rangeMax !== undefined &&
      value.rangeMin >= value.rangeMax
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rangeMax"],
        message: "rangeMax must be greater than rangeMin",
      });
    }
  });
export const RemoveLiquiditySchema = z
  .object({
    txHash: bytes32Hash,
    onChainPositionId: bytes32Hash,
    positionId: opaqueResourceId,
    percentage: z.number().finite().gt(0).max(100),
  })
  .strict();
/**
 * A completed flash loan is reported, not requested. `amount` is deliberately
 * absent: the verifier reads it from the FlashLoanInitiated event, and
 * accepting a caller-supplied figure the service then ignores would imply it
 * carried weight.
 */
export const FlashLiquiditySchema = z
  .object({
    poolId: opaqueResourceId,
    txHash: bytes32Hash,
    flashLoanId: bytes32Hash,
  })
  .strict();

export const CreateStreamSchema = z
  .object({
    sender: ethereumAddress,
    recipient: ethereumAddress,
    totalAmount: advancedPositiveDecimal,
    currency: currencyCode,
    startTime: isoDate.optional(),
    endTime: isoDate,
    cliffDuration: z.number().int().min(0).max(31_536_000).optional(),
    ratePerSecond: advancedPositiveDecimal.optional(),
    autoCompound: z.boolean().optional(),
    metadata: boundedMetadata,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sender.toLowerCase() === value.recipient.toLowerCase()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipient"],
        message: "Sender and recipient must be different",
      });
    }
    if (
      value.startTime &&
      Date.parse(value.endTime) <= Date.parse(value.startTime)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "endTime must be after startTime",
      });
    }
  });
export const BatchStreamsSchema = z
  .object({
    streams: z.array(CreateStreamSchema).min(1).max(100),
    label: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export const StreamListQuerySchema = z
  .object({
    sender: ethereumAddress.optional(),
    recipient: ethereumAddress.optional(),
    status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"]).optional(),
    currency: currencyCode.optional(),
    page,
    limit,
  })
  .strict();
export const AdjustStreamRateSchema = z
  .object({ ratePerSecond: advancedPositiveDecimal })
  .strict();

export const FXRatesQuerySchema = z
  .object({ pair: currencyPair.optional() })
  .strict();
export const FXHedgeListQuerySchema = z
  .object({
    status: z.enum(["OPEN", "CLOSED", "EXPIRED", "EXERCISED"]).optional(),
    page,
    limit,
  })
  .strict();
export const CreateFXHedgeSchema = z
  .object({
    pair: currencyPair,
    type: z.enum(["FORWARD", "OPTION", "SWAP"]),
    notionalAmount: advancedPositiveDecimal,
    currency: currencyCode,
    strikeRate: z.number().finite().positive().optional(),
    expiryDate: isoDate,
    premium: advancedPositiveDecimal.optional(),
    marginDeposit: advancedPositiveDecimal,
    metadata: boundedMetadata,
    // The receipt for the position that already exists on chain.
    txHash: bytes32Hash,
    onChainPositionId: bytes32Hash,
    // The CONTRACT's hedge type, which `type` above cannot express: OPTION
    // says nothing about call versus put, and those are opposite positions.
    // See docs/audit/NP-FX-01.
    onChainHedgeType: z.enum(["FORWARD", "OPTION_CALL", "OPTION_PUT"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === "SWAP") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["type"],
        message:
          "FXHedgingVault cannot create a SWAP position, so one cannot be verified",
      });
    }
    const typesAgree =
      value.type === "FORWARD"
        ? value.onChainHedgeType === "FORWARD"
        : value.onChainHedgeType !== "FORWARD";
    if (value.type !== "SWAP" && !typesAgree) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["onChainHedgeType"],
        message: `A ${value.type} hedge cannot be opened as ${value.onChainHedgeType}`,
      });
    }
    if (!value.pair.startsWith(`${value.currency}/`)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currency"],
        message: "currency must match the base currency in pair",
      });
    }
    if (Date.parse(value.expiryDate) <= Date.now()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiryDate"],
        message: "expiryDate must be in the future",
      });
    }
  });

export const CrossChainRouteQuerySchema = z
  .object({
    source: opaqueResourceId,
    destination: opaqueResourceId,
    token: currencyCode,
    amount: advancedPositiveDecimal,
  })
  .strict()
  .refine((value) => value.source !== value.destination, {
    path: ["destination"],
    message: "Source and destination must be different",
  });
export const CreateCrossChainTransferSchema = z
  .object({
    sourceChain: opaqueResourceId,
    destinationChain: opaqueResourceId,
    token: currencyCode,
    amount: advancedPositiveDecimal,
    recipient: ethereumAddress,
    metadata: boundedMetadata,
    // The receipt for the escrow that already happened on the source chain.
    // Required, because a transfer record without one is an unverifiable claim
    // that funds moved.
    txHash: bytes32Hash,
    onChainTransferId: bytes32Hash,
  })
  .strict()
  .refine((value) => value.sourceChain !== value.destinationChain, {
    path: ["destinationChain"],
    message: "Source and destination chains must be different",
  });
export const CrossChainTransferListQuerySchema = z
  .object({
    sender: ethereumAddress.optional(),
    status: z
      .enum([
        "INITIATED",
        "RELAYING",
        "CONFIRMING",
        "COMPLETED",
        "FAILED",
        "STUCK",
        "RECOVERED",
      ])
      .optional(),
    sourceChain: opaqueResourceId.optional(),
    destinationChain: opaqueResourceId.optional(),
    page,
    limit,
  })
  .strict();
export const RecoverCrossChainTransferSchema = z
  .object({
    transferId: opaqueResourceId,
    // The source-chain transaction that refunded the escrow.
    txHash: bytes32Hash,
  })
  .strict();
export const AdvancedPaginationSchema = z.object({ page, limit }).strict();

const treasuryProposalTypes = [
  "TRANSFER",
  "POLICY_CHANGE",
  "YIELD_ALLOCATION",
  "EMERGENCY",
] as const;
const treasuryCategories = [
  "OPERATIONS",
  "PAYROLL",
  "MARKETING",
  "DEVELOPMENT",
  "COMPLIANCE",
  "INFRASTRUCTURE",
  "OTHER",
] as const;

export const CreateTreasuryProposalSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(5_000),
    type: z.enum(treasuryProposalTypes),
    amount: advancedPositiveDecimal.optional(),
    currency: currencyCode.optional(),
    recipient: ethereumAddress.optional(),
    category: z.enum(treasuryCategories).optional(),
    timelockHours: z.number().int().min(0).max(720).optional(),
    metadata: boundedMetadata,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.amount && (!value.currency || !value.category)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amount"],
        message: "Monetary proposals require currency and category",
      });
    }
    if (value.type === "TRANSFER" && !value.recipient) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipient"],
        message: "Transfer proposals require a recipient",
      });
    }
  });
/**
 * Execution is reported, not requested. The caller supplies the transaction
 * that settled the proposal on chain and the on-chain proposal id it settled;
 * the service verifies both against the chain before recording anything, so
 * neither field is trusted on receipt.
 */
export const ExecuteTreasuryProposalSchema = z
  .object({
    txHash: bytes32Hash,
    onChainProposalId: bytes32Hash,
  })
  .strict();

export const TreasuryProposalListQuerySchema = z
  .object({
    status: z
      .enum(["PENDING", "APPROVED", "EXECUTED", "REJECTED", "EXPIRED"])
      .optional(),
    page,
    limit,
  })
  .strict();
export const TreasuryAnalyticsQuerySchema = z
  .object({
    period: z.enum(["day", "week", "month", "quarter"]).default("month"),
  })
  .strict();

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
export type ReconcilePaymentInput = z.infer<typeof ReconcilePaymentSchema>;
export type CreateBusinessInput = z.infer<typeof CreateBusinessSchema>;
export type UpdateBusinessInput = z.infer<typeof UpdateBusinessSchema>;
export type ListBusinessesInput = z.infer<typeof ListBusinessesSchema>;
export type ComplianceScreeningInput = z.infer<
  typeof ComplianceScreeningSchema
>;
export type TravelRuleChallengeInput = z.infer<
  typeof TravelRuleChallengeSchema
>;
export type TravelRuleAuthorizationInput = z.infer<
  typeof TravelRuleAuthorizationSchema
>;
export type ReviewDecisionInput = z.infer<typeof ReviewDecisionSchema>;
export type ListAuditInput = z.infer<typeof ListAuditSchema>;
export type AuditExportInput = z.infer<typeof AuditExportSchema>;
export type LiquidityPoolsQuery = z.infer<typeof LiquidityPoolsQuerySchema>;
export type LiquidityPositionQuery = z.infer<
  typeof LiquidityPositionQuerySchema
>;
export type StreamListQuery = z.infer<typeof StreamListQuerySchema>;
export const CloseFXHedgeSchema = z.object({ txHash: bytes32Hash }).strict();

export type FXRatesQuery = z.infer<typeof FXRatesQuerySchema>;
export type CreateFXHedge = z.infer<typeof CreateFXHedgeSchema>;
export type CloseFXHedge = z.infer<typeof CloseFXHedgeSchema>;
export type FXHedgeListQuery = z.infer<typeof FXHedgeListQuerySchema>;
export type CrossChainRouteQuery = z.infer<typeof CrossChainRouteQuerySchema>;
export type CreateCrossChainTransfer = z.infer<
  typeof CreateCrossChainTransferSchema
>;
export type RecoverCrossChainTransfer = z.infer<
  typeof RecoverCrossChainTransferSchema
>;
export type CrossChainTransferListQuery = z.infer<
  typeof CrossChainTransferListQuerySchema
>;
export type AdvancedPaginationQuery = z.infer<typeof AdvancedPaginationSchema>;
export type ExecuteTreasuryProposal = z.infer<
  typeof ExecuteTreasuryProposalSchema
>;
export type TreasuryProposalListQuery = z.infer<
  typeof TreasuryProposalListQuerySchema
>;
export type TreasuryAnalyticsQuery = z.infer<
  typeof TreasuryAnalyticsQuerySchema
>;
