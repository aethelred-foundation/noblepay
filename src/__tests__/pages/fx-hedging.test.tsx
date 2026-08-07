/**
 * Tests for the FX hedging desk.
 *
 * The previous suite rendered a page that generated its own rates and hedges,
 * then asserted those appeared. These drive the page through mocked hook state
 * and cover what a hedging desk has to get right: the forward-versus-option
 * distinction, maturity gating on settlement, margin warnings, and refusing to
 * imply a hedge ratio the contract cannot compute.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

jest.mock("recharts", () => {
  const R = require("react");
  const stub =
    (name: string) =>
    ({ children }: any) =>
      R.createElement("div", { "data-chart": name }, children);
  return new Proxy({}, { get: (_t, p: string) => (p === "__esModule" ? true : stub(p)) });
});

jest.mock("@/components/SEOHead", () => ({ SEOHead: () => null }));

jest.mock("@/components/SharedComponents", () => ({
  TopNav: () => <nav data-testid="top-nav" />,
  Footer: () => <footer data-testid="footer" />,
  Modal: ({ open, title, children, onClose }: any) =>
    open ? (
      <div data-testid="modal" aria-label={title}>
        {title}
        {children}
        <button data-testid="modal-close" onClick={onClose}>
          X
        </button>
      </div>
    ) : null,
  Tabs: ({ tabs, active, onChange }: any) => (
    <div data-testid="tabs">
      {tabs.map((t: any) => (
        <button key={t.id} onClick={() => onChange(t.id)} data-active={active === t.id}>
          {t.label}
        </button>
      ))}
    </div>
  ),
}));

jest.mock("@/components/PagePrimitives", () => ({
  GlassCard: ({ children, className }: any) => <div className={className}>{children}</div>,
  SectionHeader: ({ title, subtitle }: any) => (
    <div>
      <h2>{title}</h2>
      {subtitle && <p>{subtitle}</p>}
    </div>
  ),
}));

jest.mock("@/config/chains", () => ({
  activeChain: { id: 7332 },
  CONTRACT_ADDRESSES: {
    fxHedgingVault: "0xe7c2a73131dd48d8ac46dcd7ab80c8cbee5b410a",
    usdcToken: "0x65007c1351d9fbb88d49533c843cb1ef589557fe",
  },
}));

const mockUseAccount = jest.fn();
jest.mock("wagmi", () => ({ useAccount: () => mockUseAccount() }));

const mockCreateForward = jest.fn();
const mockCreateOption = jest.fn();
const mockSettleForward = jest.fn();
const mockExerciseOption = jest.fn();
const mockExpireOption = jest.fn();
const mockUpdateMtM = jest.fn();
const mockState: any = {};

jest.mock("@/hooks/useFX", () => {
  const actual = jest.requireActual("@/hooks/useFX");
  return {
    ...actual,
    useFX: () => mockState.fx,
    useRateHistory: () => mockState.history,
    useFXActions: () => ({
      createForward: mockCreateForward,
      createOption: mockCreateOption,
      settleForward: mockSettleForward,
      exerciseOption: mockExerciseOption,
      expireOption: mockExpireOption,
      addMargin: jest.fn(),
      updateMarkToMarket: mockUpdateMtM,
      pending: null,
    }),
  };
});

import FXHedgingPage from "@/pages/fx-hedging";

const PAIR_ID = "0xpair1";
const HOUR = 3_600_000;

const pair = (over: Partial<any> = {}) => ({
  pairId: PAIR_ID,
  base: "AED",
  quote: "USD",
  active: true,
  maxHedgeRatioBps: 10_000,
  marginRequirementBps: 500,
  maintenanceMarginBps: 300,
  rate: 27_230_000n,
  rateUpdatedAt: Date.now() - HOUR,
  ...over,
});

const position = (over: Partial<any> = {}) => ({
  positionId: "0xpos1",
  hedger: "0x1111111111111111111111111111111111111111",
  pairId: PAIR_ID,
  hedgeType: 0,
  status: 0,
  notionalAmount: 10_000_00000000n,
  lockedRate: 27_230_000n,
  premium: 0n,
  collateralToken: "0x65007c1351d9fbb88d49533c843cb1ef589557fe",
  collateralAmount: 500_00000000n,
  createdAt: Date.now() - 2 * HOUR,
  maturityDate: Date.now() + 48 * HOUR,
  settledAt: 0,
  settlementAmount: 0n,
  markToMarketValue: 0n,
  lastMtMUpdate: 0,
  underMargined: false,
  ...over,
});

const defaultFX = (over: Partial<any> = {}) => {
  const pairs = over.pairs ?? [pair()];
  const positions = over.positions ?? [position()];
  return {
    pairs,
    pairsById: new Map(pairs.map((p: any) => [p.pairId.toLowerCase(), p])),
    positions,
    portfolio: {
      totalNotional: 10_000_00000000n,
      totalCollateral: 500_00000000n,
      totalPremiumPaid: 0n,
      totalPnL: 0n,
      unrealizedPnL: 0n,
      positionCount: 1,
      lastRebalanced: 0,
    },
    atRisk: [],
    isLoading: false,
    error: null,
    refetch: jest.fn(),
    ...over,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUseAccount.mockReturnValue({ address: "0x1111111111111111111111111111111111111111", isConnected: true });
  mockState.fx = defaultFX();
  mockState.history = { history: [], isLoading: false, error: null };
});

describe("overview", () => {
  it("renders portfolio totals from chain state", () => {
    render(<FXHedgingPage />);
    expect(screen.getByText("Total notional")).toBeInTheDocument();
    expect(screen.getByText(/1 open position/)).toBeInTheDocument();
  });

  it("surfaces a vault read error", () => {
    mockState.fx = defaultFX({ error: new Error("execution reverted") });
    render(<FXHedgingPage />);
    expect(screen.getByText(/Could not read the FX vault/i)).toBeInTheDocument();
  });

  it("warns when positions are below maintenance margin", () => {
    const p = position({ underMargined: true });
    mockState.fx = defaultFX({ positions: [p], atRisk: [p] });
    render(<FXHedgingPage />);
    expect(screen.getByText(/below\s+maintenance margin and can be liquidated/i)).toBeInTheDocument();
  });
});

describe("positions", () => {
  it("renders a position with its pair, notional and locked rate", () => {
    render(<FXHedgingPage />);
    expect(screen.getByText("AED/USD")).toBeInTheDocument();
    expect(screen.getByText(/notional 10.0K/)).toBeInTheDocument();
  });

  it("disables settlement on a forward before maturity", () => {
    render(<FXHedgingPage />);
    expect(screen.getByRole("button", { name: "Settle" })).toBeDisabled();
  });

  it("enables settlement once the forward has matured", () => {
    mockState.fx = defaultFX({
      positions: [position({ maturityDate: Date.now() - HOUR })],
    });
    render(<FXHedgingPage />);
    expect(screen.getByRole("button", { name: "Settle" })).toBeEnabled();
  });

  it("offers exercise on an option, not settlement", () => {
    mockState.fx = defaultFX({ positions: [position({ hedgeType: 1 })] });
    render(<FXHedgingPage />);
    expect(screen.getByRole("button", { name: "Exercise" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settle" })).not.toBeInTheDocument();
  });

  it("blocks letting an option expire before maturity", () => {
    mockState.fx = defaultFX({ positions: [position({ hedgeType: 2 })] });
    render(<FXHedgingPage />);
    expect(screen.getByRole("button", { name: "Let expire" })).toBeDisabled();
  });

  it("calls settleForward with the position id", () => {
    mockSettleForward.mockResolvedValue("0xhash");
    mockState.fx = defaultFX({
      positions: [position({ maturityDate: Date.now() - HOUR })],
    });
    render(<FXHedgingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Settle" }));
    expect(mockSettleForward).toHaveBeenCalledWith("0xpos1");
  });

  it("explains that positions are per-account when no wallet is connected", () => {
    mockUseAccount.mockReturnValue({ address: undefined, isConnected: false });
    render(<FXHedgingPage />);
    expect(screen.getByText(/No wallet connected/i)).toBeInTheDocument();
  });

  it("shows an empty state when the account has no hedges", () => {
    mockState.fx = defaultFX({ positions: [] });
    render(<FXHedgingPage />);
    expect(screen.getByText(/No hedges yet/i)).toBeInTheDocument();
  });
});

describe("rates", () => {
  const openRates = () => {
    render(<FXHedgingPage />);
    fireEvent.click(screen.getByText(/Rates \(1\)/));
  };

  it("lists configured pairs with margin requirements", () => {
    openRates();
    expect(screen.getByText("0.2723")).toBeInTheDocument();
    expect(screen.getByText("5.00%")).toBeInTheDocument(); // initial margin
    expect(screen.getByText("3.00%")).toBeInTheDocument(); // maintenance
  });

  it("marks a pair whose oracle has never published", () => {
    mockState.fx = defaultFX({ pairs: [pair({ rate: 0n })] });
    render(<FXHedgingPage />);
    fireEvent.click(screen.getByText(/Rates \(1\)/));
    expect(screen.getByText("never")).toBeInTheDocument();
  });

  it("says a single published rate cannot make a line", () => {
    mockState.history = {
      history: [{ rate: 27_230_000n, timestamp: Date.now(), oracle: "0xabc" }],
      isLoading: false,
      error: null,
    };
    openRates();
    expect(screen.getByText(/A line needs a second point/i)).toBeInTheDocument();
  });

  it("explains an empty vault rather than showing nothing", () => {
    mockState.fx = defaultFX({ pairs: [], positions: [] });
    render(<FXHedgingPage />);
    fireEvent.click(screen.getByText(/Rates \(0\)/));
    expect(screen.getByText(/No currency pairs configured/i)).toBeInTheDocument();
  });
});

describe("hedged notional", () => {
  /**
   * The vault records hedged notional and knows nothing about the receivables
   * being hedged. The old page drew a "% of exposure hedged" bar against an
   * invented denominator; this asserts the replacement says so instead.
   */
  it("does not present hedged notional as a hedge ratio", () => {
    render(<FXHedgingPage />);
    fireEvent.click(screen.getByText("Hedged notional"));
    expect(screen.getByText(/not a hedge ratio/i)).toBeInTheDocument();
    expect(screen.getByText(/no view of the underlying/i)).toBeInTheDocument();
  });

  it("totals open positions by pair", () => {
    render(<FXHedgingPage />);
    fireEvent.click(screen.getByText("Hedged notional"));
    expect(screen.getByText("AED/USD")).toBeInTheDocument();
  });
});

