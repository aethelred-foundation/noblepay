// ============================================================
// NoblePay TypeScript Type Definitions
// Core domain types for the cross-border payment platform
// ============================================================

// ---------------------------------------------------------------------------
// Payment Types
// ---------------------------------------------------------------------------

/** On-chain payment status enum (mirrors contract uint8) */
export enum PaymentStatus {
  Pending = 0,
  Screening = 1,
  Passed = 2,
  Flagged = 3,
  Blocked = 4,
  Settled = 5,
  Refunded = 6,
}

/** Human-readable payment status labels */
export type PaymentStatusLabel =
  | 'Pending'
  | 'Screening'
  | 'Passed'
  | 'Flagged'
  | 'Blocked'
  | 'Settled'
  | 'Refunded';

/** A single cross-border payment record */
export interface Payment {
  /** Unique payment identifier (bytes32) */
  id: string;
  /** Sender wallet address */
  sender: string;
  /** Recipient wallet address */
  recipient: string;
  /** Payment amount in token units (human-readable) */
  amount: number;
  /** Raw amount in smallest units (bigint string) */
  amountRaw: string;
  /** Token address used for payment */
  token: string;
  /** Token symbol (e.g. 'USDC', 'AET') */
  tokenSymbol: string;
  /** Current payment status */
  status: PaymentStatusLabel;
  /** Compliance result hash (bytes32) */
  complianceHash: string;
  /** Timestamp when payment was initiated (Unix ms) */
  initiatedAt: number;
  /** Timestamp when payment was settled (Unix ms), 0 if not settled */
  settledAt: number;
  /** Sender jurisdiction (ISO 3166-1 alpha-2) */
  senderJurisdiction: string;
  /** Recipient jurisdiction (ISO 3166-1 alpha-2) */
  recipientJurisdiction: string;
  /** Optional memo attached to the payment */
  memo?: string;
  /** Risk score from compliance screening (0-100) */
  riskScore?: number;
}

/** A batch of payments submitted together */
export interface PaymentBatch {
  /** Batch identifier */
  batchId: string;
  /** Individual payments in this batch */
  payments: Payment[];
  /** Total value across all payments (USD equivalent) */
  totalValue: number;
  /** Batch status */
  status: 'Processing' | 'Complete' | 'PartialFailure';
  /** Timestamp of batch creation */
  createdAt: number;
  /** Number of payments that passed screening */
  passedCount: number;
  /** Number of payments that were flagged/blocked */
  flaggedCount: number;
}

// ---------------------------------------------------------------------------
// Compliance Types
// ---------------------------------------------------------------------------

/** Compliance screening result status */
export enum ComplianceStatus {
  Pending = 'Pending',
  InProgress = 'InProgress',
  Clear = 'Clear',
  Review = 'Review',
  Escalated = 'Escalated',
  Rejected = 'Rejected',
}

/** Detailed compliance screening result for a payment */
export interface ComplianceResult {
  /** The payment this result belongs to */
  paymentId: string;
  /** Overall compliance status */
  status: ComplianceStatus;
  /** AML risk score (0-100) */
  riskScore: number;
  /** Sanctions lists that were screened */
  sanctionsListsChecked: string[];
  /** Whether any sanctions matches were found */
  sanctionsMatch: boolean;
  /** PEP (Politically Exposed Person) match */
  pepMatch: boolean;
  /** Adverse media match */
  adverseMediaMatch: boolean;
  /** TEE attestation bytes (hex string) */
  attestation: string;
  /** TEE node that performed the screening */
  teeNodeId: string;
  /** Screening start timestamp (Unix ms) */
  startedAt: number;
  /** Screening completion timestamp (Unix ms) */
  completedAt: number;
  /** Human-readable reason for flagging, if applicable */
  flagReason?: string;
}

// ---------------------------------------------------------------------------
// Business Types
// ---------------------------------------------------------------------------

