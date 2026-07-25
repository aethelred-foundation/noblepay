import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  ShieldAlert,
} from "lucide-react";
import { activeChain } from "@/config/wagmi";
import {
  useBusinessPaymentLimits,
  useBusinessProfile,
} from "@/hooks/useBusiness";
import {
  useComplianceMetrics,
  useComplianceStatus,
} from "@/hooks/useCompliance";
import { usePayments, usePaymentStats } from "@/hooks/usePayment";
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

function percentage(value: number | undefined) {
  return `${((value ?? 0) * 100).toFixed(1)}%`;
}

function DashboardContent() {
  const profile = useBusinessProfile();
  const limits = useBusinessPaymentLimits();
  const stats = usePaymentStats();
  const recent = usePayments({ page: 1, pageSize: 5 });
  const compliance = useComplianceMetrics();
  const engine = useComplianceStatus();
  const queries = [profile, limits, stats, recent, compliance, engine];

  if (queries.some((query) => query.isLoading))
    return <LoadingState label="Loading live operating position" />;
  const failed = queries.find((query) => query.error);
  if (failed?.error) {
    return (
      <ErrorState
        error={failed.error}
        retry={() => void Promise.all(queries.map((query) => query.refetch()))}
      />
    );
  }

  const business = profile.data;
  const complianceServiceHealthy = engine.data?.engineStatus === "healthy";
  const sanctionsFresh = engine.data?.sanctions.status === "fresh";

  return (
    <div className="space-y-6">
      <section className="grid gap-5 rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 p-6 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold text-white">
              {business?.businessName}
            </h2>
            <Badge
              variant={
                business?.kycStatus === "VERIFIED" ? "success" : "warning"
              }
            >
              {business?.kycStatus ?? "UNKNOWN"}
            </Badge>
            <Badge variant="neutral">{business?.tier ?? "NO TIER"}</Badge>
          </div>
          <p className="mt-2 text-sm text-slate-400">
            {business?.jurisdiction} · License {business?.licenseNumber}
          </p>
        </div>
        <Link
          href="/businesses"
          className="inline-flex items-center gap-2 text-sm font-semibold text-amber-300 hover:text-amber-200"
        >
          Business profile <ArrowRight className="h-4 w-4" />
        </Link>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="24-hour volume"
          value={stats.data?.last24h.volume ?? "0"}
          detail={`${stats.data?.last24h.count ?? 0} verified payments`}
        />
        <MetricCard
          label="Payments"
          value={stats.data?.totalPayments ?? 0}
          detail={`${stats.data?.totalVolume ?? "0"} lifetime volume`}
        />
        <MetricCard
          label="Compliance pass rate"
          value={percentage(compliance.data?.passRate)}
          tone={
            (compliance.data?.failedScreenings ?? 0) > 0 ? "warning" : "success"
          }
          detail={`${compliance.data?.totalScreenings ?? 0} screenings`}
        />
        <MetricCard
          label="Open flags"
          value={compliance.data?.flaggedCount ?? 0}
          tone={(compliance.data?.flaggedCount ?? 0) > 0 ? "danger" : "success"}
          detail={`${compliance.data?.underReviewCount ?? 0} under review`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Panel
          title="Recent payments"
          description="Most recent records verified by the NoblePay API."
        >
          {!recent.data?.payments.length ? (
            <EmptyState
              title="No payment history"
              body="The ledger will remain empty until a wallet transaction has been verified."
              href="/payments"
              action="Initiate a payment"
            />
          ) : (
            <div className="divide-y divide-slate-800">
              {recent.data.payments.map((payment) => (
                <div
                  key={payment.id}
                  className="grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-5"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-slate-300">
                      {payment.paymentId}
                    </p>
                    <p className="mt-1 truncate text-xs text-slate-500">
                      to {payment.recipient}
                    </p>
                  </div>
                  <p className="text-sm font-semibold tabular-nums text-white">
                    {payment.amount}{" "}
                    <span className="text-xs text-slate-500">
                      {payment.currency}
                    </span>
                  </p>
                  <div className="flex items-center justify-between gap-3 sm:justify-end">
                    <Badge
                      variant={
                        payment.status === "SETTLED" ||
                        payment.status === "APPROVED"
                          ? "success"
                          : payment.status === "REJECTED"
                            ? "error"
                            : "warning"
                      }
                    >
                      {payment.status}
                    </Badge>
                    {payment.txHash && (
                      <a
                        href={`${activeChain.blockExplorers?.default.url}/tx/${payment.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="Open transaction in explorer"
                        className="text-slate-500 hover:text-amber-300"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <div className="space-y-6">
          <Panel
            title="Settlement controls"
            description="Production dependencies are shown as evidence, not optimistic status."
          >
            <ul className="space-y-4 text-sm">
              <li className="flex items-start gap-3">
                {complianceServiceHealthy ? (
                  <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400" />
                ) : (
                  <ShieldAlert className="mt-0.5 h-5 w-5 text-red-400" />
                )}
                <div>
                  <p className="font-medium text-slate-200">
                    External compliance service
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {complianceServiceHealthy
                      ? "live health and dataset evidence verified"
                      : "unavailable; settlement remains fail-closed"}
                  </p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                {sanctionsFresh ? (
                  <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400" />
                ) : (
                  <Clock3 className="mt-0.5 h-5 w-5 text-amber-400" />
                )}
                <div>
                  <p className="font-medium text-slate-200">
                    Sanctions dataset
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {engine.data?.sanctions.status ?? "unavailable"} ·{" "}
                    {engine.data?.sanctions.totalEntries ?? 0} entries
                  </p>
                </div>
              </li>
            </ul>
          </Panel>

          <Panel
            title="Payment limits"
            description="Enforced for the authenticated business."
          >
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Daily remaining</dt>
                <dd className="font-medium tabular-nums text-white">
                  {limits.data?.daily.remaining ?? "0"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Monthly remaining</dt>
                <dd className="font-medium tabular-nums text-white">
                  {limits.data?.monthly.remaining ?? "0"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Tier</dt>
                <dd className="font-medium text-white">
                  {limits.data?.tier ?? business?.tier}
                </dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <PageShell
      title="Settlement overview"
      description="Live payment, compliance, and control-plane evidence for the authenticated business."
      path="/"
    >
      <SessionGate>
        <DashboardContent />
      </SessionGate>
    </PageShell>
  );
}