describe("new hedge form", () => {
  const openForm = () => {
    render(<FXHedgingPage />);
    fireEvent.click(screen.getByRole("button", { name: /New hedge/i }));
  };

  it("is unavailable when the vault has no pairs", () => {
    mockState.fx = defaultFX({ pairs: [], positions: [] });
    render(<FXHedgingPage />);
    expect(screen.getByRole("button", { name: /New hedge/i })).toBeDisabled();
  });

  it("warns that a forward is an obligation", () => {
    openForm();
    expect(screen.getByText(/obligation, not a right/i)).toBeInTheDocument();
  });

  it("rejects a zero notional before sending a transaction", () => {
    openForm();
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Open hedge/i }));
    expect(screen.getByText(/Notional must be greater than zero/i)).toBeInTheDocument();
    expect(mockCreateForward).not.toHaveBeenCalled();
  });

  it("requires collateral, because positions are margined", () => {
    openForm();
    const inputs = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(inputs[0], { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: /Open hedge/i }));
    expect(screen.getByText(/Collateral must be greater than zero/i)).toBeInTheDocument();
    expect(mockCreateForward).not.toHaveBeenCalled();
  });

  it("converts decimals to the contract's 8-decimal fixed point", () => {
    mockCreateForward.mockResolvedValue("0xhash");
    openForm();
    const inputs = screen.getAllByPlaceholderText("0.00");
    fireEvent.change(inputs[0], { target: { value: "1000" } }); // notional
    fireEvent.change(inputs[1], { target: { value: "50" } }); // collateral
    fireEvent.click(screen.getByRole("button", { name: /Open hedge/i }));
    expect(mockCreateForward).toHaveBeenCalledWith(
      expect.objectContaining({
        notionalAmount: 1000_00000000n,
        collateralAmount: 50_00000000n,
      }),
    );
  });
});
