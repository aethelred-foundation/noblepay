/**
 * NoblePay Cross-Chain — Cross-Chain Transfer Dashboard
 *
 * Enterprise cross-chain transfer dashboard featuring chain status cards,
 * transfer forms with route optimization, active transfer tracking,
 * relay node health monitoring, and analytics summaries.
 *
 * All mock data uses seededRandom for deterministic SSR hydration.
 */

import { useState, useEffect, useMemo } from 'react';
import { SEOHead } from '@/components/SEOHead';
import {
  ArrowUpRight, ArrowDownRight,
  Plus, Shield, AlertTriangle, Clock, CheckCircle,
  ArrowRight, Activity, Zap, RefreshCw,
  Globe, Radio, Server, Send,
  Loader2, ChevronRight, Cpu,
  ArrowLeftRight, Layers,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { TopNav, Footer, Badge, Modal } from '@/components/SharedComponents';
import { seededRandom, seededAddress, seededHex, formatNumber, truncateAddress } from '@/lib/utils';
import { BRAND } from '@/lib/constants';
import { GlassCard, SectionHeader, Sparkline } from '@/components/PagePrimitives';


// =============================================================================
// CONSTANTS
// =============================================================================

const CHAINS = [
  { id: 'aethelred', name: 'Aethelred L1', color: '#DC2626', icon: '🔺' },
  { id: 'ethereum', name: 'Ethereum', color: '#627EEA', icon: '🔷' },
  { id: 'polygon', name: 'Polygon', color: '#8247E5', icon: '🟣' },
  { id: 'arbitrum', name: 'Arbitrum', color: '#28A0F0', icon: '🔵' },
  { id: 'base', name: 'Base', color: '#0052FF', icon: '🅱' },
] as const;

type ChainId = typeof CHAINS[number]['id'];

const TOKENS = ['USDC', 'USDT', 'AETH', 'WETH', 'DAI'] as const;
type Token = typeof TOKENS[number];

const TRANSFER_STEPS = ['Initiated', 'Relaying', 'Confirming', 'Completed'] as const;
type TransferStep = typeof TRANSFER_STEPS[number];

type TransferStatus = 'In Progress' | 'Completed' | 'Failed';


// =============================================================================
// TYPES
// =============================================================================

interface ChainStatus {
  id: ChainId;
  name: string;
  color: string;
  icon: string;
  active: boolean;
  blockHeight: number;
  avgLatency: number;
}

interface Transfer {
  id: string;
  sourceChain: ChainId;
  destChain: ChainId;
  token: Token;
  amount: number;
  sender: string;
  recipient: string;
  currentStep: TransferStep;
  status: TransferStatus;
  initiatedAt: number;
  estimatedTime: number;
  txHash: string;
}

interface RelayNode {
  address: string;
  name: string;
  stake: number;
  successRate: number;
  totalRelayed: number;
  status: 'Online' | 'Degraded' | 'Offline';
}


// =============================================================================
// MOCK DATA GENERATORS
// =============================================================================

function generateChainStatuses(): ChainStatus[] {
  return CHAINS.map((chain, i) => {
    const seed = 8000 + i * 53;
    return {
      id: chain.id,
      name: chain.name,
      color: chain.color,
      icon: chain.icon,
      active: seededRandom(seed) > 0.1,
      blockHeight: Math.floor(seededRandom(seed + 10) * 5000000) + 15000000,
      avgLatency: Math.floor(seededRandom(seed + 20) * 800) + 120,
    };
  });
}

function generateTransfers(count: number): Transfer[] {
  const chainIds = CHAINS.map(c => c.id);
  const statuses: TransferStatus[] = ['In Progress', 'In Progress', 'Completed', 'Completed', 'Failed'];
  const transfers: Transfer[] = [];
  for (let i = 0; i < count; i++) {
    const seed = 8500 + i * 131;
    const sourceIdx = Math.floor(seededRandom(seed) * chainIds.length);
    let destIdx = Math.floor(seededRandom(seed + 10) * chainIds.length);
    if (destIdx === sourceIdx) destIdx = (destIdx + 1) % chainIds.length;
    const status = statuses[Math.floor(seededRandom(seed + 20) * statuses.length)];
    const stepIdx = status === 'Completed' ? 3
      : status === 'Failed' ? Math.floor(seededRandom(seed + 25) * 3)
      : Math.floor(seededRandom(seed + 25) * 3);
    transfers.push({
      id: `XFR-${String(5000 + i).padStart(5, '0')}`,
      sourceChain: chainIds[sourceIdx],
      destChain: chainIds[destIdx],
      token: TOKENS[Math.floor(seededRandom(seed + 30) * TOKENS.length)],
      amount: i === 0 ? 500 : Math.floor(seededRandom(seed + 40) * 500000) + 1000,
      sender: seededAddress(seed + 50),
      recipient: seededAddress(seed + 60),
      currentStep: TRANSFER_STEPS[stepIdx],
      status,
      initiatedAt: Date.now() - Math.floor(seededRandom(seed + 70) * 259200000),
      estimatedTime: Math.floor(seededRandom(seed + 80) * 300) + 60,
      txHash: `0x${seededHex(seed + 90, 16)}`,
    });
  }
  return transfers;
}

const NODE_NAMES = [
  'Sentinel Alpha', 'Nexus Prime', 'Relay Guardian', 'Bridge Keeper',
  'Arc Validator', 'Meridian Node', 'Horizon Relay', 'Apex Router',
];

function generateRelayNodes(count: number): RelayNode[] {
  const nodes: RelayNode[] = [];
  for (let i = 0; i < count; i++) {
    const seed = 9000 + i * 79;
    const statusRoll = seededRandom(seed + 50);
    nodes.push({
      address: seededAddress(seed),
      name: NODE_NAMES[i % NODE_NAMES.length],
      stake: Math.floor(seededRandom(seed + 10) * 500000) + 50000,
      successRate: 95 + seededRandom(seed + 20) * 5,
      totalRelayed: Math.floor(seededRandom(seed + 30) * 10000) + 500,
      status: statusRoll > 0.2 ? 'Online' : statusRoll > 0.05 ? 'Degraded' : 'Offline',
    });
  }
  return nodes;
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

function chainName(id: ChainId): string {
  return CHAINS.find(c => c.id === id)?.name || id;
}

function chainIcon(id: ChainId): string {
  return CHAINS.find(c => c.id === id)?.icon || '';
}


// =============================================================================
// REUSABLE LOCAL COMPONENTS
// =============================================================================

function TransferStatusBadge({ status }: { status: TransferStatus }) {
  const styles: Record<TransferStatus, string> = {
    'In Progress': 'bg-blue-500/20 text-blue-400',
    Completed: 'bg-emerald-500/20 text-emerald-400',
    Failed: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
      {status === 'In Progress' && <Loader2 className="w-3 h-3 animate-spin" />}
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

function NodeStatusBadge({ status }: { status: RelayNode['status'] }) {
  const styles: Record<string, string> = {
    Online: 'bg-emerald-500/20 text-emerald-400',
    Degraded: 'bg-amber-500/20 text-amber-400',
    Offline: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || ''}`}>
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${status !== 'Online' ? 'animate-pulse' : ''}`} />
      {status}
    </span>
  );
}

function StepProgress({ currentStep, status }: { currentStep: TransferStep; status: TransferStatus }) {
  const currentIdx = TRANSFER_STEPS.indexOf(currentStep);
  return (
    <div className="flex items-center gap-1">
      {TRANSFER_STEPS.map((step, i) => {
        const isComplete = i < currentIdx || (i === currentIdx && status === 'Completed');
        const isCurrent = i === currentIdx && status !== 'Completed';
        const isFailed = i === currentIdx && status === 'Failed';
        return (
          <div key={step} className="flex items-center gap-1">
            <div
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                isFailed ? 'bg-red-500/30 text-red-400 ring-1 ring-red-500/50'
                : isComplete ? 'bg-emerald-500/30 text-emerald-400'
                : isCurrent ? 'bg-blue-500/30 text-blue-400 ring-1 ring-blue-500/50'
                : 'bg-slate-700/50 text-slate-500'
              }`}
            >
              {isComplete ? <CheckCircle className="w-3 h-3" /> : isCurrent ? <Loader2 className="w-3 h-3 animate-spin" /> : i + 1}
            </div>
            {i < TRANSFER_STEPS.length - 1 && (
              <div className={`w-4 h-0.5 ${i < currentIdx ? 'bg-emerald-500/50' : 'bg-slate-700/50'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}


// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function CrossChainPage() {
  const { realTime } = useApp();
  const [mounted, setMounted] = useState(false);
  const [showTransferForm, setShowTransferForm] = useState(false);
  const [sourceChain, setSourceChain] = useState<ChainId>('aethelred');
  const [destChain, setDestChain] = useState<ChainId>('ethereum');
  const [transferToken, setTransferToken] = useState<Token>('USDC');
  const [transferAmount, setTransferAmount] = useState('');
  useEffect(() => setMounted(true), []);

  const chainStatuses = useMemo(() => generateChainStatuses(), []);
  const transfers = useMemo(() => generateTransfers(10), []);
  const relayNodes = useMemo(() => generateRelayNodes(8), []);

  const activeTransfers = useMemo(() => transfers.filter(t => t.status === 'In Progress'), [transfers]);
  const completedTransfers = useMemo(() => transfers.filter(t => t.status === 'Completed'), [transfers]);
  const totalVolume = useMemo(() => transfers.reduce((s, t) => s + t.amount, 0), [transfers]);
  const avgSettlement = useMemo(() => {
    const completed = transfers.filter(t => t.status === 'Completed');
    if (completed.length === 0) return 0;
    return completed.reduce((s, t) => s + t.estimatedTime, 0) / completed.length;
  }, [transfers]);
  const activeRelays = useMemo(() => relayNodes.filter(n => n.status === 'Online').length, [relayNodes]);

  return (
    <>
      <SEOHead
        title="Cross-Chain Transfers"
        description="NoblePay cross-chain transfer dashboard for enterprise multi-chain asset bridging and relay monitoring."
        path="/cross-chain"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/cross-chain" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* HEADER */}
          <div className="mb-8">
            <div className="flex items-start justify-between mb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay Bridge</p>
                <h1 className="mt-2 text-3xl font-bold text-white">Cross-Chain Transfers</h1>
                <p className="mt-1 text-sm text-slate-400">Multi-chain asset bridging, relay monitoring, and route optimization</p>
              </div>
              <button
                onClick={() => setShowTransferForm(true)}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 transition-colors"
              >
                <Plus className="w-4 h-4" />
                New Transfer
              </button>
            </div>
          </div>

          {/* CHAIN STATUS CARDS */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
            {chainStatuses.map(chain => (
              <GlassCard key={chain.id} className="p-4" hover>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-lg">{chain.icon}</span>
                  <span className="text-sm font-semibold text-white">{chain.name}</span>
                </div>
                <div className="flex items-center gap-1.5 mb-3">
                  <span className={`w-2 h-2 rounded-full ${chain.active ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'}`} />
                  <span className={`text-xs font-medium ${chain.active ? 'text-emerald-400' : 'text-red-400'}`}>
                    {chain.active ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Block Height</span>
                    <span className="text-white font-mono">{chain.blockHeight.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">Avg Latency</span>
                    <span className={`font-medium ${chain.avgLatency < 300 ? 'text-emerald-400' : chain.avgLatency < 600 ? 'text-amber-400' : 'text-red-400'}`}>
                      {chain.avgLatency}ms
                    </span>
                  </div>
                </div>
              </GlassCard>
            ))}
          </div>

          {/* ANALYTICS SUMMARY */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Send className="w-4 h-4 text-slate-400" />
                    <span className="text-xs text-slate-400">Total Transfers</span>
                  </div>
                  <p className="text-xl font-bold text-white">{transfers.length}</p>
                  <div className="flex items-center gap-1 mt-1 text-xs text-emerald-400">
                    <ArrowUpRight className="w-3 h-3" />+18.3% this week
                  </div>
                </div>
                <Sparkline data={generateSparklineData(300, 12)} color={BRAND.red} height={28} width={64} />
              </div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Layers className="w-4 h-4 text-slate-400" />
                    <span className="text-xs text-slate-400">Total Volume</span>
                  </div>
                  <p className="text-xl font-bold text-white">{formatUSD(totalVolume)}</p>
                  <div className="flex items-center gap-1 mt-1 text-xs text-emerald-400">
                    <ArrowUpRight className="w-3 h-3" />+24.1% this week
                  </div>
                </div>
                <Sparkline data={generateSparklineData(400, 12)} color="#10B981" height={28} width={64} />
              </div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <Clock className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-400">Avg Settlement</span>
              </div>
              <p className="text-xl font-bold text-white">{avgSettlement.toFixed(0)}s</p>
              <div className="flex items-center gap-1 mt-1 text-xs text-emerald-400">
                <ArrowDownRight className="w-3 h-3" />-12% faster
              </div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <Radio className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-400">Active Relays</span>
              </div>
              <p className="text-xl font-bold text-white">{activeRelays}/{relayNodes.length}</p>
              <div className="text-xs text-slate-500 mt-1">{((activeRelays / relayNodes.length) * 100).toFixed(0)}% online</div>
            </GlassCard>
            <GlassCard className="p-4" hover={false}>
              <div className="flex items-center gap-2 mb-1">
                <Activity className="w-4 h-4 text-slate-400" />
                <span className="text-xs text-slate-400">In Progress</span>
              </div>
              <p className="text-xl font-bold text-amber-400">{activeTransfers.length}</p>
              <div className="text-xs text-slate-500 mt-1">{completedTransfers.length} completed today</div>
            </GlassCard>
          </div>

          {/* ACTIVE TRANSFERS TRACKER */}
          <GlassCard className="p-0 overflow-hidden mb-8">
            <div className="flex items-center justify-between p-4 border-b border-slate-700/50">
              <SectionHeader title="Active Transfers" />
              <span className="text-xs text-slate-400">{activeTransfers.length} in progress</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Transfer ID</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Route</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Token</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-400">Amount</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Progress</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Initiated</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.map(t => (
                    <tr key={t.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs text-red-400">{t.id}</span>
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5">{truncateAddress(t.txHash, 10, 6)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="text-white">{chainIcon(t.sourceChain)} {chainName(t.sourceChain)}</span>
                          <ArrowRight className="w-3 h-3 text-slate-500" />
                          <span className="text-white">{chainIcon(t.destChain)} {chainName(t.destChain)}</span>
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                          {truncateAddress(t.sender, 6, 4)} → {truncateAddress(t.recipient, 6, 4)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-700/50 text-slate-300">{t.token}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-white font-medium">{formatUSD(t.amount)}</td>
                      <td className="px-4 py-3">
                        <StepProgress currentStep={t.currentStep} status={t.status} />
                        <div className="text-[10px] text-slate-500 mt-1">{t.currentStep}</div>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">{timeAgo(t.initiatedAt)}</td>
                      <td className="px-4 py-3"><TransferStatusBadge status={t.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassCard>

          {/* RELAY NODE HEALTH TABLE */}
          <GlassCard className="p-0 overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-slate-700/50">
              <SectionHeader title="Relay Node Health" />
              <span className="text-xs text-slate-400">{activeRelays} of {relayNodes.length} online</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Node</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Address</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-400">Stake</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-400">Success Rate</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-400">Total Relayed</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-400">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {relayNodes.map(node => (
                    <tr key={node.address} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Cpu className="w-4 h-4 text-slate-500" />
                          <span className="text-sm text-white font-medium">{node.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-400">{truncateAddress(node.address, 8, 4)}</td>
                      <td className="px-4 py-3 text-right text-white font-medium">{formatUSD(node.stake)}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={`font-medium ${node.successRate >= 99 ? 'text-emerald-400' : node.successRate >= 97 ? 'text-amber-400' : 'text-red-400'}`}>
                          {node.successRate.toFixed(2)}%
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-300">{node.totalRelayed.toLocaleString()}</td>
                      <td className="px-4 py-3"><NodeStatusBadge status={node.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </GlassCard>

        </main>

        <Footer />
      </div>

      {/* TRANSFER FORM MODAL */}
      <Modal open={showTransferForm} onClose={() => setShowTransferForm(false)} title="New Cross-Chain Transfer" maxWidth="max-w-lg">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Source Chain</label>
            <select
              value={sourceChain}
              onChange={e => setSourceChain(e.target.value as ChainId)}
              className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-red-500/50"
            >
              {CHAINS.map(c => (
                <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Destination Chain</label>
            <select
              value={destChain}
              onChange={e => setDestChain(e.target.value as ChainId)}
              className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-red-500/50"
            >
              {CHAINS.filter(c => c.id !== sourceChain).map(c => (
                <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Token</label>
              <select
                value={transferToken}
                onChange={e => setTransferToken(e.target.value as Token)}
                className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-red-500/50"
              >
                {TOKENS.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Amount</label>
              <input
                type="number"
                value={transferAmount}
                onChange={e => setTransferAmount(e.target.value)}
                placeholder="100,000"
                className="w-full rounded-lg bg-slate-800/50 border border-slate-700/50 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-red-500/50"
              />
            </div>
          </div>

          {/* Route Optimization Preview */}
          <div className="rounded-lg bg-slate-800/30 border border-slate-700/30 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-xs font-medium text-slate-300">Optimized Route</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="text-white font-medium">{chainIcon(sourceChain)} {chainName(sourceChain)}</span>
              <ChevronRight className="w-3 h-3" />
              <span className="text-amber-400 font-medium">Relay Pool</span>
              <ChevronRight className="w-3 h-3" />
              <span className="text-white font-medium">{chainIcon(destChain)} {chainName(destChain)}</span>
            </div>
            <div className="flex justify-between text-xs text-slate-500 mt-2">
              <span>Est. time: ~120s</span>
              <span>Fee: 0.05%</span>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              onClick={() => setShowTransferForm(false)}
              className="flex-1 rounded-lg border border-slate-700/50 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-700/50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => setShowTransferForm(false)}
              className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 transition-colors"
            >
              Initiate Transfer
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
