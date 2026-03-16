/**
 * NoblePay Analytics & Reporting — Enterprise analytics dashboard
 *
 * Cross-border payment insights with volume trends, geographic corridors,
 * settlement performance, compliance analytics, and fee revenue breakdowns.
 *
 * All data is deterministic via seededRandom for SSR hydration safety.
 */

import { useState, useMemo } from 'react';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  Legend, ComposedChart,
} from 'recharts';
import {
  TrendingUp, TrendingDown, DollarSign, Users, Clock, ShieldCheck,
  Receipt, ArrowUpRight, Globe, BarChart3, Activity, Zap,
} from 'lucide-react';
import { SEOHead } from '@/components/SEOHead';
import { TopNav, Footer } from '@/components/SharedComponents';
import { GlassCard, SectionHeader, Sparkline, ChartTooltip } from '@/components/PagePrimitives';
import { useApp } from '@/contexts/AppContext';
import { seededRandom, seededHex, seededAddress, formatNumber, truncateAddress } from '@/lib/utils';
import { BRAND, CHART_COLORS } from '@/lib/constants';


// =============================================================================
// TYPES
// =============================================================================

interface KPICard {
  label: string;
  value: string;
  change: number;
  icon: React.ReactNode;
  sparkData: number[];
}

interface VolumeTrendPoint {
  day: string;
  total: number;
  settled: number;
  usdc: number;
  usdt: number;
  aet: number;
}

interface CorridorRow {
  corridor: string;
  from: string;
  to: string;
  volume: number;
  count: number;
  avgSettlement: string;
  complianceRate: number;
}

interface BusinessRow {
  rank: number;
  name: string;
  volume: number;
  count: number;
  avgSize: number;
  complianceScore: number;
  sparkData: number[];
}

type Period = '24h' | '7d' | '30d' | '90d' | 'ytd' | 'all';


// =============================================================================
// DATA GENERATORS
// =============================================================================

const PERIOD_LABELS: Record<Period, string> = {
  '24h': '24 Hours',
  '7d': '7 Days',
  '30d': '30 Days',
  '90d': '90 Days',
  'ytd': 'Year to Date',
  'all': 'All Time',
};

const CORRIDOR_DATA: Array<{ from: string; to: string; corridor: string }> = [
  { from: 'UAE', to: 'India', corridor: 'UAE \u2192 India' },
  { from: 'UAE', to: 'UK', corridor: 'UAE \u2192 UK' },
  { from: 'UAE', to: 'Pakistan', corridor: 'UAE \u2192 Pakistan' },
  { from: 'UAE', to: 'Philippines', corridor: 'UAE \u2192 Philippines' },
  { from: 'UAE', to: 'Bangladesh', corridor: 'UAE \u2192 Bangladesh' },
  { from: 'UAE', to: 'Egypt', corridor: 'UAE \u2192 Egypt' },
  { from: 'UAE', to: 'USA', corridor: 'UAE \u2192 USA' },
  { from: 'Saudi Arabia', to: 'India', corridor: 'Saudi Arabia \u2192 India' },
  { from: 'Qatar', to: 'Nepal', corridor: 'Qatar \u2192 Nepal' },
  { from: 'UAE', to: 'Sri Lanka', corridor: 'UAE \u2192 Sri Lanka' },
];

const BUSINESS_NAMES = [
  'Al Ansari Exchange', 'UAE Exchange', 'Travelex Dubai', 'Wall Street Exchange',
  'Al Fardan Exchange', 'BFC Exchange', 'Sharaf Exchange', 'Al Ghurair Exchange',
  'Orient Exchange', 'City Exchange', 'Lulu Exchange', 'Al Rostamani Exchange',
  'Thomas Exchange', 'Al Ahalia Exchange', 'GCC Exchange',
];

