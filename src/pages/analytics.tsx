import { useAuditStats } from "@/hooks/useAudit";
import { useComplianceMetrics } from "@/hooks/useCompliance";
import { usePaymentStats } from "@/hooks/usePayment";
import {
  ErrorState,
  LoadingState,
  MetricCard,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

function AnalyticsContent() {
  const payments = usePaymentStats();
  const compliance = useComplianceMetrics();
  const audit = useAuditStats();
  const queries = [payments, compliance, audit];

  if (queries.some((query) => query.isLoading))
    return <LoadingState label="Calculating live tenant metrics" />;
  const failed = queries.find((query) => query.error);
  if (failed?.error)
    return (
      <ErrorState
        error={failed.error}
        retry={() => void Promise.all(queries.map((query) => query.refetch()))}
      />
    );

  const currencyRows = Object.entries(payments.data?.byCurrency ?? {}).sort(
    (a, b) => Number(b[1].volume) - Number(a[1].volume),
  );
  const statusRows = Object.entries(payments.data?.byStatus ?? {}).sort(
    (a, b) => b[1] - a[1],
  );
  const eventRows = Object.entries(audit.data?.byEventType ?? {}).sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Lifetime volume"
          value={payments.data?.totalVolume ?? "0"}
          detail={`${payments.data?.totalPayments ?? 0} payments`}
        />
        <MetricCard
          label="Average payment"
          value={payments.data?.averageAmount ?? "0"}
        />
        <MetricCard
          label="7-day volume"
          value={payments.data?.last7d.volume ?? "0"}
          detail={`${payments.data?.last7d.count ?? 0} payments`}
        />
        <MetricCard
          label="Screening pass rate"
          value={`${((compliance.data?.passRate ?? 0) * 100).toFixed(1)}%`}
          tone={
            (compliance.data?.failedScreenings ?? 0) ? "warning" : "success"
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Volume by asset"
          description="Aggregated from tenant-scoped payment records."
        >
          {currencyRows.length ? (
            <div className="space-y-3">
              {currencyRows.map(([asset, values]) => (
                <div
                  key={asset}
                  className="flex items-center justify-between gap-4 rounded-lg border border-slate-800 px-4 py-3"
                >
                  <div>
                    <p className="font-medium text-white">{asset}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {values.count} payments
                    </p>
                  </div>
                  <p className="font-semibold tabular-nums text-slate-200">
                    {values.volume}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">No verified volume yet.</p>
          )}
        </Panel>

        <Panel
          title="Payment lifecycle"
          description="Current record counts by reconciled status."
        >
          {statusRows.length ? (
            <div className="space-y-3">
              {statusRows.map(([status, count]) => (
                <div
                  key={status}
                  className="flex items-center justify-between border-b border-slate-800 pb-3 last:border-0 last:pb-0"
                >
                  <span className="text-sm text-slate-400">{status}</span>
                  <span className="font-semibold tabular-nums text-white">
                    {count}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              No payment status history yet.
            </p>
          )}
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.5fr]">
        <Panel
          title="Compliance efficiency"
          description="Real screening records; no projected values."
        >
          <dl className="space-y-4 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Average duration</dt>
              <dd className="font-medium tabular-nums text-white">
                {(compliance.data?.averageScreeningDuration ?? 0).toFixed(0)} ms
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Average risk score</dt>
              <dd className="font-medium tabular-nums text-white">
                {(compliance.data?.averageRiskScore ?? 0).toFixed(1)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Under review</dt>
              <dd className="font-medium tabular-nums text-white">
                {compliance.data?.underReviewCount ?? 0}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Failed</dt>
              <dd className="font-medium tabular-nums text-white">
                {compliance.data?.failedScreenings ?? 0}
              </dd>
            </div>
          </dl>
        </Panel>

        <Panel
          title="Audit activity"
          description={`${audit.data?.totalEntries ?? 0} chained events · ${audit.data?.chainIntact ? "stored chain intact" : "verification required"}`}
        >
          {eventRows.length ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {eventRows.slice(0, 10).map(([event, count]) => (
                <div
                  key={event}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 px-3 py-2"
                >
                  <span
                    className="truncate text-xs text-slate-500"
                    title={event}
                  >
                    {event}
                  </span>
                  <span className="text-sm font-semibold text-white">
                    {count}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">No audit events yet.</p>
          )}
        </Panel>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <PageShell
      title="Analytics"
      description="Tenant-scoped payment, screening, and audit aggregates calculated from persisted records."
      path="/analytics"
    >
      <SessionGate>
        <AnalyticsContent />
      </SessionGate>
    </PageShell>
  );
}
