import { useApp } from "@/contexts/AppContext";
import { useStreaming } from "@/hooks/useStreaming";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

const amount = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(value);

function StreamingContent() {
  const { wallet } = useApp();
  const streaming = useStreaming(wallet.address || undefined);

  if (streaming.isLoading)
    return <LoadingState label="Loading payment streams" />;
  if (streaming.error) {
    return (
      <ErrorState
        error={streaming.error}
        retry={() => void streaming.refetch()}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Active streams"
          value={streaming.analytics?.totalActiveStreams || 0}
        />
        <MetricCard
          label="Streamed value"
          value={amount(streaming.analytics?.totalStreamedValue || 0)}
          tone="success"
        />
        <MetricCard
          label="Remaining value"
          value={amount(streaming.analytics?.totalRemainingValue || 0)}
        />
        <MetricCard
          label="Average duration"
          value={`${amount(streaming.analytics?.avgStreamDuration || 0)} days`}
        />
      </div>

      <Panel
        title="Stream execution"
        description="Contract writes are intentionally fail-closed in this environment."
      >
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100/75">
          {streaming.mutationReason} Existing schedules and calculated balances
          remain available below as read-only records.
        </div>
      </Panel>

      <Panel
        title="Payment streams"
        description="Balances refresh from the authenticated stream service."
      >
        {streaming.streams.length === 0 ? (
          <EmptyState
            title="No payment streams"
            body="No durable stream records were returned for the authenticated wallet."
          />
        ) : (
          <div className="space-y-3">
            {streaming.streams.map((stream) => {
              const balance = streaming.balances.get(stream.id);
              return (
                <article
                  key={stream.id}
                  className="rounded-xl border border-slate-800 p-4"
                >
                  <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium text-white">
                          {stream.tokenSymbol} stream
                        </h3>
                        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                          {stream.status}
                        </span>
                      </div>
                      <p className="mt-2 break-all text-sm text-slate-400">
                        To {stream.recipient}
                      </p>
                      <p className="mt-1 text-sm text-slate-400">
                        {amount(balance?.withdrawable || 0)} withdrawable ·{" "}
                        {amount(balance?.remaining || 0)} remaining
                      </p>
                    </div>
                    <span className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-500">
                      Read-only until receipt verification is enabled
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

export default function StreamingPage() {
  return (
    <PageShell
      title="Payment Streaming"
      description="Authenticated durable stream schedules, balances, and settlement history."
      path="/streaming"
    >
      <SessionGate>
        <StreamingContent />
      </SessionGate>
    </PageShell>
  );
}
