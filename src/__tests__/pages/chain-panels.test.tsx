/**
 * Page-level tests for the on-chain panels added to the treasury and FX pages.
 *
 * These cover the labelling, not the plumbing — the hooks are tested
 * separately. What is asserted here is that the page cannot silently present
 * contract state as though it were the recorded ledger, and cannot present an
 * unknown as a reassurance. Those are the two ways this screen could mislead
 * an operator, and neither is caught by a test that only checks data arrives.
 */

import { render, screen } from "@testing-library/react";

import FXPage from "@/pages/fx-hedging";
import TreasuryPage from "@/pages/treasury";

const mockUseTreasury = jest.fn();
const mockUseTreasuryChain = jest.fn();
const mockUseFX = jest.fn();
const mockUseFXChain = jest.fn();

jest.mock("@/hooks/useTreasury", () => ({ useTreasury: () => mockUseTreasury() }));
jest.mock("@/hooks/useTreasuryChain", () => ({
  useTreasuryChain: () => mockUseTreasuryChain(),
}));
jest.mock("@/hooks/useFX", () => ({ useFX: () => mockUseFX() }));
jest.mock("@/hooks/useFXChain", () => ({ useFXChain: () => mockUseFXChain() }));

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
  Panel: ({ title, description, children }: any) => (
    <section>
      <h2>{title}</h2>
      {description && <p>{description}</p>}
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

const ledgerTreasury = {
  isLoading: false,
  error: null,
  actionError: null,
  isMutating: false,
  overview: {
    tokenBalances: [],
    activeStrategies: 0,
    signerCount: 0,
    pendingApprovals: 0,
  },
  policies: [],
  strategies: [],
  proposals: [],
  createProposal: jest.fn(),
  refetch: jest.fn(),
};

// Every field fx-hedging.tsx reads. An incomplete fixture fails inside the
// page rather than in the assertion, which makes the real failure hard to see.
const ledgerFX = {
  isLoading: false,
  error: null,
  oracleError: null,
  ratesLoading: false,
  mutationReason: "Execution disabled",
  exposure: null,
  rates: [],
  hedges: [],
  refetch: jest.fn(),
};

const chainTreasuryConfigured = {
  configured: true,
  overview: {
    address: "0xf87ea237cca6f4c932f13983f7df05c0b842b128",
    nativeBalance: "5000000000000000000",
    signers: [],
    signerCount: 3,
    thresholds: { small: 1, medium: 2, large: 3, emergency: 2 },
    tiers: [
      {
        tier: "SMALL",
        minAmount: "0",
        maxAmount: "10000000000",
        requiredSignatures: 1,
        timelockSeconds: 86400,
      },
    ],
    proposalCounts: {
      PENDING: 1,
      APPROVED: 0,
      EXECUTED: 0,
      REJECTED: 0,
      CANCELLED: 0,
      EXPIRED: 0,
    },
    activeBudgets: 0,
    amountBasis: "RAW_TOKEN_BASE_UNITS_COMPARED_AGAINST_USD6_THRESHOLDS",
    readAtBlock: "4242",
  },
  proposals: [],
  budgets: [],
  amountBasis: "RAW_TOKEN_BASE_UNITS_COMPARED_AGAINST_USD6_THRESHOLDS",
  readAtBlock: "4242",
  isLoading: false,
  error: null,
  refetch: jest.fn(),
};

const chainFXEmpty = {
  configured: true,
  pairs: [],
  rateDecimals: 8,
  settlementFeeBps: 25,
  positions: [],
  portfolio: null,
  underMargined: [],
  marginUnknown: [],
  adverselyClosed: [],
  isLoading: false,
  error: null,
  refetch: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUseTreasury.mockReturnValue(ledgerTreasury);
  mockUseFX.mockReturnValue(ledgerFX);
  mockUseTreasuryChain.mockReturnValue(chainTreasuryConfigured);
  mockUseFXChain.mockReturnValue(chainFXEmpty);
});

