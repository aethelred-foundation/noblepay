import { render, screen } from "@testing-library/react";
import DashboardPage from "@/pages/index";

const mockUseBusinessProfile = jest.fn();
const mockUseBusinessPaymentLimits = jest.fn();
const mockUsePaymentStats = jest.fn();
const mockUsePayments = jest.fn();
const mockUseComplianceMetrics = jest.fn();
const mockUseComplianceStatus = jest.fn();

jest.mock("@/config/wagmi", () => ({
  activeChain: {
    blockExplorers: { default: { url: "https://explorer.test" } },
  },
}));
jest.mock("@/hooks/useBusiness", () => ({
  useBusinessProfile: () => mockUseBusinessProfile(),
  useBusinessPaymentLimits: () => mockUseBusinessPaymentLimits(),
}));
jest.mock("@/hooks/usePayment", () => ({
  usePaymentStats: () => mockUsePaymentStats(),
  usePayments: (filters: unknown) => mockUsePayments(filters),
}));
jest.mock("@/hooks/useCompliance", () => ({
  useComplianceMetrics: () => mockUseComplianceMetrics(),
  useComplianceStatus: () => mockUseComplianceStatus(),
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
  EmptyState: ({ title, body }: any) => (
    <div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  ),
}));

const query = (data: unknown) => ({
  data,
  isLoading: false,
  error: null,
  refetch: jest.fn(),
});

describe("DashboardPage", () => {
  beforeEach(() => {
    mockUseBusinessProfile.mockReturnValue(
      query({
        businessName: "Acme LLC",
        kycStatus: "VERIFIED",
        tier: "ENTERPRISE",
        jurisdiction: "AE",
        licenseNumber: "LIC-1",
      }),
    );
    mockUseBusinessPaymentLimits.mockReturnValue(
      query({
        daily: { remaining: "900" },
        monthly: { remaining: "9000" },
        tier: "ENTERPRISE",
      }),
    );
    mockUsePaymentStats.mockReturnValue(
      query({
        totalPayments: 1,
        totalVolume: "100",
        last24h: { count: 1, volume: "100" },
      }),
    );
    mockUsePayments.mockReturnValue(
      query({
        payments: [
          {
            id: "p1",
            paymentId: "payment-live-1",
            recipient: "0xrecipient",
            amount: "100",
            currency: "USDC",
            status: "SETTLED",
            txHash: null,
          },
        ],
      }),
    );
    mockUseComplianceMetrics.mockReturnValue(
      query({
        passRate: 1,
        failedScreenings: 0,
        totalScreenings: 1,
        flaggedCount: 0,
        underReviewCount: 0,
      }),
    );
    mockUseComplianceStatus.mockReturnValue(
      query({
        engineStatus: "healthy",
        checkedAt: "2026-07-22T00:00:00.000Z",
        settlementEvidence: "verified_per_submission",
        sanctions: { status: "fresh", totalEntries: 50 },
      }),
    );
  });

  it("renders tenant-scoped operating data", () => {
    render(<DashboardPage />);
    expect(
      screen.getByRole("heading", { name: "Settlement overview" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Acme LLC")).toBeInTheDocument();
    expect(screen.getByText("payment-live-1")).toBeInTheDocument();
    expect(mockUsePayments).toHaveBeenCalledWith({ page: 1, pageSize: 5 });
  });

  it("renders the authoritative empty ledger state", () => {
    mockUsePayments.mockReturnValue(query({ payments: [] }));
    render(<DashboardPage />);
    expect(screen.getByText("No payment history")).toBeInTheDocument();
  });

  it("renders query failures", () => {
    mockUsePaymentStats.mockReturnValue({
      ...query(null),
      error: new Error("stats unavailable"),
    });
    render(<DashboardPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("stats unavailable");
  });
});
