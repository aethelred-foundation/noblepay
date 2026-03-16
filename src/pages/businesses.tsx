/**
 * Business Registry — UAE business onboarding and management.
 *
 * Business registration, KYC verification, tier management, verification
 * queues, and re-verification alerts for NoblePay compliance officers.
 *
 * All data is deterministic via seededRandom for SSR hydration safety.
 */

import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer,
} from 'recharts';
import {
  Building2, Search, Filter, ChevronDown, ChevronUp, ChevronRight,
  ChevronLeft, Plus, Shield, ShieldCheck, ShieldAlert, Clock,
  AlertTriangle, CheckCircle, XCircle, Eye, Edit3, UserCheck,
  Users, Award, Star, ArrowUpRight, Upload, FileText, Globe,
  Calendar, MapPin, Briefcase, Hash, X, AlertCircle,
} from 'lucide-react';
import { SEOHead } from '@/components/SEOHead';
import { TopNav, Footer } from '@/components/SharedComponents';
import { GlassCard, SectionHeader, ChartTooltip } from '@/components/PagePrimitives';
import { useApp } from '@/contexts/AppContext';
import { seededRandom, seededHex, seededAddress, formatNumber, truncateAddress } from '@/lib/utils';
import { BRAND } from '@/lib/constants';


// =============================================================================
// TYPES
// =============================================================================

type KYCStatus = 'Verified' | 'Pending' | 'Suspended' | 'Expired';
type BusinessTier = 'STANDARD' | 'PREMIUM' | 'ENTERPRISE';

interface Business {
  id: string;
  name: string;
  licenseNo: string;
  jurisdiction: string;
  tier: BusinessTier;
  kycStatus: KYCStatus;
  dailyVolume: number;
  complianceScore: number;
  registeredDate: string;
  address: string;
  complianceOfficer: string;
  lastVerified: string;
  nextVerification: string;
  monthlyVolume: number;
  dailyLimit: number;
  monthlyLimit: number;
  usedToday: number;
  usedMonth: number;
  businessType: string;
}

interface VerificationItem {
  businessName: string;
  submittedDate: string;
  documentsStatus: 'Complete' | 'Partial' | 'Missing';
  licenseNo: string;
}

interface ReverificationAlert {
  businessName: string;
  lastVerified: string;
  daysRemaining: number;
  category: 'overdue' | 'this_month' | 'next_month';
}


// =============================================================================
// CONSTANTS
// =============================================================================

const UAE_EMIRATES = [
  'Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah',
];

const BUSINESS_TYPES = [
  'LLC', 'Free Zone LLC', 'Free Zone Company', 'Branch Office', 'Representative Office',
  'Sole Establishment', 'Civil Company', 'Public Joint Stock',
];

const BUSINESS_NAMES = [
  'Al Maktoum Trading LLC', 'Emirates Global Finance', 'Dubai Silicon Oasis Tech FZ-LLC',
  'Abu Dhabi Investment Partners', 'Sharjah Digital Services', 'RAK International Holdings',
  'Ajman Commercial Group', 'Fujairah Maritime Logistics', 'Al Ain Agritech Solutions',
  'DIFC Capital Management', 'Jebel Ali Free Zone Corp', 'Meydan Group Holdings',
  'Al Barsha Technologies', 'Deira Gold Trading LLC', 'Business Bay Consulting FZ',
  'Palm Jumeirah Ventures', 'Al Quoz Industrial LLC', 'Maritime City Services FZ-LLC',
  'Dubai Healthcare Partners', 'Abu Dhabi Energy Corp', 'Sharjah Media Group LLC',
  'RAK Ceramics Trading', 'Ajman Port Logistics', 'Fujairah Oil Terminal LLC',
  'Al Reem Island Finance', 'Saadiyat Investment Group', 'Yas Marina Trading LLC',
  'Dubai Internet City Tech', 'Masdar City Green Energy', 'Khalifa Port Services LLC',
];

const LICENSE_PREFIXES = ['CN', 'DED', 'JAFZA', 'DAFZA', 'RAKEZ', 'AFZA', 'SPC', 'DIFC'];