describe("treasury page — on-chain panel", () => {
  it("names the panel so contract state is not read as the ledger", () => {
    render(<TreasuryPage />);
    expect(screen.getByText("On-chain treasury")).toBeInTheDocument();
  });

  it("states the address and block the snapshot came from", () => {
    render(<TreasuryPage />);
    expect(screen.getByText(/at block 4242/)).toBeInTheDocument();
  });

  it("warns that tier bounds are not dollars for most assets", () => {
    // NP-TREASURY-01. Without this the operator reads "0 – 10,000,000,000" as
    // a dollar band, which is only true for a six-decimal pegged token.
    render(<TreasuryPage />);
    expect(
      screen.getByText(/only read as US dollars for a six-decimal/i),
    ).toBeInTheDocument();
  });

  it("labels the amount column as raw units, not currency", () => {
    render(<TreasuryPage />);
    expect(screen.getByText(/Amount bound \(raw units\)/)).toBeInTheDocument();
  });

  it("distinguishes 'still loading' from 'no treasury deployed'", () => {
    mockUseTreasuryChain.mockReturnValue({
      ...chainTreasuryConfigured,
      configured: null,
      overview: null,
    });
    render(<TreasuryPage />);
    expect(screen.getByText("Reading the treasury contract")).toBeInTheDocument();
    expect(
      screen.queryByText("No treasury contract configured"),
    ).not.toBeInTheDocument();
  });

  it("says plainly when no contract is deployed", () => {
    mockUseTreasuryChain.mockReturnValue({
      ...chainTreasuryConfigured,
      configured: false,
      overview: null,
    });
    render(<TreasuryPage />);
    expect(
      screen.getByText("No treasury contract configured"),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing is settled on chain/i)).toBeInTheDocument();
  });
});

describe("FX page — on-chain panel", () => {
  it("names the panel and separates it from recorded exposure", () => {
    render(<FXPage />);
    expect(screen.getByText("On-chain vault")).toBeInTheDocument();
    expect(
      screen.getByText(/Distinct from the recorded exposure above/i),
    ).toBeInTheDocument();
  });

  it("raises an alert for positions below maintenance margin", () => {
    mockUseFXChain.mockReturnValue({
      ...chainFXEmpty,
      underMargined: [{ positionId: "0x1" }],
    });
    render(<FXPage />);
    expect(
      screen.getByText(/1 position below maintenance margin/i),
    ).toBeInTheDocument();
  });

  it("does not present an unevaluated margin check as safe", () => {
    // The distinction this asserts is the whole point of the null: the page
    // must say it does not know, not imply the position is covered.
    mockUseFXChain.mockReturnValue({
      ...chainFXEmpty,
      marginUnknown: [{ positionId: "0x3" }],
    });
    render(<FXPage />);
    expect(
      screen.getByText(/could not be margin checked/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/it is a statement that we do not know/i),
    ).toBeInTheDocument();
  });

  it("surfaces liquidated positions rather than folding them into 'closed'", () => {
    mockUseFXChain.mockReturnValue({
      ...chainFXEmpty,
      adverselyClosed: [{ positionId: "0x1" }, { positionId: "0x2" }],
    });
    render(<FXPage />);
    expect(
      screen.getByText(/2 positions were liquidated or unwound/i),
    ).toBeInTheDocument();
  });

  it("marks a pair whose oracle has never published", () => {
    mockUseFXChain.mockReturnValue({
      ...chainFXEmpty,
      pairs: [
        {
          pairId: "0xp",
          base: "AED",
          quote: "USD",
          active: true,
          maxHedgeRatioBps: 10000,
          marginRequirementBps: 500,
          maintenanceMarginBps: 300,
          rate: null,
          rateUpdatedAt: null,
        },
      ],
    });
    render(<FXPage />);
    expect(screen.getByText("not published")).toBeInTheDocument();
  });

  it("says plainly when no vault is deployed", () => {
    mockUseFXChain.mockReturnValue({ ...chainFXEmpty, configured: false });
    render(<FXPage />);
    expect(screen.getByText("No FX vault configured")).toBeInTheDocument();
  });
});
