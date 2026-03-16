/**
 * NoblePay Settings — Business profile, compliance, API, notifications, security
 *
 * Enterprise configuration dashboard with tabbed navigation for managing
 * business profile, compliance parameters, API keys, notification preferences,
 * and security settings. All data deterministic via seededRandom.
 */

import { useState, useMemo } from 'react';
import {
  User, Shield, Key, Bell, Lock, Save, Plus, Trash2,
  RotateCcw, AlertTriangle, Monitor, RefreshCw,
} from 'lucide-react';
import { SEOHead } from '@/components/SEOHead';
import { TopNav, Footer } from '@/components/SharedComponents';
import { GlassCard, SectionHeader, StatusBadge, CopyButton } from '@/components/PagePrimitives';
import { useApp } from '@/contexts/AppContext';
import { seededRandom, seededHex, seededAddress, formatNumber, truncateAddress } from '@/lib/utils';
import { BRAND } from '@/lib/constants';


// =============================================================================
// TYPES
// =============================================================================

type SettingsTab = 'profile' | 'compliance' | 'api' | 'notifications' | 'security';

interface APIKey {
  id: string;
  name: string;
  keyPrefix: string;
  created: string;
  lastUsed: string;
  status: 'Active' | 'Revoked';
}

interface Session {
  id: string;
  device: string;
  ip: string;
  location: string;
  lastActive: string;
  current: boolean;
}


// =============================================================================
// DATA GENERATORS
// =============================================================================

function generateAPIKeys(baseSeed: number): APIKey[] {
  const names = ['Production API', 'Staging API', 'Webhook Signer', 'Read-Only Analytics', 'Settlement Bot'];
  return names.map((name, i) => {
    const s = baseSeed + i * 11;
    const daysAgo = Math.floor(seededRandom(s) * 90);
    const lastUsedHours = Math.floor(seededRandom(s + 1) * 48);
    return {
      id: `key-${i}`,
      name,
      keyPrefix: `np_${seededHex(s + 2, 8)}...${seededHex(s + 3, 4)}`,
      created: `${daysAgo} days ago`,
      lastUsed: lastUsedHours === 0 ? 'Just now' : `${lastUsedHours}h ago`,
      status: seededRandom(s + 4) > 0.2 ? 'Active' as const : 'Revoked' as const,
    };
  });
}

function generateSessions(baseSeed: number): Session[] {
  const devices = [
    { device: 'Chrome on macOS', location: 'Dubai, UAE' },
    { device: 'Firefox on Windows', location: 'London, UK' },
    { device: 'Safari on iPhone', location: 'Abu Dhabi, UAE' },
    { device: 'API Client', location: 'Frankfurt, DE' },
    { device: 'Chrome on Linux', location: 'Mumbai, IN' },
  ];
  return devices.map((d, i) => {
    const s = baseSeed + i * 7;
    return {
      id: `session-${i}`,
      device: d.device,
      ip: `${Math.floor(100 + seededRandom(s) * 155)}.${Math.floor(seededRandom(s + 1) * 255)}.${Math.floor(seededRandom(s + 2) * 255)}.${Math.floor(1 + seededRandom(s + 3) * 254)}`,
      location: d.location,
      lastActive: i === 0 ? 'Now' : `${Math.floor(1 + seededRandom(s + 4) * 48)}h ago`,
      current: i === 0,
    };
  });
}


// =============================================================================
// TAB DEFINITIONS
// =============================================================================

const TABS: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
  { id: 'profile', label: 'Profile', icon: <User className="h-4 w-4" /> },
  { id: 'compliance', label: 'Compliance', icon: <Shield className="h-4 w-4" /> },
  { id: 'api', label: 'API Keys', icon: <Key className="h-4 w-4" /> },
  { id: 'notifications', label: 'Notifications', icon: <Bell className="h-4 w-4" /> },
  { id: 'security', label: 'Security', icon: <Lock className="h-4 w-4" /> },
];


// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function FormField({ label, value, readOnly = false, type = 'text', onChange }: {
  label: string;
  value: string;
  readOnly?: boolean;
  type?: string;
  onChange?: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs text-slate-400 uppercase tracking-wider mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange?.(e.target.value)}
        className={`w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-200 focus:border-red-500 focus:outline-none transition-colors ${
          readOnly ? 'opacity-60 cursor-not-allowed' : ''
        }`}
      />
    </div>
  );
}

