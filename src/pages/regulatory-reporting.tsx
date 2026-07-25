import { FormEvent, useMemo, useState } from "react";
import { Download, FileCheck2, RefreshCw } from "lucide-react";
import {
  useGenerateReport,
  fetchRegulatoryReport,
  useReports,
  useReportTemplates,
} from "@/hooks/useReporting";
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

function ReportingContent() {
  const templates = useReportTemplates();
  const [page, setPage] = useState(1);
  const reports = useReports(page, 20);
  const generate = useGenerateReport();
  const [open, setOpen] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [notes, setNotes] = useState("");
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const totals = useMemo(() => {
    const values = reports.data ?? [];
    return {
      ready: values.filter((report) => report.status === "READY").length,
      submitted: values.filter(
        (report) =>
          report.status === "SUBMITTED" || report.status === "ACKNOWLEDGED",
      ).length,
      transactions: values.reduce(
        (sum, report) => sum + report.summary.totalTransactions,
        0,
      ),
    };
  }, [reports.data]);

  if (templates.isLoading || reports.isLoading)
    return <LoadingState label="Loading regulatory report records" />;
  if (templates.error)
    return (
      <ErrorState
        error={templates.error}
        retry={() => void templates.refetch()}
      />
    );
  if (reports.error)
    return (
      <ErrorState error={reports.error} retry={() => void reports.refetch()} />
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await generate.mutateAsync({
      templateId,
      dateFrom: new Date(`${dateFrom}T00:00:00.000Z`).toISOString(),
      dateTo: new Date(`${dateTo}T23:59:59.999Z`).toISOString(),
      notes,
    });
    setOpen(false);
    setNotes("");
  };

  const download = async (report: NonNullable<typeof reports.data>[number]) => {
    setDownloadError(null);
    try {
      // List pages intentionally contain summaries only. Retrieve exactly one
      // bounded evidence package before offering it as a download.
      const evidence = await fetchRegulatoryReport(report.id);
      const blob = new Blob([JSON.stringify(evidence, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${report.id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setDownloadError(
        error instanceof Error ? error.message : "Unable to download report",
      );
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Generated reports"
          value={reports.data?.length ?? 0}
        />
        <MetricCard
          label="Ready for review"
          value={totals.ready}
          tone={totals.ready ? "warning" : "neutral"}
        />
        <MetricCard label="Externally submitted" value={totals.submitted} />
        <MetricCard label="Transactions covered" value={totals.transactions} />
      </div>

      <Panel
        title="Generated evidence packages"
        description="Report summaries are calculated from tenant payment and screening records in the requested UTC period."
        action={
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void reports.refetch()}
              className="text-slate-400 hover:text-white"
              aria-label="Refresh reports"
            >
              <RefreshCw
                className={`h-4 w-4 ${reports.isFetching ? "animate-spin" : ""}`}
              />
            </button>
            <button
              type="button"
              onClick={() => {
                setTemplateId(templates.data?.[0]?.id ?? "");
                setOpen(true);
              }}
              disabled={!templates.data?.length}
              className="rounded-lg bg-amber-400 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-40"
            >
              Generate report
            </button>
          </div>
        }
      >
        {!reports.data?.length ? (
          <EmptyState
            title="No generated reports"
            body="Generate a report from persisted tenant records. NoblePay does not pre-populate regulatory filings."
          />
        ) : (
          <div className="space-y-3">
            {reports.data.map((report) => (
              <article
                key={report.id}
                className="rounded-xl border border-slate-800 p-4"
              >
                <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <FileCheck2 className="h-4 w-4 text-amber-400" />
                      <h3 className="font-medium text-white">{report.name}</h3>
                      <Badge
                        variant={
                          report.status === "ACKNOWLEDGED" ||
                          report.status === "SUBMITTED"
                            ? "success"
                            : report.status === "REJECTED"
                              ? "error"
                              : "warning"
                        }
                      >
                        {report.status}
                      </Badge>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      {report.jurisdiction} ·{" "}
                      {new Date(report.dateFrom).toLocaleDateString()}–
                      {new Date(report.dateTo).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void download(report)}
                    className="inline-flex items-center gap-2 text-xs font-semibold text-slate-300 hover:text-white"
                  >
                    <Download className="h-4 w-4" /> JSON evidence
                  </button>
                </div>
                <dl className="mt-4 grid gap-3 border-t border-slate-800 pt-4 text-xs sm:grid-cols-4">
                  <div>
                    <dt className="text-slate-600">Transactions</dt>
                    <dd className="mt-1 font-semibold text-white">
                      {report.summary.totalTransactions}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-600">Volume</dt>
                    <dd className="mt-1 font-semibold text-white">
                      {report.summary.totalVolume}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-600">Flagged</dt>
                    <dd className="mt-1 font-semibold text-white">
                      {report.summary.flaggedTransactions}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-600">Sanctions hits</dt>
                    <dd className="mt-1 font-semibold text-white">
                      {report.summary.sanctionsHits}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-xs text-slate-500">Page {page}</span>
              <button
                type="button"
                disabled={
                  reports.pagination?.totalPages !== undefined
                    ? page >= reports.pagination.totalPages
                    : (reports.data?.length ?? 0) < 20
                }
                onClick={() => setPage((current) => current + 1)}
                className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
        {downloadError && (
          <p role="alert" className="mt-3 text-sm text-red-300">
            {downloadError}
          </p>
        )}
      </Panel>

      <Panel
        title="Available templates"
        description="Configured filing schemas. Final legal review and regulator delivery remain explicit governed steps."
      >
        <div className="grid gap-3 md:grid-cols-2">
          {templates.data?.map((template) => (
            <div
              key={template.id}
              className="rounded-xl border border-slate-800 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-medium text-slate-200">
                    {template.name}
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    {template.regulatoryBody}
                  </p>
                </div>
                <Badge variant="neutral">{template.format}</Badge>
              </div>
              <p className="mt-3 text-xs leading-5 text-slate-500">
                {template.description}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      <Modal
        open={open}
        onClose={() => !generate.isPending && setOpen(false)}
        title="Generate regulatory report"
      >
        <form onSubmit={submit} className="space-y-4">
          <label className="block text-sm text-slate-300">
            Template
            <select
              required
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            >
              {templates.data?.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm text-slate-300">
              From
              <input
                required
                type="date"
                value={dateFrom}
                onChange={(event) => setDateFrom(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
              />
            </label>
            <label className="text-sm text-slate-300">
              To
              <input
                required
                type="date"
                min={dateFrom}
                value={dateTo}
                onChange={(event) => setDateTo(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
              />
            </label>
          </div>
          <label className="block text-sm text-slate-300">
            Review notes
            <textarea
              maxLength={1000}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              className="mt-1 min-h-24 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white"
            />
          </label>
          {generate.error && (
            <p role="alert" className="text-sm text-red-300">
              {generate.error.message}
            </p>
          )}
          <button
            type="submit"
            disabled={generate.isPending}
            className="w-full rounded-lg bg-amber-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-60"
          >
            {generate.isPending
              ? "Calculating report…"
              : "Generate from live records"}
          </button>
        </form>
      </Modal>
    </div>
  );
}

export default function RegulatoryReportingPage() {
  return (
    <PageShell
      title="Regulatory reporting"
      description="Generate reviewable evidence packages from persisted payment and compliance records."
      path="/regulatory-reporting"
    >
      <SessionGate>
        <ReportingContent />
      </SessionGate>
    </PageShell>
  );
}
