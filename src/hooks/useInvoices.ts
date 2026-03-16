/**
 * Invoice Hooks — Custom React hooks for NoblePay invoice financing.
 *
 * Provides typed hooks for invoice management, financing requests,
 * credit scoring, and invoice analytics.
 */

import { useState, useEffect, useCallback } from 'react';
import type {
  Invoice,
  FinancingRequest,
  CreditScore,
  InvoiceAnalytics,
} from '@/types/invoice';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_INVOICES: Invoice[] = [
  {
    id: 'inv-001',
    invoiceNumber: 'NP-2026-0001',
    issuer: '0x1234567890abcdef1234567890abcdef12345678',
    issuerName: 'Aethelred Trading LLC',
    payer: '0xabcdef1234567890abcdef1234567890abcdef12',
    payerName: 'Gulf Logistics Corp',
    amount: 250_000,
    currency: 'USDC',
    status: 'Issued',
    issuedAt: Date.now() - 5 * 86_400_000,
    dueAt: Date.now() + 25 * 86_400_000,
    paidAt: 0,
    daysUntilDue: 25,
    description: 'Q1 logistics software licensing and support services',
    tokenized: true,
    tokenId: '1001',
    documentHash: 'QmXyz123abc456def789',
  },
  {
    id: 'inv-002',
    invoiceNumber: 'NP-2026-0002',
    issuer: '0x1234567890abcdef1234567890abcdef12345678',
    issuerName: 'Aethelred Trading LLC',
    payer: '0xbcdef1234567890abcdef1234567890abcdef1234',
    payerName: 'Emirates Digital Solutions',
    amount: 180_000,
    currency: 'USDC',
    status: 'Financed',
    issuedAt: Date.now() - 15 * 86_400_000,
    dueAt: Date.now() + 15 * 86_400_000,
    paidAt: 0,
    daysUntilDue: 15,
    description: 'Blockchain integration consulting — Phase 2',
    tokenized: true,
    tokenId: '1002',
    documentHash: 'QmAbc789xyz456def123',
  },
  {
    id: 'inv-003',
    invoiceNumber: 'NP-2026-0003',
    issuer: '0x2345678901abcdef2345678901abcdef23456789',
    issuerName: 'Singapore Fintech Partners',
    payer: '0x1234567890abcdef1234567890abcdef12345678',
    payerName: 'Aethelred Trading LLC',
    amount: 75_000,
    currency: 'USDT',
    status: 'Overdue',
    issuedAt: Date.now() - 45 * 86_400_000,
    dueAt: Date.now() - 5 * 86_400_000,
    paidAt: 0,
    daysUntilDue: -5,
    description: 'Payment gateway API integration services',
    tokenized: false,
  },
  {
    id: 'inv-004',
    invoiceNumber: 'NP-2026-0004',
    issuer: '0x1234567890abcdef1234567890abcdef12345678',
    issuerName: 'Aethelred Trading LLC',
    payer: '0xcdef1234567890abcdef1234567890abcdef12345',
    payerName: 'Riyadh Capital Markets',
    amount: 420_000,
    currency: 'USDC',
    status: 'Paid',
    issuedAt: Date.now() - 60 * 86_400_000,
    dueAt: Date.now() - 30 * 86_400_000,
    paidAt: Date.now() - 32 * 86_400_000,
    daysUntilDue: 0,
    description: 'Enterprise compliance module deployment',
    paymentId: '0xpayment001',
    tokenized: true,
    tokenId: '1004',
    documentHash: 'QmDef456abc789xyz012',
  },
];

const MOCK_FINANCING: FinancingRequest[] = [
  {
    id: 'fin-001',
    invoiceId: 'inv-002',
    invoiceNumber: 'NP-2026-0002',
    borrower: '0x1234567890abcdef1234567890abcdef12345678',
    requestedAmount: 144_000,
    approvedAmount: 144_000,
    advanceRate: 80,
    interestRate: 8.5,
    fee: 720,
    status: 'Funded',
    creditScore: 742,
    requestedAt: Date.now() - 14 * 86_400_000,
    fundedAt: Date.now() - 13 * 86_400_000,
    repaymentDueAt: Date.now() + 16 * 86_400_000,
    amountRepaid: 0,
  },
];