/** Business KYC verification status */
export enum KYCStatus {
  NotStarted = 0,
  Pending = 1,
  Verified = 2,
  Rejected = 3,
  Expired = 4,
}

/** Business tier levels */
export enum BusinessTier {
  Standard = 0,
  Premium = 1,
  Enterprise = 2,
}

/** Registered business entity */
export interface Business {
  /** On-chain owner address */
  owner: string;
  /** Legal business name */
  name: string;
  /** Jurisdiction of registration (ISO 3166-1 alpha-2) */
  jurisdiction: string;
  /** Business tier level */
  tier: BusinessTier;
  /** Current KYC status */
  kycStatus: KYCStatus;
  /** Registration timestamp (Unix ms) */
  registeredAt: number;
  /** Daily payment limit (USD) */
  dailyLimit: number;
  /** Monthly payment limit (USD) */
  monthlyLimit: number;
  /** Amount used today (USD) */
  dailyUsed: number;
  /** Amount used this month (USD) */
  monthlyUsed: number;
}

/** Business registration form data */
export interface BusinessRegistration {
  /** Legal business name */
  name: string;
  /** Jurisdiction of registration */
  jurisdiction: string;
  /** KYC document hash (SHA-256) */
  kycDocumentHash: string;
  /** Trade license number */
  tradeLicenseNumber?: string;
  /** Contact email */
  contactEmail?: string;
}

// ---------------------------------------------------------------------------
// Travel Rule Types
// ---------------------------------------------------------------------------

/** FATF Travel Rule data for a payment */
export interface TravelRuleData {
  /** Associated payment ID */
  paymentId: string;
  /** Whether data has been submitted */
  submitted: boolean;
  /** Whether data has been verified */
  verified: boolean;
  /** Hash of the submitted data (bytes32) */
  dataHash: string;
  /** Submission timestamp (Unix ms) */
  submittedAt: number;
  /** Originator information (encrypted in transit) */
  originator?: {
    name: string;
    accountNumber: string;
    institution: string;
    jurisdiction: string;
  };
  /** Beneficiary information (encrypted in transit) */
  beneficiary?: {
    name: string;
    accountNumber: string;
    institution: string;
    jurisdiction: string;
  };
}

// ---------------------------------------------------------------------------
// Sanctions & AML Types
// ---------------------------------------------------------------------------

/** Result of a sanctions list check against a single entity */
export interface SanctionsCheckResult {
  /** Sanctions list identifier (e.g. 'OFAC', 'UN') */
  listId: string;
  /** Whether a match was found */
  matched: boolean;
  /** Confidence score (0-100) */
  confidence: number;
  /** Matched entity name, if any */
  matchedName?: string;
  /** Matched entity ID on the sanctions list */
  matchedId?: string;
  /** Timestamp of the check */
  checkedAt: number;
}

/** AML risk scoring result */
export interface AMLRiskScore {
  /** Overall risk score (0-100) */
  score: number;
  /** Risk level classification */
  level: 'Low' | 'Medium' | 'High' | 'Critical';
  /** Individual risk factor contributions */
  factors: {
    jurisdictionRisk: number;
    transactionPatternRisk: number;
    counterpartyRisk: number;
    volumeRisk: number;
    sanctionsProximity: number;
  };
  /** Timestamp of the assessment */
  assessedAt: number;
}

// ---------------------------------------------------------------------------
// TEE Types
// ---------------------------------------------------------------------------

/** TEE attestation record from the compliance oracle */
export interface TEEAttestation {
  /** TEE node identifier */
  nodeId: string;
  /** Whether the attestation is valid */
  valid: boolean;
  /** Attestation bytes (hex) */
  attestationData: string;
  /** Timestamp of last attestation */
  lastAttestation: number;
  /** Number of screenings processed by this node */
  processedCount: number;
  /** Node uptime percentage (0-100) */
  uptime: number;
}

