import { render, screen } from "@testing-library/react";
import FXHedgingPage from "@/pages/fx-hedging";

const mockUseFX = jest.fn();

jest.mock("@/hooks/useFX", () => ({ useFX: () => mockUseFX() }));
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

const ready = {
  rates: [
    { pair: "USD/AED", rate: 3.67, bid: 3.66, ask: 3.68, change24h: 0.1 },
  ],
  hedges: [
    {
      id: "hedge-1",
      fromCurrency: "USD",
      toCurrency: "AED",
      notionalAmount: 1000,
      lockedRate: 3.67,
      currentRate: 3.68,
      unrealizedPnl: 10,
      status: "Active",
    },
  ],
  exposure: {
    totalExposure: 1000,
    hedgedPercentage: 60,
    unhedgedExposure: 400,
    valueAtRisk: 20,
    byPair: [{ pair: "USD", exposure: 1000, hedged: 600, unhedged: 400 }],
  },
  isLoading: false,
  ratesLoading: false,
  isMutating: false,
  error: null,
  oracleError: null,
  mutationReason:
    "FX execution is disabled until signed settlement and receipt verification are configured.",
  refetch: jest.fn(),
};

describe("FXHedgingPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseFX.mockReturnValue(ready);
  });

  it("renders verified rates, durable exposure, and positions", () => {
    render(<FXHedgingPage />);
    expect(screen.getAllByText("USD/AED").length).toBeGreaterThan(0);
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("FX execution is read-only")).toBeInTheDocument();
    expect(screen.getByText("Settlement unavailable")).toBeInTheDocument();
  });

  it("does not expose unsupported open or close controls", () => {
    render(<FXHedgingPage />);
    expect(screen.queryByRole("button", { name: /open hedge/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /close hedge/i })).toBeNull();
  });

  it("renders empty states without generated market data", () => {
    mockUseFX.mockReturnValue({
      ...ready,
      rates: [],
      hedges: [],
      exposure: null,
    });
    render(<FXHedgingPage />);
    expect(screen.getByText("No FX rates")).toBeInTheDocument();
    expect(screen.getByText("No hedge positions")).toBeInTheDocument();
  });

  it("keeps durable records visible when the oracle is unavailable", () => {
    mockUseFX.mockReturnValue({
      ...ready,
      rates: [],
      oracleError: new Error("oracle unavailable"),
    });
    render(<FXHedgingPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("oracle unavailable");
    expect(screen.getByText("Settlement unavailable")).toBeInTheDocument();
  });
});
