/**
 * NoblePay FX Hedging — currency risk desk
 *
 * Every figure is read from the deployed FXHedgingVault. The page previously
 * generated its own rates, twelve hedges and a per-currency exposure breakdown
 * with seededRandom, and offered a "Swap" instrument the contract does not
 * implement.
 *
 * Two things the contract cannot answer, and which this page therefore does
 * not claim:
 *
 *  - Unhedged exposure. The vault knows what has been hedged; it has no idea
 *    what a business's underlying receivables are. The old page drew a "% of
 *    exposure hedged" bar against an invented denominator. This one reports
 *    hedged notional per pair and says where the rest of the number would have
 *    to come from.
 *  - Rate history beyond what the oracle published. The chart is built from
 *    FXRateUpdated events, so a pair updated once shows one point.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import { SEOHead } from "@/components/SEOHead";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";
import {
  TrendingUp,
  Shield,
  AlertCircle,
  Plus,
  RefreshCw,
  Clock,
  XCircle,
  Layers,
  Activity,
  Wallet,
  ArrowRightLeft,
} from "lucide-react";
import { useAccount } from "wagmi";
import { TopNav, Footer, Modal, Tabs } from "@/components/SharedComponents";
import { truncateAddress } from "@/lib/utils";
import { BRAND } from "@/lib/constants";
import { GlassCard, SectionHeader } from "@/components/PagePrimitives";
import {
  useFX,
  useFXActions,
  useRateHistory,
  HEDGE_TYPE,
  POSITION_STATUS,
  RATE_DECIMALS,
  type CurrencyPair,
  type HedgePosition,
} from "@/hooks/useFX";
import { CONTRACT_ADDRESSES } from "@/config/chains";

// =============================================================================
// FORMATTING
// =============================================================================

/** bigint -> number for display only; never for contract arguments. */
function toNumber(v: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  return Number(v / base) + Number(v % base) / Number(base);
}

function formatRate(rate: bigint): string {
  if (rate === 0n) return "—";
  return toNumber(rate, RATE_DECIMALS).toFixed(4);
}

function formatNotional(v: bigint): string {
  const n = toNumber(v, RATE_DECIMALS);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n === 0 ? "0" : n.toFixed(2);
}

function timeAgo(ts: number): string {
  if (!ts) return "never";
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function untilMaturity(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "matured";
  const days = Math.floor(diff / 86_400_000);
  if (days > 0) return `${days}d`;
  return `${Math.floor(diff / 3_600_000)}h`;
}

const STATUS_STYLES: Record<string, string> = {
  Active: "bg-emerald-500/20 text-emerald-400",
  Matured: "bg-blue-500/20 text-blue-400",
  Settled: "bg-blue-500/20 text-blue-400",
  Exercised: "bg-purple-500/20 text-purple-400",
  Expired: "bg-slate-500/20 text-slate-400",
  Liquidated: "bg-red-500/20 text-red-400",
  "Emergency unwound": "bg-red-500/20 text-red-400",
};

// =============================================================================
// SMALL COMPONENTS
// =============================================================================

function StatusBadge({ status }: { status: number }) {
  const name = POSITION_STATUS[status] ?? "Unknown";
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
        STATUS_STYLES[name] ?? "bg-slate-500/20 text-slate-400"
      }`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {name}
    </span>
  );
}

function TypeBadge({ hedgeType }: { hedgeType: number }) {
  const name = HEDGE_TYPE[hedgeType] ?? "Unknown";
  const style = hedgeType === 0 ? "bg-blue-500/20 text-blue-400" : "bg-purple-500/20 text-purple-400";
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${style}`}>{name}</span>;
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
      <p className="mt-1 text-xs text-slate-500 max-w-md">{body}</p>
    </div>
  );
}

// =============================================================================
// NEW HEDGE MODAL
// =============================================================================

