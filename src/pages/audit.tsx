import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Download,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {
  useAuditEntries,
  useAuditStats,
  useExportAudit,
  useVerifyAuditChain,
} from "@/hooks/useAudit";
import { Badge } from "@/components/SharedComponents";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

const severityVariant: Record<
  string,
  "neutral" | "info" | "warning" | "error"
> = {
  INFO: "info",
  LOW: "neutral",
  MEDIUM: "warning",
  HIGH: "error",
  CRITICAL: "error",
};

function AuditContent() {
  const [page, setPage] = useState(1);
  const [severity, setSeverity] = useState("");
  const [eventType, setEventType] = useState("");
  const entries = useAuditEntries({ page, limit: 20, severity, eventType });
  const stats = useAuditStats();
  const verify = useVerifyAuditChain();
  const exporter = useExportAudit();
  const exportRange = useMemo(() => {
    const to = new Date();
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - 30);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  if (entries.isLoading || stats.isLoading)
    return <LoadingState label="Loading tenant audit chain" />;
  if (entries.error)
    return (
      <ErrorState error={entries.error} retry={() => void entries.refetch()} />
    );
  if (stats.error)
    return (
      <ErrorState error={stats.error} retry={() => void stats.refetch()} />
    );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Audit entries"
          value={stats.data?.totalEntries ?? 0}
        />
        <MetricCard
          label="Last 24 hours"
          value={stats.data?.last24hCount ?? 0}
        />
        <MetricCard label="Last 7 days" value={stats.data?.last7dCount ?? 0} />
        <MetricCard
          label="Stored chain state"
          value={
            stats.data?.chainIntact === true
              ? "Intact"
              : stats.data?.chainIntact === false
                ? "Attention"
                : "Not checked"
          }
          tone={
            stats.data?.chainIntact === true
              ? "success"
              : stats.data?.chainIntact === false
                ? "danger"
                : "warning"
          }
        />
      </div>

      <Panel
        title="Integrity verification"
        description="Recomputes each canonical entry hash and previous-hash link for this tenant."
        action={
          <button
            type="button"
            disabled={verify.isPending}
            onClick={() => verify.mutate()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 hover:border-amber-400 disabled:opacity-60"
          >
            <RefreshCw
              className={`h-4 w-4 ${verify.isPending ? "animate-spin" : ""}`}
            />{" "}
            Verify now
          </button>
        }
      >
        {verify.data ? (
          <div
            className={`flex items-start gap-3 rounded-xl border p-4 ${verify.data.intact ? "border-emerald-500/25 bg-emerald-500/10" : "border-red-500/25 bg-red-500/10"}`}
          >
            {verify.data.intact ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400" />
            ) : (
              <ShieldAlert className="mt-0.5 h-5 w-5 text-red-400" />
            )}
            <div>
              <p className="font-medium text-white">
                {verify.data.intact
                  ? "Audit chain verified"
                  : "Audit chain verification failed"}
              </p>
              <p className="mt-1 text-sm text-slate-400">
                {verify.data.message}
              </p>
            </div>
          </div>
        ) : verify.error ? (
          <ErrorState error={verify.error} />
        ) : (
          <p className="text-sm text-slate-500">
            Run verification to produce current integrity evidence. Stored
            aggregate status alone is not treated as fresh proof.
          </p>
        )}
      </Panel>

      <Panel
        title="Immutable event ledger"
        description="Tenant-scoped events in canonical chain order."
        action={
          <button
            type="button"
            disabled={exporter.isPending}
            onClick={() => exporter.mutate(exportRange)}
            className="inline-flex items-center gap-2 text-xs font-semibold text-slate-300 hover:text-white disabled:opacity-60"
          >
            <Download className="h-4 w-4" />{" "}
            {exporter.isPending ? "Exporting…" : "Export 30 days"}
          </button>
        }
      >
        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          <label>
            <span className="sr-only">Filter event type</span>
            <input
              value={eventType}
              onChange={(event) => {
                setEventType(event.target.value.toUpperCase());
                setPage(1);
              }}
              placeholder="Event type, e.g. PAYMENT_CREATED"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-600"
            />
          </label>
          <label>
            <span className="sr-only">Filter severity</span>
            <select
              value={severity}
              onChange={(event) => {
                setSeverity(event.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
            >
              <option value="">All severities</option>
              <option>INFO</option>
              <option>LOW</option>
              <option>MEDIUM</option>
              <option>HIGH</option>
              <option>CRITICAL</option>
            </select>
          </label>
        </div>

        {!entries.data?.entries.length ? (
          <EmptyState
            title="No matching audit events"
            body="No sample entries are generated. Events appear only after real tenant actions."
          />
        ) : (
          <div className="space-y-3">
            {entries.data.entries.map((entry) => (
              <article
                key={entry.id}
                className="rounded-xl border border-slate-800 bg-slate-950/50 p-4"
              >
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={severityVariant[entry.severity] ?? "neutral"}
                      >
                        {entry.severity}
                      </Badge>
                      <span className="text-xs font-medium text-slate-300">
                        {entry.eventType}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-300">
                      {entry.description}
                    </p>
                  </div>
                  <time className="shrink-0 text-xs text-slate-500">
                    {new Date(entry.createdAt).toLocaleString()}
                  </time>
                </div>
                <dl className="mt-3 grid gap-2 border-t border-slate-800 pt-3 text-xs sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-slate-600">Entry hash</dt>
                    <dd
                      className="truncate font-mono text-slate-500"
                      title={entry.entryHash}
                    >
                      {entry.entryHash}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-slate-600">Actor</dt>
                    <dd
                      className="truncate font-mono text-slate-500"
                      title={entry.actor}
                    >
                      {entry.actor}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}

        {(entries.data?.totalPages ?? 1) > 1 && (
          <div className="mt-5 flex items-center justify-between border-t border-slate-800 pt-4 text-xs text-slate-500">
            <span>
              Page {entries.data?.page} of {entries.data?.totalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
                className="rounded-lg border border-slate-700 p-2 disabled:opacity-30"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={page >= (entries.data?.totalPages ?? 1)}
                onClick={() => setPage((value) => value + 1)}
                className="rounded-lg border border-slate-700 p-2 disabled:opacity-30"
              >
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
        {exporter.error && (
          <p role="alert" className="mt-4 text-sm text-red-300">
            {exporter.error.message}
          </p>
        )}
      </Panel>
    </div>
  );
}

export default function AuditPage() {
  return (
    <PageShell
      title="Audit evidence"
      description="Verify and export the tenant’s tamper-evident operational event chain."
      path="/audit"
    >
      <SessionGate>
        <AuditContent />
      </SessionGate>
    </PageShell>
  );
}
