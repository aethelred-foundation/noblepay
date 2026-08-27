import { useCrossChain } from "@/hooks/useCrossChain";
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

function CrossChainContent() {
  const crossChain = useCrossChain();

  if (crossChain.isLoading)
    return <LoadingState label="Loading cross-chain services" />;
  if (crossChain.error) {
    return (
      <ErrorState
        error={crossChain.error}
        retry={() => void crossChain.refetch()}
      />
    );
  }

  const activeTransfers = crossChain.transfers.filter(
    (transfer) =>
      !["Completed", "Failed", "Refunded"].includes(transfer.status),
  ).length;

  return (
    <div className="space-y-6">
      <div
        role="status"
        className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100"
      >
        <p className="font-semibold">Bridge execution is read-only</p>
        <p className="mt-1 text-amber-100/80">{crossChain.mutationReason}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Supported chains" value={crossChain.chains.length} />
        <MetricCard label="Transfers" value={crossChain.transfers.length} />
        <MetricCard
          label="In progress"
          value={activeTransfers}
          tone="warning"
        />
        <MetricCard
          label="Active relays"
          value={
            crossChain.relayNodes.filter((node) => node.status === "Active")
              .length
          }
          tone="success"
        />
      </div>

      <Panel title="Chain status">
        {crossChain.chainsLoading ? (
          <LoadingState label="Verifying configured chain RPCs" />
        ) : crossChain.chainsError ? (
          <ErrorState
            error={crossChain.chainsError}
            retry={() => void crossChain.refetch()}
          />
        ) : crossChain.chains.length === 0 ? (
          <EmptyState
            title="No chains"
            body="The cross-chain service returned no configured chains."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {crossChain.chains.map((chain) => (
              <article
                key={chain.chainId}
                className="rounded-xl border border-slate-800 p-4"
              >
                <div className="flex justify-between">
                  <h3 className="font-medium text-white">{chain.name}</h3>
                  <span className="text-xs text-slate-400">{chain.status}</span>
                </div>
                <p className="mt-2 text-sm text-slate-400">
                  Chain {chain.chainId} · {number(chain.avgBlockTime)}s blocks ·{" "}
                  {chain.gasPrice === null
                    ? "gas price unavailable"
                    : `${number(chain.gasPrice, 6)} wei gas`}
                </p>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Transfers">
        {crossChain.transfers.length === 0 ? (
          <EmptyState
            title="No cross-chain transfers"
            body="No transfer history was returned for this business."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-3">Transfer</th>
                  <th>Route</th>
                  <th>Recipient</th>
                  <th>Amount</th>
                  <th>Fee</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {crossChain.transfers.map((transfer) => (
                  <tr key={transfer.id}>
                    <td className="py-4 font-mono text-xs text-white">
                      {transfer.id}
                    </td>
                    <td>
                      {transfer.sourceChainName} → {transfer.destChainName}
                    </td>
                    <td className="max-w-48 truncate">{transfer.recipient}</td>
                    <td>
                      {number(transfer.amount)} {transfer.tokenSymbol}
                    </td>
                    <td>
                      {transfer.bridgeFee === null
                        ? "Unavailable"
                        : `$${number(transfer.bridgeFee)}`}
                    </td>
                    <td>{transfer.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Relay nodes">
        {crossChain.relayNodes.length === 0 ? (
          <EmptyState
            title="No relay nodes"
            body="No relay health records were returned."
          />
        ) : (
          <div className="space-y-3">
            {crossChain.relayNodes.map((node) => (
              <article
                key={node.id}
                className="flex flex-col justify-between gap-2 rounded-xl border border-slate-800 p-4 sm:flex-row sm:items-center"
              >
                <div>
                  <h3 className="font-medium text-white">{node.name}</h3>
                  <p className="mt-1 break-all text-xs text-slate-500">
                    {node.operator}
                  </p>
                </div>
                <p className="text-sm text-slate-400">
                  {node.status} ·{" "}
                  {node.uptime === null
                    ? "uptime unavailable"
                    : `${number(node.uptime)}% uptime`}{" "}
                  · {number(node.successRate ?? 0)}% recorded success ·{" "}
                  {number(node.stakedCollateral)} staked
                </p>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

export default function CrossChainPage() {
  return (
    <PageShell
      title="Cross-Chain Transfers"
      description="Verified chain health, relay registry, and authenticated durable transfer history."
      path="/cross-chain"
    >
      <SessionGate>
        <CrossChainContent />
      </SessionGate>
    </PageShell>
  );
}
