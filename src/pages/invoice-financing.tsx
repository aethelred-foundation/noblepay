/**
 * NoblePay Invoice Financing — Invoice Factoring Dashboard
 *
 * Enterprise invoice factoring dashboard featuring active invoices,
 * financing request forms, credit score displays, aging bucket charts,
 * and dispute resolution panels.
 *
 * All mock data uses seededRandom for deterministic SSR hydration.
 */

import { useState, useEffect, useMemo } from 'react';
import { SEOHead } from '@/components/SEOHead';
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  Legend,
} from 'recharts';
import {
  FileText, DollarSign, TrendingUp, Clock, CheckCircle,
  ArrowUpRight, ArrowDownRight, Plus, AlertCircle,
  Building2, Send, AlertTriangle, XCircle,
  Calendar, ChevronDown, Shield, Eye,
  Star, Users, Banknote, Scale,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { TopNav, Footer, Badge, Modal } from '@/components/SharedComponents';
import { seededRandom, seededAddress, formatNumber, truncateAddress } from '@/lib/utils';
import { BRAND } from '@/lib/constants';
import { GlassCard, SectionHeader, Sparkline } from '@/components/PagePrimitives';


// =============================================================================
// CONSTANTS
// =============================================================================

const CHART_COLORS = [
  '#DC2626', '#0EA5E9', '#10B981', '#F59E0B', '#8B5CF6',
  '#EC4899', '#06B6D4', '#F87171', '#34D399', '#FBBF24',
];

const INVOICE_STATUS_STYLES: Record<string, string> = {
  Funded: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  Pending: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  Overdue: 'bg-red-500/20 text-red-400 border-red-500/30',
  Disputed: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  Settled: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
};

const CREDIT_GRADES = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC', 'CC', 'C', 'D'] as const;
type CreditGrade = typeof CREDIT_GRADES[number];

const GRADE_COLORS: Record<string, string> = {
  AAA: 'text-emerald-400', AA: 'text-emerald-400', A: 'text-green-400',
  BBB: 'text-lime-400', BB: 'text-yellow-400', B: 'text-amber-400',
  CCC: 'text-orange-400', CC: 'text-red-400', C: 'text-red-500', D: 'text-red-600',
};


// =============================================================================
// TYPES
// =============================================================================

type InvoiceStatus = 'Funded' | 'Pending' | 'Overdue' | 'Disputed' | 'Settled';

interface Invoice {
  id: string;
  debtor: string;
  debtorName: string;
  amount: number;
  funded: number;
  discountRate: number;
  issueDate: number;
  dueDate: number;
  status: InvoiceStatus;
  daysBucket: 'current' | '30' | '60' | '90+';
}

interface Dispute {
  id: string;
  invoiceId: string;
  reason: string;
  filedBy: string;
  filedAt: number;
  status: 'Open' | 'Under Review' | 'Resolved' | 'Escalated';
  resolution?: string;
}


// =============================================================================
// MOCK DATA GENERATORS
// =============================================================================

const DEBTOR_NAMES = [
  'TechCorp International', 'Gulf Trading LLC', 'Alpine Manufacturing',
  'Pacific Logistics Co.', 'Meridian Solutions', 'Crescent Industries',
  'Nordic Supply Chain', 'Atlas Global Services', 'Pinnacle Enterprises',
  'Horizon Capital Group', 'Sterling Commerce Ltd', 'Vanguard Exports',
];

const DISPUTE_REASONS = [
  'Invoice amount discrepancy', 'Goods not received as specified',
  'Duplicate invoice submitted', 'Incorrect payment terms',
  'Quality dispute — partial delivery', 'Unauthorized charges included',
];

function generateInvoices(count: number): Invoice[] {
  const statuses: InvoiceStatus[] = ['Funded', 'Pending', 'Overdue', 'Disputed', 'Settled'];
  const invoices: Invoice[] = [];
  for (let i = 0; i < count; i++) {
    const seed = 3000 + i * 137;
    const amount = Math.floor(seededRandom(seed) * 500000) + 25000;
    const status = statuses[Math.floor(seededRandom(seed + 10) * statuses.length)];
    const daysOffset = Math.floor(seededRandom(seed + 20) * 120);
    const daysBucket = daysOffset <= 30 ? 'current' as const
      : daysOffset <= 60 ? '30' as const
      : daysOffset <= 90 ? '60' as const : '90+' as const;
    invoices.push({
      id: `INV-${String(2000 + i).padStart(5, '0')}`,
      debtor: seededAddress(seed + 30),
      debtorName: DEBTOR_NAMES[Math.floor(seededRandom(seed + 40) * DEBTOR_NAMES.length)],
      amount,
      funded: status === 'Funded' || status === 'Settled' ? amount * (seededRandom(seed + 50) * 0.1 + 0.88) : 0,
      discountRate: seededRandom(seed + 60) * 4 + 1.5,
      issueDate: Date.now() - daysOffset * 86400000,
      dueDate: Date.now() + Math.floor(seededRandom(seed + 70) * 90 - 30) * 86400000,
      status,
      daysBucket,
    });
  }
  return invoices;
}

function generateDisputes(): Dispute[] {
  const statuses: Dispute['status'][] = ['Open', 'Under Review', 'Resolved', 'Escalated'];
  const disputes: Dispute[] = [];
  for (let i = 0; i < 6; i++) {
    const seed = 4000 + i * 89;
    disputes.push({
      id: `DSP-${String(100 + i).padStart(4, '0')}`,
      invoiceId: `INV-${String(2000 + Math.floor(seededRandom(seed) * 15)).padStart(5, '0')}`,
      reason: DISPUTE_REASONS[Math.floor(seededRandom(seed + 10) * DISPUTE_REASONS.length)],
      filedBy: DEBTOR_NAMES[Math.floor(seededRandom(seed + 20) * DEBTOR_NAMES.length)],
      filedAt: Date.now() - Math.floor(seededRandom(seed + 30) * 604800000),
      status: statuses[Math.floor(seededRandom(seed + 40) * statuses.length)],
    });
  }
  return disputes;
}

function generateAgingData(): Array<{ bucket: string; count: number; value: number; fill: string }> {
  return [
    { bucket: 'Current', count: 24, value: 2450000, fill: '#10B981' },
    { bucket: '30 Days', count: 12, value: 1380000, fill: '#F59E0B' },
    { bucket: '60 Days', count: 7, value: 890000, fill: '#F97316' },
    { bucket: '90+ Days', count: 4, value: 520000, fill: '#DC2626' },
  ];
}

function generateSparklineData(seed: number, count: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < count; i++) data.push(seededRandom(seed + i * 7) * 100);
  return data;
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

function timeAgo(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function daysUntil(timestamp: number): string {
  const diff = Math.floor((timestamp - Date.now()) / 86400000);
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff === 0) return 'Due today';
  return `${diff}d remaining`;
}


// =============================================================================
// REUSABLE LOCAL COMPONENTS
// =============================================================================

function StatusBadge({ status }: { status: string }) {
  const style = INVOICE_STATUS_STYLES[status] || 'bg-slate-700/50 text-slate-300 border-slate-600/30';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${style}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

function CreditGradeDisplay({ grade, score }: { grade: CreditGrade; score: number }) {
  return (
    <div className="text-center">
      <div className={`text-5xl font-black ${GRADE_COLORS[grade] || 'text-slate-400'}`}>{grade}</div>
      <div className="mt-2 text-sm text-slate-400">Credit Score</div>
      <div className="text-2xl font-bold text-white">{score}</div>
      <div className="mt-3 w-full h-2 rounded-full bg-slate-700/50 overflow-hidden">
        <div
          className="h-2 rounded-full bg-gradient-to-r from-red-500 via-yellow-400 to-emerald-500"
          style={{ width: `${Math.min(100, score / 8.5)}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-slate-500 mt-1">
        <span>0</span>
        <span>850</span>
      </div>
    </div>
  );
}

function DisputeStatusBadge({ status }: { status: Dispute['status'] }) {
  const styles: Record<string, string> = {
    Open: 'bg-amber-500/20 text-amber-400',
    'Under Review': 'bg-blue-500/20 text-blue-400',
    Resolved: 'bg-emerald-500/20 text-emerald-400',
    Escalated: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || ''}`}>
      {status}
    </span>
  );
}


// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function InvoiceFinancingPage() {
  const { realTime } = useApp();
  const [mounted, setMounted] = useState(false);
  const [showFinancingForm, setShowFinancingForm] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | InvoiceStatus>('all');
  const [formAmount, setFormAmount] = useState('');
  const [formDebtor, setFormDebtor] = useState('');
  const [formDueDate, setFormDueDate] = useState('');
  useEffect(() => setMounted(true), []);

  const invoices = useMemo(() => generateInvoices(15), []);
  const disputes = useMemo(() => generateDisputes(), []);
  const agingData = useMemo(() => generateAgingData(), []);

  const filteredInvoices = useMemo(() => {
    if (statusFilter === 'all') return invoices;
    return invoices.filter(inv => inv.status === statusFilter);
  }, [invoices, statusFilter]);

  const totalOutstanding = useMemo(() => invoices.reduce((s, inv) => s + inv.amount, 0), [invoices]);
  const totalFunded = useMemo(() => invoices.filter(i => i.status === 'Funded' || i.status === 'Settled').reduce((s, inv) => s + inv.funded, 0), [invoices]);
  const avgDiscount = useMemo(() => invoices.reduce((s, inv) => s + inv.discountRate, 0) / invoices.length, [invoices]);
  const overdueCount = useMemo(() => invoices.filter(i => i.status === 'Overdue').length, [invoices]);

  return (
    <>
      <SEOHead
        title="Invoice Financing"
        description="NoblePay invoice factoring dashboard for enterprise receivables financing and credit management."
        path="/invoice-financing"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/invoice-financing" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* HEADER */}
          <div className="mb-8">
            <div className="flex items-start justify-between mb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay Financing</p>
                <h1 className="mt-2 text-3xl font-bold text-white">Invoice Financing</h1>
                <p className="mt-1 text-sm text-slate-400">Enterprise receivables factoring, credit scoring, and dispute management</p>
              </div>
              <button
                onClick={() => setShowFinancingForm(true)}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 transition-colors"
              >
                <Plus className="w-4 h-4" />
                New Financing Request
              </button>
            </div>
          </div>

          {/* KPI CARDS */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <FileText className="w-4 h-4 text-slate-400" />
                    <span className="text-xs text-slate-400">Total Outstanding</span>
                  </div>
                  <p className="text-xl font-bold text-white">{formatUSD(totalOutstanding)}</p>
                  <div className="flex items-center gap-1 mt-1 text-xs text-emerald-400">
                    <ArrowUpRight className="w-3 h-3" />+12.4% this month
                  </div>
                </div>
                <Sparkline data={generateSparklineData(100, 12)} color={BRAND.red} height={28} width={64} />
              </div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <DollarSign className="w-4 h-4 text-slate-400" />
                    <span className="text-xs text-slate-400">Total Funded</span>
                  </div>
                  <p className="text-xl font-bold text-white">{formatUSD(totalFunded)}</p>
                  <div className="flex items-center gap-1 mt-1 text-xs text-emerald-400">
                    <ArrowUpRight className="w-3 h-3" />+8.7% this month
                  </div>
                </div>
                <Sparkline data={generateSparklineData(200, 12)} color="#10B981" height={28} width={64} />
              </div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <TrendingUp className="w-4 h-4 text-slate-400" />
                    <span className="text-xs text-slate-400">Avg Discount Rate</span>
                  </div>
                  <p className="text-xl font-bold text-white">{avgDiscount.toFixed(2)}%</p>
                  <div className="flex items-center gap-1 mt-1 text-xs text-red-400">
                    <ArrowDownRight className="w-3 h-3" />-0.3% vs last month
                  </div>
                </div>
              </div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className="w-4 h-4 text-slate-400" />
                    <span className="text-xs text-slate-400">Overdue Invoices</span>
                  </div>
                  <p className="text-xl font-bold text-white">{overdueCount}</p>
                  <div className="flex items-center gap-1 mt-1 text-xs text-amber-400">
                    Requires attention
                  </div>
                </div>
              </div>
            </GlassCard>
          </div>

          {/* MAIN CONTENT GRID */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">

            {/* ACTIVE INVOICES TABLE */}
            <div className="lg:col-span-2">
              <GlassCard className="p-0 overflow-hidden">
                <div className="flex items-center justify-between p-4 border-b border-slate-700/50">
                  <SectionHeader title="Active Invoices" />
                  <div className="flex gap-2">
                    {(['all', 'Funded', 'Pending', 'Overdue', 'Disputed', 'Settled'] as const).map(f => (
                      <button
                        key={f}
                        onClick={() => setStatusFilter(f)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
                          statusFilter === f
                            ? 'bg-red-600/20 text-red-400 border border-red-500/30'
                            : 'text-slate-400 hover:text-white hover:bg-slate-700/50'
                        }`}
                      >
                        {f === 'all' ? 'All' : f}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-700/50">
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Invoice ID</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Debtor</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-slate-400">Amount</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-slate-400">Discount</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Due Date</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredInvoices.slice(0, 10).map(inv => (
                        <tr key={inv.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                          <td className="px-4 py-3 font-mono text-xs text-red-400">{inv.id}</td>
                          <td className="px-4 py-3">
                            <div className="text-sm text-white">{inv.debtorName}</div>
                            <div className="text-xs text-slate-500 font-mono">{truncateAddress(inv.debtor, 8, 4)}</div>
                          </td>
                          <td className="px-4 py-3 text-right text-white font-medium">{formatUSD(inv.amount)}</td>
                          <td className="px-4 py-3 text-right text-slate-300">{inv.discountRate.toFixed(2)}%</td>
                          <td className="px-4 py-3 text-xs text-slate-400">{daysUntil(inv.dueDate)}</td>
                          <td className="px-4 py-3"><StatusBadge status={inv.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </GlassCard>
            </div>

            {/* CREDIT SCORE + AGING */}
            <div className="space-y-6">
              <GlassCard className="p-6">
                <SectionHeader title="Counterparty Credit Score" />
                <div className="mt-4">
                  <CreditGradeDisplay grade="AA" score={742} />
                </div>
                <div className="mt-4 space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Payment History</span>
                    <span className="text-emerald-400">98.2%</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Default Probability</span>
                    <span className="text-green-400">0.8%</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Avg Days to Pay</span>
                    <span className="text-white">34 days</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-400">Credit Utilization</span>
                    <span className="text-amber-400">67%</span>
                  </div>
                </div>
              </GlassCard>

              <GlassCard className="p-6">
                <SectionHeader title="Aging Buckets" />
                <div className="mt-4 h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={agingData} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 11 }} tickFormatter={(v: number) => formatUSD(v)} />
                      <YAxis type="category" dataKey="bucket" tick={{ fill: '#94a3b8', fontSize: 11 }} width={70} />
                      <RechartsTooltip
                        contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                        labelStyle={{ color: '#f8fafc' }}
                        formatter={(value: number) => [formatUSD(value), 'Value']}
                      />
                      <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                        {agingData.map((entry, index) => (
                          <Cell key={index} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 space-y-1">
                  {agingData.map(bucket => (
                    <div key={bucket.bucket} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: bucket.fill }} />
                        <span className="text-slate-400">{bucket.bucket}</span>
                      </div>
                      <span className="text-white">{bucket.count} invoices</span>
                    </div>
                  ))}
                </div>
              </GlassCard>
            </div>
          </div>

          {/* DISPUTE RESOLUTION PANEL */}
          <GlassCard className="p-0 overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-slate-700/50">
              <SectionHeader title="Dispute Resolution" />
              <span className="text-xs text-slate-400">{disputes.filter(d => d.status === 'Open' || d.status === 'Escalated').length} active disputes</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Dispute ID</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Invoice</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Reason</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Filed By</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Filed</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {disputes.map(d => (
                    <tr key={d.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-red-400">{d.id}</td>
                      <td className="px-4 py-3 font-mono text-xs text-blue-400">{d.invoiceId}</td>
                      <td className="px-4 py-3 text-sm text-slate-300 max-w-[200px] truncate">{d.reason}</td>
                      <td className="px-4 py-3 text-sm text-white">{d.filedBy}</td>
                      <td className="px-4 py-3 text-xs text-slate-400">{timeAgo(d.filedAt)}</td>
                      <td className="px-4 py-3"><DisputeStatusBadge status={d.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassCard>

        </main>

        <Footer />
      </div>

      {/* FINANCING REQUEST MODAL */}
      <Modal open={showFinancingForm} onClose={() => setShowFinancingForm(false)} title="New Financing Request" maxWidth="max-w-lg">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Invoice Amount (USD)</label>
            <input
              type="number"
              value={formAmount}
              onChange={e => setFormAmount(e.target.value)}
              placeholder="250,000"
              className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500/50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Debtor / Counterparty</label>
            <input
              type="text"
              value={formDebtor}
              onChange={e => setFormDebtor(e.target.value)}
              placeholder="TechCorp International"
              className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500/50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Due Date</label>
            <input
              type="date"
              value={formDueDate}
              onChange={e => setFormDueDate(e.target.value)}
              className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500/50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Terms</label>
            <select className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-red-500/50">
              <option value="net30">Net 30</option>
              <option value="net60">Net 60</option>
              <option value="net90">Net 90</option>
            </select>
          </div>
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setShowFinancingForm(false)}
              className="flex-1 rounded-lg border border-slate-700/50 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-700/50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => setShowFinancingForm(false)}
              className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 transition-colors"
            >
              Submit Request
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
