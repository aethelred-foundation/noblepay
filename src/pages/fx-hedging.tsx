import { useFX } from "@/hooks/useFX";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

const number = (value: number, digits = 4) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(
    value,
  );
const money = (value: number) => `$${number(value, 2)}`;
const optionalMoney = (value: number | null | undefined) =>
  value === null || value === undefined ? "Unavailable" : money(value);

function FXContent() {
  const fx = useFX();
  if (fx.isLoading)
    return <LoadingState label="Loading FX rates and positions" />;
  if (fx.error)
    return <ErrorState error={fx.error} retry={() => void fx.refetch()} />;

  return (
    <div className="space-y-6">
      <div
        role="status"
        className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100"
      >
        <p className="font-semibold">FX execution is read-only</p>
        <p className="mt-1 text-amber-100/80">{fx.mutationReason}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Total exposure"
          value={money(fx.exposure?.totalExposure || 0)}
        />
        <MetricCard
          label="Hedged"
          value={`${number(fx.exposure?.hedgedPercentage || 0, 2)}%`}
          tone="success"
        />
        <MetricCard
          label="Unhedged exposure"
          value={optionalMoney(fx.exposure?.unhedgedExposure)}
          tone="warning"
        />
        <MetricCard
          label="Value at risk"
          value={optionalMoney(fx.exposure?.valueAtRisk)}
          tone="danger"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Live rates">
          {fx.ratesLoading ? (
            <LoadingState label="Loading verified FX rates" />
          ) : fx.oracleError ? (
            <ErrorState
              error={fx.oracleError}
              retry={() => void fx.refetch()}
            />
          ) : fx.rates.length === 0 ? (
            <EmptyState
              title="No FX rates"
              body="The rate service returned no supported currency pairs."
            />
          ) : (
            <div className="space-y-3">
              {fx.rates.map((rate) => (
                <article
                  key={rate.pair}
                  className="flex items-center justify-between rounded-xl border border-slate-800 p-4"
                >
                  <div>
                    <h3 className="font-medium text-white">{rate.pair}</h3>
                    <p className="mt-1 text-xs text-slate-500">
                      Bid {number(rate.bid)} · Ask {number(rate.ask)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-white">
                      {number(rate.rate)}
                    </p>
                    {rate.change24h === null ? (
                      <p className="text-xs text-slate-500">
                        24h change unavailable
                      </p>
                    ) : (
                      <p
                        className={
                          rate.change24h >= 0
                            ? "text-xs text-emerald-300"
                            : "text-xs text-red-300"
                        }
                      >
                        {rate.change24h >= 0 ? "+" : ""}
                        {number(rate.change24h, 2)}%
                      </p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Exposure by currency">
          {!fx.exposure || fx.exposure.byPair.length === 0 ? (
            <EmptyState
              title="No currency exposure"
              body="No active exposure was returned for this business."
            />
          ) : (
            <div className="space-y-3">
              {fx.exposure.byPair.map((item) => (
                <article
                  key={item.pair}
                  className="rounded-xl border border-slate-800 p-4"
                >
                  <div className="flex justify-between">
                    <h3 className="font-medium text-white">{item.pair}</h3>
                    <span>{money(item.exposure)}</span>
                  </div>
                  <p className="mt-2 text-sm text-slate-400">
                    {money(item.hedged)} hedged · {optionalMoney(item.unhedged)}{" "}
                    unhedged
                  </p>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Hedge positions">
        {fx.hedges.length === 0 ? (
          <EmptyState
            title="No hedge positions"
            body="No durable hedge records were returned for this business."
          />
        ) : (
          <div className="space-y-3">
            {fx.hedges.map((hedge) => (
              <article
                key={hedge.id}
                className="flex flex-col justify-between gap-4 rounded-xl border border-slate-800 p-4 sm:flex-row sm:items-center"
              >
                <div>
                  <h3 className="font-medium text-white">
                    {hedge.fromCurrency}/{hedge.toCurrency}
                  </h3>
                  <p className="mt-1 text-sm text-slate-400">
                    {money(hedge.notionalAmount)} notional · locked{" "}
                    {number(hedge.lockedRate)} · current{" "}
                    {number(hedge.currentRate)} · P&amp;L{" "}
                    {optionalMoney(hedge.unrealizedPnl)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-slate-400">{hedge.status}</span>
                  {hedge.status === "Active" && (
                    <span className="text-xs text-amber-300">
                      Settlement unavailable
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

export default function FXHedgingPage() {
  return (
    <PageShell
      title="FX Hedging"
      description="Verified currency rates and authenticated durable hedge records."
      path="/fx-hedging"
    >
      <SessionGate>
        <FXContent />
      </SessionGate>
    </PageShell>
  );
}
