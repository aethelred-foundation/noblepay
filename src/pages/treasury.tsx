import { FormEvent, useState } from "react";
import { formatBaseUnits, groupDigits } from "@/lib/fixed-point";
import { useTreasury } from "@/hooks/useTreasury";
import { useTreasuryChain } from "@/hooks/useTreasuryChain";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

const money = (value: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);

const NATIVE_DECIMALS = 18;

const shortHex = (value: string) =>
  value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

const secondsToHours = (seconds: number) => `${Math.round(seconds / 3600)}h`;

/**
 * On-chain treasury state.
 *
 * Deliberately a separate panel from the records above rather than a
 * replacement for them. The database holds the approval workflow; the contract
 * holds the funds. They answer different questions and can disagree, so the
 * page shows both and says which is which — the page's own banner already
 * warns that a recorded proposal does not move money, and this is what it
 * looks like when you check.
 */
function OnChainTreasuryPanel() {
  const chain = useTreasuryChain();

  if (chain.configured === null) {
    return (
      <Panel title="On-chain treasury">
        <LoadingState label="Reading the treasury contract" />
      </Panel>
    );
  }

  if (chain.configured === false) {
    return (
      <Panel
        title="On-chain treasury"
        description="Contract state, read directly from MultiSigTreasury."
      >
        <EmptyState
          title="No treasury contract configured"
          body="This environment has no MULTISIG_TREASURY_ADDRESS. The records above are the durable workflow only; nothing is settled on chain."
        />
      </Panel>
    );
  }

  const overview = chain.overview;
  if (!overview) return null;

  return (
    <Panel
      title="On-chain treasury"
      description={`Read from ${shortHex(overview.address)} at block ${overview.readAtBlock}. This is contract state, not the recorded ledger above.`}
    >
      {chain.error && (
        <div className="mb-4">
          <ErrorState
            error={chain.error}
            retry={() => void chain.refetch()}
          />
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Contract balance"
          value={`${formatBaseUnits(overview.nativeBalance, NATIVE_DECIMALS)} AETHEL`}
        />
        <MetricCard
          label="Signers on contract"
          value={overview.signerCount}
        />
        <MetricCard
          label="Awaiting approval"
          value={overview.proposalCounts.PENDING}
          tone="warning"
        />
        <MetricCard
          label="Approved, not executed"
          value={overview.proposalCounts.APPROVED}
          tone="success"
        />
      </div>

      <h3 className="mt-6 text-sm font-semibold text-white">Approval matrix</h3>
      <p className="mt-1 text-xs text-amber-200/90">
        The contract compares a proposal&apos;s raw amount against these bounds,
        so they only read as US dollars for a six-decimal, dollar-pegged token
        such as USDC. For any other asset, native AETHEL included, the tier is
        derived from that token&apos;s own base units and does not track the
        value being moved. Bounds are shown in raw units for that reason.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-xs text-slate-400">
              <th className="pb-2 text-left">Tier</th>
              <th className="pb-2 text-left">Amount bound (raw units)</th>
              <th className="pb-2 text-right">Signatures</th>
              <th className="pb-2 text-right">Timelock</th>
            </tr>
          </thead>
          <tbody>
            {overview.tiers.map((tier) => (
              <tr key={tier.tier} className="border-b border-slate-800/60">
                <td className="py-2 text-white">{tier.tier}</td>
                <td className="py-2 text-xs text-slate-300">
                  {tier.tier === "EMERGENCY"
                    ? "any (flagged)"
                    : `${groupDigits(tier.minAmount)} – ${
                        tier.maxAmount === null
                          ? "unbounded"
                          : groupDigits(tier.maxAmount)
                      }`}
                </td>
                <td className="py-2 text-right text-white">
                  {tier.requiredSignatures}
                </td>
                <td className="py-2 text-right text-slate-300">
                  {secondsToHours(tier.timelockSeconds)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-white">
        Proposals on the contract
      </h3>
      {chain.proposals.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="No proposals on chain"
            body="The contract holds no proposals. Records above are workflow only until a signer creates one on chain."
          />
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {chain.proposals.map((proposal) => (
            <article
              key={proposal.proposalId}
              className="rounded-xl border border-slate-800 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-medium text-white">
                  {proposal.description || "(no description)"}
                </h4>
                <span className="text-xs text-slate-400">
                  {proposal.status} · {proposal.tier} tier
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-400">
                {groupDigits(proposal.amount)} raw units to{" "}
                {shortHex(proposal.recipient)}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {proposal.approvalCount} of {proposal.requiredApprovals}{" "}
                approvals
                {proposal.rejectionCount > 0 &&
                  ` · ${proposal.rejectionCount} rejection(s)`}
                {proposal.isEmergency && " · emergency"}
              </p>
            </article>
          ))}
        </div>
      )}

      {chain.budgets.length > 0 && (
        <>
          <h3 className="mt-6 text-sm font-semibold text-white">
            Budgets on the contract
          </h3>
          <div className="mt-3 space-y-3">
            {chain.budgets.map((budget) => (
              <article
                key={budget.budgetId}
                className="rounded-xl border border-slate-800 p-4"
              >
                <div className="flex items-center justify-between gap-4">
                  <h4 className="font-medium text-white">{budget.name}</h4>
                  <span className="text-xs text-slate-400">
                    {budget.category}
                  </span>
                </div>
                <p className="mt-2 text-sm text-slate-400">
                  {groupDigits(budget.spent)} of{" "}
                  {groupDigits(budget.totalAllocation)} spent
                </p>
              </article>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function TreasuryContent() {
  const treasury = useTreasury();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("USDC");
  const [category, setCategory] = useState("");

  if (treasury.isLoading)
    return <LoadingState label="Loading treasury records" />;
  if (treasury.error) {
    return (
      <ErrorState
        error={treasury.error}
        retry={() => void treasury.refetch()}
      />
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await treasury.createProposal({
      title,
      description,
      recipient,
      amount: Number(amount),
      tokenSymbol,
      category,
    });
    setTitle("");
    setDescription("");
    setRecipient("");
    setAmount("");
  };

  return (
    <div className="space-y-6">
      <div
        role="status"
        className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100"
      >
        <p className="font-semibold">Proposals do not move funds</p>
        <p className="mt-1 text-amber-100/80">
          Proposal creation and approval are durable workflows. On-chain
          execution stays disabled until a transaction receipt can be verified.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Recorded currencies"
          value={treasury.overview?.tokenBalances.length || 0}
        />
        <MetricCard
          label="Active strategies"
          value={treasury.overview?.activeStrategies || 0}
          tone="success"
        />
        <MetricCard
          label="Recorded signers"
          value={treasury.overview?.signerCount || 0}
        />
        <MetricCard
          label="Pending approvals"
          value={treasury.overview?.pendingApprovals || 0}
          tone="warning"
        />
      </div>

      <p className="text-xs text-slate-500">
        Allocation amounts are shown in their recorded token units; no fiat AUM
        valuation is inferred without a verified price source. The metrics above
        are the recorded ledger — see the on-chain panel for what the contract
        actually holds.
      </p>

      <OnChainTreasuryPanel />

      <Panel
        title="Create treasury proposal"
        description="Persists a policy-checked approval request for the authenticated business. Execution is a separate, disabled on-chain step."
      >
        {treasury.actionError && (
          <div className="mb-4">
            <ErrorState
              error={treasury.actionError}
              retry={() => void treasury.refetch()}
            />
          </div>
        )}
        <form
          onSubmit={(event) => void submit(event).catch(() => undefined)}
          className="grid gap-4 md:grid-cols-2"
        >
          <Field label="Title" value={title} onChange={setTitle} required />
          <Field
            label="Recipient"
            value={recipient}
            onChange={setRecipient}
            required
          />
          <Field
            label="Amount"
            value={amount}
            onChange={setAmount}
            type="number"
            min="0.01"
            step="0.01"
            required
          />
          <Field
            label="Token"
            value={tokenSymbol}
            onChange={setTokenSymbol}
            required
          />
          <label className="text-sm text-slate-300">
            Spending category
            <select
              required
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            >
              <option value="">Select an active policy</option>
              {treasury.policies
                .filter((policy) => policy.active)
                .map((policy) => (
                  <option key={policy.id} value={policy.name}>
                    {policy.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="md:col-span-2 text-sm text-slate-300">
            Description
            <textarea
              required
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="mt-2 min-h-24 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            />
          </label>
          <button
            disabled={treasury.isMutating || !category}
            className="w-fit rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50"
          >
            {treasury.isMutating ? "Submitting…" : "Create proposal"}
          </button>
        </form>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Spending policies">
          {treasury.policies.length === 0 ? (
            <EmptyState
              title="No spending policies"
              body="The treasury service returned no policy records for this business."
            />
          ) : (
            <div className="space-y-3">
              {treasury.policies.map((policy) => (
                <article
                  key={policy.id}
                  className="rounded-xl border border-slate-800 p-4"
                >
                  <div className="flex items-center justify-between gap-4">
                    <h3 className="font-medium text-white">{policy.name}</h3>
                    <span className="text-xs text-slate-400">
                      {policy.requiredApprovals} approvals
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-400">
                    Daily {money(policy.dailyLimit)} · Monthly{" "}
                    {money(policy.monthlyLimit)}
                  </p>
                </article>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Yield strategies">
          {treasury.strategies.length === 0 ? (
            <EmptyState
              title="No yield strategies"
              body="No active or historical yield strategies were returned."
            />
          ) : (
            <div className="space-y-3">
              {treasury.strategies.map((strategy) => (
                <article
                  key={strategy.id}
                  className="rounded-xl border border-slate-800 p-4"
                >
                  <div className="flex items-center justify-between gap-4">
                    <h3 className="font-medium text-white">
                      {strategy.protocol}
                    </h3>
                    <span className="text-sm font-semibold text-emerald-300">
                      {strategy.apy.toFixed(2)}% APY
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-400">
                    {money(strategy.allocated)} allocated · {strategy.risk} risk
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {money(strategy.earnedToDate)} recorded yield
                  </p>
                </article>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Proposal approvals">
        {treasury.proposals.length === 0 ? (
          <EmptyState
            title="No treasury proposals"
            body="No durable proposal records were returned for this business."
          />
        ) : (
          <div className="space-y-3">
            {treasury.proposals.map((proposal) => (
              <article
                key={proposal.id}
                className="rounded-xl border border-slate-800 p-4"
              >
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div>
                    <h3 className="font-medium text-white">{proposal.title}</h3>
                    <p className="mt-1 text-sm text-slate-400">
                      {proposal.amount === null || !proposal.tokenSymbol
                        ? "Non-monetary proposal"
                        : `${proposal.amount.toLocaleString()} ${proposal.tokenSymbol}`}{" "}
                      · {proposal.votesFor}/{proposal.quorum} approvals
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {proposal.category || "No category"} · {proposal.status}
                    </p>
                  </div>
                  {proposal.status === "Active" ? (
                    <button
                      type="button"
                      disabled={treasury.isMutating}
                      onClick={() =>
                        void treasury
                          .voteOnProposal(proposal.id, true)
                          .catch(() => undefined)
                      }
                      className="rounded-lg border border-emerald-500/30 px-3 py-2 text-sm text-emerald-300 disabled:opacity-50"
                    >
                      Approve proposal
                    </button>
                  ) : proposal.status === "Queued" ? (
                    <span className="text-xs text-amber-300">
                      Execution unavailable
                    </span>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  ...input
}: { label: string; value: string; onChange: (value: string) => void } & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange"
>) {
  return (
    <label className="text-sm text-slate-300">
      {label}
      <input
        {...input}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
      />
    </label>
  );
}

export default function TreasuryPage() {
  return (
    <PageShell
      title="Treasury"
      description="Durable spending controls, recorded allocations, and policy-checked approvals."
      path="/treasury"
    >
      <SessionGate>
        <TreasuryContent />
      </SessionGate>
    </PageShell>
  );
}