const TIER_CONFIG: Record<BusinessTier, { label: string; color: string; bg: string; ring: string; dailyLimit: number }> = {
  STANDARD: { label: 'Standard', color: 'text-slate-300', bg: 'bg-slate-500/10', ring: 'ring-slate-500/20', dailyLimit: 50000 },
  PREMIUM: { label: 'Premium', color: 'text-blue-400', bg: 'bg-blue-500/10', ring: 'ring-blue-500/20', dailyLimit: 500000 },
  ENTERPRISE: { label: 'Enterprise', color: 'text-amber-400', bg: 'bg-amber-500/10', ring: 'ring-amber-500/20', dailyLimit: 5000000 },
};

const KYC_STYLES: Record<KYCStatus, { bg: string; text: string; dot: string }> = {
  Verified: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  Pending: { bg: 'bg-amber-500/10', text: 'text-amber-400', dot: 'bg-amber-400' },
  Suspended: { bg: 'bg-red-500/10', text: 'text-red-400', dot: 'bg-red-400' },
  Expired: { bg: 'bg-slate-500/10', text: 'text-slate-400', dot: 'bg-slate-400' },
};

const TIER_DISTRIBUTION = [
  { name: 'STANDARD', count: 85, limit: '$50K/day', color: '#64748b' },
  { name: 'PREMIUM', count: 42, limit: '$500K/day', color: '#3B82F6' },
  { name: 'ENTERPRISE', count: 15, limit: '$5M/day', color: '#F59E0B' },
];

const CHART_COLORS = ['#64748b', '#3B82F6', '#F59E0B'];


// =============================================================================
// MOCK DATA GENERATORS
// =============================================================================

function generateBusinesses(): Business[] {
  const kycStatuses: KYCStatus[] = ['Verified', 'Verified', 'Verified', 'Verified', 'Verified', 'Verified', 'Pending', 'Suspended', 'Expired', 'Verified'];
  const tiers: BusinessTier[] = ['STANDARD', 'STANDARD', 'STANDARD', 'PREMIUM', 'PREMIUM', 'ENTERPRISE', 'STANDARD', 'STANDARD', 'PREMIUM', 'STANDARD'];

  return Array.from({ length: 30 }, (_, i) => {
    const seed = 3000 + i * 19;
    const tier = tiers[i % tiers.length];
    const config = TIER_CONFIG[tier];
    const kycStatus = kycStatuses[i % kycStatuses.length];
    const prefix = LICENSE_PREFIXES[i % LICENSE_PREFIXES.length];
    const licenseNum = String(Math.floor(seededRandom(seed) * 9000000 + 1000000));
    const dailyLimit = config.dailyLimit;
    const monthlyLimit = dailyLimit * 30;
    const usedToday = Math.round(seededRandom(seed + 1) * dailyLimit * 0.7);
    const usedMonth = Math.round(seededRandom(seed + 2) * monthlyLimit * 0.6);

    return {
      id: `BIZ-${String(i + 1).padStart(4, '0')}`,
      name: BUSINESS_NAMES[i % BUSINESS_NAMES.length],
      licenseNo: `${prefix}-${licenseNum}`,
      jurisdiction: UAE_EMIRATES[i % UAE_EMIRATES.length],
      tier,
      kycStatus,
      dailyVolume: Math.round(seededRandom(seed + 3) * dailyLimit * 0.5),
      complianceScore: Math.round(seededRandom(seed + 4) * 20 + 80),
      registeredDate: `2023-${String((i % 12) + 1).padStart(2, '0')}-${String(Math.floor(seededRandom(seed + 5) * 27 + 1)).padStart(2, '0')}`,
      address: seededAddress(seed + 6),
      complianceOfficer: seededAddress(seed + 7),
      lastVerified: `2023-${String(Math.floor(seededRandom(seed + 8) * 6 + 7)).padStart(2, '0')}-${String(Math.floor(seededRandom(seed + 9) * 27 + 1)).padStart(2, '0')}`,
      nextVerification: `2024-${String(Math.floor(seededRandom(seed + 10) * 6 + 1)).padStart(2, '0')}-${String(Math.floor(seededRandom(seed + 11) * 27 + 1)).padStart(2, '0')}`,
      monthlyVolume: usedMonth,
      dailyLimit,
      monthlyLimit,
      usedToday,
      usedMonth,
      businessType: BUSINESS_TYPES[i % BUSINESS_TYPES.length],
    };
  });
}

