/**
 * NoblePay Treasury — Treasury Management Console
 *
 * Every figure on this page is read from the deployed MultiSigTreasury. The
 * page previously generated its own contents with seededRandom: twelve
 * proposals with invented titles, named human signers, Aave/Lido yield
 * strategies and a twelve-month AUM curve, none of which corresponded to any
 * contract state. It looked like a treasury console and reported nothing.
 *
 * Two modelling corrections came with the rewrite:
 *
 *  - The treasury is a multi-sig, not a token-weighted DAO. Approval is a
 *    count of SIGNER_ROLE holders measured against a tier threshold. There are
 *    no vote weights, no quorum bar, and no "votes against" to plot.
 *  - Signers are addresses. The contract stores no names, so none are shown.
 *
 * Charts are derived from executed proposals and live allocations rather than
 * from a fabricated time series; where the chain cannot answer a question, the
 * section says so instead of filling the space.
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { SEOHead } from "@/components/SEOHead";
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import {
  Vault,
  TrendingUp,
  Users,
  Clock,
  CheckCircle,
  Plus,
  Shield,
  AlertCircle,
  Timer,
  FileText,
  RefreshCw,
  Wallet,
  XCircle,
  Send,
  Banknote,
  Layers,
  Activity,
  Hash,
  Ban,
} from "lucide-react";
import { useAccount } from "wagmi";
import {
  TopNav,
  Footer,
  Modal,
  Tabs,
} from "@/components/SharedComponents";
import { truncateAddress } from "@/lib/utils";
import { BRAND } from "@/lib/constants";
import { GlassCard, SectionHeader } from "@/components/PagePrimitives";
import {
  useTreasury,
  useProposalActions,
  useBudgetActions,
  useTreasuryActivity,
  PROPOSAL_STATUS,
  TX_TIER,
  SPENDING_CATEGORY,
  NATIVE_TOKEN,
  NO_BUDGET,
  type Proposal,
  type Budget,
  type TokenHolding,
  type ActivityEntry,
} from "@/hooks/useTreasury";

// =============================================================================
// CONSTANTS
// =============================================================================

const CHART_COLORS = [
  "#DC2626",
  "#0EA5E9",
  "#10B981",
  "#F59E0B",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#F87171",
];

/** Keyed by the contract's ProposalStatus enum name. */
const PROPOSAL_STATUS_STYLES: Record<string, string> = {
  Pending: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  Approved: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  Executed: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  Rejected: "bg-red-500/20 text-red-400 border-red-500/30",
  Cancelled: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  Expired: "bg-slate-500/20 text-slate-400 border-slate-500/30",
};

const PROPOSAL_STATUS_DOT: Record<string, string> = {
  Pending: "bg-amber-400",
  Approved: "bg-emerald-400",
  Executed: "bg-blue-400",
  Rejected: "bg-red-400",
  Cancelled: "bg-slate-400",
  Expired: "bg-slate-400",
};

const NATIVE_SYMBOL = "AETHEL";
const NATIVE_DECIMALS = 18;
/** The contract's budget/threshold accounting unit: USD-equivalent, 6 dp. */
const USD_DECIMALS = 6;

// =============================================================================
// FORMATTING
// =============================================================================

/** bigint -> number for display and charts only; never for contract args. */
function toNumber(amount: bigint, decimals: number): number {
  if (decimals === 0) return Number(amount);
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = amount % base;
  return Number(whole) + Number(frac) / Number(base);
}

function formatAmount(n: number, symbol: string): string {
  const abs = Math.abs(n);
  const body =
    abs >= 1_000_000_000
      ? `${(n / 1_000_000_000).toFixed(2)}B`
      : abs >= 1_000_000
        ? `${(n / 1_000_000).toFixed(2)}M`
        : abs >= 1_000
          ? `${(n / 1_000).toFixed(1)}K`
          : abs >= 1
            ? // Hold two decimal places for ordinary amounts. Trimming "10.00"
              // to "10" saves two characters and costs the reader the cue that
              // this column is money, and that the value is exact rather than
              // rounded to a whole unit.
              n.toFixed(2)
            : // Below one unit, two places would round most balances to 0.00,
              // so show six and drop only the padding zeros.
              n.toFixed(6).replace(/\.?0+$/, "");
  return symbol ? `${body} ${symbol}` : body;
}

function formatUSD(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function timeAgo(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 1000) return "just now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function timeUntil(timestamp: number): string {
  const diff = Math.max(0, timestamp - Date.now());
  if (diff < 60000) return "less than 1m";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000)
    return `${Math.floor(diff / 3600000)}h ${Math.floor((diff % 3600000) / 60000)}m`;
  return `${Math.floor(diff / 86400000)}d ${Math.floor((diff % 86400000) / 3600000)}h`;
}

/**
 * Resolve an asset's symbol and decimals from the treasury's own holdings.
 * A token the treasury has never held is shown by address rather than guessed
 * at — assuming 18 decimals would silently misreport the amount by orders of
 * magnitude.
 */
function useAssetResolver(tokens: TokenHolding[]) {
  return useCallback(
    (token: string): { symbol: string; decimals: number; known: boolean } => {
      if (token.toLowerCase() === NATIVE_TOKEN.toLowerCase()) {
        return { symbol: NATIVE_SYMBOL, decimals: NATIVE_DECIMALS, known: true };
      }
      const hit = tokens.find((t) => t.token.toLowerCase() === token.toLowerCase());
      if (hit) return { symbol: hit.symbol, decimals: hit.decimals, known: true };
      return { symbol: truncateAddress(token), decimals: 0, known: false };
    },
    [tokens],
  );
}

