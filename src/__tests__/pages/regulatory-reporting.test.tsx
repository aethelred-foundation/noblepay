import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RegulatoryReportingPage from "@/pages/regulatory-reporting";

const mockUseReportTemplates = jest.fn();
const mockUseReports = jest.fn();
const mockUseGenerateReport = jest.fn();
const mockGenerate = jest.fn();
const mockFetchReport = jest.fn();

jest.mock("@/hooks/useReporting", () => ({
  useReportTemplates: () => mockUseReportTemplates(),
  useReports: () => mockUseReports(),
  useGenerateReport: () => mockUseGenerateReport(),
  fetchRegulatoryReport: (...args: unknown[]) => mockFetchReport(...args),
}));
jest.mock("@/components/SharedComponents", () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
  Modal: ({ open, title, children }: any) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    ) : null,
}));
jest.mock("@/components/ProductionPage", () => ({
  PageShell: ({ title, children }: any) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
  SessionGate: ({ children }: any) => children,
  MetricCard: ({ label, value }: any) => (
    <div>
      {label}: {value}
    </div>
  ),
  Panel: ({ title, action, children }: any) => (
    <section>
      <h2>{title}</h2>
      {action}
      {children}
    </section>
  ),
  LoadingState: ({ label }: any) => <div>{label}</div>,
  ErrorState: ({ error }: any) => <div role="alert">{error.message}</div>,
  EmptyState: ({ title, body }: any) => (
    <div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  ),
}));

const template = {
  id: "template-sar",
  name: "Suspicious Activity Report",
  regulatoryBody: "UAE FIU",
  format: "JSON",
  description: "Tenant suspicious activity evidence",
};
const report = {
  id: "report-1",
  name: "SAR July",
  status: "READY",
  jurisdiction: "AE",
  dateFrom: "2026-07-01T00:00:00Z",
  dateTo: "2026-07-20T23:59:59Z",
  summary: {
    totalTransactions: 10,
    totalVolume: "1000",
    flaggedTransactions: 2,
    sanctionsHits: 0,
  },
};
const query = (data: unknown) => ({
  data,
  isLoading: false,
  isFetching: false,
  error: null,
  refetch: jest.fn(),
});

describe("RegulatoryReportingPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseReportTemplates.mockReturnValue(query([template]));
    mockUseReports.mockReturnValue(query([report]));
    mockGenerate.mockResolvedValue({});
    mockUseGenerateReport.mockReturnValue({
      mutateAsync: mockGenerate,
      isPending: false,
      error: null,
    });
  });

  it("renders generated reports and configured templates", () => {
    render(<RegulatoryReportingPage />);
    expect(screen.getByText("SAR July")).toBeInTheDocument();
    expect(screen.getByText("Suspicious Activity Report")).toBeInTheDocument();
    expect(screen.getByText("UAE FIU")).toBeInTheDocument();
  });

  it("generates an evidence package from a real UTC period", async () => {
    render(<RegulatoryReportingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Generate report" }));
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("To"), {
      target: { value: "2026-07-20" },
    });
    fireEvent.change(screen.getByLabelText("Review notes"), {
      target: { value: "Reviewed by compliance" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Generate from live records" }),
    );
    await waitFor(() =>
      expect(mockGenerate).toHaveBeenCalledWith({
        templateId: "template-sar",
        dateFrom: "2026-07-01T00:00:00.000Z",
        dateTo: "2026-07-20T23:59:59.999Z",
        notes: "Reviewed by compliance",
      }),
    );
  });

  it("renders the authoritative no-report state", () => {
    mockUseReports.mockReturnValue(query([]));
    render(<RegulatoryReportingPage />);
    expect(screen.getByText("No generated reports")).toBeInTheDocument();
  });
});
