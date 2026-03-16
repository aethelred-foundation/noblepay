/**
 * NoblePay AI Compliance — AI-Powered Compliance Insights Dashboard
 *
 * AI model registry, real-time compliance decision feed, risk heat maps,
 * decision factor analysis, human review queue, model performance charts,
 * bias monitoring, appeal management, and regulatory report generation.
 *
 * All mock data uses seededRandom for deterministic SSR hydration.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { SEOHead } from '@/components/SEOHead';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  Legend, ReferenceLine, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  ScatterChart, Scatter,
} from 'recharts';
import {
  Brain, Shield, AlertTriangle, CheckCircle, XCircle,
  ArrowUpRight, ArrowDownRight, Eye, Search, Filter,
  Download, FileText, RefreshCw, Settings, ChevronRight,
  Globe, Target, Activity, TrendingUp, BarChart3,
  Users, Clock, Zap, AlertCircle, Hash,
  Scale, Fingerprint, Flag, ThumbsUp, ThumbsDown,
  Crosshair, Layers, Radio, PieChart as PieChartIcon,
  ChevronDown, X, Plus, ArrowRight, ExternalLink,
  DollarSign, Lock, Building2,
} from 'lucide-react';
import { useApp } from '@/contexts/AppContext';
import { TopNav, Footer, Badge, Modal, Tabs, Drawer } from '@/components/SharedComponents';
import { seededRandom, seededHex, seededAddress, formatNumber, truncateAddress } from '@/lib/utils';
import { BRAND, JURISDICTION_RISK_MAP } from '@/lib/constants';
import { GlassCard, SectionHeader, Sparkline } from '@/components/PagePrimitives';


// =============================================================================
// CHART & LOCAL CONSTANTS
// =============================================================================

const CHART_COLORS = [
  '#DC2626', '#0EA5E9', '#10B981', '#F59E0B', '#8B5CF6',
  '#EC4899', '#06B6D4', '#F87171', '#34D399', '#FBBF24',
];


// =============================================================================
// TYPES
// =============================================================================

type DecisionOutcome = 'Approved' | 'Flagged' | 'Blocked' | 'Review';
type AppealStatus = 'Open' | 'Under Review' | 'Resolved' | 'Rejected';

interface AIModel {
  id: string;
  name: string;
  version: string;
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
  totalDecisions: number;
  avgLatencyMs: number;
  status: 'Production' | 'Staging' | 'Deprecated';
  lastUpdated: number;
  trainedOn: string;
}

interface ComplianceDecision {
  id: string;
  paymentId: string;
  outcome: DecisionOutcome;
  confidence: number;
  modelId: string;
  modelVersion: string;
  riskScore: number;
  factors: {
    name: string;
    score: number;
    weight: number;
    description: string;
  }[];
  jurisdiction: string;
  amount: number;
  currency: string;
  timestamp: number;
  processingTimeMs: number;
  senderName: string;
  recipientName: string;
}

interface HumanReviewItem {
  id: string;
  decision: ComplianceDecision;
  assignedTo: string;
  assignedName: string;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
  status: 'Pending' | 'In Progress' | 'Completed';
  notes: string;
  createdAt: number;
}

interface Appeal {
  id: string;
  decisionId: string;
  paymentId: string;
  status: AppealStatus;
  reason: string;
  submittedBy: string;
  submittedByName: string;
  submittedAt: number;
  resolvedAt: number | null;
  resolution: string | null;
  originalOutcome: DecisionOutcome;
  amount: number;
  currency: string;
}

interface JurisdictionRiskEntry {
  code: string;
  name: string;
  risk: 'Low' | 'Medium' | 'High' | 'Critical';
  decisions: number;
  flagRate: number;
  avgConfidence: number;
}

interface BiasMetric {
  category: string;
  detectionRate: number;
  falsePositiveRate: number;
  avgConfidence: number;
  sampleSize: number;
}


// =============================================================================
// MOCK DATA GENERATORS
// =============================================================================

const COMPANY_NAMES = [
  'Meridian Capital LLC', 'Falcon Fintech Solutions', 'Desert Rose Trading',
  'Gulf Stream Finance', 'Phoenix Partners AG', 'Oasis Digital Assets',
  'Atlas Venture Holdings', 'Zenith Corporation', 'Crescent Bay Ventures',
  'Sovereign Wealth Partners', 'Noble Bridge Capital', 'Apex Advisory Group',
];

const REVIEWER_NAMES = [
  'Sarah Chen', 'Marcus Williams', 'Aisha Al-Rashid', 'James O\'Connor',
  'Elena Petrov', 'David Kim', 'Fatima Hassan', 'Robert Taylor',
];

const JURISDICTIONS: Array<{ code: string; name: string }> = [
  { code: 'AE', name: 'UAE' }, { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' }, { code: 'SG', name: 'Singapore' },
  { code: 'JP', name: 'Japan' }, { code: 'DE', name: 'Germany' },
  { code: 'IN', name: 'India' }, { code: 'BR', name: 'Brazil' },
  { code: 'NG', name: 'Nigeria' }, { code: 'PK', name: 'Pakistan' },
  { code: 'TR', name: 'Turkey' }, { code: 'ZA', name: 'South Africa' },
  { code: 'CH', name: 'Switzerland' }, { code: 'FR', name: 'France' },
  { code: 'EG', name: 'Egypt' }, { code: 'VN', name: 'Vietnam' },
];

const FACTOR_NAMES = [
  'Sanctions Proximity', 'Transaction Pattern', 'Jurisdiction Risk',
  'Counterparty Score', 'Volume Anomaly', 'Behavioral Analysis',
  'Network Topology', 'Entity Reputation', 'Historical Activity',
];

function generateSparklineData(seed: number, count: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < count; i++) {
    data.push(seededRandom(seed + i * 7) * 100);
  }
  return data;
}

function generateModels(): AIModel[] {
  return [
    {
      id: 'AML-SENTINEL',
      name: 'AML Sentinel',
      version: 'v3.2.1',
      accuracy: 97.4,
      precision: 96.8,
      recall: 94.2,
      f1Score: 95.5,
      falsePositiveRate: 2.3,
      falseNegativeRate: 1.1,
      totalDecisions: 1247832,
      avgLatencyMs: 42,
      status: 'Production',
      lastUpdated: Date.now() - 172800000,
      trainedOn: 'Jan 2026 dataset (2.3M samples)',
    },
    {
      id: 'SANCTIONS-NET',
      name: 'SanctionsNet',
      version: 'v2.8.0',
      accuracy: 99.1,
      precision: 98.7,
      recall: 97.5,
      f1Score: 98.1,
      falsePositiveRate: 0.8,
      falseNegativeRate: 0.3,
      totalDecisions: 892451,
      avgLatencyMs: 28,
      status: 'Production',
      lastUpdated: Date.now() - 604800000,
      trainedOn: 'Feb 2026 OFAC/UN dataset (890K entries)',
    },
    {
      id: 'BEHAVIOR-ANALYST',
      name: 'Behavioral Analyst',
      version: 'v1.9.3',
      accuracy: 93.7,
      precision: 91.2,
      recall: 89.8,
      f1Score: 90.5,
      falsePositiveRate: 5.1,
      falseNegativeRate: 2.8,
      totalDecisions: 634218,
      avgLatencyMs: 67,
      status: 'Production',
      lastUpdated: Date.now() - 259200000,
      trainedOn: 'Dec 2025 behavioral dataset (1.1M patterns)',
    },
    {
      id: 'JURISDICTION-RISK',
      name: 'Jurisdiction Risk Engine',
      version: 'v4.0.0-rc2',
      accuracy: 95.8,
      precision: 94.3,
      recall: 92.1,
      f1Score: 93.2,
      falsePositiveRate: 3.4,
      falseNegativeRate: 1.9,
      totalDecisions: 45231,
      avgLatencyMs: 35,
      status: 'Staging',
      lastUpdated: Date.now() - 86400000,
      trainedOn: 'Mar 2026 jurisdiction dataset (500K entries)',
    },
    {
      id: 'PEP-DETECTOR',
      name: 'PEP Detector',
      version: 'v2.1.0',
      accuracy: 96.2,
      precision: 95.5,
      recall: 93.8,
      f1Score: 94.6,
      falsePositiveRate: 2.9,
      falseNegativeRate: 1.5,
      totalDecisions: 312890,
      avgLatencyMs: 51,
      status: 'Deprecated',
      lastUpdated: Date.now() - 2592000000,
      trainedOn: 'Oct 2025 PEP dataset (780K entries)',
    },
  ];
}

function generateDecisions(count: number): ComplianceDecision[] {
  const decisions: ComplianceDecision[] = [];
  const outcomes: DecisionOutcome[] = ['Approved', 'Approved', 'Approved', 'Flagged', 'Blocked', 'Review'];
  const currencies = ['USDC', 'USDT', 'AET', 'AED'];
  const models = ['AML-SENTINEL', 'SANCTIONS-NET', 'BEHAVIOR-ANALYST'];

  for (let i = 0; i < count; i++) {
    const seed = 60000 + i * 137;
    const outcome = outcomes[Math.floor(seededRandom(seed) * outcomes.length)];
    const jIdx = Math.floor(seededRandom(seed + 10) * JURISDICTIONS.length);
    const factorCount = 4 + Math.floor(seededRandom(seed + 20) * 4);
    const factors = [];
    for (let f = 0; f < factorCount; f++) {
      const fSeed = seed + 100 + f * 17;
      factors.push({
        name: FACTOR_NAMES[Math.floor(seededRandom(fSeed) * FACTOR_NAMES.length)],
        score: Math.floor(seededRandom(fSeed + 1) * 100),
        weight: seededRandom(fSeed + 2) * 0.3 + 0.05,
        description: `Risk factor analysis for ${FACTOR_NAMES[Math.floor(seededRandom(fSeed) * FACTOR_NAMES.length)].toLowerCase()}`,
      });
    }

    decisions.push({
      id: `AID-${String(5000 + i).padStart(5, '0')}`,
      paymentId: `0x${seededHex(seed + 30, 16)}`,
      outcome,
      confidence: outcome === 'Approved' ? 85 + seededRandom(seed + 40) * 15 : 40 + seededRandom(seed + 40) * 50,
      modelId: models[Math.floor(seededRandom(seed + 50) * models.length)],
      modelVersion: 'v3.2.1',
      riskScore: outcome === 'Approved' ? Math.floor(seededRandom(seed + 60) * 30)
        : outcome === 'Flagged' ? 40 + Math.floor(seededRandom(seed + 60) * 30)
        : outcome === 'Blocked' ? 70 + Math.floor(seededRandom(seed + 60) * 30)
        : 30 + Math.floor(seededRandom(seed + 60) * 40),
      factors,
      jurisdiction: JURISDICTIONS[jIdx].code,
      amount: i === 0 ? 500 : Math.floor(seededRandom(seed + 70) * 500000) + 5000,
      currency: currencies[Math.floor(seededRandom(seed + 80) * currencies.length)],
      timestamp: Date.now() - Math.floor(seededRandom(seed + 90) * 604800000),
      processingTimeMs: Math.floor(seededRandom(seed + 100) * 80) + 15,
      senderName: COMPANY_NAMES[Math.floor(seededRandom(seed + 110) * COMPANY_NAMES.length)],
      recipientName: COMPANY_NAMES[Math.floor(seededRandom(seed + 120) * COMPANY_NAMES.length)],
    });
  }
  return decisions.sort((a, b) => b.timestamp - a.timestamp);
}

function generateReviewQueue(): HumanReviewItem[] {
  const items: HumanReviewItem[] = [];
  const priorities: HumanReviewItem['priority'][] = ['Low', 'Medium', 'High', 'Critical'];
  const statuses: HumanReviewItem['status'][] = ['Pending', 'In Progress', 'Completed'];
  const allDecisions = generateDecisions(10);
  const decisions = allDecisions.filter(d => d.outcome === 'Review' || d.outcome === 'Flagged');
  if (decisions.length === 0) decisions.push(allDecisions[0]);

  for (let i = 0; i < 8; i++) {
    const seed = 61000 + i * 97;
    const decision = decisions[i % decisions.length];
    items.push({
      id: `REV-${String(3000 + i).padStart(5, '0')}`,
      decision,
      assignedTo: seededAddress(seed + 10),
      assignedName: REVIEWER_NAMES[Math.floor(seededRandom(seed + 20) * REVIEWER_NAMES.length)],
      priority: priorities[Math.floor(seededRandom(seed + 30) * priorities.length)],
      status: statuses[Math.floor(seededRandom(seed + 40) * statuses.length)],
      notes: `Review required for ${decision.outcome.toLowerCase()} decision with ${decision.confidence.toFixed(0)}% confidence.`,
      createdAt: Date.now() - Math.floor(seededRandom(seed + 50) * 172800000),
    });
  }
  return items;
}

function generateAppeals(): Appeal[] {
  const appeals: Appeal[] = [];
  const statuses: AppealStatus[] = ['Open', 'Under Review', 'Resolved', 'Rejected'];
  const reasons = [
    'Transaction was a legitimate business payment',
    'False sanctions match — different entity',
    'Counterparty was incorrectly flagged',
    'Payment was for regulatory compliance purposes',
    'Amount threshold triggered false positive',
    'Jurisdiction classification error',
  ];

  for (let i = 0; i < 8; i++) {
    const seed = 62000 + i * 113;
    const status = statuses[Math.floor(seededRandom(seed) * statuses.length)];
    appeals.push({
      id: `APL-${String(4000 + i).padStart(5, '0')}`,
      decisionId: `AID-${String(5000 + Math.floor(seededRandom(seed + 10) * 20)).padStart(5, '0')}`,
      paymentId: `0x${seededHex(seed + 20, 16)}`,
      status,
      reason: reasons[Math.floor(seededRandom(seed + 30) * reasons.length)],
      submittedBy: seededAddress(seed + 40),
      submittedByName: COMPANY_NAMES[Math.floor(seededRandom(seed + 50) * COMPANY_NAMES.length)],
      submittedAt: Date.now() - Math.floor(seededRandom(seed + 60) * 1209600000),
      resolvedAt: status === 'Resolved' || status === 'Rejected' ? Date.now() - Math.floor(seededRandom(seed + 70) * 604800000) : null,
      resolution: status === 'Resolved' ? 'Appeal upheld — decision overturned' : status === 'Rejected' ? 'Original decision confirmed' : null,
      originalOutcome: (['Flagged', 'Blocked'] as const)[Math.floor(seededRandom(seed + 80) * 2)],
      amount: Math.floor(seededRandom(seed + 90) * 300000) + 10000,
      currency: ['USDC', 'USDT', 'AET'][Math.floor(seededRandom(seed + 100) * 3)],
    });
  }
  return appeals;
}

function generateJurisdictionRisk(): JurisdictionRiskEntry[] {
  return JURISDICTIONS.map((j, i) => {
    const seed = 63000 + i * 73;
    const risk = JURISDICTION_RISK_MAP[j.code] || 'Medium';
    return {
      code: j.code,
      name: j.name,
      risk: risk as JurisdictionRiskEntry['risk'],
      decisions: Math.floor(seededRandom(seed) * 50000) + 5000,
      flagRate: risk === 'Low' ? seededRandom(seed + 10) * 3
        : risk === 'Medium' ? 3 + seededRandom(seed + 10) * 8
        : risk === 'High' ? 10 + seededRandom(seed + 10) * 15
        : 25 + seededRandom(seed + 10) * 20,
      avgConfidence: 75 + seededRandom(seed + 20) * 20,
    };
  });
}

function generateBiasMetrics(): BiasMetric[] {
  return [
    { category: 'Low-Risk Jurisdictions', detectionRate: 2.3, falsePositiveRate: 1.1, avgConfidence: 96.2, sampleSize: 450000 },
    { category: 'Medium-Risk Jurisdictions', detectionRate: 8.7, falsePositiveRate: 3.4, avgConfidence: 91.5, sampleSize: 180000 },
    { category: 'High-Risk Jurisdictions', detectionRate: 18.4, falsePositiveRate: 5.8, avgConfidence: 87.3, sampleSize: 45000 },
    { category: 'Individual Accounts', detectionRate: 4.2, falsePositiveRate: 2.1, avgConfidence: 93.8, sampleSize: 320000 },
    { category: 'Corporate Accounts', detectionRate: 6.1, falsePositiveRate: 2.8, avgConfidence: 92.1, sampleSize: 280000 },
    { category: 'Government Entities', detectionRate: 3.5, falsePositiveRate: 1.5, avgConfidence: 95.4, sampleSize: 25000 },
    { category: 'Small Transactions (<$10K)', detectionRate: 1.8, falsePositiveRate: 0.9, avgConfidence: 97.1, sampleSize: 520000 },
    { category: 'Large Transactions (>$100K)', detectionRate: 12.3, falsePositiveRate: 4.7, avgConfidence: 88.6, sampleSize: 85000 },
  ];
}

function generatePrecisionRecallChart(): Array<{ month: string; precision: number; recall: number; f1: number }> {
  const months = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
  return months.map((month, i) => ({
    month,
    precision: 93 + seededRandom(64000 + i * 41) * 5,
    recall: 90 + seededRandom(64000 + i * 53) * 7,
    f1: 91 + seededRandom(64000 + i * 67) * 6,
  }));
}

function generateFPRateChart(): Array<{ week: string; sentinel: number; sanctions: number; behavioral: number }> {
  const weeks = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12'];
  return weeks.map((week, i) => ({
    week,
    sentinel: 1.5 + seededRandom(65000 + i * 31) * 2.5,
    sanctions: 0.3 + seededRandom(65000 + i * 47) * 1.5,
    behavioral: 3.0 + seededRandom(65000 + i * 61) * 4,
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

function riskColor(score: number): string {
  if (score < 30) return 'text-emerald-400';
  if (score < 60) return 'text-amber-400';
  if (score < 80) return 'text-orange-400';
  return 'text-red-400';
}

function riskBarColor(score: number): string {
  if (score < 30) return 'bg-emerald-500';
  if (score < 60) return 'bg-amber-500';
  if (score < 80) return 'bg-orange-500';
  return 'bg-red-500';
}


// =============================================================================
// REUSABLE LOCAL COMPONENTS
// =============================================================================

function OutcomeBadge({ outcome }: { outcome: DecisionOutcome }) {
  const styles: Record<DecisionOutcome, string> = {
    Approved: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    Flagged: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    Blocked: 'bg-red-500/20 text-red-400 border-red-500/30',
    Review: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles[outcome]}`}>
      {outcome}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: HumanReviewItem['priority'] }) {
  const styles = {
    Low: 'bg-slate-500/20 text-slate-400',
    Medium: 'bg-amber-500/20 text-amber-400',
    High: 'bg-orange-500/20 text-orange-400',
    Critical: 'bg-red-500/20 text-red-400',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[priority]}`}>
      {priority}
    </span>
  );
}

function ModelStatusBadge({ status }: { status: AIModel['status'] }) {
  const styles = {
    Production: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    Staging: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    Deprecated: 'bg-slate-500/20 text-slate-400 border-slate-500/30',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${status === 'Production' ? 'bg-emerald-400 animate-pulse' : status === 'Staging' ? 'bg-amber-400' : 'bg-slate-400'}`} />
      {status}
    </span>
  );
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const color = confidence >= 90 ? 'bg-emerald-500' : confidence >= 70 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 rounded-full bg-slate-700/50 overflow-hidden">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${confidence}%` }} />
      </div>
      <span className="text-xs tabular-nums text-slate-300">{confidence.toFixed(0)}%</span>
    </div>
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

function CustomTooltip({ active, payload, label, formatValue }: {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number | string }>;
  label?: string;
  formatValue?: (v: number | string) => string;
}) {
  if (!active || !payload?.length) return null;
  const fmt = formatValue || ((v: number | string) => typeof v === 'number' ? `${v.toFixed(2)}` : String(v));
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

export default function AICompliancePage() {
  const { realTime } = useApp();
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState('decisions');
  const [selectedDecision, setSelectedDecision] = useState<ComplianceDecision | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<'all' | DecisionOutcome>('all');
  useEffect(() => setMounted(true), []);

  // Generate all mock data deterministically
  const models = useMemo(() => generateModels(), []);
  const decisions = useMemo(() => generateDecisions(20), []);
  const reviewQueue = useMemo(() => generateReviewQueue(), []);
  const appeals = useMemo(() => generateAppeals(), []);
  const jurisdictionRisk = useMemo(() => generateJurisdictionRisk(), []);
  const biasMetrics = useMemo(() => generateBiasMetrics(), []);
  const precisionRecall = useMemo(() => generatePrecisionRecallChart(), []);
  const fpRateChart = useMemo(() => generateFPRateChart(), []);

  const filteredDecisions = useMemo(() => {
    if (outcomeFilter === 'all') return decisions;
    return decisions.filter(d => d.outcome === outcomeFilter);
  }, [decisions, outcomeFilter]);

  const productionModels = models.filter(m => m.status === 'Production');
  const avgAccuracy = productionModels.reduce((s, m) => s + m.accuracy, 0) / productionModels.length;
  const totalDecisions = models.reduce((s, m) => s + m.totalDecisions, 0);
  const pendingReviews = reviewQueue.filter(r => r.status !== 'Completed').length;
  const openAppeals = appeals.filter(a => a.status === 'Open' || a.status === 'Under Review').length;

  const tabs = [
    { id: 'decisions', label: 'Decisions' },
    { id: 'models', label: 'Models' },
    { id: 'review', label: `Review Queue (${pendingReviews})` },
    { id: 'heatmap', label: 'Risk Map' },
    { id: 'performance', label: 'Performance' },
    { id: 'bias', label: 'Bias Monitor' },
    { id: 'appeals', label: `Appeals (${openAppeals})` },
  ];

  return (
    <>
      <SEOHead
        title="AI Compliance"
        description="NoblePay AI-powered compliance insights with model registry, decision analysis, and bias monitoring."
        path="/ai-compliance"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/ai-compliance" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* ============================================================ */}
          {/* HEADER                                                       */}
          {/* ============================================================ */}
          <div className="mb-8">
            <div className="flex items-start justify-between mb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay AI</p>
                <h1 className="mt-2 text-3xl font-bold text-white">AI Compliance Insights</h1>
                <p className="mt-1 text-sm text-slate-400">AI-powered compliance decision intelligence, model monitoring, and bias analysis</p>
              </div>
              <button className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors">
                <FileText className="w-4 h-4" />
                Generate Report
              </button>
            </div>

            {/* STAT CARDS */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard
                icon={Brain}
                label="Model Accuracy"
                value={`${avgAccuracy.toFixed(1)}%`}
                change={{ value: '+0.3% this month', positive: true }}
              />
              <StatCard
                icon={Activity}
                label="Total Decisions"
                value={formatNumber(totalDecisions)}
                sparkData={generateSparklineData(70000, 12)}
                sparkColor="#3B82F6"
              />
              <StatCard
                icon={Target}
                label="Avg Confidence"
                value="94.2%"
                change={{ value: '+1.2%', positive: true }}
              />
              <StatCard
                icon={AlertTriangle}
                label="False Positive Rate"
                value="2.3%"
                change={{ value: '-0.4%', positive: true }}
                sparkData={generateSparklineData(70100, 12)}
                sparkColor="#10B981"
              />
              <StatCard
                icon={Eye}
                label="Pending Reviews"
                value={String(pendingReviews)}
                change={{ value: `${openAppeals} appeals`, positive: false }}
              />
              <StatCard
                icon={Clock}
                label="Avg Latency"
                value="42ms"
                change={{ value: '-8ms this week', positive: true }}
              />
            </div>
          </div>

          {/* TABS */}
          <div className="mb-6 overflow-x-auto">
            <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
          </div>

          {/* ============================================================ */}
          {/* DECISIONS TAB                                                */}
          {/* ============================================================ */}
          {activeTab === 'decisions' && (
            <div className="space-y-6">
              {/* Filters */}
              <div className="flex items-center gap-2">
                {(['all', 'Approved', 'Flagged', 'Blocked', 'Review'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setOutcomeFilter(filter)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      outcomeFilter === filter ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {filter === 'all' ? 'All' : filter}
                  </button>
                ))}
              </div>

              {/* Decision Feed */}
              <div className="space-y-3">
                {filteredDecisions.map((decision) => (
                  <GlassCard
                    key={decision.id}
                    className="p-4 cursor-pointer"
                    hover
                    onClick={() => setSelectedDecision(decision)}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="text-xs font-mono text-slate-500">{decision.id}</span>
                          <OutcomeBadge outcome={decision.outcome} />
                          <Badge variant="neutral">{decision.modelId}</Badge>
                          <Badge variant="info">{decision.jurisdiction}</Badge>
                        </div>
                        <div className="flex items-center gap-2 text-sm">
                          <span className="text-white">{decision.senderName}</span>
                          <ArrowRight className="w-3.5 h-3.5 text-slate-500" />
                          <span className="text-white">{decision.recipientName}</span>
                        </div>
                        <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
                          <span>Confidence: <span className={riskColor(100 - decision.confidence)}>{decision.confidence.toFixed(1)}%</span></span>
                          <span>Risk: <span className={riskColor(decision.riskScore)}>{decision.riskScore}</span></span>
                          <span>{decision.processingTimeMs}ms</span>
                          <span>{timeAgo(decision.timestamp)}</span>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-semibold text-white tabular-nums">{formatUSD(decision.amount)}</p>
                        <p className="text-xs text-slate-400">{decision.currency}</p>
                        <ConfidenceBar confidence={decision.confidence} />
                      </div>
                    </div>
                  </GlassCard>
                ))}
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* MODELS TAB                                                   */}
          {/* ============================================================ */}
          {activeTab === 'models' && (
            <div className="space-y-4">
              {models.map((model) => (
                <GlassCard key={model.id} className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <div className="flex items-center gap-3 mb-1">
                        <Brain className="w-5 h-5 text-purple-400" />
                        <h3 className="text-lg font-semibold text-white">{model.name}</h3>
                        <ModelStatusBadge status={model.status} />
                      </div>
                      <p className="text-xs text-slate-400">
                        {model.id} &middot; {model.version} &middot; Updated {timeAgo(model.lastUpdated)}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">Trained on: {model.trainedOn}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold text-white">{model.accuracy.toFixed(1)}%</p>
                      <p className="text-xs text-slate-400">Accuracy</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4">
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">Precision</p>
                      <p className="text-sm font-semibold text-white">{model.precision.toFixed(1)}%</p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">Recall</p>
                      <p className="text-sm font-semibold text-white">{model.recall.toFixed(1)}%</p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">F1 Score</p>
                      <p className="text-sm font-semibold text-emerald-400">{model.f1Score.toFixed(1)}%</p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">FP Rate</p>
                      <p className="text-sm font-semibold text-amber-400">{model.falsePositiveRate.toFixed(1)}%</p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">FN Rate</p>
                      <p className="text-sm font-semibold text-red-400">{model.falseNegativeRate.toFixed(1)}%</p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">Decisions</p>
                      <p className="text-sm font-semibold text-white">{formatNumber(model.totalDecisions)}</p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">Latency</p>
                      <p className="text-sm font-semibold text-white">{model.avgLatencyMs}ms</p>
                    </div>
                  </div>
                </GlassCard>
              ))}
            </div>
          )}

          {/* ============================================================ */}
          {/* REVIEW QUEUE TAB                                             */}
          {/* ============================================================ */}
          {(activeTab === 'review' || activeTab.startsWith('Review Queue')) && (
            <div className="space-y-3">
              {reviewQueue.map((item) => (
                <GlassCard key={item.id} className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="text-xs font-mono text-slate-500">{item.id}</span>
                        <PriorityBadge priority={item.priority} />
                        <OutcomeBadge outcome={item.decision.outcome} />
                        <Badge variant={item.status === 'Completed' ? 'success' : item.status === 'In Progress' ? 'info' : 'warning'}>
                          {item.status}
                        </Badge>
                      </div>
                      <p className="text-sm text-slate-300">{item.notes}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
                        <span>Assigned to: {item.assignedName}</span>
                        <span>&middot;</span>
                        <span>Created: {timeAgo(item.createdAt)}</span>
                        <span>&middot;</span>
                        <span>Confidence: {item.decision.confidence.toFixed(0)}%</span>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-semibold text-white tabular-nums">{formatUSD(item.decision.amount)}</p>
                      {item.status !== 'Completed' && (
                        <button className="mt-2 px-3 py-1 rounded-lg bg-red-600/20 text-red-400 text-xs font-medium hover:bg-red-600/30 transition-colors">
                          Review
                        </button>
                      )}
                    </div>
                  </div>
                </GlassCard>
              ))}
            </div>
          )}

          {/* ============================================================ */}
          {/* RISK MAP TAB                                                 */}
          {/* ============================================================ */}
          {activeTab === 'heatmap' && (
            <div className="space-y-6">
              <GlassCard className="p-6">
                <SectionHeader title="Jurisdiction Risk Heat Map" subtitle="AI detection rates and confidence by region" size="sm" />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {jurisdictionRisk.map((j) => {
                    const riskStyles = {
                      Low: 'border-emerald-500/30 bg-emerald-500/5',
                      Medium: 'border-amber-500/30 bg-amber-500/5',
                      High: 'border-orange-500/30 bg-orange-500/5',
                      Critical: 'border-red-500/30 bg-red-500/5',
                    };
                    const riskTextStyles = {
                      Low: 'text-emerald-400',
                      Medium: 'text-amber-400',
                      High: 'text-orange-400',
                      Critical: 'text-red-400',
                    };
                    return (
                      <div key={j.code} className={`p-4 rounded-xl border ${riskStyles[j.risk]}`}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-lg font-bold text-white">{j.code}</span>
                          <span className={`text-xs font-medium ${riskTextStyles[j.risk]}`}>{j.risk}</span>
                        </div>
                        <p className="text-xs text-slate-400">{j.name}</p>
                        <div className="mt-2 space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">Flag Rate</span>
                            <span className={riskTextStyles[j.risk]}>{j.flagRate.toFixed(1)}%</span>
                          </div>
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">Confidence</span>
                            <span className="text-slate-300">{j.avgConfidence.toFixed(1)}%</span>
                          </div>
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">Decisions</span>
                            <span className="text-slate-300">{formatNumber(j.decisions)}</span>
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
          {/* PERFORMANCE TAB                                              */}
          {/* ============================================================ */}
          {activeTab === 'performance' && (
            <div className="space-y-8">
              {/* Precision / Recall Over Time */}
              <GlassCard className="p-6">
                <SectionHeader title="Precision / Recall Over Time" subtitle="Model performance metrics (last 9 months)" size="sm" />
                {mounted && (
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={precisionRecall}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="month" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis domain={[85, 100]} tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
                      <RechartsTooltip content={<CustomTooltip formatValue={(v) => `${Number(v).toFixed(1)}%`} />} />
                      <Line type="monotone" dataKey="precision" name="Precision" stroke="#DC2626" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="recall" name="Recall" stroke="#0EA5E9" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="f1" name="F1 Score" stroke="#10B981" strokeWidth={2} dot={false} />
                      <Legend />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </GlassCard>

              {/* False Positive Rates */}
              <GlassCard className="p-6">
                <SectionHeader title="False Positive Rate by Model" subtitle="Weekly FP rate trend (last 12 weeks)" size="sm" />
                {mounted && (
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={fpRateChart}>
                      <defs>
                        <linearGradient id="fpGrad1" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#DC2626" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#DC2626" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="fpGrad2" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#0EA5E9" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#0EA5E9" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="fpGrad3" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#F59E0B" stopOpacity={0.2} />
                          <stop offset="95%" stopColor="#F59E0B" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="week" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
                      <RechartsTooltip content={<CustomTooltip formatValue={(v) => `${Number(v).toFixed(2)}%`} />} />
                      <Area type="monotone" dataKey="sentinel" name="AML Sentinel" stroke="#DC2626" fill="url(#fpGrad1)" strokeWidth={2} />
                      <Area type="monotone" dataKey="sanctions" name="SanctionsNet" stroke="#0EA5E9" fill="url(#fpGrad2)" strokeWidth={2} />
                      <Area type="monotone" dataKey="behavioral" name="Behavioral" stroke="#F59E0B" fill="url(#fpGrad3)" strokeWidth={2} />
                      <Legend />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </GlassCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* BIAS MONITOR TAB                                             */}
          {/* ============================================================ */}
          {activeTab === 'bias' && (
            <GlassCard className="p-6">
              <SectionHeader
                title="Bias Monitoring Dashboard"
                subtitle="Detection rates and false positive rates by category"
                size="sm"
              />
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-700/50">
                      <th className="text-left py-3 px-3 text-xs font-medium text-slate-400">Category</th>
                      <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Detection Rate</th>
                      <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">FP Rate</th>
                      <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Avg Confidence</th>
                      <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Sample Size</th>
                      <th className="text-center py-3 px-3 text-xs font-medium text-slate-400">Bias Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {biasMetrics.map((metric) => {
                      const biasRisk = metric.falsePositiveRate > 5 ? 'High' : metric.falsePositiveRate > 3 ? 'Medium' : 'Low';
                      const biasStyles = {
                        Low: 'bg-emerald-500/20 text-emerald-400',
                        Medium: 'bg-amber-500/20 text-amber-400',
                        High: 'bg-red-500/20 text-red-400',
                      };
                      return (
                        <tr key={metric.category} className="border-b border-slate-800 hover:bg-slate-800/30 transition-colors">
                          <td className="py-3 px-3 text-sm text-white">{metric.category}</td>
                          <td className="py-3 px-3 text-right text-sm text-white tabular-nums">{metric.detectionRate.toFixed(1)}%</td>
                          <td className="py-3 px-3 text-right">
                            <span className={`text-sm font-medium tabular-nums ${metric.falsePositiveRate > 4 ? 'text-red-400' : metric.falsePositiveRate > 2 ? 'text-amber-400' : 'text-emerald-400'}`}>
                              {metric.falsePositiveRate.toFixed(1)}%
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right text-sm text-slate-300 tabular-nums">{metric.avgConfidence.toFixed(1)}%</td>
                          <td className="py-3 px-3 text-right text-sm text-slate-300 tabular-nums">{formatNumber(metric.sampleSize)}</td>
                          <td className="py-3 px-3 text-center">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${biasStyles[biasRisk]}`}>
                              {biasRisk}
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
          {/* APPEALS TAB                                                  */}
          {/* ============================================================ */}
          {(activeTab === 'appeals' || activeTab.startsWith('Appeals')) && (
            <div className="space-y-3">
              {appeals.map((appeal) => {
                const statusStyles: Record<AppealStatus, string> = {
                  Open: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
                  'Under Review': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
                  Resolved: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
                  Rejected: 'bg-red-500/20 text-red-400 border-red-500/30',
                };
                return (
                  <GlassCard key={appeal.id} className="p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="text-xs font-mono text-slate-500">{appeal.id}</span>
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${statusStyles[appeal.status]}`}>
                            {appeal.status}
                          </span>
                          <OutcomeBadge outcome={appeal.originalOutcome} />
                        </div>
                        <p className="text-sm text-white mb-1">{appeal.reason}</p>
                        <div className="flex items-center gap-3 text-xs text-slate-400">
                          <span>By: {appeal.submittedByName}</span>
                          <span>&middot;</span>
                          <span>Decision: {appeal.decisionId}</span>
                          <span>&middot;</span>
                          <span>Filed: {timeAgo(appeal.submittedAt)}</span>
                        </div>
                        {appeal.resolution && (
                          <p className="text-xs text-slate-300 mt-2 p-2 rounded-lg bg-slate-800/40">
                            Resolution: {appeal.resolution}
                          </p>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-semibold text-white tabular-nums">{formatUSD(appeal.amount)}</p>
                        <p className="text-xs text-slate-400">{appeal.currency}</p>
                        {(appeal.status === 'Open' || appeal.status === 'Under Review') && (
                          <button className="mt-2 px-3 py-1 rounded-lg bg-red-600/20 text-red-400 text-xs font-medium hover:bg-red-600/30 transition-colors">
                            Process
                          </button>
                        )}
                      </div>
                    </div>
                  </GlassCard>
                );
              })}
            </div>
          )}

        </main>

        <Footer />
      </div>

      {/* ============================================================ */}
      {/* DECISION DETAIL DRAWER                                       */}
      {/* ============================================================ */}
      <Drawer
        open={selectedDecision !== null}
        onClose={() => setSelectedDecision(null)}
        title={selectedDecision ? `Decision ${selectedDecision.id}` : 'Decision Detail'}
        width="max-w-xl"
      >
        {selectedDecision && (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <OutcomeBadge outcome={selectedDecision.outcome} />
              <Badge variant="neutral">{selectedDecision.modelId}</Badge>
              <Badge variant="info">{selectedDecision.jurisdiction}</Badge>
            </div>

            {/* Summary */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
                <p className="text-xs text-slate-400">Amount</p>
                <p className="text-lg font-bold text-white">{formatUSD(selectedDecision.amount)}</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
                <p className="text-xs text-slate-400">Confidence</p>
                <p className="text-lg font-bold text-white">{selectedDecision.confidence.toFixed(1)}%</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
                <p className="text-xs text-slate-400">Risk Score</p>
                <p className={`text-lg font-bold ${riskColor(selectedDecision.riskScore)}`}>{selectedDecision.riskScore}/100</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
                <p className="text-xs text-slate-400">Processing</p>
                <p className="text-lg font-bold text-white">{selectedDecision.processingTimeMs}ms</p>
              </div>
            </div>

            {/* Factor Analysis */}
            <div>
              <p className="text-xs font-medium text-slate-400 mb-3">Decision Factor Analysis</p>
              <div className="space-y-3">
                {selectedDecision.factors.map((factor, i) => (
                  <div key={i} className="p-3 rounded-xl bg-slate-800/30 border border-slate-700/30">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-white">{factor.name}</span>
                      <span className={`text-sm font-semibold tabular-nums ${riskColor(factor.score)}`}>
                        {factor.score}/100
                      </span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-slate-700/50 overflow-hidden mb-1">
                      <div
                        className={`h-1.5 rounded-full ${riskBarColor(factor.score)}`}
                        style={{ width: `${factor.score}%` }}
                      />
                    </div>
                    <div className="flex justify-between">
                      <span className="text-xs text-slate-500">{factor.description}</span>
                      <span className="text-xs text-slate-500">Weight: {(factor.weight * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Participants */}
            <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <p className="text-xs text-slate-400">Sender</p>
                  <p className="text-sm text-white">{selectedDecision.senderName}</p>
                </div>
                <ArrowRight className="w-4 h-4 text-slate-500" />
                <div className="flex-1">
                  <p className="text-xs text-slate-400">Recipient</p>
                  <p className="text-sm text-white">{selectedDecision.recipientName}</p>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 pt-4 border-t border-slate-700/50">
              <button className="flex-1 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors">
                Override: Approve
              </button>
              <button className="flex-1 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors">
                Escalate
              </button>
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}
