/**
 * Compliance Center — Enterprise compliance management dashboard.
 *
 * Sanctions screening, AML monitoring, risk analysis, flagged payment review,
 * investigation tracking, and regulatory reporting for compliance officers.
 *
 * All data is deterministic via seededRandom for SSR hydration safety.
 */

import { useState, useMemo, useEffect } from 'react';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, Legend,
} from 'recharts';
import {
  Shield, ShieldCheck, ShieldAlert, Clock, AlertTriangle, CheckCircle,
  XCircle, Search, Filter, ChevronDown, ChevronUp, ChevronRight,
  Download, FileText, RefreshCw, Eye, Lock, Zap, Activity,
  ArrowRight, AlertCircle, BarChart3, Settings, UserCheck, Users,
  Globe, Play, Pause, ToggleLeft, ToggleRight, FileCheck,
} from 'lucide-react';
import { SEOHead } from '@/components/SEOHead';
import { TopNav, Footer } from '@/components/SharedComponents';
import { GlassCard, SectionHeader, ChartTooltip } from '@/components/PagePrimitives';
import { useApp } from '@/contexts/AppContext';
import { seededRandom, seededHex, seededAddress, formatNumber, truncateAddress } from '@/lib/utils';
import { BRAND } from '@/lib/constants';


// =============================================================================
// CHART COLORS
// =============================================================================

const RISK_COLORS: Record<string, string> = {
  Low: '#10B981',
  Medium: '#F59E0B',
  High: '#F87171',
  Critical: '#DC2626',
};

const CHART_COLORS = ['#10B981', '#3B82F6', '#DC2626'];


// =============================================================================
// TYPES
// =============================================================================

interface SanctionsList {
  name: string;
  source: string;
  lastUpdated: string;
  entries: number;
  status: 'Current' | 'Stale' | 'Critical';
  hoursAgo: number;
}

interface FlaggedPayment {
  id: string;
  date: string;
  amount: number;
  sender: string;
  senderName: string;
  riskScore: number;
  flagReason: string;
  assignedTo: string;
  status: 'Under Review' | 'Escalated' | 'Pending' | 'Cleared';
}

interface InvestigationEntry {
  id: string;
  date: string;
  paymentId: string;
  investigator: string;
  outcome: 'Cleared' | 'Escalated' | 'Blocked';
  notes: string;
}

interface ComplianceReport {
  name: string;
  lastGenerated: string;
  status: 'Complete' | 'In Progress' | 'Scheduled';
  icon: typeof FileText;
}

interface PipelineStage {
  name: string;
  count: number;
  avgTime: string;
  icon: typeof Shield;
}


// =============================================================================
// MOCK DATA GENERATORS
// =============================================================================

const SANCTIONS_LISTS: SanctionsList[] = [
  { name: 'OFAC SDN List', source: 'US Treasury', lastUpdated: '2024-01-14T18:30:00Z', entries: 12847, status: 'Current', hoursAgo: 4 },
  { name: 'UAE Central Bank', source: 'CBUAE', lastUpdated: '2024-01-14T12:00:00Z', entries: 3291, status: 'Current', hoursAgo: 10 },
  { name: 'UN Consolidated List', source: 'United Nations', lastUpdated: '2024-01-13T08:00:00Z', entries: 8453, status: 'Stale', hoursAgo: 38 },
  { name: 'EU Sanctions List', source: 'European Union', lastUpdated: '2024-01-12T06:00:00Z', entries: 6124, status: 'Critical', hoursAgo: 62 },
];

const FLAG_REASONS = [
  'Velocity threshold exceeded',
  'High-risk jurisdiction',
  'Structuring pattern detected',
  'Sanctions screening match',
  'Unusual transaction pattern',
  'Round-trip payment detected',
  'Large cash-equivalent transfer',
  'Counterparty risk alert',
];

const INVESTIGATOR_NAMES = [
  'Sarah Al-Rashid',
  'Ahmed Hassan',
  'Fatima Al-Qasimi',
  'Omar Khalifa',
  'Layla Mahmoud',
];

const INVESTIGATION_NOTES = [
  'False positive confirmed — legitimate trade settlement between verified entities.',
  'Structuring pattern found — referred to AML team for SAR filing.',
  'Counterparty cleared after enhanced due diligence review.',
  'Sanctions match on secondary alias — payment blocked and frozen.',
  'Velocity spike due to quarterly dividend distribution — cleared.',
  'Round-trip pattern confirmed — accounts flagged for monitoring.',
  'High-risk jurisdiction transfer verified with correspondent bank.',
  'Pattern matching error — rule threshold adjustment recommended.',
  'Multiple small transfers below threshold — escalated for review.',
  'Legitimate recurring payment series — whitelist recommendation filed.',
];

