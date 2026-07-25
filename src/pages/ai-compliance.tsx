import { useAICompliance } from "@/hooks/useAICompliance";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function AIComplianceContent() {
  const compliance = useAICompliance();
  const activeModels = compliance.models.filter(
    (model) => model.status === "ACTIVE",
  );
  const openAppeals = compliance.appeals.filter((appeal) =>
    ["SUBMITTED", "UNDER_REVIEW"].includes(appeal.status),
  );

  if (compliance.isLoading)
    return <LoadingState label="Loading AI decision archive" />;
  if (compliance.error)
    return (
      <ErrorState
        error={compliance.error}
        retry={() => void compliance.refetch()}
      />
    );

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100/80">
        This archive is read-only. Adapter-supplied model and attestation
        metadata is not independently verified on-chain and cannot approve,
        block, or settle a NoblePay payment. Core payment screening remains
        governed by the separately reconciled compliance transaction flow.
      </div>

      {compliance.reviewQueueError && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100">
          Historical review queue unavailable:{" "}
          {compliance.reviewQueueError.message}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Configured model records"
          value={compliance.models.length}
        />
        <MetricCard
          label="Active metadata records"
          value={activeModels.length}
        />
        <MetricCard
          label="Recorded decisions"
          value={
            compliance.analytics?.totalDecisions ?? compliance.decisions.length
          }
        />
        <MetricCard
          label="Open historical appeals"
          value={openAppeals.length}
          tone={openAppeals.length ? "warning" : "neutral"}
        />
      </div>

      <Panel
        title="Model metadata archive"
        description="Durable records reported by a previously configured adapter. These labels are evidence fields, not hardware-attestation verification."
      >
        {compliance.models.length === 0 ? (
          <EmptyState
            title="No model records"
            body="No model metadata has been provisioned. NoblePay does not ship fixture models."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {compliance.models.map((model) => (
              <article
                key={model.id}
                className="rounded-xl border border-slate-800 p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-medium text-white">{model.name}</h3>
                  <span className="text-xs text-slate-400">{model.status}</span>
                </div>
                <p className="mt-2 text-sm text-slate-400">
                  {model.version} · reported accuracy {percent(model.accuracy)}{" "}
                  · {model.totalDecisions.toLocaleString()} decisions
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Adapter-reported attestation:{" "}
                  {model.teeAttested ? "present" : "absent"}; not independently
                  verified by this module.
                </p>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Historical decision records"
        description="Read-only tenant records. They are not an authority for the NoblePay payment state machine."
      >
        {compliance.decisions.length === 0 ? (
          <EmptyState
            title="No archived decisions"
            body="No adapter decision records were returned for this business."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-3">Decision</th>
                  <th>Payment</th>
                  <th>Outcome</th>
                  <th>Confidence</th>
                  <th>Risk</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {compliance.decisions.map((decision) => (
                  <tr key={decision.id}>
                    <td className="py-4 font-mono text-xs text-white">
                      {decision.id}
                    </td>
                    <td>{decision.paymentId}</td>
                    <td>{decision.outcome}</td>
                    <td>{percent(decision.confidence)}</td>
                    <td>{decision.riskScore}</td>
                    <td>{decision.humanOverride ? "Overridden" : "Adapter"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Historical appeals"
          description="Appeal mutations remain disabled until a governed, verifiable review service is integrated."
        >
          {compliance.appeals.length === 0 ? (
            <EmptyState
              title="No appeal records"
              body="No archived appeals were returned."
            />
          ) : (
            <div className="space-y-3">
              {compliance.appeals.map((appeal) => (
                <article
                  key={appeal.id}
                  className="rounded-lg border border-slate-800 p-3 text-sm"
                >
                  <div className="flex justify-between gap-3">
                    <span className="font-mono text-xs text-white">
                      {appeal.id}
                    </span>
                    <span className="text-slate-400">{appeal.status}</span>
                  </div>
                  <p className="mt-2 text-slate-500">
                    Payment {appeal.paymentId}
                  </p>
                </article>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Recorded bias metrics"
          description="Descriptive metrics calculated only from archived tenant decisions."
        >
          {compliance.biasMetrics.length === 0 ? (
            <EmptyState
              title="No bias metrics"
              body="Archived decisions are required before descriptive jurisdiction metrics exist."
            />
          ) : (
            <div className="space-y-3">
              {compliance.biasMetrics.map((metric) => (
                <article
                  key={metric.jurisdiction}
                  className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 sm:flex-row"
                >
                  <span className="font-medium text-white">
                    {metric.jurisdiction}
                  </span>
                  <span className="text-sm text-slate-400">
                    {metric.totalScreened.toLocaleString()} records · flag{" "}
                    {percent(metric.flagRate)} · block{" "}
                    {percent(metric.blockRate)}
                  </span>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

export default function AICompliancePage() {
  return (
    <PageShell
      title="AI decision archive"
      description="Read-only historical adapter records; not a payment authorization or TEE-verification surface."
      path="/ai-compliance"
    >
      <SessionGate>
        <AIComplianceContent />
      </SessionGate>
    </PageShell>
  );
}