// =============================================================================
// SMALL COMPONENTS
// =============================================================================

function ProposalStatusBadge({ status }: { status: number }) {
  const name = PROPOSAL_STATUS[status] ?? "Unknown";
  const style =
    PROPOSAL_STATUS_STYLES[name] ||
    "bg-slate-700/50 text-slate-300 border-slate-600/30";
  const dot = PROPOSAL_STATUS_DOT[name] || "bg-slate-400";
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${style}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${dot} ${name === "Pending" ? "animate-pulse" : ""}`}
      />
      {name}
    </span>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <GlassCard className="p-4" hover={false}>
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4 text-slate-400" />
        <span className="text-xs text-slate-400 truncate">{label}</span>
      </div>
      <p className="text-xl font-bold text-white truncate">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-500 truncate">{sub}</p>}
    </GlassCard>
  );
}

function ProgressBar({
  value,
  max,
  color = "bg-red-500",
  height = "h-2",
}: {
  value: number;
  max: number;
  color?: string;
  height?: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const barColor = pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : color;
  return (
    <div className={`w-full ${height} rounded-full bg-slate-700/50 overflow-hidden`}>
      <div
        className={`${height} rounded-full transition-all duration-500 ${barColor}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function CustomTooltip({
  active,
  payload,
  label,
  formatValue,
}: {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number | string }>;
  label?: string;
  formatValue?: (v: number | string) => string;
}) {
  if (!active || !payload?.length) return null;
  const fmt =
    formatValue ||
    ((v: number | string) => (typeof v === "number" ? formatUSD(v) : String(v)));
  return (
    <div className="bg-slate-800 text-white px-3 py-2 rounded-lg text-xs shadow-xl border border-slate-700">
      {label && <p className="font-medium mb-1">{label}</p>}
      {payload.map((entry, i) => (
        <p key={i} className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          {entry.name}: {fmt(entry.value)}
        </p>
      ))}
    </div>
  );
}

/** Shown wherever the chain has nothing to report, instead of filler data. */
function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ElementType;
  title: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="p-3 rounded-xl bg-slate-800/60 border border-slate-700 mb-3">
        <Icon className="w-6 h-6 text-slate-500" />
      </div>
      <p className="text-sm font-medium text-slate-300">{title}</p>
      <p className="mt-1 text-xs text-slate-500 max-w-sm">{body}</p>
    </div>
  );
}

function ActivityIcon({ kind }: { kind: ActivityEntry["kind"] }) {
  const map: Record<string, { icon: React.ReactNode; bg: string }> = {
    ProposalCreated: {
      icon: <FileText className="w-3.5 h-3.5 text-blue-400" />,
      bg: "bg-blue-500/10 border-blue-500/20",
    },
    ProposalApproved: {
      icon: <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />,
      bg: "bg-emerald-500/10 border-emerald-500/20",
    },
    ProposalRejected: {
      icon: <XCircle className="w-3.5 h-3.5 text-red-400" />,
      bg: "bg-red-500/10 border-red-500/20",
    },
    ProposalExecuted: {
      icon: <Send className="w-3.5 h-3.5 text-blue-400" />,
      bg: "bg-blue-500/10 border-blue-500/20",
    },
    ProposalCancelled: {
      icon: <Ban className="w-3.5 h-3.5 text-slate-400" />,
      bg: "bg-slate-500/10 border-slate-500/20",
    },
    BudgetCreated: {
      icon: <Banknote className="w-3.5 h-3.5 text-cyan-400" />,
      bg: "bg-cyan-500/10 border-cyan-500/20",
    },
    BudgetSpent: {
      icon: <Banknote className="w-3.5 h-3.5 text-cyan-400" />,
      bg: "bg-cyan-500/10 border-cyan-500/20",
    },
    YieldAllocated: {
      icon: <TrendingUp className="w-3.5 h-3.5 text-purple-400" />,
      bg: "bg-purple-500/10 border-purple-500/20",
    },
    SignerAdded: {
      icon: <Users className="w-3.5 h-3.5 text-amber-400" />,
      bg: "bg-amber-500/10 border-amber-500/20",
    },
    SignerRemoved: {
      icon: <Users className="w-3.5 h-3.5 text-amber-400" />,
      bg: "bg-amber-500/10 border-amber-500/20",
    },
  };
  const entry = map[kind] ?? {
    icon: <Activity className="w-3.5 h-3.5 text-slate-400" />,
    bg: "bg-slate-500/10 border-slate-500/20",
  };
  return <div className={`p-1.5 rounded-lg border ${entry.bg}`}>{entry.icon}</div>;
}

// =============================================================================
// NEW PROPOSAL MODAL
// =============================================================================

