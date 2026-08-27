import { fireEvent, render, screen } from "@testing-library/react";
import AuditPage from "@/pages/audit";

const mockUseAuditEntries = jest.fn();
const mockUseAuditStats = jest.fn();
const mockUseVerifyAuditChain = jest.fn();
const mockUseExportAudit = jest.fn();
const mockVerify = jest.fn();
const mockExport = jest.fn();

jest.mock("@/hooks/useAudit", () => ({
  useAuditEntries: (filters: unknown) => mockUseAuditEntries(filters),
  useAuditStats: () => mockUseAuditStats(),
  useVerifyAuditChain: () => mockUseVerifyAuditChain(),
  useExportAudit: () => mockUseExportAudit(),
}));
jest.mock("@/components/SharedComponents", () => ({
  Badge: ({ children }: any) => <span>{children}</span>,
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

const entriesQuery = {
  data: {
    entries: [
      {
        id: "entry-1",
        severity: "INFO",
        eventType: "PAYMENT_CREATED",
        description: "Payment was created",
        createdAt: "2026-07-21T10:00:00Z",
        entryHash: "hash-1",
        actor: "0xactor",
      },
    ],
    page: 1,
    totalPages: 1,
  },
  isLoading: false,
  error: null,
  refetch: jest.fn(),
};
const statsQuery = {
  data: { totalEntries: 1, last24hCount: 1, last7dCount: 1, chainIntact: true },
  isLoading: false,
  error: null,
  refetch: jest.fn(),
};

describe("AuditPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuditEntries.mockReturnValue(entriesQuery);
    mockUseAuditStats.mockReturnValue(statsQuery);
    mockUseVerifyAuditChain.mockReturnValue({
      mutate: mockVerify,
      isPending: false,
      data: null,
      error: null,
    });
    mockUseExportAudit.mockReturnValue({
      mutate: mockExport,
      isPending: false,
      error: null,
    });
  });

  it("renders canonical tenant events and applies server filters", () => {
    render(<AuditPage />);
    expect(screen.getByText("Payment was created")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter event type"), {
      target: { value: "payment_settled" },
    });
    fireEvent.change(screen.getByLabelText("Filter severity"), {
      target: { value: "HIGH" },
    });
    expect(mockUseAuditEntries).toHaveBeenLastCalledWith({
      page: 1,
      limit: 20,
      eventType: "PAYMENT_SETTLED",
      severity: "HIGH",
    });
  });

  it("runs integrity verification and a real 30-day export", () => {
    render(<AuditPage />);
    fireEvent.click(screen.getByRole("button", { name: "Verify now" }));
    fireEvent.click(screen.getByRole("button", { name: "Export 30 days" }));
    expect(mockVerify).toHaveBeenCalled();
    expect(mockExport).toHaveBeenCalledWith(
      expect.objectContaining({
        from: expect.any(String),
        to: expect.any(String),
      }),
    );
  });

  it("renders the empty canonical ledger state", () => {
    mockUseAuditEntries.mockReturnValue({
      ...entriesQuery,
      data: { entries: [], page: 1, totalPages: 1 },
    });
    render(<AuditPage />);
    expect(screen.getByText("No matching audit events")).toBeInTheDocument();
  });
});
