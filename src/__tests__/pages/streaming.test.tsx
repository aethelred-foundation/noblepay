import { render, screen } from "@testing-library/react";
import StreamingPage from "@/pages/streaming";

const mockUseStreaming = jest.fn();
jest.mock("@/hooks/useStreaming", () => ({
  useStreaming: (address: string) => mockUseStreaming(address),
}));
jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({
    wallet: { address: "0x1111111111111111111111111111111111111111" },
  }),
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

const state = {
  streams: [
    {
      id: "stream-1",
      sender: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      tokenSymbol: "USDC",
      totalAmount: 100,
      streamedAmount: 60,
      ratePerSecond: 1,
      startTime: 0,
      endTime: 1000,
      status: "Active",
      cancelable: false,
      lastWithdrawal: null,
    },
  ],
  balances: new Map([
    [
      "stream-1",
      {
        streamId: "stream-1",
        withdrawable: 55,
        remaining: 40,
        deposited: 100,
        withdrawn: 5,
        snapshotAt: 0,
      },
    ],
  ]),
  analytics: {
    totalActiveStreams: 1,
    totalStreamedValue: 60,
    totalRemainingValue: 40,
    incomingStreams: 0,
    outgoingStreams: 1,
    avgStreamDuration: 1,
  },
  isLoading: false,
  error: null,
  refetch: jest.fn(),
  mutationsEnabled: false,
  mutationReason: "Receipt verification is not configured.",
};

describe("StreamingPage", () => {
  beforeEach(() => mockUseStreaming.mockReturnValue(state));

  it("renders tenant stream terms and calculated balance as read-only", () => {
    render(<StreamingPage />);

    expect(mockUseStreaming).toHaveBeenCalledWith(
      "0x1111111111111111111111111111111111111111",
    );
    expect(screen.getByText("USDC stream")).toBeInTheDocument();
    expect(screen.getByText(/55 withdrawable/)).toBeInTheDocument();
    expect(
      screen.getByText(/Read-only until receipt verification/),
    ).toBeInTheDocument();
  });

  it("removes all nonfunctional mutation controls", () => {
    render(<StreamingPage />);
    expect(
      screen.queryByRole("button", { name: /create/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /pause/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /cancel/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Receipt verification is not configured/),
    ).toBeInTheDocument();
  });

  it("renders an empty durable ledger without fixtures", () => {
    mockUseStreaming.mockReturnValue({
      ...state,
      streams: [],
      balances: new Map(),
    });
    render(<StreamingPage />);
    expect(screen.getByText("No payment streams")).toBeInTheDocument();
  });
});
