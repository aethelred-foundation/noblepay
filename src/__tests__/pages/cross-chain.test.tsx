import { render, screen } from "@testing-library/react";
import CrossChainPage from "@/pages/cross-chain";

const mockUseCrossChain = jest.fn();

jest.mock("@/hooks/useCrossChain", () => ({
  useCrossChain: () => mockUseCrossChain(),
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

const chains = [
  {
    chainId: 1,
    name: "Ethereum",
    supportedTokens: ["USDC"],
    status: "Online",
    avgBlockTime: 12,
    gasPrice: 20,
  },
  {
    chainId: 7331,
    name: "Aethelred L1",
    supportedTokens: ["USDC", "AET"],
    status: "Online",
    avgBlockTime: 2,
    gasPrice: 1,
  },
];
const ready = {
  chains,
  transfers: [
    {
      id: "transfer-1",
      sourceChainName: "Ethereum",
      destChainName: "Aethelred L1",
      recipient: "0xrecipient",
      amount: 100,
      tokenSymbol: "USDC",
      bridgeFee: 2,
      status: "Completed",
    },
  ],
  relayNodes: [
    {
      id: "relay-1",
      name: "relay-1",
      operator: "0xrelay",
      status: "Active",
      uptime: 99.9,
      successRate: 98.5,
      stakedCollateral: 1000,
    },
  ],
  isLoading: false,
  chainsLoading: false,
  isMutating: false,
  error: null,
  chainsError: null,
  mutationReason:
    "Bridge quotes and execution are disabled until signed quotes and both-chain receipts can be verified.",
  refetch: jest.fn(),
};

describe("CrossChainPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseCrossChain.mockReturnValue(ready);
  });

  it("renders live chains, transfers, and relay health", () => {
    render(<CrossChainPage />);
    expect(screen.getAllByText("Ethereum").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Aethelred L1").length).toBeGreaterThan(0);
    expect(screen.getByText("transfer-1")).toBeInTheDocument();
    expect(screen.getByText("relay-1")).toBeInTheDocument();
    expect(
      screen.getByText("Bridge execution is read-only"),
    ).toBeInTheDocument();
  });

  it("does not expose unsupported quote or transfer controls", () => {
    render(<CrossChainPage />);
    expect(screen.queryByRole("button", { name: /find routes/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /initiate transfer/i }),
    ).toBeNull();
  });

  it("renders a real empty state when chains are unavailable", () => {
    mockUseCrossChain.mockReturnValue({
      ...ready,
      chains: [],
      transfers: [],
      relayNodes: [],
    });
    render(<CrossChainPage />);
    expect(screen.getByText("No chains")).toBeInTheDocument();
    expect(screen.getByText("No cross-chain transfers")).toBeInTheDocument();
    expect(screen.getByText("No relay nodes")).toBeInTheDocument();
  });
});
