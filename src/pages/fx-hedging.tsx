import { formatBaseUnits } from "@/lib/fixed-point";
import { useFX } from "@/hooks/useFX";
import { useFXChain } from "@/hooks/useFXChain";
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

const shortHex = (value: string) =>
  value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

const bps = (value: number) => `${(value / 100).toFixed(2)}%`;

/**
 * Vault state, read from FXHedgingVault.
 *
 * Kept separate from the exposure metrics above, which come from the database.
 * The distinction matters here: the database knows what this business is
 * exposed to and can therefore report a hedge ratio; the vault only knows what
 * has been hedged. Neither is wrong, but only one of them is a contract
 * balance.
 *
 * Statuses use the contract's own vocabulary. The database models four; the
 * vault has seven, and LIQUIDATED and EMERGENCY_UNWOUND have no database
 * equivalent — reporting either as a generic "closed" would hide the outcome
 * that matters most.
 */
function OnChainVaultPanel() {
  const chain = useFXChain();

  if (chain.configured === null) {
    return (
      <Panel title="On-chain vault">
        <LoadingState label="Reading the FX vault" />
      </Panel>
    );
  }

  if (chain.configured === false) {
    return (
      <Panel
        title="On-chain vault"
        description="Contract state, read directly from FXHedgingVault."
      >
        <EmptyState
          title="No FX vault configured"
          body="This environment has no FX_HEDGING_VAULT_ADDRESS. The rates and positions above are database records only."
        />
      </Panel>
    );
  }

  const decimals = chain.rateDecimals ?? 8;

  return (
    <Panel
      title="On-chain vault"
      description="Contract state, read directly from FXHedgingVault. Distinct from the recorded exposure above."
    >
      {chain.error && (
        <div className="mb-4">
          <ErrorState error={chain.error} retry={() => void chain.refetch()} />
        </div>
      )}

      {chain.underMargined.length > 0 && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100"
        >
          <p className="font-semibold">
            {chain.underMargined.length} position
            {chain.underMargined.length === 1 ? "" : "s"} below maintenance
            margin
          </p>
          <p className="mt-1 text-red-100/80">
            These can be liquidated by anyone holding LIQUIDATOR_ROLE. Add
            margin to restore cover.
          </p>
        </div>
      )}

      {chain.marginUnknown.length > 0 && (
        <div
          role="status"
          className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100"
        >
          <p className="font-semibold">
            {chain.marginUnknown.length} position
            {chain.marginUnknown.length === 1 ? "" : "s"} could not be margin
            checked
          </p>
          <p className="mt-1 text-amber-100/80">
            The check needs a published oracle rate for the pair. This is not a
            statement that they are adequately margined — it is a statement that
            we do not know.
          </p>
        </div>
      )}

      {chain.adverselyClosed.length > 0 && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-100"
        >
          <p className="font-semibold">
            {chain.adverselyClosed.length} position
            {chain.adverselyClosed.length === 1 ? " was" : "s were"} liquidated
            or unwound
          </p>
          <p className="mt-1 text-red-100/80">
            Closed against the hedger rather than settled or exercised.
          </p>
        </div>
      )}

      <h3 className="text-sm font-semibold text-white">Currency pairs</h3>
      {chain.pairs.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="No currency pairs configured"
            body="An account holding ADMIN_ROLE must add a pair before any hedge can be opened against it."
          />
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400">
                <th className="pb-2 text-left">Pair</th>
                <th className="pb-2 text-right">Oracle rate</th>
                <th className="pb-2 text-right">Initial margin</th>
                <th className="pb-2 text-right">Maintenance</th>
                <th className="pb-2 text-right">Max hedge</th>
              </tr>
            </thead>
            <tbody>
              {chain.pairs.map((pair) => (
                <tr key={pair.pairId} className="border-b border-slate-800/60">
                  <td className="py-2 text-white">
                    {pair.base}/{pair.quote}
                  </td>
                  <td className="py-2 text-right">
                    {pair.rate === null ? (
                      <span className="text-amber-300">not published</span>
                    ) : (
                      <span className="text-white">
                        {formatBaseUnits(pair.rate, decimals, 4)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right text-slate-300">
                    {bps(pair.marginRequirementBps)}
                  </td>
                  <td className="py-2 text-right text-slate-300">
                    {bps(pair.maintenanceMarginBps)}
                  </td>
                  <td className="py-2 text-right text-slate-300">
                    {bps(pair.maxHedgeRatioBps)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mt-6 text-sm font-semibold text-white">
        Positions on the contract
      </h3>
      {chain.positions.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="No positions on chain"
            body="This account holds no hedge positions in the vault."
          />
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {chain.positions.map((position) => (
            <article
              key={position.positionId}
              className="rounded-xl border border-slate-800 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-medium text-white">
                  {position.hedgeType.replace("_", " ")}
                </h4>
                <span className="text-xs text-slate-400">
                  {position.status}
                  {position.underMargined === true && (
                    <span className="ml-2 text-red-300">under margin</span>
                  )}
                  {position.underMargined === null &&
                    position.status === "ACTIVE" && (
                      <span className="ml-2 text-amber-300">
                        margin unknown
                      </span>
                    )}
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-400">
                notional{" "}
                {formatBaseUnits(position.notionalAmount, decimals, 2)}{" "}
                · locked rate{" "}
                {formatBaseUnits(position.lockedRate, decimals, 4)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                collateral{" "}
                {formatBaseUnits(position.collateralAmount, decimals, 2)} in{" "}
                {shortHex(position.collateralToken)}
              </p>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}

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

      <OnChainVaultPanel />

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
