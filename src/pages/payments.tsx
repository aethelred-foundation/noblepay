/**
 * NoblePay Payments — Full Payment Management Interface
 *
 * Enterprise-grade payment management for cross-border transactions with
 * real-time compliance screening, filterable data tables, payment detail
 * drawers, and new payment creation flow.
 *
 * All mock data uses seededRandom for deterministic SSR hydration.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { SEOHead } from '@/components/SEOHead';
import { useApp } from '@/contexts/AppContext';
import { TopNav, Footer } from '@/components/SharedComponents';
import { GlassCard, SectionHeader } from '@/components/PagePrimitives';
import { seededRandom, seededHex, seededAddress, formatNumber, truncateAddress } from '@/lib/utils';
import { BRAND } from '@/lib/constants';
import {
  Search, Filter, ChevronDown, ChevronUp, ChevronLeft, ChevronRight,
  X, Plus, Upload, Download, Send, Clock, CheckCircle, AlertCircle,
  XCircle, ShieldCheck, Eye, MoreHorizontal, ArrowUpDown, ArrowUp,
  ArrowDown, CreditCard, DollarSign, Timer, AlertTriangle,
  FileText, Fingerprint, Lock, Shield, RefreshCw, ExternalLink,
  Building2, Globe, Banknote, Hash, Copy, Check,
} from 'lucide-react';


// =============================================================================
// TYPES
// =============================================================================

type PaymentStatus = 'Pending' | 'Screening' | 'Passed' | 'Flagged' | 'Blocked' | 'Settled' | 'Refunded';
type Currency = 'AET' | 'USDC' | 'USDT' | 'AED' | 'USD';
type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';
type DateRange = 'today' | '7d' | '30d' | '90d' | 'custom';
type SortField = 'date' | 'amount' | 'status' | 'risk' | 'settlement';
type SortDir = 'asc' | 'desc';

interface MockPayment {
  id: string;
  date: number;
  sender: string;
  senderName: string;
  senderJurisdiction: string;
  recipient: string;
  recipientName: string;
  recipientJurisdiction: string;
  recipientIBAN: string;
  amount: number;
  currency: Currency;
  status: PaymentStatus;
  riskScore: number;
  riskLevel: RiskLevel;
  settlementTime: number | null;
  teeAttestation: string;
  purposeCode: string;
  complianceTimeline: ComplianceStep[];
  encryptedMetadata: string;
  settlementTxHash: string | null;
  fee: number;
  exchangeRate: number | null;
}

interface ComplianceStep {
  name: string;
  status: 'completed' | 'in-progress' | 'pending' | 'failed';
  timestamp: number | null;
  detail: string;
}

interface Filters {
  status: PaymentStatus | 'All';
  currency: Currency | 'All';
  dateRange: DateRange;
  amountMin: string;
  amountMax: string;
  search: string;
  riskLevel: RiskLevel | 'All';
}


// =============================================================================
// CONSTANTS
// =============================================================================

const STATUS_COLORS: Record<PaymentStatus, { bg: string; text: string; dot: string; border: string }> = {
  Pending:   { bg: 'bg-amber-500/20', text: 'text-amber-400', dot: 'bg-amber-400', border: 'border-amber-500/30' },
  Screening: { bg: 'bg-blue-500/20', text: 'text-blue-400', dot: 'bg-blue-400', border: 'border-blue-500/30' },
  Passed:    { bg: 'bg-emerald-500/20', text: 'text-emerald-400', dot: 'bg-emerald-400', border: 'border-emerald-500/30' },
  Flagged:   { bg: 'bg-red-500/20', text: 'text-red-400', dot: 'bg-red-400', border: 'border-red-500/30' },
  Blocked:   { bg: 'bg-red-700/20', text: 'text-red-500', dot: 'bg-red-500', border: 'border-red-700/30' },
  Settled:   { bg: 'bg-cyan-500/20', text: 'text-cyan-400', dot: 'bg-cyan-400', border: 'border-cyan-500/30' },
  Refunded:  { bg: 'bg-purple-500/20', text: 'text-purple-400', dot: 'bg-purple-400', border: 'border-purple-500/30' },
};

const RISK_BAR_COLORS: Record<RiskLevel, string> = {
  Low: 'bg-emerald-500',
  Medium: 'bg-amber-500',
  High: 'bg-orange-500',
  Critical: 'bg-red-500',
};

const RISK_TEXT_COLORS: Record<RiskLevel, string> = {
  Low: 'text-emerald-400',
  Medium: 'text-amber-400',
  High: 'text-orange-400',
  Critical: 'text-red-400',
};

const UAE_COMPANIES = [
  'Emirates Digital Holdings', 'Abu Dhabi FinTech Corp', 'Dubai Precious Metals LLC',
  'Al Habtoor Trading Group', 'Majid Al Futtaim Finance', 'RAK Free Zone Ventures',
  'Sharjah Capital Partners', 'DIFC Investment Authority', 'Nakheel Payment Systems',
  'Emaar Digital Services', 'Al Ghurair Exchange', 'Mashreq Tech Solutions',
  'ADGM Custody Services', 'Jumeirah Blockchain Lab', 'Gulf Capital Pay',
  'Ajman Trade Finance', 'Fujairah Commodities Inc', 'Damac Financial Technologies',
  'First Abu Dhabi Digital', 'Dubai Islamic FinServ', 'National Bank Digital',
  'Aldar Properties Finance', 'Etisalat Payment Hub', 'Dubai Holdings Capital',
  'Union National Pay', 'DP World Financial', 'Mubadala Ventures Pay',
];

const JURISDICTIONS = ['DIFC', 'ADGM', 'RAK DAO', 'DAFZA', 'DMCC', 'SCA', 'CBUAE', 'JAFZA', 'SAIF', 'KIZAD'];

const PURPOSE_CODES = [
  'Trade Settlement', 'Service Payment', 'Investment Transfer', 'Loan Repayment',
  'Dividend Distribution', 'Salary Payment', 'Vendor Payment', 'Intercompany Transfer',
  'Capital Contribution', 'Consulting Fees', 'Licensing Fees', 'Equipment Purchase',
];

const ALL_CURRENCIES: Currency[] = ['AET', 'USDC', 'USDT', 'AED', 'USD'];
const ALL_STATUSES: PaymentStatus[] = ['Pending', 'Screening', 'Passed', 'Flagged', 'Blocked', 'Settled', 'Refunded'];
const ALL_RISK_LEVELS: RiskLevel[] = ['Low', 'Medium', 'High', 'Critical'];
const ITEMS_PER_PAGE = 20;


// =============================================================================
// DATA GENERATORS
// =============================================================================

function riskLevelFromScore(score: number): RiskLevel {
  if (score < 25) return 'Low';
  if (score < 55) return 'Medium';
  if (score < 80) return 'High';
  return 'Critical';
}

function generateIBAN(seed: number): string {
  const countryPrefixes = ['AE', 'GB', 'DE', 'FR', 'SG', 'CH', 'US'];
  const prefix = countryPrefixes[Math.floor(seededRandom(seed) * countryPrefixes.length)];
  let iban = prefix;
  for (let i = 0; i < 20; i++) {
    iban += Math.floor(seededRandom(seed + i + 10) * 10).toString();
  }
  return iban;
}

function generateComplianceTimeline(seed: number, status: PaymentStatus): ComplianceStep[] {
  const baseTime = Date.now() - Math.floor(seededRandom(seed) * 86400000);

  const steps: ComplianceStep[] = [
    {
      name: 'Payment Initiated',
      status: 'completed',
      timestamp: baseTime,
      detail: 'Payment request received and validated',
    },
    {
      name: 'Sanctions Screening',
      status: status === 'Pending' ? 'pending' : 'completed',
      timestamp: status === 'Pending' ? null : baseTime + 5000,
      detail: status === 'Blocked' ? 'Match found on OFAC SDN list' : 'No matches found across 6 sanctions lists',
    },
    {
      name: 'AML Risk Scoring',
      status: ['Pending', 'Screening'].includes(status) ? (status === 'Screening' ? 'in-progress' : 'pending') : status === 'Blocked' ? 'failed' : 'completed',
      timestamp: ['Pending', 'Screening'].includes(status) ? null : baseTime + 15000,
      detail: status === 'Flagged' ? 'Elevated risk score — manual review required' : 'Risk assessment completed',
    },
    {
      name: 'Travel Rule Verification',
      status: ['Pending', 'Screening', 'Flagged'].includes(status) ? 'pending' : status === 'Blocked' ? 'failed' : 'completed',
      timestamp: ['Pending', 'Screening', 'Flagged', 'Blocked'].includes(status) ? null : baseTime + 25000,
      detail: 'VASP information exchange via TRISA protocol',
    },
    {
      name: 'Settlement',
      status: status === 'Settled' ? 'completed' : status === 'Refunded' ? 'completed' : 'pending',
      timestamp: status === 'Settled' || status === 'Refunded' ? baseTime + 120000 : null,
      detail: status === 'Settled' ? 'Funds settled on-chain' : status === 'Refunded' ? 'Funds returned to sender' : 'Awaiting compliance clearance',
    },
  ];

  return steps;
}

function generateMockPayment(seed: number, idx: number): MockPayment {
  const statusRoll = seededRandom(seed + 1);
  let status: PaymentStatus;
  if (statusRoll < 0.10) status = 'Pending';
  else if (statusRoll < 0.18) status = 'Screening';
  else if (statusRoll < 0.35) status = 'Passed';
  else if (statusRoll < 0.45) status = 'Flagged';
  else if (statusRoll < 0.85) status = 'Settled';
  else if (statusRoll < 0.93) status = 'Blocked';
  else status = 'Refunded';

  const currIdx = Math.floor(seededRandom(seed + 2) * ALL_CURRENCIES.length);
  const senderIdx = Math.floor(seededRandom(seed + 3) * UAE_COMPANIES.length);
  const recipientIdx = Math.floor(seededRandom(seed + 4) * UAE_COMPANIES.length);
  const senderJurIdx = Math.floor(seededRandom(seed + 30) * JURISDICTIONS.length);
  const recipientJurIdx = Math.floor(seededRandom(seed + 31) * JURISDICTIONS.length);
  const purposeIdx = Math.floor(seededRandom(seed + 32) * PURPOSE_CODES.length);
  const amount = Math.round(500 + seededRandom(seed + 5) * 499500);
  const riskScore = Math.floor(seededRandom(seed + 6) * 100);
  const currency = ALL_CURRENCIES[currIdx];
  const fee = Math.round(amount * (0.001 + seededRandom(seed + 20) * 0.004) * 100) / 100;
  const hasExchange = currency === 'AED' || currency === 'AET';

  return {
    id: `0x${seededHex(seed + 7, 64)}`,
    date: Date.now() - idx * 180000 - Math.floor(seededRandom(seed + 8) * 120000),
    sender: seededAddress(seed + 9),
    senderName: UAE_COMPANIES[senderIdx],
    senderJurisdiction: JURISDICTIONS[senderJurIdx],
    recipient: seededAddress(seed + 10),
    recipientName: UAE_COMPANIES[recipientIdx],
    recipientJurisdiction: JURISDICTIONS[recipientJurIdx],
    recipientIBAN: generateIBAN(seed + 11),
    amount,
    currency,
    status,
    riskScore,
    riskLevel: riskLevelFromScore(riskScore),
    settlementTime: status === 'Settled' ? Math.round(60 + seededRandom(seed + 12) * 240) : null,
    teeAttestation: `0x${seededHex(seed + 13, 128)}`,
    purposeCode: PURPOSE_CODES[purposeIdx],
    complianceTimeline: generateComplianceTimeline(seed + 14, status),
    encryptedMetadata: `enc:${seededHex(seed + 15, 32)}...`,
    settlementTxHash: status === 'Settled' ? `0x${seededHex(seed + 16, 64)}` : null,
    fee,
    exchangeRate: hasExchange ? Math.round((3.67 + seededRandom(seed + 17) * 0.05) * 100) / 100 : null,
  };
}

function generateAllPayments(): MockPayment[] {
  const payments: MockPayment[] = [];
  for (let i = 0; i < 150; i++) {
    payments.push(generateMockPayment(10000 + i * 47, i));
  }
  return payments;
}


// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function formatUSD(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatAmount(n: number, currency: Currency): string {
  const formatted = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (currency === 'AED') return `${formatted} AED`;
  if (currency === 'AET') return `${formatted} AET`;
  return `$${formatted}`;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatFullDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatSettlementTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}


// =============================================================================
// REUSABLE LOCAL COMPONENTS
// =============================================================================

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const s = STATUS_COLORS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${s.bg} ${s.text} ${s.border}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${status === 'Screening' ? 'animate-pulse' : ''}`} />
      {status}
    </span>
  );
}

function RiskBar({ score, level }: { score: number; level: RiskLevel }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-12 h-1.5 bg-slate-700/50 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${RISK_BAR_COLORS[level]}`} style={{ width: `${score}%` }} />
      </div>
      <span className={`text-xs font-medium tabular-nums ${RISK_TEXT_COLORS[level]}`}>{score}</span>
    </div>
  );
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
        active
          ? 'bg-red-600/20 text-red-400 border-red-500/30'
          : 'bg-slate-800/50 text-slate-400 border-slate-700/50 hover:border-slate-600 hover:text-slate-300'
      }`}
    >
      {label}
    </button>
  );
}

function SortHeader({ label, field, currentSort, currentDir, onSort }: {
  label: string;
  field: SortField;
  currentSort: SortField;
  currentDir: SortDir;
  onSort: (field: SortField) => void;
}) {
  const isActive = currentSort === field;
  return (
    <button
      onClick={() => onSort(field)}
      className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 uppercase tracking-wider hover:text-slate-200 transition-colors"
    >
      {label}
      {isActive ? (
        currentDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
      ) : (
        <ArrowUpDown className="w-3 h-3 opacity-40" />
      )}
    </button>
  );
}

function ComplianceTimelineStep({ step, isLast }: { step: ComplianceStep; isLast: boolean }) {
  const icons: Record<string, React.ReactNode> = {
    completed: <CheckCircle className="w-4 h-4 text-emerald-400" />,
    'in-progress': <RefreshCw className="w-4 h-4 text-blue-400 animate-spin" />,
    pending: <Clock className="w-4 h-4 text-slate-500" />,
    failed: <XCircle className="w-4 h-4 text-red-400" />,
  };
  const lineColors: Record<string, string> = {
    completed: 'bg-emerald-500/50',
    'in-progress': 'bg-blue-500/50',
    pending: 'bg-slate-700',
    failed: 'bg-red-500/50',
  };

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        {icons[step.status]}
        {!isLast && <div className={`w-0.5 flex-1 my-1 ${lineColors[step.status]}`} />}
      </div>
      <div className={`pb-4 ${isLast ? '' : ''}`}>
        <p className={`text-sm font-medium ${step.status === 'pending' ? 'text-slate-500' : step.status === 'failed' ? 'text-red-400' : 'text-slate-200'}`}>
          {step.name}
        </p>
        <p className="text-xs text-slate-500 mt-0.5">{step.detail}</p>
        {step.timestamp && (
          <p className="text-xs text-slate-600 mt-0.5">{formatFullDate(step.timestamp)}</p>
        )}
      </div>
    </div>
  );
}


// =============================================================================
// PAYMENT DETAIL DRAWER
// =============================================================================

function PaymentDetailDrawer({ payment, open, onClose }: {
  payment: MockPayment | null;
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }, []);

  if (!open || !payment) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed inset-y-0 right-0 z-[100] w-full max-w-lg bg-slate-900 border-l border-slate-700/50 shadow-2xl overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-slate-700/50 bg-slate-900/95 backdrop-blur-sm">
          <div>
            <h3 className="text-lg font-semibold text-white">Payment Details</h3>
            <code className="text-xs text-slate-500 font-mono">{truncateAddress(payment.id, 12, 8)}</code>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 transition-colors text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Status and amount */}
          <div className="flex items-center justify-between">
            <PaymentStatusBadge status={payment.status} />
            <div className="text-right">
              <p className="text-2xl font-bold text-white">{formatAmount(payment.amount, payment.currency)}</p>
              <p className="text-xs text-slate-500">Fee: {formatAmount(payment.fee, payment.currency)}</p>
            </div>
          </div>

          {/* Sender & Recipient */}
          <div className="grid grid-cols-1 gap-4">
            <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/30">
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Sender</p>
              <p className="text-sm font-medium text-white">{payment.senderName}</p>
              <div className="flex items-center gap-1 mt-1">
                <code className="text-xs text-slate-500 font-mono">{truncateAddress(payment.sender, 12, 6)}</code>
                <button onClick={() => handleCopy(payment.sender, 'sender')} className="p-0.5 rounded hover:bg-slate-700/50">
                  {copiedField === 'sender' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-slate-600" />}
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-1">{payment.senderJurisdiction}</p>
            </div>

            <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/30">
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-2">Recipient</p>
              <p className="text-sm font-medium text-white">{payment.recipientName}</p>
              <div className="flex items-center gap-1 mt-1">
                <code className="text-xs text-slate-500 font-mono">{truncateAddress(payment.recipient, 12, 6)}</code>
                <button onClick={() => handleCopy(payment.recipient, 'recipient')} className="p-0.5 rounded hover:bg-slate-700/50">
                  {copiedField === 'recipient' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-slate-600" />}
                </button>
              </div>
              <p className="text-xs text-slate-500 mt-1">IBAN: {payment.recipientIBAN}</p>
              <p className="text-xs text-slate-500">{payment.recipientJurisdiction}</p>
            </div>
          </div>

          {/* Details grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
              <p className="text-xs text-slate-500">Purpose</p>
              <p className="text-sm text-slate-200 mt-0.5">{payment.purposeCode}</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
              <p className="text-xs text-slate-500">Risk Score</p>
              <div className="mt-1"><RiskBar score={payment.riskScore} level={payment.riskLevel} /></div>
            </div>
            <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
              <p className="text-xs text-slate-500">Date</p>
              <p className="text-sm text-slate-200 mt-0.5">{formatFullDate(payment.date)}</p>
            </div>
            {payment.settlementTime && (
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
                <p className="text-xs text-slate-500">Settlement Time</p>
                <p className="text-sm text-slate-200 mt-0.5">{formatSettlementTime(payment.settlementTime)}</p>
              </div>
            )}
            {payment.exchangeRate && (
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
                <p className="text-xs text-slate-500">Exchange Rate</p>
                <p className="text-sm text-slate-200 mt-0.5">1 USD = {payment.exchangeRate} {payment.currency}</p>
              </div>
            )}
          </div>

          {/* Compliance Timeline */}
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-3">Compliance Screening Timeline</p>
            <div className="space-y-0">
              {payment.complianceTimeline.map((step, idx) => (
                <ComplianceTimelineStep
                  key={idx}
                  step={step}
                  isLast={idx === payment.complianceTimeline.length - 1}
                />
              ))}
            </div>
          </div>

          {/* TEE Attestation */}
          <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/30">
            <div className="flex items-center gap-2 mb-2">
              <Fingerprint className="w-4 h-4 text-red-400" />
              <p className="text-xs text-slate-500 uppercase tracking-wider">TEE Attestation</p>
            </div>
            <div className="flex items-center gap-1">
              <code className="text-xs text-slate-500 font-mono break-all">{truncateAddress(payment.teeAttestation, 24, 12)}</code>
              <button onClick={() => handleCopy(payment.teeAttestation, 'tee')} className="p-0.5 rounded hover:bg-slate-700/50 flex-shrink-0">
                {copiedField === 'tee' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-slate-600" />}
              </button>
            </div>
          </div>

          {/* Encrypted Metadata */}
          <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/30">
            <div className="flex items-center gap-2 mb-2">
              <Lock className="w-4 h-4 text-amber-400" />
              <p className="text-xs text-slate-500 uppercase tracking-wider">Encrypted Metadata</p>
            </div>
            <code className="text-xs text-slate-600 font-mono">{payment.encryptedMetadata}</code>
          </div>

          {/* Settlement Tx Hash */}
          {payment.settlementTxHash && (
            <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/30">
              <div className="flex items-center gap-2 mb-2">
                <Hash className="w-4 h-4 text-cyan-400" />
                <p className="text-xs text-slate-500 uppercase tracking-wider">Settlement Transaction</p>
              </div>
              <div className="flex items-center gap-1">
                <code className="text-xs text-slate-500 font-mono">{truncateAddress(payment.settlementTxHash, 16, 8)}</code>
                <button onClick={() => handleCopy(payment.settlementTxHash!, 'stx')} className="p-0.5 rounded hover:bg-slate-700/50 flex-shrink-0">
                  {copiedField === 'stx' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-slate-600" />}
                </button>
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-3 pt-2">
            {payment.status === 'Pending' && (
              <button className="flex-1 py-2.5 rounded-lg border border-red-500/30 text-red-400 text-sm font-medium hover:bg-red-500/10 transition-colors">
                Cancel Payment
              </button>
            )}
            {payment.status === 'Settled' && (
              <button className="flex-1 py-2.5 rounded-lg border border-amber-500/30 text-amber-400 text-sm font-medium hover:bg-amber-500/10 transition-colors">
                Initiate Refund
              </button>
            )}
            <button className="flex-1 py-2.5 rounded-lg border border-slate-600 text-slate-300 text-sm font-medium hover:border-slate-500 hover:text-white transition-colors">
              Export Details
            </button>
          </div>
        </div>
      </div>
    </>
  );
}


// =============================================================================
// NEW PAYMENT MODAL
// =============================================================================

function NewPaymentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [recipientAddress, setRecipientAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USDC');
  const [purposeCode, setPurposeCode] = useState(PURPOSE_CODES[0]);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
      setShowConfirm(false);
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const estimatedFee = useMemo(() => {
    const amt = parseFloat(amount) || 0;
    return (amt * 0.0025).toFixed(2);
  }, [amount]);

  const handleSubmit = () => {
    if (showConfirm) {
      onClose();
      setRecipientAddress('');
      setAmount('');
      setCurrency('USDC');
      setPurposeCode(PURPOSE_CODES[0]);
      setShowConfirm(false);
    } else {
      setShowConfirm(true);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
        <div
          className="relative bg-slate-900 border border-slate-700/50 rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/50">
            <div className="flex items-center gap-2">
              <Send className="w-5 h-5 text-red-400" />
              <h3 className="text-lg font-semibold text-white">New Payment</h3>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 transition-colors text-slate-400 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="overflow-y-auto max-h-[calc(85vh-64px)] p-6 space-y-5">
            {!showConfirm ? (
              <>
                {/* Recipient */}
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">Recipient Address</label>
                  <input
                    type="text"
                    value={recipientAddress}
                    onChange={(e) => setRecipientAddress(e.target.value)}
                    placeholder="aeth1..."
                    className="w-full px-4 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-white placeholder-slate-600 text-sm focus:border-red-500 focus:ring-1 focus:ring-red-500/50 outline-none transition-colors"
                  />
                </div>

                {/* Amount + Currency */}
                <div className="grid grid-cols-[1fr_auto] gap-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1.5">Amount</label>
                    <input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      min="0"
                      step="0.01"
                      className="w-full px-4 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-white placeholder-slate-600 text-sm focus:border-red-500 focus:ring-1 focus:ring-red-500/50 outline-none transition-colors tabular-nums"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-300 mb-1.5">Currency</label>
                    <select
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value as Currency)}
                      className="px-4 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm focus:border-red-500 outline-none appearance-none cursor-pointer min-w-[90px]"
                    >
                      {ALL_CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                </div>

                {/* Purpose Code */}
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">Purpose Code</label>
                  <select
                    value={purposeCode}
                    onChange={(e) => setPurposeCode(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-white text-sm focus:border-red-500 outline-none appearance-none cursor-pointer"
                  >
                    {PURPOSE_CODES.map(code => <option key={code} value={code}>{code}</option>)}
                  </select>
                </div>

                {/* Supporting Documents */}
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">Supporting Documents</label>
                  <div className="p-6 rounded-xl border-2 border-dashed border-slate-700 hover:border-slate-600 transition-colors text-center cursor-pointer">
                    <Upload className="w-6 h-6 text-slate-500 mx-auto mb-2" />
                    <p className="text-sm text-slate-400">Drop files here or click to upload</p>
                    <p className="text-xs text-slate-600 mt-1">PDF, PNG, JPG up to 10MB</p>
                  </div>
                </div>

                {/* Fee Estimation */}
                <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/30">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-slate-500">Estimated Fee</span>
                    <span className="text-sm font-medium text-white">${estimatedFee}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-xs text-emerald-400">Compliance pre-check: Ready</span>
                  </div>
                </div>
              </>
            ) : (
              /* Confirmation Step */
              <div className="space-y-4">
                <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                    <p className="text-sm font-medium text-amber-400">Confirm Payment</p>
                  </div>
                  <p className="text-xs text-slate-400">Please review the payment details before submitting.</p>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-sm text-slate-400">Recipient</span>
                    <code className="text-sm text-slate-200 font-mono">{truncateAddress(recipientAddress || 'aeth1...', 10, 6)}</code>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-slate-400">Amount</span>
                    <span className="text-sm text-white font-semibold">{formatAmount(parseFloat(amount) || 0, currency)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-slate-400">Fee</span>
                    <span className="text-sm text-slate-300">${estimatedFee}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-slate-400">Purpose</span>
                    <span className="text-sm text-slate-300">{purposeCode}</span>
                  </div>
                  <div className="border-t border-slate-700/50 pt-3 flex justify-between">
                    <span className="text-sm text-slate-400 font-medium">Total</span>
                    <span className="text-sm text-white font-bold">
                      {formatAmount((parseFloat(amount) || 0) + parseFloat(estimatedFee), currency)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-3 pt-2">
              {showConfirm && (
                <button
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 py-2.5 rounded-lg border border-slate-600 text-slate-300 text-sm font-medium hover:border-slate-500 transition-colors"
                >
                  Back
                </button>
              )}
              <button
                onClick={handleSubmit}
                disabled={!recipientAddress || !amount}
                className="flex-1 py-2.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {showConfirm ? 'Confirm & Send' : 'Initiate Payment'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}


// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function PaymentsPage() {
  const { realTime } = useApp();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // All mock payments
  const allPayments = useMemo(() => generateAllPayments(), []);

  // Filter state
  const [filters, setFilters] = useState<Filters>({
    status: 'All',
    currency: 'All',
    dateRange: '30d',
    amountMin: '',
    amountMax: '',
    search: '',
    riskLevel: 'All',
  });

  // Sort state
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);

  // Drawer/modal state
  const [selectedPayment, setSelectedPayment] = useState<MockPayment | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [newPaymentOpen, setNewPaymentOpen] = useState(false);

  // Show/hide filter bar
  const [showFilters, setShowFilters] = useState(true);

  // Filter payments
  const filteredPayments = useMemo(() => {
    let result = [...allPayments];

    if (filters.status !== 'All') {
      result = result.filter(p => p.status === filters.status);
    }
    if (filters.currency !== 'All') {
      result = result.filter(p => p.currency === filters.currency);
    }
    if (filters.riskLevel !== 'All') {
      result = result.filter(p => p.riskLevel === filters.riskLevel);
    }
    if (filters.amountMin) {
      const min = parseFloat(filters.amountMin);
      if (!isNaN(min)) result = result.filter(p => p.amount >= min);
    }
    if (filters.amountMax) {
      const max = parseFloat(filters.amountMax);
      if (!isNaN(max)) result = result.filter(p => p.amount <= max);
    }
    if (filters.search.trim()) {
      const q = filters.search.toLowerCase().trim();
      result = result.filter(p =>
        p.id.toLowerCase().includes(q) ||
        p.senderName.toLowerCase().includes(q) ||
        p.recipientName.toLowerCase().includes(q) ||
        p.sender.toLowerCase().includes(q) ||
        p.recipient.toLowerCase().includes(q)
      );
    }

    // Date range filter
    const now = Date.now();
    const rangeMs: Record<DateRange, number> = {
      today: 86400000,
      '7d': 604800000,
      '30d': 2592000000,
      '90d': 7776000000,
      custom: Infinity,
    };
    const cutoff = now - rangeMs[filters.dateRange];
    result = result.filter(p => p.date >= cutoff);

    return result;
  }, [allPayments, filters]);

  // Sort payments
  const sortedPayments = useMemo(() => {
    const sorted = [...filteredPayments];
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'date': cmp = a.date - b.date; break;
        case 'amount': cmp = a.amount - b.amount; break;
        case 'risk': cmp = a.riskScore - b.riskScore; break;
        case 'settlement': cmp = (a.settlementTime || 0) - (b.settlementTime || 0); break;
        case 'status': cmp = a.status.localeCompare(b.status); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [filteredPayments, sortField, sortDir]);

  // Paginate
  const totalPages = Math.ceil(sortedPayments.length / ITEMS_PER_PAGE);
  const paginatedPayments = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return sortedPayments.slice(start, start + ITEMS_PER_PAGE);
  }, [sortedPayments, currentPage]);

  // Summary stats
  const summaryStats = useMemo(() => {
    const total = filteredPayments.length;
    const volume = filteredPayments.reduce((acc, p) => acc + p.amount, 0);
    const withSettlement = filteredPayments.filter(p => p.settlementTime !== null);
    const avgSettlement = withSettlement.length > 0
      ? withSettlement.reduce((acc, p) => acc + (p.settlementTime || 0), 0) / withSettlement.length
      : 0;
    const flagged = filteredPayments.filter(p => p.status === 'Flagged' || p.status === 'Blocked').length;
    const flagRate = total > 0 ? ((flagged / total) * 100).toFixed(1) : '0.0';
    return { total, volume, avgSettlement, flagRate };
  }, [filteredPayments]);

  // Handlers
  const handleSort = useCallback((field: SortField) => {
    if (field === sortField) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
    setCurrentPage(1);
  }, [sortField]);

  const handleRowClick = useCallback((payment: MockPayment) => {
    setSelectedPayment(payment);
    setDrawerOpen(true);
  }, []);

  const updateFilter = useCallback(<K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    setCurrentPage(1);
  }, []);

  return (
    <>
      <SEOHead
        title="Payments"
        description="Manage cross-border transactions with real-time compliance screening on NoblePay."
        path="/payments"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/payments" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* ============================================================ */}
          {/* HEADER WITH ACTIONS                                          */}
          {/* ============================================================ */}

          <div className="mb-8 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay</p>
              <h1 className="mt-2 text-3xl font-bold text-white">Payments</h1>
              <p className="mt-1 text-sm text-slate-400">Manage cross-border transactions with real-time compliance</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setNewPaymentOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                New Payment
              </button>
              <button className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-300 hover:border-slate-500 transition-colors">
                <Download className="w-4 h-4" />
                Export
              </button>
              <button className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm text-slate-300 hover:border-slate-500 transition-colors">
                <Upload className="w-4 h-4" />
                Bulk Upload
              </button>
            </div>
          </div>


          {/* ============================================================ */}
          {/* FILTER BAR                                                   */}
          {/* ============================================================ */}

          <GlassCard className="mb-6 p-4" hover={false}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-medium text-slate-300">Filters</span>
              </div>
              <button
                onClick={() => setShowFilters(!showFilters)}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                {showFilters ? 'Hide' : 'Show'}
              </button>
            </div>

            {showFilters && (
              <div className="space-y-4">
                {/* Row 1: Status */}
                <div>
                  <p className="text-xs text-slate-500 mb-2">Status</p>
                  <div className="flex flex-wrap gap-2">
                    <FilterPill label="All" active={filters.status === 'All'} onClick={() => updateFilter('status', 'All')} />
                    {ALL_STATUSES.map(s => (
                      <FilterPill key={s} label={s} active={filters.status === s} onClick={() => updateFilter('status', s)} />
                    ))}
                  </div>
                </div>

                {/* Row 2: Currency + Date + Risk */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div>
                    <p className="text-xs text-slate-500 mb-2">Currency</p>
                    <div className="flex flex-wrap gap-2">
                      <FilterPill label="All" active={filters.currency === 'All'} onClick={() => updateFilter('currency', 'All')} />
                      {ALL_CURRENCIES.map(c => (
                        <FilterPill key={c} label={c} active={filters.currency === c} onClick={() => updateFilter('currency', c)} />
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-2">Date Range</p>
                    <div className="flex flex-wrap gap-2">
                      {(['today', '7d', '30d', '90d'] as DateRange[]).map(d => (
                        <FilterPill key={d} label={d === 'today' ? 'Today' : d} active={filters.dateRange === d} onClick={() => updateFilter('dateRange', d)} />
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-2">Risk Level</p>
                    <div className="flex flex-wrap gap-2">
                      <FilterPill label="All" active={filters.riskLevel === 'All'} onClick={() => updateFilter('riskLevel', 'All')} />
                      {ALL_RISK_LEVELS.map(r => (
                        <FilterPill key={r} label={r} active={filters.riskLevel === r} onClick={() => updateFilter('riskLevel', r)} />
                      ))}
                    </div>
                  </div>
                </div>

                {/* Row 3: Search + Amount range */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto_auto]">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                      type="text"
                      value={filters.search}
                      onChange={(e) => updateFilter('search', e.target.value)}
                      placeholder="Search by payment ID, sender, or recipient..."
                      className="w-full pl-9 pr-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-600 text-sm focus:border-red-500 outline-none transition-colors"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={filters.amountMin}
                      onChange={(e) => updateFilter('amountMin', e.target.value)}
                      placeholder="Min $"
                      className="w-24 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-600 text-sm focus:border-red-500 outline-none transition-colors tabular-nums"
                    />
                    <span className="text-slate-600">-</span>
                    <input
                      type="number"
                      value={filters.amountMax}
                      onChange={(e) => updateFilter('amountMax', e.target.value)}
                      placeholder="Max $"
                      className="w-24 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white placeholder-slate-600 text-sm focus:border-red-500 outline-none transition-colors tabular-nums"
                    />
                  </div>
                </div>
              </div>
            )}
          </GlassCard>


          {/* ============================================================ */}
          {/* SUMMARY STATS                                                */}
          {/* ============================================================ */}

          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <CreditCard className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-400">Total Payments</span>
              </div>
              <p className="text-xl font-bold text-white">{summaryStats.total}</p>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <DollarSign className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-400">Total Volume</span>
              </div>
              <p className="text-xl font-bold text-white">{formatUSD(summaryStats.volume)}</p>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <Timer className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-400">Avg Processing</span>
              </div>
              <p className="text-xl font-bold text-white">{formatSettlementTime(Math.round(summaryStats.avgSettlement))}</p>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-400">Flag Rate</span>
              </div>
              <p className="text-xl font-bold text-white">{summaryStats.flagRate}%</p>
            </GlassCard>
          </div>


          {/* ============================================================ */}
          {/* PAYMENTS TABLE                                               */}
          {/* ============================================================ */}

          <GlassCard className="mb-6" hover={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="py-3 px-4 text-left">
                      <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Payment ID</span>
                    </th>
                    <th className="py-3 px-4 text-left">
                      <SortHeader label="Date" field="date" currentSort={sortField} currentDir={sortDir} onSort={handleSort} />
                    </th>
                    <th className="py-3 px-4 text-left">
                      <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Sender</span>
                    </th>
                    <th className="py-3 px-4 text-left">
                      <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Recipient</span>
                    </th>
                    <th className="py-3 px-4 text-right">
                      <SortHeader label="Amount" field="amount" currentSort={sortField} currentDir={sortDir} onSort={handleSort} />
                    </th>
                    <th className="py-3 px-4 text-center">
                      <SortHeader label="Status" field="status" currentSort={sortField} currentDir={sortDir} onSort={handleSort} />
                    </th>
                    <th className="py-3 px-4 text-center">
                      <SortHeader label="Risk" field="risk" currentSort={sortField} currentDir={sortDir} onSort={handleSort} />
                    </th>
                    <th className="py-3 px-4 text-right">
                      <SortHeader label="Settlement" field="settlement" currentSort={sortField} currentDir={sortDir} onSort={handleSort} />
                    </th>
                    <th className="py-3 px-4 text-center">
                      <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {paginatedPayments.map((payment) => (
                    <tr
                      key={payment.id}
                      onClick={() => handleRowClick(payment)}
                      className="hover:bg-slate-800/30 transition-colors cursor-pointer"
                    >
                      <td className="py-3 px-4">
                        <code className="text-xs text-slate-500 font-mono">{truncateAddress(payment.id, 8, 4)}</code>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-400 whitespace-nowrap">
                        {mounted ? formatDate(payment.date) : '--'}
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-slate-300 truncate block max-w-[120px]" title={payment.senderName}>
                          {payment.senderName}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-slate-300 truncate block max-w-[120px]" title={payment.recipientName}>
                          {payment.recipientName}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <div>
                          <span className="text-white font-medium tabular-nums">{formatAmount(payment.amount, payment.currency)}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-center">
                        <PaymentStatusBadge status={payment.status} />
                      </td>
                      <td className="py-3 px-4">
                        <RiskBar score={payment.riskScore} level={payment.riskLevel} />
                      </td>
                      <td className="py-3 px-4 text-right text-xs text-slate-400 tabular-nums">
                        {payment.settlementTime ? formatSettlementTime(payment.settlementTime) : '—'}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleRowClick(payment); }}
                            className="p-1.5 rounded-lg hover:bg-slate-700/50 transition-colors text-slate-500 hover:text-slate-300"
                            title="View details"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {payment.status === 'Pending' && (
                            <button
                              onClick={(e) => { e.stopPropagation(); }}
                              className="p-1.5 rounded-lg hover:bg-red-500/10 transition-colors text-slate-500 hover:text-red-400"
                              title="Cancel"
                            >
                              <XCircle className="w-4 h-4" />
                            </button>
                          )}
                          {payment.status === 'Settled' && (
                            <button
                              onClick={(e) => { e.stopPropagation(); }}
                              className="p-1.5 rounded-lg hover:bg-amber-500/10 transition-colors text-slate-500 hover:text-amber-400"
                              title="Refund"
                            >
                              <RefreshCw className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700/50">
              <p className="text-xs text-slate-500">
                Showing {((currentPage - 1) * ITEMS_PER_PAGE) + 1}–{Math.min(currentPage * ITEMS_PER_PAGE, sortedPayments.length)} of {sortedPayments.length} payments
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="p-1.5 rounded-lg hover:bg-slate-800 transition-colors text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  let page: number;
                  if (totalPages <= 5) {
                    page = i + 1;
                  } else if (currentPage <= 3) {
                    page = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    page = totalPages - 4 + i;
                  } else {
                    page = currentPage - 2 + i;
                  }
                  return (
                    <button
                      key={page}
                      onClick={() => setCurrentPage(page)}
                      className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                        page === currentPage
                          ? 'bg-red-600 text-white'
                          : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                      }`}
                    >
                      {page}
                    </button>
                  );
                })}
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="p-1.5 rounded-lg hover:bg-slate-800 transition-colors text-slate-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </GlassCard>

        </main>

        <Footer />
      </div>

      {/* Drawers / Modals */}
      <PaymentDetailDrawer
        payment={selectedPayment}
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); setSelectedPayment(null); }}
      />
      <NewPaymentModal
        open={newPaymentOpen}
        onClose={() => setNewPaymentOpen(false)}
      />
    </>
  );
}