function generateVolumeTrend(baseSeed: number): VolumeTrendPoint[] {
  const data: VolumeTrendPoint[] = [];
  for (let i = 0; i < 30; i++) {
    const s = baseSeed + i * 7;
    const total = 300000 + seededRandom(s) * 500000;
    const usdc = total * (0.40 + seededRandom(s + 1) * 0.10);
    const usdt = total * (0.25 + seededRandom(s + 2) * 0.10);
    const aet = total * (0.15 + seededRandom(s + 3) * 0.10);
    data.push({
      day: `Mar ${i + 1}`,
      total: Math.round(total),
      settled: Math.round(total * (0.82 + seededRandom(s + 4) * 0.12)),
      usdc: Math.round(usdc),
      usdt: Math.round(usdt),
      aet: Math.round(aet),
    });
  }
  return data;
}

function generateCorridors(baseSeed: number): CorridorRow[] {
  return CORRIDOR_DATA.map((c, i) => {
    const s = baseSeed + i * 11;
    const volume = 800000 + seededRandom(s) * 3200000;
    return {
      ...c,
      volume: Math.round(volume),
      count: Math.round(100 + seededRandom(s + 1) * 900),
      avgSettlement: `${(1.5 + seededRandom(s + 2) * 3.5).toFixed(1)} min`,
      complianceRate: 94 + seededRandom(s + 3) * 5.5,
    };
  }).sort((a, b) => b.volume - a.volume);
}

function generateSettlementPerf(baseSeed: number) {
  const data = [];
  for (let i = 0; i < 30; i++) {
    const s = baseSeed + i * 5;
    const avg = 1.8 + seededRandom(s) * 1.5;
    data.push({
      day: `Mar ${i + 1}`,
      avg: +avg.toFixed(2),
      p95: +(avg + 1.5 + seededRandom(s + 1) * 2).toFixed(2),
      min: +(avg - 0.8 - seededRandom(s + 2) * 0.5).toFixed(2),
      max: +(avg + 3 + seededRandom(s + 3) * 3).toFixed(2),
      target: 5,
    });
  }
  return data;
}

function generateComplianceScreening(baseSeed: number) {
  const data = [];
  for (let i = 0; i < 30; i++) {
    const s = baseSeed + i * 9;
    const total = 100 + Math.round(seededRandom(s) * 80);
    data.push({
      day: `Mar ${i + 1}`,
      passed: Math.round(total * (0.93 + seededRandom(s + 1) * 0.05)),
      flagged: Math.round(total * (0.02 + seededRandom(s + 2) * 0.04)),
      blocked: Math.round(total * (0.005 + seededRandom(s + 3) * 0.015)),
    });
  }
  return data;
}

function generateScreeningLatency(baseSeed: number) {
  const data = [];
  for (let i = 0; i < 30; i++) {
    const s = baseSeed + i * 3;
    data.push({
      day: `Mar ${i + 1}`,
      latency: Math.round(45 + seededRandom(s) * 80),
      target: 100,
    });
  }
  return data;
}

function generateBusinesses(baseSeed: number): BusinessRow[] {
  return BUSINESS_NAMES.map((name, i) => {
    const s = baseSeed + i * 13;
    const volume = 200000 + seededRandom(s) * 2800000;
    const count = Math.round(50 + seededRandom(s + 1) * 500);
    const sparkData: number[] = [];
    for (let j = 0; j < 10; j++) {
      sparkData.push(10000 + seededRandom(s + j + 10) * 300000);
    }
    return {
      rank: i + 1,
      name,
      volume: Math.round(volume),
      count,
      avgSize: Math.round(volume / count),
      complianceScore: +(92 + seededRandom(s + 2) * 7.5).toFixed(1),
      sparkData,
    };
  }).sort((a, b) => b.volume - a.volume).map((b, i) => ({ ...b, rank: i + 1 }));
}

function generateFeeRevenue(baseSeed: number) {
  const data = [];
  let cumulative = 0;
  for (let i = 0; i < 30; i++) {
    const s = baseSeed + i * 6;
    const baseFee = 200 + seededRandom(s) * 300;
    const percentFee = 300 + seededRandom(s + 1) * 400;
    cumulative += baseFee + percentFee;
    data.push({
      day: `Mar ${i + 1}`,
      baseFees: Math.round(baseFee),
      percentFees: Math.round(percentFee),
      cumulative: Math.round(cumulative),
    });
  }
  return data;
}