function ToggleSwitch({ enabled, onChange, label }: {
  enabled: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-slate-300">{label}</span>
      <button
        onClick={() => onChange(!enabled)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          enabled ? 'bg-red-600' : 'bg-slate-700'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
            enabled ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}

function SliderField({ label, value, min, max, unit, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="py-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-slate-300">{label}</span>
        <span className="text-sm font-medium text-white">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none bg-slate-700 accent-red-600 cursor-pointer"
      />
      <div className="flex justify-between mt-1">
        <span className="text-xs text-slate-500">{min}{unit}</span>
        <span className="text-xs text-slate-500">{max}{unit}</span>
      </div>
    </div>
  );
}


// =============================================================================
// TAB PANELS
// =============================================================================

function ProfileTab() {
  const [jurisdiction, setJurisdiction] = useState('UAE - Abu Dhabi Global Market');
  const [complianceOfficer, setComplianceOfficer] = useState('aeth1q9f8k3m2p7w4x5v6n8b1c0d3e4f5g6h7j8k9l0m1n2');
  const [contactEmail, setContactEmail] = useState('compliance@alansari-exchange.ae');

  return (
    <div className="space-y-6">
      <GlassCard className="p-6" hover={false}>
        <h3 className="text-lg font-semibold text-white mb-6">Business Profile</h3>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <FormField label="Business Name" value="Al Ansari Exchange" readOnly />
          <FormField label="License Number" value="ADGM-FSP-2024-0847" readOnly />
          <FormField
            label="Jurisdiction"
            value={jurisdiction}
            onChange={setJurisdiction}
          />
          <FormField label="Business Type" value="Licensed Exchange House" readOnly />
          <div className="sm:col-span-2">
            <FormField
              label="Compliance Officer Address"
              value={complianceOfficer}
              onChange={setComplianceOfficer}
            />
          </div>
          <div className="sm:col-span-2">
            <FormField
              label="Contact Email"
              value={contactEmail}
              type="email"
              onChange={setContactEmail}
            />
          </div>
        </div>
        <div className="mt-6 flex justify-end">
          <button className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors">
            <Save className="h-4 w-4" />
            Save Changes
          </button>
        </div>
      </GlassCard>
    </div>
  );
}

function ComplianceTab() {
  const [riskTolerance, setRiskTolerance] = useState(50);
  const [autoApprove, setAutoApprove] = useState(30);
  const [manualReview, setManualReview] = useState(60);
  const [autoBlock, setAutoBlock] = useState(85);
  const [travelRuleShare, setTravelRuleShare] = useState(true);
  const [eddThreshold, setEddThreshold] = useState('10000');
  const [sanctionsLists, setSanctionsLists] = useState({
    ofac: true,
    uae: true,
    un: true,
    eu: false,
  });

  const riskLabel = riskTolerance < 33 ? 'Conservative' : riskTolerance < 66 ? 'Balanced' : 'Aggressive';
  const riskColor = riskTolerance < 33 ? 'text-emerald-400' : riskTolerance < 66 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="space-y-6">
      {/* Risk Configuration */}
      <GlassCard className="p-6" hover={false}>
        <h3 className="text-lg font-semibold text-white mb-6">Risk Configuration</h3>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-slate-300">Risk Tolerance</span>
            <span className={`text-sm font-semibold ${riskColor}`}>{riskLabel}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={riskTolerance}
            onChange={(e) => setRiskTolerance(Number(e.target.value))}
            className="w-full h-1.5 rounded-full appearance-none bg-slate-700 accent-red-600 cursor-pointer"
          />
          <div className="flex justify-between mt-1">
            <span className="text-xs text-emerald-400">Conservative</span>
            <span className="text-xs text-amber-400">Balanced</span>
            <span className="text-xs text-red-400">Aggressive</span>
          </div>
        </div>

        <div className="space-y-2 mt-6">
          <SliderField label="Auto-approve below risk score" value={autoApprove} min={0} max={50} onChange={setAutoApprove} />
          <SliderField label="Manual review required above" value={manualReview} min={50} max={100} onChange={setManualReview} />
          <SliderField label="Auto-block above risk score" value={autoBlock} min={70} max={100} onChange={setAutoBlock} />
        </div>
      </GlassCard>

      {/* Sanctions & Compliance */}
      <GlassCard className="p-6" hover={false}>
        <h3 className="text-lg font-semibold text-white mb-6">Sanctions & Compliance</h3>

        <div className="mb-6">
          <p className="text-xs text-slate-400 uppercase tracking-wider mb-3">Sanctions List Preferences</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { key: 'ofac' as const, label: 'OFAC (US)' },
              { key: 'uae' as const, label: 'UAE List' },
              { key: 'un' as const, label: 'UN Sanctions' },
              { key: 'eu' as const, label: 'EU Sanctions' },
            ].map((list) => (
              <label
                key={list.key}
                className={`flex items-center gap-2 rounded-lg border p-3 cursor-pointer transition-colors ${
                  sanctionsLists[list.key]
                    ? 'border-red-500/50 bg-red-500/10'
                    : 'border-slate-700 bg-slate-800/50 hover:border-slate-600'
                }`}
              >
                <input
                  type="checkbox"
                  checked={sanctionsLists[list.key]}
                  onChange={(e) => setSanctionsLists({ ...sanctionsLists, [list.key]: e.target.checked })}
                  className="rounded border-slate-600 bg-slate-800 text-red-600 focus:ring-red-500"
                />
                <span className="text-sm text-slate-200">{list.label}</span>
              </label>
            ))}
          </div>
        </div>

        <ToggleSwitch
          enabled={travelRuleShare}
          onChange={setTravelRuleShare}
          label="Travel Rule Auto-Share"
        />

        <div className="mt-4">
          <label className="block text-xs text-slate-400 uppercase tracking-wider mb-1.5">
            Enhanced Due Diligence Threshold
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
            <input
              type="text"
              value={eddThreshold}
              onChange={(e) => setEddThreshold(e.target.value.replace(/[^0-9]/g, ''))}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 pl-7 pr-3 py-2.5 text-sm text-slate-200 focus:border-red-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors">
            <Save className="h-4 w-4" />
            Save Compliance Settings
          </button>
        </div>
      </GlassCard>
    </div>
  );
}