function generateFlaggedPayments(): FlaggedPayment[] {
  const statuses: FlaggedPayment['status'][] = ['Under Review', 'Escalated', 'Pending', 'Cleared'];
  return Array.from({ length: 8 }, (_, i) => {
    const seed = 5000 + i * 17;
    return {
      id: `NP-${String(20240100 + seededRandom(seed) * 99 | 0).slice(0, 8)}-${seededHex(seed + 1, 4).toUpperCase()}`,
      date: `2024-01-${String(8 + (seededRandom(seed + 2) * 7 | 0)).padStart(2, '0')}`,
      amount: Math.round(seededRandom(seed + 3) * 450000 + 5000),
      sender: seededAddress(seed + 4),
      senderName: ['Al Maktoum Holdings', 'Emirates Global', 'Dubai Digital FZ', 'Abu Dhabi Invest', 'Sharjah Trade Co', 'RAK Ventures', 'Ajman Commerce', 'Fujairah Logistics'][i],
      riskScore: Math.round(seededRandom(seed + 5) * 60 + 40),
      flagReason: FLAG_REASONS[i % FLAG_REASONS.length],
      assignedTo: INVESTIGATOR_NAMES[i % INVESTIGATOR_NAMES.length],
      status: statuses[i % statuses.length],
    };
  });
}

function generateInvestigations(): InvestigationEntry[] {
  const outcomes: InvestigationEntry['outcome'][] = ['Cleared', 'Escalated', 'Blocked'];
  return Array.from({ length: 10 }, (_, i) => {
    const seed = 7000 + i * 23;
    return {
      id: `INV-${String(2024001 + i).padStart(7, '0')}`,
      date: `2024-01-${String(14 - i).padStart(2, '0')}`,
      paymentId: `NP-2024010${i}-${seededHex(seed, 4).toUpperCase()}`,
      investigator: INVESTIGATOR_NAMES[i % INVESTIGATOR_NAMES.length],
      outcome: outcomes[i % outcomes.length],
      notes: INVESTIGATION_NOTES[i],
    };
  });
}

function generateScreeningChartData(): { day: string; passed: number; flagged: number; blocked: number }[] {
  return Array.from({ length: 30 }, (_, i) => {
    const seed = 9000 + i * 13;
    const day = `Jan ${i + 1}`;
    return {
      day,
      passed: Math.round(seededRandom(seed) * 800 + 1200),
      flagged: Math.round(seededRandom(seed + 1) * 15 + 5),
      blocked: Math.round(seededRandom(seed + 2) * 3 + 1),
    };
  });
}

const RISK_DISTRIBUTION = [
  { name: 'Low', value: 18742, color: RISK_COLORS.Low },
  { name: 'Medium', value: 1284, color: RISK_COLORS.Medium },
  { name: 'High', value: 187, color: RISK_COLORS.High },
  { name: 'Critical', value: 23, color: RISK_COLORS.Critical },
];


// =============================================================================
// HELPER COMPONENTS
// =============================================================================

function LiveDot({ color = 'green' }: { color?: 'green' | 'red' | 'yellow' }) {
  const colorMap = { green: 'bg-emerald-500', red: 'bg-red-500', yellow: 'bg-yellow-500' };
  const ringMap = { green: 'bg-emerald-500/40', red: 'bg-red-500/40', yellow: 'bg-yellow-500/40' };

  return (
    <span className="relative inline-flex items-center justify-center">
      <span
        className={`absolute inline-flex rounded-full ${ringMap[color]} h-4 w-4`}
        style={{ animation: 'live-dot 2s ease-in-out infinite' }}
      />
      <span className={`relative inline-flex rounded-full ${colorMap[color]} h-2 w-2`} />
    </span>
  );
}

