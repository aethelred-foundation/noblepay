import { act, fireEvent, render, screen } from "@testing-library/react";
import RiskMonitorPage from "@/pages/risk-monitor";

const mockUseComplianceMetrics = jest.fn();
const mockUseFlaggedPayments = jest.fn();
const mockUseWebSocket = jest.fn();
const mockSubscribe = jest.fn();
const mockReconnect = jest.fn();
const mockCallbacks: Record<string, (event: any) => void> = {};

jest.mock("@/hooks/useCompliance", () => ({
  useComplianceMetrics: () => mockUseComplianceMetrics(),
  useFlaggedPayments: () => mockUseFlaggedPayments(),
}));
jest.mock("@/hooks/useWebSocket", () => ({
  useWebSocket: () => mockUseWebSocket(),
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

const query = (data: unknown) => ({
  data,
  isLoading: false,
  error: null,
  refetch: jest.fn(),
});

describe("RiskMonitorPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockCallbacks).forEach((key) => delete mockCallbacks[key]);
    mockUseComplianceMetrics.mockReturnValue(
      query({ averageRiskScore: 22, flaggedCount: 1, underReviewCount: 1 }),
    );
    mockUseFlaggedPayments.mockReturnValue(
      query({
        payments: [
          {
            id: "flag-1",
            paymentId: "payment-risk-1",
            riskScore: 82,
            amount: "10",
            currency: "USDC",
          },
        ],
      }),
    );
    mockSubscribe.mockImplementation(
      (channel: string, callback: (event: any) => void) => {
        mockCallbacks[channel] = callback;
        return jest.fn();
      },
    );
    mockUseWebSocket.mockReturnValue({
      connectionState: "connected",
      subscribe: mockSubscribe,
      reconnect: mockReconnect,
    });
  });

  it("subscribes to authenticated risk channels and renders persisted flags", () => {
    render(<RiskMonitorPage />);
    expect(mockSubscribe).toHaveBeenCalledWith("risk", expect.any(Function));
    expect(mockSubscribe).toHaveBeenCalledWith("alerts", expect.any(Function));
    expect(mockSubscribe).toHaveBeenCalledWith(
      "compliance",
      expect.any(Function),
    );
    expect(screen.getByText("payment-risk-1")).toBeInTheDocument();
    expect(screen.getByText("No live risk events")).toBeInTheDocument();
  });

  it("renders a server WebSocket event without generating alerts", () => {
    render(<RiskMonitorPage />);
    act(() =>
      mockCallbacks.risk({
        type: "risk_update",
        channel: "risk",
        payload: { score: 91 },
        timestamp: "2026-07-21T10:00:00Z",
        correlationId: "corr-1",
      }),
    );
    expect(screen.getByText("risk_update")).toBeInTheDocument();
    expect(screen.getByText(/"score": 91/)).toBeInTheDocument();
  });

  it("offers a real reconnect while preserving persisted evidence", () => {
    mockUseWebSocket.mockReturnValue({
      connectionState: "disconnected",
      subscribe: mockSubscribe,
      reconnect: mockReconnect,
    });
    render(<RiskMonitorPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(mockReconnect).toHaveBeenCalled();
    expect(
      screen.getByText(
        /persisted compliance records above remain authoritative/i,
      ),
    ).toBeInTheDocument();
  });
});