/** Individual screening result from TEE processing */
export interface ScreeningResult {
  /** Payment ID that was screened */
  paymentId: string;
  /** Screening outcome */
  outcome: 'Pass' | 'Fail' | 'Review';
  /** TEE node that performed the screening */
  teeNodeId: string;
  /** Time taken for screening (ms) */
  processingTime: number;
  /** Risk score assigned */
  riskScore: number;
  /** Timestamp of completion */
  completedAt: number;
}

// ---------------------------------------------------------------------------
// Audit & Reporting Types
// ---------------------------------------------------------------------------

/** Audit log entry for compliance tracking */
export interface AuditLogEntry {
  /** Unique audit entry ID */
  id: string;
  /** Type of audited action */
  action:
    | 'PAYMENT_INITIATED'
    | 'COMPLIANCE_CHECK'
    | 'SANCTIONS_SCREEN'
    | 'TRAVEL_RULE_SUBMIT'
    | 'PAYMENT_SETTLED'
    | 'PAYMENT_REFUNDED'
    | 'BUSINESS_REGISTERED'
    | 'KYC_UPDATED'
    | 'TIER_CHANGED'
    | 'RISK_ESCALATION';
  /** Actor (wallet address or system identifier) */
  actor: string;
  /** Subject entity (payment ID, business address, etc.) */
  subject: string;
  /** Human-readable description */
  description: string;
  /** Additional metadata */
  metadata?: Record<string, string | number | boolean>;
  /** Timestamp (Unix ms) */
  timestamp: number;
  /** Transaction hash, if on-chain */
  txHash?: string;
}

/** Compliance report for regulatory submission */
export interface ComplianceReport {
  /** Report identifier */
  reportId: string;
  /** Reporting period start (Unix ms) */
  periodStart: number;
  /** Reporting period end (Unix ms) */
  periodEnd: number;
  /** Total payments processed */
  totalPayments: number;
  /** Total value processed (USD) */
  totalVolume: number;
  /** Number of payments flagged */
  flaggedPayments: number;
  /** Number of payments blocked */
  blockedPayments: number;
  /** Average screening time (ms) */
  avgScreeningTime: number;
  /** Compliance pass rate (0-100) */
  passRate: number;
  /** Breakdown by jurisdiction */
  jurisdictionBreakdown: Record<string, { count: number; volume: number }>;
  /** Generated timestamp */
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Dashboard & Analytics Types
// ---------------------------------------------------------------------------

/** Dashboard summary metrics */
export interface DashboardMetrics {
  /** Total payments processed today */
  todayPayments: number;
  /** Total payments pending screening */
  pendingScreening: number;
  /** Total flagged payments requiring review */
  flaggedCount: number;
  /** Daily payment volume (USD) */
  dailyVolume: number;
  /** Monthly payment volume (USD) */
  monthlyVolume: number;
  /** Average screening time (ms) */
  avgScreeningTime: number;
  /** Compliance pass rate (percentage, 0-100) */
  compliancePassRate: number;
  /** Number of active businesses */
  activeBusinesses: number;
  /** Total value locked in escrow (USD) */
  escrowBalance: number;
}

/** Time-series analytics data point */
export interface AnalyticsData {
  /** Timestamp for this data point */
  timestamp: number;
  /** Human-readable label (e.g. 'Mon', 'Jan 15') */
  label: string;
  /** Payment volume (USD) */
  volume: number;
  /** Number of transactions */
  txCount: number;
  /** Average risk score */
  avgRiskScore: number;
  /** Pass rate for this period */
  passRate: number;
  /** Number of flagged payments */
  flaggedCount: number;
}

// ---------------------------------------------------------------------------
// Notification Types
// ---------------------------------------------------------------------------

/** Notification payload for the toast system */
export interface NotificationPayload {
  /** Notification type */
  type: 'success' | 'error' | 'warning' | 'info';
  /** Short title */
  title: string;
  /** Descriptive message */
  message: string;
  /** Optional payment ID link */
  paymentId?: string;
  /** Optional action URL */
  actionUrl?: string;
  /** Optional action label */
  actionLabel?: string;
}
