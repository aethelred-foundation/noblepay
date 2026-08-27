import { render, screen } from "@testing-library/react";
import LiquidityPage from "@/pages/liquidity";

const mockUseLiquidity = jest.fn();
jest.mock("@/hooks/useLiquidity", () => ({
  useLiquidity: () => mockUseLiquidity(),
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
  pools: [
    {
      address: "pool-1",
      name: "USDC/USDT",
      tokenA: "USDC",
      tokenB: "USDT",
      tvl: 1990,
      volume24h: 250,
      apy: null,
      feeBps: 30,
      status: "Active",
      reserveA: 1000,
      reserveB: 990,
      lpCount: 1,
      createdAt: 0,
    },
  ],
  positions: [
    {
      id: "position-1",
      poolAddress: "pool-1",
      poolName: "USDC/USDT",
      lpTokens: 199,
      poolShare: 10,
      valueUsd: null,
      unclaimedFees: 1.5,
      impermanentLoss: null,
      enteredAt: 0,
    },
  ],
  analytics: {
    totalTvl: 1990,
    totalVolume24h: 250,
    totalPools: 1,
    avgApy: null,
    totalFeesEarned24h: 3.5,
  },
  isLoading: false,
  error: null,
  refetch: jest.fn(),
  mutationsEnabled: false,
  mutationReason: "Receipt verification is not configured.",
};

describe("LiquidityPage", () => {
  beforeEach(() => mockUseLiquidity.mockReturnValue(state));

  it("renders durable snapshots and unavailable metrics honestly", () => {
    render(<LiquidityPage />);

    expect(screen.getAllByText("USDC/USDT")).toHaveLength(2);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.getByText(/199 liquidity units/)).toBeInTheDocument();
    expect(
      screen.getByText(/Receipt verification is not configured/),
    ).toBeInTheDocument();
  });

  it("exposes no functional liquidity write control", () => {
    render(<LiquidityPage />);

    expect(screen.queryByText(/Add liquidity/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/amount/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /removal/i })).toBeNull();
    expect(screen.getByText("Removal unavailable")).toBeInTheDocument();
  });

  it("renders an authoritative empty state instead of samples", () => {
    mockUseLiquidity.mockReturnValue({ ...state, pools: [], positions: [] });
    render(<LiquidityPage />);
    expect(screen.getByText("No pool records")).toBeInTheDocument();
    expect(screen.getByText("No liquidity positions")).toBeInTheDocument();
  });
});