function NewProposalModal({
  open,
  onClose,
  tokens,
  budgets,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  tokens: TokenHolding[];
  budgets: Budget[];
  onSubmitted: () => void;
}) {
  const { createProposal, pending } = useProposalActions();
  const [recipient, setRecipient] = useState("");
  const [token, setToken] = useState<string>(NATIVE_TOKEN);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(0);
  const [description, setDescription] = useState("");
  const [isEmergency, setIsEmergency] = useState(false);
  const [budgetId, setBudgetId] = useState<string>(NO_BUDGET);
  const [error, setError] = useState<string | null>(null);

  const decimals =
    token === NATIVE_TOKEN
      ? NATIVE_DECIMALS
      : (tokens.find((t) => t.token === token)?.decimals ?? 18);

  const reset = () => {
    setRecipient("");
    setToken(NATIVE_TOKEN);
    setAmount("");
    setCategory(0);
    setDescription("");
    setIsEmergency(false);
    setBudgetId(NO_BUDGET);
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      setError("Recipient must be a 20-byte hex address.");
      return;
    }
    let units: bigint;
    try {
      const [whole, frac = ""] = amount.trim().split(".");
      if (!whole && !frac) throw new Error("empty");
      const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
      units = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
    } catch {
      setError("Amount must be a positive decimal number.");
      return;
    }
    if (units <= 0n) {
      setError("Amount must be greater than zero.");
      return;
    }
    if (!description.trim()) {
      setError("A description is required — it is stored on chain.");
      return;
    }
    try {
      await createProposal({
        recipient: recipient as `0x${string}`,
        token: token as `0x${string}`,
        amount: units,
        category,
        description: description.trim(),
        isEmergency,
        budgetId: budgetId as `0x${string}`,
      });
      reset();
      onSubmitted();
      onClose();
    } catch (err) {
      setError((err as Error)?.message ?? "Transaction failed.");
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New treasury proposal">
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Recipient</label>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x…"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm font-mono"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Asset</label>
            <select
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
            >
              <option value={NATIVE_TOKEN}>{NATIVE_SYMBOL} (native)</option>
              {tokens.map((t) => (
                <option key={t.token} value={t.token}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Amount</label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              inputMode="decimal"
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
            >
              {SPENDING_CATEGORY.map((c, i) => (
                <option key={c} value={i}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Budget</label>
            <select
              value={budgetId}
              onChange={(e) => setBudgetId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
            >
              <option value={NO_BUDGET}>Not charged to a budget</option>
              {budgets.map((b) => (
                <option key={b.budgetId} value={b.budgetId}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs text-slate-400 mb-1">
            Description <span className="text-slate-600">(stored on chain)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={isEmergency}
            onChange={(e) => setIsEmergency(e.target.checked)}
            className="rounded border-slate-600 bg-slate-800"
          />
          Emergency proposal
          <span className="text-xs text-slate-500">
            (higher approval threshold, shorter timelock)
          </span>
        </label>

        {token === NATIVE_TOKEN && (
          <p className="text-xs text-amber-400/90 flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            A native proposal is funded at creation — the amount is sent with
            this transaction and held by the treasury until execution.
          </p>
        )}

        {error && (
          <p className="text-xs text-red-400 flex items-start gap-1.5">
            <XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={pending !== null}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
          >
            {pending === "create" ? "Submitting…" : "Create proposal"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// =============================================================================
// PROPOSAL DETAIL MODAL
// =============================================================================

function ProposalDetail({
  proposal,
  onClose,
  isSigner,
  onChanged,
  resolve,
}: {
  proposal: Proposal | null;
  onClose: () => void;
  isSigner: boolean;
  onChanged: () => void;
  resolve: (token: string) => { symbol: string; decimals: number; known: boolean };
}) {
  const { approveProposal, rejectProposal, executeProposal, cancelProposal, pending } =
    useProposalActions();
  const { address } = useAccount();
  const [error, setError] = useState<string | null>(null);

  if (!proposal) return null;

  const asset = resolve(proposal.token);
  const statusName = PROPOSAL_STATUS[proposal.status];
  const timelockPassed = Date.now() >= proposal.timelockExpiry;
  const isProposer =
    address && proposal.proposer.toLowerCase() === address.toLowerCase();

  const run = async (fn: (id: `0x${string}`) => Promise<unknown>) => {
    setError(null);
    try {
      await fn(proposal.proposalId);
      onChanged();
      onClose();
    } catch (err) {
      setError((err as Error)?.message ?? "Transaction failed.");
    }
  };

  return (
    <Modal open onClose={onClose} title="Proposal">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-white break-words">{proposal.description}</p>
            <p className="mt-1 text-xs text-slate-500 font-mono break-all">
              {proposal.proposalId}
            </p>
          </div>
          <ProposalStatusBadge status={proposal.status} />
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-slate-400">Amount</p>
            <p className="text-white font-medium">
              {asset.known
                ? formatAmount(toNumber(proposal.amount, asset.decimals), asset.symbol)
                : `${proposal.amount.toString()} units`}
            </p>
            {!asset.known && (
              <p className="text-xs text-slate-500">
                token {truncateAddress(proposal.token)} — decimals unknown
              </p>
            )}
          </div>
          <div>
            <p className="text-xs text-slate-400">Tier</p>
            <p className="text-white font-medium">
              {TX_TIER[proposal.tier] ?? "Unknown"}
              {proposal.isEmergency && (
                <span className="ml-1 text-xs text-amber-400">emergency</span>
              )}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-400">Recipient</p>
            <p className="text-white font-mono text-xs">
              {truncateAddress(proposal.recipient)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-400">Proposer</p>
            <p className="text-white font-mono text-xs">
              {truncateAddress(proposal.proposer)}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-400">Category</p>
            <p className="text-white">{SPENDING_CATEGORY[proposal.category]}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400">Created</p>
            <p className="text-white">{timeAgo(proposal.createdAt)}</p>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-slate-400">Signer approvals</span>
            <span className="text-white font-medium">
              {proposal.approvalCount} of {proposal.requiredApprovals}
            </span>
          </div>
          <ProgressBar
            value={proposal.approvalCount}
            max={proposal.requiredApprovals}
            color="bg-emerald-500"
          />
          {proposal.rejectionCount > 0 && (
            <p className="mt-1 text-xs text-red-400">
              {proposal.rejectionCount} rejection
              {proposal.rejectionCount === 1 ? "" : "s"}
            </p>
          )}
        </div>

        <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-xs space-y-1">
          <div className="flex items-center gap-1.5 text-slate-300">
            <Timer className="w-3.5 h-3.5" />
            {timelockPassed ? (
              <span>Timelock elapsed — executable once approved.</span>
            ) : (
              <span>Timelock ends in {timeUntil(proposal.timelockExpiry)}.</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-slate-400">
            <Clock className="w-3.5 h-3.5" />
            Expires {timeUntil(proposal.expiresAt)} from now
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400 flex items-start gap-1.5">
            <XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            {error}
          </p>
        )}

        {!isSigner && statusName === "Pending" && (
          <p className="text-xs text-slate-500 flex items-start gap-1.5">
            <Shield className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            The connected account does not hold SIGNER_ROLE, so it cannot
            approve or reject.
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {statusName === "Pending" && isSigner && (
            <>
              <button
                onClick={() => run(rejectProposal)}
                disabled={pending !== null}
                className="px-3 py-2 rounded-lg text-sm border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-50"
              >
                {pending === "reject" ? "Rejecting…" : "Reject"}
              </button>
              <button
                onClick={() => run(approveProposal)}
                disabled={pending !== null}
                className="px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {pending === "approve" ? "Approving…" : "Approve"}
              </button>
            </>
          )}
          {statusName === "Approved" && (
            <button
              onClick={() => run(executeProposal)}
              disabled={pending !== null || !timelockPassed}
              title={timelockPassed ? undefined : "Timelock has not elapsed"}
              className="px-3 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {pending === "execute" ? "Executing…" : "Execute"}
            </button>
          )}
          {statusName === "Pending" && isProposer && (
            <button
              onClick={() => run(cancelProposal)}
              disabled={pending !== null}
              className="px-3 py-2 rounded-lg text-sm border border-slate-600 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              {pending === "cancel" ? "Cancelling…" : "Cancel"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// =============================================================================
// NEW BUDGET MODAL
// =============================================================================

function NewBudgetModal({
  open,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const { createBudget, pending } = useBudgetActions();
  const [name, setName] = useState("");
  const [category, setCategory] = useState(0);
  const [total, setTotal] = useState("");
  const [daily, setDaily] = useState("");
  const [weekly, setWeekly] = useState("");
  const [monthly, setMonthly] = useState("");
  const [periodDays, setPeriodDays] = useState("30");
  const [error, setError] = useState<string | null>(null);

  const toUsdUnits = (v: string) => {
    const [whole, frac = ""] = v.trim().split(".");
    const padded = (frac + "000000").slice(0, USD_DECIMALS);
    return BigInt(whole || "0") * 10n ** BigInt(USD_DECIMALS) + BigInt(padded || "0");
  };

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Budget name is required.");
      return;
    }
    let args;
    try {
      args = {
        name: name.trim(),
        category,
        totalAllocation: toUsdUnits(total),
        dailyLimit: toUsdUnits(daily),
        weeklyLimit: toUsdUnits(weekly),
        monthlyLimit: toUsdUnits(monthly),
        periodDuration: BigInt(Math.max(1, Number(periodDays))) * 86_400n,
      };
    } catch {
      setError("All limits must be decimal numbers.");
      return;
    }
    if (args.totalAllocation <= 0n) {
      setError("Total allocation must be greater than zero.");
      return;
    }
    try {
      await createBudget(args);
      onSubmitted();
      onClose();
    } catch (err) {
      setError((err as Error)?.message ?? "Transaction failed.");
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New budget">
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          Budget amounts are held in the contract&apos;s USD-equivalent unit with
          6 decimal places.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
            >
              {SPENDING_CATEGORY.map((c, i) => (
                <option key={c} value={i}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[
            ["Total allocation", total, setTotal],
            ["Daily limit", daily, setDaily],
            ["Weekly limit", weekly, setWeekly],
            ["Monthly limit", monthly, setMonthly],
          ].map(([label, value, setter]) => (
            <div key={label as string}>
              <label className="block text-xs text-slate-400 mb-1">
                {label as string}
              </label>
              <input
                value={value as string}
                onChange={(e) => (setter as (v: string) => void)(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
              />
            </div>
          ))}
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">
            Budget period (days)
          </label>
          <input
            value={periodDays}
            onChange={(e) => setPeriodDays(e.target.value)}
            inputMode="numeric"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
          />
        </div>
        {error && (
          <p className="text-xs text-red-400 flex items-start gap-1.5">
            <XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={pending}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
          >
            {pending ? "Submitting…" : "Create budget"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export default function TreasuryPage() {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [proposalFilter, setProposalFilter] = useState<string>("all");
  const [showNewProposal, setShowNewProposal] = useState(false);
  const [showNewBudget, setShowNewBudget] = useState(false);
  const [selected, setSelected] = useState<Proposal | null>(null);

  useEffect(() => setMounted(true), []);

  const { isConnected } = useAccount();
  const {
    summary,
    proposals,
    budgets,
    protocols,
    signers,
    signerConfig,
    tiers,
    isSigner,
    isLoading,
    error,
    refetch,
  } = useTreasury();
  const { activity, isLoading: activityLoading, refetch: refetchActivity } =
    useTreasuryActivity();

  const resolve = useAssetResolver(summary.tokens);

  const refreshAll = useCallback(() => {
    refetch();
    refetchActivity();
  }, [refetch, refetchActivity]);

  // --- derived ------------------------------------------------------------

  const filteredProposals = useMemo(() => {
    if (proposalFilter === "all") return proposals;
    return proposals.filter((p) => PROPOSAL_STATUS[p.status] === proposalFilter);
  }, [proposals, proposalFilter]);

  /**
   * Outflow already committed but not yet paid: proposals that are pending or
   * approved still hold a claim on the treasury. Showing gross balance alone
   * would overstate what is actually free to allocate.
   */
  const committedByAsset = useMemo(() => {
    const map = new Map<string, bigint>();
    for (const p of proposals) {
      const name = PROPOSAL_STATUS[p.status];
      if (name !== "Pending" && name !== "Approved") continue;
      const key = p.token.toLowerCase();
      map.set(key, (map.get(key) ?? 0n) + p.amount);
    }
    return map;
  }, [proposals]);

  const nativeCommitted = committedByAsset.get(NATIVE_TOKEN.toLowerCase()) ?? 0n;
  const nativeAvailable =
    summary.nativeBalance > nativeCommitted
      ? summary.nativeBalance - nativeCommitted
      : 0n;

  /** Executed outflow per spending category — real, from executed proposals. */
  const spendingByCategory = useMemo(() => {
    const totals = new Map<number, number>();
    for (const p of proposals) {
      if (PROPOSAL_STATUS[p.status] !== "Executed") continue;
      const asset = resolve(p.token);
      if (!asset.known) continue;
      const value = toNumber(p.amount, asset.decimals);
      totals.set(p.category, (totals.get(p.category) ?? 0) + value);
    }
    return [...totals.entries()]
      .map(([category, value]) => ({
        name: SPENDING_CATEGORY[category] ?? "Other",
        value,
      }))
      .sort((a, b) => b.value - a.value);
  }, [proposals, resolve]);

  /** Cumulative disbursement over time, replayed from executed proposals. */
  const disbursementSeries = useMemo(() => {
    const executed = proposals
      .filter((p) => PROPOSAL_STATUS[p.status] === "Executed")
      .sort((a, b) => a.createdAt - b.createdAt);
    let running = 0;
    return executed.map((p) => {
      const asset = resolve(p.token);
      running += asset.known ? toNumber(p.amount, asset.decimals) : 0;
      return {
        label: new Date(p.createdAt).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
        value: running,
      };
    });
  }, [proposals, resolve]);

  const yieldAllocation = useMemo(
    () =>
      protocols
        .filter((p) => p.active && p.currentAllocation > 0n)
        .map((p) => ({
          name: p.name,
          value: toNumber(p.currentAllocation, USD_DECIMALS),
        })),
    [protocols],
  );

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "proposals", label: `Proposals (${proposals.length})` },
    { id: "budgets", label: `Budgets (${budgets.length})` },
    { id: "yield", label: `Yield (${protocols.length})` },
    { id: "activity", label: "Activity" },
  ];

  // Avoid a hydration mismatch: all content below depends on chain reads.
  if (!mounted) return null;

  return (
    <>
      <SEOHead
        title="Treasury — NoblePay"
        description="Multi-signature treasury management: proposals, budgets, yield allocation and signer governance."
      />
      <div className="min-h-screen bg-slate-950">
        <TopNav />

        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
            <div>
              <div className="flex items-center gap-2">
                <Vault className="w-6 h-6 text-red-500" />
                <h1 className="text-2xl font-bold text-white">Treasury</h1>
              </div>
              <p className="mt-1 text-sm text-slate-400">
                Multi-signature treasury on Aethelred. Approvals are counted per
                signer against a tier threshold — this is not token voting.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={refreshAll}
                className="p-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800"
                aria-label="Refresh treasury data"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
              </button>
              <button
                onClick={() => setShowNewProposal(true)}
                disabled={!isConnected}
                title={isConnected ? undefined : "Connect a wallet to propose"}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
                New proposal
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-4 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm text-red-300">
                  Could not read the treasury contract.
                </p>
                <p className="text-xs text-red-400/80 mt-0.5">{error.message}</p>
              </div>
            </div>
          )}

          {/* Stat row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard
              icon={Wallet}
              label={`${NATIVE_SYMBOL} balance`}
              value={formatAmount(
                toNumber(summary.nativeBalance, NATIVE_DECIMALS),
                NATIVE_SYMBOL,
              )}
              sub={
                nativeCommitted > 0n
                  ? `${formatAmount(toNumber(nativeAvailable, NATIVE_DECIMALS), NATIVE_SYMBOL)} uncommitted`
                  : "none committed"
              }
            />
            <StatCard
              icon={FileText}
              label="Awaiting approval"
              value={String(summary.pendingProposals)}
              sub={`${summary.approvedAwaitingExecution} approved, awaiting execution`}
            />
            <StatCard
              icon={Users}
              label="Signers"
              value={String(summary.totalSigners)}
              sub={
                signerConfig
                  ? `${signerConfig.smallThreshold}/${signerConfig.mediumThreshold}/${signerConfig.largeThreshold} threshold by tier`
                  : undefined
              }
            />
            <StatCard
              icon={TrendingUp}
              label="Deployed in yield"
              value={formatUSD(toNumber(summary.deployedInYield, USD_DECIMALS))}
              sub={`${protocols.filter((p) => p.active).length} active protocol(s)`}
            />
          </div>

          <div className="mb-6">
            <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
          </div>

          {/* ---------------------------------------------------------------- */}
          {activeTab === "overview" && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <GlassCard className="p-5" hover={false}>
                  <SectionHeader
                    title="Holdings"
                    subtitle="Native balance and every token the treasury supports"
                  />
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center justify-between py-2 border-b border-slate-800">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: BRAND.red }}
                        />
                        <span className="text-sm text-white">{NATIVE_SYMBOL}</span>
                        <span className="text-xs text-slate-500">native</span>
                      </div>
                      <span className="text-sm text-white font-medium">
                        {formatAmount(
                          toNumber(summary.nativeBalance, NATIVE_DECIMALS),
                          "",
                        )}
                      </span>
                    </div>
                    {summary.tokens.map((t, i) => (
                      <div
                        key={t.token}
                        className="flex items-center justify-between py-2 border-b border-slate-800 last:border-0"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{
                              backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
                            }}
                          />
                          <span className="text-sm text-white">{t.symbol}</span>
                          <span className="text-xs text-slate-500 font-mono truncate">
                            {truncateAddress(t.token)}
                          </span>
                        </div>
                        <span className="text-sm text-white font-medium">
                          {formatAmount(toNumber(t.balance, t.decimals), "")}
                        </span>
                      </div>
                    ))}
                    {summary.tokens.length === 0 && !isLoading && (
                      <p className="text-xs text-slate-500 py-2">
                        No ERC20 tokens have been marked supported on this
                        treasury yet.
                      </p>
                    )}
                  </div>
                </GlassCard>

                <GlassCard className="p-5" hover={false}>
                  <SectionHeader
                    title="Approval matrix"
                    subtitle="Read from the contract's own thresholds and timelocks"
                  />
                  <div className="mt-4 overflow-x-auto">
                    {tiers.length === 0 ? (
                      <p className="text-xs text-slate-500 py-2">
                        Signer configuration unavailable.
                      </p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-xs text-slate-400 border-b border-slate-800">
                            <th className="text-left pb-2">Tier</th>
                            <th className="text-left pb-2">Range (USD)</th>
                            <th className="text-right pb-2">Signatures</th>
                            <th className="text-right pb-2">Timelock</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tiers.map((t) => (
                            <tr key={t.tier} className="border-b border-slate-800/60">
                              <td className="py-2 text-white">{t.tier}</td>
                              <td className="py-2 text-slate-300 text-xs">
                                {t.tier === "Emergency"
                                  ? "any (flagged)"
                                  : `${formatUSD(toNumber(t.minAmount, USD_DECIMALS))} – ${
                                      t.maxAmount === null
                                        ? "∞"
                                        : formatUSD(toNumber(t.maxAmount, USD_DECIMALS))
                                    }`}
                              </td>
                              <td className="py-2 text-right text-white">
                                {t.requiredSignatures}
                              </td>
                              <td className="py-2 text-right text-slate-300 text-xs">
                                {t.timelockSeconds / 3600}h
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </GlassCard>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <GlassCard className="p-5" hover={false}>
                  <SectionHeader
                    title="Executed spend by category"
                    subtitle="Aggregated from executed proposals"
                  />
                  {spendingByCategory.length === 0 ? (
                    <EmptyState
                      icon={Layers}
                      title="No executed proposals yet"
                      body="Category totals appear once proposals have been executed on chain."
                    />
                  ) : (
                    <div className="mt-4 h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={spendingByCategory}
                            dataKey="value"
                            nameKey="name"
                            innerRadius={55}
                            outerRadius={90}
                            paddingAngle={2}
                          >
                            {spendingByCategory.map((_, i) => (
                              <Cell
                                key={i}
                                fill={CHART_COLORS[i % CHART_COLORS.length]}
                              />
                            ))}
                          </Pie>
                          <RechartsTooltip
                            content={
                              <CustomTooltip
                                formatValue={(v) =>
                                  typeof v === "number" ? v.toFixed(4) : String(v)
                                }
                              />
                            }
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </GlassCard>

                <GlassCard className="p-5" hover={false}>
                  <SectionHeader
                    title="Cumulative disbursement"
                    subtitle="Replayed from executed proposals, newest last"
                  />
                  {disbursementSeries.length === 0 ? (
                    <EmptyState
                      icon={Activity}
                      title="Nothing disbursed yet"
                      body="This curve is built from executed proposals; it is not a projection."
                    />
                  ) : (
                    <div className="mt-4 h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={disbursementSeries}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                          <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
                          <YAxis stroke="#64748b" fontSize={11} />
                          <RechartsTooltip
                            content={
                              <CustomTooltip
                                formatValue={(v) =>
                                  typeof v === "number" ? v.toFixed(4) : String(v)
                                }
                              />
                            }
                          />
                          <Area
                            type="monotone"
                            dataKey="value"
                            name="Cumulative"
                            stroke={BRAND.red}
                            fill={BRAND.red}
                            fillOpacity={0.15}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </GlassCard>
              </div>

              <GlassCard className="p-5" hover={false}>
                <SectionHeader
                  title="Signers"
                  subtitle="Addresses holding SIGNER_ROLE on this treasury"
                />
                {signers.length === 0 ? (
                  <EmptyState
                    icon={Users}
                    title="No signers returned"
                    body="The contract's signer set is empty or could not be read."
                  />
                ) : (
                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {signers.map((s) => (
                      <div
                        key={s}
                        className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2"
                      >
                        <Shield className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                        <span className="text-xs font-mono text-slate-300 truncate">
                          {s}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </GlassCard>
            </div>
          )}

          {/* ---------------------------------------------------------------- */}
          {activeTab === "proposals" && (
            <GlassCard className="p-5" hover={false}>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <SectionHeader
                  title="Proposals"
                  subtitle="Every proposal ever created on this treasury"
                />
                <div className="flex flex-wrap gap-1.5">
                  {["all", ...PROPOSAL_STATUS].map((f) => (
                    <button
                      key={f}
                      onClick={() => setProposalFilter(f)}
                      className={`px-2.5 py-1 rounded-lg text-xs border ${
                        proposalFilter === f
                          ? "bg-red-600 text-white border-red-500"
                          : "border-slate-700 text-slate-400 hover:bg-slate-800"
                      }`}
                    >
                      {f === "all" ? "All" : f}
                    </button>
                  ))}
                </div>
              </div>

              {isLoading && proposals.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">
                  Reading proposals from chain…
                </p>
              ) : filteredProposals.length === 0 ? (
                <EmptyState
                  icon={FileText}
                  title={
                    proposals.length === 0
                      ? "No proposals yet"
                      : "No proposals match this filter"
                  }
                  body={
                    proposals.length === 0
                      ? "Create a proposal to move funds out of the treasury. It will need signer approval and a timelock before it can execute."
                      : "Clear the filter to see the full list."
                  }
                />
              ) : (
                <div className="space-y-2">
                  {filteredProposals.map((p) => {
                    const asset = resolve(p.token);
                    return (
                      <button
                        key={p.proposalId}
                        onClick={() => setSelected(p)}
                        className="w-full text-left rounded-lg border border-slate-800 bg-slate-900/40 hover:bg-slate-900/70 p-4 transition-colors"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <ProposalStatusBadge status={p.status} />
                              <span className="text-xs text-slate-500">
                                {TX_TIER[p.tier]} tier
                              </span>
                              {p.isEmergency && (
                                <span className="text-xs text-amber-400">
                                  emergency
                                </span>
                              )}
                            </div>
                            <p className="mt-2 text-sm text-white truncate">
                              {p.description || "(no description)"}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              to {truncateAddress(p.recipient)} ·{" "}
                              {SPENDING_CATEGORY[p.category]} · {timeAgo(p.createdAt)}
                            </p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="text-sm font-medium text-white">
                              {asset.known
                                ? formatAmount(
                                    toNumber(p.amount, asset.decimals),
                                    asset.symbol,
                                  )
                                : `${p.amount.toString()} units`}
                            </p>
                            <p className="mt-1 text-xs text-slate-400">
                              {p.approvalCount}/{p.requiredApprovals} approvals
                            </p>
                            <div className="mt-1 w-28">
                              <ProgressBar
                                value={p.approvalCount}
                                max={p.requiredApprovals}
                                color="bg-emerald-500"
                                height="h-1.5"
                              />
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </GlassCard>
          )}

          {/* ---------------------------------------------------------------- */}
          {activeTab === "budgets" && (
            <GlassCard className="p-5" hover={false}>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <SectionHeader
                  title="Budgets"
                  subtitle="Allocation and live rolling spend, in USD-equivalent units"
                />
                <button
                  onClick={() => setShowNewBudget(true)}
                  disabled={!isConnected}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-slate-700 text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" />
                  New budget
                </button>
              </div>

              {budgets.length === 0 ? (
                <EmptyState
                  icon={Banknote}
                  title="No active budgets"
                  body="Budgets cap spend per day, week and month for a category. Proposals can then be charged against them."
                />
              ) : (
                <div className="space-y-4">
                  {budgets.map((b) => {
                    const total = toNumber(b.totalAllocation, USD_DECIMALS);
                    const spent = toNumber(b.spent, USD_DECIMALS);
                    return (
                      <div
                        key={b.budgetId}
                        className="rounded-lg border border-slate-800 bg-slate-900/40 p-4"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-medium text-white">{b.name}</p>
                            <p className="text-xs text-slate-500">
                              {SPENDING_CATEGORY[b.category]} · period ends{" "}
                              {timeUntil(b.periodEnd)}
                            </p>
                          </div>
                          <p className="text-sm text-white">
                            {formatUSD(spent)}{" "}
                            <span className="text-slate-500">of {formatUSD(total)}</span>
                          </p>
                        </div>
                        <div className="mt-3">
                          <ProgressBar value={spent} max={total} />
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
                          {[
                            ["Daily", b.dailySpent, b.dailyLimit],
                            ["Weekly", b.weeklySpent, b.weeklyLimit],
                            ["Monthly", b.monthlySpent, b.monthlyLimit],
                          ].map(([label, used, limit]) => (
                            <div key={label as string}>
                              <div className="flex justify-between text-slate-400 mb-1">
                                <span>{label as string}</span>
                                <span className="text-slate-300">
                                  {formatUSD(toNumber(used as bigint, USD_DECIMALS))}/
                                  {formatUSD(toNumber(limit as bigint, USD_DECIMALS))}
                                </span>
                              </div>
                              <ProgressBar
                                value={toNumber(used as bigint, USD_DECIMALS)}
                                max={toNumber(limit as bigint, USD_DECIMALS)}
                                height="h-1"
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </GlassCard>
          )}

          {/* ---------------------------------------------------------------- */}
          {activeTab === "yield" && (
            <div className="space-y-6">
              <GlassCard className="p-5" hover={false}>
                <SectionHeader
                  title="Approved yield protocols"
                  subtitle="Venues an admin has whitelisted, with live allocation"
                />
                {protocols.length === 0 ? (
                  <EmptyState
                    icon={TrendingUp}
                    title="No yield protocols approved"
                    body="An account with YIELD_MANAGER_ROLE must approve a protocol before treasury funds can be allocated to it."
                  />
                ) : (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-slate-400 border-b border-slate-800">
                          <th className="text-left pb-2">Protocol</th>
                          <th className="text-left pb-2">Address</th>
                          <th className="text-right pb-2">Allocated</th>
                          <th className="text-right pb-2">Cap</th>
                          <th className="text-right pb-2">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {protocols.map((p) => (
                          <tr
                            key={p.protocolAddress}
                            className="border-b border-slate-800/60"
                          >
                            <td className="py-2 text-white">{p.name}</td>
                            <td className="py-2 text-xs font-mono text-slate-400">
                              {truncateAddress(p.protocolAddress)}
                            </td>
                            <td className="py-2 text-right text-white">
                              {formatUSD(toNumber(p.currentAllocation, USD_DECIMALS))}
                            </td>
                            <td className="py-2 text-right text-slate-300">
                              {formatUSD(toNumber(p.maxAllocation, USD_DECIMALS))}
                            </td>
                            <td className="py-2 text-right">
                              <span
                                className={`text-xs px-2 py-0.5 rounded-full ${
                                  p.active
                                    ? "bg-emerald-500/20 text-emerald-400"
                                    : "bg-slate-600/30 text-slate-400"
                                }`}
                              >
                                {p.active ? "Active" : "Inactive"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="mt-4 text-xs text-slate-500 flex items-start gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  The contract records allocation, not return. It exposes no APY
                  or accrued-yield figure, so none is shown.
                </p>
              </GlassCard>

              {yieldAllocation.length > 0 && (
                <GlassCard className="p-5" hover={false}>
                  <SectionHeader
                    title="Allocation by protocol"
                    subtitle="Current allocation only — not performance"
                  />
                  <div className="mt-4 h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={yieldAllocation}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                        <XAxis dataKey="name" stroke="#64748b" fontSize={11} />
                        <YAxis stroke="#64748b" fontSize={11} />
                        <RechartsTooltip content={<CustomTooltip />} />
                        <Bar dataKey="value" name="Allocated" fill={BRAND.red} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </GlassCard>
              )}
            </div>
          )}

          {/* ---------------------------------------------------------------- */}
          {activeTab === "activity" && (
            <GlassCard className="p-5" hover={false}>
              <SectionHeader
                title="Activity"
                subtitle="Treasury events in reverse chain order"
              />
              {activityLoading && activity.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">
                  Reading events from chain…
                </p>
              ) : activity.length === 0 ? (
                <EmptyState
                  icon={Activity}
                  title="No treasury activity"
                  body="Proposal, budget, yield and signer events appear here as they are emitted."
                />
              ) : (
                <div className="mt-4 space-y-2">
                  {activity.map((a, i) => (
                    <div
                      key={`${a.transactionHash}-${i}`}
                      className="flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2.5"
                    >
                      <ActivityIcon kind={a.kind} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-white">
                          {a.kind.replace(/([a-z])([A-Z])/g, "$1 $2")}
                        </p>
                        <p className="text-xs text-slate-500 font-mono truncate">
                          block {a.blockNumber.toString()} ·{" "}
                          {truncateAddress(a.transactionHash)}
                        </p>
                      </div>
                      <Hash className="w-3.5 h-3.5 text-slate-600 flex-shrink-0 mt-1" />
                    </div>
                  ))}
                </div>
              )}
            </GlassCard>
          )}
        </main>

        <Footer />
      </div>

      <NewProposalModal
        open={showNewProposal}
        onClose={() => setShowNewProposal(false)}
        tokens={summary.tokens}
        budgets={budgets}
        onSubmitted={refreshAll}
      />
      <NewBudgetModal
        open={showNewBudget}
        onClose={() => setShowNewBudget(false)}
        onSubmitted={refreshAll}
      />
      {selected && (
        <ProposalDetail
          proposal={selected}
          onClose={() => setSelected(null)}
          isSigner={isSigner}
          onChanged={refreshAll}
          resolve={resolve}
        />
      )}
    </>
  );
}
