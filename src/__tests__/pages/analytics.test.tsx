import { render, screen } from "@testing-library/react";
import AnalyticsPage from "@/pages/analytics";

const mockUsePaymentStats = jest.fn();
const mockUseComplianceMetrics = jest.fn();
const mockUseAuditStats = jest.fn();

jest.mock("@/hooks/usePayment", () => ({
  usePaymentStats: () => mockUsePaymentStats(),
}));
jest.mock("@/hooks/useCompliance", () => ({
  useComplianceMetrics: () => mockUseComplianceMetrics(),
}));
jest.mock("@/hooks/useAudit", () => ({
  useAuditStats: () => mockUseAuditStats(),
}));
jest.mock("@/components/ProductionPage", () => ({
  PageShell: ({ title, children }: any) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
  SessionGate: ({ children }: any) => children,
  MetricCard: ({ label, value, detail }: any) => (
    <div>
      {label}: {value} {detail}
    </div>
  ),
  Panel: ({ title, children }: any) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  LoadingState: ({ label }: any) => <div>{label}</div>,
  ErrorState: ({ error }: any) => <div role="alert">{error.message}</div>,
}));

const query = (data: unknown) => ({
  data,
  isLoading: false,
  error: null,
  refetch: jest.fn(),
});

describe("AnalyticsPage", () => {
  beforeEach(() => {
    mockUsePaymentStats.mockReturnValue(
      query({
        totalVolume: "1000",
        totalPayments: 4,
        averageAmount: "250",
        last7d: { volume: "500", count: 2 },
        byCurrency: {
          USDC: { volume: "700", count: 3 },
          USDT: { volume: "300", count: 1 },
        },
        byStatus: { SETTLED: 3, FLAGGED: 1 },
      }),
    );
    mockUseComplianceMetrics.mockReturnValue(
      query({
        passRate: 0.75,
        failedScreenings: 1,
        averageScreeningDuration: 42,
        averageRiskScore: 18,
        underReviewCount: 1,
      }),
    );
    mockUseAuditStats.mockReturnValue(
      query({
        totalEntries: 8,
        chainIntact: true,
        byEventType: { PAYMENT_CREATED: 4, PAYMENT_SETTLED: 3 },
      }),
    );
  });

  it("renders persisted payment, compliance, and audit aggregates", () => {
    render(<AnalyticsPage />);
    expect(screen.getByText("USDC")).toBeInTheDocument();
    expect(screen.getByText("SETTLED")).toBeInTheDocument();
    expect(screen.getByText("PAYMENT_CREATED")).toBeInTheDocument();
    expect(screen.getByText(/Screening pass rate: 75.0%/)).toBeInTheDocument();
  });

  it("renders honest empty aggregate states", () => {
    mockUsePaymentStats.mockReturnValue(
      query({
        totalVolume: "0",
        totalPayments: 0,
        averageAmount: "0",
        last7d: { volume: "0", count: 0 },
        byCurrency: {},
        byStatus: {},
      }),
    );
    mockUseAuditStats.mockReturnValue(
      query({ totalEntries: 0, chainIntact: false, byEventType: {} }),
    );
    render(<AnalyticsPage />);
    expect(screen.getByText("No verified volume yet.")).toBeInTheDocument();
    expect(screen.getByText("No audit events yet.")).toBeInTheDocument();
  });

  it("renders service failures", () => {
    mockUseAuditStats.mockReturnValue({
      ...query(null),
      error: new Error("audit stats offline"),
    });
    render(<AnalyticsPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("audit stats offline");
  });
});
