import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useInvoices } from "@/hooks/useInvoices";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

const amount = (value: number, currency: string) =>
  `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value)} ${currency}`;

function InvoiceContent() {
  const { business } = useAuth();
  const invoiceApi = useInvoices(business?.id);
  const [payerAddress, setPayerAddress] = useState("");
  const [payerName, setPayerName] = useState("");
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [currency, setCurrency] = useState("USDC");
  const [dueDays, setDueDays] = useState("30");
  const [description, setDescription] = useState("");
  const [financeInvoiceId, setFinanceInvoiceId] = useState("");
  const [financeAmount, setFinanceAmount] = useState("");
  const [settleInvoiceId, setSettleInvoiceId] = useState("");
  const [settlementReference, setSettlementReference] = useState("");
  const [disputeInvoiceId, setDisputeInvoiceId] = useState("");
  const [disputeReason, setDisputeReason] = useState("");

  const financeableInvoices = useMemo(
    () =>
      invoiceApi.invoices.filter(
        (invoice) =>
          invoice.outstandingAmount > 0 &&
          ["Issued", "Financed"].includes(invoice.status),
      ),
    [invoiceApi.invoices],
  );
  const disputableInvoices = useMemo(
    () =>
      invoiceApi.invoices.filter(
        (invoice) => !["Paid", "WrittenOff"].includes(invoice.status),
      ),
    [invoiceApi.invoices],
  );

  useEffect(() => {
    if (!financeInvoiceId && financeableInvoices[0]) {
      setFinanceInvoiceId(financeableInvoices[0].id);
    }
    if (!settleInvoiceId && financeableInvoices[0]) {
      setSettleInvoiceId(financeableInvoices[0].id);
    }
    if (!disputeInvoiceId && disputableInvoices[0]) {
      setDisputeInvoiceId(disputableInvoices[0].id);
    }
  }, [
    disputableInvoices,
    disputeInvoiceId,
    financeableInvoices,
    financeInvoiceId,
    settleInvoiceId,
  ]);

  if (invoiceApi.isLoading)
    return <LoadingState label="Loading invoice records" />;
  if (invoiceApi.error) {
    return (
      <ErrorState
        error={invoiceApi.error}
        retry={() => void invoiceApi.refetch()}
      />
    );
  }

  const createInvoice = async (event: FormEvent) => {
    event.preventDefault();
    await invoiceApi.createInvoice({
      payerAddress,
      payerName,
      amount: Number(invoiceAmount),
      currency,
      dueInDays: Number(dueDays),
      description,
    });
    setPayerAddress("");
    setPayerName("");
    setInvoiceAmount("");
    setDescription("");
  };
  const finance = async (event: FormEvent) => {
    event.preventDefault();
    await invoiceApi.requestFinancing(financeInvoiceId, Number(financeAmount));
    setFinanceAmount("");
  };
  const settle = async (event: FormEvent) => {
    event.preventDefault();
    await invoiceApi.settleInvoice(settleInvoiceId, settlementReference);
    setSettlementReference("");
  };
  const dispute = async (event: FormEvent) => {
    event.preventDefault();
    await invoiceApi.disputeInvoice(disputeInvoiceId, disputeReason);
    setDisputeReason("");
  };

  return (
    <div className="space-y-6">
      {invoiceApi.actionError && (
        <ErrorState
          error={invoiceApi.actionError}
          retry={() => void invoiceApi.refetch()}
        />
      )}
      {invoiceApi.analyticsError && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100">
          Invoice analytics unavailable: {invoiceApi.analyticsError.message}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Invoices" value={invoiceApi.invoices.length} />
        <MetricCard
          label="Financing requests"
          value={invoiceApi.financingRequests.length}
        />
        <MetricCard
          label="Overdue invoices"
          value={
            invoiceApi.analyticsError
              ? "Unavailable"
              : invoiceApi.analytics?.overdueCount || 0
          }
          tone="danger"
        />
        <MetricCard
          label="Average payment time"
          value={
            invoiceApi.analyticsError
              ? "Unavailable"
              : `${invoiceApi.analytics?.avgDaysToPay || 0} days`
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Create invoice"
          description="Issues a durable receivable for the authenticated, KYC-verified business."
        >
          <form
            onSubmit={(event) =>
              void createInvoice(event).catch(() => undefined)
            }
            className="grid gap-4 sm:grid-cols-2"
          >
            <Field
              label="Payer wallet"
              value={payerAddress}
              onChange={setPayerAddress}
              required
              pattern="0x[a-fA-F0-9]{40}"
            />
            <Field
              label="Payer name"
              value={payerName}
              onChange={setPayerName}
              required
            />
            <Field
              label="Amount"
              value={invoiceAmount}
              onChange={setInvoiceAmount}
              type="number"
              min="0.01"
              step="0.01"
              required
            />
            <Field
              label="Currency"
              value={currency}
              onChange={setCurrency}
              required
              pattern="[A-Z0-9]{2,10}"
            />
            <Field
              label="Due in days"
              value={dueDays}
              onChange={setDueDays}
              type="number"
              min="1"
              max="1098"
              required
            />
            <label className="sm:col-span-2 text-sm text-slate-300">
              Description
              <textarea
                required
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="mt-2 min-h-24 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
              />
            </label>
            <button
              disabled={invoiceApi.isMutating}
              className="w-fit rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50"
            >
              Create invoice
            </button>
          </form>
        </Panel>

        <Panel
          title="Request financing"
          description="A request is recorded only after the configured financing gateway returns a verified reference."
        >
          {financeableInvoices.length === 0 ? (
            <EmptyState
              title="No invoice to finance"
              body="An issued invoice with an outstanding balance is required."
            />
          ) : (
            <form
              onSubmit={(event) => void finance(event).catch(() => undefined)}
              className="space-y-4"
            >
              <InvoiceSelect
                label="Invoice"
                value={financeInvoiceId}
                onChange={setFinanceInvoiceId}
                invoices={financeableInvoices}
              />
              <Field
                label="Financing amount"
                value={financeAmount}
                onChange={setFinanceAmount}
                type="number"
                min="0.01"
                step="0.01"
                required
              />
              <button
                disabled={invoiceApi.isMutating}
                className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50"
              >
                Request financing
              </button>
            </form>
          )}
        </Panel>
      </div>

      <Panel title="Invoices">
        {invoiceApi.invoices.length === 0 ? (
          <EmptyState
            title="No invoices"
            body="The invoice service returned no receivables for this business."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-3">Invoice</th>
                  <th>Payer</th>
                  <th>Face value</th>
                  <th>Outstanding</th>
                  <th>Financed</th>
                  <th>Due</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {invoiceApi.invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="py-4 font-medium text-white">
                      {invoice.invoiceNumber}
                    </td>
                    <td>{invoice.payerName || invoice.payer}</td>
                    <td>{amount(invoice.amount, invoice.currency)}</td>
                    <td>
                      {amount(invoice.outstandingAmount, invoice.currency)}
                    </td>
                    <td>{amount(invoice.financedAmount, invoice.currency)}</td>
                    <td>{new Date(invoice.dueAt).toLocaleDateString()}</td>
                    <td>{invoice.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel
          title="Verified settlement"
          description="Settlement changes only after the gateway verifies the supplied reference, amount, and currency."
        >
          {financeableInvoices.length === 0 ? (
            <EmptyState
              title="No invoice to settle"
              body="No issued or financed invoice with an outstanding balance was returned."
            />
          ) : (
            <form
              onSubmit={(event) => void settle(event).catch(() => undefined)}
              className="space-y-4"
            >
              <InvoiceSelect
                label="Invoice to settle"
                value={settleInvoiceId}
                onChange={setSettleInvoiceId}
                invoices={financeableInvoices}
              />
              <Field
                label="Settlement reference"
                value={settlementReference}
                onChange={setSettlementReference}
                required
              />
              <button
                disabled={invoiceApi.isMutating}
                className="rounded-lg border border-emerald-500/30 px-4 py-2 text-sm font-semibold text-emerald-300 disabled:opacity-50"
              >
                Verify settlement
              </button>
            </form>
          )}
        </Panel>
        <Panel
          title="Raise dispute"
          description="Creates an audited durable dispute and places the invoice in disputed status."
        >
          {disputableInvoices.length === 0 ? (
            <EmptyState
              title="No invoice to dispute"
              body="No invoice in a disputable state was returned."
            />
          ) : (
            <form
              onSubmit={(event) => void dispute(event).catch(() => undefined)}
              className="space-y-4"
            >
              <InvoiceSelect
                label="Invoice to dispute"
                value={disputeInvoiceId}
                onChange={setDisputeInvoiceId}
                invoices={disputableInvoices}
              />
              <label className="block text-sm text-slate-300">
                Dispute reason
                <textarea
                  required
                  minLength={10}
                  value={disputeReason}
                  onChange={(event) => setDisputeReason(event.target.value)}
                  className="mt-2 min-h-24 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
                />
              </label>
              <button
                disabled={invoiceApi.isMutating}
                className="rounded-lg border border-red-500/30 px-4 py-2 text-sm font-semibold text-red-300 disabled:opacity-50"
              >
                Raise dispute
              </button>
            </form>
          )}
        </Panel>
      </div>

      <Panel title="Financing history">
        {invoiceApi.financingRequests.length === 0 ? (
          <EmptyState
            title="No financing requests"
            body="No durable financing gateway receipts were returned."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-3">Request</th>
                  <th>Invoice</th>
                  <th>Amount</th>
                  <th>Net proceeds</th>
                  <th>Term</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {invoiceApi.financingRequests.map((request) => {
                  const invoice = invoiceApi.invoices.find(
                    (item) => item.id === request.invoiceId,
                  );
                  const unit = invoice?.currency || "USD";
                  return (
                    <tr key={request.id}>
                      <td className="py-4 font-mono text-xs text-white">
                        {request.id}
                      </td>
                      <td>{request.invoiceId}</td>
                      <td>{amount(request.amount, unit)}</td>
                      <td>
                        {request.netProceeds === null
                          ? "Unavailable"
                          : amount(request.netProceeds, unit)}
                      </td>
                      <td>{request.termDays} days</td>
                      <td>{request.status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Credit score">
          {invoiceApi.creditScore ? (
            <div>
              <p className="text-4xl font-semibold text-white">
                {invoiceApi.creditScore.score ?? "Unrated"}
              </p>
              <p className="mt-2 text-sm text-slate-400">
                Grade {invoiceApi.creditScore.grade} ·{" "}
                {invoiceApi.creditScore.sampleSize} observed invoices
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {invoiceApi.creditScore.methodology} · updated{" "}
                {new Date(invoiceApi.creditScore.updatedAt).toLocaleString()}
              </p>
            </div>
          ) : (
            <EmptyState
              title="No credit score"
              body="The business credit-score endpoint returned no record."
            />
          )}
        </Panel>
        <Panel title="Recorded values by currency">
          {!invoiceApi.analytics ||
          Object.keys(invoiceApi.analytics.byCurrency).length === 0 ? (
            <EmptyState
              title="No currency totals"
              body="No invoice values were available."
            />
          ) : (
            <div className="space-y-3">
              {Object.entries(invoiceApi.analytics.byCurrency).map(
                ([unit, totals]) => (
                  <article
                    key={unit}
                    className="flex items-center justify-between border-b border-slate-800 pb-3 last:border-0"
                  >
                    <div>
                      <p className="font-medium text-white">{unit}</p>
                      <p className="text-xs text-slate-500">
                        {totals.count} invoices
                      </p>
                    </div>
                    <p className="text-right text-sm text-slate-300">
                      {amount(totals.total, unit)} total
                      <br />
                      {amount(totals.financed, unit)} financed
                    </p>
                  </article>
                ),
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function InvoiceSelect({
  label,
  value,
  onChange,
  invoices,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  invoices: ReturnType<typeof useInvoices>["invoices"];
}) {
  return (
    <label className="block text-sm text-slate-300">
      {label}
      <select
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
      >
        {invoices.map((invoice) => (
          <option key={invoice.id} value={invoice.id}>
            {invoice.invoiceNumber} ·{" "}
            {amount(invoice.outstandingAmount, invoice.currency)} outstanding
          </option>
        ))}
      </select>
    </label>
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

export default function InvoiceFinancingPage() {
  return (
    <PageShell
      title="Invoice Financing"
      description="Durable receivables, verified financing receipts, disputes, and settlement status."
      path="/invoice-financing"
    >
      <SessionGate>
        <InvoiceContent />
      </SessionGate>
    </PageShell>
  );
}
