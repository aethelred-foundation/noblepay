/**
 * NoblePay Liquidity — Institutional Liquidity Pool Dashboard
 *
 * Enterprise liquidity management interface with pool analytics,
 * position management, market maker configuration, LP rewards,
 * and concentrated liquidity range visualization.
 *
 * All mock data uses seededRandom for deterministic SSR hydration.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { SEOHead } from '@/components/SEOHead';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  Legend, ReferenceLine, ComposedChart,
} from 'recharts';
import {
  Droplets, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight,
  Plus, Minus, RefreshCw, AlertTriangle, CheckCircle, Settings,
  ChevronRight, Eye, BarChart3, Activity, Shield, Zap,
  Clock, Lock, Wallet, ArrowRight, X, DollarSign,
  Layers, Target, AlertCircle, Filter, Search, Download,
  Gauge, Radio, Heart, PieChart as PieChartIcon, ChevronDown,
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

const POOL_PAIR_COLORS: Record<string, { primary: string; secondary: string }> = {
  'USDC/AET': { primary: '#2775CA', secondary: '#DC2626' },
  'USDT/AET': { primary: '#26A17B', secondary: '#DC2626' },
  'USDC/USDT': { primary: '#2775CA', secondary: '#26A17B' },
  'AED/USDC': { primary: '#009B3A', secondary: '#2775CA' },
  'AET/AED': { primary: '#DC2626', secondary: '#009B3A' },
  'USDC/AED': { primary: '#2775CA', secondary: '#009B3A' },
};


// =============================================================================
// TYPES
// =============================================================================

type PoolStatus = 'Active' | 'Paused' | 'Rebalancing';
type PositionStatus = 'In Range' | 'Out of Range' | 'Closed';

interface LiquidityPool {
  id: string;
  pair: string;
  tokenA: string;
  tokenB: string;
  tvl: number;
  apy: number;
  volume24h: number;
  volume7d: number;
  utilization: number;
  fees24h: number;
  status: PoolStatus;
  minLiquidity: number;
  circuitBreaker: boolean;
  sparkData: number[];
}

interface Position {
  id: string;
  pool: string;
  pair: string;
  liquidity: number;
  lowerTick: number;
  upperTick: number;
  currentTick: number;
  feesEarned: number;
  impermanentLoss: number;
  status: PositionStatus;
  entryDate: number;
  tokenAAmount: number;
  tokenBAmount: number;
}

interface FlashLiquidityRequest {
  id: string;
  pair: string;
  amount: number;
  fee: number;
  requester: string;
  requesterName: string;
  timestamp: number;
  status: 'Fulfilled' | 'Pending' | 'Expired';
}

interface RebalanceAlert {
  id: string;
  pool: string;
  pair: string;
  type: 'utilization' | 'price' | 'volume' | 'health';
  severity: 'low' | 'medium' | 'high';
  message: string;
  timestamp: number;
  acknowledged: boolean;
}

interface LPReward {
  pool: string;
  pair: string;
  pendingRewards: number;
  claimedRewards: number;
  rewardToken: string;
  apr: number;
}

interface MarketMakerConfig {
  pair: string;
  spreadBps: number;
  orderDepth: number;
  maxSlippage: number;
  autoRebalance: boolean;
  minProfitBps: number;
}


// =============================================================================
// MOCK DATA GENERATORS
// =============================================================================

const POOL_PAIRS = ['USDC/AET', 'USDT/AET', 'USDC/USDT', 'AED/USDC', 'AET/AED', 'USDC/AED'];
const REQUESTER_NAMES = [
  'Meridian Capital', 'Falcon Fintech', 'Desert Rose Trading', 'Gulf Stream Finance',
  'Phoenix Partners', 'Oasis Digital Assets', 'Atlas Ventures', 'Zenith Corp',
];

function generateSparklineData(seed: number, count: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < count; i++) {
    data.push(seededRandom(seed + i * 7) * 100);
  }
  return data;
}

function generatePools(): LiquidityPool[] {
  return POOL_PAIRS.map((pair, i) => {
    const seed = 20000 + i * 137;
    const [tokenA, tokenB] = pair.split('/');
    return {
      id: `LP-${String(100 + i).padStart(4, '0')}`,
      pair,
      tokenA,
      tokenB,
      tvl: Math.floor(seededRandom(seed) * 30000000) + 5000000,
      apy: seededRandom(seed + 10) * 18 + 2,
      volume24h: Math.floor(seededRandom(seed + 20) * 8000000) + 500000,
      volume7d: Math.floor(seededRandom(seed + 30) * 50000000) + 3000000,
      utilization: seededRandom(seed + 40) * 80 + 15,
      fees24h: Math.floor(seededRandom(seed + 50) * 50000) + 5000,
      status: seededRandom(seed + 60) > 0.15 ? 'Active' : (seededRandom(seed + 70) > 0.5 ? 'Paused' : 'Rebalancing'),
      minLiquidity: 1000000,
      circuitBreaker: seededRandom(seed + 80) > 0.85,
      sparkData: generateSparklineData(seed + 90, 12),
    };
  });
}

function generatePositions(): Position[] {
  const positions: Position[] = [];
  for (let i = 0; i < 8; i++) {
    const seed = 21000 + i * 151;
    const pair = POOL_PAIRS[Math.floor(seededRandom(seed) * POOL_PAIRS.length)];
    const currentTick = Math.floor(seededRandom(seed + 10) * 2000) + 500;
    const lowerTick = currentTick - Math.floor(seededRandom(seed + 20) * 400) - 50;
    const upperTick = currentTick + Math.floor(seededRandom(seed + 30) * 400) + 50;
    const inRange = currentTick >= lowerTick && currentTick <= upperTick;
    positions.push({
      id: `POS-${String(200 + i).padStart(4, '0')}`,
      pool: `LP-${String(100 + Math.floor(seededRandom(seed + 40) * 6)).padStart(4, '0')}`,
      pair,
      liquidity: Math.floor(seededRandom(seed + 50) * 2000000) + 100000,
      lowerTick,
      upperTick,
      currentTick,
      feesEarned: Math.floor(seededRandom(seed + 60) * 50000) + 1000,
      impermanentLoss: seededRandom(seed + 70) * 5,
      status: seededRandom(seed + 80) > 0.1 ? (inRange ? 'In Range' : 'Out of Range') : 'Closed',
      entryDate: Date.now() - Math.floor(seededRandom(seed + 90) * 7776000000),
      tokenAAmount: Math.floor(seededRandom(seed + 100) * 500000) + 10000,
      tokenBAmount: Math.floor(seededRandom(seed + 110) * 500000) + 10000,
    });
  }
  return positions;
}

function generateFlashRequests(): FlashLiquidityRequest[] {
  const requests: FlashLiquidityRequest[] = [];
  for (let i = 0; i < 10; i++) {
    const seed = 22000 + i * 113;
    requests.push({
      id: `FL-${String(300 + i).padStart(4, '0')}`,
      pair: POOL_PAIRS[Math.floor(seededRandom(seed) * POOL_PAIRS.length)],
      amount: Math.floor(seededRandom(seed + 10) * 5000000) + 100000,
      fee: Math.floor(seededRandom(seed + 20) * 2000) + 100,
      requester: seededAddress(seed + 30),
      requesterName: REQUESTER_NAMES[Math.floor(seededRandom(seed + 40) * REQUESTER_NAMES.length)],
      timestamp: Date.now() - Math.floor(seededRandom(seed + 50) * 604800000),
      status: seededRandom(seed + 60) > 0.3 ? 'Fulfilled' : (seededRandom(seed + 70) > 0.5 ? 'Pending' : 'Expired'),
    });
  }
  return requests.sort((a, b) => b.timestamp - a.timestamp);
}

function generateAlerts(): RebalanceAlert[] {
  const alerts: RebalanceAlert[] = [];
  const messages = [
    'Utilization exceeds 85% threshold', 'Price deviation exceeds tolerance',
    'Volume spike detected — 3x average', 'Pool health below minimum',
    'Impermanent loss exceeds 3%', 'Circuit breaker approaching trigger',
    'Min liquidity threshold warning', 'Auto-rebalance triggered',
  ];
  for (let i = 0; i < 8; i++) {
    const seed = 23000 + i * 97;
    alerts.push({
      id: `ALR-${String(400 + i).padStart(4, '0')}`,
      pool: `LP-${String(100 + Math.floor(seededRandom(seed) * 6)).padStart(4, '0')}`,
      pair: POOL_PAIRS[Math.floor(seededRandom(seed + 10) * POOL_PAIRS.length)],
      type: (['utilization', 'price', 'volume', 'health'] as const)[Math.floor(seededRandom(seed + 20) * 4)],
      severity: (['low', 'medium', 'high'] as const)[Math.floor(seededRandom(seed + 30) * 3)],
      message: messages[Math.floor(seededRandom(seed + 40) * messages.length)],
      timestamp: Date.now() - Math.floor(seededRandom(seed + 50) * 259200000),
      acknowledged: seededRandom(seed + 60) > 0.4,
    });
  }
  return alerts.sort((a, b) => b.timestamp - a.timestamp);
}

function generateRewards(): LPReward[] {
  return POOL_PAIRS.map((pair, i) => {
    const seed = 24000 + i * 83;
    return {
      pool: `LP-${String(100 + i).padStart(4, '0')}`,
      pair,
      pendingRewards: Math.floor(seededRandom(seed) * 25000) + 500,
      claimedRewards: Math.floor(seededRandom(seed + 10) * 100000) + 5000,
      rewardToken: 'AET',
      apr: seededRandom(seed + 20) * 15 + 3,
    };
  });
}

function generateTVLChart(): Array<{ date: string; tvl: number; volume: number }> {
  const dates = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return dates.map((date, i) => ({
    date,
    tvl: 40000000 + Math.floor(seededRandom(25000 + i * 41) * 30000000),
    volume: 5000000 + Math.floor(seededRandom(25000 + i * 53) * 15000000),
  }));
}

function generateVolumeByPair(): Array<{ pair: string; volume: number; fill: string }> {
  return POOL_PAIRS.map((pair, i) => ({
    pair,
    volume: Math.floor(seededRandom(26000 + i * 67) * 12000000) + 1000000,
    fill: CHART_COLORS[i],
  }));
}

function generateFeeDistribution(): Array<{ pair: string; fees: number; fill: string }> {
  return POOL_PAIRS.map((pair, i) => ({
    pair,
    fees: Math.floor(seededRandom(27000 + i * 73) * 80000) + 5000,
    fill: CHART_COLORS[i],
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

function timeAgo(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 1000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}


// =============================================================================
// REUSABLE LOCAL COMPONENTS
// =============================================================================

function PoolStatusBadge({ status }: { status: PoolStatus }) {
  const styles: Record<PoolStatus, string> = {
    Active: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    Paused: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    Rebalancing: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  };
  const dots: Record<PoolStatus, string> = {
    Active: 'bg-emerald-400',
    Paused: 'bg-amber-400',
    Rebalancing: 'bg-blue-400',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dots[status]} ${status === 'Active' ? 'animate-pulse' : ''}`} />
      {status}
    </span>
  );
}

function PositionStatusBadge({ status }: { status: PositionStatus }) {
  const styles: Record<PositionStatus, string> = {
    'In Range': 'bg-emerald-500/20 text-emerald-400',
    'Out of Range': 'bg-amber-500/20 text-amber-400',
    Closed: 'bg-slate-500/20 text-slate-400',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
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

function ProgressBar({ value, max, color = 'bg-red-500', height = 'h-2' }: {
  value: number;
  max: number;
  color?: string;
  height?: string;
}) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className={`w-full ${height} rounded-full bg-slate-700/50 overflow-hidden`}>
      <div
        className={`${height} rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function AlertSeverityBadge({ severity }: { severity: 'low' | 'medium' | 'high' }) {
  const styles = {
    low: 'bg-blue-500/20 text-blue-400',
    medium: 'bg-amber-500/20 text-amber-400',
    high: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[severity]}`}>
      {severity.charAt(0).toUpperCase() + severity.slice(1)}
    </span>
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

export default function LiquidityPage() {
  const { realTime } = useApp();
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState('pools');
  const [showAddLiquidity, setShowAddLiquidity] = useState(false);
  const [selectedPool, setSelectedPool] = useState<LiquidityPool | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  useEffect(() => setMounted(true), []);

  // Generate all mock data deterministically
  const pools = useMemo(() => generatePools(), []);
  const positions = useMemo(() => generatePositions(), []);
  const flashRequests = useMemo(() => generateFlashRequests(), []);
  const alerts = useMemo(() => generateAlerts(), []);
  const rewards = useMemo(() => generateRewards(), []);
  const tvlChart = useMemo(() => generateTVLChart(), []);
  const volumeByPair = useMemo(() => generateVolumeByPair(), []);
  const feeDistribution = useMemo(() => generateFeeDistribution(), []);

  const totalTVL = useMemo(() => pools.reduce((s, p) => s + p.tvl, 0), [pools]);
  const totalVolume24h = useMemo(() => pools.reduce((s, p) => s + p.volume24h, 0), [pools]);
  const totalFees24h = useMemo(() => pools.reduce((s, p) => s + p.fees24h, 0), [pools]);
  const totalPendingRewards = useMemo(() => rewards.reduce((s, r) => s + r.pendingRewards, 0), [rewards]);
  const activeAlerts = useMemo(() => alerts.filter(a => !a.acknowledged).length, [alerts]);

  const tabs = [
    { id: 'pools', label: 'Pools' },
    { id: 'positions', label: 'Positions' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'alerts', label: `Alerts (${activeAlerts})` },
    { id: 'rewards', label: 'Rewards' },
    { id: 'flash', label: 'Flash Liquidity' },
  ];

  return (
    <>
      <SEOHead
        title="Liquidity"
        description="NoblePay institutional liquidity pool dashboard with concentrated liquidity, market making, and LP rewards."
        path="/liquidity"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/liquidity" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* ============================================================ */}
          {/* HEADER                                                       */}
          {/* ============================================================ */}
          <div className="mb-8">
            <div className="flex items-start justify-between mb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay Liquidity</p>
                <h1 className="mt-2 text-3xl font-bold text-white">Liquidity Pools</h1>
                <p className="mt-1 text-sm text-slate-400">Institutional liquidity management with concentrated ranges and LP rewards</p>
              </div>
              <button
                onClick={() => setShowAddLiquidity(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add Liquidity
              </button>
            </div>

            {/* STAT CARDS */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard
                icon={Droplets}
                label="Total TVL"
                value={formatUSD(totalTVL)}
                change={{ value: '+5.2%', positive: true }}
                sparkData={generateSparklineData(30000, 12)}
                sparkColor="#3B82F6"
              />
              <StatCard
                icon={Activity}
                label="Volume (24h)"
                value={formatUSD(totalVolume24h)}
                change={{ value: '+18.7%', positive: true }}
                sparkData={generateSparklineData(30100, 12)}
                sparkColor="#10B981"
              />
              <StatCard
                icon={DollarSign}
                label="Fees (24h)"
                value={formatUSD(totalFees24h)}
                change={{ value: '+9.3%', positive: true }}
              />
              <StatCard
                icon={Layers}
                label="Active Pools"
                value={String(pools.filter(p => p.status === 'Active').length)}
                change={{ value: `${pools.length} total`, positive: true }}
              />
              <StatCard
                icon={Target}
                label="Positions"
                value={String(positions.filter(p => p.status !== 'Closed').length)}
                change={{ value: `${positions.filter(p => p.status === 'In Range').length} in range`, positive: true }}
              />
              <StatCard
                icon={Zap}
                label="Pending Rewards"
                value={`${formatNumber(totalPendingRewards)} AET`}
                sparkData={generateSparklineData(30200, 12)}
                sparkColor="#F59E0B"
              />
            </div>
          </div>

          {/* TABS */}
          <div className="mb-6">
            <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
          </div>

          {/* ============================================================ */}
          {/* POOLS TAB                                                    */}
          {/* ============================================================ */}
          {activeTab === 'pools' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {pools.map((pool) => (
                  <GlassCard
                    key={pool.id}
                    className="p-5 cursor-pointer"
                    hover
                    onClick={() => setSelectedPool(pool)}
                  >
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="flex -space-x-2">
                          <div className="w-8 h-8 rounded-full border-2 border-slate-900 flex items-center justify-center text-[10px] font-bold"
                            style={{ backgroundColor: POOL_PAIR_COLORS[pool.pair]?.primary || '#666', color: 'white' }}>
                            {pool.tokenA}
                          </div>
                          <div className="w-8 h-8 rounded-full border-2 border-slate-900 flex items-center justify-center text-[10px] font-bold"
                            style={{ backgroundColor: POOL_PAIR_COLORS[pool.pair]?.secondary || '#999', color: 'white' }}>
                            {pool.tokenB}
                          </div>
                        </div>
                        <div>
                          <h3 className="text-sm font-semibold text-white">{pool.pair}</h3>
                          <span className="text-xs text-slate-500">{pool.id}</span>
                        </div>
                      </div>
                      <PoolStatusBadge status={pool.status} />
                    </div>

                    <div className="grid grid-cols-2 gap-3 mb-4">
                      <div>
                        <p className="text-xs text-slate-400">TVL</p>
                        <p className="text-sm font-semibold text-white tabular-nums">{formatUSD(pool.tvl)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-400">APY</p>
                        <p className="text-sm font-semibold text-emerald-400 tabular-nums">{pool.apy.toFixed(2)}%</p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-400">Volume (24h)</p>
                        <p className="text-sm font-semibold text-white tabular-nums">{formatUSD(pool.volume24h)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-slate-400">Fees (24h)</p>
                        <p className="text-sm font-semibold text-white tabular-nums">{formatUSD(pool.fees24h)}</p>
                      </div>
                    </div>

                    {/* Utilization bar */}
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-slate-400">Utilization</span>
                        <span className={`tabular-nums ${pool.utilization > 85 ? 'text-red-400' : pool.utilization > 70 ? 'text-amber-400' : 'text-emerald-400'}`}>
                          {pool.utilization.toFixed(1)}%
                        </span>
                      </div>
                      <ProgressBar value={pool.utilization} max={100} color="bg-blue-500" height="h-1.5" />
                    </div>

                    {/* Health indicators */}
                    <div className="flex items-center gap-3 mt-3 pt-3 border-t border-slate-700/30">
                      <div className="flex items-center gap-1.5">
                        <Shield className={`w-3 h-3 ${pool.circuitBreaker ? 'text-red-400' : 'text-emerald-400'}`} />
                        <span className="text-xs text-slate-400">
                          {pool.circuitBreaker ? 'CB Active' : 'CB Ready'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Gauge className={`w-3 h-3 ${pool.tvl > pool.minLiquidity ? 'text-emerald-400' : 'text-red-400'}`} />
                        <span className="text-xs text-slate-400">Min Liq OK</span>
                      </div>
                      <div className="flex-1" />
                      <Sparkline data={pool.sparkData} color={POOL_PAIR_COLORS[pool.pair]?.primary || '#666'} height={20} width={48} />
                    </div>
                  </GlassCard>
                ))}
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* POSITIONS TAB                                                */}
          {/* ============================================================ */}
          {activeTab === 'positions' && (
            <div className="space-y-4">
              {positions.map((pos) => (
                <GlassCard
                  key={pos.id}
                  className="p-5 cursor-pointer"
                  hover
                  onClick={() => setSelectedPosition(pos)}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="text-xs font-mono text-slate-500">{pos.id}</span>
                        <PositionStatusBadge status={pos.status} />
                        <Badge variant="neutral">{pos.pair}</Badge>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-3">
                        <div>
                          <p className="text-xs text-slate-400">Liquidity</p>
                          <p className="text-sm font-semibold text-white tabular-nums">{formatUSD(pos.liquidity)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-400">Fees Earned</p>
                          <p className="text-sm font-semibold text-emerald-400 tabular-nums">{formatUSD(pos.feesEarned)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-400">IL</p>
                          <p className="text-sm font-semibold text-red-400 tabular-nums">-{pos.impermanentLoss.toFixed(2)}%</p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-400">Range</p>
                          <p className="text-sm text-slate-300 tabular-nums">{pos.lowerTick} — {pos.upperTick}</p>
                        </div>
                      </div>
                    </div>
                    <div className="flex-shrink-0 w-32">
                      {/* Mini range visualization */}
                      <div className="h-12 bg-slate-800/50 rounded-lg relative overflow-hidden">
                        {(() => {
                          const range = pos.upperTick - pos.lowerTick;
                          const totalRange = range * 1.6;
                          const start = ((pos.lowerTick - (pos.lowerTick - range * 0.3)) / totalRange) * 100;
                          const width = (range / totalRange) * 100;
                          const currentPos = ((pos.currentTick - (pos.lowerTick - range * 0.3)) / totalRange) * 100;
                          return (
                            <>
                              <div
                                className="absolute top-0 bottom-0 bg-blue-500/20 border-x border-blue-500/40"
                                style={{ left: `${start}%`, width: `${width}%` }}
                              />
                              <div
                                className="absolute top-0 bottom-0 w-0.5 bg-white"
                                style={{ left: `${Math.min(100, Math.max(0, currentPos))}%` }}
                              />
                            </>
                          );
                        })()}
                      </div>
                      <p className="text-[10px] text-slate-500 text-center mt-1">Current: {pos.currentTick}</p>
                    </div>
                  </div>
                </GlassCard>
              ))}
            </div>
          )}

          {/* ============================================================ */}
          {/* ANALYTICS TAB                                                */}
          {/* ============================================================ */}
          {activeTab === 'analytics' && (
            <div className="space-y-8">
              {/* TVL Over Time */}
              <GlassCard className="p-6">
                <SectionHeader title="TVL & Volume Over Time" subtitle="Monthly aggregate data" size="sm" />
                {mounted && (
                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart data={tvlChart}>
                      <defs>
                        <linearGradient id="tvlGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#DC2626" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#DC2626" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => formatUSD(v)} />
                      <RechartsTooltip content={<CustomTooltip />} />
                      <Area type="monotone" dataKey="tvl" name="TVL" stroke="#DC2626" fill="url(#tvlGrad)" strokeWidth={2} />
                      <Bar dataKey="volume" name="Volume" fill="#0EA5E9" opacity={0.6} radius={[4, 4, 0, 0]} />
                      <Legend />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </GlassCard>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Volume by Pair */}
                <GlassCard className="p-6">
                  <SectionHeader title="Volume by Pair" subtitle="24h trading volume distribution" size="sm" />
                  {mounted && (
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={volumeByPair} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => formatUSD(v)} />
                        <YAxis dataKey="pair" type="category" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} width={80} />
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Bar dataKey="volume" name="Volume" radius={[0, 6, 6, 0]}>
                          {volumeByPair.map((entry, i) => (
                            <Cell key={i} fill={entry.fill} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </GlassCard>

                {/* Fee Distribution */}
                <GlassCard className="p-6">
                  <SectionHeader title="Fee Distribution" subtitle="24h fees by pool" size="sm" />
                  {mounted && (
                    <ResponsiveContainer width="100%" height={280}>
                      <PieChart>
                        <Pie
                          data={feeDistribution}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={100}
                          paddingAngle={3}
                          dataKey="fees"
                          nameKey="pair"
                        >
                          {feeDistribution.map((entry, i) => (
                            <Cell key={i} fill={entry.fill} />
                          ))}
                        </Pie>
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </GlassCard>
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* ALERTS TAB                                                   */}
          {/* ============================================================ */}
          {activeTab === `Alerts (${activeAlerts})` || activeTab === 'alerts' ? (
            activeTab.startsWith('Alerts') || activeTab === 'alerts' ? (
              <div className="space-y-3">
                {alerts.map((alert) => (
                  <GlassCard key={alert.id} className={`p-4 ${!alert.acknowledged ? 'border-l-2 border-l-amber-500' : ''}`} hover={false}>
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg ${
                        alert.severity === 'high' ? 'bg-red-500/10' : alert.severity === 'medium' ? 'bg-amber-500/10' : 'bg-blue-500/10'
                      }`}>
                        <AlertTriangle className={`w-4 h-4 ${
                          alert.severity === 'high' ? 'text-red-400' : alert.severity === 'medium' ? 'text-amber-400' : 'text-blue-400'
                        }`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-white">{alert.message}</span>
                          <AlertSeverityBadge severity={alert.severity} />
                        </div>
                        <div className="flex items-center gap-3 text-xs text-slate-400">
                          <span>{alert.pair}</span>
                          <span>&middot;</span>
                          <span>{alert.pool}</span>
                          <span>&middot;</span>
                          <span>{timeAgo(alert.timestamp)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {alert.acknowledged ? (
                          <Badge variant="success">Acknowledged</Badge>
                        ) : (
                          <button className="px-3 py-1 rounded-lg bg-slate-800 text-xs text-slate-300 hover:text-white hover:bg-slate-700 transition-colors">
                            Acknowledge
                          </button>
                        )}
                      </div>
                    </div>
                  </GlassCard>
                ))}
              </div>
            ) : null
          ) : null}

          {/* ============================================================ */}
          {/* REWARDS TAB                                                  */}
          {/* ============================================================ */}
          {activeTab === 'rewards' && (
            <div className="space-y-6">
              {/* Summary */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <GlassCard className="p-6">
                  <div className="text-xs text-slate-400 mb-1">Total Pending Rewards</div>
                  <div className="text-2xl font-bold text-white">{formatNumber(totalPendingRewards)} AET</div>
                  <button className="mt-3 w-full py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors">
                    Claim All
                  </button>
                </GlassCard>
                <GlassCard className="p-6">
                  <div className="text-xs text-slate-400 mb-1">Total Claimed</div>
                  <div className="text-2xl font-bold text-emerald-400">
                    {formatNumber(rewards.reduce((s, r) => s + r.claimedRewards, 0))} AET
                  </div>
                </GlassCard>
                <GlassCard className="p-6">
                  <div className="text-xs text-slate-400 mb-1">Average APR</div>
                  <div className="text-2xl font-bold text-white">
                    {(rewards.reduce((s, r) => s + r.apr, 0) / rewards.length).toFixed(2)}%
                  </div>
                </GlassCard>
              </div>

              {/* Rewards Table */}
              <GlassCard className="p-6">
                <SectionHeader title="LP Rewards by Pool" size="sm" />
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-700/50">
                        <th className="text-left py-3 px-3 text-xs font-medium text-slate-400">Pool</th>
                        <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Pending</th>
                        <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Claimed</th>
                        <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">APR</th>
                        <th className="text-center py-3 px-3 text-xs font-medium text-slate-400">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rewards.map((reward) => (
                        <tr key={reward.pool} className="border-b border-slate-800 hover:bg-slate-800/30 transition-colors">
                          <td className="py-3 px-3">
                            <div className="flex items-center gap-2">
                              <Droplets className="w-4 h-4 text-blue-400" />
                              <span className="text-sm font-medium text-white">{reward.pair}</span>
                            </div>
                          </td>
                          <td className="py-3 px-3 text-right text-sm text-white tabular-nums">{formatNumber(reward.pendingRewards)} AET</td>
                          <td className="py-3 px-3 text-right text-sm text-slate-300 tabular-nums">{formatNumber(reward.claimedRewards)} AET</td>
                          <td className="py-3 px-3 text-right text-sm text-emerald-400 tabular-nums">{reward.apr.toFixed(2)}%</td>
                          <td className="py-3 px-3 text-center">
                            <button className="px-3 py-1 rounded-lg bg-red-600/20 text-red-400 text-xs font-medium hover:bg-red-600/30 transition-colors">
                              Claim
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </GlassCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* FLASH LIQUIDITY TAB                                          */}
          {/* ============================================================ */}
          {activeTab === 'flash' && (
            <GlassCard className="p-6">
              <SectionHeader title="Flash Liquidity Requests" subtitle="On-demand liquidity provisioning history" size="sm" />
              <div className="space-y-3">
                {flashRequests.map((req) => {
                  const statusStyles = {
                    Fulfilled: 'text-emerald-400',
                    Pending: 'text-amber-400',
                    Expired: 'text-slate-400',
                  };
                  return (
                    <div key={req.id} className="flex items-center justify-between p-3 rounded-xl hover:bg-slate-800/30 transition-colors border border-slate-700/20">
                      <div className="flex items-center gap-3">
                        <Zap className={`w-4 h-4 ${statusStyles[req.status]}`} />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-white">{req.pair}</span>
                            <span className="text-xs font-mono text-slate-500">{req.id}</span>
                          </div>
                          <p className="text-xs text-slate-400 mt-0.5">
                            {req.requesterName} &middot; {truncateAddress(req.requester, 8, 4)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-white tabular-nums">{formatUSD(req.amount)}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-xs text-slate-500">Fee: {formatUSD(req.fee)}</span>
                          <span className={`text-xs font-medium ${statusStyles[req.status]}`}>{req.status}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </GlassCard>
          )}

        </main>

        <Footer />
      </div>

      {/* ============================================================ */}
      {/* ADD LIQUIDITY MODAL                                          */}
      {/* ============================================================ */}
      <Modal open={showAddLiquidity} onClose={() => setShowAddLiquidity(false)} title="Add Liquidity" maxWidth="max-w-2xl">
        <div className="space-y-5">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Select Pool</label>
            <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">
              {POOL_PAIRS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Token A Amount</label>
              <input
                type="text"
                placeholder="0.00"
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Token B Amount</label>
              <input
                type="text"
                placeholder="0.00"
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-2">Price Range (Concentrated Liquidity)</label>
            <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-[10px] text-slate-500 mb-1">Min Price</label>
                  <input
                    type="text"
                    placeholder="0.95"
                    className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 mb-1">Max Price</label>
                  <input
                    type="text"
                    placeholder="1.05"
                    className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  />
                </div>
              </div>
              {/* Range visualization */}
              <div className="h-16 bg-slate-900/60 rounded-lg relative overflow-hidden">
                <div className="absolute top-0 bottom-0 bg-blue-500/15 border-x border-blue-500/40"
                  style={{ left: '25%', width: '50%' }} />
                <div className="absolute top-0 bottom-0 w-0.5 bg-white" style={{ left: '50%' }} />
                <p className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[10px] text-slate-500">Current Price</p>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-700/50">
            <button
              onClick={() => setShowAddLiquidity(false)}
              className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => setShowAddLiquidity(false)}
              className="px-6 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"
            >
              Add Liquidity
            </button>
          </div>
        </div>
      </Modal>

      {/* ============================================================ */}
      {/* POOL DETAIL DRAWER                                           */}
      {/* ============================================================ */}
      <Drawer
        open={selectedPool !== null}
        onClose={() => setSelectedPool(null)}
        title={selectedPool ? `Pool: ${selectedPool.pair}` : 'Pool Detail'}
        width="max-w-xl"
      >
        {selectedPool && (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <PoolStatusBadge status={selectedPool.status} />
              <span className="text-xs font-mono text-slate-500">{selectedPool.id}</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
                <p className="text-xs text-slate-400">TVL</p>
                <p className="text-lg font-bold text-white">{formatUSD(selectedPool.tvl)}</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
                <p className="text-xs text-slate-400">APY</p>
                <p className="text-lg font-bold text-emerald-400">{selectedPool.apy.toFixed(2)}%</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
                <p className="text-xs text-slate-400">Volume (24h)</p>
                <p className="text-lg font-bold text-white">{formatUSD(selectedPool.volume24h)}</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
                <p className="text-xs text-slate-400">Fees (24h)</p>
                <p className="text-lg font-bold text-white">{formatUSD(selectedPool.fees24h)}</p>
              </div>
            </div>

            <div>
              <p className="text-xs text-slate-400 mb-2">Utilization</p>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <ProgressBar value={selectedPool.utilization} max={100} color="bg-blue-500" />
                </div>
                <span className="text-sm font-semibold text-white tabular-nums">{selectedPool.utilization.toFixed(1)}%</span>
              </div>
            </div>

            <div>
              <p className="text-xs text-slate-400 mb-2">7d Volume</p>
              <p className="text-lg font-bold text-white">{formatUSD(selectedPool.volume7d)}</p>
            </div>

            <div className="p-4 rounded-xl bg-slate-800/30 border border-slate-700/30">
              <p className="text-xs font-medium text-slate-400 mb-3">Pool Health</p>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">Circuit Breaker</span>
                  <span className={`text-xs font-medium ${selectedPool.circuitBreaker ? 'text-red-400' : 'text-emerald-400'}`}>
                    {selectedPool.circuitBreaker ? 'ACTIVE' : 'Standby'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">Min Liquidity</span>
                  <span className="text-xs font-medium text-emerald-400">
                    {formatUSD(selectedPool.minLiquidity)} (met)
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">Status</span>
                  <PoolStatusBadge status={selectedPool.status} />
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors">
                Add Liquidity
              </button>
              <button className="flex-1 py-2 rounded-lg border border-slate-600 text-slate-300 text-sm font-medium hover:border-slate-500 hover:text-white transition-colors">
                Remove Liquidity
              </button>
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}
