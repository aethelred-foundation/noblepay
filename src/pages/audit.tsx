/**
 * NoblePay Audit Trail — Cryptographic audit log for regulatory compliance
 *
 * Enterprise-grade audit trail with hash-chained entries, regulatory exports,
 * system events, and audit statistics. All data deterministic via seededRandom.
 */

import { useState, useMemo } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
  Legend,
} from 'recharts';
import {
  CheckCircle, Shield, Clock, Link2, Download, FileText, AlertTriangle,
  ChevronDown, ChevronRight, Hash, Lock, Server, RefreshCw,
  Filter, Search, Calendar, Database,
} from 'lucide-react';
import { SEOHead } from '@/components/SEOHead';
import { TopNav, Footer } from '@/components/SharedComponents';
import { GlassCard, SectionHeader, StatusBadge, ChartTooltip } from '@/components/PagePrimitives';
import { useApp } from '@/contexts/AppContext';
import { seededRandom, seededHex, seededAddress, formatNumber, truncateAddress } from '@/lib/utils';
import { BRAND, CHART_COLORS } from '@/lib/constants';


// =============================================================================
// TYPES
// =============================================================================

type EventType = 'Payment' | 'Compliance' | 'Business' | 'System' | 'Configuration';
type Severity = 'Info' | 'Warning' | 'Critical';

interface AuditEntry {
  timestamp: string;
  eventId: string;
  eventType: EventType;
  actor: string;
  description: string;
  severity: Severity;
  blockNumber: number;
  txHash: string;
  prevHash: string;
  details: Record<string, string>;
}

interface SystemEvent {
  timestamp: string;
  type: string;
  description: string;
  actor: string;
  severity: Severity;
}

interface ExportCard {
  title: string;
  description: string;
  lastGenerated: string;
  formats: string[];
  status: 'Ready' | 'Generating' | 'Scheduled';
  icon: React.ReactNode;
}


// =============================================================================
// DATA GENERATORS
// =============================================================================

const EVENT_TYPES: EventType[] = ['Payment', 'Compliance', 'Business', 'System', 'Configuration'];
const SEVERITIES: Severity[] = ['Info', 'Info', 'Info', 'Info', 'Warning', 'Critical'];

const EVENT_DESCRIPTIONS: Record<EventType, string[]> = {
  Payment: [
    'Cross-border payment initiated',
    'Payment settled successfully',
    'Payment settlement confirmed on-chain',
    'Multi-currency payment routed',
    'Payment refund processed',
    'Batch settlement completed',
  ],
  Compliance: [
    'AML/KYC screening completed',
    'Sanctions list check passed',
    'Travel rule data shared',
    'Enhanced due diligence triggered',
    'Compliance flag raised for review',
    'Risk score threshold exceeded',
  ],
  Business: [
    'New business onboarded',
    'Business license verified',
    'Business tier upgraded',
    'Compliance officer updated',
    'Business profile modified',
    'API key generated',
  ],
  System: [
    'TEE node registered',
    'TEE attestation verified',
    'Sanctions list updated (OFAC)',
    'System health check passed',
    'Node synchronization complete',
    'Backup attestation verified',
  ],
  Configuration: [
    'Risk threshold modified',
    'Auto-approve limit updated',
    'Sanctions list preference changed',
    'Notification settings updated',
    'Rate limit configuration changed',
    'Emergency freeze toggled',
  ],
};

const SYSTEM_EVENT_TYPES = [
  'TEE Node Registration',
  'TEE Node Deregistration',
  'Sanctions List Update',
  'Configuration Change',
  'Risk Threshold Modification',
  'Emergency Action',
  'Node Health Check',
  'Attestation Renewal',
];

