/**
 * NoblePay Treasury — Treasury Management Console
 *
 * Comprehensive treasury management dashboard for institutional users
 * featuring multi-sig proposals, budget tracking, yield strategies,
 * spending policies, and treasury activity monitoring.
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
  Vault, DollarSign, TrendingUp, Users, Clock, CheckCircle,
  ArrowUpRight, ArrowDownRight, Plus, Shield, AlertCircle,
  Lock, Building2, Timer, FileText, RefreshCw, Settings,
  ChevronRight, Eye, PieChart as PieChartIcon, BarChart3,
  Wallet, ArrowRight, XCircle, Pause, Play, Send,
  Banknote, Landmark, Target, Layers, Activity, Zap,
  Calendar, Hash, ChevronDown, X,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { TopNav, Footer, Badge, Modal, Tabs } from '@/components/SharedComponents';
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

const CURRENCY_COLORS: Record<string, string> = {
  USDC: '#2775CA',
  USDT: '#26A17B',
  AET: '#DC2626',
  AED: '#009B3A',
  USD: '#22C55E',
};

const PROPOSAL_STATUS_STYLES: Record<string, string> = {
  Pending: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  Approved: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  Executed: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  Rejected: 'bg-red-500/20 text-red-400 border-red-500/30',
};

const PROPOSAL_STATUS_DOT: Record<string, string> = {
  Pending: 'bg-amber-400',
  Approved: 'bg-emerald-400',
  Executed: 'bg-blue-400',
  Rejected: 'bg-red-400',
};


// =============================================================================
// TYPES
// =============================================================================

type ProposalStatus = 'Pending' | 'Approved' | 'Executed' | 'Rejected';
type ProposalType = 'Transfer' | 'Budget Allocation' | 'Yield Strategy' | 'Policy Change';

interface Signer {
  address: string;
  name: string;
  signed: boolean;
  signedAt?: number;
}

interface Proposal {
  id: string;
  title: string;
  type: ProposalType;
  status: ProposalStatus;
  amount: number;
  currency: string;
  description: string;
  createdAt: number;
  expiresAt: number;
  signers: Signer[];
  requiredSignatures: number;
  creator: string;
  creatorName: string;
}

interface BudgetItem {
  department: string;
  allocated: number;
  spent: number;
  remaining: number;
  color: string;
}

interface YieldStrategy {
  protocol: string;
  allocation: number;
  apy: number;
  tvl: number;
  currency: string;
  risk: 'Low' | 'Medium' | 'High';
  status: 'Active' | 'Paused';
}

interface TimeLocked {
  id: string;
  description: string;
  amount: number;
  currency: string;
  unlockAt: number;
  status: 'Locked' | 'Unlocking' | 'Ready';
}

interface ActivityItem {
  id: string;
  action: string;
  actor: string;
  actorName: string;
  description: string;
  timestamp: number;
  type: 'transfer' | 'approval' | 'policy' | 'yield' | 'budget';
}

interface SpendingPolicy {
  name: string;
  dailyLimit: number;
  weeklyLimit: number;
  monthlyLimit: number;
  dailyUsed: number;
  weeklyUsed: number;
  monthlyUsed: number;
}


// =============================================================================
// MOCK DATA GENERATORS
// =============================================================================

const SIGNER_NAMES = [
  'Alice Chen', 'Bob Martinez', 'Carol Johnson', 'David Kim',
  'Elena Petrov', 'Faisal Al-Rashid', 'Grace Nakamura',
];

const DEPARTMENT_NAMES = [
  'Engineering', 'Marketing', 'Operations', 'Legal & Compliance',
  'Business Development', 'Research', 'Human Resources', 'Infrastructure',
];

const PROTOCOL_NAMES = [
  'Aave V3', 'Compound Finance', 'MakerDAO', 'Yearn Finance',
  'Convex Finance', 'Lido Staking', 'Rocket Pool', 'Frax Finance',
];

const ACTIVITY_ACTIONS = [
  'Proposal Created', 'Proposal Approved', 'Transfer Executed',
  'Budget Updated', 'Yield Harvested', 'Policy Changed',
  'Signer Added', 'Threshold Modified', 'Emergency Pause',
  'Funds Deposited', 'Allocation Rebalanced',
];

function generateSigners(seed: number, count: number, signedCount: number): Signer[] {
  const signers: Signer[] = [];
  for (let i = 0; i < count; i++) {
    const signed = i < signedCount;
    signers.push({
      address: seededAddress(seed + i * 100),
      name: SIGNER_NAMES[Math.floor(seededRandom(seed + i * 31) * SIGNER_NAMES.length)],
      signed,
      signedAt: signed ? Date.now() - Math.floor(seededRandom(seed + i * 41) * 86400000) : undefined,
    });
  }
  return signers;
}

function generateProposals(count: number): Proposal[] {
  const proposals: Proposal[] = [];
  const types: ProposalType[] = ['Transfer', 'Budget Allocation', 'Yield Strategy', 'Policy Change'];
  const statuses: ProposalStatus[] = ['Pending', 'Approved', 'Executed', 'Rejected'];
  const currencies = ['USDC', 'USDT', 'AET', 'AED'];
  const titles = [
    'Q1 Marketing Budget Allocation', 'Cross-border Settlement to Dubai',
    'Yield Strategy: Aave V3 USDC', 'Infrastructure Upgrade Fund',
    'Partnership Payment — TechCorp', 'Emergency Reserve Transfer',
    'Monthly Payroll Disbursement', 'R&D Innovation Fund',
    'Regulatory Compliance Reserve', 'Liquidity Pool Rebalance',
    'Vendor Payment — CloudInfra Ltd', 'Conference Sponsorship Fund',
  ];

  for (let i = 0; i < count; i++) {
    const seed = 5000 + i * 137;
    const signerCount = 3 + Math.floor(seededRandom(seed + 10) * 4);
    const statusIdx = Math.floor(seededRandom(seed + 20) * statuses.length);
    const status = statuses[statusIdx];
    const signedCount = status === 'Executed' ? signerCount
      : status === 'Approved' ? signerCount - 1
      : status === 'Rejected' ? Math.floor(signerCount / 2)
      : Math.floor(seededRandom(seed + 30) * (signerCount - 1));

    proposals.push({
      id: `PROP-${String(1000 + i).padStart(4, '0')}`,
      title: titles[i % titles.length],
      type: types[Math.floor(seededRandom(seed + 40) * types.length)],
      status,
      amount: Math.floor(seededRandom(seed + 50) * 2000000) + 10000,
      currency: currencies[Math.floor(seededRandom(seed + 60) * currencies.length)],
      description: `Multi-sig proposal for ${titles[i % titles.length].toLowerCase()} requiring ${signerCount} signatures.`,
      createdAt: Date.now() - Math.floor(seededRandom(seed + 70) * 604800000),
      expiresAt: Date.now() + Math.floor(seededRandom(seed + 80) * 604800000),
      signers: generateSigners(seed + 90, signerCount, signedCount),
      requiredSignatures: signerCount,
      creator: seededAddress(seed + 200),
      creatorName: SIGNER_NAMES[Math.floor(seededRandom(seed + 210) * SIGNER_NAMES.length)],
    });
  }
  return proposals;
}

function generateBudgets(): BudgetItem[] {
  return DEPARTMENT_NAMES.map((dept, i) => {
    const seed = 6000 + i * 47;
    const allocated = Math.floor(seededRandom(seed) * 800000) + 100000;
    const spent = Math.floor(allocated * (seededRandom(seed + 10) * 0.85 + 0.1));
    return {
      department: dept,
      allocated,
      spent,
      remaining: allocated - spent,
      color: CHART_COLORS[i % CHART_COLORS.length],
    };
  });
}

function generateYieldStrategies(): YieldStrategy[] {
  const risks: Array<'Low' | 'Medium' | 'High'> = ['Low', 'Medium', 'High'];
  return PROTOCOL_NAMES.map((protocol, i) => {
    const seed = 7000 + i * 53;
    return {
      protocol,
      allocation: Math.floor(seededRandom(seed) * 5000000) + 500000,
      apy: seededRandom(seed + 10) * 12 + 1.5,
      tvl: Math.floor(seededRandom(seed + 20) * 500000000) + 10000000,
      currency: ['USDC', 'USDT', 'AET', 'AED'][Math.floor(seededRandom(seed + 30) * 4)],
      risk: risks[Math.floor(seededRandom(seed + 40) * risks.length)],
      status: seededRandom(seed + 50) > 0.2 ? 'Active' as const : 'Paused' as const,
    };
  });
}

function generateTimeLocked(): TimeLocked[] {
  const items: TimeLocked[] = [];
  const descriptions = [
    'Quarterly dividend release', 'Vesting schedule — Series B',
    'Regulatory escrow — UAE CBDC', 'Partnership lock-up — TechCorp',
    'Employee stock option pool', 'Insurance reserve unlock',
  ];
  for (let i = 0; i < 6; i++) {
    const seed = 8000 + i * 67;
    const unlockAt = Date.now() + Math.floor(seededRandom(seed) * 7776000000);
    items.push({
      id: `TL-${String(100 + i).padStart(4, '0')}`,
      description: descriptions[i],
      amount: Math.floor(seededRandom(seed + 10) * 3000000) + 100000,
      currency: ['USDC', 'USDT', 'AET'][Math.floor(seededRandom(seed + 20) * 3)],
      unlockAt,
      status: unlockAt - Date.now() < 86400000 ? 'Unlocking'
        : unlockAt < Date.now() ? 'Ready' : 'Locked',
    });
  }
  return items;
}

function generateActivities(count: number): ActivityItem[] {
  const items: ActivityItem[] = [];
  const types: ActivityItem['type'][] = ['transfer', 'approval', 'policy', 'yield', 'budget'];
  for (let i = 0; i < count; i++) {
    const seed = 9000 + i * 79;
    items.push({
      id: `ACT-${String(1000 + i).padStart(5, '0')}`,
      action: ACTIVITY_ACTIONS[Math.floor(seededRandom(seed) * ACTIVITY_ACTIONS.length)],
      actor: seededAddress(seed + 10),
      actorName: SIGNER_NAMES[Math.floor(seededRandom(seed + 20) * SIGNER_NAMES.length)],
      description: `${ACTIVITY_ACTIONS[Math.floor(seededRandom(seed) * ACTIVITY_ACTIONS.length)]} for treasury operations.`,
      timestamp: Date.now() - Math.floor(seededRandom(seed + 30) * 604800000),
      type: types[Math.floor(seededRandom(seed + 40) * types.length)],
    });
  }
  return items.sort((a, b) => b.timestamp - a.timestamp);
}

function generateSpendingPolicies(): SpendingPolicy[] {
  return [
    {
      name: 'General Treasury',
      dailyLimit: 500000, weeklyLimit: 2000000, monthlyLimit: 8000000,
      dailyUsed: 234500, weeklyUsed: 1245000, monthlyUsed: 5670000,
    },
    {
      name: 'Payroll Account',
      dailyLimit: 200000, weeklyLimit: 1000000, monthlyLimit: 3500000,
      dailyUsed: 0, weeklyUsed: 850000, monthlyUsed: 2900000,
    },
    {
      name: 'Operations Fund',
      dailyLimit: 100000, weeklyLimit: 500000, monthlyLimit: 1500000,
      dailyUsed: 67800, weeklyUsed: 345000, monthlyUsed: 1120000,
    },
    {
      name: 'Emergency Reserve',
      dailyLimit: 50000, weeklyLimit: 200000, monthlyLimit: 500000,
      dailyUsed: 0, weeklyUsed: 0, monthlyUsed: 45000,
    },
  ];
}

function generateAUMChart(): Array<{ month: string; aum: number; yield: number }> {
  const months = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
  return months.map((month, i) => ({
    month,
    aum: 18000000 + Math.floor(seededRandom(10000 + i * 41) * 8000000),
    yield: Math.floor(seededRandom(10000 + i * 53) * 200000) + 50000,
  }));
}

function generateSpendingByCategory(): Array<{ category: string; amount: number; fill: string }> {
  return [
    { category: 'Engineering', amount: 2450000, fill: '#DC2626' },
    { category: 'Marketing', amount: 890000, fill: '#0EA5E9' },
    { category: 'Operations', amount: 1200000, fill: '#10B981' },
    { category: 'Legal', amount: 650000, fill: '#F59E0B' },
    { category: 'Infrastructure', amount: 980000, fill: '#8B5CF6' },
    { category: 'R&D', amount: 1560000, fill: '#EC4899' },
  ];
}

function generateYieldPerformance(): Array<{ week: string; aave: number; compound: number; lido: number }> {
  const weeks = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12'];
  return weeks.map((week, i) => ({
    week,
    aave: 3.2 + seededRandom(11000 + i * 31) * 2.5,
    compound: 2.8 + seededRandom(11000 + i * 47) * 2.0,
    lido: 4.0 + seededRandom(11000 + i * 61) * 1.5,
  }));
}

function generateSparklineData(seed: number, count: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < count; i++) {
    data.push(seededRandom(seed + i * 7) * 100);
  }
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
  if (diff < 1000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function timeUntil(timestamp: number): string {
  const diff = Math.max(0, timestamp - Date.now());
  if (diff < 60000) return 'less than 1m';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ${Math.floor((diff % 3600000) / 60000)}m`;
  return `${Math.floor(diff / 86400000)}d ${Math.floor((diff % 86400000) / 3600000)}h`;
}


// =============================================================================
// REUSABLE LOCAL COMPONENTS
// =============================================================================

function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  const style = PROPOSAL_STATUS_STYLES[status] || 'bg-slate-700/50 text-slate-300 border-slate-600/30';
  const dot = PROPOSAL_STATUS_DOT[status] || 'bg-slate-400';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${style}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot} ${status === 'Pending' ? 'animate-pulse' : ''}`} />
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

function RiskBadge({ risk }: { risk: 'Low' | 'Medium' | 'High' }) {
  const styles = {
    Low: 'bg-emerald-500/20 text-emerald-400',
    Medium: 'bg-amber-500/20 text-amber-400',
    High: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[risk]}`}>
      {risk}
    </span>
  );
}

function ProgressBar({ value, max, color = 'bg-red-500', height = 'h-2' }: {
  value: number;
  max: number;
  color?: string;
  height?: string;
}) {
  const pct = Math.min(100, (value / max) * 100);
  const barColor = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : color;
  return (
    <div className={`w-full ${height} rounded-full bg-slate-700/50 overflow-hidden`}>
      <div
        className={`${height} rounded-full transition-all duration-500 ${barColor}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function ActivityIcon({ type }: { type: ActivityItem['type'] }) {
  const icons = {
    transfer: <Send className="w-3.5 h-3.5 text-blue-400" />,
    approval: <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />,
    policy: <Settings className="w-3.5 h-3.5 text-amber-400" />,
    yield: <TrendingUp className="w-3.5 h-3.5 text-purple-400" />,
    budget: <Banknote className="w-3.5 h-3.5 text-cyan-400" />,
  };
  const bgs = {
    transfer: 'bg-blue-500/10 border-blue-500/20',
    approval: 'bg-emerald-500/10 border-emerald-500/20',
    policy: 'bg-amber-500/10 border-amber-500/20',
    yield: 'bg-purple-500/10 border-purple-500/20',
    budget: 'bg-cyan-500/10 border-cyan-500/20',
  };
  return (
    <div className={`p-1.5 rounded-lg border ${bgs[type]}`}>
      {icons[type]}
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

export default function TreasuryPage() {
  const { realTime } = useApp();
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [proposalFilter, setProposalFilter] = useState<'all' | ProposalStatus>('all');
  const [showNewProposal, setShowNewProposal] = useState(false);
  const [selectedProposal, setSelectedProposal] = useState<Proposal | null>(null);
  const [newProposalType, setNewProposalType] = useState<ProposalType>('Transfer');
  useEffect(() => setMounted(true), []);

  // Generate all mock data deterministically
  const proposals = useMemo(() => generateProposals(12), []);
  const budgets = useMemo(() => generateBudgets(), []);
  const yieldStrategies = useMemo(() => generateYieldStrategies(), []);
  const timeLockedItems = useMemo(() => generateTimeLocked(), []);
  const activities = useMemo(() => generateActivities(20), []);
  const spendingPolicies = useMemo(() => generateSpendingPolicies(), []);
  const aumChart = useMemo(() => generateAUMChart(), []);
  const spendingByCategory = useMemo(() => generateSpendingByCategory(), []);
  const yieldPerformance = useMemo(() => generateYieldPerformance(), []);

  const filteredProposals = useMemo(() => {
    if (proposalFilter === 'all') return proposals;
    return proposals.filter(p => p.status === proposalFilter);
  }, [proposals, proposalFilter]);

  const totalAUM = useMemo(() => {
    return yieldStrategies.reduce((sum, s) => sum + s.allocation, 0) + 12500000;
  }, [yieldStrategies]);

  const totalYield = useMemo(() => {
    return yieldStrategies.reduce((sum, s) => sum + (s.allocation * s.apy / 100), 0);
  }, [yieldStrategies]);

  const totalBudget = useMemo(() => budgets.reduce((sum, b) => sum + b.allocated, 0), [budgets]);
  const totalSpent = useMemo(() => budgets.reduce((sum, b) => sum + b.spent, 0), [budgets]);

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'proposals', label: 'Proposals' },
    { id: 'budgets', label: 'Budgets' },
    { id: 'yield', label: 'Yield' },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <>
      <SEOHead
        title="Treasury"
        description="NoblePay treasury management console for institutional multi-sig operations, budgeting, and yield strategies."
        path="/treasury"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/treasury" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* ============================================================ */}
          {/* HEADER                                                       */}
          {/* ============================================================ */}
          <div className="mb-8">
            <div className="flex items-start justify-between mb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay Treasury</p>
                <h1 className="mt-2 text-3xl font-bold text-white">Treasury Management</h1>
                <p className="mt-1 text-sm text-slate-400">Multi-signature treasury operations, budgeting, and yield management</p>
              </div>
              <button
                onClick={() => setShowNewProposal(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                New Proposal
              </button>
            </div>

            {/* STAT CARDS */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard
                icon={Wallet}
                label="Total AUM"
                value={formatUSD(totalAUM)}
                change={{ value: '+8.4%', positive: true }}
                sparkData={generateSparklineData(2000, 12)}
                sparkColor="#3B82F6"
              />
              <StatCard
                icon={TrendingUp}
                label="Annual Yield"
                value={formatUSD(totalYield)}
                change={{ value: '+2.1%', positive: true }}
                sparkData={generateSparklineData(2100, 12)}
                sparkColor="#10B981"
              />
              <StatCard
                icon={Banknote}
                label="Budget Spent"
                value={`${((totalSpent / totalBudget) * 100).toFixed(1)}%`}
                change={{ value: formatUSD(totalBudget - totalSpent) + ' remaining', positive: true }}
              />
              <StatCard
                icon={FileText}
                label="Active Proposals"
                value={String(proposals.filter(p => p.status === 'Pending').length)}
                change={{ value: `${proposals.filter(p => p.status === 'Approved').length} approved`, positive: true }}
              />
              <StatCard
                icon={Lock}
                label="Time-Locked"
                value={formatUSD(timeLockedItems.reduce((s, t) => s + t.amount, 0))}
                sparkData={generateSparklineData(2200, 12)}
                sparkColor="#F59E0B"
              />
              <StatCard
                icon={Users}
                label="Active Signers"
                value="7"
                change={{ value: '3 required threshold', positive: true }}
              />
            </div>
          </div>

          {/* TABS */}
          <div className="mb-6">
            <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
          </div>

          {/* ============================================================ */}
          {/* OVERVIEW TAB                                                 */}
          {/* ============================================================ */}
          {activeTab === 'overview' && (
            <div className="space-y-8">
              {/* AUM Over Time & Allocation Breakdown */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <GlassCard className="lg:col-span-2 p-6">
                  <SectionHeader title="Assets Under Management" subtitle="Treasury AUM and yield over time" size="sm" />
                  {mounted && (
                    <ResponsiveContainer width="100%" height={300}>
                      <AreaChart data={aumChart}>
                        <defs>
                          <linearGradient id="aumGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#DC2626" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#DC2626" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="yieldGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => formatUSD(v)} />
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Area type="monotone" dataKey="aum" name="AUM" stroke="#DC2626" fill="url(#aumGrad)" strokeWidth={2} />
                        <Area type="monotone" dataKey="yield" name="Yield" stroke="#10B981" fill="url(#yieldGrad)" strokeWidth={2} />
                        <Legend />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </GlassCard>

                <GlassCard className="p-6">
                  <SectionHeader title="Allocation" subtitle="By currency" size="sm" />
                  {mounted && (
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie
                          data={[
                            { name: 'USDC', value: 12500000 },
                            { name: 'USDT', value: 8200000 },
                            { name: 'AET', value: 4800000 },
                            { name: 'AED', value: 3100000 },
                          ]}
                          cx="50%" cy="50%" innerRadius={50} outerRadius={80}
                          paddingAngle={3} dataKey="value"
                        >
                          {['USDC', 'USDT', 'AET', 'AED'].map((cur, i) => (
                            <Cell key={cur} fill={[CURRENCY_COLORS.USDC, CURRENCY_COLORS.USDT, CURRENCY_COLORS.AET, CURRENCY_COLORS.AED][i]} />
                          ))}
                        </Pie>
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </GlassCard>
              </div>

              {/* Spending Policies */}
              <GlassCard className="p-6">
                <SectionHeader title="Spending Policies" subtitle="Daily, weekly, and monthly limit utilization" size="sm" />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {spendingPolicies.map((policy) => (
                    <div key={policy.name} className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
                      <div className="flex items-center justify-between mb-4">
                        <h4 className="text-sm font-semibold text-white">{policy.name}</h4>
                        <Settings className="w-4 h-4 text-slate-500 cursor-pointer hover:text-slate-300 transition-colors" />
                      </div>
                      <div className="space-y-3">
                        <div>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-slate-400">Daily</span>
                            <span className="text-slate-300">{formatUSD(policy.dailyUsed)} / {formatUSD(policy.dailyLimit)}</span>
                          </div>
                          <ProgressBar value={policy.dailyUsed} max={policy.dailyLimit} color="bg-blue-500" />
                        </div>
                        <div>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-slate-400">Weekly</span>
                            <span className="text-slate-300">{formatUSD(policy.weeklyUsed)} / {formatUSD(policy.weeklyLimit)}</span>
                          </div>
                          <ProgressBar value={policy.weeklyUsed} max={policy.weeklyLimit} color="bg-purple-500" />
                        </div>
                        <div>
                          <div className="flex justify-between text-xs mb-1">
                            <span className="text-slate-400">Monthly</span>
                            <span className="text-slate-300">{formatUSD(policy.monthlyUsed)} / {formatUSD(policy.monthlyLimit)}</span>
                          </div>
                          <ProgressBar value={policy.monthlyUsed} max={policy.monthlyLimit} color="bg-cyan-500" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </GlassCard>

              {/* Time-Locked Transactions */}
              <GlassCard className="p-6">
                <SectionHeader title="Time-Locked Transactions" subtitle="Pending unlock schedule" size="sm" />
                <div className="space-y-3">
                  {timeLockedItems.map((item) => {
                    const lockStyles = {
                      Locked: 'border-slate-700/50 bg-slate-800/30',
                      Unlocking: 'border-amber-500/30 bg-amber-500/5',
                      Ready: 'border-emerald-500/30 bg-emerald-500/5',
                    };
                    const statusColors = {
                      Locked: 'text-slate-400',
                      Unlocking: 'text-amber-400',
                      Ready: 'text-emerald-400',
                    };
                    return (
                      <div key={item.id} className={`flex items-center justify-between p-4 rounded-xl border ${lockStyles[item.status]}`}>
                        <div className="flex items-center gap-4">
                          <div className="p-2 rounded-lg bg-slate-800/60 border border-slate-700/30">
                            <Lock className={`w-4 h-4 ${statusColors[item.status]}`} />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-white">{item.description}</p>
                            <p className="text-xs text-slate-400 mt-0.5">{item.id} &middot; {item.currency}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold text-white tabular-nums">{formatUSD(item.amount)}</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <Timer className="w-3 h-3 text-slate-500" />
                            <span className={`text-xs ${statusColors[item.status]}`}>
                              {item.status === 'Ready' ? 'Ready to claim' : `Unlocks in ${timeUntil(item.unlockAt)}`}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </GlassCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* PROPOSALS TAB                                                */}
          {/* ============================================================ */}
          {activeTab === 'proposals' && (
            <div className="space-y-6">
              {/* Filter bar */}
              <div className="flex items-center gap-2">
                {(['all', 'Pending', 'Approved', 'Executed', 'Rejected'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setProposalFilter(filter)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      proposalFilter === filter
                        ? 'bg-slate-700 text-white'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                    }`}
                  >
                    {filter === 'all' ? 'All' : filter}
                    <span className="ml-1.5 text-slate-500">
                      {filter === 'all' ? proposals.length : proposals.filter(p => p.status === filter).length}
                    </span>
                  </button>
                ))}
              </div>

              {/* Proposal List */}
              <div className="space-y-3">
                {filteredProposals.map((proposal) => {
                  const signedCount = proposal.signers.filter(s => s.signed).length;
                  const signedPct = (signedCount / proposal.requiredSignatures) * 100;
                  return (
                    <GlassCard
                      key={proposal.id}
                      className="p-5 cursor-pointer"
                      hover
                      onClick={() => setSelectedProposal(proposal)}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-3 mb-2">
                            <span className="text-xs font-mono text-slate-500">{proposal.id}</span>
                            <ProposalStatusBadge status={proposal.status} />
                            <Badge variant="info">{proposal.type}</Badge>
                          </div>
                          <h3 className="text-sm font-semibold text-white mb-1">{proposal.title}</h3>
                          <p className="text-xs text-slate-400">{proposal.description}</p>
                          <div className="flex items-center gap-4 mt-3">
                            <span className="text-xs text-slate-500">
                              Created by {proposal.creatorName} &middot; {timeAgo(proposal.createdAt)}
                            </span>
                            <span className="text-xs text-slate-500">
                              Expires in {timeUntil(proposal.expiresAt)}
                            </span>
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="text-lg font-bold text-white tabular-nums">{formatUSD(proposal.amount)}</p>
                          <p className="text-xs text-slate-400">{proposal.currency}</p>
                          <div className="mt-3">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs text-slate-400">{signedCount}/{proposal.requiredSignatures} signed</span>
                            </div>
                            <div className="w-24">
                              <ProgressBar value={signedCount} max={proposal.requiredSignatures} color="bg-emerald-500" height="h-1.5" />
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Signer avatars */}
                      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-slate-700/30">
                        <span className="text-xs text-slate-500 mr-1">Signers:</span>
                        {proposal.signers.map((signer, si) => (
                          <div
                            key={si}
                            className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold border ${
                              signer.signed
                                ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                                : 'bg-slate-800 border-slate-700 text-slate-500'
                            }`}
                            title={`${signer.name} — ${signer.signed ? 'Signed' : 'Pending'}`}
                          >
                            {signer.name.split(' ').map(n => n[0]).join('')}
                          </div>
                        ))}
                      </div>
                    </GlassCard>
                  );
                })}
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* BUDGETS TAB                                                  */}
          {/* ============================================================ */}
          {activeTab === 'budgets' && (
            <div className="space-y-8">
              {/* Summary */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <GlassCard className="p-6">
                  <div className="text-xs text-slate-400 mb-1">Total Allocated</div>
                  <div className="text-2xl font-bold text-white">{formatUSD(totalBudget)}</div>
                </GlassCard>
                <GlassCard className="p-6">
                  <div className="text-xs text-slate-400 mb-1">Total Spent</div>
                  <div className="text-2xl font-bold text-white">{formatUSD(totalSpent)}</div>
                  <div className="text-xs text-amber-400 mt-1">{((totalSpent / totalBudget) * 100).toFixed(1)}% utilization</div>
                </GlassCard>
                <GlassCard className="p-6">
                  <div className="text-xs text-slate-400 mb-1">Remaining</div>
                  <div className="text-2xl font-bold text-emerald-400">{formatUSD(totalBudget - totalSpent)}</div>
                </GlassCard>
              </div>

              {/* Budget Table */}
              <GlassCard className="p-6">
                <SectionHeader title="Department Budgets" subtitle="Allocated vs spent by department" size="sm" />
                <div className="space-y-4">
                  {budgets.map((budget) => {
                    const pct = (budget.spent / budget.allocated) * 100;
                    return (
                      <div key={budget.department} className="p-4 rounded-xl bg-slate-800/30 border border-slate-700/30">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: budget.color }} />
                            <span className="text-sm font-medium text-white">{budget.department}</span>
                          </div>
                          <div className="flex items-center gap-4">
                            <span className="text-xs text-slate-400">{formatUSD(budget.spent)} / {formatUSD(budget.allocated)}</span>
                            <span className={`text-xs font-medium tabular-nums ${pct > 90 ? 'text-red-400' : pct > 70 ? 'text-amber-400' : 'text-emerald-400'}`}>
                              {pct.toFixed(1)}%
                            </span>
                          </div>
                        </div>
                        <ProgressBar value={budget.spent} max={budget.allocated} color={`bg-[${budget.color}]`} />
                      </div>
                    );
                  })}
                </div>
              </GlassCard>

              {/* Spending by Category Chart */}
              <GlassCard className="p-6">
                <SectionHeader title="Spending by Category" subtitle="Total expenditure distribution" size="sm" />
                {mounted && (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={spendingByCategory}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="category" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => formatUSD(v)} />
                      <RechartsTooltip content={<CustomTooltip />} />
                      <Bar dataKey="amount" name="Spent" radius={[6, 6, 0, 0]}>
                        {spendingByCategory.map((entry, i) => (
                          <Cell key={i} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </GlassCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* YIELD TAB                                                    */}
          {/* ============================================================ */}
          {activeTab === 'yield' && (
            <div className="space-y-8">
              {/* Yield Strategies Table */}
              <GlassCard className="p-6">
                <SectionHeader
                  title="DeFi Yield Strategies"
                  subtitle="Current allocations and performance"
                  size="sm"
                  action={
                    <button className="inline-flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors">
                      <Plus className="w-3.5 h-3.5" /> Add Strategy
                    </button>
                  }
                />
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-700/50">
                        <th className="text-left py-3 px-3 text-xs font-medium text-slate-400">Protocol</th>
                        <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Allocation</th>
                        <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">APY</th>
                        <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">TVL</th>
                        <th className="text-center py-3 px-3 text-xs font-medium text-slate-400">Currency</th>
                        <th className="text-center py-3 px-3 text-xs font-medium text-slate-400">Risk</th>
                        <th className="text-center py-3 px-3 text-xs font-medium text-slate-400">Status</th>
                        <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Est. Annual</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yieldStrategies.map((strategy) => (
                        <tr key={strategy.protocol} className="border-b border-slate-800 hover:bg-slate-800/30 transition-colors">
                          <td className="py-3 px-3">
                            <div className="flex items-center gap-2">
                              <Zap className="w-4 h-4 text-purple-400" />
                              <span className="text-sm font-medium text-white">{strategy.protocol}</span>
                            </div>
                          </td>
                          <td className="py-3 px-3 text-right text-sm text-white tabular-nums">{formatUSD(strategy.allocation)}</td>
                          <td className="py-3 px-3 text-right">
                            <span className="text-sm font-semibold text-emerald-400 tabular-nums">{strategy.apy.toFixed(2)}%</span>
                          </td>
                          <td className="py-3 px-3 text-right text-sm text-slate-300 tabular-nums">{formatUSD(strategy.tvl)}</td>
                          <td className="py-3 px-3 text-center">
                            <Badge variant="neutral">{strategy.currency}</Badge>
                          </td>
                          <td className="py-3 px-3 text-center">
                            <RiskBadge risk={strategy.risk} />
                          </td>
                          <td className="py-3 px-3 text-center">
                            <span className={`inline-flex items-center gap-1 text-xs font-medium ${strategy.status === 'Active' ? 'text-emerald-400' : 'text-amber-400'}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${strategy.status === 'Active' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                              {strategy.status}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right text-sm text-white tabular-nums">
                            {formatUSD(strategy.allocation * strategy.apy / 100)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-slate-600/50">
                        <td className="py-3 px-3 text-sm font-semibold text-white">Total</td>
                        <td className="py-3 px-3 text-right text-sm font-semibold text-white tabular-nums">
                          {formatUSD(yieldStrategies.reduce((s, y) => s + y.allocation, 0))}
                        </td>
                        <td className="py-3 px-3 text-right text-sm font-semibold text-emerald-400">
                          {(yieldStrategies.reduce((s, y) => s + y.apy, 0) / yieldStrategies.length).toFixed(2)}% avg
                        </td>
                        <td colSpan={3} />
                        <td />
                        <td className="py-3 px-3 text-right text-sm font-semibold text-white tabular-nums">
                          {formatUSD(totalYield)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </GlassCard>

              {/* Yield Performance Chart */}
              <GlassCard className="p-6">
                <SectionHeader title="Yield Performance" subtitle="APY trend by protocol (last 12 weeks)" size="sm" />
                {mounted && (
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={yieldPerformance}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="week" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v.toFixed(1)}%`} />
                      <RechartsTooltip content={<CustomTooltip formatValue={(v) => `${Number(v).toFixed(2)}%`} />} />
                      <Line type="monotone" dataKey="aave" name="Aave V3" stroke="#8B5CF6" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="compound" name="Compound" stroke="#0EA5E9" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="lido" name="Lido" stroke="#10B981" strokeWidth={2} dot={false} />
                      <Legend />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </GlassCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* ACTIVITY TAB                                                 */}
          {/* ============================================================ */}
          {activeTab === 'activity' && (
            <GlassCard className="p-6">
              <SectionHeader
                title="Treasury Activity Feed"
                subtitle="Real-time log of all treasury operations"
                size="sm"
                action={
                  <button className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors">
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh
                  </button>
                }
              />
              <div className="space-y-2">
                {activities.map((activity) => (
                  <div
                    key={activity.id}
                    className="flex items-start gap-3 p-3 rounded-xl hover:bg-slate-800/30 transition-colors"
                  >
                    <ActivityIcon type={activity.type} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white">{activity.action}</span>
                      </div>
                      <p className="text-xs text-slate-400 mt-0.5">{activity.description}</p>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs text-slate-500">
                          by {activity.actorName}
                        </span>
                        <span className="text-xs text-slate-600">&middot;</span>
                        <span className="text-xs text-slate-500 font-mono">
                          {truncateAddress(activity.actor, 8, 4)}
                        </span>
                      </div>
                    </div>
                    <span className="text-xs text-slate-500 flex-shrink-0">{timeAgo(activity.timestamp)}</span>
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

        </main>

        <Footer />
      </div>

      {/* ============================================================ */}
      {/* NEW PROPOSAL MODAL                                           */}
      {/* ============================================================ */}
      <Modal open={showNewProposal} onClose={() => setShowNewProposal(false)} title="Create Treasury Proposal" maxWidth="max-w-2xl">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Proposal Type</label>
            <div className="flex gap-2">
              {(['Transfer', 'Budget Allocation', 'Yield Strategy', 'Policy Change'] as ProposalType[]).map((type) => (
                <button
                  key={type}
                  onClick={() => setNewProposalType(type)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    newProposalType === type ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Title</label>
            <input
              type="text"
              placeholder="Enter proposal title"
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Amount</label>
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

          {newProposalType === 'Transfer' && (
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Recipient Address</label>
              <input
                type="text"
                placeholder="aeth1..."
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm font-mono placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              />
            </div>
          )}

          {newProposalType === 'Budget Allocation' && (
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Department</label>
              <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">
                {DEPARTMENT_NAMES.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          )}

          {newProposalType === 'Yield Strategy' && (
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Protocol</label>
              <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">
                {PROTOCOL_NAMES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Description</label>
            <textarea
              rows={3}
              placeholder="Describe the purpose of this proposal..."
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent resize-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Required Signers</label>
            <div className="flex gap-2 flex-wrap">
              {SIGNER_NAMES.slice(0, 5).map((name) => (
                <label key={name} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 cursor-pointer hover:border-slate-600 transition-colors">
                  <input type="checkbox" className="rounded border-slate-600 bg-slate-700 text-red-500 focus:ring-red-500" />
                  <span className="text-xs text-slate-300">{name}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-700/50">
            <button
              onClick={() => setShowNewProposal(false)}
              className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => setShowNewProposal(false)}
              className="px-6 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"
            >
              Submit Proposal
            </button>
          </div>
        </div>
      </Modal>

      {/* ============================================================ */}
      {/* PROPOSAL DETAIL MODAL                                        */}
      {/* ============================================================ */}
      <Modal
        open={selectedProposal !== null}
        onClose={() => setSelectedProposal(null)}
        title={selectedProposal?.title || 'Proposal Detail'}
        maxWidth="max-w-xl"
      >
        {selectedProposal && (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <ProposalStatusBadge status={selectedProposal.status} />
              <Badge variant="info">{selectedProposal.type}</Badge>
              <span className="text-xs font-mono text-slate-500">{selectedProposal.id}</span>
            </div>

            <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-slate-400">Amount</p>
                  <p className="text-lg font-bold text-white">{formatUSD(selectedProposal.amount)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Currency</p>
                  <p className="text-lg font-bold text-white">{selectedProposal.currency}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Created</p>
                  <p className="text-sm text-slate-200">{timeAgo(selectedProposal.createdAt)}</p>
                </div>
                <div>
                  <p className="text-xs text-slate-400">Expires</p>
                  <p className="text-sm text-slate-200">{timeUntil(selectedProposal.expiresAt)}</p>
                </div>
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-slate-400 mb-3">Approval Workflow</p>
              <div className="space-y-2">
                {selectedProposal.signers.map((signer, i) => (
                  <div key={i} className="flex items-center justify-between p-2.5 rounded-lg bg-slate-800/30 border border-slate-700/30">
                    <div className="flex items-center gap-3">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                        signer.signed
                          ? 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-400'
                          : 'bg-slate-800 border border-slate-700 text-slate-500'
                      }`}>
                        {signer.name.split(' ').map(n => n[0]).join('')}
                      </div>
                      <div>
                        <p className="text-sm text-white">{signer.name}</p>
                        <p className="text-xs text-slate-500 font-mono">{truncateAddress(signer.address, 8, 4)}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      {signer.signed ? (
                        <div className="flex items-center gap-1.5 text-emerald-400">
                          <CheckCircle className="w-4 h-4" />
                          <span className="text-xs">Signed</span>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">Pending</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {selectedProposal.status === 'Pending' && (
              <div className="flex gap-3 pt-4 border-t border-slate-700/50">
                <button className="flex-1 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors">
                  Approve
                </button>
                <button className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors">
                  Reject
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
