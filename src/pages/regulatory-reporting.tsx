/**
 * NoblePay Regulatory Reporting — Compliance Reporting Dashboard
 *
 * Regulatory reporting dashboard featuring report templates, filing
 * deadlines, generated reports tracking, jurisdiction filtering,
 * and reporting analytics.
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
  FileText, DollarSign, ArrowUpRight, ArrowDownRight,
  Plus, Shield, AlertTriangle, Clock, CheckCircle,
  Calendar, Filter, Download, Eye,
  Building2, Globe, AlertCircle, XCircle,
  Send, RefreshCw, Bookmark, Scale,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { TopNav, Footer, Badge, Modal } from '@/components/SharedComponents';
import { seededRandom } from '@/lib/utils';
import { BRAND } from '@/lib/constants';
import { GlassCard, SectionHeader, Sparkline } from '@/components/PagePrimitives';


// =============================================================================
// CONSTANTS
// =============================================================================

const CHART_COLORS = [
  '#DC2626', '#0EA5E9', '#10B981', '#F59E0B', '#8B5CF6',
  '#EC4899', '#06B6D4', '#F87171',
];

const JURISDICTIONS = [
  { code: 'UAE', name: 'United Arab Emirates', flag: 'AE' },
  { code: 'US', name: 'United States', flag: 'US' },
  { code: 'EU', name: 'European Union', flag: 'EU' },
  { code: 'UK', name: 'United Kingdom', flag: 'GB' },
  { code: 'SG', name: 'Singapore', flag: 'SG' },
];

const REPORT_TEMPLATES = [
  {
    code: 'SAR',
    name: 'Suspicious Activity Report',
    description: 'Report suspicious transactions exceeding threshold limits for AML compliance.',
    jurisdictions: ['UAE', 'US', 'UK', 'SG'],
    frequency: 'As needed',
    icon: AlertTriangle,
    color: 'text-red-400 bg-red-500/10 border-red-500/20',
  },
  {
    code: 'CTR',
    name: 'Currency Transaction Report',
    description: 'Mandatory filing for currency transactions above regulatory thresholds.',
    jurisdictions: ['US', 'UAE'],
    frequency: 'Per transaction',
    icon: DollarSign,
    color: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  },
  {
    code: 'STR',
    name: 'Suspicious Transaction Report',
    description: 'Transaction monitoring report for potentially suspicious activities.',
    jurisdictions: ['UAE', 'EU', 'SG'],
    frequency: 'As needed',
    icon: Shield,
    color: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  },
  {
    code: 'FATF',
    name: 'FATF Travel Rule Report',
    description: 'Cross-border wire transfer reporting as per FATF Recommendation 16.',
    jurisdictions: ['UAE', 'US', 'EU', 'UK', 'SG'],
    frequency: 'Per transfer',
    icon: Globe,
    color: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
  },
];

const REPORT_STATUS_STYLES: Record<string, string> = {
  Filed: 'bg-emerald-500/20 text-emerald-400',
  Pending: 'bg-amber-500/20 text-amber-400',
  Overdue: 'bg-red-500/20 text-red-400',
  Draft: 'bg-slate-500/20 text-slate-400',
  Rejected: 'bg-red-500/20 text-red-400',
};


// =============================================================================
// TYPES
// =============================================================================

type ReportStatus = 'Filed' | 'Pending' | 'Overdue' | 'Draft' | 'Rejected';

interface GeneratedReport {
  id: string;
  templateCode: string;
  templateName: string;
  jurisdiction: string;
  status: ReportStatus;
  createdAt: number;
  dueDate: number;
  filedAt?: number;
  referenceId: string;
  txCount: number;
  totalAmount: number;
}

interface Deadline {
  id: string;
  reportType: string;
  jurisdiction: string;
  dueDate: number;
  status: 'upcoming' | 'due_soon' | 'overdue';
  description: string;
}


// =============================================================================
// MOCK DATA GENERATORS
// =============================================================================

function generateReports(count: number): GeneratedReport[] {
  const statuses: ReportStatus[] = ['Filed', 'Filed', 'Filed', 'Pending', 'Overdue', 'Draft', 'Rejected'];
  const reports: GeneratedReport[] = [];
  for (let i = 0; i < count; i++) {
    const seed = 5000 + i * 127;
    const template = REPORT_TEMPLATES[Math.floor(seededRandom(seed) * REPORT_TEMPLATES.length)];
    const jurisdiction = template.jurisdictions[Math.floor(seededRandom(seed + 10) * template.jurisdictions.length)];
    const status = statuses[Math.floor(seededRandom(seed + 20) * statuses.length)];
    reports.push({
      id: `RPT-${String(3000 + i).padStart(5, '0')}`,
      templateCode: template.code,
      templateName: template.name,
      jurisdiction,
      status,
      createdAt: Date.now() - Math.floor(seededRandom(seed + 30) * 30 * 86400000),
      dueDate: Date.now() + Math.floor((seededRandom(seed + 40) - 0.3) * 14 * 86400000),
      filedAt: status === 'Filed' ? Date.now() - Math.floor(seededRandom(seed + 50) * 7 * 86400000) : undefined,
      referenceId: `REF-${Math.floor(seededRandom(seed + 60) * 999999).toString().padStart(6, '0')}`,
      txCount: Math.floor(seededRandom(seed + 70) * 50) + 1,
      totalAmount: i === 0 ? 500 : Math.floor(seededRandom(seed + 80) * 5000000) + 10000,
    });
  }
  return reports.sort((a, b) => b.createdAt - a.createdAt);
}

function generateDeadlines(): Deadline[] {
  const deadlines: Deadline[] = [];
  const descriptions = [
    'Quarterly SAR filing — Q1 2026',
    'Monthly CTR aggregate report',
    'FATF travel rule compliance batch',
    'STR suspicious pattern review',
    'Annual regulatory compliance summary',
    'Cross-border transaction disclosure',
    'AML compliance quarterly review',
    'Sanctions screening batch report',
  ];
  for (let i = 0; i < 8; i++) {
    const seed = 6000 + i * 83;
    const daysOffset = Math.floor(seededRandom(seed) * 30) - 5;
    const status = daysOffset < 0 ? 'overdue' as const
      : daysOffset < 3 ? 'due_soon' as const : 'upcoming' as const;
    deadlines.push({
      id: `DL-${100 + i}`,
      reportType: REPORT_TEMPLATES[Math.floor(seededRandom(seed + 10) * REPORT_TEMPLATES.length)].code,
      jurisdiction: JURISDICTIONS[Math.floor(seededRandom(seed + 20) * JURISDICTIONS.length)].code,
      dueDate: Date.now() + daysOffset * 86400000,
      status,
      description: descriptions[i],
    });
  }
  return deadlines.sort((a, b) => a.dueDate - b.dueDate);
}

function generateAnalyticsData(): Array<{ month: string; filed: number; pending: number; overdue: number }> {
  const months = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
  return months.map((month, i) => ({
    month,
    filed: Math.floor(seededRandom(7000 + i * 31) * 40) + 15,
    pending: Math.floor(seededRandom(7000 + i * 47) * 10) + 2,
    overdue: Math.floor(seededRandom(7000 + i * 61) * 5),
  }));
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

function daysUntil(timestamp: number): string {
  const diff = Math.floor((timestamp - Date.now()) / 86400000);
  if (diff < -1) return `${Math.abs(diff)}d overdue`;
  if (diff < 0) return 'Overdue';
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  return `${diff}d remaining`;
}


// =============================================================================
// REUSABLE LOCAL COMPONENTS
// =============================================================================

function ReportStatusBadge({ status }: { status: ReportStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${REPORT_STATUS_STYLES[status] || ''}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

function DeadlineStatusDot({ status }: { status: Deadline['status'] }) {
  const colors: Record<string, string> = {
    upcoming: 'bg-emerald-400',
    due_soon: 'bg-amber-400 animate-pulse',
    overdue: 'bg-red-400 animate-pulse',
  };
  return <span className={`w-2 h-2 rounded-full ${colors[status]}`} />;
}


// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function RegulatoryReportingPage() {
  const { realTime } = useApp();
  const [mounted, setMounted] = useState(false);
  const [jurisdictionFilter, setJurisdictionFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ReportStatus>('all');
  useEffect(() => setMounted(true), []);

  const reports = useMemo(() => generateReports(20), []);
  const deadlines = useMemo(() => generateDeadlines(), []);
  const analyticsData = useMemo(() => generateAnalyticsData(), []);

  const filteredReports = useMemo(() => {
    let filtered = reports;
    if (jurisdictionFilter !== 'all') filtered = filtered.filter(r => r.jurisdiction === jurisdictionFilter);
    if (statusFilter !== 'all') filtered = filtered.filter(r => r.status === statusFilter);
    return filtered;
  }, [reports, jurisdictionFilter, statusFilter]);

  const filedCount = useMemo(() => reports.filter(r => r.status === 'Filed').length, [reports]);
  const pendingCount = useMemo(() => reports.filter(r => r.status === 'Pending' || r.status === 'Draft').length, [reports]);
  const overdueCount = useMemo(() => reports.filter(r => r.status === 'Overdue').length, [reports]);
  const complianceRate = useMemo(() => (filedCount / reports.length) * 100, [filedCount, reports]);

  return (
    <>
      <SEOHead
        title="Regulatory Reporting"
        description="NoblePay regulatory reporting dashboard for compliance filing, deadline tracking, and jurisdiction management."
        path="/regulatory-reporting"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/regulatory-reporting" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* HEADER */}
          <div className="mb-8">
            <div className="flex items-start justify-between mb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay Compliance</p>
                <h1 className="mt-2 text-3xl font-bold text-white">Regulatory Reporting</h1>
                <p className="mt-1 text-sm text-slate-400">Compliance filing, deadline tracking, and multi-jurisdiction reporting</p>
              </div>
            </div>
          </div>

          {/* KPI CARDS */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle className="w-4 h-4 text-emerald-400" />
                <span className="text-xs text-slate-400">Filed Reports</span>
              </div>
              <p className="text-xl font-bold text-white">{filedCount}</p>
              <div className="flex items-center gap-1 mt-1 text-xs text-emerald-400">
                <ArrowUpRight className="w-3 h-3" />On schedule
              </div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <Clock className="w-4 h-4 text-amber-400" />
                <span className="text-xs text-slate-400">Pending / Draft</span>
              </div>
              <p className="text-xl font-bold text-white">{pendingCount}</p>
              <div className="text-xs text-slate-500 mt-1">Awaiting review</div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4 text-red-400" />
                <span className="text-xs text-slate-400">Overdue</span>
              </div>
              <p className="text-xl font-bold text-red-400">{overdueCount}</p>
              <div className="text-xs text-red-400/70 mt-1">Immediate action needed</div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <Shield className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-400">Compliance Rate</span>
              </div>
              <p className="text-xl font-bold text-white">{complianceRate.toFixed(1)}%</p>
              <div className="w-full h-1.5 rounded-full bg-slate-700/50 overflow-hidden mt-2">
                <div
                  className={`h-1.5 rounded-full ${complianceRate > 90 ? 'bg-emerald-500' : complianceRate > 70 ? 'bg-amber-500' : 'bg-red-500'}`}
                  style={{ width: `${complianceRate}%` }}
                />
              </div>
            </GlassCard>
          </div>

          {/* REPORT TEMPLATES GRID */}
          <div className="mb-8">
            <SectionHeader title="Report Templates" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
              {REPORT_TEMPLATES.map(tmpl => {
                const Icon = tmpl.icon;
                return (
                  <GlassCard key={tmpl.code} className="p-4" hover>
                    <div className={`inline-flex p-2 rounded-lg border mb-3 ${tmpl.color}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <h3 className="text-sm font-semibold text-white">{tmpl.code}</h3>
                    <p className="text-xs text-slate-400 mt-1 line-clamp-2">{tmpl.description}</p>
                    <div className="flex flex-wrap gap-1 mt-3">
                      {tmpl.jurisdictions.map(j => (
                        <span key={j} className="px-1.5 py-0.5 rounded text-xs bg-slate-700/50 text-slate-300">{j}</span>
                      ))}
                    </div>
                    <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-700/30">
                      <span className="text-xs text-slate-500">{tmpl.frequency}</span>
                      <button className="text-xs text-red-400 hover:text-red-300 font-medium">Generate</button>
                    </div>
                  </GlassCard>
                );
              })}
            </div>
          </div>

          {/* DEADLINES TIMELINE + ANALYTICS */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">

            {/* FILING DEADLINES */}
            <GlassCard className="p-6">
              <SectionHeader title="Filing Deadlines" />
              <div className="mt-4 space-y-3">
                {deadlines.map(dl => (
                  <div key={dl.id} className="flex items-start gap-3 p-3 rounded-lg bg-slate-800/30 hover:bg-slate-800/50 transition-colors">
                    <div className="mt-1.5">
                      <DeadlineStatusDot status={dl.status} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white">{dl.description}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs text-slate-500">{dl.reportType}</span>
                        <span className="text-xs text-slate-600">|</span>
                        <span className="text-xs text-slate-500">{dl.jurisdiction}</span>
                      </div>
                    </div>
                    <span className={`text-xs font-medium flex-shrink-0 ${
                      dl.status === 'overdue' ? 'text-red-400' : dl.status === 'due_soon' ? 'text-amber-400' : 'text-slate-400'
                    }`}>
                      {daysUntil(dl.dueDate)}
                    </span>
                  </div>
                ))}
              </div>
            </GlassCard>

            {/* REPORTING ANALYTICS */}
            <GlassCard className="p-6">
              <SectionHeader title="Reporting Analytics" />
              <div className="mt-4 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analyticsData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                    <RechartsTooltip
                      contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                      labelStyle={{ color: '#f8fafc' }}
                    />
                    <Legend wrapperStyle={{ fontSize: '11px', color: '#94a3b8' }} />
                    <Bar dataKey="filed" name="Filed" fill="#10B981" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="pending" name="Pending" fill="#F59E0B" radius={[2, 2, 0, 0]} />
                    <Bar dataKey="overdue" name="Overdue" fill="#DC2626" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </GlassCard>
          </div>

          {/* GENERATED REPORTS TABLE */}
          <GlassCard className="p-0 overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-slate-700/50">
              <SectionHeader title="Generated Reports" />
              <div className="flex gap-2">
                {/* Jurisdiction filter */}
                <select
                  value={jurisdictionFilter}
                  onChange={e => setJurisdictionFilter(e.target.value)}
                  className="rounded-lg bg-slate-800/50 border border-slate-700/50 px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-red-500/50"
                >
                  <option value="all">All Jurisdictions</option>
                  {JURISDICTIONS.map(j => (
                    <option key={j.code} value={j.code}>{j.code} — {j.name}</option>
                  ))}
                </select>
                {/* Status filter */}
                <select
                  value={statusFilter}
                  onChange={e => setStatusFilter(e.target.value as 'all' | ReportStatus)}
                  className="rounded-lg bg-slate-800/50 border border-slate-700/50 px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-red-500/50"
                >
                  <option value="all">All Statuses</option>
                  <option value="Filed">Filed</option>
                  <option value="Pending">Pending</option>
                  <option value="Overdue">Overdue</option>
                  <option value="Draft">Draft</option>
                </select>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Report ID</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Type</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Jurisdiction</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-400">Transactions</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-400">Amount</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Due</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Status</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredReports.slice(0, 12).map(r => (
                    <tr key={r.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-red-400">{r.id}</td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-white">{r.templateCode}</span>
                        <div className="text-xs text-slate-500">{r.referenceId}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-1.5 py-0.5 rounded text-xs bg-slate-700/50 text-slate-300">{r.jurisdiction}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300">{r.txCount}</td>
                      <td className="px-4 py-3 text-right text-white font-medium">{formatUSD(r.totalAmount)}</td>
                      <td className="px-4 py-3 text-xs text-slate-400">{daysUntil(r.dueDate)}</td>
                      <td className="px-4 py-3"><ReportStatusBadge status={r.status} /></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button className="p-1 rounded hover:bg-slate-700/50 text-slate-400 hover:text-white transition-colors">
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                          <button className="p-1 rounded hover:bg-slate-700/50 text-slate-400 hover:text-white transition-colors">
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassCard>

        </main>

        <Footer />
      </div>
    </>
  );
}