function generateAuditEntries(baseSeed: number, count: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let prevHash = '0x' + seededHex(baseSeed, 64);

  for (let i = 0; i < count; i++) {
    const s = baseSeed + i * 17;
    const eventType = EVENT_TYPES[Math.floor(seededRandom(s) * EVENT_TYPES.length)];
    const descriptions = EVENT_DESCRIPTIONS[eventType];
    const severity = SEVERITIES[Math.floor(seededRandom(s + 1) * SEVERITIES.length)];
    const currentHash = '0x' + seededHex(s + 2, 64);

    const hour = Math.floor(seededRandom(s + 3) * 24);
    const minute = Math.floor(seededRandom(s + 4) * 60);
    const day = Math.max(1, 14 - Math.floor(i / 3));

    entries.push({
      timestamp: `2026-03-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(Math.floor(seededRandom(s + 5) * 60)).padStart(2, '0')} UTC`,
      eventId: currentHash,
      eventType,
      actor: seededRandom(s + 6) > 0.3 ? seededAddress(s + 7) : 'system',
      description: descriptions[Math.floor(seededRandom(s + 8) * descriptions.length)],
      severity,
      blockNumber: 2847000 + Math.floor(seededRandom(s + 9) * 1000),
      txHash: '0x' + seededHex(s + 10, 64),
      prevHash,
      details: {
        'Gas Used': `${Math.floor(21000 + seededRandom(s + 11) * 200000)}`,
        'Execution Time': `${Math.floor(50 + seededRandom(s + 12) * 200)}ms`,
        'TEE Enclave': `enclave-${seededHex(s + 13, 8)}`,
        'Attestation': seededRandom(s + 14) > 0.1 ? 'Verified' : 'Pending',
      },
    });

    prevHash = currentHash;
  }

  return entries;
}

function generateSystemEvents(baseSeed: number): SystemEvent[] {
  const events: SystemEvent[] = [];
  for (let i = 0; i < 12; i++) {
    const s = baseSeed + i * 13;
    const type = SYSTEM_EVENT_TYPES[Math.floor(seededRandom(s) * SYSTEM_EVENT_TYPES.length)];
    const severity: Severity = seededRandom(s + 1) > 0.85 ? 'Critical' : seededRandom(s + 1) > 0.7 ? 'Warning' : 'Info';
    const day = Math.max(1, 14 - Math.floor(i / 2));
    const hour = Math.floor(seededRandom(s + 2) * 24);
    const minute = Math.floor(seededRandom(s + 3) * 60);
    events.push({
      timestamp: `2026-03-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`,
      type,
      description: `${type} event processed successfully`,
      actor: seededRandom(s + 4) > 0.5 ? seededAddress(s + 5) : 'system',
      severity,
    });
  }
  return events;
}

function generateAuditByType(baseSeed: number) {
  return EVENT_TYPES.map((type, i) => ({
    type,
    count: Math.floor(500 + seededRandom(baseSeed + i) * 3000),
  }));
}

function generateAuditBySeverity(baseSeed: number) {
  return [
    { name: 'Info', value: Math.floor(9000 + seededRandom(baseSeed) * 2000), color: '#3B82F6' },
    { name: 'Warning', value: Math.floor(500 + seededRandom(baseSeed + 1) * 800), color: '#F59E0B' },
    { name: 'Critical', value: Math.floor(50 + seededRandom(baseSeed + 2) * 150), color: '#EF4444' },
  ];
}

function generateAuditOverTime(baseSeed: number) {
  const data = [];
  for (let i = 0; i < 30; i++) {
    const s = baseSeed + i * 5;
    data.push({
      day: `Mar ${i + 1}`,
      count: Math.floor(300 + seededRandom(s) * 200),
    });
  }
  return data;
}


// =============================================================================
// SUB-COMPONENTS
// =============================================================================

const EVENT_TYPE_COLORS: Record<EventType, string> = {
  Payment: 'bg-blue-500/20 text-blue-400',
  Compliance: 'bg-emerald-500/20 text-emerald-400',
  Business: 'bg-purple-500/20 text-purple-400',
  System: 'bg-amber-500/20 text-amber-400',
  Configuration: 'bg-cyan-500/20 text-cyan-400',
};

const SEVERITY_COLORS: Record<Severity, string> = {
  Info: 'text-blue-400',
  Warning: 'text-amber-400',
  Critical: 'text-red-400',
};

const SEVERITY_DOT: Record<Severity, string> = {
  Info: 'bg-blue-400',
  Warning: 'bg-amber-400',
  Critical: 'bg-red-400',
};

