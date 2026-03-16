/**
 * NoblePay Payment Channels — Payment Channels Overview
 *
 * Payment channels dashboard featuring active channels with capacity bars,
 * open channel forms, channel analytics, and recent settlements tables.
 *
 * All mock data uses seededRandom for deterministic SSR hydration.
 */

import { useState, useEffect, useMemo } from 'react';
import { SEOHead } from '@/components/SEOHead';
import {
  BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
} from 'recharts';
import {
  Zap, DollarSign, ArrowUpRight, ArrowDownRight,
  Plus, Activity, Clock, CheckCircle,
  ArrowRight, Users, Layers, Send,
  Radio, Timer, Hash, Link2,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { TopNav, Footer, Modal } from '@/components/SharedComponents';
import { seededRandom, seededAddress, truncateAddress } from '@/lib/utils';
import { BRAND } from '@/lib/constants';
import { GlassCard, SectionHeader, Sparkline } from '@/components/PagePrimitives';


// =============================================================================
// CONSTANTS
// =============================================================================

const CHANNEL_STATUS_STYLES: Record<string, string> = {
  Active: 'bg-emerald-500/20 text-emerald-400',
  Pending: 'bg-amber-500/20 text-amber-400',
  Closing: 'bg-red-500/20 text-red-400',
  Settled: 'bg-blue-500/20 text-blue-400',
};


// =============================================================================
// TYPES
// =============================================================================

type ChannelStatus = 'Active' | 'Pending' | 'Closing' | 'Settled';

interface Channel {
  id: string;
  counterparty: string;
  counterpartyName: string;
  capacity: number;
  localBalance: number;
  remoteBalance: number;
  txCount: number;
  status: ChannelStatus;
  openedAt: number;
  lastActivity: number;
}

interface Settlement {
  id: string;
  channelId: string;
  amount: number;
  direction: 'Inbound' | 'Outbound';
  settledAt: number;
  txHash: string;
  fee: number;
}


// =============================================================================
// MOCK DATA GENERATORS
// =============================================================================

const COUNTERPARTY_NAMES = [
  'Meridian Payments', 'Pacific Clearing House', 'Gulf Settlement Network',
  'Nordic Payment Hub', 'Atlas Financial Services', 'Pinnacle Clearing',
  'Sterling Payments Ltd', 'Horizon Networks', 'Crescent Gateway',
  'Vanguard Payment Co.',
];

function generateChannels(count: number): Channel[] {
  const statuses: ChannelStatus[] = ['Active', 'Active', 'Active', 'Pending', 'Closing'];
  const channels: Channel[] = [];
  for (let i = 0; i < count; i++) {
    const seed = 2000 + i * 113;
    const capacity = Math.floor(seededRandom(seed) * 2000000) + 100000;
    const localPct = seededRandom(seed + 10) * 0.8 + 0.1;
    channels.push({
      id: `CH-${String(100 + i).padStart(4, '0')}`,
      counterparty: seededAddress(seed + 20),
      counterpartyName: COUNTERPARTY_NAMES[Math.floor(seededRandom(seed + 30) * COUNTERPARTY_NAMES.length)],
      capacity,
      localBalance: Math.floor(capacity * localPct),
      remoteBalance: Math.floor(capacity * (1 - localPct)),
      txCount: Math.floor(seededRandom(seed + 40) * 5000) + 100,
      status: statuses[Math.floor(seededRandom(seed + 50) * statuses.length)],
      openedAt: Date.now() - Math.floor(seededRandom(seed + 60) * 90 * 86400000),
      lastActivity: Date.now() - Math.floor(seededRandom(seed + 70) * 86400000),
    });
  }
  return channels;
}

function generateSettlements(count: number): Settlement[] {
  const settlements: Settlement[] = [];
  for (let i = 0; i < count; i++) {
    const seed = 3000 + i * 89;
    settlements.push({
      id: `STL-${String(1000 + i).padStart(5, '0')}`,
      channelId: `CH-${String(100 + Math.floor(seededRandom(seed) * 10)).padStart(4, '0')}`,
      amount: Math.floor(seededRandom(seed + 10) * 500000) + 5000,
      direction: seededRandom(seed + 20) > 0.5 ? 'Inbound' : 'Outbound',
      settledAt: Date.now() - Math.floor(seededRandom(seed + 30) * 604800000),
      txHash: `0x${Array.from({ length: 12 }, (_, j) => Math.floor(seededRandom(seed + 40 + j) * 16).toString(16)).join('')}...`,
      fee: Math.floor(seededRandom(seed + 50) * 500) + 10,
    });
  }
  return settlements.sort((a, b) => b.settledAt - a.settledAt);
}

function generateThroughputData(): Array<{ hour: string; throughput: number; settlements: number }> {
  return Array.from({ length: 24 }, (_, i) => ({
    hour: `${String(i).padStart(2, '0')}:00`,
    throughput: Math.floor(seededRandom(4000 + i * 31) * 800000) + 50000,
    settlements: Math.floor(seededRandom(4000 + i * 47) * 50) + 5,
  }));
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


// =============================================================================
// REUSABLE LOCAL COMPONENTS
// =============================================================================

function ChannelStatusBadge({ status }: { status: ChannelStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${CHANNEL_STATUS_STYLES[status] || ''}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

function CapacityBar({ local, remote, capacity }: { local: number; remote: number; capacity: number }) {
  const localPct = (local / capacity) * 100;
  return (
    <div className="space-y-1">
      <div className="w-full h-3 rounded-full bg-slate-700/50 overflow-hidden flex">
        <div className="h-3 bg-emerald-500 transition-all" style={{ width: `${localPct}%` }} />
        <div className="h-3 bg-blue-500 transition-all" style={{ width: `${100 - localPct}%` }} />
      </div>
      <div className="flex justify-between text-xs text-slate-500">
        <span>Local: {formatUSD(local)}</span>
        <span>Remote: {formatUSD(remote)}</span>
      </div>
    </div>
  );
}


// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function PaymentChannelsPage() {
  const { realTime } = useApp();
  const [mounted, setMounted] = useState(false);
  const [showOpenChannel, setShowOpenChannel] = useState(false);
  useEffect(() => setMounted(true), []);

  const channels = useMemo(() => generateChannels(10), []);
  const settlements = useMemo(() => generateSettlements(15), []);
  const throughputData = useMemo(() => generateThroughputData(), []);

  const activeChannels = useMemo(() => channels.filter(c => c.status === 'Active'), [channels]);
  const totalCapacity = useMemo(() => channels.reduce((s, c) => s + c.capacity, 0), [channels]);
  const totalLocalBalance = useMemo(() => channels.reduce((s, c) => s + c.localBalance, 0), [channels]);
  const totalTxCount = useMemo(() => channels.reduce((s, c) => s + c.txCount, 0), [channels]);
  const avgSettlementTime = 4.2; // mock: 4.2 seconds average

  return (
    <>
      <SEOHead
        title="Payment Channels"
        description="NoblePay payment channels overview for high-throughput off-chain payment routing and settlement."
        path="/payment-channels"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/payment-channels" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* HEADER */}
          <div className="mb-8">
            <div className="flex items-start justify-between mb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay Channels</p>
                <h1 className="mt-2 text-3xl font-bold text-white">Payment Channels</h1>
                <p className="mt-1 text-sm text-slate-400">Off-chain payment routing, channel management, and settlement analytics</p>
              </div>
              <button
                onClick={() => setShowOpenChannel(true)}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Open Channel
              </button>
            </div>
          </div>

          {/* KPI CARDS */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Radio className="w-4 h-4 text-slate-400" />
                    <span className="text-xs text-slate-400">Active Channels</span>
                  </div>
                  <p className="text-xl font-bold text-white">{activeChannels.length}</p>
                  <div className="text-xs text-slate-500 mt-1">of {channels.length} total</div>
                </div>
                <Sparkline data={generateSparklineData(100, 12)} color={BRAND.red} height={28} width={64} />
              </div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Layers className="w-4 h-4 text-slate-400" />
                    <span className="text-xs text-slate-400">Total Capacity</span>
                  </div>
                  <p className="text-xl font-bold text-white">{formatUSD(totalCapacity)}</p>
                  <div className="flex items-center gap-1 mt-1 text-xs text-emerald-400">
                    <ArrowUpRight className="w-3 h-3" />+15.3% this week
                  </div>
                </div>
              </div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Zap className="w-4 h-4 text-slate-400" />
                    <span className="text-xs text-slate-400">Total Transactions</span>
                  </div>
                  <p className="text-xl font-bold text-white">{totalTxCount.toLocaleString()}</p>
                  <div className="flex items-center gap-1 mt-1 text-xs text-emerald-400">
                    <ArrowUpRight className="w-3 h-3" />+8.1% today
                  </div>
                </div>
              </div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Timer className="w-4 h-4 text-slate-400" />
                    <span className="text-xs text-slate-400">Avg Settlement Time</span>
                  </div>
                  <p className="text-xl font-bold text-white">{avgSettlementTime}s</p>
                  <div className="flex items-center gap-1 mt-1 text-xs text-emerald-400">
                    <ArrowDownRight className="w-3 h-3" />-0.8s vs last week
                  </div>
                </div>
              </div>
            </GlassCard>
          </div>

          {/* CHANNELS LIST */}
          <GlassCard className="p-0 overflow-hidden mb-8">
            <div className="flex items-center justify-between p-4 border-b border-slate-700/50">
              <SectionHeader title="Active Channels" />
            </div>
            <div className="divide-y divide-slate-800/50">
              {channels.map(ch => (
                <div key={ch.id} className="p-4 hover:bg-slate-800/30 transition-colors">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs text-red-400">{ch.id}</span>
                      <div>
                        <span className="text-sm text-white font-medium">{ch.counterpartyName}</span>
                        <span className="text-xs text-slate-500 font-mono ml-2">{truncateAddress(ch.counterparty, 8, 4)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-slate-400">{ch.txCount.toLocaleString()} txns</span>
                      <ChannelStatusBadge status={ch.status} />
                    </div>
                  </div>
                  <CapacityBar local={ch.localBalance} remote={ch.remoteBalance} capacity={ch.capacity} />
                  <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                    <span>Capacity: {formatUSD(ch.capacity)}</span>
                    <span>Opened: {timeAgo(ch.openedAt)}</span>
                    <span>Last active: {timeAgo(ch.lastActivity)}</span>
                  </div>
                </div>
              ))}
            </div>
          </GlassCard>

          {/* ANALYTICS + SETTLEMENTS */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* THROUGHPUT CHART */}
            <GlassCard className="p-6">
              <SectionHeader title="Channel Throughput (24h)" />
              <div className="mt-4 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={throughputData}>
                    <defs>
                      <linearGradient id="throughputGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#DC2626" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#DC2626" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="hour" tick={{ fill: '#94a3b8', fontSize: 10 }} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} tickFormatter={(v: number) => formatUSD(v)} />
                    <RechartsTooltip
                      contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' }}
                      labelStyle={{ color: '#f8fafc' }}
                      formatter={(value: number) => [formatUSD(value), 'Throughput']}
                    />
                    <Area type="monotone" dataKey="throughput" stroke="#DC2626" fill="url(#throughputGrad)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </GlassCard>

            {/* RECENT SETTLEMENTS */}
            <GlassCard className="p-0 overflow-hidden">
              <div className="p-4 border-b border-slate-700/50">
                <SectionHeader title="Recent Settlements" />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700/50">
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-400">ID</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-400">Channel</th>
                      <th className="text-right px-4 py-2.5 text-xs font-medium text-slate-400">Amount</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-400">Dir</th>
                      <th className="text-right px-4 py-2.5 text-xs font-medium text-slate-400">Fee</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-slate-400">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settlements.slice(0, 10).map(s => (
                      <tr key={s.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                        <td className="px-4 py-2.5 font-mono text-xs text-red-400">{s.id}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-blue-400">{s.channelId}</td>
                        <td className="px-4 py-2.5 text-right text-white font-medium">{formatUSD(s.amount)}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-xs font-medium ${s.direction === 'Inbound' ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {s.direction}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-400 text-xs">${s.fee}</td>
                        <td className="px-4 py-2.5 text-xs text-slate-400">{timeAgo(s.settledAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </GlassCard>
          </div>

        </main>

        <Footer />
      </div>

      {/* OPEN CHANNEL MODAL */}
      <Modal open={showOpenChannel} onClose={() => setShowOpenChannel(false)} title="Open Payment Channel" maxWidth="max-w-lg">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Counterparty Address</label>
            <input
              type="text"
              placeholder="0x..."
              className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500/50 font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Initial Capacity (USD)</label>
            <input
              type="number"
              placeholder="500,000"
              className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500/50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Channel Type</label>
            <select className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-red-500/50">
              <option value="bilateral">Bilateral</option>
              <option value="hub">Hub-Spoke</option>
              <option value="multi">Multi-Party</option>
            </select>
          </div>
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setShowOpenChannel(false)}
              className="flex-1 rounded-lg border border-slate-700/50 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-700/50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => setShowOpenChannel(false)}
              className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 transition-colors"
            >
              Open Channel
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
