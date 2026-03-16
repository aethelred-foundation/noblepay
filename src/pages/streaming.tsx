/**
 * NoblePay Streaming — Payment Streaming Console
 *
 * Real-time payment streaming management with animated progress,
 * batch payroll creation, stream lifecycle controls, calendar views,
 * auto-compound settings, and cumulative payment analytics.
 *
 * All mock data uses seededRandom for deterministic SSR hydration.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { SEOHead } from '@/components/SEOHead';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  Legend, ReferenceLine,
} from 'recharts';
import {
  Play, Pause, Square, FastForward, RotateCcw,
  Plus, Upload, Download, Clock, CheckCircle,
  ArrowUpRight, ArrowDownRight, ArrowRight,
  Send, Users, Calendar, Timer, DollarSign,
  Activity, TrendingUp, Zap, Settings, Eye,
  ChevronRight, AlertCircle, FileText, RefreshCw,
  X, Filter, Search, Wallet, Layers,
  ArrowRightLeft, Banknote, ChevronDown, Hash,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { TopNav, Footer, Badge, Modal, Tabs, Drawer } from '@/components/SharedComponents';
import { seededRandom, seededHex, seededAddress, formatNumber, truncateAddress } from '@/lib/utils';
import { BRAND } from '@/lib/constants';
import { GlassCard, SectionHeader, Sparkline } from '@/components/PagePrimitives';


// =============================================================================
// CHART & LOCAL CONSTANTS
// =============================================================================

const CHART_COLORS = [
  '#DC2626', '#0EA5E9', '#10B981', '#F59E0B', '#8B5CF6',
  '#EC4899', '#06B6D4', '#F87171', '#34D399', '#FBBF24',
];

const STREAM_STATUS_STYLES: Record<string, string> = {
  Active: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  Paused: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  Completed: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  Cancelled: 'bg-red-500/20 text-red-400 border-red-500/30',
  Scheduled: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
};

const STREAM_STATUS_DOT: Record<string, string> = {
  Active: 'bg-emerald-400',
  Paused: 'bg-amber-400',
  Completed: 'bg-blue-400',
  Cancelled: 'bg-red-400',
  Scheduled: 'bg-purple-400',
};


// =============================================================================
// TYPES
// =============================================================================

type StreamStatus = 'Active' | 'Paused' | 'Completed' | 'Cancelled' | 'Scheduled';
type StreamDirection = 'outgoing' | 'incoming';

interface PaymentStream {
  id: string;
  sender: string;
  senderName: string;
  recipient: string;
  recipientName: string;
  totalAmount: number;
  streamedAmount: number;
  remainingAmount: number;
  ratePerSecond: number;
  currency: string;
  status: StreamStatus;
  direction: StreamDirection;
  startDate: number;
  endDate: number;
  cliffDate: number | null;
  cliffAmount: number;
  autoCompound: boolean;
  compoundProtocol: string | null;
  category: string;
  lastWithdrawal: number;
  createdAt: number;
}

interface StreamMilestone {
  date: number;
  description: string;
  amount: number;
  stream: string;
  streamName: string;
  completed: boolean;
}

interface StreamHistoryItem {
  id: string;
  stream: string;
  action: string;
  amount: number;
  currency: string;
  timestamp: number;
  txHash: string;
}

interface BatchPayrollEntry {
  recipient: string;
  recipientName: string;
  amount: number;
  duration: number;
  currency: string;
}


// =============================================================================
// MOCK DATA GENERATORS
// =============================================================================

const COMPANY_NAMES = [
  'Meridian Capital LLC', 'Falcon Fintech Solutions', 'Desert Rose Trading Co.',
  'Gulf Stream Finance Ltd', 'Phoenix Partners AG', 'Oasis Digital Assets',
  'Atlas Venture Holdings', 'Zenith Corporation', 'Crescent Bay Ventures',
  'Sovereign Wealth Partners', 'Noble Bridge Capital', 'Apex Advisory Group',
];

const PERSON_NAMES = [
  'Sarah Chen', 'Marcus Williams', 'Aisha Al-Rashid', 'James O\'Connor',
  'Yuki Tanaka', 'Elena Petrov', 'David Kim', 'Fatima Hassan',
  'Robert Taylor', 'Priya Sharma', 'Carlos Martinez', 'Grace Nakamura',
];

const CATEGORIES = [
  'Payroll', 'Consulting', 'Contractor', 'Dividend', 'Grant',
  'Subscription', 'Vesting', 'Revenue Share', 'Advisor',
];

function generateSparklineData(seed: number, count: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < count; i++) {
    data.push(seededRandom(seed + i * 7) * 100);
  }
  return data;
}

function generateStreams(count: number): PaymentStream[] {
  const streams: PaymentStream[] = [];
  const currencies = ['USDC', 'USDT', 'AET', 'AED'];
  const statuses: StreamStatus[] = ['Active', 'Active', 'Active', 'Paused', 'Completed', 'Cancelled', 'Scheduled'];
  const protocols = ['Aave V3', 'Compound', 'Yearn', null, null];

  for (let i = 0; i < count; i++) {
    const seed = 40000 + i * 137;
    const totalAmount = Math.floor(seededRandom(seed) * 500000) + 10000;
    const status = statuses[Math.floor(seededRandom(seed + 10) * statuses.length)];
    const duration = Math.floor(seededRandom(seed + 20) * 31536000000) + 2592000000; // 1 month to 1 year
    const startDate = Date.now() - Math.floor(seededRandom(seed + 30) * duration * 0.8);
    const endDate = startDate + duration;
    const elapsed = Math.min(Date.now() - startDate, duration);
    const progress = status === 'Cancelled' ? seededRandom(seed + 40) * 0.5 : Math.max(0, Math.min(1, elapsed / duration));
    const streamedAmount = status === 'Completed' ? totalAmount : Math.floor(totalAmount * progress);
    const hasCliff = seededRandom(seed + 50) > 0.4;
    const autoCompound = seededRandom(seed + 60) > 0.6;

    streams.push({
      id: `STR-${String(1000 + i).padStart(5, '0')}`,
      sender: seededAddress(seed + 70),
      senderName: COMPANY_NAMES[Math.floor(seededRandom(seed + 80) * COMPANY_NAMES.length)],
      recipient: seededAddress(seed + 90),
      recipientName: PERSON_NAMES[Math.floor(seededRandom(seed + 100) * PERSON_NAMES.length)],
      totalAmount,
      streamedAmount,
      remainingAmount: totalAmount - streamedAmount,
      ratePerSecond: totalAmount / (duration / 1000),
      currency: currencies[Math.floor(seededRandom(seed + 110) * currencies.length)],
      status,
      direction: seededRandom(seed + 120) > 0.4 ? 'outgoing' : 'incoming',
      startDate,
      endDate,
      cliffDate: hasCliff ? startDate + Math.floor(duration * 0.1) : null,
      cliffAmount: hasCliff ? Math.floor(totalAmount * 0.1) : 0,
      autoCompound,
      compoundProtocol: autoCompound ? protocols[Math.floor(seededRandom(seed + 130) * protocols.length)] : null,
      category: CATEGORIES[Math.floor(seededRandom(seed + 140) * CATEGORIES.length)],
      lastWithdrawal: Date.now() - Math.floor(seededRandom(seed + 150) * 604800000),
      createdAt: startDate - Math.floor(seededRandom(seed + 160) * 86400000),
    });
  }
  // Guarantee at least one Paused stream for full status coverage
  if (streams.length > 1 && !streams.some(s => s.status === 'Paused')) {
    streams[1].status = 'Paused';
  }
  return streams;
}

function generateMilestones(streams: PaymentStream[]): StreamMilestone[] {
  const milestones: StreamMilestone[] = [];
  const descriptions = [
    'Cliff release', '25% vested', '50% milestone', '75% vested',
    'Final payment', 'Annual review', 'Renewal date', 'Bonus trigger',
  ];
  for (let i = 0; i < 12; i++) {
    const seed = 41000 + i * 97;
    const stream = streams[Math.floor(seededRandom(seed) * streams.length)];
    milestones.push({
      date: Date.now() + Math.floor(seededRandom(seed + 10) * 7776000000) - 2592000000,
      description: descriptions[Math.floor(seededRandom(seed + 20) * descriptions.length)],
      amount: Math.floor(seededRandom(seed + 30) * 50000) + 5000,
      stream: stream.id,
      streamName: stream.recipientName,
      completed: seededRandom(seed + 40) > 0.6,
    });
  }
  return milestones.sort((a, b) => a.date - b.date);
}

function generateHistory(count: number): StreamHistoryItem[] {
  const items: StreamHistoryItem[] = [];
  const actions = [
    'Stream Created', 'Withdrawal', 'Paused', 'Resumed',
    'Rate Adjusted', 'Cancelled', 'Completed', 'Cliff Released',
  ];
  for (let i = 0; i < count; i++) {
    const seed = 42000 + i * 113;
    items.push({
      id: `SH-${String(2000 + i).padStart(5, '0')}`,
      stream: `STR-${String(1000 + Math.floor(seededRandom(seed) * 16)).padStart(5, '0')}`,
      action: actions[Math.floor(seededRandom(seed + 10) * actions.length)],
      amount: Math.floor(seededRandom(seed + 20) * 100000) + 1000,
      currency: ['USDC', 'USDT', 'AET', 'AED'][Math.floor(seededRandom(seed + 30) * 4)],
      timestamp: Date.now() - Math.floor(seededRandom(seed + 40) * 2592000000),
      txHash: `0x${seededHex(seed + 50, 64)}`,
    });
  }
  return items.sort((a, b) => b.timestamp - a.timestamp);
}

function generateVelocityChart(): Array<{ day: string; outflow: number; inflow: number }> {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return days.map((day, i) => ({
    day,
    outflow: Math.floor(seededRandom(43000 + i * 41) * 50000) + 10000,
    inflow: Math.floor(seededRandom(43000 + i * 53) * 40000) + 5000,
  }));
}

function generateCumulativeChart(): Array<{ date: string; cumulative: number; daily: number }> {
  const dates = [];
  let cumulative = 0;
  for (let i = 0; i < 30; i++) {
    const daily = Math.floor(seededRandom(44000 + i * 37) * 25000) + 5000;
    cumulative += daily;
    dates.push({
      date: `Mar ${i + 1}`,
      cumulative,
      daily,
    });
  }
  return dates;
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
  if (diff < 1000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatDateShort(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRate(ratePerSecond: number, currency: string): string {
  const perDay = ratePerSecond * 86400;
  if (perDay >= 1000) return `${formatUSD(perDay)}/day`;
  const perHour = ratePerSecond * 3600;
  return `${formatUSD(perHour)}/hr`;
}


// =============================================================================
// REUSABLE LOCAL COMPONENTS
// =============================================================================

function StreamStatusBadge({ status }: { status: StreamStatus }) {
  const style = STREAM_STATUS_STYLES[status] || 'bg-slate-700/50 text-slate-300 border-slate-600/30';
  const dot = STREAM_STATUS_DOT[status] || 'bg-slate-400';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${style}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot} ${status === 'Active' ? 'animate-pulse' : ''}`} />
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

function StreamProgressBar({ stream }: { stream: PaymentStream }) {
  const progress = (stream.streamedAmount / stream.totalAmount) * 100;
  const cliffPct = stream.cliffDate
    ? ((stream.cliffDate - stream.startDate) / (stream.endDate - stream.startDate)) * 100
    : 0;

  return (
    <div className="relative">
      <div className="w-full h-3 rounded-full bg-slate-700/50 overflow-hidden">
        {/* Streamed amount */}
        <div
          className={`h-3 rounded-full transition-all duration-1000 ${
            stream.status === 'Active' ? 'bg-emerald-500' :
            stream.status === 'Paused' ? 'bg-amber-500' :
            stream.status === 'Completed' ? 'bg-blue-500' :
            stream.status === 'Cancelled' ? 'bg-red-500' :
            'bg-purple-500'
          }`}
          style={{
            width: `${progress}%`,
            ...(stream.status === 'Active' ? {
              backgroundImage: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.1) 50%, transparent 100%)',
              backgroundSize: '200% 100%',
              animation: 'payment-flow 2.5s ease-in-out infinite',
            } : {}),
          }}
        />
      </div>
      {/* Cliff marker */}
      {stream.cliffDate && cliffPct > 0 && cliffPct < 100 && (
        <div
          className="absolute top-0 w-0.5 h-3 bg-amber-400"
          style={{ left: `${cliffPct}%` }}
          title={`Cliff: ${formatDateShort(stream.cliffDate)}`}
        />
      )}
    </div>
  );
}

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

