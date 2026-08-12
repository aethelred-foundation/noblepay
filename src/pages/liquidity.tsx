import { useLiquidity } from "@/hooks/useLiquidity";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

const number = (value: number, digits = 2) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(
    value,
  );
const money = (value: number) => `$${number(value)}`;

function LiquidityContent() {
  const liquidity = useLiquidity();

  if (liquidity.isLoading)
    return <LoadingState label="Loading liquidity pools" />;
  if (liquidity.error) {
    return (
      <ErrorState
        error={liquidity.error}
        retry={() => void liquidity.refetch()}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <MetricCard
          label="Total value locked"
          value={money(liquidity.analytics?.totalTvl || 0)}
        />
        <MetricCard
          label="24h volume"
          value={money(liquidity.analytics?.totalVolume24h || 0)}
        />
        <MetricCard
          label="Pools"
          value={liquidity.analytics?.totalPools || liquidity.pools.length}
        />
        <MetricCard
          label="Average APY"
          value={
            liquidity.analytics?.avgApy === null ||
            liquidity.analytics?.avgApy === undefined
              ? "Unavailable"
              : `${number(liquidity.analytics.avgApy)}%`
          }
        />
        <MetricCard
          label="24h fees"
          value={money(liquidity.analytics?.totalFeesEarned24h || 0)}
        />
      </div>

      <Panel
        title="Liquidity execution"
        description="Settlements are verified against the chain before they are recorded."
      >
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100/75">
          {liquidity.mutationReason} A settlement is accepted only if the
          transaction is canonical on this network, targeted the pool, and
          emitted the matching event for your address — and a flash loan only if
          its repayment appears in the same transaction as the borrow.
        </div>
      </Panel>

      <Panel title="Settlement pools">
        {liquidity.pools.length === 0 ? (
          <EmptyState
            title="No pool records"
            body="No live liquidity pool data was returned."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-3">Pool</th>
                  <th>TVL</th>
                  <th>24h volume</th>
                  <th>APY</th>
                  <th>Fee</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {liquidity.pools.map((pool) => (
                  <tr key={pool.address}>
                    <td className="py-4 font-medium text-white">{pool.name}</td>
                    <td>{money(pool.tvl)}</td>
                    <td>{money(pool.volume24h)}</td>
                    <td className="text-emerald-300">
                      {pool.apy === null
                        ? "Unavailable"
                        : `${number(pool.apy)}%`}
                    </td>
                    <td>{number(pool.feeBps)} bps</td>
                    <td>{pool.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Your positions"
        description="Authenticated durable position records. Liquidity execution remains disabled until settlement receipts can be verified."
      >
        {liquidity.positions.length === 0 ? (
          <EmptyState
            title="No liquidity positions"
            body="No durable position records were returned for the authenticated wallet."
          />
        ) : (
          <div className="space-y-3">
            {liquidity.positions.map((position) => (
              <article
                key={position.id}
                className="flex flex-col justify-between gap-4 rounded-xl border border-slate-800 p-4 sm:flex-row sm:items-center"
              >
                <div>
                  <h3 className="font-medium text-white">
                    {position.poolName}
                  </h3>
                  <p className="mt-1 text-sm text-slate-400">
                    {position.valueUsd === null
                      ? `${number(position.lpTokens)} liquidity units`
                      : money(position.valueUsd)}{" "}
                    · {number(position.poolShare, 4)}% share ·{" "}
                    {money(position.unclaimedFees)} recorded fees
                  </p>
                </div>
                <span
                  title={liquidity.mutationReason}
                  className="text-xs text-amber-300"
                >
                  Removal unavailable
                </span>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

export default function LiquidityPage() {
  return (
    <PageShell
      title="Liquidity"
      description="Live settlement pools and authenticated liquidity positions."
      path="/liquidity"
    >
      <SessionGate>
        <LiquidityContent />
      </SessionGate>
    </PageShell>
  );
}
