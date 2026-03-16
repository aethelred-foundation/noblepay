/**
 * NoblePay Risk Monitor — Real-Time Risk Monitoring Center
 *
 * Enterprise risk command center with live risk dashboard, transaction
 * monitoring, alert management, counterparty risk profiles, network
 * visualization, anomaly detection, incident management, TEE health,
 * and risk reporting.
 *
 * All mock data uses seededRandom for deterministic SSR hydration.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { SEOHead } from '@/components/SEOHead';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  Legend, ReferenceLine, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
} from 'recharts';
import {
  ShieldAlert, Shield, AlertTriangle, CheckCircle, XCircle,
  ArrowUpRight, ArrowDownRight, Eye, Search, Filter,
  Download, FileText, RefreshCw, Settings, ChevronRight,
  Globe, Target, Activity, TrendingUp, BarChart3,
  Users, Clock, Zap, AlertCircle, Radio,
  Server, Cpu, Lock, Fingerprint, Bell,
  Network, Crosshair, Layers, ChevronDown, X,
  Plus, ArrowRight, ExternalLink, DollarSign,
  Building2, Hash, Flag, Scale, Timer,
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

const RISK_FACTOR_COLORS: Record<string, string> = {
  sanctions: '#EF4444',
  aml: '#F97316',
  jurisdiction: '#F59E0B',
  behavioral: '#8B5CF6',
  network: '#0EA5E9',
  volume: '#10B981',
};


// =============================================================================
// TYPES
// =============================================================================

type AlertSeverity = 'Low' | 'Medium' | 'High' | 'Critical';
type AlertStatus = 'Active' | 'Acknowledged' | 'Resolved' | 'Dismissed';
type IncidentStatus = 'Open' | 'Investigating' | 'Mitigated' | 'Closed';
type TEEStatus = 'Healthy' | 'Degraded' | 'Offline';

interface RiskFactor {
  name: string;
  key: string;
  score: number;
  trend: 'up' | 'down' | 'stable';
  description: string;
}

interface TransactionAlert {
  id: string;
  paymentId: string;
  severity: AlertSeverity;
  status: AlertStatus;
  type: string;
  message: string;
  riskScore: number;
  amount: number;
  currency: string;
  sender: string;
  senderName: string;
  recipient: string;
  recipientName: string;
  jurisdiction: string;
  timestamp: number;
  acknowledgedBy: string | null;
  resolvedAt: number | null;
}

interface CounterpartyProfile {
  address: string;
  name: string;
  jurisdiction: string;
  riskScore: number;
  riskLevel: 'Low' | 'Medium' | 'High' | 'Critical';
  totalTransactions: number;
  totalVolume: number;
  flaggedTransactions: number;
  lastActivity: number;
  watchlisted: boolean;
  tier: 'Standard' | 'Premium' | 'Enterprise';
}

interface NetworkNode {
  id: string;
  name: string;
  type: 'sender' | 'recipient' | 'intermediary';
  riskScore: number;
  connections: number;
  volume: number;
}

interface AnomalyAlert {
  id: string;
  type: 'volume_spike' | 'unusual_pattern' | 'new_counterparty' | 'time_anomaly' | 'frequency_change';
  description: string;
  confidence: number;
  relatedEntities: string[];
  timestamp: number;
  severity: AlertSeverity;
}

interface Incident {
  id: string;
  title: string;
  description: string;
  status: IncidentStatus;
  severity: AlertSeverity;
  category: string;
  createdBy: string;
  createdByName: string;
  createdAt: number;
  updatedAt: number;
  relatedAlerts: number;
  assignedTo: string;
  assignedToName: string;
}

interface TEENode {
  id: string;
  name: string;
  status: TEEStatus;
  attestationValid: boolean;
  lastAttestation: number;
  uptime: number;
  processedCount: number;
  avgLatencyMs: number;
  errorRate: number;
  version: string;
}


// =============================================================================
// MOCK DATA GENERATORS
// =============================================================================

const COMPANY_NAMES = [
  'Meridian Capital LLC', 'Falcon Fintech Solutions', 'Desert Rose Trading',
  'Gulf Stream Finance', 'Phoenix Partners AG', 'Oasis Digital Assets',
  'Atlas Venture Holdings', 'Zenith Corporation', 'Crescent Bay Ventures',
  'Sovereign Wealth Partners', 'Noble Bridge Capital', 'Apex Advisory Group',
  'Titanium Holdings', 'Sapphire Investments', 'Emerald Consulting',
];

const REVIEWER_NAMES = [
  'Sarah Chen', 'Marcus Williams', 'Aisha Al-Rashid', 'James O\'Connor',
  'Elena Petrov', 'David Kim', 'Fatima Hassan', 'Robert Taylor',
];

const JURISDICTIONS = ['AE', 'US', 'GB', 'SG', 'JP', 'DE', 'IN', 'BR', 'NG', 'PK', 'TR', 'ZA'];

const ALERT_TYPES = [
  'Sanctions Match', 'AML Threshold Exceeded', 'Unusual Transaction Pattern',
  'High-Risk Jurisdiction', 'Behavioral Anomaly', 'Network Risk Alert',
  'Volume Spike Detected', 'Counterparty Flagged', 'PEP Match',
  'Structuring Suspicion', 'Cross-Border Threshold', 'Velocity Rule Triggered',
];

const INCIDENT_CATEGORIES = [
  'AML Investigation', 'Sanctions Violation', 'Fraud Suspicion',
  'Regulatory Inquiry', 'System Breach', 'Operational Failure',
  'Policy Violation', 'Customer Complaint',
];

function generateSparklineData(seed: number, count: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < count; i++) {
    data.push(seededRandom(seed + i * 7) * 100);
  }
  return data;
}

function generateRiskFactors(): RiskFactor[] {
  return [
    { name: 'Sanctions Exposure', key: 'sanctions', score: 18, trend: 'down', description: 'OFAC/UN/EU sanctions list proximity risk' },
    { name: 'AML Risk Score', key: 'aml', score: 32, trend: 'stable', description: 'Anti-money laundering pattern detection' },
    { name: 'Jurisdiction Risk', key: 'jurisdiction', score: 24, trend: 'up', description: 'Aggregate jurisdiction risk across corridors' },
    { name: 'Behavioral Analysis', key: 'behavioral', score: 15, trend: 'down', description: 'Transaction behavior pattern analysis' },
    { name: 'Network Topology', key: 'network', score: 21, trend: 'stable', description: 'Payment network graph risk assessment' },
    { name: 'Volume Anomaly', key: 'volume', score: 28, trend: 'up', description: 'Transaction volume deviation from baseline' },
    { name: 'High-Risk Corridors', key: 'corridors', score: 72, trend: 'up', description: 'Elevated risk from high-risk payment corridors' },
    { name: 'Fraud Detection', key: 'fraud', score: 88, trend: 'stable', description: 'ML-based fraud detection scoring' },
  ];
}

function generateAlerts(count: number): TransactionAlert[] {
  const alerts: TransactionAlert[] = [];
  const severities: AlertSeverity[] = ['Low', 'Medium', 'High', 'Critical'];
  const statuses: AlertStatus[] = ['Active', 'Active', 'Acknowledged', 'Resolved', 'Dismissed'];
  const currencies = ['USDC', 'USDT', 'AET', 'AED'];

  for (let i = 0; i < count; i++) {
    const seed = 80000 + i * 137;
    const severity = severities[Math.floor(seededRandom(seed) * severities.length)];
    const status = statuses[Math.floor(seededRandom(seed + 10) * statuses.length)];
    alerts.push({
      id: `ALT-${String(6000 + i).padStart(5, '0')}`,
      paymentId: `0x${seededHex(seed + 20, 16)}`,
      severity,
      status,
      type: ALERT_TYPES[Math.floor(seededRandom(seed + 30) * ALERT_TYPES.length)],
      message: `${ALERT_TYPES[Math.floor(seededRandom(seed + 30) * ALERT_TYPES.length)]} detected for transaction.`,
      riskScore: severity === 'Critical' ? 75 + Math.floor(seededRandom(seed + 40) * 25)
        : severity === 'High' ? 50 + Math.floor(seededRandom(seed + 40) * 25)
        : severity === 'Medium' ? 25 + Math.floor(seededRandom(seed + 40) * 25)
        : Math.floor(seededRandom(seed + 40) * 25),
      amount: i === 0 ? 500 : Math.floor(seededRandom(seed + 50) * 500000) + 5000,
      currency: currencies[Math.floor(seededRandom(seed + 60) * currencies.length)],
      sender: seededAddress(seed + 70),
      senderName: COMPANY_NAMES[Math.floor(seededRandom(seed + 80) * COMPANY_NAMES.length)],
      recipient: seededAddress(seed + 90),
      recipientName: COMPANY_NAMES[Math.floor(seededRandom(seed + 100) * COMPANY_NAMES.length)],
      jurisdiction: JURISDICTIONS[Math.floor(seededRandom(seed + 110) * JURISDICTIONS.length)],
      timestamp: Date.now() - Math.floor(seededRandom(seed + 120) * 604800000),
      acknowledgedBy: status === 'Acknowledged' || status === 'Resolved'
        ? REVIEWER_NAMES[Math.floor(seededRandom(seed + 130) * REVIEWER_NAMES.length)]
        : null,
      resolvedAt: status === 'Resolved' ? Date.now() - Math.floor(seededRandom(seed + 140) * 172800000) : null,
    });
  }
  return alerts.sort((a, b) => b.timestamp - a.timestamp);
}

function generateCounterparties(): CounterpartyProfile[] {
  const profiles: CounterpartyProfile[] = [];
  const riskLevels: CounterpartyProfile['riskLevel'][] = ['Low', 'Low', 'Medium', 'High', 'Critical'];
  const tiers: CounterpartyProfile['tier'][] = ['Standard', 'Premium', 'Enterprise'];

  for (let i = 0; i < 12; i++) {
    const seed = 81000 + i * 113;
    const riskLevel = riskLevels[Math.floor(seededRandom(seed) * riskLevels.length)];
    profiles.push({
      address: seededAddress(seed + 10),
      name: COMPANY_NAMES[i % COMPANY_NAMES.length],
      jurisdiction: JURISDICTIONS[Math.floor(seededRandom(seed + 20) * JURISDICTIONS.length)],
      riskScore: riskLevel === 'Low' ? Math.floor(seededRandom(seed + 30) * 25)
        : riskLevel === 'Medium' ? 25 + Math.floor(seededRandom(seed + 30) * 25)
        : riskLevel === 'High' ? 50 + Math.floor(seededRandom(seed + 30) * 25)
        : 75 + Math.floor(seededRandom(seed + 30) * 25),
      riskLevel,
      totalTransactions: Math.floor(seededRandom(seed + 40) * 5000) + 100,
      totalVolume: Math.floor(seededRandom(seed + 50) * 10000000) + 100000,
      flaggedTransactions: Math.floor(seededRandom(seed + 60) * 50),
      lastActivity: Date.now() - Math.floor(seededRandom(seed + 70) * 2592000000),
      watchlisted: riskLevel === 'High' || riskLevel === 'Critical',
      tier: tiers[Math.floor(seededRandom(seed + 80) * tiers.length)],
    });
  }
  return profiles;
}

function generateAnomalies(): AnomalyAlert[] {
  const anomalies: AnomalyAlert[] = [];
  const types: AnomalyAlert['type'][] = ['volume_spike', 'unusual_pattern', 'new_counterparty', 'time_anomaly', 'frequency_change'];
  const descriptions = [
    'Transaction volume 3.2x above rolling 30-day average',
    'Unusual payment pattern detected: round numbers with 5min intervals',
    'New counterparty with links to high-risk jurisdiction',
    'Off-hours activity spike: 92% increase in 2am-5am window',
    'Payment frequency increased 400% from baseline',
    'Sudden shift in payment corridor: US to PK new route',
    'Multiple small transactions below reporting threshold',
    'Dormant account reactivated with large outbound transfer',
  ];

  for (let i = 0; i < 8; i++) {
    const seed = 82000 + i * 97;
    anomalies.push({
      id: `ANM-${String(7000 + i).padStart(5, '0')}`,
      type: types[Math.floor(seededRandom(seed) * types.length)],
      description: descriptions[Math.floor(seededRandom(seed + 10) * descriptions.length)],
      confidence: 60 + seededRandom(seed + 20) * 35,
      relatedEntities: [
        COMPANY_NAMES[Math.floor(seededRandom(seed + 30) * COMPANY_NAMES.length)],
        COMPANY_NAMES[Math.floor(seededRandom(seed + 40) * COMPANY_NAMES.length)],
      ],
      timestamp: Date.now() - Math.floor(seededRandom(seed + 50) * 604800000),
      severity: (['Medium', 'High', 'Critical'] as const)[Math.floor(seededRandom(seed + 60) * 3)],
    });
  }
  return anomalies.sort((a, b) => b.timestamp - a.timestamp);
}

function generateIncidents(): Incident[] {
  const incidents: Incident[] = [];
  const statuses: IncidentStatus[] = ['Open', 'Investigating', 'Mitigated', 'Closed'];
  const titles = [
    'Suspected structuring activity — Gulf Stream Finance',
    'Sanctions near-match investigation — Atlas Ventures',
    'AML threshold breach — Cross-border corridor AE-PK',
    'Unusual pattern detection — Midnight transactions',
    'Regulatory inquiry — DFSA compliance review',
    'Counterparty flagged — Updated OFAC list match',
  ];

  for (let i = 0; i < 6; i++) {
    const seed = 83000 + i * 113;
    const status = statuses[Math.floor(seededRandom(seed) * statuses.length)];
    incidents.push({
      id: `INC-${String(8000 + i).padStart(5, '0')}`,
      title: titles[i],
      description: `Compliance incident requiring investigation and documentation.`,
      status,
      severity: (['Medium', 'High', 'Critical'] as const)[Math.floor(seededRandom(seed + 10) * 3)],
      category: INCIDENT_CATEGORIES[Math.floor(seededRandom(seed + 20) * INCIDENT_CATEGORIES.length)],
      createdBy: seededAddress(seed + 30),
      createdByName: REVIEWER_NAMES[Math.floor(seededRandom(seed + 40) * REVIEWER_NAMES.length)],
      createdAt: Date.now() - Math.floor(seededRandom(seed + 50) * 2592000000),
      updatedAt: Date.now() - Math.floor(seededRandom(seed + 60) * 604800000),
      relatedAlerts: Math.floor(seededRandom(seed + 70) * 15) + 1,
      assignedTo: seededAddress(seed + 80),
      assignedToName: REVIEWER_NAMES[Math.floor(seededRandom(seed + 90) * REVIEWER_NAMES.length)],
    });
  }
  return incidents;
}

function generateTEENodes(): TEENode[] {
  return [
    { id: 'TEE-01', name: 'SGX Primary', status: 'Healthy', attestationValid: true, lastAttestation: Date.now() - 120000, uptime: 99.97, processedCount: 487231, avgLatencyMs: 38, errorRate: 0.01, version: 'v2.4.1' },
    { id: 'TEE-02', name: 'SGX Secondary', status: 'Healthy', attestationValid: true, lastAttestation: Date.now() - 180000, uptime: 99.94, processedCount: 412890, avgLatencyMs: 41, errorRate: 0.02, version: 'v2.4.1' },
    { id: 'TEE-03', name: 'TDX Compliance', status: 'Healthy', attestationValid: true, lastAttestation: Date.now() - 90000, uptime: 99.99, processedCount: 298456, avgLatencyMs: 35, errorRate: 0.005, version: 'v2.4.1' },
    { id: 'TEE-04', name: 'SEV Backup', status: 'Degraded', attestationValid: true, lastAttestation: Date.now() - 600000, uptime: 98.23, processedCount: 156789, avgLatencyMs: 67, errorRate: 0.15, version: 'v2.3.8' },
    { id: 'TEE-05', name: 'SGX Failover', status: 'Offline', attestationValid: false, lastAttestation: Date.now() - 7200000, uptime: 0, processedCount: 89234, avgLatencyMs: 0, errorRate: 100, version: 'v2.4.0' },
  ];
}

function generateRiskScoreChart(): Array<{ date: string; overall: number; sanctions: number; aml: number; behavioral: number }> {
  const dates = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12'];
  return dates.map((date, i) => ({
    date,
    overall: 20 + seededRandom(84000 + i * 41) * 15,
    sanctions: 10 + seededRandom(84000 + i * 53) * 20,
    aml: 25 + seededRandom(84000 + i * 67) * 20,
    behavioral: 12 + seededRandom(84000 + i * 79) * 18,
  }));
}

function generateAlertFrequency(): Array<{ day: string; low: number; medium: number; high: number; critical: number }> {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return days.map((day, i) => ({
    day,
    low: Math.floor(seededRandom(85000 + i * 31) * 20) + 5,
    medium: Math.floor(seededRandom(85000 + i * 47) * 12) + 3,
    high: Math.floor(seededRandom(85000 + i * 61) * 6) + 1,
    critical: Math.floor(seededRandom(85000 + i * 73) * 3),
  }));
}

function generateResolutionTimes(): Array<{ category: string; avgHours: number; fill: string }> {
  return [
    { category: 'Sanctions', avgHours: 2.4, fill: '#EF4444' },
    { category: 'AML', avgHours: 8.2, fill: '#F97316' },
    { category: 'Behavioral', avgHours: 12.5, fill: '#8B5CF6' },
    { category: 'Jurisdiction', avgHours: 4.1, fill: '#F59E0B' },
    { category: 'Network', avgHours: 6.8, fill: '#0EA5E9' },
    { category: 'Volume', avgHours: 3.2, fill: '#10B981' },
  ];
}

function generateRadarData(): Array<{ factor: string; score: number; fullMark: number }> {
  return [
    { factor: 'Sanctions', score: 18, fullMark: 100 },
    { factor: 'AML', score: 32, fullMark: 100 },
    { factor: 'Jurisdiction', score: 24, fullMark: 100 },
    { factor: 'Behavioral', score: 15, fullMark: 100 },
    { factor: 'Network', score: 21, fullMark: 100 },
    { factor: 'Volume', score: 28, fullMark: 100 },
  ];
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

function riskBgColor(score: number): string {
  if (score < 30) return 'bg-emerald-500';
  if (score < 60) return 'bg-amber-500';
  if (score < 80) return 'bg-orange-500';
  return 'bg-red-500';
}


// =============================================================================
// REUSABLE LOCAL COMPONENTS
// =============================================================================

function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const styles: Record<AlertSeverity, string> = {
    Low: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    Medium: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    High: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
    Critical: 'bg-red-500/20 text-red-400 border-red-500/30',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles[severity]}`}>
      {severity}
    </span>
  );
}

function AlertStatusBadge({ status }: { status: AlertStatus }) {
  const styles: Record<AlertStatus, string> = {
    Active: 'bg-red-500/20 text-red-400',
    Acknowledged: 'bg-amber-500/20 text-amber-400',
    Resolved: 'bg-emerald-500/20 text-emerald-400',
    Dismissed: 'bg-slate-500/20 text-slate-400',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${styles[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${status === 'Active' ? 'bg-red-400 animate-pulse' : status === 'Acknowledged' ? 'bg-amber-400' : status === 'Resolved' ? 'bg-emerald-400' : 'bg-slate-400'}`} />
      {status}
    </span>
  );
}

function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  const styles: Record<IncidentStatus, string> = {
    Open: 'bg-red-500/20 text-red-400 border-red-500/30',
    Investigating: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    Mitigated: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    Closed: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles[status]}`}>
      {status}
    </span>
  );
}

function TEEStatusBadge({ status }: { status: TEEStatus }) {
  const styles: Record<TEEStatus, string> = {
    Healthy: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    Degraded: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    Offline: 'bg-red-500/20 text-red-400 border-red-500/30',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${status === 'Healthy' ? 'bg-emerald-400 animate-pulse' : status === 'Degraded' ? 'bg-amber-400' : 'bg-red-400'}`} />
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

function CustomTooltip({ active, payload, label, formatValue }: {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number | string }>;
  label?: string;
  formatValue?: (v: number | string) => string;
}) {
  if (!active || !payload?.length) return null;
  const fmt = formatValue || ((v: number | string) => typeof v === 'number' ? `${v.toFixed(1)}` : String(v));
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

export default function RiskMonitorPage() {
  const { realTime } = useApp();
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [alertFilter, setAlertFilter] = useState<'all' | AlertSeverity>('all');
  const [selectedAlert, setSelectedAlert] = useState<TransactionAlert | null>(null);
  const [showCreateIncident, setShowCreateIncident] = useState(false);
  useEffect(() => setMounted(true), []);

  // Generate all mock data deterministically
  const riskFactors = useMemo(() => generateRiskFactors(), []);
  const alerts = useMemo(() => generateAlerts(20), []);
  const counterparties = useMemo(() => generateCounterparties(), []);
  const anomalies = useMemo(() => generateAnomalies(), []);
  const incidents = useMemo(() => generateIncidents(), []);
  const teeNodes = useMemo(() => generateTEENodes(), []);
  const riskScoreChart = useMemo(() => generateRiskScoreChart(), []);
  const alertFrequency = useMemo(() => generateAlertFrequency(), []);
  const resolutionTimes = useMemo(() => generateResolutionTimes(), []);
  const radarData = useMemo(() => generateRadarData(), []);

  const filteredAlerts = useMemo(() => {
    if (alertFilter === 'all') return alerts;
    return alerts.filter(a => a.severity === alertFilter);
  }, [alerts, alertFilter]);

  const overallRiskScore = useMemo(() =>
    Math.round(riskFactors.reduce((s, f) => s + f.score, 0) / riskFactors.length),
    [riskFactors]
  );
  const activeAlertCount = alerts.filter(a => a.status === 'Active').length;
  const openIncidents = incidents.filter(i => i.status !== 'Closed').length;
  const healthyNodes = teeNodes.filter(n => n.status === 'Healthy').length;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'alerts', label: `Alerts (${activeAlertCount})` },
    { id: 'counterparties', label: 'Counterparties' },
    { id: 'anomalies', label: 'Anomalies' },
    { id: 'incidents', label: `Incidents (${openIncidents})` },
    { id: 'tee', label: 'TEE Health' },
    { id: 'charts', label: 'Reports' },
  ];

  return (
    <>
      <SEOHead
        title="Risk Monitor"
        description="NoblePay real-time risk monitoring center with alert management, anomaly detection, and TEE health."
        path="/risk-monitor"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/risk-monitor" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* ============================================================ */}
          {/* HEADER                                                       */}
          {/* ============================================================ */}
          <div className="mb-8">
            <div className="flex items-start justify-between mb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay Risk</p>
                <h1 className="mt-2 text-3xl font-bold text-white">Risk Monitoring Center</h1>
                <p className="mt-1 text-sm text-slate-400">Enterprise risk command center with real-time transaction monitoring and TEE health</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCreateIncident(true)}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-medium text-slate-300 hover:border-slate-500 hover:text-white transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  New Incident
                </button>
                <button className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors">
                  <FileText className="w-4 h-4" />
                  Risk Report
                </button>
              </div>
            </div>

            {/* STAT CARDS */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard
                icon={ShieldAlert}
                label="Overall Risk"
                value={`${overallRiskScore}/100`}
                change={{ value: '-2 this week', positive: true }}
                sparkData={generateSparklineData(90000, 12)}
                sparkColor={overallRiskScore > 50 ? '#EF4444' : overallRiskScore > 30 ? '#F59E0B' : '#10B981'}
              />
              <StatCard
                icon={Bell}
                label="Active Alerts"
                value={String(activeAlertCount)}
                change={{ value: `${alerts.filter(a => a.severity === 'Critical').length} critical`, positive: false }}
              />
              <StatCard
                icon={Flag}
                label="Open Incidents"
                value={String(openIncidents)}
                change={{ value: `${incidents.filter(i => i.status === 'Investigating').length} investigating`, positive: false }}
              />
              <StatCard
                icon={Crosshair}
                label="Anomalies"
                value={String(anomalies.length)}
                sparkData={generateSparklineData(90100, 12)}
                sparkColor="#8B5CF6"
              />
              <StatCard
                icon={Server}
                label="TEE Nodes"
                value={`${healthyNodes}/${teeNodes.length}`}
                change={{ value: `${teeNodes.filter(n => n.status === 'Offline').length} offline`, positive: healthyNodes === teeNodes.length }}
              />
              <StatCard
                icon={Clock}
                label="Avg Resolution"
                value="4.2h"
                change={{ value: '-1.3h this week', positive: true }}
              />
            </div>
          </div>

          {/* TABS */}
          <div className="mb-6 overflow-x-auto">
            <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
          </div>

          {/* ============================================================ */}
          {/* OVERVIEW TAB                                                 */}
          {/* ============================================================ */}
          {activeTab === 'overview' && (
            <div className="space-y-8">
              {/* Risk Radar & Factors */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <GlassCard className="p-6">
                  <SectionHeader title="Risk Radar" subtitle="System-wide risk profile" size="sm" />
                  {mounted && (
                    <ResponsiveContainer width="100%" height={250}>
                      <RadarChart data={radarData}>
                        <PolarGrid stroke="#334155" />
                        <PolarAngleAxis dataKey="factor" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                        <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 10 }} />
                        <Radar name="Risk Score" dataKey="score" stroke="#DC2626" fill="#DC2626" fillOpacity={0.2} strokeWidth={2} />
                      </RadarChart>
                    </ResponsiveContainer>
                  )}
                </GlassCard>

                <GlassCard className="lg:col-span-2 p-6">
                  <SectionHeader title="Risk Factor Breakdown" subtitle="Contributing factors to system risk" size="sm" />
                  <div className="space-y-4">
                    {riskFactors.map((factor) => (
                      <div key={factor.key} className="flex items-center gap-4">
                        <div className="w-4 h-4 rounded-full" style={{ backgroundColor: RISK_FACTOR_COLORS[factor.key] }} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-sm font-medium text-white">{factor.name}</span>
                            <div className="flex items-center gap-2">
                              <span className={`text-sm font-semibold tabular-nums ${riskColor(factor.score)}`}>
                                {factor.score}/100
                              </span>
                              {factor.trend === 'up' && <ArrowUpRight className="w-3 h-3 text-red-400" />}
                              {factor.trend === 'down' && <ArrowDownRight className="w-3 h-3 text-emerald-400" />}
                              {factor.trend === 'stable' && <ArrowRight className="w-3 h-3 text-slate-400" />}
                            </div>
                          </div>
                          <div className="w-full h-2 rounded-full bg-slate-700/50 overflow-hidden">
                            <div
                              className={`h-2 rounded-full transition-all duration-500 ${riskBgColor(factor.score)}`}
                              style={{ width: `${factor.score}%` }}
                            />
                          </div>
                          <p className="text-xs text-slate-500 mt-1">{factor.description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </GlassCard>
              </div>

              {/* Recent Alerts & Anomalies */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <GlassCard className="p-6">
                  <SectionHeader title="Recent Alerts" subtitle="Latest active alerts" size="sm" />
                  <div className="space-y-3">
                    {alerts.slice(0, 5).map((alert) => (
                      <div
                        key={alert.id}
                        className="flex items-start gap-3 p-3 rounded-xl hover:bg-slate-800/30 transition-colors cursor-pointer"
                        onClick={() => setSelectedAlert(alert)}
                      >
                        <AlertTriangle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${
                          alert.severity === 'Critical' ? 'text-red-400' :
                          alert.severity === 'High' ? 'text-orange-400' :
                          alert.severity === 'Medium' ? 'text-amber-400' :
                          'text-blue-400'
                        }`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-sm text-white truncate">{alert.type}</span>
                            <SeverityBadge severity={alert.severity} />
                          </div>
                          <p className="text-xs text-slate-400">{alert.senderName} &middot; {formatUSD(alert.amount)} &middot; {timeAgo(alert.timestamp)}</p>
                        </div>
                        <AlertStatusBadge status={alert.status} />
                      </div>
                    ))}
                  </div>
                </GlassCard>

                <GlassCard className="p-6">
                  <SectionHeader title="Anomaly Detection" subtitle="AI-detected unusual patterns" size="sm" />
                  <div className="space-y-3">
                    {anomalies.slice(0, 5).map((anomaly) => (
                      <div key={anomaly.id} className="p-3 rounded-xl bg-slate-800/30 border border-slate-700/30">
                        <div className="flex items-center gap-2 mb-1">
                          <Crosshair className="w-3.5 h-3.5 text-purple-400" />
                          <SeverityBadge severity={anomaly.severity} />
                          <span className="text-xs text-slate-500">{anomaly.id}</span>
                        </div>
                        <p className="text-sm text-white mb-1">{anomaly.description}</p>
                        <div className="flex items-center gap-3 text-xs text-slate-400">
                          <span>Confidence: {anomaly.confidence.toFixed(0)}%</span>
                          <span>&middot;</span>
                          <span>{anomaly.relatedEntities.join(', ')}</span>
                          <span>&middot;</span>
                          <span>{timeAgo(anomaly.timestamp)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </GlassCard>
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* ALERTS TAB                                                   */}
          {/* ============================================================ */}
          {(activeTab === 'alerts' || activeTab.startsWith('Alerts')) && (
            <div className="space-y-6">
              <div className="flex items-center gap-2">
                {(['all', 'Critical', 'High', 'Medium', 'Low'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setAlertFilter(filter)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      alertFilter === filter ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {filter === 'all' ? 'All' : filter}
                    <span className="ml-1.5 text-slate-500">
                      {filter === 'all' ? alerts.length : alerts.filter(a => a.severity === filter).length}
                    </span>
                  </button>
                ))}
              </div>

              <div className="space-y-3">
                {filteredAlerts.map((alert) => (
                  <GlassCard
                    key={alert.id}
                    className={`p-4 cursor-pointer ${alert.status === 'Active' && alert.severity === 'Critical' ? 'border-l-2 border-l-red-500' : ''}`}
                    hover
                    onClick={() => setSelectedAlert(alert)}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="text-xs font-mono text-slate-500">{alert.id}</span>
                          <SeverityBadge severity={alert.severity} />
                          <AlertStatusBadge status={alert.status} />
                        </div>
                        <p className="text-sm font-medium text-white">{alert.type}</p>
                        <p className="text-xs text-slate-400 mt-1">{alert.message}</p>
                        <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
                          <span>{alert.senderName} &rarr; {alert.recipientName}</span>
                          <span>&middot;</span>
                          <span>{alert.jurisdiction}</span>
                          <span>&middot;</span>
                          <span>{timeAgo(alert.timestamp)}</span>
                          {alert.acknowledgedBy && (
                            <>
                              <span>&middot;</span>
                              <span>Ack by {alert.acknowledgedBy}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="text-sm font-semibold text-white tabular-nums">{formatUSD(alert.amount)}</p>
                        <p className="text-xs text-slate-400">{alert.currency}</p>
                        <div className="mt-1">
                          <span className={`text-xs font-medium tabular-nums ${riskColor(alert.riskScore)}`}>
                            Risk: {alert.riskScore}/100
                          </span>
                        </div>
                      </div>
                    </div>
                  </GlassCard>
                ))}
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* COUNTERPARTIES TAB                                           */}
          {/* ============================================================ */}
          {activeTab === 'counterparties' && (
            <GlassCard className="p-6">
              <SectionHeader title="Counterparty Risk Profiles" subtitle="Entity risk assessment and transaction history" size="sm" />
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-700/50">
                      <th className="text-left py-3 px-3 text-xs font-medium text-slate-400">Entity</th>
                      <th className="text-center py-3 px-3 text-xs font-medium text-slate-400">Risk</th>
                      <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Risk Score</th>
                      <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Volume</th>
                      <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Txns</th>
                      <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Flagged</th>
                      <th className="text-center py-3 px-3 text-xs font-medium text-slate-400">Watchlist</th>
                      <th className="text-right py-3 px-3 text-xs font-medium text-slate-400">Last Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {counterparties.map((cp) => {
                      const riskStyles = {
                        Low: 'bg-emerald-500/20 text-emerald-400',
                        Medium: 'bg-amber-500/20 text-amber-400',
                        High: 'bg-orange-500/20 text-orange-400',
                        Critical: 'bg-red-500/20 text-red-400',
                      };
                      return (
                        <tr key={cp.address} className="border-b border-slate-800 hover:bg-slate-800/30 transition-colors">
                          <td className="py-3 px-3">
                            <div className="flex items-center gap-2">
                              <Building2 className="w-4 h-4 text-slate-400" />
                              <div>
                                <p className="text-sm font-medium text-white">{cp.name}</p>
                                <p className="text-xs text-slate-500">{cp.jurisdiction} &middot; {cp.tier}</p>
                              </div>
                            </div>
                          </td>
                          <td className="py-3 px-3 text-center">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${riskStyles[cp.riskLevel]}`}>
                              {cp.riskLevel}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right">
                            <span className={`text-sm font-semibold tabular-nums ${riskColor(cp.riskScore)}`}>{cp.riskScore}</span>
                          </td>
                          <td className="py-3 px-3 text-right text-sm text-white tabular-nums">{formatUSD(cp.totalVolume)}</td>
                          <td className="py-3 px-3 text-right text-sm text-slate-300 tabular-nums">{formatNumber(cp.totalTransactions)}</td>
                          <td className="py-3 px-3 text-right">
                            <span className={`text-sm tabular-nums ${cp.flaggedTransactions > 10 ? 'text-red-400' : 'text-slate-300'}`}>
                              {cp.flaggedTransactions}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-center">
                            {cp.watchlisted ? (
                              <Eye className="w-4 h-4 text-red-400 mx-auto" />
                            ) : (
                              <span className="text-xs text-slate-600">—</span>
                            )}
                          </td>
                          <td className="py-3 px-3 text-right text-xs text-slate-400">{timeAgo(cp.lastActivity)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </GlassCard>
          )}

          {/* ============================================================ */}
          {/* ANOMALIES TAB                                                */}
          {/* ============================================================ */}
          {activeTab === 'anomalies' && (
            <div className="space-y-3">
              {anomalies.map((anomaly) => {
                const typeIcons = {
                  volume_spike: <TrendingUp className="w-4 h-4 text-red-400" />,
                  unusual_pattern: <Activity className="w-4 h-4 text-purple-400" />,
                  new_counterparty: <Users className="w-4 h-4 text-amber-400" />,
                  time_anomaly: <Clock className="w-4 h-4 text-blue-400" />,
                  frequency_change: <Zap className="w-4 h-4 text-orange-400" />,
                };
                const typeLabels = {
                  volume_spike: 'Volume Spike',
                  unusual_pattern: 'Unusual Pattern',
                  new_counterparty: 'New Counterparty',
                  time_anomaly: 'Time Anomaly',
                  frequency_change: 'Frequency Change',
                };
                return (
                  <GlassCard key={anomaly.id} className="p-5">
                    <div className="flex items-start gap-4">
                      <div className="p-2 rounded-lg bg-slate-800/60 border border-slate-700/30">
                        {typeIcons[anomaly.type]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2">
                          <span className="text-xs font-mono text-slate-500">{anomaly.id}</span>
                          <SeverityBadge severity={anomaly.severity} />
                          <Badge variant="neutral">{typeLabels[anomaly.type]}</Badge>
                        </div>
                        <p className="text-sm text-white mb-2">{anomaly.description}</p>
                        <div className="flex items-center gap-3 text-xs text-slate-400">
                          <span>Confidence: <span className="text-white">{anomaly.confidence.toFixed(0)}%</span></span>
                          <span>&middot;</span>
                          <span>Related: {anomaly.relatedEntities.join(', ')}</span>
                          <span>&middot;</span>
                          <span>{timeAgo(anomaly.timestamp)}</span>
                        </div>
                      </div>
                      <button className="px-3 py-1.5 rounded-lg bg-red-600/20 text-red-400 text-xs font-medium hover:bg-red-600/30 transition-colors flex-shrink-0">
                        Investigate
                      </button>
                    </div>
                  </GlassCard>
                );
              })}
            </div>
          )}

          {/* ============================================================ */}
          {/* INCIDENTS TAB                                                */}
          {/* ============================================================ */}
          {(activeTab === 'incidents' || activeTab.startsWith('Incidents')) && (
            <div className="space-y-3">
              {incidents.map((incident) => (
                <GlassCard key={incident.id} className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="text-xs font-mono text-slate-500">{incident.id}</span>
                        <IncidentStatusBadge status={incident.status} />
                        <SeverityBadge severity={incident.severity} />
                        <Badge variant="neutral">{incident.category}</Badge>
                      </div>
                      <h3 className="text-sm font-semibold text-white mb-1">{incident.title}</h3>
                      <p className="text-xs text-slate-400">{incident.description}</p>
                      <div className="flex items-center gap-3 mt-3 text-xs text-slate-400">
                        <span>Created by {incident.createdByName}</span>
                        <span>&middot;</span>
                        <span>Assigned to {incident.assignedToName}</span>
                        <span>&middot;</span>
                        <span>{incident.relatedAlerts} related alerts</span>
                        <span>&middot;</span>
                        <span>Updated {timeAgo(incident.updatedAt)}</span>
                      </div>
                    </div>
                    <div className="flex-shrink-0">
                      <button className="px-3 py-1.5 rounded-lg bg-slate-800 text-xs text-slate-300 hover:text-white hover:bg-slate-700 transition-colors">
                        View Details
                      </button>
                    </div>
                  </div>
                </GlassCard>
              ))}
            </div>
          )}

          {/* ============================================================ */}
          {/* TEE HEALTH TAB                                               */}
          {/* ============================================================ */}
          {activeTab === 'tee' && (
            <div className="space-y-4">
              {teeNodes.map((node) => (
                <GlassCard key={node.id} className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div className={`p-2 rounded-lg ${
                        node.status === 'Healthy' ? 'bg-emerald-500/10 border border-emerald-500/20' :
                        node.status === 'Degraded' ? 'bg-amber-500/10 border border-amber-500/20' :
                        'bg-red-500/10 border border-red-500/20'
                      }`}>
                        <Server className={`w-5 h-5 ${
                          node.status === 'Healthy' ? 'text-emerald-400' :
                          node.status === 'Degraded' ? 'text-amber-400' :
                          'text-red-400'
                        }`} />
                      </div>
                      <div>
                        <h3 className="text-lg font-semibold text-white">{node.name}</h3>
                        <p className="text-xs text-slate-400">{node.id} &middot; {node.version}</p>
                      </div>
                    </div>
                    <TEEStatusBadge status={node.status} />
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4">
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">Attestation</p>
                      <p className={`text-sm font-semibold ${node.attestationValid ? 'text-emerald-400' : 'text-red-400'}`}>
                        {node.attestationValid ? 'Valid' : 'Invalid'}
                      </p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">Last Attested</p>
                      <p className="text-sm font-semibold text-white">{timeAgo(node.lastAttestation)}</p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">Uptime</p>
                      <p className={`text-sm font-semibold ${node.uptime > 99.9 ? 'text-emerald-400' : node.uptime > 99 ? 'text-amber-400' : 'text-red-400'}`}>
                        {node.uptime.toFixed(2)}%
                      </p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">Processed</p>
                      <p className="text-sm font-semibold text-white">{formatNumber(node.processedCount)}</p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">Avg Latency</p>
                      <p className="text-sm font-semibold text-white">{node.avgLatencyMs}ms</p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">Error Rate</p>
                      <p className={`text-sm font-semibold ${node.errorRate < 0.1 ? 'text-emerald-400' : node.errorRate < 1 ? 'text-amber-400' : 'text-red-400'}`}>
                        {node.errorRate < 1 ? `${(node.errorRate * 100).toFixed(0)}bps` : `${node.errorRate.toFixed(1)}%`}
                      </p>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-800/40">
                      <p className="text-xs text-slate-400">Version</p>
                      <p className="text-sm font-semibold text-white">{node.version}</p>
                    </div>
                  </div>
                </GlassCard>
              ))}
            </div>
          )}

          {/* ============================================================ */}
          {/* REPORTS/CHARTS TAB                                           */}
          {/* ============================================================ */}
          {activeTab === 'charts' && (
            <div className="space-y-8">
              {/* Risk Score Trends */}
              <GlassCard className="p-6">
                <SectionHeader title="Risk Score Trends" subtitle="Weekly risk score by category (last 12 weeks)" size="sm" />
                {mounted && (
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={riskScoreChart}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                      <RechartsTooltip content={<CustomTooltip />} />
                      <Line type="monotone" dataKey="overall" name="Overall" stroke="#DC2626" strokeWidth={2.5} dot={false} />
                      <Line type="monotone" dataKey="sanctions" name="Sanctions" stroke="#EF4444" strokeWidth={1.5} dot={false} strokeDasharray="5 5" />
                      <Line type="monotone" dataKey="aml" name="AML" stroke="#F97316" strokeWidth={1.5} dot={false} strokeDasharray="5 5" />
                      <Line type="monotone" dataKey="behavioral" name="Behavioral" stroke="#8B5CF6" strokeWidth={1.5} dot={false} strokeDasharray="5 5" />
                      <Legend />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </GlassCard>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Alert Frequency */}
                <GlassCard className="p-6">
                  <SectionHeader title="Alert Frequency" subtitle="Alerts by severity (this week)" size="sm" />
                  {mounted && (
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={alertFrequency}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="day" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} />
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Bar dataKey="critical" name="Critical" fill="#EF4444" stackId="alerts" radius={[0, 0, 0, 0]} />
                        <Bar dataKey="high" name="High" fill="#F97316" stackId="alerts" radius={[0, 0, 0, 0]} />
                        <Bar dataKey="medium" name="Medium" fill="#F59E0B" stackId="alerts" radius={[0, 0, 0, 0]} />
                        <Bar dataKey="low" name="Low" fill="#0EA5E9" stackId="alerts" radius={[4, 4, 0, 0]} />
                        <Legend />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </GlassCard>

                {/* Resolution Times */}
                <GlassCard className="p-6">
                  <SectionHeader title="Avg Resolution Time" subtitle="By alert category (hours)" size="sm" />
                  {mounted && (
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={resolutionTimes} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}h`} />
                        <YAxis dataKey="category" type="category" tick={{ fill: '#94a3b8', fontSize: 12 }} axisLine={false} tickLine={false} width={90} />
                        <RechartsTooltip content={<CustomTooltip formatValue={(v) => `${Number(v).toFixed(1)} hours`} />} />
                        <Bar dataKey="avgHours" name="Avg Hours" radius={[0, 6, 6, 0]}>
                          {resolutionTimes.map((entry, i) => (
                            <Cell key={i} fill={entry.fill} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </GlassCard>
              </div>
            </div>
          )}

        </main>

        <Footer />
      </div>

      {/* ============================================================ */}
      {/* ALERT DETAIL DRAWER                                          */}
      {/* ============================================================ */}
      <Drawer
        open={selectedAlert !== null}
        onClose={() => setSelectedAlert(null)}
        title={selectedAlert ? `Alert ${selectedAlert.id}` : 'Alert Detail'}
        width="max-w-xl"
      >
        {selectedAlert && (
          <div className="space-y-6">
            <div className="flex items-center gap-3">
              <SeverityBadge severity={selectedAlert.severity} />
              <AlertStatusBadge status={selectedAlert.status} />
              <Badge variant="neutral">{selectedAlert.jurisdiction}</Badge>
            </div>

            <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
              <h3 className="text-sm font-semibold text-white mb-2">{selectedAlert.type}</h3>
              <p className="text-xs text-slate-400">{selectedAlert.message}</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
                <p className="text-xs text-slate-400">Amount</p>
                <p className="text-lg font-bold text-white">{formatUSD(selectedAlert.amount)}</p>
              </div>
              <div className="p-3 rounded-xl bg-slate-800/40 border border-slate-700/30">
                <p className="text-xs text-slate-400">Risk Score</p>
                <p className={`text-lg font-bold ${riskColor(selectedAlert.riskScore)}`}>{selectedAlert.riskScore}/100</p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/30">
              <div className="flex items-center gap-3 mb-3">
                <div className="flex-1">
                  <p className="text-xs text-slate-400">Sender</p>
                  <p className="text-sm font-medium text-white">{selectedAlert.senderName}</p>
                  <p className="text-xs text-slate-500 font-mono">{truncateAddress(selectedAlert.sender, 10, 6)}</p>
                </div>
                <ArrowRight className="w-4 h-4 text-slate-500" />
                <div className="flex-1">
                  <p className="text-xs text-slate-400">Recipient</p>
                  <p className="text-sm font-medium text-white">{selectedAlert.recipientName}</p>
                  <p className="text-xs text-slate-500 font-mono">{truncateAddress(selectedAlert.recipient, 10, 6)}</p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-slate-400">Payment ID</span>
                <span className="font-mono text-slate-300">{truncateAddress(selectedAlert.paymentId, 10, 6)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-slate-400">Timestamp</span>
                <span className="text-slate-300">{timeAgo(selectedAlert.timestamp)}</span>
              </div>
              {selectedAlert.acknowledgedBy && (
                <div className="flex justify-between text-xs">
                  <span className="text-slate-400">Acknowledged by</span>
                  <span className="text-slate-300">{selectedAlert.acknowledgedBy}</span>
                </div>
              )}
            </div>

            {selectedAlert.status === 'Active' && (
              <div className="flex gap-3 pt-4 border-t border-slate-700/50">
                <button className="flex-1 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 transition-colors">
                  Acknowledge
                </button>
                <button className="flex-1 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors">
                  Resolve
                </button>
                <button className="flex-1 py-2 rounded-lg bg-slate-700 text-white text-sm font-medium hover:bg-slate-600 transition-colors">
                  Dismiss
                </button>
              </div>
            )}
          </div>
        )}
      </Drawer>

      {/* ============================================================ */}
      {/* CREATE INCIDENT MODAL                                        */}
      {/* ============================================================ */}
      <Modal open={showCreateIncident} onClose={() => setShowCreateIncident(false)} title="Create Compliance Incident" maxWidth="max-w-2xl">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Incident Title</label>
            <input
              type="text"
              placeholder="Brief description of the incident"
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Category</label>
              <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">
                {INCIDENT_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">Severity</label>
              <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Critical">Critical</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Description</label>
            <textarea
              rows={4}
              placeholder="Detailed description of the compliance incident..."
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent resize-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Assign To</label>
            <select className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent">
              {REVIEWER_NAMES.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Related Alert IDs (optional)</label>
            <input
              type="text"
              placeholder="ALT-06001, ALT-06002"
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm font-mono placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-700/50">
            <button
              onClick={() => setShowCreateIncident(false)}
              className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => setShowCreateIncident(false)}
              className="px-6 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"
            >
              Create Incident
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