function generateVerificationQueue(): VerificationItem[] {
  const docStatuses: VerificationItem['documentsStatus'][] = ['Complete', 'Partial', 'Complete', 'Missing', 'Complete'];
  return [
    { businessName: 'Al Khaleej Trading FZ-LLC', submittedDate: '2024-01-12', documentsStatus: docStatuses[0], licenseNo: 'DAFZA-8834521' },
    { businessName: 'Gulf Stream Logistics', submittedDate: '2024-01-11', documentsStatus: docStatuses[1], licenseNo: 'DED-2024-112233' },
    { businessName: 'Reem Island Tech Solutions', submittedDate: '2024-01-10', documentsStatus: docStatuses[2], licenseNo: 'AFZA-7712345' },
    { businessName: 'Marina Walk Investments', submittedDate: '2024-01-09', documentsStatus: docStatuses[3], licenseNo: 'CN-5567890' },
    { businessName: 'Corniche Capital Partners', submittedDate: '2024-01-08', documentsStatus: docStatuses[4], licenseNo: 'SPC-3345678' },
  ];
}

function generateReverificationAlerts(): ReverificationAlert[] {
  return [
    { businessName: 'Al Maktoum Trading LLC', lastVerified: '2023-01-10', daysRemaining: -5, category: 'overdue' },
    { businessName: 'RAK International Holdings', lastVerified: '2023-01-20', daysRemaining: -1, category: 'overdue' },
    { businessName: 'Dubai Silicon Oasis Tech FZ-LLC', lastVerified: '2023-02-01', daysRemaining: 8, category: 'this_month' },
    { businessName: 'DIFC Capital Management', lastVerified: '2023-02-05', daysRemaining: 12, category: 'this_month' },
    { businessName: 'Emirates Global Finance', lastVerified: '2023-02-15', daysRemaining: 22, category: 'this_month' },
    { businessName: 'Abu Dhabi Investment Partners', lastVerified: '2023-03-01', daysRemaining: 36, category: 'next_month' },
    { businessName: 'Sharjah Digital Services', lastVerified: '2023-03-10', daysRemaining: 45, category: 'next_month' },
  ];
}


// =============================================================================
// HELPER COMPONENTS
// =============================================================================

function TierBadge({ tier }: { tier: BusinessTier }) {
  const config = TIER_CONFIG[tier];
  const icons: Record<BusinessTier, typeof Star> = { STANDARD: Shield, PREMIUM: Star, ENTERPRISE: Award };
  const Icon = icons[tier];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${config.bg} ${config.color} ${config.ring}`}>
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  );
}

function KYCBadge({ status }: { status: KYCStatus }) {
  const s = KYC_STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ring-white/10 ${s.bg} ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot} ${status === 'Verified' ? 'animate-pulse' : ''}`} />
      {status}
    </span>
  );
}

function MiniProgressBar({ value, max, color = '#DC2626' }: { value: number; max: number; color?: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="h-1.5 w-full rounded-full bg-slate-800">
      <div
        className="h-1.5 rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  tone,
}: {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: typeof Building2;
  tone: 'green' | 'red' | 'amber' | 'blue';
}) {
  const toneMap: Record<string, { card: string; icon: string }> = {
    green: { card: 'from-emerald-500/10 to-emerald-900/10 border-emerald-700/30', icon: 'text-emerald-400' },
    red: { card: 'from-red-500/10 to-red-900/10 border-red-700/30', icon: 'text-red-400' },
    amber: { card: 'from-amber-500/10 to-amber-900/10 border-amber-700/30', icon: 'text-amber-400' },
    blue: { card: 'from-blue-500/10 to-blue-900/10 border-blue-700/30', icon: 'text-blue-400' },
  };
  const s = toneMap[tone];
  return (
    <GlassCard className={`p-5 bg-gradient-to-br ${s.card}`}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-slate-400">{title}</p>
          <p className="mt-2 text-2xl font-bold text-white tabular-nums">{value}</p>
          {subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}
        </div>
        <div className={`rounded-lg bg-slate-800/50 p-2 ${s.icon}`}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </GlassCard>
  );
}


// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function BusinessRegistryPage() {
  const { wallet } = useApp();
  const [mounted, setMounted] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [tierFilter, setTierFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [jurisdictionFilter, setJurisdictionFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedBusiness, setSelectedBusiness] = useState<Business | null>(null);
  const [showRegistrationModal, setShowRegistrationModal] = useState(false);
  const [showDetailPanel, setShowDetailPanel] = useState(false);
  const pageSize = 10;

  useEffect(() => setMounted(true), []);

  const businesses = useMemo(() => generateBusinesses(), []);
  const verificationQueue = useMemo(() => generateVerificationQueue(), []);
  const reverificationAlerts = useMemo(() => generateReverificationAlerts(), []);

  const filteredBusinesses = useMemo(() => {
    return businesses.filter((b) => {
      if (tierFilter !== 'all' && b.tier !== tierFilter) return false;
      if (statusFilter !== 'all' && b.kycStatus !== statusFilter) return false;
      if (jurisdictionFilter !== 'all' && b.jurisdiction !== jurisdictionFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          b.name.toLowerCase().includes(q) ||
          b.licenseNo.toLowerCase().includes(q) ||
          b.jurisdiction.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [businesses, tierFilter, statusFilter, jurisdictionFilter, searchQuery]);

  const totalPages = Math.ceil(filteredBusinesses.length / pageSize);
  const paginatedBusinesses = filteredBusinesses.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const openDetail = useCallback((biz: Business) => {
    setSelectedBusiness(biz);
    setShowDetailPanel(true);
  }, []);

  const overdue = reverificationAlerts.filter((a) => a.category === 'overdue');
  const thisMonth = reverificationAlerts.filter((a) => a.category === 'this_month');
  const nextMonth = reverificationAlerts.filter((a) => a.category === 'next_month');

  return (
    <>
      <SEOHead
        title="Business Registry"
        description="UAE business onboarding, KYC verification, and tier management for NoblePay enterprise payments."
        path="/businesses"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="/businesses" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          {/* ================================================================
              SECTION 1 — Header
              ================================================================ */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-8">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-red-400">NoblePay Registry</p>
              <h1 className="mt-2 text-3xl font-bold text-white">Business Registry</h1>
              <p className="mt-1 text-sm text-slate-400">UAE business onboarding, KYC verification, and tier management</p>
            </div>
            <button
              onClick={() => setShowRegistrationModal(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors self-start"
            >
              <Plus className="h-4 w-4" />
              Register New Business
            </button>
          </div>

          {/* ================================================================
              SECTION 2 — Registry Stats
              ================================================================ */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-10">
            <StatCard title="Total Registered" value={142} subtitle="All businesses" icon={Building2} tone="blue" />
            <StatCard title="Verified" value="128" subtitle="90.1% of total" icon={ShieldCheck} tone="green" />
            <StatCard title="Pending Verification" value={10} subtitle="Awaiting review" icon={Clock} tone="amber" />
            <StatCard title="Suspended" value={4} subtitle="Compliance hold" icon={ShieldAlert} tone="red" />
          </div>

          {/* ================================================================
              SECTION 3 — Business Tier Distribution
              ================================================================ */}
          <SectionHeader title="Tier Distribution" subtitle="Business tiers and corresponding transaction limits" size="sm" />
          <GlassCard className="p-6 mb-10" hover={false}>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              {/* Donut Chart */}
              {mounted && (
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={TIER_DISTRIBUTION}
                      dataKey="count"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={90}
                      innerRadius={55}
                      strokeWidth={0}
                    >
                      {TIER_DISTRIBUTION.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                    <RechartsTooltip content={<ChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              )}

              {/* Tier Breakdown */}
              <div className="flex flex-col justify-center space-y-4">
                {TIER_DISTRIBUTION.map((tier) => {
                  const pct = Math.round((tier.count / 142) * 100);
                  return (
                    <div key={tier.name}>
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: tier.color }} />
                          <span className="text-sm font-medium text-white">{tier.name}</span>
                          <span className="text-xs text-slate-500">({tier.limit})</span>
                        </div>
                        <span className="text-sm font-medium text-white tabular-nums">{tier.count} <span className="text-slate-500 text-xs">({pct}%)</span></span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-800">
                        <div
                          className="h-2 rounded-full transition-all duration-700"
                          style={{ width: `${pct}%`, backgroundColor: tier.color }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </GlassCard>

          {/* ================================================================
              SECTION 4 — Business Directory Table
              ================================================================ */}
          <SectionHeader title="Business Directory" subtitle="All registered UAE businesses" size="sm" />
          <GlassCard className="mb-10 overflow-hidden" hover={false}>
            {/* Filters */}
            <div className="flex flex-col gap-3 border-b border-slate-700/50 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  placeholder="Search by name, license, or jurisdiction..."
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800/50 py-2 pl-10 pr-4 text-sm text-slate-100 placeholder-slate-500 focus:border-red-500/50 focus:outline-none focus:ring-1 focus:ring-red-500/30"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={tierFilter}
                  onChange={(e) => { setTierFilter(e.target.value); setCurrentPage(1); }}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 focus:border-red-500/50 focus:outline-none"
                >
                  <option value="all">All Tiers</option>
                  <option value="STANDARD">Standard</option>
                  <option value="PREMIUM">Premium</option>
                  <option value="ENTERPRISE">Enterprise</option>
                </select>
                <select
                  value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 focus:border-red-500/50 focus:outline-none"
                >
                  <option value="all">All Status</option>
                  <option value="Verified">Verified</option>
                  <option value="Pending">Pending</option>
                  <option value="Suspended">Suspended</option>
                  <option value="Expired">Expired</option>
                </select>
                <select
                  value={jurisdictionFilter}
                  onChange={(e) => { setJurisdictionFilter(e.target.value); setCurrentPage(1); }}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 focus:border-red-500/50 focus:outline-none"
                >
                  <option value="all">All Jurisdictions</option>
                  {UAE_EMIRATES.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Business Name</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">License No.</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Jurisdiction</th>
                    <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-slate-400">Tier</th>
                    <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-slate-400">KYC Status</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-slate-400">Daily Volume</th>
                    <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-slate-400">Compliance</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Registered</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-slate-400">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedBusinesses.map((biz) => {
                    const scoreColor = biz.complianceScore >= 95 ? '#10B981' : biz.complianceScore >= 85 ? '#F59E0B' : '#DC2626';
                    return (
                      <tr key={biz.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-medium text-white text-xs">{biz.name}</div>
                          <div className="font-mono text-[10px] text-slate-600">{biz.id}</div>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-400">{biz.licenseNo}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5 text-xs text-slate-300">
                            <MapPin className="h-3 w-3 text-slate-500" />
                            {biz.jurisdiction}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center"><TierBadge tier={biz.tier} /></td>
                        <td className="px-4 py-3 text-center"><KYCBadge status={biz.kycStatus} /></td>
                        <td className="px-4 py-3 text-right text-xs text-white tabular-nums">${formatNumber(biz.dailyVolume)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 justify-center">
                            <span className="text-xs font-bold tabular-nums" style={{ color: scoreColor }}>{biz.complianceScore}%</span>
                            <div className="h-1.5 w-10 rounded-full bg-slate-800">
                              <div className="h-1.5 rounded-full" style={{ width: `${biz.complianceScore}%`, backgroundColor: scoreColor }} />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-400">{biz.registeredDate}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => openDetail(biz)} className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-700 hover:text-white transition-colors" title="View">
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                            <button className="rounded px-2 py-1 text-xs text-blue-400 hover:bg-blue-500/10 transition-colors" title="Edit">
                              <Edit3 className="h-3.5 w-3.5" />
                            </button>
                            <button className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 transition-colors" title="Suspend">
                              <ShieldAlert className="h-3.5 w-3.5" />
                            </button>
                            <button className="rounded px-2 py-1 text-xs text-amber-400 hover:bg-amber-500/10 transition-colors" title="Upgrade">
                              <ArrowUpRight className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between border-t border-slate-700/50 px-4 py-3">
              <p className="text-xs text-slate-500">
                Showing {((currentPage - 1) * pageSize) + 1}–{Math.min(currentPage * pageSize, filteredBusinesses.length)} of {filteredBusinesses.length}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-400 hover:border-slate-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                {Array.from({ length: totalPages }, (_, i) => (
                  <button
                    key={i}
                    onClick={() => setCurrentPage(i + 1)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                      currentPage === i + 1
                        ? 'bg-red-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
                    }`}
                  >
                    {i + 1}
                  </button>
                ))}
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-400 hover:border-slate-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </GlassCard>

          {/* ================================================================
              SECTION 7 — Verification Queue
              ================================================================ */}
          <SectionHeader
            title="Verification Queue"
            subtitle="Pending businesses awaiting KYC verification"
            size="sm"
            action={
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-400 ring-1 ring-inset ring-amber-500/20">
                <Clock className="h-3 w-3" />
                {verificationQueue.length} Pending
              </span>
            }
          />
          <GlassCard className="mb-10 overflow-hidden" hover={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700/50">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Business Name</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">License No.</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-slate-400">Submitted</th>
                    <th className="px-4 py-3 text-center text-xs font-medium uppercase tracking-wide text-slate-400">Documents</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-slate-400">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {verificationQueue.map((item) => {
                    const docColor: Record<string, string> = {
                      Complete: 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20',
                      Partial: 'text-amber-400 bg-amber-500/10 ring-amber-500/20',
                      Missing: 'text-red-400 bg-red-500/10 ring-red-500/20',
                    };
                    return (
                      <tr key={item.licenseNo} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                        <td className="px-4 py-3 font-medium text-white text-xs">{item.businessName}</td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-400">{item.licenseNo}</td>
                        <td className="px-4 py-3 text-xs text-slate-400">{item.submittedDate}</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${docColor[item.documentsStatus]}`}>
                            {item.documentsStatus}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button className="rounded-lg border border-emerald-700/50 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 transition-colors">
                              Verify
                            </button>
                            <button className="rounded-lg border border-amber-700/50 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-400 hover:bg-amber-500/20 transition-colors">
                              Request Info
                            </button>
                            <button className="rounded-lg border border-red-700/50 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-500/20 transition-colors">
                              Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </GlassCard>

          {/* ================================================================
              SECTION 8 — Re-verification Alerts
              ================================================================ */}
          <SectionHeader title="Re-verification Alerts" subtitle="Annual KYC re-verification schedule" size="sm" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-10">
            {/* Overdue */}
            <GlassCard className="p-5 border-red-700/30" hover={false}>
              <div className="flex items-center gap-2 mb-4">
                <div className="rounded-lg bg-red-500/10 p-1.5">
                  <XCircle className="h-4 w-4 text-red-400" />
                </div>
                <h3 className="text-sm font-semibold text-red-400">Overdue</h3>
                <span className="ml-auto rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-bold text-red-400">{overdue.length}</span>
              </div>
              <div className="space-y-3">
                {overdue.map((a) => (
                  <div key={a.businessName} className="rounded-lg bg-red-500/5 border border-red-800/30 p-3">
                    <p className="text-xs font-medium text-white">{a.businessName}</p>
                    <p className="text-[10px] text-slate-500 mt-1">Last verified: {a.lastVerified}</p>
                    <p className="text-[10px] text-red-400 font-medium mt-0.5">{Math.abs(a.daysRemaining)} days overdue</p>
                  </div>
                ))}
              </div>
            </GlassCard>

            {/* This Month */}
            <GlassCard className="p-5 border-amber-700/30" hover={false}>
              <div className="flex items-center gap-2 mb-4">
                <div className="rounded-lg bg-amber-500/10 p-1.5">
                  <AlertTriangle className="h-4 w-4 text-amber-400" />
                </div>
                <h3 className="text-sm font-semibold text-amber-400">Due This Month</h3>
                <span className="ml-auto rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-bold text-amber-400">{thisMonth.length}</span>
              </div>
              <div className="space-y-3">
                {thisMonth.map((a) => (
                  <div key={a.businessName} className="rounded-lg bg-amber-500/5 border border-amber-800/30 p-3">
                    <p className="text-xs font-medium text-white">{a.businessName}</p>
                    <p className="text-[10px] text-slate-500 mt-1">Last verified: {a.lastVerified}</p>
                    <p className="text-[10px] text-amber-400 font-medium mt-0.5">{a.daysRemaining} days remaining</p>
                  </div>
                ))}
              </div>
            </GlassCard>

            {/* Next Month */}
            <GlassCard className="p-5 border-blue-700/30" hover={false}>
              <div className="flex items-center gap-2 mb-4">
                <div className="rounded-lg bg-blue-500/10 p-1.5">
                  <Calendar className="h-4 w-4 text-blue-400" />
                </div>
                <h3 className="text-sm font-semibold text-blue-400">Due Next Month</h3>
                <span className="ml-auto rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-bold text-blue-400">{nextMonth.length}</span>
              </div>
              <div className="space-y-3">
                {nextMonth.map((a) => (
                  <div key={a.businessName} className="rounded-lg bg-blue-500/5 border border-blue-800/30 p-3">
                    <p className="text-xs font-medium text-white">{a.businessName}</p>
                    <p className="text-[10px] text-slate-500 mt-1">Last verified: {a.lastVerified}</p>
                    <p className="text-[10px] text-blue-400 font-medium mt-0.5">{a.daysRemaining} days remaining</p>
                  </div>
                ))}
              </div>
            </GlassCard>
          </div>

        </main>

        <Footer />
      </div>

      {/* ================================================================
          Business Detail Panel (Drawer)
          ================================================================ */}
      {showDetailPanel && selectedBusiness && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowDetailPanel(false)}
            style={{ animation: 'modal-overlay-in 0.2s ease-out' }}
          />
          <div
            className="relative w-full max-w-lg bg-slate-900 border-l border-slate-700/50 overflow-y-auto"
            style={{ animation: 'drawer-in 0.3s ease-out' }}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-700/50 bg-slate-900/95 backdrop-blur px-6 py-4">
              <h3 className="text-lg font-bold text-white">Business Details</h3>
              <button
                onClick={() => setShowDetailPanel(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Profile */}
              <div>
                <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-3">Business Profile</h4>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    ['Name', selectedBusiness.name],
                    ['License', selectedBusiness.licenseNo],
                    ['Jurisdiction', selectedBusiness.jurisdiction],
                    ['Type', selectedBusiness.businessType],
                    ['Registered', selectedBusiness.registeredDate],
                    ['ID', selectedBusiness.id],
                  ].map(([label, val]) => (
                    <div key={label} className="rounded-lg bg-slate-800/50 p-3">
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide">{label}</p>
                      <p className="mt-0.5 text-xs text-white font-medium truncate">{val}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* KYC Information */}
              <div>
                <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-3">KYC Information</h4>
                <div className="space-y-2">
                  <div className="flex items-center justify-between rounded-lg bg-slate-800/50 p-3">
                    <span className="text-xs text-slate-400">Status</span>
                    <KYCBadge status={selectedBusiness.kycStatus} />
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-slate-800/50 p-3">
                    <span className="text-xs text-slate-400">Tier</span>
                    <TierBadge tier={selectedBusiness.tier} />
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-slate-800/50 p-3">
                    <span className="text-xs text-slate-400">Last Verified</span>
                    <span className="text-xs text-white">{selectedBusiness.lastVerified}</span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-slate-800/50 p-3">
                    <span className="text-xs text-slate-400">Next Verification</span>
                    <span className="text-xs text-white">{selectedBusiness.nextVerification}</span>
                  </div>
                  <div className="rounded-lg bg-slate-800/50 p-3">
                    <span className="text-xs text-slate-400">Compliance Officer</span>
                    <p className="font-mono text-[10px] text-slate-300 mt-1 break-all">{selectedBusiness.complianceOfficer}</p>
                  </div>
                </div>
              </div>

              {/* Transaction Limits */}
              <div>
                <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-3">Transaction Limits</h4>
                <div className="space-y-3">
                  <div className="rounded-lg bg-slate-800/50 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-slate-400">Daily Limit</span>
                      <span className="text-xs text-white tabular-nums">${formatNumber(selectedBusiness.usedToday)} / ${formatNumber(selectedBusiness.dailyLimit)}</span>
                    </div>
                    <MiniProgressBar value={selectedBusiness.usedToday} max={selectedBusiness.dailyLimit} color="#3B82F6" />
                  </div>
                  <div className="rounded-lg bg-slate-800/50 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-slate-400">Monthly Limit</span>
                      <span className="text-xs text-white tabular-nums">${formatNumber(selectedBusiness.usedMonth)} / ${formatNumber(selectedBusiness.monthlyLimit)}</span>
                    </div>
                    <MiniProgressBar value={selectedBusiness.usedMonth} max={selectedBusiness.monthlyLimit} color="#F59E0B" />
                  </div>
                </div>
              </div>

              {/* Compliance Record */}
              <div>
                <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-3">Compliance Record</h4>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg bg-emerald-500/5 border border-emerald-800/30 p-3 text-center">
                    <p className="text-lg font-bold text-emerald-400">{selectedBusiness.complianceScore}%</p>
                    <p className="text-[10px] text-slate-500">Pass Rate</p>
                  </div>
                  <div className="rounded-lg bg-amber-500/5 border border-amber-800/30 p-3 text-center">
                    <p className="text-lg font-bold text-amber-400">{Math.round(seededRandom(parseInt(selectedBusiness.id.replace('BIZ-', '')) + 100) * 3)}</p>
                    <p className="text-[10px] text-slate-500">Flags</p>
                  </div>
                  <div className="rounded-lg bg-blue-500/5 border border-blue-800/30 p-3 text-center">
                    <p className="text-lg font-bold text-blue-400">{Math.round(seededRandom(parseInt(selectedBusiness.id.replace('BIZ-', '')) + 200) * 2)}</p>
                    <p className="text-[10px] text-slate-500">Investigations</p>
                  </div>
                </div>
              </div>

              {/* Payment History (last 10) */}
              <div>
                <h4 className="text-xs uppercase tracking-wide text-slate-500 mb-3">Recent Payments</h4>
                <div className="space-y-1.5">
                  {Array.from({ length: 10 }, (_, i) => {
                    const seed = parseInt(selectedBusiness.id.replace('BIZ-', '')) * 100 + i * 7;
                    const amount = Math.round(seededRandom(seed) * selectedBusiness.dailyLimit * 0.3);
                    const status = seededRandom(seed + 1) > 0.15 ? 'Success' : 'Pending';
                    return (
                      <div key={i} className="flex items-center justify-between rounded-lg bg-slate-800/30 px-3 py-2">
                        <div>
                          <span className="font-mono text-[10px] text-slate-500">Jan {14 - i}</span>
                          <span className="ml-2 font-mono text-[10px] text-slate-600">NP-{seededHex(seed + 2, 8)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-white tabular-nums">${formatNumber(amount)}</span>
                          <span className={`h-1.5 w-1.5 rounded-full ${status === 'Success' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================
          Registration Form (Modal)
          ================================================================ */}
      {showRegistrationModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowRegistrationModal(false)}
            style={{ animation: 'modal-overlay-in 0.2s ease-out' }}
          />
          <div
            className="relative w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-700/50 bg-slate-900 p-6 shadow-2xl"
            style={{ animation: 'modal-content-in 0.3s ease-out' }}
          >
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-lg font-bold text-white">Register New Business</h3>
                <p className="text-xs text-slate-400 mt-1">Submit UAE business registration for NoblePay onboarding</p>
              </div>
              <button
                onClick={() => setShowRegistrationModal(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={(e) => { e.preventDefault(); setShowRegistrationModal(false); }} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">UAE Trade License Number *</label>
                <input
                  type="text"
                  placeholder="e.g., CN-1234567 or DED-2023-445566"
                  pattern="[A-Z]{2,5}-\d{4,10}(-\d{2,6})?"
                  required
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-red-500/50 focus:outline-none focus:ring-1 focus:ring-red-500/30"
                />
                <p className="text-[10px] text-slate-600 mt-1">Format: PREFIX-NUMBERS (e.g., CN-1234567, DED-2023-445566)</p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Business Name *</label>
                <input
                  type="text"
                  placeholder="Full registered business name"
                  required
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-600 focus:border-red-500/50 focus:outline-none focus:ring-1 focus:ring-red-500/30"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Jurisdiction *</label>
                  <select
                    required
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-red-500/50 focus:outline-none"
                  >
                    <option value="">Select Emirate</option>
                    {UAE_EMIRATES.map((e) => <option key={e} value={e}>{e}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Business Type *</label>
                  <select
                    required
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white focus:border-red-500/50 focus:outline-none"
                  >
                    <option value="">Select Type</option>
                    {BUSINESS_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">Compliance Officer Address *</label>
                <input
                  type="text"
                  placeholder="aeth1..."
                  required
                  pattern="aeth1[a-z0-9]{38}"
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white font-mono placeholder-slate-600 focus:border-red-500/50 focus:outline-none focus:ring-1 focus:ring-red-500/30"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5">KYC Attestation Document</label>
                <div className="flex items-center justify-center rounded-lg border-2 border-dashed border-slate-700 bg-slate-800/30 p-6 transition-colors hover:border-slate-600">
                  <div className="text-center">
                    <Upload className="mx-auto h-8 w-8 text-slate-500" />
                    <p className="mt-2 text-xs text-slate-400">Drag & drop or click to upload</p>
                    <p className="text-[10px] text-slate-600 mt-1">PDF, PNG, or JPG up to 10MB</p>
                  </div>
                </div>
              </div>

              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  required
                  id="terms"
                  className="mt-0.5 rounded border-slate-600 bg-slate-800 text-red-600 focus:ring-red-500/30"
                />
                <label htmlFor="terms" className="text-xs text-slate-400">
                  I confirm that the business details provided are accurate and I agree to the{' '}
                  <a href="#" className="text-red-400 hover:text-red-300 underline">NoblePay Terms of Service</a>{' '}
                  and{' '}
                  <a href="#" className="text-red-400 hover:text-red-300 underline">Compliance Policy</a>.
                </label>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowRegistrationModal(false)}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-400 hover:bg-slate-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-red-600 px-5 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
                >
                  Submit Registration
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