function MetricCard({
  title,
  value,
  subtitle,
  icon: Icon,
  tone = 'slate',
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: typeof Shield;
  tone?: 'green' | 'red' | 'amber' | 'blue' | 'slate' | 'cyan';
}) {
  const toneStyles: Record<string, string> = {
    green: 'from-emerald-500/10 to-emerald-900/10 border-emerald-700/30',
    red: 'from-red-500/10 to-red-900/10 border-red-700/30',
    amber: 'from-amber-500/10 to-amber-900/10 border-amber-700/30',
    blue: 'from-blue-500/10 to-blue-900/10 border-blue-700/30',
    slate: 'from-slate-500/10 to-slate-900/10 border-slate-700/30',
    cyan: 'from-cyan-500/10 to-cyan-900/10 border-cyan-700/30',
  };

  const iconTone: Record<string, string> = {
    green: 'text-emerald-400',
    red: 'text-red-400',
    amber: 'text-amber-400',
    blue: 'text-blue-400',
    slate: 'text-slate-400',
    cyan: 'text-cyan-400',
  };

  return (
    <GlassCard className={`p-5 bg-gradient-to-br ${toneStyles[tone]}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">{title}</p>
          <p className="mt-2 text-2xl font-bold text-white tabular-nums">{value}</p>
          {subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}
        </div>
        <div className={`rounded-lg bg-slate-800/50 p-2 ${iconTone[tone]}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </GlassCard>
  );
}

function FreshnessBadge({ hoursAgo }: { hoursAgo: number }) {
  if (hoursAgo < 24) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400 ring-1 ring-inset ring-emerald-500/20">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        Fresh ({hoursAgo}h ago)
      </span>
    );
  }
  if (hoursAgo < 48) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400 ring-1 ring-inset ring-amber-500/20">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Stale ({hoursAgo}h ago)
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-400 ring-1 ring-inset ring-red-500/20">
      <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
      Critical ({hoursAgo}h ago)
    </span>
  );
}


// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function CompliancePage() {
  const { wallet } = useApp();
  const [mounted, setMounted] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());
  const [showEditModal, setShowEditModal] = useState(false);
  const [ruleToggles, setRuleToggles] = useState({
    velocityCheck: true,
    patternDetection: true,
    counterpartyRisk: true,
    travelRule: true,
  });

  useEffect(() => setMounted(true), []);

  const flaggedPayments = useMemo(() => generateFlaggedPayments(), []);
  const investigations = useMemo(() => generateInvestigations(), []);
  const screeningData = useMemo(() => generateScreeningChartData(), []);

  const filteredPayments = useMemo(() => {
    return flaggedPayments.filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          p.id.toLowerCase().includes(q) ||
          p.senderName.toLowerCase().includes(q) ||
          p.flagReason.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [flaggedPayments, statusFilter, searchQuery]);

  const toggleRule = (key: string) => {
    setExpandedRules((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const pipelineStages: PipelineStage[] = [
    { name: 'Payment Received', count: 2847, avgTime: '0ms', icon: Zap },
    { name: 'Sanctions Check', count: 2847, avgTime: '87ms', icon: ShieldCheck },
    { name: 'AML Scoring', count: 2841, avgTime: '142ms', icon: BarChart3 },
    { name: 'Travel Rule', count: 2838, avgTime: '53ms', icon: Globe },
    { name: 'Decision', count: 2835, avgTime: '12ms', icon: CheckCircle },
  ];

  const complianceReports: ComplianceReport[] = [
    { name: 'Monthly Compliance Report', lastGenerated: '2024-01-01', status: 'Complete', icon: FileText },
    { name: 'Quarterly SAR Filing', lastGenerated: '2023-12-31', status: 'Complete', icon: FileCheck },
    { name: 'Annual AML Review', lastGenerated: '2023-12-15', status: 'In Progress', icon: Shield },
    { name: 'Regulatory Submission', lastGenerated: '2024-01-10', status: 'Scheduled', icon: Globe },
  ];

  return (
    <>
      <SEOHead
        title="Compliance Center"
        description="Enterprise compliance management dashboard for NoblePay regulatory officers. Sanctions screening, AML monitoring, and risk analysis."
        path="/compliance"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/compliance" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* ================================================================
              SECTION 1 — Compliance Status Banner
              ================================================================ */}
          <GlassCard className="p-6 mb-8" hover={false}>
            <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-6">
                <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-emerald-500/10 border border-emerald-500/20">
                  <ShieldCheck className="h-10 w-10 text-emerald-400" />
                </div>
                <div>
                  <div className="flex items-center gap-3">
                    <span className="text-5xl font-bold text-white tabular-nums">97.8%</span>
                    <span className="text-sm font-medium text-emerald-400 bg-emerald-500/10 rounded-full px-3 py-1">Excellent</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-400">Overall Compliance Score</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-6">
                <div className="flex items-center gap-2">
                  <LiveDot color="green" />
                  <span className="text-sm font-medium text-emerald-400">All Systems Operational</span>
                </div>
                <div className="text-sm text-slate-400">
                  <span className="text-slate-500">Last Audit:</span>{' '}
                  <span className="text-slate-300">2024-01-15</span>
                </div>
                <div className="text-sm text-slate-400">
                  <span className="text-slate-500">Next Scheduled:</span>{' '}
                  <span className="text-slate-300">2024-04-15</span>
                </div>
              </div>
            </div>
          </GlassCard>

          {/* ================================================================
              SECTION 2 — Compliance Metrics Grid
              ================================================================ */}
          <SectionHeader title="Compliance Metrics" subtitle="Real-time screening and verification performance" size="sm" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-10">
            <MetricCard title="Sanctions Screening Rate" value="99.9%" subtitle="Uptime last 30 days" icon={ShieldCheck} tone="green" />
            <MetricCard title="Average Screening Time" value="87ms" subtitle="Per transaction" icon={Zap} tone="cyan" />
            <MetricCard title="False Positive Rate" value="2.1%" subtitle="Last 30 days" icon={AlertTriangle} tone="amber" />
            <MetricCard title="Manual Review Queue" value="3" subtitle="Items pending" icon={Eye} tone="blue" />
            <MetricCard title="Travel Rule Compliance" value="100%" subtitle="All jurisdictions" icon={Globe} tone="green" />
            <MetricCard title="TEE Attestation Validity" value="12/12" subtitle="All nodes valid" icon={Lock} tone="green" />
          </div>

          {/* ================================================================
              SECTION 3 — Sanctions Lists Management
              ================================================================ */}
          <SectionHeader title="Sanctions Lists" subtitle="Source list synchronization and freshness monitoring" size="sm" />
          <GlassCard className="mb-10 overflow-hidden" hover={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">List Name</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Source</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Last Updated</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-slate-400">Entries</th>
                    <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-slate-400">Status</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-slate-400">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {SANCTIONS_LISTS.map((list, i) => (
                    <tr key={list.name} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3 font-medium text-white">{list.name}</td>
                      <td className="px-4 py-3 text-slate-400">{list.source}</td>
                      <td className="px-4 py-3 text-slate-400 text-xs font-mono">{list.lastUpdated.replace('T', ' ').replace('Z', ' UTC')}</td>
                      <td className="px-4 py-3 text-right text-slate-300 tabular-nums">{list.entries.toLocaleString()}</td>
                      <td className="px-4 py-3 text-center">
                        <FreshnessBadge hoursAgo={list.hoursAgo} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-red-500/50 hover:text-white transition-colors">
                          <RefreshCw className="h-3 w-3" />
                          Force Update
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-slate-700/50 px-4 py-3">
              <p className="text-xs text-slate-500">4 lists configured &middot; Auto-sync every 6 hours</p>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-500">Overall sync:</span>
                <span className="text-amber-400 font-medium">2 of 4 current</span>
              </div>
            </div>
          </GlassCard>

          {/* ================================================================
              SECTION 4 — Screening Pipeline Visualization
              ================================================================ */}
          <SectionHeader title="Screening Pipeline" subtitle="Real-time payment processing flow" size="sm" />
          <GlassCard className="p-6 mb-10" hover={false}>
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-0">
              {pipelineStages.map((stage, idx) => {
                const Icon = stage.icon;
                const isLast = idx === pipelineStages.length - 1;
                const dropped = idx > 0 ? pipelineStages[idx - 1].count - stage.count : 0;
                return (
                  <div key={stage.name} className="flex items-center flex-1">
                    <div className="flex-1 rounded-xl border border-slate-700/50 bg-slate-800/40 p-4 text-center relative overflow-hidden">
                      <div className="compliance-scan absolute inset-0" />
                      <div className="relative z-10">
                        <Icon className="h-6 w-6 text-red-400 mx-auto mb-2" />
                        <p className="text-xs font-medium text-slate-300">{stage.name}</p>
                        <p className="text-xl font-bold text-white tabular-nums mt-1">{stage.count.toLocaleString()}</p>
                        <p className="text-[10px] text-slate-500 mt-1">Avg: {stage.avgTime}</p>
                        {dropped > 0 && (
                          <p className="text-[10px] text-red-400 mt-0.5">-{dropped} filtered</p>
                        )}
                      </div>
                    </div>
                    {!isLast && (
                      <div className="hidden lg:flex items-center px-2">
                        <div className="w-6 h-px bg-slate-600" />
                        <ChevronRight className="h-4 w-4 text-slate-600 -ml-1" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-500">
              <Activity className="h-3.5 w-3.5 text-emerald-400 animate-pulse" />
              Processing payments in real-time &middot; Total pipeline latency: 294ms
            </div>
          </GlassCard>

          {/* ================================================================
              SECTION 5 — Risk Distribution Dashboard
              ================================================================ */}
          <SectionHeader title="Risk Analysis" subtitle="Transaction risk distribution and screening trends" size="sm" />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-10">
            {/* Pie Chart - Risk Distribution */}
            <GlassCard className="p-6" hover={false}>
              <h3 className="text-lg font-semibold text-white mb-4">Risk Distribution</h3>
              {mounted && (
                <div className="flex items-center gap-6">
                  <ResponsiveContainer width="50%" height={220}>
                    <PieChart>
                      <Pie
                        data={RISK_DISTRIBUTION}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={90}
                        innerRadius={55}
                        strokeWidth={0}
                      >
                        {RISK_DISTRIBUTION.map((entry) => (
                          <Cell key={entry.name} fill={entry.color} />
                        ))}
                      </Pie>
                      <RechartsTooltip content={<ChartTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex-1 space-y-3">
                    {RISK_DISTRIBUTION.map((item) => (
                      <div key={item.name} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} />
                          <span className="text-sm text-slate-300">{item.name}</span>
                        </div>
                        <span className="text-sm font-medium text-white tabular-nums">{item.value.toLocaleString()}</span>
                      </div>
                    ))}
                    <div className="border-t border-slate-700/50 pt-2">
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span>Total Screened</span>
                        <span className="font-medium text-slate-300">20,236</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </GlassCard>

            {/* Bar Chart - Screening Results */}
            <GlassCard className="p-6" hover={false}>
              <h3 className="text-lg font-semibold text-white mb-4">Screening Results (30 Days)</h3>
              {mounted && (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={screeningData.slice(-15)} barCategoryGap="20%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="day" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <RechartsTooltip content={<ChartTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="passed" fill="#10B981" name="Passed" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="flagged" fill="#F59E0B" name="Flagged" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="blocked" fill="#DC2626" name="Blocked" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </GlassCard>
          </div>

          {/* ================================================================
              SECTION 6 — Flagged Payments Queue
              ================================================================ */}
          <SectionHeader
            title="Flagged Payments"
            subtitle="Payments requiring manual compliance review"
            size="sm"
            action={
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-400 ring-1 ring-inset ring-amber-500/20">
                <AlertTriangle className="h-3 w-3" />
                {flaggedPayments.filter((p) => p.status !== 'Cleared').length} Active
              </span>
            }
          />
          <GlassCard className="mb-10 overflow-hidden" hover={false}>
            {/* Filters */}
            <div className="flex flex-col gap-3 border-b border-slate-700/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  placeholder="Search by ID, name, or reason..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800/50 py-2 pl-10 pr-4 text-sm text-slate-100 placeholder-slate-500 focus:border-red-500/50 focus:outline-none focus:ring-1 focus:ring-red-500/30"
                />
              </div>
              <div className="flex items-center gap-2">
                <Filter className="h-4 w-4 text-slate-500" />
                {['all', 'Under Review', 'Escalated', 'Pending', 'Cleared'].map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      statusFilter === s
                        ? 'bg-red-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
                    }`}
                  >
                    {s === 'all' ? 'All' : s}
                  </button>
                ))}
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Payment ID</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Date</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-slate-400">Amount</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Sender</th>
                    <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-slate-400">Risk Score</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Flag Reason</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Assigned To</th>
                    <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-slate-400">Status</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-slate-400">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPayments.map((payment) => {
                    const riskColor = payment.riskScore >= 80 ? '#DC2626' : payment.riskScore >= 60 ? '#F59E0B' : '#3B82F6';
                    const statusStyle: Record<string, string> = {
                      'Under Review': 'bg-amber-500/10 text-amber-400 ring-amber-500/20',
                      Escalated: 'bg-red-500/10 text-red-400 ring-red-500/20',
                      Pending: 'bg-blue-500/10 text-blue-400 ring-blue-500/20',
                      Cleared: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20',
                    };
                    return (
                      <tr key={payment.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                        <td className="px-4 py-3 font-mono text-xs text-red-400">{payment.id}</td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{payment.date}</td>
                        <td className="px-4 py-3 text-right font-medium text-white tabular-nums">${payment.amount.toLocaleString()}</td>
                        <td className="px-4 py-3">
                          <div className="text-slate-300 text-xs">{payment.senderName}</div>
                          <div className="font-mono text-[10px] text-slate-600">{truncateAddress(payment.sender, 8, 4)}</div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 justify-center">
                            <span className="text-xs font-bold tabular-nums" style={{ color: riskColor }}>{payment.riskScore}</span>
                            <div className="h-1.5 w-12 rounded-full bg-slate-800">
                              <div className="h-1.5 rounded-full" style={{ width: `${payment.riskScore}%`, backgroundColor: riskColor }} />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-400 max-w-[180px] truncate">{payment.flagReason}</td>
                        <td className="px-4 py-3 text-xs text-slate-300">{payment.assignedTo}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusStyle[payment.status]}`}>
                            {payment.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-700 hover:text-white transition-colors" title="Review">
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                            <button className="rounded px-2 py-1 text-xs text-amber-400 hover:bg-amber-500/10 transition-colors" title="Escalate">
                              <AlertTriangle className="h-3.5 w-3.5" />
                            </button>
                            <button className="rounded px-2 py-1 text-xs text-emerald-400 hover:bg-emerald-500/10 transition-colors" title="Clear">
                              <CheckCircle className="h-3.5 w-3.5" />
                            </button>
                            <button className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 transition-colors" title="Block">
                              <XCircle className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-slate-700/50 px-4 py-3">
              <p className="text-xs text-slate-500">Showing {filteredPayments.length} of {flaggedPayments.length} flagged payments</p>
            </div>
          </GlassCard>

          {/* ================================================================
              SECTION 7 — AML Rule Configuration
              ================================================================ */}
          <SectionHeader
            title="AML Rule Configuration"
            subtitle="Active anti-money laundering detection rules"
            size="sm"
            action={
              <button
                onClick={() => setShowEditModal(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-xs font-medium text-white hover:bg-red-700 transition-colors"
              >
                <Settings className="h-3.5 w-3.5" />
                Edit Rules
              </button>
            }
          />
          <div className="grid grid-cols-1 gap-4 mb-10">
            {/* Velocity Check */}
            <GlassCard className="overflow-hidden" hover={false}>
              <button
                onClick={() => toggleRule('velocity')}
                className="flex w-full items-center justify-between px-5 py-4 text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-blue-500/10 p-2">
                    <Zap className="h-5 w-5 text-blue-400" />
                  </div>
                  <div>
                    <p className="font-medium text-white">Velocity Check</p>
                    <p className="text-xs text-slate-400">Transaction frequency and volume monitoring</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={(e) => { e.stopPropagation(); setRuleToggles((prev) => ({ ...prev, velocityCheck: !prev.velocityCheck })); }}
                    className="text-emerald-400"
                  >
                    {ruleToggles.velocityCheck ? <ToggleRight className="h-6 w-6" /> : <ToggleLeft className="h-6 w-6 text-slate-600" />}
                  </button>
                  {expandedRules.has('velocity') ? <ChevronUp className="h-4 w-4 text-slate-500" /> : <ChevronDown className="h-4 w-4 text-slate-500" />}
                </div>
              </button>
              {expandedRules.has('velocity') && (
                <div className="border-t border-slate-700/50 px-5 py-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-lg bg-slate-800/50 p-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Max Transactions / Hour</p>
                    <p className="mt-1 text-lg font-bold text-white">10</p>
                  </div>
                  <div className="rounded-lg bg-slate-800/50 p-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Max Daily Volume</p>
                    <p className="mt-1 text-lg font-bold text-white">$100,000</p>
                  </div>
                </div>
              )}
            </GlassCard>

            {/* Pattern Detection */}
            <GlassCard className="overflow-hidden" hover={false}>
              <button
                onClick={() => toggleRule('pattern')}
                className="flex w-full items-center justify-between px-5 py-4 text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-amber-500/10 p-2">
                    <Activity className="h-5 w-5 text-amber-400" />
                  </div>
                  <div>
                    <p className="font-medium text-white">Pattern Detection</p>
                    <p className="text-xs text-slate-400">Structuring, round-trip, and anomaly detection</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={(e) => { e.stopPropagation(); setRuleToggles((prev) => ({ ...prev, patternDetection: !prev.patternDetection })); }}
                    className="text-emerald-400"
                  >
                    {ruleToggles.patternDetection ? <ToggleRight className="h-6 w-6" /> : <ToggleLeft className="h-6 w-6 text-slate-600" />}
                  </button>
                  {expandedRules.has('pattern') ? <ChevronUp className="h-4 w-4 text-slate-500" /> : <ChevronDown className="h-4 w-4 text-slate-500" />}
                </div>
              </button>
              {expandedRules.has('pattern') && (
                <div className="border-t border-slate-700/50 px-5 py-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg bg-slate-800/50 p-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Structuring Threshold</p>
                    <p className="mt-1 text-lg font-bold text-white">$9,500</p>
                  </div>
                  <div className="rounded-lg bg-slate-800/50 p-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Round-Trip Detection</p>
                    <p className="mt-1 text-lg font-bold text-emerald-400">Enabled</p>
                  </div>
                  <div className="rounded-lg bg-slate-800/50 p-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Anomaly Window</p>
                    <p className="mt-1 text-lg font-bold text-white">24 hours</p>
                  </div>
                </div>
              )}
            </GlassCard>

            {/* Counterparty Risk */}
            <GlassCard className="overflow-hidden" hover={false}>
              <button
                onClick={() => toggleRule('counterparty')}
                className="flex w-full items-center justify-between px-5 py-4 text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-red-500/10 p-2">
                    <Users className="h-5 w-5 text-red-400" />
                  </div>
                  <div>
                    <p className="font-medium text-white">Counterparty Risk</p>
                    <p className="text-xs text-slate-400">Jurisdiction-based risk scoring and monitoring</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={(e) => { e.stopPropagation(); setRuleToggles((prev) => ({ ...prev, counterpartyRisk: !prev.counterpartyRisk })); }}
                    className="text-emerald-400"
                  >
                    {ruleToggles.counterpartyRisk ? <ToggleRight className="h-6 w-6" /> : <ToggleLeft className="h-6 w-6 text-slate-600" />}
                  </button>
                  {expandedRules.has('counterparty') ? <ChevronUp className="h-4 w-4 text-slate-500" /> : <ChevronDown className="h-4 w-4 text-slate-500" />}
                </div>
              </button>
              {expandedRules.has('counterparty') && (
                <div className="border-t border-slate-700/50 px-5 py-4">
                  <p className="text-xs text-slate-400 mb-3">High-risk jurisdictions actively monitored:</p>
                  <div className="flex flex-wrap gap-2">
                    {['DPRK', 'Iran', 'Syria', 'Myanmar', 'Russia', 'Belarus', 'Venezuela', 'Cuba'].map((j) => (
                      <span key={j} className="rounded-full bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400 ring-1 ring-inset ring-red-500/20">
                        {j}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </GlassCard>

            {/* Travel Rule */}
            <GlassCard className="overflow-hidden" hover={false}>
              <button
                onClick={() => toggleRule('travelrule')}
                className="flex w-full items-center justify-between px-5 py-4 text-left"
              >
                <div className="flex items-center gap-3">
                  <div className="rounded-lg bg-cyan-500/10 p-2">
                    <Globe className="h-5 w-5 text-cyan-400" />
                  </div>
                  <div>
                    <p className="font-medium text-white">Travel Rule Enforcement</p>
                    <p className="text-xs text-slate-400">FATF Travel Rule compliance for cross-border transfers</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={(e) => { e.stopPropagation(); setRuleToggles((prev) => ({ ...prev, travelRule: !prev.travelRule })); }}
                    className="text-emerald-400"
                  >
                    {ruleToggles.travelRule ? <ToggleRight className="h-6 w-6" /> : <ToggleLeft className="h-6 w-6 text-slate-600" />}
                  </button>
                  {expandedRules.has('travelrule') ? <ChevronUp className="h-4 w-4 text-slate-500" /> : <ChevronDown className="h-4 w-4 text-slate-500" />}
                </div>
              </button>
              {expandedRules.has('travelrule') && (
                <div className="border-t border-slate-700/50 px-5 py-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-lg bg-slate-800/50 p-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Threshold</p>
                    <p className="mt-1 text-lg font-bold text-white">$1,000 USD equivalent</p>
                  </div>
                  <div className="rounded-lg bg-slate-800/50 p-3">
                    <p className="text-xs text-slate-500 uppercase tracking-wide">Protocol</p>
                    <p className="mt-1 text-lg font-bold text-cyan-400">TRISA v2</p>
                  </div>
                </div>
              )}
            </GlassCard>
          </div>

          {/* ================================================================
              SECTION 8 — Compliance Reports
              ================================================================ */}
          <SectionHeader title="Compliance Reports" subtitle="Regulatory filings and compliance documentation" size="sm" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-10">
            {complianceReports.map((report) => {
              const Icon = report.icon;
              const statusColor: Record<string, string> = {
                Complete: 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20',
                'In Progress': 'text-amber-400 bg-amber-500/10 ring-amber-500/20',
                Scheduled: 'text-blue-400 bg-blue-500/10 ring-blue-500/20',
              };
              return (
                <GlassCard key={report.name} className="p-5">
                  <div className="flex items-start gap-3 mb-4">
                    <div className="rounded-lg bg-slate-800/50 p-2">
                      <Icon className="h-5 w-5 text-red-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">{report.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">Last: {report.lastGenerated}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusColor[report.status]}`}>
                      {report.status}
                    </span>
                    <div className="flex items-center gap-1">
                      <button className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-white transition-colors" title="Download">
                        <Download className="h-3.5 w-3.5" />
                      </button>
                      <button className="rounded p-1.5 text-slate-400 hover:bg-slate-700 hover:text-white transition-colors" title="Generate">
                        <RefreshCw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </GlassCard>
              );
            })}
          </div>

          {/* ================================================================
              SECTION 9 — Investigation Log
              ================================================================ */}
          <SectionHeader title="Investigation Log" subtitle="Recent compliance investigations and outcomes" size="sm" />
          <GlassCard className="p-6 mb-10" hover={false}>
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-4 top-0 bottom-0 w-px bg-slate-700/50" />

              <div className="space-y-6">
                {investigations.map((inv) => {
                  const outcomeColors: Record<string, { dot: string; bg: string; text: string }> = {
                    Cleared: { dot: 'bg-emerald-400', bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
                    Escalated: { dot: 'bg-amber-400', bg: 'bg-amber-500/10', text: 'text-amber-400' },
                    Blocked: { dot: 'bg-red-400', bg: 'bg-red-500/10', text: 'text-red-400' },
                  };
                  const style = outcomeColors[inv.outcome] || outcomeColors.Cleared;
                  const OutcomeIcon = inv.outcome === 'Cleared' ? CheckCircle : inv.outcome === 'Blocked' ? XCircle : AlertTriangle;

                  return (
                    <div key={inv.id} className="relative pl-10">
                      {/* Timeline dot */}
                      <div className={`absolute left-2.5 top-1 h-3 w-3 rounded-full border-2 border-slate-900 ${style.dot}`} />

                      <div className="rounded-xl border border-slate-800/50 bg-slate-800/20 p-4">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-slate-500">{inv.date}</span>
                            <span className="font-mono text-xs text-red-400">{inv.id}</span>
                            <span className="font-mono text-[10px] text-slate-600">{inv.paymentId}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-400">{inv.investigator}</span>
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text} ring-1 ring-inset ring-white/5`}>
                              <OutcomeIcon className="h-3 w-3" />
                              {inv.outcome}
                            </span>
                          </div>
                        </div>
                        <p className="mt-2 text-sm text-slate-400">{inv.notes}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </GlassCard>

        </main>

        <Footer />
      </div>

      {/* Edit Rules Modal */}
      {showEditModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowEditModal(false)}
            style={{ animation: 'modal-overlay-in 0.2s ease-out' }}
          />
          <div
            className="relative w-full max-w-lg rounded-2xl border border-slate-700/50 bg-slate-900 p-6 shadow-2xl"
            style={{ animation: 'modal-content-in 0.3s ease-out' }}
          >
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold text-white">Edit AML Rules</h3>
              <button
                onClick={() => setShowEditModal(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
              >
                <XCircle className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Max Transactions / Hour</label>
                <input type="number" defaultValue={10} className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-red-500/50 focus:outline-none focus:ring-1 focus:ring-red-500/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Max Daily Volume (USD)</label>
                <input type="number" defaultValue={100000} className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-red-500/50 focus:outline-none focus:ring-1 focus:ring-red-500/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Structuring Threshold (USD)</label>
                <input type="number" defaultValue={9500} className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-red-500/50 focus:outline-none focus:ring-1 focus:ring-red-500/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Travel Rule Threshold (USD)</label>
                <input type="number" defaultValue={1000} className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-red-500/50 focus:outline-none focus:ring-1 focus:ring-red-500/30" />
              </div>
            </div>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                onClick={() => setShowEditModal(false)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-400 hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => setShowEditModal(false)}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