// =============================================================================
// DONUT CHART DATA
// =============================================================================

const CURRENCY_DISTRIBUTION = [
  { name: 'USDC', value: 45, color: '#3B82F6' },
  { name: 'USDT', value: 30, color: '#10B981' },
  { name: 'AET', value: 20, color: '#DC2626' },
  { name: 'AED', value: 5, color: '#F59E0B' },
];

const STATUS_DISTRIBUTION = [
  { name: 'Settled', value: 85, color: '#10B981' },
  { name: 'Pending', value: 8, color: '#F59E0B' },
  { name: 'Flagged', value: 5, color: '#EAB308' },
  { name: 'Blocked', value: 2, color: '#EF4444' },
];

const TIER_DISTRIBUTION = [
  { name: 'Enterprise', value: 60, color: '#DC2626' },
  { name: 'Premium', value: 30, color: '#F87171' },
  { name: 'Standard', value: 10, color: '#FCA5A5' },
];


// =============================================================================
// COMPONENT
// =============================================================================

export default function AnalyticsPage() {
  const [period, setPeriod] = useState<Period>('30d');

  const volumeTrend = useMemo(() => generateVolumeTrend(42000), []);
  const corridors = useMemo(() => generateCorridors(43000), []);
  const settlementPerf = useMemo(() => generateSettlementPerf(44000), []);
  const complianceScreening = useMemo(() => generateComplianceScreening(45000), []);
  const screeningLatency = useMemo(() => generateScreeningLatency(46000), []);
  const businesses = useMemo(() => generateBusinesses(47000), []);
  const feeRevenue = useMemo(() => generateFeeRevenue(48000), []);

  const maxVolume = Math.max(...corridors.map((c) => c.volume));

  const kpis: KPICard[] = useMemo(() => {
    const mkSparkline = (seed: number) => {
      const d: number[] = [];
      for (let i = 0; i < 12; i++) d.push(seededRandom(seed + i) * 100);
      return d;
    };
    return [
      { label: 'Total Volume', value: '$12.4M', change: 14.2, icon: <DollarSign className="h-5 w-5" />, sparkData: mkSparkline(5001) },
      { label: 'Total Payments', value: '3,847', change: 8.7, icon: <Receipt className="h-5 w-5" />, sparkData: mkSparkline(5002) },
      { label: 'Unique Senders', value: '89', change: 3.1, icon: <Users className="h-5 w-5" />, sparkData: mkSparkline(5003) },
      { label: 'Unique Recipients', value: '234', change: 12.5, icon: <Globe className="h-5 w-5" />, sparkData: mkSparkline(5004) },
      { label: 'Avg Payment Size', value: '$3,225', change: -2.3, icon: <BarChart3 className="h-5 w-5" />, sparkData: mkSparkline(5005) },
      { label: 'Median Settlement', value: '2.1 min', change: -8.4, icon: <Clock className="h-5 w-5" />, sparkData: mkSparkline(5006) },
      { label: 'Compliance Rate', value: '97.8%', change: 0.4, icon: <ShieldCheck className="h-5 w-5" />, sparkData: mkSparkline(5007) },
      { label: 'Revenue (Fees)', value: '$18,420', change: 11.6, icon: <Zap className="h-5 w-5" />, sparkData: mkSparkline(5008) },
    ];
  }, []);

  return (
    <>
      <SEOHead
        title="Analytics"
        description="Enterprise analytics dashboard for NoblePay cross-border payment insights."
        path="/analytics"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="analytics" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* ================================================================
              SECTION 1 — Period Selector
              ================================================================ */}
          <div className="mb-8">
            <SectionHeader
              title="Analytics & Reporting"
              subtitle="Enterprise cross-border payment insights and compliance metrics"
            />
            <div className="flex flex-wrap gap-1 rounded-xl bg-slate-800/50 p-1 w-fit">
              {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    period === p
                      ? 'bg-red-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {p.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* ================================================================
              SECTION 2 — KPI Cards (2 rows of 4)
              ================================================================ */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-10">
            {kpis.map((kpi) => (
              <GlassCard key={kpi.label} className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="rounded-lg bg-slate-800/80 p-2 text-red-400">
                    {kpi.icon}
                  </div>
                  <Sparkline data={kpi.sparkData} color={kpi.change >= 0 ? '#10B981' : '#EF4444'} width={64} height={24} />
                </div>
                <p className="text-sm text-slate-400 mb-1">{kpi.label}</p>
                <div className="flex items-end justify-between">
                  <p className="text-2xl font-bold text-white">{kpi.value}</p>
                  <span className={`inline-flex items-center gap-1 text-xs font-medium ${
                    kpi.change >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}>
                    {kpi.change >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                    {Math.abs(kpi.change)}%
                  </span>
                </div>
              </GlassCard>
            ))}
          </div>

          {/* ================================================================
              SECTION 3 — Volume Trends (AreaChart)
              ================================================================ */}
          <SectionHeader title="Volume Trends" subtitle="30-day payment volume with currency breakdown" size="sm" />
          <GlassCard className="p-6 mb-10" hover={false}>
            <ResponsiveContainer width="100%" height={360}>
              <AreaChart data={volumeTrend}>
                <defs>
                  <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#DC2626" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#DC2626" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradSettled" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="day" stroke="#64748b" fontSize={11} tickLine={false} />
                <YAxis stroke="#64748b" fontSize={11} tickLine={false} tickFormatter={(v) => `$${formatNumber(v)}`} />
                <RechartsTooltip content={<ChartTooltip formatValue={(v) => `$${formatNumber(Number(v))}`} />} />
                <Legend />
                <Area type="monotone" dataKey="total" name="Total" stroke="#DC2626" fill="url(#gradTotal)" strokeWidth={2} />
                <Area type="monotone" dataKey="settled" name="Settled" stroke="#10B981" fill="url(#gradSettled)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </GlassCard>

          {/* ================================================================
              SECTION 4 — Payment Distribution (3 donut charts)
              ================================================================ */}
          <SectionHeader title="Payment Distribution" subtitle="Breakdown by currency, status, and business tier" size="sm" />
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3 mb-10">
            {[
              { title: 'By Currency', data: CURRENCY_DISTRIBUTION },
              { title: 'By Status', data: STATUS_DISTRIBUTION },
              { title: 'By Business Tier', data: TIER_DISTRIBUTION },
            ].map((chart) => (
              <GlassCard key={chart.title} className="p-6" hover={false}>
                <h3 className="text-sm font-semibold text-white mb-4">{chart.title}</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={chart.data}
                      cx="50%"
                      cy="50%"
                      innerRadius={55}
                      outerRadius={80}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {chart.data.map((entry, idx) => (
                        <Cell key={idx} fill={entry.color} stroke="transparent" />
                      ))}
                    </Pie>
                    <RechartsTooltip content={<ChartTooltip formatValue={(v) => `${v}%`} />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap justify-center gap-3 mt-2">
                  {chart.data.map((entry) => (
                    <span key={entry.name} className="inline-flex items-center gap-1.5 text-xs text-slate-300">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                      {entry.name} ({entry.value}%)
                    </span>
                  ))}
                </div>
              </GlassCard>
            ))}
          </div>

          {/* ================================================================
              SECTION 5 — Geographic Flow Map (Table)
              ================================================================ */}
          <SectionHeader title="Geographic Flow Map" subtitle="Top 10 payment corridors by volume" size="sm" />
          <GlassCard className="p-6 mb-10 overflow-x-auto" hover={false}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700/50 text-left text-xs uppercase tracking-wider text-slate-400">
                  <th className="py-3 pr-4">Corridor</th>
                  <th className="py-3 pr-4">Volume</th>
                  <th className="py-3 pr-4 hidden sm:table-cell">Count</th>
                  <th className="py-3 pr-4 hidden md:table-cell">Avg Settlement</th>
                  <th className="py-3 pr-4 hidden lg:table-cell">Compliance</th>
                  <th className="py-3 w-40 hidden xl:table-cell">Relative Volume</th>
                </tr>
              </thead>
              <tbody>
                {corridors.map((c, idx) => (
                  <tr key={idx} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 pr-4 font-medium text-white">
                      <div className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-red-400 shrink-0" />
                        {c.corridor}
                      </div>
                    </td>
                    <td className="py-3 pr-4 font-mono text-slate-200">${formatNumber(c.volume)}</td>
                    <td className="py-3 pr-4 text-slate-300 hidden sm:table-cell">{c.count.toLocaleString()}</td>
                    <td className="py-3 pr-4 text-slate-300 hidden md:table-cell">{c.avgSettlement}</td>
                    <td className="py-3 pr-4 hidden lg:table-cell">
                      <span className={`text-xs font-medium ${c.complianceRate >= 97 ? 'text-emerald-400' : 'text-amber-400'}`}>
                        {c.complianceRate.toFixed(1)}%
                      </span>
                    </td>
                    <td className="py-3 hidden xl:table-cell">
                      <div className="w-full bg-slate-800 rounded-full h-2">
                        <div
                          className="bg-red-500 h-2 rounded-full transition-all"
                          style={{ width: `${(c.volume / maxVolume) * 100}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassCard>

          {/* ================================================================
              SECTION 6 — Settlement Performance (LineChart)
              ================================================================ */}
          <SectionHeader title="Settlement Performance" subtitle="Average and 95th percentile settlement times vs SLA target" size="sm" />
          <GlassCard className="p-6 mb-10" hover={false}>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={settlementPerf}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="day" stroke="#64748b" fontSize={11} tickLine={false} />
                <YAxis stroke="#64748b" fontSize={11} tickLine={false} unit=" min" />
                <RechartsTooltip content={<ChartTooltip formatValue={(v) => `${v} min`} />} />
                <Legend />
                <Line type="monotone" dataKey="avg" name="Average" stroke="#DC2626" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="p95" name="95th Percentile" stroke="#F87171" strokeWidth={2} strokeDasharray="5 5" dot={false} />
                <Line type="monotone" dataKey="target" name="SLA Target" stroke="#10B981" strokeWidth={1.5} strokeDasharray="8 4" dot={false} />
                <Line type="monotone" dataKey="min" name="Min" stroke="#3B82F6" strokeWidth={1} strokeDasharray="3 3" dot={false} />
                <Line type="monotone" dataKey="max" name="Max" stroke="#8B5CF6" strokeWidth={1} strokeDasharray="3 3" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </GlassCard>

          {/* ================================================================
              SECTION 7 — Compliance Analytics (2 columns)
              ================================================================ */}
          <SectionHeader title="Compliance Analytics" subtitle="Screening results and latency monitoring" size="sm" />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 mb-10">
            {/* Left: Screening Results BarChart */}
            <GlassCard className="p-6" hover={false}>
              <h3 className="text-sm font-semibold text-white mb-4">Daily Screening Results</h3>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={complianceScreening}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="day" stroke="#64748b" fontSize={10} tickLine={false} interval={4} />
                  <YAxis stroke="#64748b" fontSize={11} tickLine={false} />
                  <RechartsTooltip content={<ChartTooltip />} />
                  <Legend />
                  <Bar dataKey="passed" name="Passed" fill="#10B981" stackId="a" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="flagged" name="Flagged" fill="#EAB308" stackId="a" />
                  <Bar dataKey="blocked" name="Blocked" fill="#EF4444" stackId="a" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </GlassCard>

            {/* Right: Screening Latency LineChart */}
            <GlassCard className="p-6" hover={false}>
              <h3 className="text-sm font-semibold text-white mb-4">Average Screening Latency (ms)</h3>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={screeningLatency}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="day" stroke="#64748b" fontSize={10} tickLine={false} interval={4} />
                  <YAxis stroke="#64748b" fontSize={11} tickLine={false} unit="ms" />
                  <RechartsTooltip content={<ChartTooltip formatValue={(v) => `${v}ms`} />} />
                  <Legend />
                  <Line type="monotone" dataKey="latency" name="Avg Latency" stroke="#DC2626" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="target" name="Target (100ms)" stroke="#10B981" strokeWidth={1.5} strokeDasharray="8 4" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </GlassCard>
          </div>

          {/* ================================================================
              SECTION 8 — Top Businesses Leaderboard
              ================================================================ */}
          <SectionHeader title="Top Businesses Leaderboard" subtitle="Ranked by total payment volume" size="sm" />
          <GlassCard className="p-6 mb-10 overflow-x-auto" hover={false}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700/50 text-left text-xs uppercase tracking-wider text-slate-400">
                  <th className="py-3 pr-3 w-12">#</th>
                  <th className="py-3 pr-4">Business Name</th>
                  <th className="py-3 pr-4">Volume</th>
                  <th className="py-3 pr-4 hidden sm:table-cell">Payments</th>
                  <th className="py-3 pr-4 hidden md:table-cell">Avg Size</th>
                  <th className="py-3 pr-4 hidden lg:table-cell">Compliance</th>
                  <th className="py-3 w-24 hidden xl:table-cell">Trend</th>
                </tr>
              </thead>
              <tbody>
                {businesses.map((b) => (
                  <tr key={b.rank} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 pr-3">
                      <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${
                        b.rank <= 3 ? 'bg-red-600/20 text-red-400' : 'bg-slate-800 text-slate-400'
                      }`}>
                        {b.rank}
                      </span>
                    </td>
                    <td className="py-3 pr-4 font-medium text-white">{b.name}</td>
                    <td className="py-3 pr-4 font-mono text-slate-200">${formatNumber(b.volume)}</td>
                    <td className="py-3 pr-4 text-slate-300 hidden sm:table-cell">{b.count.toLocaleString()}</td>
                    <td className="py-3 pr-4 text-slate-300 hidden md:table-cell">${formatNumber(b.avgSize)}</td>
                    <td className="py-3 pr-4 hidden lg:table-cell">
                      <span className={`text-xs font-medium ${b.complianceScore >= 97 ? 'text-emerald-400' : b.complianceScore >= 95 ? 'text-amber-400' : 'text-red-400'}`}>
                        {b.complianceScore}%
                      </span>
                    </td>
                    <td className="py-3 hidden xl:table-cell">
                      <Sparkline data={b.sparkData} color={BRAND.red} width={80} height={24} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassCard>

          {/* ================================================================
              SECTION 9 — Fee Revenue Breakdown
              ================================================================ */}
          <SectionHeader title="Fee Revenue Breakdown" subtitle="Daily fee revenue split by type with cumulative total" size="sm" />
          <GlassCard className="p-6 mb-10" hover={false}>
            <ResponsiveContainer width="100%" height={360}>
              <ComposedChart data={feeRevenue}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis dataKey="day" stroke="#64748b" fontSize={11} tickLine={false} />
                <YAxis yAxisId="left" stroke="#64748b" fontSize={11} tickLine={false} tickFormatter={(v) => `$${formatNumber(v)}`} />
                <YAxis yAxisId="right" orientation="right" stroke="#64748b" fontSize={11} tickLine={false} tickFormatter={(v) => `$${formatNumber(v)}`} />
                <RechartsTooltip content={<ChartTooltip formatValue={(v) => `$${formatNumber(Number(v))}`} />} />
                <Legend />
                <Bar yAxisId="left" dataKey="baseFees" name="Base Fees" fill="#DC2626" stackId="fees" radius={[0, 0, 0, 0]} />
                <Bar yAxisId="left" dataKey="percentFees" name="Percentage Fees" fill="#F87171" stackId="fees" radius={[4, 4, 0, 0]} />
                <Line yAxisId="right" type="monotone" dataKey="cumulative" name="Cumulative" stroke="#10B981" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </GlassCard>

        </main>

        <Footer />
      </div>
    </>
  );
}
