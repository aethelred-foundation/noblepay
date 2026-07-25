import { FormEvent, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {
  useComplianceMetrics,
  useComplianceStatus,
  useFlaggedPayments,
  useReviewFlaggedPayment,
  useSanctionsListStatus,
  type FlaggedPayment,
} from "@/hooks/useCompliance";
import { Badge, Modal } from "@/components/SharedComponents";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

function ComplianceContent() {
  const status = useComplianceStatus();
  const metrics = useComplianceMetrics();
  const sanctions = useSanctionsListStatus();
  const flagged = useFlaggedPayments();
  const review = useReviewFlaggedPayment();
  const [selected, setSelected] = useState<FlaggedPayment | null>(null);
  const [reason, setReason] = useState("");
  const queries = [status, metrics, sanctions, flagged];

  if (queries.some((query) => query.isLoading))
    return <LoadingState label="Loading compliance evidence" />;
  const failed = queries.find((query) => query.error);
  if (failed?.error)
    return (
      <ErrorState
        error={failed.error}
        retry={() => void Promise.all(queries.map((query) => query.refetch()))}
      />
    );

  const submitReview = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    try {
      await review.mutateAsync({
        paymentId: selected.id,
        decision: "escalate",
        reason,
      });
      setSelected(null);
      setReason("");
    } catch {
      // The mutation error is rendered below without closing the review.
    }
  };

  const serviceHealthy = status.data?.engineStatus === "healthy";
  const datasetFresh = sanctions.data?.status === "fresh";

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Screenings"
          value={metrics.data?.totalScreenings ?? 0}
          detail={`${metrics.data?.passedScreenings ?? 0} passed · ${metrics.data?.failedScreenings ?? 0} failed`}
        />
        <MetricCard
          label="Pass rate"
          value={`${((metrics.data?.passRate ?? 0) * 100).toFixed(1)}%`}
          tone={
            (metrics.data?.failedScreenings ?? 0) > 0 ? "warning" : "success"
          }
        />
        <MetricCard
          label="Average risk"
          value={(metrics.data?.averageRiskScore ?? 0).toFixed(1)}
          detail="0–100 risk score"
        />
        <MetricCard
          label="Review queue"
          value={flagged.data?.total ?? 0}
          tone={(flagged.data?.total ?? 0) ? "danger" : "success"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="External compliance service"
          description="Health and sanctions freshness are checked live. Every settlement still requires separately reconciled on-chain verifier evidence."
        >
          <div
            className={`rounded-xl border p-4 ${serviceHealthy ? "border-emerald-500/25 bg-emerald-500/10" : "border-red-500/25 bg-red-500/10"}`}
          >
            <div className="flex items-center gap-3">
              {serviceHealthy ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              ) : (
                <ShieldAlert className="h-5 w-5 text-red-400" />
              )}
              <div>
                <p className="font-medium text-white">
                  {serviceHealthy
                    ? "Live health check passed"
                    : "Settlement is fail-closed"}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {status.data?.checkedAt
                    ? `Checked ${new Date(status.data.checkedAt).toLocaleString()}`
                    : "No verified health response"}
                </p>
              </div>
            </div>
          </div>
          <p className="mt-4 text-sm leading-6 text-slate-500">
            Operator identity, contract role, canonical receipt, and the exact
            attestation bytes submitted on-chain are reconciled for each
            screening. Hardware-attestation validity remains part of the
            audited external service contract; this health check does not
            claim node count or capacity.
          </p>
        </Panel>

        <Panel
          title="Sanctions data"
          description="Freshness is reported by the configured compliance engine; NoblePay does not invent list counts."
        >
          <div className="flex items-start gap-3">
            {datasetFresh ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400" />
            ) : (
              <Clock3 className="mt-0.5 h-5 w-5 text-amber-400" />
            )}
            <div>
              <p className="font-medium text-white">
                {sanctions.data?.status?.toUpperCase() ?? "UNAVAILABLE"}
              </p>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Last updated{" "}
                {sanctions.data?.lastUpdated
                  ? new Date(sanctions.data.lastUpdated).toLocaleString()
                  : "not reported"}
              </p>
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
            <div className="rounded-lg border border-slate-800 p-3">
              <dt className="text-xs text-slate-500">Entries</dt>
              <dd className="mt-1 font-semibold tabular-nums text-white">
                {sanctions.data?.totalEntries ?? 0}
              </dd>
            </div>
            <div className="rounded-lg border border-slate-800 p-3">
              <dt className="text-xs text-slate-500">Lists</dt>
              <dd className="mt-1 font-semibold tabular-nums text-white">
                {sanctions.data?.listsLoaded.length ?? 0}
              </dd>
            </div>
          </dl>
          {sanctions.data?.listsLoaded.length ? (
            <p className="mt-4 text-xs leading-5 text-slate-500">
              {sanctions.data.listsLoaded.join(" · ")}
            </p>
          ) : null}
        </Panel>
      </div>

      <Panel
        title="Flagged payment review"
        description="Escalations are attributed to the authenticated wallet. Approval or rejection stays unavailable until a governed on-chain decision flow is deployed."
        action={
          <button
            type="button"
            onClick={() => void flagged.refetch()}
            className="inline-flex items-center gap-2 text-xs font-semibold text-slate-300 hover:text-white"
          >
            <RefreshCw
              className={`h-4 w-4 ${flagged.isFetching ? "animate-spin" : ""}`}
            />{" "}
            Refresh
          </button>
        }
      >
        {!flagged.data?.payments.length ? (
          <EmptyState
            title="No payments awaiting review"
            body="This queue contains only tenant-scoped records flagged by the real compliance service."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="pb-3 font-medium">Payment</th>
                  <th className="pb-3 font-medium">Sender</th>
                  <th className="pb-3 text-right font-medium">Amount</th>
                  <th className="pb-3 font-medium">Risk</th>
                  <th className="pb-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {flagged.data.payments.map((payment) => (
                  <tr
                    key={payment.id}
                    className="border-b border-slate-800/70 last:border-0"
                  >
                    <td className="py-4 font-mono text-xs text-slate-300">
                      {payment.paymentId.slice(0, 12)}…
                    </td>
                    <td className="py-4 font-mono text-xs text-slate-500">
                      {payment.sender.slice(0, 10)}…{payment.sender.slice(-6)}
                    </td>
                    <td className="py-4 text-right font-medium tabular-nums text-white">
                      {payment.amount}{" "}
                      <span className="text-xs text-slate-500">
                        {payment.currency}
                      </span>
                    </td>
                    <td className="py-4">
                      <Badge
                        variant={
                          (payment.riskScore ?? 0) >= 70 ? "error" : "warning"
                        }
                      >
                        {payment.riskScore ?? "N/A"}
                      </Badge>
                    </td>
                    <td className="py-4 text-right">
                      <button
                        type="button"
                        onClick={() => setSelected(payment)}
                        className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-amber-400 hover:text-amber-300"
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Modal
        open={Boolean(selected)}
        onClose={() => !review.isPending && setSelected(null)}
        title="Review flagged payment"
      >
        <form onSubmit={submitReview} className="space-y-4">
          <p className="break-all font-mono text-xs text-slate-500">
            {selected?.paymentId}
          </p>
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-sm leading-6 text-amber-100/80">
            This records an escalation for governed resolution; it does not
            change the on-chain payment disposition.
          </div>
          <label className="block text-sm text-slate-300">
            Reason
            <textarea
              required
              minLength={3}
              maxLength={1000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="mt-1 min-h-28 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            />
          </label>
          {review.error && (
            <p role="alert" className="text-sm text-red-300">
              {review.error.message}
            </p>
          )}
          <button
            type="submit"
            disabled={review.isPending}
            className="w-full rounded-lg bg-amber-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-60"
          >
            {review.isPending
              ? "Recording escalation…"
              : "Escalate for governed resolution"}
          </button>
        </form>
      </Modal>
    </div>
  );
}

export default function CompliancePage() {
  return (
    <PageShell
      title="Compliance control room"
      description="Verifier status, sanctions freshness, reconciled screening metrics, and tenant-scoped escalations."
      path="/compliance"
    >
      <SessionGate>
        <ComplianceContent />
      </SessionGate>
    </PageShell>
  );
}