const MOCK_CREDIT_SCORE: CreditScore = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  businessName: 'Aethelred Trading LLC',
  score: 742,
  grade: 'AA',
  maxFinancingAmount: 2_000_000,
  maxAdvanceRate: 85,
  baseInterestRate: 7.5,
  invoicesScored: 24,
  onTimePaymentRate: 95.8,
  avgDaysToPay: 22,
  totalFinancingVolume: 3_200_000,
  defaultCount: 0,
  updatedAt: Date.now() - 2 * 86_400_000,
};

const MOCK_ANALYTICS: InvoiceAnalytics = {
  totalIssued: 47,
  totalOutstanding: 505_000,
  totalOverdue: 75_000,
  totalFinanced: 1_440_000,
  avgDaysToPay: 22,
  onTimeRate: 95.8,
  defaultRate: 0,
  monthlyVolume: [
    { month: 'Oct', issued: 320_000, paid: 280_000, financed: 150_000 },
    { month: 'Nov', issued: 410_000, paid: 350_000, financed: 200_000 },
    { month: 'Dec', issued: 280_000, paid: 320_000, financed: 100_000 },
    { month: 'Jan', issued: 520_000, paid: 410_000, financed: 300_000 },
    { month: 'Feb', issued: 380_000, paid: 450_000, financed: 180_000 },
    { month: 'Mar', issued: 250_000, paid: 180_000, financed: 144_000 },
  ],
  generatedAt: Date.now(),
};

// ---------------------------------------------------------------------------
// useInvoices — invoices, financing, credit scores, and analytics
// ---------------------------------------------------------------------------

export function useInvoices() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [financingRequests, setFinancingRequests] = useState<FinancingRequest[]>([]);
  const [creditScore, setCreditScore] = useState<CreditScore | null>(null);
  const [analytics, setAnalytics] = useState<InvoiceAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setInvoices(MOCK_INVOICES);
      setFinancingRequests(MOCK_FINANCING);
      setCreditScore(MOCK_CREDIT_SCORE);
      setAnalytics(MOCK_ANALYTICS);
      setIsLoading(false);
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  const createInvoice = useCallback(
    (params: {
      payerAddress: string;
      payerName: string;
      amount: number;
      currency: string;
      dueInDays: number;
      description: string;
    }) => {
      const now = Date.now();
      const newInvoice: Invoice = {
        id: `inv-${String(now).slice(-6)}`,
        invoiceNumber: `NP-2026-${String(invoices.length + 1).padStart(4, '0')}`,
        issuer: '0x1234567890abcdef1234567890abcdef12345678',
        issuerName: 'Aethelred Trading LLC',
        payer: params.payerAddress,
        payerName: params.payerName,
        amount: params.amount,
        currency: params.currency,
        status: 'Draft',
        issuedAt: now,
        dueAt: now + params.dueInDays * 86_400_000,
        paidAt: 0,
        daysUntilDue: params.dueInDays,
        description: params.description,
        tokenized: false,
      };
      setInvoices((prev) => [newInvoice, ...prev]);
    },
    [invoices.length],
  );

  const requestFinancing = useCallback(
    (invoiceId: string, amount: number) => {
      const invoice = invoices.find((i) => i.id === invoiceId);
      if (!invoice || !creditScore) return;

      const newRequest: FinancingRequest = {
        id: `fin-${String(Date.now()).slice(-6)}`,
        invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        borrower: invoice.issuer,
        requestedAmount: amount,
        approvedAmount: 0,
        advanceRate: creditScore.maxAdvanceRate,
        interestRate: creditScore.baseInterestRate,
        fee: amount * 0.005,
        status: 'Pending',
        creditScore: creditScore.score,
        requestedAt: Date.now(),
        fundedAt: 0,
        repaymentDueAt: invoice.dueAt,
        amountRepaid: 0,
      };
      setFinancingRequests((prev) => [newRequest, ...prev]);
    },
    [invoices, creditScore],
  );

  const tokenizeInvoice = useCallback((invoiceId: string) => {
    setInvoices((prev) =>
      prev.map((i) =>
        i.id === invoiceId
          ? { ...i, tokenized: true, tokenId: String(1000 + Math.floor(Math.random() * 9000)) }
          : i,
      ),
    );
  }, []);

  return {
    invoices,
    financingRequests,
    creditScore,
    analytics,
    isLoading,
    createInvoice,
    requestFinancing,
    tokenizeInvoice,
  };
}