function NewHedgeModal({
  open,
  onClose,
  pairs,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  pairs: CurrencyPair[];
  onSubmitted: () => void;
}) {
  const { createForward, createOption, pending } = useFXActions();
  const [pairId, setPairId] = useState<string>("");
  const [instrument, setInstrument] = useState(0); // index into HEDGE_TYPE
  const [notional, setNotional] = useState("");
  const [strike, setStrike] = useState("");
  const [premium, setPremium] = useState("");
  const [maturityDays, setMaturityDays] = useState("90");
  const [collateral, setCollateral] = useState("");
  const [error, setError] = useState<string | null>(null);

  const collateralToken = CONTRACT_ADDRESSES.usdcToken as `0x${string}`;
  const selected = pairs.find((p) => p.pairId === pairId) ?? pairs[0];

  useEffect(() => {
    if (!pairId && pairs.length) setPairId(pairs[0].pairId);
  }, [pairs, pairId]);

  const toFixedPoint = (v: string) => {
    const [whole, frac = ""] = v.trim().split(".");
    const padded = (frac + "0".repeat(RATE_DECIMALS)).slice(0, RATE_DECIMALS);
    return BigInt(whole || "0") * 10n ** BigInt(RATE_DECIMALS) + BigInt(padded || "0");
  };

  const submit = async () => {
    setError(null);
    if (!pairId) {
      setError("Select a currency pair.");
      return;
    }
    if (!collateralToken) {
      setError("No collateral token is configured for this deployment.");
      return;
    }
    let notionalUnits: bigint;
    let collateralUnits: bigint;
    try {
      notionalUnits = toFixedPoint(notional);
      collateralUnits = toFixedPoint(collateral);
    } catch {
      setError("Notional and collateral must be decimal numbers.");
      return;
    }
    if (notionalUnits <= 0n) {
      setError("Notional must be greater than zero.");
      return;
    }
    if (collateralUnits <= 0n) {
      setError("Collateral must be greater than zero — positions are margined.");
      return;
    }
    const days = Number(maturityDays);
    if (!Number.isFinite(days) || days <= 0) {
      setError("Maturity must be a positive number of days.");
      return;
    }
    const maturityDate = BigInt(Math.floor(Date.now() / 1000) + Math.floor(days * 86_400));

    try {
      if (instrument === 0) {
        await createForward({
          pairId: pairId as `0x${string}`,
          notionalAmount: notionalUnits,
          maturityDate,
          collateralToken,
          collateralAmount: collateralUnits,
        });
      } else {
        const strikeUnits = toFixedPoint(strike);
        if (strikeUnits <= 0n) {
          setError("An option needs a strike rate.");
          return;
        }
        await createOption({
          pairId: pairId as `0x${string}`,
          hedgeType: instrument,
          notionalAmount: notionalUnits,
          strikeRate: strikeUnits,
          premium: toFixedPoint(premium),
          maturityDate,
          collateralToken,
          collateralAmount: collateralUnits,
        });
      }
      onSubmitted();
      onClose();
    } catch (err) {
      setError((err as Error)?.message ?? "Transaction failed.");
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New hedge">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Currency pair</label>
            <select
              value={pairId}
              onChange={(e) => setPairId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
            >
              {pairs.map((p) => (
                <option key={p.pairId} value={p.pairId}>
                  {p.base}/{p.quote}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Instrument</label>
            <select
              value={instrument}
              onChange={(e) => setInstrument(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
            >
              {HEDGE_TYPE.map((t, i) => (
                <option key={t} value={i}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>

        {selected && (
          <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3 text-xs space-y-1">
            <div className="flex justify-between text-slate-300">
              <span>Oracle rate</span>
              <span className="text-white">
                {formatRate(selected.rate)}
                {selected.rate === 0n && (
                  <span className="ml-1 text-amber-400">not yet published</span>
                )}
              </span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Initial margin</span>
              <span>{(selected.marginRequirementBps / 100).toFixed(2)}%</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Maintenance margin</span>
              <span>{(selected.maintenanceMarginBps / 100).toFixed(2)}%</span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              Notional ({selected ? selected.base : "base"})
            </label>
            <input
              value={notional}
              onChange={(e) => setNotional(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Maturity (days)</label>
            <input
              value={maturityDays}
              onChange={(e) => setMaturityDays(e.target.value)}
              inputMode="numeric"
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
            />
          </div>
        </div>

        {instrument !== 0 && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Strike rate</label>
              <input
                value={strike}
                onChange={(e) => setStrike(e.target.value)}
                inputMode="decimal"
                placeholder={selected ? formatRate(selected.rate) : "0.0000"}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Premium</label>
              <input
                value={premium}
                onChange={(e) => setPremium(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
              />
            </div>
          </div>
        )}

        <div>
          <label className="block text-xs text-slate-400 mb-1">Collateral</label>
          <input
            value={collateral}
            onChange={(e) => setCollateral(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm"
          />
          <p className="mt-1 text-xs text-slate-500">
            Posted in {truncateAddress(collateralToken || "0x")} and transferred
            on submission. Falling below maintenance margin makes the position
            liquidatable.
          </p>
        </div>

        {instrument === 0 && (
          <p className="text-xs text-amber-400/90 flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            A forward is an obligation, not a right — it must settle at the
            locked rate whichever way the market moves.
          </p>
        )}

        {error && (
          <p className="text-xs text-red-400 flex items-start gap-1.5">
            <XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-300 hover:bg-slate-800">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={pending !== null}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
          >
            {pending ? "Submitting…" : "Open hedge"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// =============================================================================
// RATE CHART
// =============================================================================

function RateChart({ pair }: { pair: CurrencyPair | undefined }) {
  const { history, isLoading } = useRateHistory(pair?.pairId);

  const data = useMemo(
    () =>
      history.map((p) => ({
        label: new Date(p.timestamp).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
        rate: toNumber(p.rate, RATE_DECIMALS),
      })),
    [history],
  );

  if (!pair) return null;
  if (isLoading && data.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">Reading oracle history…</p>;
  }
  if (data.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No rate has been published"
        body="This chart plots FXRateUpdated events. Until the oracle submits a rate for this pair there is nothing to draw."
      />
    );
  }
  if (data.length === 1) {
    return (
      <div className="py-8 text-center">
        <p className="text-2xl font-bold text-white">{data[0].rate.toFixed(4)}</p>
        <p className="mt-1 text-xs text-slate-500">
          One published rate so far, at {data[0].label}. A line needs a second point.
        </p>
      </div>
    );
  }
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis dataKey="label" stroke="#64748b" fontSize={11} />
          <YAxis stroke="#64748b" fontSize={11} domain={["auto", "auto"]} />
          <RechartsTooltip
            contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, fontSize: 12 }}
          />
          <Line type="monotone" dataKey="rate" stroke={BRAND.red} dot={{ r: 2 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// =============================================================================
// POSITION ROW
// =============================================================================

function PositionRow({
  position,
  pair,
  onChanged,
}: {
  position: HedgePosition;
  pair: CurrencyPair | undefined;
  onChanged: () => void;
}) {
  const { settleForward, exerciseOption, expireOption, updateMarkToMarket, pending } =
    useFXActions();
  const [error, setError] = useState<string | null>(null);

  const statusName = POSITION_STATUS[position.status];
  const isForward = position.hedgeType === 0;
  const matured = Date.now() >= position.maturityDate;

  const run = async (fn: (id: `0x${string}`) => Promise<unknown>) => {
    setError(null);
    try {
      await fn(position.positionId);
      onChanged();
    } catch (err) {
      setError((err as Error)?.message ?? "Transaction failed.");
    }
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-white">
              {pair ? `${pair.base}/${pair.quote}` : truncateAddress(position.pairId)}
            </span>
            <TypeBadge hedgeType={position.hedgeType} />
            <StatusBadge status={position.status} />
            {position.underMargined && statusName === "Active" && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/20 text-red-400">
                under margin
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            notional {formatNotional(position.notionalAmount)} · locked{" "}
            {formatRate(position.lockedRate)} · collateral{" "}
            {formatNotional(position.collateralAmount)}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {matured ? "matured" : `matures in ${untilMaturity(position.maturityDate)}`}
            {position.lastMtMUpdate > 0 && ` · marked ${timeAgo(position.lastMtMUpdate)}`}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {statusName === "Active" && (
            <button
              onClick={() => run(updateMarkToMarket)}
              disabled={pending !== null}
              className="px-2.5 py-1.5 rounded-lg text-xs border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              {pending === "mtm" ? "Marking…" : "Mark to market"}
            </button>
          )}
          {isForward && statusName !== "Settled" && (
            <button
              onClick={() => run(settleForward)}
              disabled={pending !== null || !matured}
              title={matured ? undefined : "Forwards settle at maturity"}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {pending === "settle" ? "Settling…" : "Settle"}
            </button>
          )}
          {!isForward && statusName === "Active" && (
            <>
              <button
                onClick={() => run(exerciseOption)}
                disabled={pending !== null}
                className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50"
              >
                {pending === "exercise" ? "Exercising…" : "Exercise"}
              </button>
              <button
                onClick={() => run(expireOption)}
                disabled={pending !== null || !matured}
                title={matured ? undefined : "An option can only expire after maturity"}
                className="px-2.5 py-1.5 rounded-lg text-xs border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                {pending === "expire" ? "Expiring…" : "Let expire"}
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <p className="mt-2 text-xs text-red-400 flex items-start gap-1.5">
          <XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export default function FXHedgingPage() {
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState("positions");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedPairId, setSelectedPairId] = useState<string>("");

  useEffect(() => setMounted(true), []);

  const { isConnected } = useAccount();
  const { pairs, pairsById, positions, portfolio, atRisk, isLoading, error, refetch } =
    useFX();

  useEffect(() => {
    if (!selectedPairId && pairs.length) setSelectedPairId(pairs[0].pairId);
  }, [pairs, selectedPairId]);

  const selectedPair = pairs.find((p) => p.pairId === selectedPairId);
  const pairFor = useCallback(
    (id: string) => pairsById.get(id.toLowerCase()),
    [pairsById],
  );

  /**
   * Hedged notional per pair. This is deliberately not a hedge ratio: the
   * contract knows what has been hedged and nothing about the exposure being
   * hedged against, so a percentage would need a denominator no one on chain
   * has.
   */
  const hedgedByPair = useMemo(() => {
    const totals = new Map<string, bigint>();
    for (const p of positions) {
      if (POSITION_STATUS[p.status] !== "Active") continue;
      const key = p.pairId.toLowerCase();
      totals.set(key, (totals.get(key) ?? 0n) + p.notionalAmount);
    }
    return [...totals.entries()]
      .map(([pairId, notional]) => ({ pair: pairsById.get(pairId), notional }))
      .filter((e) => e.pair)
      .sort((a, b) => (b.notional > a.notional ? 1 : -1));
  }, [positions, pairsById]);

  const openPositions = positions.filter(
    (p) => POSITION_STATUS[p.status] === "Active",
  );

  const tabs = [
    { id: "positions", label: `Positions (${positions.length})` },
    { id: "rates", label: `Rates (${pairs.length})` },
    { id: "exposure", label: "Hedged notional" },
  ];

  if (!mounted) return null;

  return (
    <>
      <SEOHead
        title="FX Hedging — NoblePay"
        description="Hedge currency exposure with collateralised forwards and options settled on Aethelred."
      />
      <div className="min-h-screen bg-slate-950">
        <TopNav />

        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
            <div>
              <div className="flex items-center gap-2">
                <ArrowRightLeft className="w-6 h-6 text-red-500" />
                <h1 className="text-2xl font-bold text-white">FX Hedging</h1>
              </div>
              <p className="mt-1 text-sm text-slate-400">
                Collateralised forwards and options on Aethelred, marked against
                published oracle rates.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={refetch}
                className="p-2 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800"
                aria-label="Refresh FX data"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
              </button>
              <button
                onClick={() => setShowCreate(true)}
                disabled={!isConnected || pairs.length === 0}
                title={
                  !isConnected
                    ? "Connect a wallet to hedge"
                    : pairs.length === 0
                      ? "No currency pairs are configured on this vault"
                      : undefined
                }
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
                New hedge
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-4 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm text-red-300">Could not read the FX vault.</p>
                <p className="text-xs text-red-400/80 mt-0.5">{error.message}</p>
              </div>
            </div>
          )}

          {atRisk.length > 0 && (
            <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-amber-300">
                {atRisk.length} position{atRisk.length === 1 ? " is" : "s are"} below
                maintenance margin and can be liquidated. Add margin to restore cover.
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <StatCard
              icon={Layers}
              label="Total notional"
              value={portfolio ? formatNotional(portfolio.totalNotional) : "—"}
              sub={`${openPositions.length} open position(s)`}
            />
            <StatCard
              icon={Wallet}
              label="Collateral posted"
              value={portfolio ? formatNotional(portfolio.totalCollateral) : "—"}
              sub={
                portfolio && portfolio.totalPremiumPaid > 0n
                  ? `${formatNotional(portfolio.totalPremiumPaid)} premium paid`
                  : "no premium paid"
              }
            />
            <StatCard
              icon={TrendingUp}
              label="Realised P&L"
              value={portfolio ? formatNotional(portfolio.totalPnL) : "—"}
              sub={
                portfolio
                  ? `${formatNotional(portfolio.unrealizedPnL)} unrealised`
                  : undefined
              }
            />
            <StatCard
              icon={Shield}
              label="Below maintenance"
              value={String(atRisk.length)}
              sub={atRisk.length ? "liquidatable" : "all positions covered"}
            />
          </div>

          <div className="mb-6">
            <Tabs tabs={tabs} active={activeTab} onChange={setActiveTab} />
          </div>

          {activeTab === "positions" && (
            <GlassCard className="p-5" hover={false}>
              <SectionHeader
                title="Your positions"
                subtitle="Read from getBusinessPositions for the connected account"
              />
              {!isConnected ? (
                <EmptyState
                  icon={Wallet}
                  title="No wallet connected"
                  body="Positions are looked up per hedger address. Connect a wallet to see yours."
                />
              ) : isLoading && positions.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-500">
                  Reading positions from chain…
                </p>
              ) : positions.length === 0 ? (
                <EmptyState
                  icon={Layers}
                  title="No hedges yet"
                  body="Open a forward to lock a rate, or an option to buy the right to one. Both require collateral."
                />
              ) : (
                <div className="mt-4 space-y-3">
                  {positions.map((p) => (
                    <PositionRow
                      key={p.positionId}
                      position={p}
                      pair={pairFor(p.pairId)}
                      onChanged={refetch}
                    />
                  ))}
                </div>
              )}
            </GlassCard>
          )}

          {activeTab === "rates" && (
            <div className="space-y-6">
              <GlassCard className="p-5" hover={false}>
                <SectionHeader
                  title="Currency pairs"
                  subtitle="Configured on the vault, with the latest oracle rate"
                />
                {pairs.length === 0 ? (
                  <EmptyState
                    icon={ArrowRightLeft}
                    title="No currency pairs configured"
                    body="An account with ADMIN_ROLE must add a pair before any hedge can be opened against it."
                  />
                ) : (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-slate-400 border-b border-slate-800">
                          <th className="text-left pb-2">Pair</th>
                          <th className="text-right pb-2">Rate</th>
                          <th className="text-right pb-2">Updated</th>
                          <th className="text-right pb-2">Initial margin</th>
                          <th className="text-right pb-2">Maintenance</th>
                          <th className="text-right pb-2">Max hedge</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pairs.map((p) => (
                          <tr
                            key={p.pairId}
                            onClick={() => setSelectedPairId(p.pairId)}
                            className={`border-b border-slate-800/60 cursor-pointer hover:bg-slate-800/40 ${
                              p.pairId === selectedPairId ? "bg-slate-800/30" : ""
                            }`}
                          >
                            <td className="py-2 text-white">
                              {p.base}/{p.quote}
                            </td>
                            <td className="py-2 text-right text-white">
                              {formatRate(p.rate)}
                            </td>
                            <td className="py-2 text-right text-slate-400 text-xs">
                              {p.rate === 0n ? (
                                <span className="text-amber-400">never</span>
                              ) : (
                                timeAgo(p.rateUpdatedAt)
                              )}
                            </td>
                            <td className="py-2 text-right text-slate-300">
                              {(p.marginRequirementBps / 100).toFixed(2)}%
                            </td>
                            <td className="py-2 text-right text-slate-300">
                              {(p.maintenanceMarginBps / 100).toFixed(2)}%
                            </td>
                            <td className="py-2 text-right text-slate-300">
                              {(p.maxHedgeRatioBps / 100).toFixed(0)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </GlassCard>

              {pairs.length > 0 && (
                <GlassCard className="p-5" hover={false}>
                  <SectionHeader
                    title={
                      selectedPair
                        ? `${selectedPair.base}/${selectedPair.quote} oracle history`
                        : "Oracle history"
                    }
                    subtitle="Every rate the oracle has published for this pair"
                  />
                  <div className="mt-4">
                    <RateChart pair={selectedPair} />
                  </div>
                </GlassCard>
              )}
            </div>
          )}

          {activeTab === "exposure" && (
            <GlassCard className="p-5" hover={false}>
              <SectionHeader
                title="Hedged notional by pair"
                subtitle="Open positions only"
              />
              <p className="mt-2 text-xs text-amber-400/90 flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                This is hedged notional, not a hedge ratio. The vault records
                what you have hedged; it has no view of the underlying
                receivables you are hedging against, so the share of exposure
                covered cannot be computed from chain state alone.
              </p>
              {hedgedByPair.length === 0 ? (
                <EmptyState
                  icon={Layers}
                  title="Nothing hedged"
                  body="Open a position and its notional will be totalled here by currency pair."
                />
              ) : (
                <div className="mt-4 space-y-4">
                  {hedgedByPair.map(({ pair, notional }) => (
                    <div key={pair!.pairId}>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="text-white font-medium">
                          {pair!.base}/{pair!.quote}
                        </span>
                        <span className="text-slate-300">{formatNotional(notional)}</span>
                      </div>
                      <div className="w-full h-2.5 rounded-full bg-slate-700/50 overflow-hidden">
                        <div
                          className="h-2.5 rounded-full"
                          style={{
                            width: `${
                              (Number(notional) /
                                Number(hedgedByPair[0].notional || 1n)) *
                              100
                            }%`,
                            backgroundColor: BRAND.red,
                          }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        rate {formatRate(pair!.rate)} · maintenance{" "}
                        {(pair!.maintenanceMarginBps / 100).toFixed(2)}%
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </GlassCard>
          )}
        </main>

        <Footer />
      </div>

      <NewHedgeModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        pairs={pairs}
        onSubmitted={refetch}
      />
    </>
  );
}