export default function StreamingPage() {
  const { realTime } = useApp();
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState('streams');
  const [directionFilter, setDirectionFilter] = useState<'all' | StreamDirection>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | StreamStatus>('all');
  const [showCreateStream, setShowCreateStream] = useState(false);
  const [showBatchCreate, setShowBatchCreate] = useState(false);
  const [selectedStream, setSelectedStream] = useState<PaymentStream | null>(null);
  useEffect(() => setMounted(true), []);

  // Generate all mock data deterministically
  const streams = useMemo(() => generateStreams(16), []);
  const milestones = useMemo(() => generateMilestones(streams), [streams]);
  const history = useMemo(() => generateHistory(20), []);
  const velocityChart = useMemo(() => generateVelocityChart(), []);
  const cumulativeChart = useMemo(() => generateCumulativeChart(), []);

  const filteredStreams = useMemo(() => {
    let result = streams;
    if (directionFilter !== 'all') result = result.filter(s => s.direction === directionFilter);
    if (statusFilter !== 'all') result = result.filter(s => s.status === statusFilter);
    return result;
  }, [streams, directionFilter, statusFilter]);

  const activeStreams = useMemo(() => streams.filter(s => s.status === 'Active'), [streams]);
  const totalOutflow = useMemo(() =>
    activeStreams.filter(s => s.direction === 'outgoing').reduce((s, st) => s + st.ratePerSecond * 86400, 0),
    [activeStreams]
  );
  const totalInflow = useMemo(() =>
    activeStreams.filter(s => s.direction === 'incoming').reduce((s, st) => s + st.ratePerSecond * 86400, 0),
    [activeStreams]
  );
  const totalStreamed = useMemo(() => streams.reduce((s, st) => s + st.streamedAmount, 0), [streams]);

  const tabs = [
    { id: 'streams', label: 'Active Streams' },
    { id: 'calendar', label: 'Calendar' },
    { id: 'history', label: 'History' },
    { id: 'analytics', label: 'Analytics' },
  ];

  return (
    <>
      <SEOHead
        title="Streaming"
        description="NoblePay payment streaming console for real-time salary, contractor, and revenue share payment streams."
        path="/streaming"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/streaming" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* ============================================================ */}
          {/* HEADER                                                       */}
          {/* ============================================================ */}
          <div className="mb-8">
            <div className="flex items-start justify-between mb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay Streaming</p>
                <h1 className="mt-2 text-3xl font-bold text-white">Payment Streams</h1>
                <p className="mt-1 text-sm text-slate-400">Real-time payment streaming for payroll, consulting, and revenue distribution</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowBatchCreate(true)}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-medium text-slate-300 hover:border-slate-500 hover:text-white transition-colors"
                >
                  <Upload className="w-4 h-4" />
                  Batch Payroll
                </button>
                <button
                  onClick={() => setShowCreateStream(true)}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  New Stream
                </button>
              </div>
            </div>

            {/* STAT CARDS */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard
                icon={Activity}
                label="Active Streams"
                value={String(activeStreams.length)}
                change={{ value: `${streams.length} total`, positive: true }}
              />
              <StatCard
                icon={ArrowUpRight}
                label="Daily Outflow"
                value={formatUSD(totalOutflow)}
                change={{ value: '+3.2%', positive: false }}
                sparkData={generateSparklineData(50000, 12)}
                sparkColor="#EF4444"
              />
              <StatCard
                icon={ArrowDownRight}
                label="Daily Inflow"
                value={formatUSD(totalInflow)}
                change={{ value: '+7.8%', positive: true }}
                sparkData={generateSparklineData(50100, 12)}
                sparkColor="#10B981"
              />
              <StatCard
                icon={DollarSign}
                label="Total Streamed"
                value={formatUSD(totalStreamed)}
                sparkData={generateSparklineData(50200, 12)}
                sparkColor="#3B82F6"
              />
              <StatCard
                icon={Timer}
                label="Avg Duration"
                value="4.2 mo"
                change={{ value: '30d to 12mo range', positive: true }}
              />
              <StatCard
                icon={Zap}
                label="Auto-Compound"
                value={String(streams.filter(s => s.autoCompound).length)}
                change={{ value: `${((streams.filter(s => s.autoCompound).length / streams.length) * 100).toFixed(0)}% of streams`, positive: true }}
              />
            </div>
          </div>

          {/* TABS */}
          <div className="mb-6">
            <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
          </div>

          {/* ============================================================ */}
          {/* STREAMS TAB                                                  */}
          {/* ============================================================ */}
          {activeTab === 'streams' && (
            <div className="space-y-6">
              {/* Filters */}
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">Direction:</span>
                  {(['all', 'outgoing', 'incoming'] as const).map((dir) => (
                    <button
                      key={dir}
                      onClick={() => setDirectionFilter(dir)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        directionFilter === dir ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {dir === 'all' ? 'All' : dir.charAt(0).toUpperCase() + dir.slice(1)}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">Status:</span>
                  {(['all', 'Active', 'Paused', 'Completed', 'Cancelled', 'Scheduled'] as const).map((status) => (
                    <button
                      key={status}
                      onClick={() => setStatusFilter(status)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        statusFilter === status ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {status === 'all' ? 'All' : status}
                    </button>
                  ))}
                </div>
              </div>

              {/* Stream Cards */}
              <div className="space-y-3">
                {filteredStreams.map((stream) => {
                  const progress = (stream.streamedAmount / stream.totalAmount) * 100;
                  return (
                    <GlassCard
                      key={stream.id}
                      className="p-5 cursor-pointer"
                      hover
                      onClick={() => setSelectedStream(stream)}
                    >
                      <div className="flex items-start justify-between gap-4 mb-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-3 mb-2">
                            <span className="text-xs font-mono text-slate-500">{stream.id}</span>
                            <StreamStatusBadge status={stream.status} />
                            <Badge variant={stream.direction === 'outgoing' ? 'error' : 'success'}>
                              {stream.direction === 'outgoing' ? 'Outgoing' : 'Incoming'}
                            </Badge>
                            <Badge variant="neutral">{stream.category}</Badge>
                          </div>
                          <div className="flex items-center gap-2 text-sm">
                            <span className="text-white font-medium">{stream.senderName}</span>
                            <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                            <span className="text-white font-medium">{stream.recipientName}</span>
                          </div>
                          <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
                            <span>Rate: {formatRate(stream.ratePerSecond, stream.currency)} ({stream.currency})</span>
                            <span>&middot;</span>
                            <span>{formatDateShort(stream.startDate)} — {formatDateShort(stream.endDate)}</span>
                            {stream.autoCompound && (
                              <>
                                <span>&middot;</span>
                                <span className="flex items-center gap-1 text-purple-400">
                                  <Zap className="w-3 h-3" />
                                  Auto-compound {stream.compoundProtocol && `(${stream.compoundProtocol})`}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-lg font-bold text-white tabular-nums">{formatUSD(stream.totalAmount)}</p>
                          <p className="text-xs text-slate-400">{stream.currency}</p>
                        </div>
                      </div>

                      {/* Progress */}
                      <StreamProgressBar stream={stream} />
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-xs text-slate-400">
                          Streamed: {formatUSD(stream.streamedAmount)} ({progress.toFixed(1)}%)
                        </span>
                        <span className="text-xs text-slate-400">
                          Remaining: {formatUSD(stream.remainingAmount)}
                        </span>
                      </div>

                      {/* Actions */}
                      {stream.status === 'Active' && (
                        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-700/30">
                          <button
                            className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-amber-500/10 text-amber-400 text-xs font-medium hover:bg-amber-500/20 transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Pause className="w-3 h-3" /> Pause
                          </button>
                          <button
                            className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-blue-500/10 text-blue-400 text-xs font-medium hover:bg-blue-500/20 transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Settings className="w-3 h-3" /> Adjust Rate
                          </button>
                          <button
                            className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-red-500/10 text-red-400 text-xs font-medium hover:bg-red-500/20 transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Square className="w-3 h-3" /> Cancel
                          </button>
                        </div>
                      )}
                      {stream.status === 'Paused' && (
                        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-slate-700/30">
                          <button
                            className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium hover:bg-emerald-500/20 transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Play className="w-3 h-3" /> Resume
                          </button>
                          <button
                            className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-red-500/10 text-red-400 text-xs font-medium hover:bg-red-500/20 transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Square className="w-3 h-3" /> Cancel
                          </button>
                        </div>
                      )}
                    </GlassCard>
                  );
                })}
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* CALENDAR TAB                                                 */}
          {/* ============================================================ */}
          {activeTab === 'calendar' && (
            <div className="space-y-6">
              <GlassCard className="p-6">
                <SectionHeader title="Upcoming Milestones" subtitle="Stream events and payment milestones" size="sm" />
                <div className="space-y-3">
                  {milestones.map((milestone, i) => {
                    const isPast = milestone.date < Date.now();
                    return (
                      <div key={i} className={`flex items-center gap-4 p-3 rounded-xl border ${
                        milestone.completed ? 'border-slate-700/30 bg-slate-800/20' : 'border-slate-700/50 bg-slate-800/40'
                      }`}>
                        <div className={`p-2 rounded-lg ${milestone.completed ? 'bg-emerald-500/10' : isPast ? 'bg-amber-500/10' : 'bg-blue-500/10'}`}>
                          {milestone.completed ? (
                            <CheckCircle className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <Calendar className="w-4 h-4 text-blue-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-medium ${milestone.completed ? 'text-slate-400 line-through' : 'text-white'}`}>
                              {milestone.description}
                            </span>
                            {milestone.completed && <Badge variant="success">Completed</Badge>}
                          </div>
                          <p className="text-xs text-slate-400 mt-0.5">
                            {milestone.streamName} &middot; {milestone.stream}
                          </p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-sm font-semibold text-white tabular-nums">{formatUSD(milestone.amount)}</p>
                          <p className="text-xs text-slate-500">{formatDateShort(milestone.date)}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </GlassCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* HISTORY TAB                                                  */}
          {/* ============================================================ */}
          {activeTab === 'history' && (
            <GlassCard className="p-6">
              <SectionHeader title="Stream History" subtitle="Complete settlement and action log" size="sm" />
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-700/50">
                      <th className="text-left py-3 px-3 text-xs font-medium text-slate-400">ID</th>
                      <th className="text-left py-3 px-3 text-xs font-medium text-slate-400">Stream</th>
                      <th className="text-left py-3 px-3 text-xs font-medium text-slate-400">Action</th>
                      <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Amount</th>
                      <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Time</th>
                      <th className="text-left py-3 px-3 text-xs font-medium text-slate-400">Tx Hash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((item) => {
                      const actionStyles: Record<string, string> = {
                        'Stream Created': 'text-blue-400',
                        Withdrawal: 'text-emerald-400',
                        Paused: 'text-amber-400',
                        Resumed: 'text-emerald-400',
                        'Rate Adjusted': 'text-purple-400',
                        Cancelled: 'text-red-400',
                        Completed: 'text-blue-400',
                        'Cliff Released': 'text-cyan-400',
                      };
                      return (
                        <tr key={item.id} className="border-b border-slate-800 hover:bg-slate-800/30 transition-colors">
                          <td className="py-3 px-3 text-xs font-mono text-slate-500">{item.id}</td>
                          <td className="py-3 px-3 text-xs font-mono text-slate-400">{item.stream}</td>
                          <td className="py-3 px-3">
                            <span className={`text-sm font-medium ${actionStyles[item.action] || 'text-slate-300'}`}>
                              {item.action}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right text-sm text-white tabular-nums">
                            {formatUSD(item.amount)} <span className="text-slate-400">{item.currency}</span>
                          </td>
                          <td className="py-3 px-3 text-right text-xs text-slate-400">{timeAgo(item.timestamp)}</td>
                          <td className="py-3 px-3">
                            <span className="text-xs font-mono text-slate-500 hover:text-slate-300 cursor-pointer">
                              {truncateAddress(item.txHash, 8, 4)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </GlassCard>
          )}

          {/* ============================================================ */}
          {/* ANALYTICS TAB                                                */}
          {/* ============================================================ */}
          {activeTab === 'analytics' && (
            <div className="space-y-8">
              {/* Streaming Velocity */}
              <GlassCard className="p-6">
                <SectionHeader title="Streaming Velocity" subtitle="Daily inflow vs outflow (this week)" size="sm" />
                {mounted && (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={velocityChart}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => formatUSD(v)} />
                      <RechartsTooltip content={<CustomTooltip />} />
                      <Bar dataKey="outflow" name="Outflow" fill="#EF4444" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="inflow" name="Inflow" fill="#10B981" radius={[4, 4, 0, 0]} />
                      <Legend />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </GlassCard>

              {/* Cumulative Payments */}
              <GlassCard className="p-6">
                <SectionHeader title="Cumulative Payments" subtitle="Running total of streamed payments (last 30 days)" size="sm" />
                {mounted && (
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={cumulativeChart}>
                      <defs>
                        <linearGradient id="cumulativeGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#DC2626" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#DC2626" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} interval={4} />
                      <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => formatUSD(v)} />
                      <RechartsTooltip content={<CustomTooltip />} />
                      <Area type="monotone" dataKey="cumulative" name="Cumulative" stroke="#DC2626" fill="url(#cumulativeGrad)" strokeWidth={2} />
                      <Legend />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </GlassCard>

              {/* Stream Metrics Summary */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <GlassCard className="p-6">
                  <div className="text-xs text-slate-400 mb-1">Monthly Outflow</div>
                  <div className="text-2xl font-bold text-white">{formatUSD(totalOutflow * 30)}</div>
                  <div className="text-xs text-red-400 mt-1 flex items-center gap-1">
                    <ArrowUpRight className="w-3 h-3" /> +5.2% vs last month
                  </div>
                </GlassCard>
                <GlassCard className="p-6">
                  <div className="text-xs text-slate-400 mb-1">Monthly Inflow</div>
                  <div className="text-2xl font-bold text-emerald-400">{formatUSD(totalInflow * 30)}</div>
                  <div className="text-xs text-emerald-400 mt-1 flex items-center gap-1">
                    <ArrowUpRight className="w-3 h-3" /> +12.1% vs last month
                  </div>
                </GlassCard>
                <GlassCard className="p-6">
                  <div className="text-xs text-slate-400 mb-1">Net Flow (Monthly)</div>
                  <div className={`text-2xl font-bold ${totalInflow > totalOutflow ? 'text-emerald-400' : 'text-red-400'}`}>
                    {totalInflow > totalOutflow ? '+' : '-'}{formatUSD(Math.abs(totalInflow - totalOutflow) * 30)}
                  </div>
                </GlassCard>
              </div>
            </div>
          )}

        </main>

        <Footer />
      </div>

      {/* ============================================================ */}
      {/* CREATE STREAM MODAL                                          */}
      {/* ============================================================ */}
      <Modal open={showCreateStream} onClose={() => setShowCreateStream(false)} title="Create Payment Stream" maxWidth="max-w-2xl">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Recipient Address</label>
            <input
              type="text"
              placeholder="aeth1..."
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm font-mono placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Total Amount</label>
              <input
                type="text"
                placeholder="0.00"
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Currency</label>
              <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">
                <option value="USDC">USDC</option>
                <option value="USDT">USDT</option>
                <option value="AET">AET</option>
                <option value="AED">AED</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Start Date</label>
              <input
                type="date"
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Duration</label>
              <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">
                <option value="30">1 Month</option>
                <option value="90">3 Months</option>
                <option value="180">6 Months</option>
                <option value="365">1 Year</option>
                <option value="custom">Custom</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Cliff Period</label>
              <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">
                <option value="0">No Cliff</option>
                <option value="30">1 Month</option>
                <option value="90">3 Months</option>
                <option value="180">6 Months</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Category</label>
              <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
            <label className="flex items-center gap-3 cursor-pointer">
              <input type="checkbox" className="rounded border-slate-600 bg-slate-700 text-red-500 focus:ring-red-500" />
              <div>
                <span className="text-sm text-white">Enable Auto-Compound</span>
                <p className="text-xs text-slate-400 mt-0.5">Automatically reinvest undrawn funds into yield strategies</p>
              </div>
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-700/50">
            <button
              onClick={() => setShowCreateStream(false)}
              className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => setShowCreateStream(false)}
              className="px-6 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"
            >
              Create Stream
            </button>
          </div>
        </div>
      </Modal>

      {/* ============================================================ */}
      {/* BATCH PAYROLL MODAL                                          */}
      {/* ============================================================ */}
      <Modal open={showBatchCreate} onClose={() => setShowBatchCreate(false)} title="Batch Payroll Creation" maxWidth="max-w-2xl">
        <div className="space-y-4">
          <div className="p-6 rounded-xl border-2 border-dashed border-slate-700 text-center">
            <Upload className="w-8 h-8 text-slate-500 mx-auto mb-2" />
            <p className="text-sm text-slate-300">Upload CSV file with payroll data</p>
            <p className="text-xs text-slate-500 mt-1">Format: recipient_address, name, amount, duration_days, currency</p>
            <button className="mt-3 px-4 py-2 rounded-lg bg-slate-800 text-sm text-slate-300 hover:text-white transition-colors">
              Choose File
            </button>
          </div>

          <div className="text-xs text-slate-400">Or add entries manually:</div>

          {/* Manual entry rows */}
          {[0, 1, 2].map((i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-4">
                {i === 0 && <label className="block text-[10px] text-slate-500 mb-1">Recipient</label>}
                <input
                  type="text"
                  placeholder={PERSON_NAMES[i]}
                  className="w-full px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-xs placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500"
                />
              </div>
              <div className="col-span-3">
                {i === 0 && <label className="block text-[10px] text-slate-500 mb-1">Amount</label>}
                <input
                  type="text"
                  placeholder="10,000"
                  className="w-full px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-xs placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500"
                />
              </div>
              <div className="col-span-2">
                {i === 0 && <label className="block text-[10px] text-slate-500 mb-1">Duration</label>}
                <select className="w-full px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-xs focus:outline-none focus:ring-1 focus:ring-red-500">
                  <option>30d</option>
                  <option>90d</option>
                  <option>180d</option>
                  <option>365d</option>
                </select>
              </div>
              <div className="col-span-2">
                {i === 0 && <label className="block text-[10px] text-slate-500 mb-1">Token</label>}
                <select className="w-full px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-xs focus:outline-none focus:ring-1 focus:ring-red-500">
                  <option>USDC</option>
                  <option>USDT</option>
                  <option>AET</option>
                </select>
              </div>
              <div className="col-span-1">
                {i === 0 && <label className="block text-[10px] text-slate-500 mb-1">&nbsp;</label>}
                <button className="w-full py-1.5 rounded-lg text-slate-500 hover:text-red-400 transition-colors">
                  <X className="w-4 h-4 mx-auto" />
                </button>
              </div>
            </div>
          ))}

          <button className="inline-flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add Another Row
          </button>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-700/50">
            <button
              onClick={() => setShowBatchCreate(false)}
              className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => setShowBatchCreate(false)}
              className="px-6 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"
            >
              Create Batch Streams
            </button>
          </div>
        </div>
      </Modal>

      {/* ============================================================ */}
      {/* STREAM DETAIL DRAWER                                         */}
      {/* ============================================================ */}
      <Drawer
        open={selectedStream !== null}
        onClose={() => setSelectedStream(null)}
        title={selectedStream ? `Stream ${selectedStream.id}` : 'Stream Detail'}
        width="max-w-xl"
      >
        {selectedStream && (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <StreamStatusBadge status={selectedStream.status} />
              <Badge variant={selectedStream.direction === 'outgoing' ? 'error' : 'success'}>
                {selectedStream.direction === 'outgoing' ? 'Outgoing' : 'Incoming'}
              </Badge>
              <Badge variant="neutral">{selectedStream.category}</Badge>
            </div>

            {/* Participants */}
            <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
              <div className="flex items-center gap-3 mb-3">
                <div className="flex-1">
                  <p className="text-xs text-slate-400">Sender</p>
                  <p className="text-sm font-medium text-white">{selectedStream.senderName}</p>
                  <p className="text-xs text-slate-500 font-mono">{truncateAddress(selectedStream.sender, 10, 6)}</p>
                </div>
                <ArrowRight className="w-4 h-4 text-slate-500" />
                <div className="flex-1">
                  <p className="text-xs text-slate-400">Recipient</p>
                  <p className="text-sm font-medium text-white">{selectedStream.recipientName}</p>
                  <p className="text-xs text-slate-500 font-mono">{truncateAddress(selectedStream.recipient, 10, 6)}</p>
                </div>
              </div>
            </div>

            {/* Amount breakdown */}
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30 text-center">
                <p className="text-xs text-slate-400">Total</p>
                <p className="text-lg font-bold text-white">{formatUSD(selectedStream.totalAmount)}</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30 text-center">
                <p className="text-xs text-slate-400">Streamed</p>
                <p className="text-lg font-bold text-emerald-400">{formatUSD(selectedStream.streamedAmount)}</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30 text-center">
                <p className="text-xs text-slate-400">Remaining</p>
                <p className="text-lg font-bold text-amber-400">{formatUSD(selectedStream.remainingAmount)}</p>
              </div>
            </div>

            {/* Progress */}
            <div>
              <StreamProgressBar stream={selectedStream} />
              <div className="flex justify-between mt-2 text-xs text-slate-400">
                <span>{formatDateShort(selectedStream.startDate)}</span>
                <span>{((selectedStream.streamedAmount / selectedStream.totalAmount) * 100).toFixed(1)}%</span>
                <span>{formatDateShort(selectedStream.endDate)}</span>
              </div>
            </div>

            {/* Details */}
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-xs text-slate-400">Rate</span>
                <span className="text-sm text-white">{formatRate(selectedStream.ratePerSecond, selectedStream.currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-slate-400">Currency</span>
                <span className="text-sm text-white">{selectedStream.currency}</span>
              </div>
              {selectedStream.cliffDate && (
                <div className="flex justify-between">
                  <span className="text-xs text-slate-400">Cliff</span>
                  <span className="text-sm text-white">
                    {formatDateShort(selectedStream.cliffDate)} ({formatUSD(selectedStream.cliffAmount)})
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-xs text-slate-400">Auto-Compound</span>
                <span className={`text-sm ${selectedStream.autoCompound ? 'text-purple-400' : 'text-slate-400'}`}>
                  {selectedStream.autoCompound ? `Yes (${selectedStream.compoundProtocol || 'Default'})` : 'No'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-slate-400">Last Withdrawal</span>
                <span className="text-sm text-slate-300">{timeAgo(selectedStream.lastWithdrawal)}</span>
              </div>
            </div>

            {/* Actions */}
            {selectedStream.status === 'Active' && (
              <div className="flex gap-3 pt-4 border-t border-slate-700/50">
                <button className="flex-1 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors">
                  Withdraw
                </button>
                <button className="flex-1 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 transition-colors">
                  Pause
                </button>
                <button className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors">
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}
