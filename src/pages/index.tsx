/**
 * NoblePay Dashboard — Main Landing Page
 *
 * Enterprise cross-border payment operations dashboard showing real-time
 * payment feeds, compliance pipeline status, volume analytics, business
 * metrics, settlement performance, and TEE health monitoring.
 *
 * All mock data uses seededRandom for deterministic SSR hydration.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { SEOHead } from '@/components/SEOHead';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  Legend, ReferenceLine,
} from 'recharts';
import {
  Activity, Shield, Cpu, TrendingUp, Clock, CheckCircle,
  ArrowUpRight, ArrowDownRight, ChevronRight, ExternalLink,
  Zap, Lock, Server, Globe, Eye, ShieldCheck,
  BarChart3, AlertCircle, FileText, Upload, DollarSign,
  Building2, Timer, Fingerprint, Radio, Heart, Wifi,
  CreditCard, Send, Download, Users,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { TopNav, Footer } from '@/components/SharedComponents';
import { seededRandom, seededHex, seededAddress, formatNumber, truncateAddress } from '@/lib/utils';
import { BRAND } from '@/lib/constants';
import { GlassCard, SectionHeader, Sparkline } from '@/components/PagePrimitives';


// =============================================================================
// CHART & LOCAL CONSTANTS
// =============================================================================

const CHART_COLORS = [
  '#DC2626', '#F87171', '#FCA5A5', '#FECACA', '#FEE2E2',
  '#10B981', '#3B82F6', '#8B5CF6', '#F59E0B',
];

const PAYMENT_STATUS_COLORS: Record<string, string> = {
  Pending: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  Screening: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  Passed: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  Flagged: 'bg-red-500/20 text-red-400 border-red-500/30',
  Settled: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  Blocked: 'bg-red-700/20 text-red-500 border-red-700/30',
  Refunded: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
};

const PAYMENT_STATUS_DOT: Record<string, string> = {
  Pending: 'bg-amber-400',
  Screening: 'bg-blue-400',
  Passed: 'bg-emerald-400',
  Flagged: 'bg-red-400',
  Settled: 'bg-cyan-400',
  Blocked: 'bg-red-500',
  Refunded: 'bg-purple-400',
};

const RISK_COLORS: Record<string, string> = {
  Low: '#10B981',
  Medium: '#F59E0B',
  High: '#F87171',
  Critical: '#DC2626',
};


// =============================================================================
// TYPES
// =============================================================================

interface MockPayment {
  id: string;
  sender: string;
  senderName: string;
  recipient: string;
  recipientName: string;
  amount: number;
  currency: string;
  status: string;
  riskScore: number;
  timestamp: number;
  settlementTime: number | null;
  teeAttestation: string;
}

interface MockBusiness {
  name: string;
  jurisdiction: string;
  tier: string;
  volume24h: number;
  paymentCount: number;
  complianceScore: number;
}

interface MockTEENode {
  id: string;
  status: 'online' | 'offline';
  lastHeartbeat: number;
  attestationValid: boolean;
  region: string;
  version: string;
  uptime: number;
}

interface MockFlag {
  paymentId: string;
  reason: string;
  riskScore: number;
  timestamp: number;
}


// =============================================================================
// DATA GENERATORS
// =============================================================================

const UAE_BUSINESS_NAMES = [
  'Emirates Digital Holdings', 'Abu Dhabi FinTech Corp', 'Dubai Precious Metals LLC',
  'Al Habtoor Trading Group', 'Majid Al Futtaim Finance', 'RAK Free Zone Ventures',
  'Sharjah Capital Partners', 'DIFC Investment Authority', 'Nakheel Payment Systems',
  'Emaar Digital Services', 'Al Ghurair Exchange', 'Mashreq Tech Solutions',
  'ADGM Custody Services', 'Jumeirah Blockchain Lab', 'Gulf Capital Pay',
  'Ajman Trade Finance', 'Fujairah Commodities Inc', 'Damac Financial Technologies',
];

const JURISDICTIONS = ['DIFC', 'ADGM', 'RAK DAO', 'DAFZA', 'DMCC', 'SCA', 'CBUAE'];
const CURRENCIES = ['USD', 'AED', 'USDC', 'USDT', 'AET'];
const PAYMENT_STATUSES = ['Pending', 'Screening', 'Passed', 'Flagged', 'Settled', 'Blocked', 'Refunded'] as const;
const TIERS = ['Enterprise', 'Professional', 'Standard'];
const TEE_REGIONS = ['UAE-DXB-1', 'UAE-AUH-1', 'UAE-DXB-2', 'SG-SGP-1', 'UK-LDN-1', 'US-NYC-1',
                     'UAE-DXB-3', 'UAE-AUH-2', 'EU-FRA-1', 'JP-TKY-1', 'AU-SYD-1', 'CA-TOR-1'];
const FLAG_REASONS = [
  'Sanctions match (partial)', 'High-risk jurisdiction', 'Unusual transaction pattern',
  'PEP association detected', 'Velocity threshold exceeded',
];

function generateMockPayment(seed: number, idx: number): MockPayment {
  const statusRoll = seededRandom(seed + 1);
  let status: string;
  if (statusRoll < 0.15) status = 'Pending';
  else if (statusRoll < 0.25) status = 'Screening';
  else if (statusRoll < 0.55) status = 'Passed';
  else if (statusRoll < 0.65) status = 'Flagged';
  else if (statusRoll < 0.90) status = 'Settled';
  else if (statusRoll < 0.95) status = 'Blocked';
  else status = 'Refunded';

  const currIdx = Math.floor(seededRandom(seed + 2) * CURRENCIES.length);
  const senderIdx = Math.floor(seededRandom(seed + 3) * UAE_BUSINESS_NAMES.length);
  const recipientIdx = Math.floor(seededRandom(seed + 4) * UAE_BUSINESS_NAMES.length);
  const amount = Math.round(500 + seededRandom(seed + 5) * 499500);
  const riskScore = Math.floor(seededRandom(seed + 6) * 100);

  return {
    id: `0x${seededHex(seed + 7, 16)}`,
    sender: seededAddress(seed + 8),
    senderName: UAE_BUSINESS_NAMES[senderIdx],
    recipient: seededAddress(seed + 9),
    recipientName: UAE_BUSINESS_NAMES[recipientIdx],
    amount,
    currency: CURRENCIES[currIdx],
    status,
    riskScore,
    timestamp: Date.now() - idx * 45000 - Math.floor(seededRandom(seed + 10) * 30000) - (idx >= 8 ? 86400000 * (idx - 7) : idx >= 5 ? 3600000 * (idx - 4) : 0),
    settlementTime: status === 'Settled' ? Math.round(60 + seededRandom(seed + 11) * 240) : null,
    teeAttestation: `0x${seededHex(seed + 12, 64)}`,
  };
}

function generateMockBusiness(seed: number): MockBusiness {
  const nameIdx = Math.floor(seededRandom(seed + 1) * UAE_BUSINESS_NAMES.length);
  const jurisdictionIdx = Math.floor(seededRandom(seed + 2) * JURISDICTIONS.length);
  const tierIdx = Math.floor(seededRandom(seed + 3) * TIERS.length);
  return {
    name: UAE_BUSINESS_NAMES[nameIdx],
    jurisdiction: JURISDICTIONS[jurisdictionIdx],
    tier: TIERS[tierIdx],
    volume24h: Math.round(50000 + seededRandom(seed + 4) * 450000),
    paymentCount: Math.floor(5 + seededRandom(seed + 5) * 95),
    complianceScore: Math.round(85 + seededRandom(seed + 6) * 15),
  };
}

function generateMockTEENode(seed: number, idx: number): MockTEENode {
  const isOnline = seededRandom(seed + 1) > 0.08;
  return {
    id: `TEE-${String(idx + 1).padStart(2, '0')}`,
    status: isOnline ? 'online' : 'offline',
    lastHeartbeat: Date.now() - Math.floor(seededRandom(seed + 2) * (isOnline ? 30000 : 600000)),
    attestationValid: isOnline && seededRandom(seed + 3) > 0.05,
    region: TEE_REGIONS[idx % TEE_REGIONS.length],
    version: `v${Math.floor(2 + seededRandom(seed + 4))}.${ Math.floor(seededRandom(seed + 5) * 5)}.${Math.floor(seededRandom(seed + 6) * 10)}`,
    uptime: isOnline ? Math.round(95 + seededRandom(seed + 7) * 5) : 0,
  };
}

function generateMockFlag(seed: number): MockFlag {
  const reasonIdx = Math.floor(seededRandom(seed + 1) * FLAG_REASONS.length);
  return {
    paymentId: `0x${seededHex(seed + 2, 12)}`,
    reason: FLAG_REASONS[reasonIdx],
    riskScore: Math.floor(60 + seededRandom(seed + 3) * 40),
    timestamp: Date.now() - Math.floor(seededRandom(seed + 4) * 3600000),
  };
}


// ---------------------------------------------------------------------------
// Chart data generators
// ---------------------------------------------------------------------------

function generateVolumeChart(): { day: string; total: number; settled: number }[] {
  const data: { day: string; total: number; settled: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const total = Math.round(1_800_000 + seededRandom(i * 13 + 7) * 1_200_000);
    const settled = Math.round(total * (0.75 + seededRandom(i * 17 + 3) * 0.2));
    data.push({ day: `Day ${30 - i}`, total, settled });
  }
  return data;
}

function generateSettlementChart(): { day: string; avg: number; p95: number }[] {
  const data: { day: string; avg: number; p95: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const avg = Math.round((120 + seededRandom(i * 11 + 5) * 100) * 10) / 10;
    const p95 = Math.round((avg * (1.5 + seededRandom(i * 19 + 9) * 0.8)) * 10) / 10;
    data.push({ day: `Day ${30 - i}`, avg: avg / 60, p95: p95 / 60 });
  }
  return data;
}

function generateRiskDistribution(): { name: string; value: number; color: string }[] {
  return [
    { name: 'Low', value: Math.round(60 + seededRandom(100) * 15), color: RISK_COLORS.Low },
    { name: 'Medium', value: Math.round(15 + seededRandom(101) * 10), color: RISK_COLORS.Medium },
    { name: 'High', value: Math.round(3 + seededRandom(102) * 5), color: RISK_COLORS.High },
    { name: 'Critical', value: Math.round(1 + seededRandom(103) * 2), color: RISK_COLORS.Critical },
  ];
}

function generateCompliancePipeline(): { name: string; count: number; color: string }[] {
  return [
    { name: 'Sanctions Screening', count: Math.floor(8 + seededRandom(200) * 15), color: '#3B82F6' },
    { name: 'AML Risk Scoring', count: Math.floor(5 + seededRandom(201) * 10), color: '#8B5CF6' },
    { name: 'Travel Rule Verification', count: Math.floor(3 + seededRandom(202) * 8), color: '#F59E0B' },
  ];
}

function generatePipelineDistribution(): { name: string; pass: number; flag: number; block: number }[] {
  return [
    {
      name: 'Sanctions',
      pass: Math.floor(80 + seededRandom(300) * 15),
      flag: Math.floor(3 + seededRandom(301) * 5),
      block: Math.floor(1 + seededRandom(302) * 2),
    },
    {
      name: 'AML',
      pass: Math.floor(75 + seededRandom(303) * 15),
      flag: Math.floor(5 + seededRandom(304) * 8),
      block: Math.floor(1 + seededRandom(305) * 3),
    },
    {
      name: 'Travel Rule',
      pass: Math.floor(85 + seededRandom(306) * 10),
      flag: Math.floor(2 + seededRandom(307) * 4),
      block: Math.floor(0 + seededRandom(308) * 2),
    },
  ];
}


// ---------------------------------------------------------------------------
// Generate initial datasets
// ---------------------------------------------------------------------------

function generateInitialPayments(count: number): MockPayment[] {
  const payments: MockPayment[] = [];
  for (let i = 0; i < count; i++) {
    payments.push(generateMockPayment(5000 + i * 37, i));
  }
  return payments;
}

function generateInitialBusinesses(): MockBusiness[] {
  const businesses: MockBusiness[] = [];
  for (let i = 0; i < 8; i++) {
    businesses.push(generateMockBusiness(6000 + i * 53));
  }
  return businesses.sort((a, b) => b.volume24h - a.volume24h);
}

function generateInitialTEENodes(): MockTEENode[] {
  const nodes: MockTEENode[] = [];
  for (let i = 0; i < 12; i++) {
    nodes.push(generateMockTEENode(7000 + i * 41, i));
  }
  return nodes;
}

function generateInitialFlags(): MockFlag[] {
  const flags: MockFlag[] = [];
  for (let i = 0; i < 5; i++) {
    flags.push(generateMockFlag(8000 + i * 29));
  }
  return flags;
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

function formatCurrency(n: number, currency: string): string {
  if (currency === 'AED') return `${formatUSD(n).replace('$', '')} AED`;
  if (currency === 'AET') return `${formatNumber(n)} AET`;
  return formatUSD(n);
}

function timeAgo(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 1000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function riskColor(score: number): string {
  if (score < 30) return 'text-emerald-400';
  if (score < 60) return 'text-amber-400';
  if (score < 80) return 'text-orange-400';
  return 'text-red-400';
}

function generateSparklineData(seed: number, count: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < count; i++) {
    data.push(seededRandom(seed + i * 7) * 100);
  }
  return data;
}


// =============================================================================
// REUSABLE LOCAL COMPONENTS
// =============================================================================

function PaymentStatusBadge({ status }: { status: string }) {
  const style = PAYMENT_STATUS_COLORS[status] || 'bg-slate-700/50 text-slate-300 border-slate-600/30';
  const dot = PAYMENT_STATUS_DOT[status] || 'bg-slate-400';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${style}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot} ${status === 'Screening' ? 'animate-pulse' : ''}`} />
      {status}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, change, sparkData, sparkColor }: {
  icon: React.ElementType;
  label: string;
  value: string;
  change?: { value: string; positive: boolean };
  sparkData?: number[];
  sparkColor?: string;
}) {
  return (
    <GlassCard className="p-4" hover={false}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Icon className="w-4 h-4 text-slate-400" />
            <span className="text-xs text-slate-400 truncate">{label}</span>
          </div>
          <p className="text-xl font-bold text-white truncate">{value}</p>
          {change && (
            <div className={`flex items-center gap-1 mt-1 text-xs ${change.positive ? 'text-emerald-400' : 'text-red-400'}`}>
              {change.positive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
              {change.value}
            </div>
          )}
        </div>
        {sparkData && (
          <div className="flex-shrink-0 ml-2">
            <Sparkline data={sparkData} color={sparkColor || BRAND.red} height={28} width={64} />
          </div>
        )}
      </div>
    </GlassCard>
  );
}

function SanctionsListRow({ name, updatedAgo, status }: { name: string; updatedAgo: string; status: 'fresh' | 'stale' | 'warning' }) {
  const dotColors = { fresh: 'bg-emerald-400', stale: 'bg-red-400', warning: 'bg-amber-400' };
  const textColors = { fresh: 'text-emerald-400', stale: 'text-red-400', warning: 'text-amber-400' };
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-800 last:border-0">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${dotColors[status]}`} />
        <span className="text-sm text-slate-200">{name}</span>
      </div>
      <span className={`text-xs ${textColors[status]}`}>{updatedAgo}</span>
    </div>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    Enterprise: 'bg-red-500/20 text-red-400 border-red-500/30',
    Professional: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    Standard: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${colors[tier] || colors.Standard}`}>
      {tier}
    </span>
  );
}


// =============================================================================
// CUSTOM TOOLTIP
// =============================================================================

function CustomTooltip({ active, payload, label, formatValue }: {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number | string }>;
  label?: string;
  formatValue?: (v: number | string) => string;
}) {
  if (!active || !payload?.length) return null;
  const fmt = formatValue || ((v: number | string) => typeof v === 'number' ? formatUSD(v) : String(v));
  return (
    <div className="bg-slate-800 text-white px-3 py-2 rounded-lg text-xs shadow-xl border border-slate-700">
      {label && <p className="font-medium mb-1">{label}</p>}
      {payload.map((entry, i) => (
        <p key={i} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
          {entry.name}: {fmt(entry.value)}
        </p>
      ))}
    </div>
  );
}


// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function DashboardPage() {
  const { realTime } = useApp();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Generate all mock data deterministically
  const payments = useMemo(() => generateInitialPayments(30), []);
  const businesses = useMemo(() => generateInitialBusinesses(), []);
  const teeNodes = useMemo(() => generateInitialTEENodes(), []);
  const flags = useMemo(() => generateInitialFlags(), []);
  const volumeChart = useMemo(() => generateVolumeChart(), []);
  const settlementChart = useMemo(() => generateSettlementChart(), []);
  const riskDistribution = useMemo(() => generateRiskDistribution(), []);
  const compliancePipeline = useMemo(() => generateCompliancePipeline(), []);
  const pipelineDistribution = useMemo(() => generatePipelineDistribution(), []);

  const onlineNodes = teeNodes.filter(n => n.status === 'online').length;

  return (
    <>
      <SEOHead
        title="Dashboard"
        description="NoblePay enterprise cross-border payment operations dashboard with real-time compliance monitoring."
        path="/"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* ============================================================ */}
          {/* HERO STATS BAR                                               */}
          {/* ============================================================ */}

          <div className="mb-8">
            <div className="mb-6">
              <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay Operations</p>
              <h1 className="mt-2 text-3xl font-bold text-white">Payment Dashboard</h1>
              <p className="mt-1 text-sm text-slate-400">Real-time cross-border payment operations and compliance monitoring</p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard
                icon={DollarSign}
                label="Total Volume (24h)"
                value="$2.4M"
                change={{ value: '+12.3%', positive: true }}
                sparkData={generateSparklineData(1000, 12)}
                sparkColor="#3B82F6"
              />
              <StatCard
                icon={CreditCard}
                label="Payments Processed"
                value="847"
                change={{ value: '+8.7%', positive: true }}
                sparkData={generateSparklineData(1100, 12)}
                sparkColor="#10B981"
              />
              <StatCard
                icon={Timer}
                label="Avg Settlement Time"
                value="2.3 min"
                change={{ value: '-0.4 min', positive: true }}
              />
              <StatCard
                icon={ShieldCheck}
                label="Compliance Pass Rate"
                value="97.8%"
                change={{ value: '+0.3%', positive: true }}
              />
              <StatCard
                icon={Building2}
                label="Active Businesses"
                value="142"
                change={{ value: '+6', positive: true }}
              />
              <StatCard
                icon={Cpu}
                label="TEE Nodes Online"
                value={`${onlineNodes}/12`}
                sparkData={generateSparklineData(1200, 12)}
                sparkColor={onlineNodes === 12 ? '#10B981' : '#F59E0B'}
              />
            </div>
          </div>


          {/* ============================================================ */}
          {/* LIVE PAYMENT FEED + COMPLIANCE PIPELINE                      */}
          {/* ============================================================ */}

          <div className="mb-10 grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_0.8fr]">
            {/* Left: Live Payment Feed */}
            <GlassCard className="p-6" hover={false}>
              <SectionHeader
                title="Live Payment Feed"
                subtitle="Latest cross-border transactions"
                size="sm"
                action={
                  <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <Radio className="w-3 h-3 animate-pulse" />
                    Live
                  </div>
                }
              />
              <div className="space-y-0 divide-y divide-slate-800">
                {payments.map((payment) => (
                  <div key={payment.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <code className="text-xs text-slate-500 font-mono">{truncateAddress(payment.id, 8, 4)}</code>
                          <PaymentStatusBadge status={payment.status} />
                        </div>
                        <div className="flex items-center gap-1 text-sm">
                          <span className="text-slate-300 truncate max-w-[140px]" title={payment.senderName}>{payment.senderName}</span>
                          <ChevronRight className="w-3 h-3 text-slate-600 flex-shrink-0" />
                          <span className="text-slate-300 truncate max-w-[140px]" title={payment.recipientName}>{payment.recipientName}</span>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-semibold text-white">{formatCurrency(payment.amount, payment.currency)}</p>
                        <p className="text-xs text-slate-500">{mounted ? timeAgo(payment.timestamp) : '--'}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </GlassCard>

            {/* Right: Compliance Pipeline */}
            <GlassCard className="p-6" hover={false}>
              <SectionHeader
                title="Compliance Pipeline"
                subtitle="Queue status and pass/flag distribution"
                size="sm"
              />

              {/* Queue counts */}
              <div className="space-y-3 mb-6">
                {compliancePipeline.map((item) => (
                  <div key={item.name} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }} />
                      <span className="text-sm text-slate-300">{item.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{item.count}</span>
                      <span className="text-xs text-slate-500">in queue</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pass/Flag/Block distribution bar chart */}
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-3">Pass / Flag / Block Distribution</p>
              {mounted && (
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={pipelineDistribution} layout="vertical" barGap={2}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(51,65,85,0.4)" horizontal={false} />
                    <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fill: '#cbd5e1', fontSize: 11 }} width={70} axisLine={false} tickLine={false} />
                    <RechartsTooltip content={<CustomTooltip formatValue={(v) => String(v)} />} />
                    <Bar dataKey="pass" name="Pass" fill="#10B981" stackId="a" radius={[0, 0, 0, 0]} />
                    <Bar dataKey="flag" name="Flag" fill="#F59E0B" stackId="a" />
                    <Bar dataKey="block" name="Block" fill="#DC2626" stackId="a" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </GlassCard>
          </div>


          {/* ============================================================ */}
          {/* PAYMENT VOLUME CHART                                         */}
          {/* ============================================================ */}

          <div className="mb-10">
            <GlassCard className="p-6" hover={false}>
              <SectionHeader
                title="Payment Volume"
                subtitle="30-day total and settled payment volume"
                size="sm"
              />
              {mounted && (
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={volumeChart}>
                    <defs>
                      <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gradSettled" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(51,65,85,0.4)" />
                    <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} interval={4} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => formatUSD(v)} />
                    <RechartsTooltip content={<CustomTooltip />} />
                    <Legend wrapperStyle={{ paddingTop: '12px', fontSize: '12px' }} />
                    <Area type="monotone" dataKey="total" name="Total Volume" stroke="#3B82F6" fill="url(#gradTotal)" strokeWidth={2} />
                    <Area type="monotone" dataKey="settled" name="Settled Volume" stroke="#10B981" fill="url(#gradSettled)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </GlassCard>
          </div>


          {/* ============================================================ */}
          {/* COMPLIANCE OVERVIEW (3 COLUMNS)                              */}
          {/* ============================================================ */}

          <div className="mb-10 grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Sanctions Lists Status */}
            <GlassCard className="p-6" hover={false}>
              <SectionHeader title="Sanctions Lists" subtitle="Data freshness status" size="sm" />
              <div className="space-y-0">
                <SanctionsListRow name="OFAC SDN" updatedAgo="2h ago" status="fresh" />
                <SanctionsListRow name="UAE Central Bank" updatedAgo="4h ago" status="fresh" />
                <SanctionsListRow name="UN Consolidated" updatedAgo="12h ago" status="warning" />
                <SanctionsListRow name="EU Sanctions" updatedAgo="8h ago" status="fresh" />
                <SanctionsListRow name="UK HMT" updatedAgo="6h ago" status="fresh" />
                <SanctionsListRow name="FATF High-Risk" updatedAgo="24h ago" status="stale" />
              </div>
            </GlassCard>

            {/* Risk Distribution Pie */}
            <GlassCard className="p-6" hover={false}>
              <SectionHeader title="Risk Distribution" subtitle="Payment risk scoring breakdown" size="sm" />
              {mounted && (
                <div className="flex items-center justify-center">
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie
                        data={riskDistribution}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={80}
                        paddingAngle={3}
                        dataKey="value"
                      >
                        {riskDistribution.map((entry, idx) => (
                          <Cell key={idx} fill={entry.color} stroke="transparent" />
                        ))}
                      </Pie>
                      <RechartsTooltip content={<CustomTooltip formatValue={(v) => `${v}%`} />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="flex flex-wrap justify-center gap-4 mt-2">
                {riskDistribution.map((item) => (
                  <div key={item.name} className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="text-xs text-slate-400">{item.name}: {item.value}%</span>
                  </div>
                ))}
              </div>
            </GlassCard>

            {/* Recent Flags */}
            <GlassCard className="p-6" hover={false}>
              <SectionHeader title="Recent Flags" subtitle="Recently flagged payments" size="sm" />
              <div className="space-y-3">
                {flags.map((flag, idx) => (
                  <div key={idx} className="flex items-start justify-between p-3 rounded-xl bg-slate-800/50 border border-slate-700/30">
                    <div className="flex-1 min-w-0">
                      <code className="text-xs font-mono text-slate-500">{truncateAddress(flag.paymentId, 8, 4)}</code>
                      <p className="text-sm text-slate-300 mt-0.5">{flag.reason}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{mounted ? timeAgo(flag.timestamp) : '--'}</p>
                    </div>
                    <div className="flex-shrink-0 ml-3 text-right">
                      <div className={`text-sm font-bold ${riskColor(flag.riskScore)}`}>{flag.riskScore}</div>
                      <div className="text-xs text-slate-500">risk</div>
                    </div>
                  </div>
                ))}
              </div>
            </GlassCard>
          </div>


          {/* ============================================================ */}
          {/* TOP BUSINESSES BY VOLUME                                     */}
          {/* ============================================================ */}

          <div className="mb-10">
            <GlassCard className="p-6" hover={false}>
              <SectionHeader
                title="Top Businesses by Volume"
                subtitle="Highest volume merchants in the last 24 hours"
                size="sm"
              />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700/50">
                      <th className="py-3 px-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">#</th>
                      <th className="py-3 px-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Business</th>
                      <th className="py-3 px-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Jurisdiction</th>
                      <th className="py-3 px-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Tier</th>
                      <th className="py-3 px-3 text-right text-xs font-medium text-slate-400 uppercase tracking-wider">24h Volume</th>
                      <th className="py-3 px-3 text-right text-xs font-medium text-slate-400 uppercase tracking-wider">Payments</th>
                      <th className="py-3 px-3 text-right text-xs font-medium text-slate-400 uppercase tracking-wider">Compliance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/50">
                    {businesses.map((biz, idx) => (
                      <tr key={idx} className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-3 px-3 text-slate-500 tabular-nums">{idx + 1}</td>
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2">
                            <Building2 className="w-4 h-4 text-slate-500" />
                            <span className="text-slate-200 font-medium">{biz.name}</span>
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <span className="text-xs text-slate-400 bg-slate-800 px-2 py-0.5 rounded">{biz.jurisdiction}</span>
                        </td>
                        <td className="py-3 px-3"><TierBadge tier={biz.tier} /></td>
                        <td className="py-3 px-3 text-right font-semibold text-white tabular-nums">{formatUSD(biz.volume24h)}</td>
                        <td className="py-3 px-3 text-right text-slate-300 tabular-nums">{biz.paymentCount}</td>
                        <td className="py-3 px-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-1.5 bg-slate-700/50 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${biz.complianceScore >= 95 ? 'bg-emerald-500' : biz.complianceScore >= 90 ? 'bg-amber-500' : 'bg-red-500'}`}
                                style={{ width: `${biz.complianceScore}%` }}
                              />
                            </div>
                            <span className={`text-xs font-medium tabular-nums ${biz.complianceScore >= 95 ? 'text-emerald-400' : biz.complianceScore >= 90 ? 'text-amber-400' : 'text-red-400'}`}>
                              {biz.complianceScore}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </GlassCard>
          </div>


          {/* ============================================================ */}
          {/* SETTLEMENT PERFORMANCE                                       */}
          {/* ============================================================ */}

          <div className="mb-10">
            <GlassCard className="p-6" hover={false}>
              <SectionHeader
                title="Settlement Performance"
                subtitle="Average and 95th percentile settlement times (minutes)"
                size="sm"
              />
              {mounted && (
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={settlementChart}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(51,65,85,0.4)" />
                    <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} interval={4} />
                    <YAxis
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={(v: number) => `${v.toFixed(1)}m`}
                      domain={[0, 'auto']}
                    />
                    <RechartsTooltip content={<CustomTooltip formatValue={(v) => `${Number(v).toFixed(1)} min`} />} />
                    <Legend wrapperStyle={{ paddingTop: '12px', fontSize: '12px' }} />
                    <ReferenceLine y={5} stroke="#DC2626" strokeDasharray="8 4" label={{ value: 'Target (5m)', fill: '#DC2626', fontSize: 11, position: 'right' }} />
                    <Line type="monotone" dataKey="avg" name="Average" stroke="#3B82F6" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="p95" name="95th Percentile" stroke="#F59E0B" strokeWidth={2} dot={false} strokeDasharray="4 2" />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </GlassCard>
          </div>


          {/* ============================================================ */}
          {/* NETWORK & TEE HEALTH (2 COLUMNS)                             */}
          {/* ============================================================ */}

          <div className="mb-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* TEE Node Grid */}
            <GlassCard className="p-6" hover={false}>
              <SectionHeader title="TEE Node Grid" subtitle="Trusted Execution Environment status" size="sm" />
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {teeNodes.map((node) => (
                  <div
                    key={node.id}
                    className={`p-3 rounded-xl border ${
                      node.status === 'online'
                        ? 'bg-slate-800/40 border-slate-700/30'
                        : 'bg-red-950/20 border-red-800/30'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-mono font-medium text-slate-300">{node.id}</span>
                      <span className={`w-2 h-2 rounded-full ${node.status === 'online' ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`} />
                    </div>
                    <p className="text-xs text-slate-500">{node.region}</p>
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-xs text-slate-500">{node.version}</span>
                      {node.attestationValid ? (
                        <CheckCircle className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <AlertCircle className="w-3 h-3 text-red-400" />
                      )}
                    </div>
                    {node.status === 'online' && (
                      <div className="mt-1.5">
                        <div className="w-full h-1 bg-slate-700/50 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${node.uptime}%` }} />
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">{node.uptime}% uptime</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </GlassCard>

            {/* Network Stats */}
            <GlassCard className="p-6" hover={false}>
              <SectionHeader title="Network Status" subtitle="Aethelred blockchain metrics" size="sm" />
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
                    <div className="flex items-center gap-2 mb-1">
                      <Activity className="w-4 h-4 text-blue-400" />
                      <span className="text-xs text-slate-400">Block Height</span>
                    </div>
                    <p className="text-lg font-bold text-white tabular-nums">{formatNumber(realTime.blockHeight)}</p>
                  </div>
                  <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
                    <div className="flex items-center gap-2 mb-1">
                      <Zap className="w-4 h-4 text-amber-400" />
                      <span className="text-xs text-slate-400">TPS</span>
                    </div>
                    <p className="text-lg font-bold text-white tabular-nums">{formatNumber(realTime.tps)}</p>
                  </div>
                  <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
                    <div className="flex items-center gap-2 mb-1">
                      <Server className="w-4 h-4 text-purple-400" />
                      <span className="text-xs text-slate-400">Gas Price</span>
                    </div>
                    <p className="text-lg font-bold text-white tabular-nums">{realTime.gasPrice} gwei</p>
                  </div>
                  <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
                    <div className="flex items-center gap-2 mb-1">
                      <Globe className="w-4 h-4 text-cyan-400" />
                      <span className="text-xs text-slate-400">Network Load</span>
                    </div>
                    <p className="text-lg font-bold text-white tabular-nums">{realTime.networkLoad}%</p>
                  </div>
                </div>
                <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="w-4 h-4 text-red-400" />
                    <span className="text-xs text-slate-400">Epoch</span>
                  </div>
                  <p className="text-lg font-bold text-white tabular-nums">{realTime.epoch}</p>
                  <p className="text-xs text-slate-500 mt-1">AETHEL Price: ${realTime.aethelPrice.toFixed(2)}</p>
                </div>
                <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
                  <div className="flex items-center gap-2 mb-2">
                    <Heart className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs text-slate-400">System Health</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                      <span className="text-sm text-emerald-400">All systems operational</span>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div className="text-center">
                      <p className="text-xs text-slate-500">Payment API</p>
                      <p className="text-xs text-emerald-400 font-medium">99.99%</p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-slate-500">Compliance</p>
                      <p className="text-xs text-emerald-400 font-medium">99.97%</p>
                    </div>
                    <div className="text-center">
                      <p className="text-xs text-slate-500">Settlement</p>
                      <p className="text-xs text-emerald-400 font-medium">99.95%</p>
                    </div>
                  </div>
                </div>
              </div>
            </GlassCard>
          </div>


          {/* ============================================================ */}
          {/* QUICK ACTIONS                                                */}
          {/* ============================================================ */}

          <div className="mb-10">
            <SectionHeader title="Quick Actions" size="sm" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <GlassCard className="p-5 group" hover>
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20 group-hover:bg-red-500/20 transition-colors">
                    <Send className="w-5 h-5 text-red-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">Initiate Payment</h3>
                    <p className="text-xs text-slate-500">Create a new cross-border payment</p>
                  </div>
                </div>
                <button className="w-full py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors">
                  New Payment
                </button>
              </GlassCard>

              <GlassCard className="p-5 group" hover>
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20 group-hover:bg-blue-500/20 transition-colors">
                    <Building2 className="w-5 h-5 text-blue-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">Register Business</h3>
                    <p className="text-xs text-slate-500">Onboard a new merchant entity</p>
                  </div>
                </div>
                <button className="w-full py-2 rounded-lg border border-slate-600 text-slate-300 text-sm font-medium hover:border-slate-500 hover:text-white transition-colors">
                  Register
                </button>
              </GlassCard>

              <GlassCard className="p-5 group" hover>
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 group-hover:bg-emerald-500/20 transition-colors">
                    <FileText className="w-5 h-5 text-emerald-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">Compliance Reports</h3>
                    <p className="text-xs text-slate-500">View screening and audit reports</p>
                  </div>
                </div>
                <button className="w-full py-2 rounded-lg border border-slate-600 text-slate-300 text-sm font-medium hover:border-slate-500 hover:text-white transition-colors">
                  View Reports
                </button>
              </GlassCard>

              <GlassCard className="p-5 group" hover>
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2.5 rounded-xl bg-purple-500/10 border border-purple-500/20 group-hover:bg-purple-500/20 transition-colors">
                    <Download className="w-5 h-5 text-purple-400" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">Export Audit Logs</h3>
                    <p className="text-xs text-slate-500">Download full audit trail</p>
                  </div>
                </div>
                <button className="w-full py-2 rounded-lg border border-slate-600 text-slate-300 text-sm font-medium hover:border-slate-500 hover:text-white transition-colors">
                  Export
                </button>
              </GlassCard>
            </div>
          </div>

        </main>

        <Footer />
      </div>
    </>
  );
}
