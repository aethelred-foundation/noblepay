/**
 * NoblePay FX Hedging — Foreign Exchange Hedging Dashboard
 *
 * Comprehensive FX hedging console featuring live rate tickers,
 * open hedge positions, hedge creation forms, exposure heatmaps,
 * and portfolio VaR calculations.
 *
 * All mock data uses seededRandom for deterministic SSR hydration.
 */

import { useState, useEffect, useMemo } from 'react';
import { SEOHead } from '@/components/SEOHead';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  Legend, Area, AreaChart,
} from 'recharts';
import {
  DollarSign, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight,
  Plus, Shield, AlertTriangle, Activity, Gauge,
  ArrowLeftRight, Globe, BarChart3, Clock,
  Layers, Target, Zap, RefreshCw,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { TopNav, Footer, Badge, Modal } from '@/components/SharedComponents';
import { seededRandom, formatNumber } from '@/lib/utils';
import { BRAND } from '@/lib/constants';
import { GlassCard, SectionHeader, Sparkline } from '@/components/PagePrimitives';


// =============================================================================
// CONSTANTS
// =============================================================================

const CHART_COLORS = [
  '#DC2626', '#0EA5E9', '#10B981', '#F59E0B', '#8B5CF6',
  '#EC4899', '#06B6D4', '#F87171',
];

const CURRENCY_PAIRS = [
  { pair: 'AED/USD', base: 'AED', quote: 'USD', flag: '🇦🇪' },
  { pair: 'EUR/USD', base: 'EUR', quote: 'USD', flag: '🇪🇺' },
  { pair: 'GBP/USD', base: 'GBP', quote: 'USD', flag: '🇬🇧' },
  { pair: 'USD/JPY', base: 'USD', quote: 'JPY', flag: '🇯🇵' },
  { pair: 'USD/SGD', base: 'USD', quote: 'SGD', flag: '🇸🇬' },
  { pair: 'USD/CHF', base: 'USD', quote: 'CHF', flag: '🇨🇭' },
];

const BASE_RATES: Record<string, number> = {
  'AED/USD': 0.2723,
  'EUR/USD': 1.0842,
  'GBP/USD': 1.2651,
  'USD/JPY': 149.82,
  'USD/SGD': 1.3412,
  'USD/CHF': 0.8821,
};


// =============================================================================
// TYPES
// =============================================================================

type HedgeType = 'Forward' | 'Option' | 'Swap';
type HedgeStatus = 'Active' | 'Matured' | 'Expired' | 'Closed';

interface FXRate {
  pair: string;
  rate: number;
  change: number;
  changePercent: number;
  high24h: number;
  low24h: number;
  flag: string;
}

interface Hedge {
  id: string;
  pair: string;
  type: HedgeType;
  direction: 'Buy' | 'Sell';
  notional: number;
  strikeRate: number;
  currentRate: number;
  pnl: number;
  maturityDate: number;
  status: HedgeStatus;
}

interface ExposureItem {
  currency: string;
  exposure: number;
  hedged: number;
  unhedged: number;
  color: string;
}


// =============================================================================
// MOCK DATA GENERATORS
// =============================================================================

function generateFXRates(): FXRate[] {
  return CURRENCY_PAIRS.map((cp, i) => {
    const seed = 5000 + i * 73;
    const baseRate = BASE_RATES[cp.pair];
    const change = (seededRandom(seed) - 0.5) * baseRate * 0.02;
    return {
      pair: cp.pair,
      rate: baseRate + (seededRandom(seed + 10) - 0.5) * baseRate * 0.005,
      change,
      changePercent: (change / baseRate) * 100,
      high24h: baseRate * (1 + seededRandom(seed + 20) * 0.01),
      low24h: baseRate * (1 - seededRandom(seed + 30) * 0.01),
      flag: cp.flag,
    };
  });
}

function generateHedges(count: number): Hedge[] {
  const types: HedgeType[] = ['Forward', 'Option', 'Swap'];
  const statuses: HedgeStatus[] = ['Active', 'Active', 'Active', 'Matured', 'Closed'];
  const pairs = CURRENCY_PAIRS.map(cp => cp.pair);
  const hedges: Hedge[] = [];
  for (let i = 0; i < count; i++) {
    const seed = 6000 + i * 97;
    const pair = pairs[Math.floor(seededRandom(seed) * pairs.length)];
    const baseRate = BASE_RATES[pair];
    const strikeRate = baseRate * (1 + (seededRandom(seed + 10) - 0.5) * 0.04);
    const currentRate = baseRate * (1 + (seededRandom(seed + 20) - 0.5) * 0.005);
    const notional = Math.floor(seededRandom(seed + 30) * 5000000) + 500000;
    const direction = seededRandom(seed + 40) > 0.5 ? 'Buy' as const : 'Sell' as const;
    const pnlMultiplier = direction === 'Buy' ? (currentRate - strikeRate) : (strikeRate - currentRate);
    hedges.push({
      id: `HDG-${String(1000 + i).padStart(5, '0')}`,
      pair,
      type: types[Math.floor(seededRandom(seed + 50) * types.length)],
      direction,
      notional,
      strikeRate,
      currentRate,
      pnl: pnlMultiplier * notional * 0.01,
      maturityDate: Date.now() + Math.floor(seededRandom(seed + 60) * 180 * 86400000),
      status: statuses[Math.floor(seededRandom(seed + 70) * statuses.length)],
    });
  }
  return hedges;
}

function generateExposureData(): ExposureItem[] {
  return [
    { currency: 'USD', exposure: 12500000, hedged: 9800000, unhedged: 2700000, color: '#22C55E' },
    { currency: 'EUR', exposure: 8200000, hedged: 6100000, unhedged: 2100000, color: '#3B82F6' },
    { currency: 'GBP', exposure: 5400000, hedged: 4200000, unhedged: 1200000, color: '#8B5CF6' },
    { currency: 'AED', exposure: 4800000, hedged: 4500000, unhedged: 300000, color: '#DC2626' },
    { currency: 'JPY', exposure: 3200000, hedged: 1800000, unhedged: 1400000, color: '#F59E0B' },
    { currency: 'SGD', exposure: 2100000, hedged: 1500000, unhedged: 600000, color: '#06B6D4' },
  ];
}

function generateRateHistory(pair: string): Array<{ time: string; rate: number }> {
  const base = BASE_RATES[pair] || 1;
  const points: Array<{ time: string; rate: number }> = [];
  for (let i = 0; i < 24; i++) {
    points.push({
      time: `${String(i).padStart(2, '0')}:00`,
      rate: base * (1 + (seededRandom(7000 + i * 41) - 0.5) * 0.008),
    });
  }
  return points;
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

function formatPnL(n: number): string {
  const prefix = n >= 0 ? '+' : '';
  return `${prefix}${formatUSD(Math.abs(n))}`;
}

function daysUntil(timestamp: number): string {
  const diff = Math.floor((timestamp - Date.now()) / 86400000);
  if (diff <= 0) return 'Expired';
  return `${diff}d`;
}


// =============================================================================
// REUSABLE LOCAL COMPONENTS
// =============================================================================

function HedgeStatusBadge({ status }: { status: HedgeStatus }) {
  const styles: Record<HedgeStatus, string> = {
    Active: 'bg-emerald-500/20 text-emerald-400',
    Matured: 'bg-blue-500/20 text-blue-400',
    Expired: 'bg-red-500/20 text-red-400',
    Closed: 'bg-slate-500/20 text-slate-400',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

function HedgeTypeBadge({ type }: { type: HedgeType }) {
  const styles: Record<HedgeType, string> = {
    Forward: 'bg-blue-500/20 text-blue-400',
    Option: 'bg-purple-500/20 text-purple-400',
    Swap: 'bg-cyan-500/20 text-cyan-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${styles[type]}`}>{type}</span>
  );
}

function ExposureBar({ item }: { item: ExposureItem }) {
  const hedgedPct = (item.hedged / item.exposure) * 100;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-white font-medium">{item.currency}</span>
        <span className="text-slate-400">{formatUSD(item.exposure)}</span>
      </div>
      <div className="w-full h-3 rounded-full bg-slate-700/50 overflow-hidden">
        <div
          className="h-3 rounded-full transition-all duration-500"
          style={{ width: `${hedgedPct}%`, backgroundColor: item.color }}
        />
      </div>
      <div className="flex justify-between text-xs text-slate-500">
        <span>{hedgedPct.toFixed(0)}% hedged</span>
        <span>{formatUSD(item.unhedged)} unhedged</span>
      </div>
    </div>
  );
}


// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function FXHedgingPage() {
  const { realTime } = useApp();
  const [mounted, setMounted] = useState(false);
  const [showCreateHedge, setShowCreateHedge] = useState(false);
  const [selectedPair, setSelectedPair] = useState('AED/USD');
  const [hedgeType, setHedgeType] = useState<HedgeType>('Forward');
  useEffect(() => setMounted(true), []);

  const fxRates = useMemo(() => generateFXRates(), []);
  const hedges = useMemo(() => generateHedges(12), []);
  const exposureData = useMemo(() => generateExposureData(), []);
  const rateHistory = useMemo(() => generateRateHistory(selectedPair), [selectedPair]);

  const activeHedges = useMemo(() => hedges.filter(h => h.status === 'Active'), [hedges]);
  const totalNotional = useMemo(() => activeHedges.reduce((s, h) => s + h.notional, 0), [activeHedges]);
  const totalPnL = useMemo(() => activeHedges.reduce((s, h) => s + h.pnl, 0), [activeHedges]);
  const totalExposure = useMemo(() => exposureData.reduce((s, e) => s + e.exposure, 0), [exposureData]);
  const totalHedged = useMemo(() => exposureData.reduce((s, e) => s + e.hedged, 0), [exposureData]);

  // Mock VaR calculation
  const portfolioVaR = 342000;
  const varPct = (portfolioVaR / totalNotional) * 100;

  return (
    <>
      <SEOHead
        title="FX Hedging"
        description="NoblePay FX hedging dashboard for enterprise currency risk management and exposure monitoring."
        path="/fx-hedging"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/fx-hedging" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* HEADER */}
          <div className="mb-8">
            <div className="flex items-start justify-between mb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay FX</p>
                <h1 className="mt-2 text-3xl font-bold text-white">FX Hedging</h1>
                <p className="mt-1 text-sm text-slate-400">Currency risk management, hedging positions, and exposure monitoring</p>
              </div>
              <button
                onClick={() => setShowCreateHedge(true)}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Create Hedge
              </button>
            </div>
          </div>

          {/* LIVE FX RATE TICKER */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
            {fxRates.map(rate => (
              <GlassCard
                key={rate.pair}
                className={`p-3 cursor-pointer transition-all ${selectedPair === rate.pair ? 'ring-1 ring-red-500/50' : ''}`}
                hover
                onClick={() => setSelectedPair(rate.pair)}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-base">{rate.flag}</span>
                  <span className="text-xs font-medium text-slate-400">{rate.pair}</span>
                </div>
                <p className="text-lg font-bold text-white">{rate.rate.toFixed(4)}</p>
                <div className={`flex items-center gap-1 text-xs ${rate.change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {rate.change >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                  {rate.changePercent >= 0 ? '+' : ''}{rate.changePercent.toFixed(3)}%
                </div>
              </GlassCard>
            ))}
          </div>

          {/* KPI CARDS */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <Layers className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-400">Total Notional</span>
              </div>
              <p className="text-xl font-bold text-white">{formatUSD(totalNotional)}</p>
              <div className="text-xs text-slate-500 mt-1">{activeHedges.length} active hedges</div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-400">Portfolio P&L</span>
              </div>
              <p className={`text-xl font-bold ${totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{formatPnL(totalPnL)}</p>
              <div className="flex items-center gap-1 mt-1 text-xs text-emerald-400">
                <ArrowUpRight className="w-3 h-3" />+3.2% MTD
              </div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <Shield className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-400">Hedge Ratio</span>
              </div>
              <p className="text-xl font-bold text-white">{((totalHedged / totalExposure) * 100).toFixed(1)}%</p>
              <div className="w-full h-1.5 rounded-full bg-slate-700/50 overflow-hidden mt-2">
                <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${(totalHedged / totalExposure) * 100}%` }} />
              </div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-400">Portfolio VaR (95%)</span>
              </div>
              <p className="text-xl font-bold text-amber-400">{formatUSD(portfolioVaR)}</p>
              <div className="text-xs text-slate-500 mt-1">{varPct.toFixed(2)}% of notional</div>
            </GlassCard>
          </div>

          {/* RATE CHART + EXPOSURE */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            <div className="lg:col-span-2">
              <GlassCard className="p-6">
                <SectionHeader title={`${selectedPair} — 24h Rate`} />
                <div className="mt-4 h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={rateHistory}>
                      <defs>
                        <linearGradient id="rateGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#DC2626" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#DC2626" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                      <XAxis dataKey="time" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                      <YAxis domain={['auto', 'auto']} tick={{ fill: '#94a3b8', fontSize: 10 }} />
                      <RechartsTooltip
                        contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                        labelStyle={{ color: '#f8fafc' }}
                      />
                      <Area type="monotone" dataKey="rate" stroke="#DC2626" fill="url(#rateGradient)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </GlassCard>
            </div>

            <GlassCard className="p-6">
              <SectionHeader title="Exposure by Currency" />
              <div className="mt-4 space-y-4">
                {exposureData.map(item => (
                  <ExposureBar key={item.currency} item={item} />
                ))}
              </div>
            </GlassCard>
          </div>

          {/* OPEN HEDGES TABLE */}
          <GlassCard className="p-0 overflow-hidden mb-8">
            <div className="flex items-center justify-between p-4 border-b border-slate-700/50">
              <SectionHeader title="Open Hedges" />
              <span className="text-xs text-slate-400">{activeHedges.length} active positions</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">ID</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Pair</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Type</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Dir</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-400">Notional</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-400">Strike</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-400">Current</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-400">P&L</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Maturity</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {hedges.map(h => (
                    <tr key={h.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-red-400">{h.id}</td>
                      <td className="px-4 py-3 text-white font-medium">{h.pair}</td>
                      <td className="px-4 py-3"><HedgeTypeBadge type={h.type} /></td>
                      <td className="px-4 py-3">
                        <span className={h.direction === 'Buy' ? 'text-emerald-400' : 'text-red-400'}>
                          {h.direction}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-white">{formatUSD(h.notional)}</td>
                      <td className="px-4 py-3 text-right text-slate-300">{h.strikeRate.toFixed(4)}</td>
                      <td className="px-4 py-3 text-right text-slate-300">{h.currentRate.toFixed(4)}</td>
                      <td className={`px-4 py-3 text-right font-medium ${h.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {formatPnL(h.pnl)}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">{daysUntil(h.maturityDate)}</td>
                      <td className="px-4 py-3"><HedgeStatusBadge status={h.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassCard>

        </main>

        <Footer />
      </div>

      {/* CREATE HEDGE MODAL */}
      <Modal open={showCreateHedge} onClose={() => setShowCreateHedge(false)} title="Create Hedge Position" maxWidth="max-w-lg">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Hedge Type</label>
            <div className="flex gap-2">
              {(['Forward', 'Option', 'Swap'] as HedgeType[]).map(t => (
                <button
                  key={t}
                  onClick={() => setHedgeType(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    hedgeType === t
                      ? 'bg-red-600/20 text-red-400 border border-red-500/30'
                      : 'bg-slate-800/50 text-slate-400 border border-slate-700/50 hover:text-white'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Currency Pair</label>
            <select className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-red-500/50">
              {CURRENCY_PAIRS.map(cp => (
                <option key={cp.pair} value={cp.pair}>{cp.pair}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Notional Amount</label>
              <input
                type="number"
                placeholder="1,000,000"
                className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500/50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Maturity Date</label>
              <input
                type="date"
                className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-red-500/50"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Direction</label>
            <div className="flex gap-2">
              <button className="flex-1 px-3 py-2 rounded-lg bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 text-sm font-medium">Buy</button>
              <button className="flex-1 px-3 py-2 rounded-lg bg-slate-800/50 text-slate-400 border border-slate-700/50 text-sm font-medium hover:text-white">Sell</button>
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setShowCreateHedge(false)}
              className="flex-1 rounded-lg border border-slate-700/50 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-700/50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => setShowCreateHedge(false)}
              className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 transition-colors"
            >
              Place Hedge
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
