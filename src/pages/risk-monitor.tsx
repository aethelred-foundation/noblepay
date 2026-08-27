import { useEffect, useState } from "react";
import { Radio, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import {
  useComplianceMetrics,
  useFlaggedPayments,
} from "@/hooks/useCompliance";
import { useWebSocket, type WSEvent } from "@/hooks/useWebSocket";
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

function RiskContent() {
  const metrics = useComplianceMetrics();
  const flagged = useFlaggedPayments();
  const websocket = useWebSocket();
  const { subscribe } = websocket;
  const [events, setEvents] = useState<WSEvent[]>([]);

  useEffect(() => {
    const receive = (event: WSEvent) =>
      setEvents((current) => [event, ...current].slice(0, 50));
    const unsubscribeRisk = subscribe("risk", receive);
    const unsubscribeAlerts = subscribe("alerts", receive);
    const unsubscribeCompliance = subscribe("compliance", receive);
    return () => {
      unsubscribeRisk();
      unsubscribeAlerts();
      unsubscribeCompliance();
    };
  }, [subscribe]);

  if (metrics.isLoading || flagged.isLoading)
    return <LoadingState label="Loading risk posture" />;
  if (metrics.error)
    return (
      <ErrorState error={metrics.error} retry={() => void metrics.refetch()} />
    );
  if (flagged.error)
    return (
      <ErrorState error={flagged.error} retry={() => void flagged.refetch()} />
    );

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Average risk"
          value={(metrics.data?.averageRiskScore ?? 0).toFixed(1)}
        />
        <MetricCard
          label="Open flags"
          value={metrics.data?.flaggedCount ?? 0}
          tone={(metrics.data?.flaggedCount ?? 0) ? "danger" : "success"}
        />
        <MetricCard
          label="Under review"
          value={metrics.data?.underReviewCount ?? 0}
          tone={(metrics.data?.underReviewCount ?? 0) ? "warning" : "success"}
        />
        <MetricCard
          label="Live channel"
          value={websocket.connectionState}
          tone={
            websocket.connectionState === "connected" ? "success" : "warning"
          }
          detail={`${events.length} events retained this session`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.25fr_1fr]">
        <Panel
          title="Live risk events"
          description="Cookie-authenticated WebSocket events from the risk, alerts, and compliance channels."
          action={
            websocket.connectionState === "connected" ? (
              <span className="inline-flex items-center gap-2 text-xs text-emerald-400">
                <Radio className="h-4 w-4" /> Connected
              </span>
            ) : (
              <button
                type="button"
                onClick={websocket.reconnect}
                className="inline-flex items-center gap-2 text-xs font-semibold text-amber-300"
              >
                <RefreshCw className="h-4 w-4" /> Reconnect
              </button>
            )
          }
        >
          {events.length ? (
            <div className="max-h-[32rem] space-y-3 overflow-y-auto pr-1">
              {events.map((event) => (
                <article
                  key={`${event.correlationId}-${event.timestamp}`}
                  className="rounded-xl border border-slate-800 bg-slate-950/50 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={
                          event.channel === "alerts"
                            ? "error"
                            : event.channel === "risk"
                              ? "warning"
                              : "info"
                        }
                      >
                        {event.channel}
                      </Badge>
                      <span className="text-xs text-slate-400">
                        {event.type}
                      </span>
                    </div>
                    <time className="text-xs text-slate-600">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </time>
                  </div>
                  <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-5 text-slate-400">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title={
                websocket.connectionState === "connected"
                  ? "No live risk events"
                  : "Live channel disconnected"
              }
              body={
                websocket.connectionState === "connected"
                  ? "No event has been published during this browser session."
                  : "Reconnect to receive risk events; NoblePay does not generate sample alerts."
              }
            />
          )}
        </Panel>

        <div className="space-y-6">
          <Panel
            title="Highest current flags"
            description="Tenant-scoped payments sorted by the service response."
          >
            {flagged.data?.payments.length ? (
              <div className="space-y-3">
                {flagged.data.payments.slice(0, 8).map((payment) => (
                  <div
                    key={payment.id}
                    className="rounded-lg border border-slate-800 p-3"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate font-mono text-xs text-slate-400">
                        {payment.paymentId}
                      </p>
                      <Badge
                        variant={
                          (payment.riskScore ?? 0) >= 70 ? "error" : "warning"
                        }
                      >
                        {payment.riskScore ?? "N/A"}
                      </Badge>
                    </div>
                    <p className="mt-2 text-xs text-slate-600">
                      {payment.amount} {payment.currency}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-3 text-sm text-slate-500">
                <ShieldAlert className="h-4 w-4" /> No flagged payments.
              </div>
            )}
          </Panel>

          {websocket.connectionState === "disconnected" && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-100/70">
              <WifiOff className="mt-0.5 h-5 w-5 shrink-0" /> Live alerts are
              unavailable; persisted compliance records above remain
              authoritative.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RiskMonitorPage() {
  return (
    <PageShell
      title="Risk monitor"
      description="Live authenticated risk events alongside persisted flags and on-chain thresholds."
      path="/risk-monitor"
    >
      <SessionGate>
        <RiskContent />
      </SessionGate>
    </PageShell>
  );
}
