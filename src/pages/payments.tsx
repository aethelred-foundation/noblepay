import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { activeChain } from "@/config/wagmi";
import { useApp } from "@/contexts/AppContext";
import {
  useCancelPayment,
  useComplianceOfficerAuthorization,
  useExecuteSettlementRecovery,
  useInitiatePayment,
  usePayments,
  usePaymentStats,
  useRefundPayment,
  useSettlementRecoveryRequest,
  useSettlePayment,
  SUPPORTED_PAYMENT_CURRENCIES,
  type InitiatePaymentParams,
  type PaymentDetails,
} from "@/hooks/usePayment";
import {
  getTravelRuleRequirement,
  useAuthorizeTravelRule,
  useSubmitScreening,
  type TravelRuleData,
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

const STATUS_VARIANT: Record<
  string,
  "success" | "warning" | "error" | "info" | "neutral"
> = {
  SETTLED: "success",
  APPROVED: "success",
  PASSED: "success",
  PENDING: "warning",
  SCREENING: "info",
  FLAGGED: "warning",
  REJECTED: "error",
  BLOCKED: "error",
  CANCELLED: "neutral",
  REFUNDED: "neutral",
};

const initialPayment: InitiatePaymentParams = {
  recipient: "",
  amount: "",
  currency: "USDC",
  purpose: "",
};

const initialTravelRuleData: TravelRuleData = {
  originatorName: "",
  originatorAccount: "",
  originatorAddress: "",
  beneficiaryName: "",
  beneficiaryAccount: "",
  originatorNationalId: "",
  beneficiaryInstitution: "",
};

function short(value: string, start = 8, end = 6) {
  return value.length > start + end + 3
    ? `${value.slice(0, start)}…${value.slice(-end)}`
    : value;
}

function SettlementRecoveryAction({ payment }: { payment: PaymentDetails }) {
  const { addNotification } = useApp();
  const request = useSettlementRecoveryRequest(payment.paymentId);
  const execution = useExecuteSettlementRecovery();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      30_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  const executeAfter = request.recoveryRequest?.executeAfter ?? 0n;
  const expiresAt = request.recoveryRequest?.expiresAt ?? 0n;
  const active = executeAfter > 0n && BigInt(now) <= expiresAt;
  const executable = active && BigInt(now) >= executeAfter;

  const submitRequest = async () => {
    try {
      await request.request();
      addNotification(
        "success",
        "Recovery notice recorded",
        "The 48-hour on-chain notice is active. Settlement remains available if corridor clearance is restored.",
      );
    } catch (error) {
      addNotification(
        "error",
        "Recovery request failed",
        error instanceof Error
          ? error.message
          : "The on-chain recovery notice could not be recorded.",
      );
    }
  };

  const executeRecovery = async () => {
    try {
      await execution.execute({ paymentId: payment.paymentId });
      addNotification(
        "success",
        "Settlement recovery confirmed",
        "The delayed refund and its exact NoblePay receipt were independently verified.",
      );
    } catch (error) {
      addNotification(
        "error",
        "Settlement recovery failed",
        error instanceof Error
          ? error.message
          : "The delayed recovery transaction failed.",
      );
    }
  };

  if (request.isLoading) {
    return <span className="text-xs text-slate-500">Loading recovery…</span>;
  }
  if (request.error) {
    return (
      <span className="text-xs text-red-300">Recovery status unavailable</span>
    );
  }
  if (!active) {
    return (
      <button
        type="button"
        disabled={request.isRequesting || execution.isPending}
        onClick={() => void submitRequest()}
        className="text-xs font-semibold text-amber-300 hover:text-amber-200 disabled:cursor-wait disabled:opacity-40"
      >
        {request.isRequesting
          ? "Requesting recovery…"
          : executeAfter > 0n
            ? "Renew recovery notice"
            : "Request recovery"}
      </button>
    );
  }
  if (!executable) {
    return (
      <span
        className="text-xs text-slate-500"
        title={`Execution window ends ${new Date(Number(expiresAt) * 1000).toLocaleString()}`}
      >
        Recovery after {new Date(Number(executeAfter) * 1000).toLocaleString()}
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={execution.isPending || request.isRequesting}
      onClick={() => void executeRecovery()}
      title={`Recovery window ends ${new Date(Number(expiresAt) * 1000).toLocaleString()}`}
      className="text-xs font-semibold text-amber-300 hover:text-amber-200 disabled:cursor-wait disabled:opacity-40"
    >
      {execution.isPending ? "Recovering…" : "Execute recovery"}
    </button>
  );
}

function PaymentsContent() {
  const { addNotification } = useApp();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [currency, setCurrency] = useState("");
  const [screeningPaymentId, setScreeningPaymentId] = useState<string | null>(
    null,
  );
  const [showCreate, setShowCreate] = useState(false);
  const [travelRulePayment, setTravelRulePayment] =
    useState<PaymentDetails | null>(null);
  const [travelRuleData, setTravelRuleData] = useState<TravelRuleData>(
    initialTravelRuleData,
  );
  const [form, setForm] = useState<InitiatePaymentParams>(initialPayment);
  const payments = usePayments({
    page,
    pageSize: 20,
    status,
    search,
    currency,
  });
  const stats = usePaymentStats();
  const initiation = useInitiatePayment();
  const settlement = useSettlePayment();
  const cancellation = useCancelPayment();
  const refund = useRefundPayment();
  const screening = useSubmitScreening();
  const travelRuleAuthorization = useAuthorizeTravelRule();
  const complianceOfficer = useComplianceOfficerAuthorization();

  const statusSummary = useMemo(
    () =>
      Object.entries(stats.data?.byStatus ?? {}).sort((a, b) => b[1] - a[1]),
    [stats.data?.byStatus],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const payment = await initiation.initiate(form);
      addNotification(
        "success",
        "Payment recorded",
        `Verified on-chain payment ${short(payment.paymentId)} is now tracked.`,
      );
      setForm(initialPayment);
      setShowCreate(false);
    } catch (error) {
      addNotification(
        "error",
        "Payment failed",
        error instanceof Error
          ? error.message
          : "The payment could not be submitted.",
      );
    }
  };

  const runLifecycleAction = async (
    payment: PaymentDetails,
    action: "settle" | "cancel" | "refund",
  ) => {
    const operation =
      action === "settle"
        ? settlement
        : action === "cancel"
          ? cancellation
          : refund;
    try {
      await operation.execute({ paymentId: payment.paymentId });
      addNotification(
        "success",
        `Payment ${action} confirmed`,
        `The ${action} transaction was independently verified on Aethelred.`,
      );
    } catch (error) {
      addNotification(
        "error",
        `Payment ${action} failed`,
        error instanceof Error
          ? error.message
          : "The lifecycle transaction failed.",
      );
    }
  };

  const submitToVerifier = async (payment: PaymentDetails) => {
    setScreeningPaymentId(payment.id);
    try {
      const result = await screening.mutateAsync({
        paymentId: payment.id,
        priority: "normal",
      });
      addNotification(
        "success",
        "Screening verified",
        `The audited verifier submitted and NoblePay verified the on-chain ${result.status} result. A Travel Rule signature authorizes data sharing only; it never signs the verifier transaction.`,
      );
    } catch (error) {
      addNotification(
        "error",
        "Screening failed",
        error instanceof Error
          ? error.message
          : "The audited verifier could not screen this payment.",
      );
    } finally {
      setScreeningPaymentId(null);
    }
  };

  const runScreening = async (payment: PaymentDetails) => {
    setScreeningPaymentId(payment.id);
    try {
      const requirement = await getTravelRuleRequirement(payment.id);
      if (requirement.required && !requirement.authorized) {
        setTravelRuleData(initialTravelRuleData);
        setTravelRulePayment(payment);
        return;
      }
      await submitToVerifier(payment);
    } catch (error) {
      addNotification(
        "error",
        "Travel Rule check failed",
        error instanceof Error
          ? error.message
          : "NoblePay could not verify the payment's Travel Rule requirement.",
      );
    } finally {
      setScreeningPaymentId(null);
    }
  };

  const authorizeAndScreen = async (event: FormEvent) => {
    event.preventDefault();
    if (!travelRulePayment) return;
    const {
      originatorNationalId,
      beneficiaryInstitution,
      ...requiredTravelRuleData
    } = travelRuleData;
    const data: TravelRuleData = {
      ...requiredTravelRuleData,
      ...(originatorNationalId?.trim() ? { originatorNationalId } : {}),
      ...(beneficiaryInstitution?.trim() ? { beneficiaryInstitution } : {}),
    };
    try {
      await travelRuleAuthorization.mutateAsync({
        paymentId: travelRulePayment.id,
        data,
      });
      const payment = travelRulePayment;
      setTravelRulePayment(null);
      setTravelRuleData(initialTravelRuleData);
      await submitToVerifier(payment);
    } catch (error) {
      addNotification(
        "error",
        "Travel Rule authorization failed",
        error instanceof Error
          ? error.message
          : "The wallet-bound Travel Rule data could not be authorized.",
      );
    }
  };

  const lifecyclePending =
    settlement.isPending || cancellation.isPending || refund.isPending;

  if (stats.isLoading && payments.isLoading)
    return <LoadingState label="Loading verified payments" />;
  if (stats.error)
    return (
      <ErrorState error={stats.error} retry={() => void stats.refetch()} />
    );
  if (payments.error)
    return (
      <ErrorState
        error={payments.error}
        retry={() => void payments.refetch()}
      />
    );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Verified payments"
          value={stats.data?.totalPayments ?? 0}
        />
        <MetricCard
          label="Total recorded volume"
          value={stats.data?.totalVolume ?? "0"}
        />
        <MetricCard
          label="Last 24 hours"
          value={stats.data?.last24h.count ?? 0}
          detail={`${stats.data?.last24h.volume ?? "0"} total volume`}
        />
        <MetricCard
          label="Flagged"
          value={stats.data?.byStatus.FLAGGED ?? 0}
          tone={(stats.data?.byStatus.FLAGGED ?? 0) > 0 ? "warning" : "success"}
          detail={
            statusSummary.length
              ? statusSummary
                  .map(([key, value]) => `${key}: ${value}`)
                  .join(" · ")
              : "No status history yet"
          }
        />
      </div>

      {initiation.pendingReconciliation && (
        <div
          role="status"
          className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5"
        >
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h2 className="font-semibold text-amber-100">
                Confirmed payment needs reconciliation
              </h2>
              <p className="mt-1 text-sm leading-6 text-amber-100/70">
                The wallet transaction succeeded, but the API has not recorded
                it yet. Recovery reuses the existing transaction and will never
                submit a duplicate payment.
              </p>
              <a
                href={`${activeChain.blockExplorers?.default.url}/tx/${initiation.pendingReconciliation.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 font-mono text-xs text-amber-300 hover:text-amber-200"
              >
                {short(initiation.pendingReconciliation.txHash, 12, 8)}{" "}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              {initiation.recoveryError && (
                <p role="alert" className="mt-2 text-sm text-red-300">
                  {initiation.recoveryError.message}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={initiation.isPending}
              onClick={() =>
                void initiation
                  .recover()
                  .then(() =>
                    addNotification(
                      "success",
                      "Payment recovered",
                      "The existing transaction was verified and recorded.",
                    ),
                  )
                  .catch((error) =>
                    addNotification(
                      "error",
                      "Recovery failed",
                      error instanceof Error
                        ? error.message
                        : "The API could not reconcile the payment.",
                    ),
                  )
              }
              className="shrink-0 rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
            >
              {initiation.isPending ? "Verifying…" : "Recover transaction"}
            </button>
          </div>
        </div>
      )}

      <Panel
        title="Payment ledger"
        description="Only API records independently reconciled with Aethelred receipts are shown."
        action={
          <button
            type="button"
            onClick={() => void payments.refetch()}
            className="inline-flex items-center gap-2 text-xs font-semibold text-slate-300 hover:text-white"
          >
            <RefreshCw
              className={`h-4 w-4 ${payments.isFetching ? "animate-spin" : ""}`}
            />{" "}
            Refresh
          </button>
        }
      >
        <div className="mb-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_10rem]">
          <label className="relative">
            <span className="sr-only">Search payments</span>
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Payment ID or address"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-600"
            />
          </label>
          <label>
            <span className="sr-only">Payment status</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
            >
              <option value="">All statuses</option>
              {Object.keys(STATUS_VARIANT).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="sr-only">Payment currency</span>
            <select
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
            >
              <option value="">All assets</option>
              <option>USDC</option>
              <option>USDT</option>
            </select>
          </label>
        </div>

        {!payments.data?.payments.length ? (
          <EmptyState
            title="No verified payments"
            body="Create a payment or adjust the filters. NoblePay never fills this ledger with sample transactions."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500">
                <tr className="border-b border-slate-800">
                  <th className="pb-3 font-medium">Payment</th>
                  <th className="pb-3 font-medium">Recipient</th>
                  <th className="pb-3 text-right font-medium">Amount</th>
                  <th className="pb-3 font-medium">Status</th>
                  <th className="pb-3 font-medium">Submitted</th>
                  <th className="pb-3 text-right font-medium">Proof</th>
                  <th className="pb-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {payments.data.payments.map((payment) => (
                  <tr
                    key={payment.id}
                    className="border-b border-slate-800/70 last:border-0"
                  >
                    <td
                      className="py-4 font-mono text-xs text-slate-300"
                      title={payment.paymentId}
                    >
                      {short(payment.paymentId)}
                    </td>
                    <td
                      className="py-4 font-mono text-xs text-slate-400"
                      title={payment.recipient}
                    >
                      {short(payment.recipient)}
                    </td>
                    <td className="py-4 text-right font-medium tabular-nums text-white">
                      {payment.amount}{" "}
                      <span className="text-xs text-slate-500">
                        {payment.currency}
                      </span>
                    </td>
                    <td className="py-4">
                      <Badge
                        variant={STATUS_VARIANT[payment.status] ?? "neutral"}
                      >
                        {payment.status}
                      </Badge>
                    </td>
                    <td className="py-4 text-xs text-slate-400">
                      {new Date(payment.initiatedAt).toLocaleString()}
                    </td>
                    <td className="py-4 text-right">
                      {payment.txHash ? (
                        <a
                          href={`${activeChain.blockExplorers?.default.url}/tx/${payment.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Open transaction ${payment.txHash}`}
                          className="inline-flex items-center gap-1 text-xs text-amber-300 hover:text-amber-200"
                        >
                          Explorer <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <span className="text-xs text-slate-600">
                          Awaiting indexer
                        </span>
                      )}
                    </td>
                    <td className="py-4 text-right">
                      {payment.status === "PENDING" && (
                        <div className="flex justify-end gap-3">
                          <button
                            type="button"
                            disabled={
                              screening.isPending ||
                              travelRuleAuthorization.isPending ||
                              lifecyclePending
                            }
                            onClick={() => void runScreening(payment)}
                            className="text-xs font-semibold text-emerald-300 hover:text-emerald-200 disabled:cursor-wait disabled:opacity-40"
                          >
                            {screeningPaymentId === payment.id
                              ? "Screening…"
                              : "Screen"}
                          </button>
                          <button
                            type="button"
                            disabled={screening.isPending || lifecyclePending}
                            onClick={() =>
                              void runLifecycleAction(payment, "cancel")
                            }
                            className="text-xs font-semibold text-slate-300 hover:text-white disabled:cursor-wait disabled:opacity-40"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                      {(payment.status === "PASSED" ||
                        payment.status === "APPROVED") && (
                        <div className="flex justify-end gap-3">
                          <button
                            type="button"
                            disabled={lifecyclePending}
                            onClick={() =>
                              void runLifecycleAction(payment, "settle")
                            }
                            className="text-xs font-semibold text-emerald-300 hover:text-emerald-200 disabled:cursor-wait disabled:opacity-40"
                          >
                            Settle
                          </button>
                          {complianceOfficer.isComplianceOfficer && (
                            <SettlementRecoveryAction payment={payment} />
                          )}
                          {!complianceOfficer.isComplianceOfficer &&
                            complianceOfficer.isLoading && (
                              <span className="text-xs text-slate-500">
                                Checking recovery role…
                              </span>
                            )}
                          {!complianceOfficer.isComplianceOfficer &&
                            complianceOfficer.error && (
                              <span className="text-xs text-red-300">
                                Recovery role unavailable
                              </span>
                            )}
                        </div>
                      )}
                      {(payment.status === "BLOCKED" ||
                        payment.status === "REJECTED") && (
                        <button
                          type="button"
                          disabled={lifecyclePending}
                          onClick={() =>
                            void runLifecycleAction(payment, "refund")
                          }
                          className="text-xs font-semibold text-amber-300 hover:text-amber-200 disabled:cursor-wait disabled:opacity-40"
                        >
                          Refund
                        </button>
                      )}
                      {payment.status === "FLAGGED" &&
                        complianceOfficer.isComplianceOfficer && (
                          <button
                            type="button"
                            disabled={lifecyclePending}
                            onClick={() =>
                              void runLifecycleAction(payment, "refund")
                            }
                            className="text-xs font-semibold text-amber-300 hover:text-amber-200 disabled:cursor-wait disabled:opacity-40"
                          >
                            Officer refund
                          </button>
                        )}
                      {payment.status === "FLAGGED" &&
                        !complianceOfficer.isComplianceOfficer && (
                          <span className="text-xs text-slate-500">
                            {complianceOfficer.isLoading
                              ? "Checking contract role…"
                              : complianceOfficer.error
                                ? "Contract role unavailable"
                                : "Compliance officer required"}
                          </span>
                        )}
                      {payment.status === "SCREENING" && (
                        <span className="text-xs text-slate-500">
                          Verifier processing
                        </span>
                      )}
                      {["SETTLED", "REFUNDED", "CANCELLED"].includes(
                        payment.status,
                      ) && (
                        <span className="text-xs text-slate-600">Complete</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(payments.data?.totalPages ?? 1) > 1 && (
          <div className="mt-5 flex items-center justify-between border-t border-slate-800 pt-4 text-xs text-slate-500">
            <span>
              Page {payments.data?.page} of {payments.data?.totalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
                className="rounded-lg border border-slate-700 p-2 text-slate-300 disabled:opacity-30"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={page >= (payments.data?.totalPages ?? 1)}
                onClick={() => setPage((value) => value + 1)}
                className="rounded-lg border border-slate-700 p-2 text-slate-300 disabled:opacity-30"
              >
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </Panel>

      <Modal
        open={Boolean(travelRulePayment)}
        onClose={() =>
          !travelRuleAuthorization.isPending && setTravelRulePayment(null)
        }
        title="Authorize Travel Rule data"
      >
        <form onSubmit={authorizeAndScreen} className="space-y-4">
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5 text-amber-100/80">
            This payment meets the configured Travel Rule threshold. NoblePay
            commits these fields to the exact payment, asks your business wallet
            for a one-time personal signature, and stores only AES-256-GCM
            ciphertext. The plaintext is sent only to the configured audited
            compliance operator over TLS. The signature has no gas fee and is
            not a blockchain transaction.
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm text-slate-300">
              Originator legal name
              <input
                required
                maxLength={200}
                value={travelRuleData.originatorName}
                onChange={(event) =>
                  setTravelRuleData({
                    ...travelRuleData,
                    originatorName: event.target.value,
                  })
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
              />
            </label>
            <label className="block text-sm text-slate-300">
              Originator account
              <input
                required
                maxLength={128}
                value={travelRuleData.originatorAccount}
                onChange={(event) =>
                  setTravelRuleData({
                    ...travelRuleData,
                    originatorAccount: event.target.value,
                  })
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-white"
              />
            </label>
          </div>
          <label className="block text-sm text-slate-300">
            Originator registered address
            <textarea
              required
              maxLength={512}
              value={travelRuleData.originatorAddress}
              onChange={(event) =>
                setTravelRuleData({
                  ...travelRuleData,
                  originatorAddress: event.target.value,
                })
              }
              className="mt-1 min-h-20 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm text-slate-300">
              Beneficiary legal name
              <input
                required
                maxLength={200}
                value={travelRuleData.beneficiaryName}
                onChange={(event) =>
                  setTravelRuleData({
                    ...travelRuleData,
                    beneficiaryName: event.target.value,
                  })
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
              />
            </label>
            <label className="block text-sm text-slate-300">
              Beneficiary account
              <input
                required
                maxLength={128}
                value={travelRuleData.beneficiaryAccount}
                onChange={(event) =>
                  setTravelRuleData({
                    ...travelRuleData,
                    beneficiaryAccount: event.target.value,
                  })
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-white"
              />
            </label>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm text-slate-300">
              Originator registration ID (optional)
              <input
                maxLength={128}
                value={travelRuleData.originatorNationalId || ""}
                onChange={(event) =>
                  setTravelRuleData({
                    ...travelRuleData,
                    originatorNationalId: event.target.value,
                  })
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
              />
            </label>
            <label className="block text-sm text-slate-300">
              Beneficiary institution (optional)
              <input
                maxLength={200}
                value={travelRuleData.beneficiaryInstitution || ""}
                onChange={(event) =>
                  setTravelRuleData({
                    ...travelRuleData,
                    beneficiaryInstitution: event.target.value,
                  })
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
              />
            </label>
          </div>
          {travelRuleAuthorization.error && (
            <p role="alert" className="text-sm text-red-300">
              {travelRuleAuthorization.error.message}
            </p>
          )}
          <button
            type="submit"
            disabled={travelRuleAuthorization.isPending || screening.isPending}
            className="w-full rounded-lg bg-amber-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
          >
            {travelRuleAuthorization.isPending
              ? "Waiting for wallet signature…"
              : screening.isPending
                ? "Screening…"
                : "Sign authorization and screen"}
          </button>
        </form>
      </Modal>

      <Modal
        open={showCreate}
        onClose={() => !initiation.isPending && setShowCreate(false)}
        title="Initiate verified payment"
      >
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm text-slate-300">
            Recipient address
            <input
              required
              value={form.recipient}
              onChange={(event) =>
                setForm({ ...form, recipient: event.target.value.trim() })
              }
              placeholder="0x…"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-white"
            />
          </label>
          <div className="grid grid-cols-[1fr_8rem] gap-3">
            <label className="block text-sm text-slate-300">
              Amount
              <input
                required
                inputMode="decimal"
                value={form.amount}
                onChange={(event) =>
                  setForm({ ...form, amount: event.target.value })
                }
                placeholder="0.00"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
              />
            </label>
            <label className="block text-sm text-slate-300">
              Asset
              <select
                value={form.currency}
                onChange={(event) =>
                  setForm({
                    ...form,
                    currency: event.target
                      .value as InitiatePaymentParams["currency"],
                  })
                }
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
              >
                {SUPPORTED_PAYMENT_CURRENCIES.map((supportedCurrency) => (
                  <option key={supportedCurrency}>{supportedCurrency}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-sm text-slate-300">
            Payment purpose
            <textarea
              required
              minLength={3}
              maxLength={500}
              value={form.purpose}
              onChange={(event) =>
                setForm({ ...form, purpose: event.target.value })
              }
              placeholder="Invoice or settlement reference"
              className="mt-1 min-h-24 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
            />
          </label>
          <p className="text-xs leading-5 text-slate-500">
            NoblePay supports governance-approved 6-decimal USD stablecoins. It
            may first request an exact token allowance, then the escrow
            transaction. The API records the payment only after independently
            verifying its receipt.
          </p>
          {initiation.error && (
            <p role="alert" className="text-sm text-red-300">
              {initiation.error.message}
            </p>
          )}
          <button
            type="submit"
            disabled={initiation.isPending}
            className="w-full rounded-lg bg-amber-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
          >
            {initiation.isPending
              ? "Confirming on Aethelred…"
              : "Review in wallet"}
          </button>
        </form>
      </Modal>

      <button
        type="button"
        onClick={() => {
          initiation.reset();
          setShowCreate(true);
        }}
        className="fixed bottom-6 right-6 inline-flex items-center gap-2 rounded-full bg-amber-400 px-5 py-3 text-sm font-bold text-slate-950 shadow-xl shadow-black/30 hover:bg-amber-300"
      >
        <Plus className="h-4 w-4" /> New payment
      </button>
    </div>
  );
}

export default function PaymentsPage() {
  return (
    <PageShell
      title="Payments"
      description="Initiate escrow payments and inspect the reconciled on-chain ledger."
      path="/payments"
    >
      <SessionGate>
        <PaymentsContent />
      </SessionGate>
    </PageShell>
  );
}
