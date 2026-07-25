// ============================================================
// NoblePay Invoice Financing Type Definitions
// Types for invoice management, financing, and credit scoring
// ============================================================

// ---------------------------------------------------------------------------
// Invoice Types
// ---------------------------------------------------------------------------

/** Invoice status */
export type InvoiceStatus =
  | "Draft"
  | "Issued"
  | "Financed"
  | "Paid"
  | "Overdue"
  | "Disputed"
  | "Cancelled"
  | "WrittenOff";

/** An invoice record for cross-border trade financing */
export interface Invoice {
  /** Invoice identifier */
  id: string;
  /** Invoice number (human-readable) */
  invoiceNumber: string;
  /** Issuer wallet address */
  issuer: string;
  /** Payer wallet address */
  payer: string;
  /** Payer business name */
  payerName: string;
  /** Invoice amount */
  amount: number;
  outstandingAmount: number;
  financedAmount: number;
  /** Currency symbol */
  currency: string;
  /** Invoice status */
  status: InvoiceStatus;
  /** Issue date (Unix ms) */
  issuedAt: number;
  /** Due date (Unix ms) */
  dueAt: number;
  /** Paid date (Unix ms), 0 if not paid */
  paidAt: number;
  /** Days until due (negative if overdue) */
  daysUntilDue: number;
  /** Description of goods/services */
  description: string;
  settlementReference: string | null;
  discountRate: number | null;
  creditScore: number | null;
}

// ---------------------------------------------------------------------------
// Financing Types
// ---------------------------------------------------------------------------

/** Financing request status */
export type FinancingStatus =
  "PENDING" | "APPROVED" | "FUNDED" | "REPAID" | "DEFAULTED" | "REJECTED";

/** A financing request against an invoice */
export interface FinancingRequest {
  /** Request identifier */
  id: string;
  /** Invoice being financed */
  invoiceId: string;
  /** Requested financing amount. */
  amount: number;
  discountRate: number | null;
  netProceeds: number | null;
  factor: string | null;
  termDays: number;
  /** Financing status */
  status: FinancingStatus;
  externalReference: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Credit Score Types
// ---------------------------------------------------------------------------

/** Credit score for invoice financing eligibility */
export interface CreditScore {
  businessId: string;
  /** Overall credit score, null until enough invoices have matured. */
  score: number | null;
  /** Score grade */
  grade: "AAA" | "AA" | "A" | "BBB" | "BB" | "B" | "CCC" | "D" | "UNRATED";
  sampleSize: number;
  factors: Array<{ name: string; value: number; description: string }>;
  history: Array<{ date: string; score: number }>;
  methodology: string;
  /** Last updated timestamp (Unix ms) */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Invoice Analytics Types
// ---------------------------------------------------------------------------

/** Aggregated invoice analytics for dashboard display */
export interface InvoiceAnalytics {
  totalReceivables: number;
  /** Total outstanding amount (USD) */
  totalOutstanding: number;
  /** Total overdue amount (USD) */
  overdueAmount: number;
  overdueCount: number;
  /** Total financed amount (USD) */
  totalFinanced: number;
  /** Average days to payment */
  avgDaysToPay: number;
  financingUtilization: number;
  agingBuckets: Array<{ range: string; amount: number; count: number }>;
  byCurrency: Record<
    string,
    { total: number; financed: number; count: number }
  >;
}
