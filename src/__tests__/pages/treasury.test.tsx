import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TreasuryPage from "@/pages/treasury";

const mockUseTreasury = jest.fn();
const mockCreateProposal = jest.fn();
const mockVoteOnProposal = jest.fn();

jest.mock("@/hooks/useTreasury", () => ({
  useTreasury: () => mockUseTreasury(),
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

const ready = {
  overview: {
    totalBalance: 1000,
    tokenBalances: [{ symbol: "USDC", amount: 1000, valueUsd: null }],
    monthlyYield: 20,
    monthlySpend: 30,
    pendingApprovals: 1,
    activeStrategies: 1,
    signerCount: 2,
  },
  proposals: [
    {
      id: "proposal-1",
      title: "Supplier payment",
      amount: 250,
      tokenSymbol: "USDC",
      category: "OPERATIONS",
      status: "Active",
      votesFor: 1,
      quorum: 2,
    },
    {
      id: "proposal-2",
      title: "Approved supplier payment",
      amount: 500,
      tokenSymbol: "USDC",
      category: "OPERATIONS",
      status: "Queued",
      votesFor: 2,
      quorum: 2,
    },
  ],
  policies: [
    {
      id: "ops",
      name: "OPERATIONS",
      dailyLimit: 100,
      monthlyLimit: 1000,
      requiredApprovals: 2,
      active: true,
    },
  ],
  strategies: [
    {
      id: "yield-1",
      protocol: "Aave",
      allocated: 500,
      apy: 4.2,
      risk: "Conservative",
      earnedToDate: 5,
    },
  ],
  thresholds: [],
  isLoading: false,
  isMutating: false,
  error: null,
  actionError: null,
  refetch: jest.fn(),
  createProposal: mockCreateProposal,
  voteOnProposal: mockVoteOnProposal,
};

describe("TreasuryPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateProposal.mockResolvedValue({});
    mockVoteOnProposal.mockResolvedValue({});
    mockUseTreasury.mockReturnValue(ready);
  });

  it("renders durable treasury records and proposal history", () => {
    render(<TreasuryPage />);
    expect(
      screen.getByRole("heading", { name: "Treasury" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("OPERATIONS").length).toBeGreaterThan(0);
    expect(screen.getByText("Aave")).toBeInTheDocument();
    expect(screen.getByText("Supplier payment")).toBeInTheDocument();
    expect(screen.getByText("Execution unavailable")).toBeInTheDocument();
  });

  it("submits a real proposal payload", async () => {
    render(<TreasuryPage />);
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Operations" },
    });
    fireEvent.change(screen.getByLabelText("Recipient"), {
      target: { value: "0xdef" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "250" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Vendor payment" },
    });
    fireEvent.change(screen.getByLabelText("Spending category"), {
      target: { value: "OPERATIONS" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create proposal" }));
    await waitFor(() =>
      expect(mockCreateProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Operations",
          recipient: "0xdef",
          amount: 250,
          tokenSymbol: "USDC",
          category: "OPERATIONS",
        }),
      ),
    );
  });

  it("allows durable approval but exposes no execution control", async () => {
    render(<TreasuryPage />);
    fireEvent.click(screen.getByRole("button", { name: "Approve proposal" }));
    await waitFor(() =>
      expect(mockVoteOnProposal).toHaveBeenCalledWith("proposal-1", true),
    );
    expect(screen.queryByRole("button", { name: /execute/i })).toBeNull();
  });

  it("renders service errors", () => {
    mockUseTreasury.mockReturnValue({
      ...ready,
      error: new Error("treasury offline"),
    });
    render(<TreasuryPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("treasury offline");
  });
});
