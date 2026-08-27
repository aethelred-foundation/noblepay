import { fireEvent, render, screen } from "@testing-library/react";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageShell,
  Panel,
  SessionGate,
} from "@/components/ProductionPage";

const mockSignIn = jest.fn();
let mockWallet = { connected: true, isWrongNetwork: false };
let mockAuth = {
  isAuthenticated: true,
  isCheckingSession: false,
  isSigningIn: false,
  error: null as string | null,
  signIn: mockSignIn,
};

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({ wallet: mockWallet }),
}));
jest.mock("@/contexts/AuthContext", () => ({
  useAuth: () => mockAuth,
}));
jest.mock("@/components/SEOHead", () => ({
  SEOHead: ({ title, path }: any) => (
    <span data-testid="seo" data-title={title} data-path={path} />
  ),
}));
jest.mock("@/components/SharedComponents", () => ({
  TopNav: ({ activePage }: any) => <nav data-active-page={activePage} />,
  Footer: () => <footer>Product footer</footer>,
}));

describe("ProductionPage primitives", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWallet = { connected: true, isWrongNetwork: false };
    mockAuth = {
      isAuthenticated: true,
      isCheckingSession: false,
      isSigningIn: false,
      error: null,
      signIn: mockSignIn,
    };
    mockSignIn.mockResolvedValue(undefined);
  });

  it("renders a complete page shell with metadata and route-aware navigation", () => {
    render(
      <PageShell
        title="Treasury"
        description="Live treasury operations"
        path="/treasury"
        action={<button>Export</button>}
      >
        <p>Verified content</p>
      </PageShell>,
    );

    expect(
      screen.getByRole("heading", { name: "Treasury" }),
    ).toBeInTheDocument();
    expect(screen.getByText("NoblePay operations")).toBeInTheDocument();
    expect(screen.getByText("Live treasury operations")).toBeInTheDocument();
    expect(screen.getByText("Verified content")).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toHaveAttribute(
      "data-active-page",
      "/treasury",
    );
    expect(screen.getByTestId("seo")).toHaveAttribute("data-title", "Treasury");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("Product footer");
  });

  it("requires a connected wallet before exposing protected content", () => {
    mockWallet = { connected: false, isWrongNetwork: false };
    render(
      <SessionGate>
        <p>Private ledger</p>
      </SessionGate>,
    );

    expect(screen.getByText("Connect the business wallet")).toBeInTheDocument();
    expect(screen.queryByText("Private ledger")).not.toBeInTheDocument();
  });

  it("blocks contract reads on the wrong network", () => {
    mockWallet = { connected: true, isWrongNetwork: true };
    render(
      <SessionGate>
        <p>Private ledger</p>
      </SessionGate>,
    );

    expect(
      screen.getByText("Switch to the configured Aethelred network"),
    ).toBeInTheDocument();
  });

  it("shows session verification while the server cookie is checked", () => {
    mockAuth = { ...mockAuth, isCheckingSession: true };
    render(<SessionGate>Private ledger</SessionGate>);

    expect(
      screen.getByText("Checking the signed wallet session"),
    ).toBeInTheDocument();
  });

  it("requests an off-chain wallet signature and surfaces authentication errors", () => {
    mockAuth = {
      ...mockAuth,
      isAuthenticated: false,
      error: "Challenge expired",
    };
    render(<SessionGate>Private ledger</SessionGate>);

    fireEvent.click(
      screen.getByRole("button", { name: /Sign in with wallet/ }),
    );
    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Challenge expired");
    expect(screen.queryByText("Private ledger")).not.toBeInTheDocument();
  });

  it("exposes protected content only to an authenticated business", () => {
    render(<SessionGate>Private ledger</SessionGate>);
    expect(screen.getByText("Private ledger")).toBeInTheDocument();
  });

  it("renders loading, retry, empty-action, metric, and panel states", () => {
    const retry = jest.fn();
    render(
      <>
        <LoadingState />
        <ErrorState error={new Error("Gateway unavailable")} retry={retry} />
        <EmptyState
          title="No records"
          body="Nothing has been verified."
          href="/payments"
          action="Create payment"
        />
        <MetricCard
          label="Settled"
          value={7}
          detail="Live records"
          tone="success"
        />
        <Panel
          title="Evidence"
          description="Canonical results"
          action={<button>Refresh</button>}
        >
          Audit data
        </Panel>
      </>,
    );

    expect(screen.getByText("Loading live data")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Gateway unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry request" }));
    expect(retry).toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: /Create payment/ }),
    ).toHaveAttribute("href", "/payments");
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Audit data")).toBeInTheDocument();
  });
});
