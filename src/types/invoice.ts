// ============================================================
// NoblePay Invoice Financing Type Definitions
// Types for invoice management, financing, and credit scoring
// ============================================================

// ---------------------------------------------------------------------------
// Invoice Types
// ---------------------------------------------------------------------------

/** Invoice status */
export type InvoiceStatus =
  | 'Draft'
  | 'Issued'
  | 'Accepted'
  | 'Financed'
  | 'Paid'
  | 'Overdue'
  | 'Disputed'
  | 'Cancelled';

/** An invoice record for cross-border trade financing */
export interface Invoice {
  /** Invoice identifier */
  id: string;
  /** Invoice number (human-readable) */
  invoiceNumber: string;
  /** Issuer wallet address */
  issuer: string;
  /** Issuer business name */
  issuerName: string;
  /** Payer wallet address */
  payer: string;
  /** Payer business name */
  payerName: string;
  /** Invoice amount */
  amount: number;
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
  /** Associated payment ID, if settled on-chain */
  paymentId?: string;
  /** Whether this invoice has been tokenized as an NFT */
  tokenized: boolean;
  /** NFT token ID, if tokenized */
  tokenId?: string;
  /** IPFS hash of invoice document */
  documentHash?: string;
}

// ---------------------------------------------------------------------------
// Financing Types
// ---------------------------------------------------------------------------

/** Financing request status */
export type FinancingStatus =
  | 'Pending'
  | 'Approved'
  | 'Funded'
  | 'Repaid'
  | 'Defaulted'
  | 'Rejected';

/** A financing request against an invoice */
export interface FinancingRequest {
  /** Request identifier */
  id: string;
  /** Invoice being financed */
  invoiceId: string;
  /** Invoice number for display */
  invoiceNumber: string;
  /** Borrower wallet address */
  borrower: string;
  /** Requested financing amount */
  requestedAmount: number;
  /** Approved financing amount */
  approvedAmount: number;
  /** Advance rate as percentage (e.g. 80 = 80% of invoice value) */
  advanceRate: number;
  /** Interest rate (annualized percentage) */
  interestRate: number;
  /** Financing fee (flat, USD) */
  fee: number;
  /** Financing status */
  status: FinancingStatus;
  /** Borrower credit score at time of request */
  creditScore: number;
  /** Request timestamp (Unix ms) */
  requestedAt: number;
  /** Funding timestamp (Unix ms), 0 if not funded */
  fundedAt: number;
  /** Repayment due date (Unix ms) */
  repaymentDueAt: number;
  /** Amount repaid so far */
  amountRepaid: number;
}

// ---------------------------------------------------------------------------
// Credit Score Types
// ---------------------------------------------------------------------------

/** Credit score for invoice financing eligibility */
export interface CreditScore {
  /** Business wallet address */
  address: string;
  /** Business name */
  businessName: string;
  /** Overall credit score (300-850) */
  score: number;
  /** Score grade */
  grade: 'AAA' | 'AA' | 'A' | 'BBB' | 'BB' | 'B' | 'CCC' | 'D';
  /** Maximum financing amount eligible (USD) */
  maxFinancingAmount: number;
  /** Maximum advance rate percentage */
  maxAdvanceRate: number;
  /** Base interest rate offered */
  baseInterestRate: number;
  /** Number of invoices used for scoring */
  invoicesScored: number;
  /** On-time payment rate (0-100) */
  onTimePaymentRate: number;
  /** Average days to pay */
  avgDaysToPay: number;
  /** Total financing volume to date (USD) */
  totalFinancingVolume: number;
  /** Default count */
  defaultCount: number;
  /** Last updated timestamp (Unix ms) */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Invoice Analytics Types
// ---------------------------------------------------------------------------

/** Aggregated invoice analytics for dashboard display */
export interface InvoiceAnalytics {
  /** Total invoices issued */
  totalIssued: number;
  /** Total outstanding amount (USD) */
  totalOutstanding: number;
  /** Total overdue amount (USD) */
  totalOverdue: number;
  /** Total financed amount (USD) */
  totalFinanced: number;
  /** Average days to payment */
  avgDaysToPay: number;
  /** On-time payment rate (0-100) */
  onTimeRate: number;
  /** Default rate (0-100) */
  defaultRate: number;
  /** Invoice volume by month */
  monthlyVolume: {
    month: string;
    issued: number;
    paid: number;
    financed: number;
  }[];
  /** Analytics generation timestamp (Unix ms) */
  generatedAt: number;
}
