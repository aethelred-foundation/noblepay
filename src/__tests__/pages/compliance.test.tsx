import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CompliancePage from "@/pages/compliance";

const mockUseComplianceStatus = jest.fn();
const mockUseComplianceMetrics = jest.fn();
const mockUseSanctionsListStatus = jest.fn();
const mockUseFlaggedPayments = jest.fn();
const mockUseReviewFlaggedPayment = jest.fn();
const mockReview = jest.fn();

jest.mock("@/hooks/useCompliance", () => ({
  useComplianceStatus: () => mockUseComplianceStatus(),
  useComplianceMetrics: () => mockUseComplianceMetrics(),
  useSanctionsListStatus: () => mockUseSanctionsListStatus(),
  useFlaggedPayments: () => mockUseFlaggedPayments(),
  useReviewFlaggedPayment: () => mockUseReviewFlaggedPayment(),
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

const query = (data: unknown) => ({
  data,
  isLoading: false,
  isFetching: false,
  error: null,
  refetch: jest.fn(),
});
const flaggedPayment = {
  id: "record-1",
  paymentId: "payment-flagged-1",
  sender: "0x1111111111111111111111111111111111111111",
  amount: "500",
  currency: "USDC",
  riskScore: 82,
};

describe("CompliancePage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseComplianceStatus.mockReturnValue(
      query({
        engineStatus: "healthy",
        checkedAt: "2026-07-22T00:00:00.000Z",
        settlementEvidence: "verified_per_submission",
      }),
    );
    mockUseComplianceMetrics.mockReturnValue(
      query({
        totalScreenings: 5,
        passedScreenings: 4,
        failedScreenings: 1,
        passRate: 0.8,
        averageRiskScore: 20,
      }),
    );
    mockUseSanctionsListStatus.mockReturnValue(
      query({
        status: "fresh",
        lastUpdated: "2026-07-21T00:00:00Z",
        totalEntries: 100,
        listsLoaded: ["OFAC"],
      }),
    );
    mockUseFlaggedPayments.mockReturnValue(
      query({ payments: [flaggedPayment], total: 1 }),
    );
    mockReview.mockResolvedValue({});
    mockUseReviewFlaggedPayment.mockReturnValue({
      mutateAsync: mockReview,
      isPending: false,
      error: null,
    });
  });

  it("renders verified service health, sanctions, and flagged records", () => {
    render(<CompliancePage />);
    expect(screen.getByText("Live health check passed")).toBeInTheDocument();
    expect(screen.getByText("OFAC")).toBeInTheDocument();
    expect(screen.getByText(/payment-flag/)).toBeInTheDocument();
  });

  it("submits a tenant-scoped manual review", async () => {
    render(<CompliancePage />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.queryByLabelText("Decision")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Verified source" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Escalate for governed resolution" }),
    );
    await waitFor(() =>
      expect(mockReview).toHaveBeenCalledWith({
        paymentId: "record-1",
        decision: "escalate",
        reason: "Verified source",
      }),
    );
  });

  it("renders the real empty review queue", () => {
    mockUseFlaggedPayments.mockReturnValue(query({ payments: [], total: 0 }));
    render(<CompliancePage />);
    expect(screen.getByText("No payments awaiting review")).toBeInTheDocument();
  });
});