function AuditRow({ entry, isExpanded, onToggle }: { entry: AuditEntry; isExpanded: boolean; onToggle: () => void }) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors cursor-pointer"
      >
        <td className="py-3 pr-3 text-xs text-slate-400 whitespace-nowrap">{entry.timestamp}</td>
        <td className="py-3 pr-3">
          <span className="font-mono text-xs text-slate-300">{truncateAddress(entry.eventId, 8, 6)}</span>
        </td>
        <td className="py-3 pr-3 hidden sm:table-cell">
          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${EVENT_TYPE_COLORS[entry.eventType]}`}>
            {entry.eventType}
          </span>
        </td>
        <td className="py-3 pr-3 hidden md:table-cell">
          <span className="font-mono text-xs text-slate-400">
            {entry.actor === 'system' ? 'SYSTEM' : truncateAddress(entry.actor, 6, 4)}
          </span>
        </td>
        <td className="py-3 pr-3 text-sm text-slate-200 hidden lg:table-cell">{entry.description}</td>
        <td className="py-3 pr-3 hidden xl:table-cell">
          <span className={`inline-flex items-center gap-1 text-xs font-medium ${SEVERITY_COLORS[entry.severity]}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[entry.severity]}`} />
            {entry.severity}
          </span>
        </td>
        <td className="py-3 pr-3 text-xs text-slate-400 hidden xl:table-cell">{entry.blockNumber.toLocaleString()}</td>
        <td className="py-3">
          {isExpanded ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
        </td>
      </tr>
      {isExpanded && (
        <tr className="border-b border-slate-800/50">
          <td colSpan={8} className="px-4 py-4 bg-slate-900/40">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-3">
                <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Transaction Hash</p>
                <p className="font-mono text-xs text-slate-200 break-all">{entry.txHash}</p>
              </div>
              <div className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-3">
                <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Previous Hash</p>
                <p className="font-mono text-xs text-slate-200 break-all">{entry.prevHash}</p>
              </div>
              {Object.entries(entry.details).map(([key, val]) => (
                <div key={key} className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-3">
                  <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">{key}</p>
                  <p className="text-sm text-slate-200">{val}</p>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}


// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function AuditPage() {
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [typeFilter, setTypeFilter] = useState<EventType | 'All'>('All');
  const [severityFilter, setSeverityFilter] = useState<Severity | 'All'>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifiedCount, setVerifiedCount] = useState(0);

  const auditEntries = useMemo(() => generateAuditEntries(60000, 40), []);
  const systemEvents = useMemo(() => generateSystemEvents(61000), []);
  const auditByType = useMemo(() => generateAuditByType(62000), []);
  const auditBySeverity = useMemo(() => generateAuditBySeverity(63000), []);
  const auditOverTime = useMemo(() => generateAuditOverTime(64000), []);

  const filteredEntries = useMemo(() => {
    return auditEntries.filter((e) => {
      if (typeFilter !== 'All' && e.eventType !== typeFilter) return false;
      if (severityFilter !== 'All' && e.severity !== severityFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          e.eventId.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.actor.toLowerCase().includes(q) ||
          e.txHash.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [auditEntries, typeFilter, severityFilter, searchQuery]);

  const chainEntries = useMemo(() => auditEntries.slice(0, 10), [auditEntries]);

  const toggleRow = (idx: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleVerifyChain = () => {
    setVerifying(true);
    setVerifiedCount(0);
    let count = 0;
    const interval = setInterval(() => {
      count++;
      setVerifiedCount(count);
      if (count >= chainEntries.length) {
        clearInterval(interval);
        setTimeout(() => setVerifying(false), 500);
      }
    }, 300);
  };

  const exportCards: ExportCard[] = [
    {
      title: 'UAE Central Bank Report',
      description: 'Regulatory reporting for CBUAE compliance',
      lastGenerated: '2 hours ago',
      formats: ['PDF', 'CSV'],
      status: 'Ready',
      icon: <Shield className="h-5 w-5 text-red-400" />,
    },
    {
      title: 'FATF Travel Rule Report',
      description: 'Travel rule compliance documentation',
      lastGenerated: '6 hours ago',
      formats: ['PDF', 'JSON'],
      status: 'Ready',
      icon: <FileText className="h-5 w-5 text-blue-400" />,
    },
    {
      title: 'OFAC Compliance Report',
      description: 'Sanctions screening activity summary',
      lastGenerated: '1 day ago',
      formats: ['PDF', 'CSV'],
      status: 'Ready',
      icon: <AlertTriangle className="h-5 w-5 text-amber-400" />,
    },
    {
      title: 'AML/CFT Activity Report',
      description: 'Anti-money laundering and counter-terrorism financing',
      lastGenerated: '3 days ago',
      formats: ['PDF'],
      status: 'Generating',
      icon: <Lock className="h-5 w-5 text-emerald-400" />,
    },
    {
      title: 'Custom Date Range Export',
      description: 'Export audit data for any custom period',
      lastGenerated: 'On demand',
      formats: ['PDF', 'CSV', 'JSON'],
      status: 'Scheduled',
      icon: <Calendar className="h-5 w-5 text-purple-400" />,
    },
  ];

  return (
    <>
      <SEOHead
        title="Audit Trail"
        description="Cryptographic audit trail for NoblePay regulatory compliance and reporting."
        path="/audit"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="audit" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* ================================================================
              SECTION 1 — Audit Overview Banner
              ================================================================ */}
          <SectionHeader
            title="Audit Trail"
            subtitle="Cryptographic audit log for regulatory compliance and immutable record-keeping"
          />

          <GlassCard className="p-6 mb-10" hover={false}>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-slate-800 p-2.5">
                  <Database className="h-5 w-5 text-red-400" />
                </div>
                <div>
                  <p className="text-xs text-slate-400 uppercase tracking-wider">Total Audit Entries</p>
                  <p className="text-2xl font-bold text-white mt-1">12,847</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-slate-800 p-2.5">
                  <CheckCircle className="h-5 w-5 text-emerald-400" />
                </div>
                <div>
                  <p className="text-xs text-slate-400 uppercase tracking-wider">Cryptographic Integrity</p>
                  <p className="text-lg font-semibold text-emerald-400 mt-1 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    Verified
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-slate-800 p-2.5">
                  <Clock className="h-5 w-5 text-blue-400" />
                </div>
                <div>
                  <p className="text-xs text-slate-400 uppercase tracking-wider">Last Verification</p>
                  <p className="text-lg font-semibold text-white mt-1">2 minutes ago</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-slate-800 p-2.5">
                  <Link2 className="h-5 w-5 text-purple-400" />
                </div>
                <div>
                  <p className="text-xs text-slate-400 uppercase tracking-wider">Chain Continuity</p>
                  <p className="text-lg font-semibold text-white mt-1">Unbroken since genesis</p>
                </div>
              </div>
            </div>
          </GlassCard>

          {/* ================================================================
              SECTION 2 — Filter Bar
              ================================================================ */}
          <GlassCard className="p-4 mb-6" hover={false}>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <Filter className="h-4 w-4 text-slate-400" />
                <span className="text-xs text-slate-400 uppercase tracking-wider">Filters:</span>
              </div>

              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as EventType | 'All')}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 focus:border-red-500 focus:outline-none"
              >
                <option value="All">All Types</option>
                {EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>

              <select
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value as Severity | 'All')}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 focus:border-red-500 focus:outline-none"
              >
                <option value="All">All Severities</option>
                <option value="Info">Info</option>
                <option value="Warning">Warning</option>
                <option value="Critical">Critical</option>
              </select>

              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search by event ID, hash, or description..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 pl-10 pr-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:border-red-500 focus:outline-none"
                />
              </div>

              <span className="text-xs text-slate-500">{filteredEntries.length} results</span>
            </div>
          </GlassCard>

          {/* ================================================================
              SECTION 3 — Audit Log Table
              ================================================================ */}
          <SectionHeader title="Audit Log" subtitle="Expandable entries with cryptographic hash chain" size="sm" />
          <GlassCard className="mb-10 overflow-x-auto" hover={false}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700/50 text-left text-xs uppercase tracking-wider text-slate-400">
                  <th className="py-3 px-4 pr-3">Timestamp</th>
                  <th className="py-3 pr-3">Event ID</th>
                  <th className="py-3 pr-3 hidden sm:table-cell">Type</th>
                  <th className="py-3 pr-3 hidden md:table-cell">Actor</th>
                  <th className="py-3 pr-3 hidden lg:table-cell">Description</th>
                  <th className="py-3 pr-3 hidden xl:table-cell">Severity</th>
                  <th className="py-3 pr-3 hidden xl:table-cell">Block</th>
                  <th className="py-3 px-4 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map((entry, idx) => (
                  <AuditRow
                    key={idx}
                    entry={entry}
                    isExpanded={expandedRows.has(idx)}
                    onToggle={() => toggleRow(idx)}
                  />
                ))}
              </tbody>
            </table>
          </GlassCard>

          {/* ================================================================
              SECTION 4 — Cryptographic Proof Chain
              ================================================================ */}
          <SectionHeader
            title="Cryptographic Proof Chain"
            subtitle="Visual hash chain linking each audit entry to its predecessor"
            size="sm"
            action={
              <button
                onClick={handleVerifyChain}
                disabled={verifying}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${verifying ? 'animate-spin' : ''}`} />
                {verifying ? `Verifying (${verifiedCount}/${chainEntries.length})` : 'Verify Chain'}
              </button>
            }
          />
          <GlassCard className="p-6 mb-10" hover={false}>
            <div className="space-y-0">
              {chainEntries.map((entry, idx) => {
                const isVerified = verifying ? idx < verifiedCount : !verifying && verifiedCount >= chainEntries.length;
                return (
                  <div key={idx} className="relative">
                    {/* Connecting line */}
                    {idx < chainEntries.length - 1 && (
                      <div className="absolute left-6 top-14 w-0.5 h-8 bg-slate-700" />
                    )}
                    <div className={`flex items-start gap-4 p-4 rounded-xl transition-all ${
                      isVerified ? 'bg-emerald-500/5 border border-emerald-500/20' : 'bg-slate-800/30 border border-slate-700/30'
                    }`}>
                      {/* Chain icon */}
                      <div className={`shrink-0 rounded-full p-2 ${
                        isVerified ? 'bg-emerald-500/20' : 'bg-slate-800'
                      }`}>
                        {isVerified ? (
                          <CheckCircle className="h-4 w-4 text-emerald-400" />
                        ) : (
                          <Hash className="h-4 w-4 text-slate-400" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs font-medium ${EVENT_TYPE_COLORS[entry.eventType]} px-2 py-0.5 rounded-full`}>
                            {entry.eventType}
                          </span>
                          <span className="text-xs text-slate-500">{entry.timestamp}</span>
                        </div>
                        <p className="text-sm text-slate-200 mb-2">{entry.description}</p>
                        <div className="flex flex-wrap gap-x-6 gap-y-1">
                          <span className="text-xs text-slate-400">
                            Hash: <span className="font-mono text-slate-300">{truncateAddress(entry.eventId, 10, 8)}</span>
                          </span>
                          <span className="text-xs text-slate-400">
                            Prev: <span className="font-mono text-slate-500">{truncateAddress(entry.prevHash, 10, 8)}</span>
                          </span>
                        </div>
                      </div>
                    </div>
                    {idx < chainEntries.length - 1 && <div className="h-2" />}
                  </div>
                );
              })}
            </div>
          </GlassCard>

          {/* ================================================================
              SECTION 5 — Regulatory Export
              ================================================================ */}
          <SectionHeader title="Regulatory Exports" subtitle="Download compliance reports for regulators and auditors" size="sm" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-10">
            {exportCards.map((card) => (
              <GlassCard key={card.title} className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="rounded-lg bg-slate-800 p-2.5">{card.icon}</div>
                  <StatusBadge status={card.status === 'Ready' ? 'Active' : card.status === 'Generating' ? 'Processing' : 'Pending'} />
                </div>
                <h3 className="text-sm font-semibold text-white mb-1">{card.title}</h3>
                <p className="text-xs text-slate-400 mb-3">{card.description}</p>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">Last: {card.lastGenerated}</span>
                  <div className="flex gap-1">
                    {card.formats.map((fmt) => (
                      <button
                        key={fmt}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-300 hover:border-red-500/50 hover:text-white transition-colors"
                      >
                        <Download className="h-3 w-3" />
                        {fmt}
                      </button>
                    ))}
                  </div>
                </div>
              </GlassCard>
            ))}
          </div>

          {/* ================================================================
              SECTION 6 — System Events Log
              ================================================================ */}
          <SectionHeader title="System Events" subtitle="TEE node lifecycle, sanctions updates, and configuration changes" size="sm" />
          <GlassCard className="p-6 mb-10 overflow-x-auto" hover={false}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700/50 text-left text-xs uppercase tracking-wider text-slate-400">
                  <th className="py-3 pr-4">Timestamp</th>
                  <th className="py-3 pr-4">Event Type</th>
                  <th className="py-3 pr-4 hidden sm:table-cell">Description</th>
                  <th className="py-3 pr-4 hidden md:table-cell">Actor</th>
                  <th className="py-3">Severity</th>
                </tr>
              </thead>
              <tbody>
                {systemEvents.map((event, idx) => (
                  <tr key={idx} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 pr-4 text-xs text-slate-400 whitespace-nowrap">{event.timestamp}</td>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        <Server className="h-3.5 w-3.5 text-slate-500" />
                        <span className="text-sm text-white font-medium">{event.type}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-sm text-slate-300 hidden sm:table-cell">{event.description}</td>
                    <td className="py-3 pr-4 hidden md:table-cell">
                      <span className="font-mono text-xs text-slate-400">
                        {event.actor === 'system' ? 'SYSTEM' : truncateAddress(event.actor, 6, 4)}
                      </span>
                    </td>
                    <td className="py-3">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${SEVERITY_COLORS[event.severity]}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[event.severity]}`} />
                        {event.severity}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassCard>

          {/* ================================================================
              SECTION 7 — Audit Statistics (3 columns)
              ================================================================ */}
          <SectionHeader title="Audit Statistics" subtitle="Event distribution and trends" size="sm" />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 mb-10">
            {/* Events by Type: BarChart */}
            <GlassCard className="p-6" hover={false}>
              <h3 className="text-sm font-semibold text-white mb-4">Events by Type</h3>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={auditByType} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis type="number" stroke="#64748b" fontSize={11} tickLine={false} />
                  <YAxis type="category" dataKey="type" stroke="#64748b" fontSize={11} tickLine={false} width={90} />
                  <RechartsTooltip content={<ChartTooltip />} />
                  <Bar dataKey="count" fill="#DC2626" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </GlassCard>

            {/* Events by Severity: PieChart */}
            <GlassCard className="p-6" hover={false}>
              <h3 className="text-sm font-semibold text-white mb-4">Events by Severity</h3>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={auditBySeverity}
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={70}
                    paddingAngle={3}
                    dataKey="value"
                  >
                    {auditBySeverity.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color} stroke="transparent" />
                    ))}
                  </Pie>
                  <RechartsTooltip content={<ChartTooltip />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap justify-center gap-3 mt-2">
                {auditBySeverity.map((entry) => (
                  <span key={entry.name} className="inline-flex items-center gap-1.5 text-xs text-slate-300">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                    {entry.name} ({entry.value.toLocaleString()})
                  </span>
                ))}
              </div>
            </GlassCard>

            {/* Events Over Time: LineChart */}
            <GlassCard className="p-6" hover={false}>
              <h3 className="text-sm font-semibold text-white mb-4">Events Over Time</h3>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={auditOverTime}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="day" stroke="#64748b" fontSize={10} tickLine={false} interval={5} />
                  <YAxis stroke="#64748b" fontSize={11} tickLine={false} />
                  <RechartsTooltip content={<ChartTooltip />} />
                  <Line type="monotone" dataKey="count" name="Events" stroke="#DC2626" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </GlassCard>
          </div>

        </main>

        <Footer />
      </div>
    </>
  );
}
