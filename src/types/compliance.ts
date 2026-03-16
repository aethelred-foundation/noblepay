// ============================================================
// NoblePay AI Compliance Type Definitions
// Types for AI-driven compliance decisions, behavioral scoring,
// corridor risk analysis, and regulatory reporting
// ============================================================

// ---------------------------------------------------------------------------
// AI Decision Types
// ---------------------------------------------------------------------------

/** AI model decision outcome */
export type DecisionOutcome = 'Approve' | 'Flag' | 'Block' | 'Review';

/** AI confidence level classification */
export type ConfidenceLevel = 'High' | 'Medium' | 'Low';

/** An individual AI compliance decision */
export interface AIDecision {
  /** Decision identifier */
  id: string;
  /** Associated payment identifier */
  paymentId: string;
  /** Model that produced this decision */
  modelId: string;
  /** Model version string */
  modelVersion: string;
  /** Decision outcome */
  outcome: DecisionOutcome;
  /** Confidence score (0-100) */
  confidence: number;
  /** Confidence level classification */
  confidenceLevel: ConfidenceLevel;
  /** Risk score assigned (0-100) */
  riskScore: number;
  /** Key factors that influenced the decision */
  factors: string[];
  /** Processing latency in milliseconds */
  latencyMs: number;
  /** Decision timestamp (Unix ms) */
  decidedAt: number;
  /** Whether this decision was appealed */
  appealed: boolean;
  /** Appeal outcome, if appealed */
  appealOutcome?: 'Upheld' | 'Overturned' | 'Pending';
}

// ---------------------------------------------------------------------------
// AI Model Types
// ---------------------------------------------------------------------------

/** AI model operational status */
export type ModelStatus = 'Active' | 'Training' | 'Deprecated' | 'Shadow';

/** AI compliance model metadata */
export interface AIModel {
  /** Model identifier */
  id: string;
  /** Model display name */
  name: string;
  /** Model version */
  version: string;
  /** Model status */
  status: ModelStatus;
  /** Accuracy percentage (0-100) */
  accuracy: number;
  /** False positive rate (0-100) */
  falsePositiveRate: number;
  /** False negative rate (0-100) */
  falseNegativeRate: number;
  /** Total decisions made */
  totalDecisions: number;
  /** Average latency in milliseconds */
  avgLatencyMs: number;
  /** Last training timestamp (Unix ms) */
  lastTrained: number;
  /** Last deployed timestamp (Unix ms) */
  deployedAt: number;
}

// ---------------------------------------------------------------------------
// Behavioral Scoring Types
// ---------------------------------------------------------------------------

/** Behavioral risk score for a wallet or business */
export interface BehavioralScore {
  /** Entity address (wallet or business) */
  address: string;
  /** Overall behavioral score (0-100, higher = more trustworthy) */
  score: number;
  /** Score trend over 30 days */
  trend: 'Improving' | 'Stable' | 'Declining';
  /** Transaction pattern regularity (0-100) */
  patternScore: number;
  /** Counterparty quality score (0-100) */
  counterpartyScore: number;
  /** Volume consistency score (0-100) */
  volumeScore: number;
  /** Geographic risk score (0-100) */
  geographicScore: number;
  /** Time-of-day pattern score (0-100) */
  temporalScore: number;
  /** Number of data points used for scoring */
  dataPoints: number;
  /** Last updated timestamp (Unix ms) */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Corridor Risk Types
// ---------------------------------------------------------------------------

/** Risk classification for a payment corridor */
export interface CorridorRisk {
  /** Source jurisdiction (ISO 3166-1 alpha-2) */
  sourceJurisdiction: string;
  /** Destination jurisdiction (ISO 3166-1 alpha-2) */
  destJurisdiction: string;
  /** Corridor risk level */
  riskLevel: 'Low' | 'Medium' | 'High' | 'Critical';
  /** Risk score (0-100) */
  riskScore: number;
  /** Transaction volume through this corridor (USD, 30d) */
  volume30d: number;
  /** Number of flagged transactions (30d) */
  flaggedCount30d: number;
  /** Flag rate as percentage */
  flagRate: number;
  /** Active regulatory alerts for this corridor */
  activeAlerts: number;
  /** Last assessment timestamp (Unix ms) */
  assessedAt: number;
}

/** Network-level analysis across all corridors */
export interface NetworkAnalysis {
  /** Total active corridors */
  totalCorridors: number;
  /** High-risk corridor count */
  highRiskCorridors: number;
  /** Overall network risk score (0-100) */
  networkRiskScore: number;
  /** Total flagged transactions (30d) */
  totalFlagged30d: number;
  /** Corridor details */
  corridors: CorridorRisk[];
  /** Analysis timestamp (Unix ms) */
  analyzedAt: number;
}

// ---------------------------------------------------------------------------
// Regulatory Report Types
// ---------------------------------------------------------------------------

/** Regulatory report type */
export type ReportType = 'SAR' | 'CTR' | 'STR' | 'AML_QUARTERLY' | 'ANNUAL_AUDIT';

/** Regulatory report status */
export type ReportStatus = 'Draft' | 'Pending' | 'Submitted' | 'Acknowledged' | 'Rejected';

/** A regulatory compliance report */
export interface RegulatoryReport {
  /** Report identifier */
  id: string;
  /** Report type */
  type: ReportType;
  /** Target regulatory body */
  regulator: string;
  /** Jurisdiction */
  jurisdiction: string;
  /** Report status */
  status: ReportStatus;
  /** Reporting period start (Unix ms) */
  periodStart: number;
  /** Reporting period end (Unix ms) */
  periodEnd: number;
  /** Number of transactions covered */
  transactionCount: number;
  /** Total volume covered (USD) */
  totalVolume: number;
  /** Number of suspicious activities reported */
  suspiciousActivityCount: number;
  /** Report generation timestamp (Unix ms) */
  generatedAt: number;
  /** Submission timestamp (Unix ms), 0 if not submitted */
  submittedAt: number;
  /** Filing reference number */
  filingReference?: string;
}