function APIKeysTab() {
  const apiKeys = useMemo(() => generateAPIKeys(70000), []);
  const [webhookUrl, setWebhookUrl] = useState('https://api.alansari-exchange.ae/webhooks/noblepay');

  return (
    <div className="space-y-6">
      {/* API Keys Table */}
      <GlassCard className="p-6" hover={false}>
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold text-white">Active API Keys</h3>
          <button className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors">
            <Plus className="h-4 w-4" />
            Generate New Key
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700/50 text-left text-xs uppercase tracking-wider text-slate-400">
                <th className="py-3 pr-4">Key Name</th>
                <th className="py-3 pr-4">Key</th>
                <th className="py-3 pr-4 hidden sm:table-cell">Created</th>
                <th className="py-3 pr-4 hidden md:table-cell">Last Used</th>
                <th className="py-3 pr-4">Status</th>
                <th className="py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {apiKeys.map((key) => (
                <tr key={key.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                  <td className="py-3 pr-4 font-medium text-white">{key.name}</td>
                  <td className="py-3 pr-4">
                    <span className="inline-flex items-center gap-2 font-mono text-xs text-slate-400">
                      {key.keyPrefix}
                      <CopyButton text={key.keyPrefix} size="sm" />
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-slate-400 hidden sm:table-cell">{key.created}</td>
                  <td className="py-3 pr-4 text-slate-400 hidden md:table-cell">{key.lastUsed}</td>
                  <td className="py-3 pr-4">
                    <StatusBadge status={key.status} />
                  </td>
                  <td className="py-3">
                    <button className="rounded p-1 text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassCard>

      {/* Webhook & Rate Limits */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GlassCard className="p-6" hover={false}>
          <h3 className="text-lg font-semibold text-white mb-4">Webhook Configuration</h3>
          <FormField
            label="Webhook URL"
            value={webhookUrl}
            onChange={setWebhookUrl}
          />
          <div className="mt-4 flex justify-end">
            <button className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors">
              <Save className="h-4 w-4" />
              Save
            </button>
          </div>
        </GlassCard>

        <GlassCard className="p-6" hover={false}>
          <h3 className="text-lg font-semibold text-white mb-4">Rate Limits</h3>
          <div className="space-y-3">
            {[
              { label: 'Requests per minute', value: '1,000', tier: 'Enterprise' },
              { label: 'Requests per hour', value: '30,000', tier: 'Enterprise' },
              { label: 'Batch size limit', value: '500', tier: 'Enterprise' },
              { label: 'Webhook retries', value: '5', tier: 'All Tiers' },
            ].map((limit) => (
              <div key={limit.label} className="flex items-center justify-between rounded-lg border border-slate-700/50 bg-slate-800/50 p-3">
                <div>
                  <p className="text-sm text-slate-200">{limit.label}</p>
                  <p className="text-xs text-slate-500">{limit.tier}</p>
                </div>
                <span className="text-sm font-semibold text-white">{limit.value}</span>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>
    </div>
  );
}

function NotificationsTab() {
  const [paymentEmail, setPaymentEmail] = useState(true);
  const [paymentWebhook, setPaymentWebhook] = useState(true);
  const [paymentOnChain, setPaymentOnChain] = useState(false);
  const [complianceInfo, setComplianceInfo] = useState(false);
  const [complianceWarning, setComplianceWarning] = useState(true);
  const [complianceCritical, setComplianceCritical] = useState(true);
  const [settlementConfirm, setSettlementConfirm] = useState(true);
  const [dailySummary, setDailySummary] = useState(true);
  const [weeklySummary, setWeeklySummary] = useState(true);
  const [emailRecipients, setEmailRecipients] = useState('compliance@alansari-exchange.ae, ops@alansari-exchange.ae');

  return (
    <div className="space-y-6">
      {/* Payment Notifications */}
      <GlassCard className="p-6" hover={false}>
        <h3 className="text-lg font-semibold text-white mb-6">Payment Notifications</h3>
        <div className="space-y-1">
          <ToggleSwitch enabled={paymentEmail} onChange={setPaymentEmail} label="Email notifications" />
          <ToggleSwitch enabled={paymentWebhook} onChange={setPaymentWebhook} label="Webhook notifications" />
          <ToggleSwitch enabled={paymentOnChain} onChange={setPaymentOnChain} label="On-chain event indexing" />
        </div>
      </GlassCard>

      {/* Compliance Alerts */}
      <GlassCard className="p-6" hover={false}>
        <h3 className="text-lg font-semibold text-white mb-6">Compliance Alerts</h3>
        <div className="space-y-1">
          <ToggleSwitch enabled={complianceInfo} onChange={setComplianceInfo} label="Info alerts (routine checks)" />
          <ToggleSwitch enabled={complianceWarning} onChange={setComplianceWarning} label="Warning alerts (flags for review)" />
          <ToggleSwitch enabled={complianceCritical} onChange={setComplianceCritical} label="Critical alerts (blocked payments)" />
        </div>
      </GlassCard>

      {/* Settlement & Reports */}
      <GlassCard className="p-6" hover={false}>
        <h3 className="text-lg font-semibold text-white mb-6">Settlement & Reports</h3>
        <div className="space-y-1">
          <ToggleSwitch enabled={settlementConfirm} onChange={setSettlementConfirm} label="Settlement confirmations" />
          <ToggleSwitch enabled={dailySummary} onChange={setDailySummary} label="Daily summary report" />
          <ToggleSwitch enabled={weeklySummary} onChange={setWeeklySummary} label="Weekly summary report" />
        </div>
      </GlassCard>

      {/* Email Recipients */}
      <GlassCard className="p-6" hover={false}>
        <h3 className="text-lg font-semibold text-white mb-4">Email Recipients</h3>
        <label className="block text-xs text-slate-400 uppercase tracking-wider mb-1.5">
          Comma-separated email addresses
        </label>
        <textarea
          value={emailRecipients}
          onChange={(e) => setEmailRecipients(e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-200 focus:border-red-500 focus:outline-none resize-none"
        />
        <div className="mt-4 flex justify-end">
          <button className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-red-700 transition-colors">
            <Save className="h-4 w-4" />
            Save Notification Settings
          </button>
        </div>
      </GlassCard>
    </div>
  );
}

function SecurityTab() {
  const sessions = useMemo(() => generateSessions(71000), []);
  const [twoFaEnabled, setTwoFaEnabled] = useState(true);
  const [emergencyFreeze, setEmergencyFreeze] = useState(false);
  const [ipWhitelist, setIpWhitelist] = useState('10.0.0.0/8, 172.16.0.0/12, 192.168.1.0/24');

  return (
    <div className="space-y-6">
      {/* Two-Factor Authentication */}
      <GlassCard className="p-6" hover={false}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">Two-Factor Authentication</h3>
            <p className="text-sm text-slate-400 mt-1">Add an extra layer of security to your account</p>
          </div>
          <StatusBadge status={twoFaEnabled ? 'Active' : 'Pending'} />
        </div>
        <div className="mt-4">
          <ToggleSwitch enabled={twoFaEnabled} onChange={setTwoFaEnabled} label="Enable 2FA for all operations" />
        </div>
      </GlassCard>

      {/* Session Management */}
      <GlassCard className="p-6" hover={false}>
        <h3 className="text-lg font-semibold text-white mb-6">Active Sessions</h3>
        <div className="space-y-3">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`flex items-center justify-between rounded-lg border p-4 transition-colors ${
                session.current
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-slate-700/50 bg-slate-800/30 hover:bg-slate-800/50'
              }`}
            >
              <div className="flex items-center gap-3">
                <Monitor className={`h-5 w-5 ${session.current ? 'text-emerald-400' : 'text-slate-400'}`} />
                <div>
                  <p className="text-sm font-medium text-white">
                    {session.device}
                    {session.current && (
                      <span className="ml-2 text-xs text-emerald-400">(Current)</span>
                    )}
                  </p>
                  <p className="text-xs text-slate-400">
                    {session.ip} &middot; {session.location} &middot; {session.lastActive}
                  </p>
                </div>
              </div>
              {!session.current && (
                <button className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:border-red-500/50 hover:text-red-400 transition-colors">
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      </GlassCard>

      {/* IP Whitelist */}
      <GlassCard className="p-6" hover={false}>
        <h3 className="text-lg font-semibold text-white mb-4">IP Whitelist</h3>
        <p className="text-sm text-slate-400 mb-4">
          Restrict API access to specific IP addresses or CIDR ranges.
        </p>
        <label className="block text-xs text-slate-400 uppercase tracking-wider mb-1.5">
          Allowed IPs (comma-separated)
        </label>
        <textarea
          value={ipWhitelist}
          onChange={(e) => setIpWhitelist(e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-200 font-mono focus:border-red-500 focus:outline-none resize-none"
        />
        <div className="mt-4 flex justify-end">
          <button className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors">
            <Save className="h-4 w-4" />
            Update Whitelist
          </button>
        </div>
      </GlassCard>

      {/* Signing Key Rotation */}
      <GlassCard className="p-6" hover={false}>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">Signing Key Rotation</h3>
            <p className="text-sm text-slate-400 mt-1">
              Rotate your TEE signing key. Current key age: <span className="text-white font-medium">47 days</span>
            </p>
          </div>
          <button className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:border-amber-500/50 hover:text-amber-400 transition-colors">
            <RotateCcw className="h-4 w-4" />
            Rotate Key
          </button>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-3">
            <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Current Key</p>
            <p className="font-mono text-xs text-slate-200">0x8a3f...b7c2</p>
          </div>
          <div className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-3">
            <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Last Rotated</p>
            <p className="text-sm text-slate-200">47 days ago</p>
          </div>
          <div className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-3">
            <p className="text-xs text-slate-400 uppercase tracking-wider mb-1">Recommended Rotation</p>
            <p className="text-sm text-slate-200">Every 90 days</p>
          </div>
        </div>
      </GlassCard>

      {/* Emergency Freeze */}
      <GlassCard className={`p-6 ${emergencyFreeze ? 'border-red-500/50' : ''}`} hover={false}>
        <div className="flex items-start gap-4">
          <div className="rounded-lg bg-red-500/10 p-2.5">
            <AlertTriangle className="h-5 w-5 text-red-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-white">Emergency Freeze</h3>
            <p className="text-sm text-slate-400 mt-1">
              Immediately halt all payment processing. This will block all outgoing transactions until manually unfrozen.
            </p>
            <div className="mt-4">
              <ToggleSwitch
                enabled={emergencyFreeze}
                onChange={setEmergencyFreeze}
                label={emergencyFreeze ? 'FREEZE ACTIVE - All payments halted' : 'System operating normally'}
              />
            </div>
            {emergencyFreeze && (
              <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                <p className="text-xs text-red-300">
                  All payment processing is currently frozen. No outgoing transactions will be processed until this is disabled.
                </p>
              </div>
            )}
          </div>
        </div>
      </GlassCard>
    </div>
  );
}


// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  const tabPanels: Record<SettingsTab, React.ReactNode> = {
    profile: <ProfileTab />,
    compliance: <ComplianceTab />,
    api: <APIKeysTab />,
    notifications: <NotificationsTab />,
    security: <SecurityTab />,
  };

  return (
    <>
      <SEOHead
        title="Settings"
        description="NoblePay business profile, compliance configuration, API management, and security settings."
        path="/settings"
      />

      <div className="min-h-screen bg-[#0f172a] text-slate-100">
        <TopNav activePage="settings" />

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">

          <SectionHeader
            title="Settings"
            subtitle="Manage your business profile, compliance rules, API access, and security"
          />

          {/* Tab Navigation */}
          <div className="mb-8">
            <div className="flex flex-wrap gap-1 rounded-xl bg-slate-800/50 p-1 w-fit">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? 'bg-red-600 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Active Tab Panel */}
          {tabPanels[activeTab]}

        </main>

        <Footer />
      </div>
    </>
  );
}
