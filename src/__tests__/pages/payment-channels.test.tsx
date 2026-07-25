import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PaymentChannelsPage from "@/pages/payment-channels";

const mockUsePaymentChannels = jest.fn();
const mockOpenChannel = jest.fn();
const mockFundChannel = jest.fn();
const mockCloseChannel = jest.fn();
const mockCancelOpenChannel = jest.fn();
const mockInitiateCurrentStateClose = jest.fn();
const mockCounterDispute = jest.fn();
const mockFinalizeClose = jest.fn();
const mockBuildStateArtifact = jest.fn();
const mockInspectStateArtifact = jest.fn();
const mockSignStateArtifact = jest.fn();
const mockRefetch = jest.fn();
const mockReset = jest.fn();
const mockNotify = jest.fn();

const USDC = "0x0000000000000000000000000000000000000005";
const COUNTERPARTY = "0x1111111111111111111111111111111111111111";

function stateArtifact(stateType: "CLOSE" | "STATE") {
  return JSON.stringify(
    {
      format: "noblepay-channel-state-v2",
      chainId: "7332",
      verifyingContract: "0x0000000000000000000000000000000000000008",
      state: {
        channelId:
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        balanceA: "8000000",
        balanceB: "7000000",
        nonce: "4",
        stateEpoch: "2",
        stateType,
      },
      signatures: {
        partyA: `0x${"aa".repeat(65)}`,
        partyB: `0x${"bb".repeat(65)}`,
      },
    },
    null,
    2,
  );
}

jest.mock("@/config/wagmi", () => ({
  activeChain: {
    blockExplorers: { default: { url: "https://explorer.test" } },
  },
}));
jest.mock("@/config/chains", () => ({
  CONTRACT_ADDRESSES: {
    paymentChannels: "0x0000000000000000000000000000000000000008",
    usdcToken: "0x0000000000000000000000000000000000000005",
    usdtToken: "0x0000000000000000000000000000000000000006",
  },
}));
jest.mock("@/hooks/usePaymentChannels", () => ({
  usePaymentChannels: () => mockUsePaymentChannels(),
}));
jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({ addNotification: mockNotify }),
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
  ErrorState: ({ error, retry }: any) => (
    <div role="alert">
      {error.message}
      {retry ? <button onClick={retry}>Retry</button> : null}
    </div>
  ),
  EmptyState: ({ title, body }: any) => (
    <div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  ),
}));

const activeChannel = {
  channelId:
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  partyA: "0x1234567890abcdef1234567890abcdef12345678",
  partyB: COUNTERPARTY,
  token: USDC,
  depositA: 10_000_000n,
  depositB: 5_000_000n,
  balanceA: 8_000_000n,
  balanceB: 7_000_000n,
  status: 2,
  nonce: 3n,
  stateEpoch: 2n,
  openedAt: 1n,
  closingAt: 0n,
  closedAt: 0n,
  challengePeriod: 86_400n,
  tokenDecimals: 6,
  tokenSymbol: "USDC",
  depositADisplay: "10",
  depositBDisplay: "5",
  balanceADisplay: "8",
  balanceBDisplay: "7",
  statusLabel: "ACTIVE",
  disputeChallenger: null,
  disputeNonce: null,
  disputeExpiresAt: null,
};

function channelState(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    connectedAddress: activeChannel.partyA,
    settlementTokensConfigured: true,
    kycVerified: true,
    channels: [activeChannel],
    isLoading: false,
    error: null,
    refetch: mockRefetch,
    openChannel: mockOpenChannel,
    fundChannel: mockFundChannel,
    closeChannel: mockCloseChannel,
    cancelOpenChannel: mockCancelOpenChannel,
    initiateCurrentStateClose: mockInitiateCurrentStateClose,
    counterDispute: mockCounterDispute,
    finalizeClose: mockFinalizeClose,
    buildStateArtifact: mockBuildStateArtifact,
    inspectStateArtifact: mockInspectStateArtifact,
    signStateArtifact: mockSignStateArtifact,
    isMutating: false,
    reset: mockReset,
    ...overrides,
  };
}

describe("PaymentChannelsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUsePaymentChannels.mockReturnValue(channelState());
    mockOpenChannel.mockResolvedValue("0xopenchannelhash");
    mockFundChannel.mockResolvedValue("0xfundchannelhash");
    mockCloseChannel.mockResolvedValue("0xclosechannelhash");
    mockCancelOpenChannel.mockResolvedValue("0xcancelchannelhash");
    mockInitiateCurrentStateClose.mockResolvedValue("0xcurrentstatehash");
    mockCounterDispute.mockResolvedValue("0xdisputehash");
    mockFinalizeClose.mockResolvedValue("0xfinalizehash");
    mockBuildStateArtifact.mockImplementation(
      ({ stateType }: { stateType: "CLOSE" | "STATE" }) =>
        Promise.resolve(stateArtifact(stateType)),
    );
    mockSignStateArtifact.mockImplementation((artifact: string) =>
      Promise.resolve(artifact),
    );
  });

  it("renders contract-backed balances and lifecycle state", () => {
    render(<PaymentChannelsPage />);

    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByText(/Counterparty 0x1111/)).toBeInTheDocument();
    expect(screen.getByText("Channels: 1")).toBeInTheDocument();
    expect(screen.getByText("Aggregate deposits: 15")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open channel contract in explorer" }),
    ).toHaveAttribute(
      "href",
      "https://explorer.test/address/0x0000000000000000000000000000000000000008",
    );
  });

  it("opens a real channel with the entered settlement terms", async () => {
    render(<PaymentChannelsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Open channel" }));
    expect(mockReset).toHaveBeenCalled();
    expect(screen.getByLabelText("Settlement token")).toHaveTextContent("USDC");
    expect(screen.getByLabelText("Settlement token")).toHaveTextContent("USDT");
    expect(screen.getByLabelText("Settlement token")).not.toHaveTextContent(
      "AETHEL",
    );
    fireEvent.change(screen.getByLabelText("Counterparty"), {
      target: { value: COUNTERPARTY },
    });
    fireEvent.change(screen.getByLabelText("Initial deposit"), {
      target: { value: "125.5" },
    });
    fireEvent.change(screen.getByLabelText("Challenge hours"), {
      target: { value: "48" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve and open" }));

    await waitFor(() =>
      expect(mockOpenChannel).toHaveBeenCalledWith({
        counterparty: COUNTERPARTY,
        token: USDC,
        deposit: "125.5",
        challengeHours: 48,
      }),
    );
    expect(mockNotify).toHaveBeenCalledWith(
      "success",
      "Channel opened",
      expect.stringContaining("0xopenchanne"),
    );
  });

  it("funds and cooperatively closes the selected channel", async () => {
    render(<PaymentChannelsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Fund" }));
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "2.25" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve and fund" }));
    await waitFor(() =>
      expect(mockFundChannel).toHaveBeenCalledWith({
        channel: activeChannel,
        amount: "2.25",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByLabelText("Final balance A")).toHaveValue("8");
    expect(screen.getByLabelText("Final balance B")).toHaveValue("7");
    expect(screen.getByLabelText("State nonce")).toHaveValue("4");
    fireEvent.click(
      screen.getByRole("button", { name: "Build from balances" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("State artifact JSON")).toHaveValue(
        stateArtifact("CLOSE"),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit close state" }));
    await waitFor(() =>
      expect(mockCloseChannel).toHaveBeenCalledWith({
        channel: activeChannel,
        artifact: stateArtifact("CLOSE"),
        mode: "cooperative",
      }),
    );
  });

  it("exposes guaranteed on-chain exits without requiring an off-chain signature", async () => {
    const view = render(<PaymentChannelsPage />);

    fireEvent.click(
      screen.getByRole("button", { name: "Close current state" }),
    );
    await waitFor(() =>
      expect(mockInitiateCurrentStateClose).toHaveBeenCalledWith(activeChannel),
    );
    expect(mockNotify).toHaveBeenCalledWith(
      "success",
      "Current-state challenge started",
      expect.stringContaining("0xcurrentsta"),
    );

    const openChannel = {
      ...activeChannel,
      status: 0,
      statusLabel: "OPEN",
      depositB: 0n,
      balanceB: 0n,
      depositBDisplay: "0",
      balanceBDisplay: "0",
    };
    mockUsePaymentChannels.mockReturnValue(
      channelState({ channels: [openChannel] }),
    );
    view.rerender(<PaymentChannelsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel & refund" }));
    await waitFor(() =>
      expect(mockCancelOpenChannel).toHaveBeenCalledWith(openChannel),
    );
  });

  it("lets a party counter a closing channel with a higher signed state", async () => {
    const closingChannel = {
      ...activeChannel,
      status: 3,
      statusLabel: "CLOSING",
      closingAt: BigInt(Math.floor(Date.now() / 1000)),
      disputeChallenger: COUNTERPARTY,
      disputeNonce: 3n,
      disputeExpiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    mockUsePaymentChannels.mockReturnValue(
      channelState({ channels: [closingChannel] }),
    );
    render(<PaymentChannelsPage />);

    expect(screen.queryByRole("button", { name: "Fund" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Counter dispute" }));
    expect(
      screen.getByRole("dialog", { name: "Counter channel dispute" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Final balance A"), {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByLabelText("Final balance B"), {
      target: { value: "8" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Build from balances" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("State artifact JSON")).toHaveValue(
        stateArtifact("STATE"),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit newer state" }));

    await waitFor(() =>
      expect(mockCounterDispute).toHaveBeenCalledWith({
        channel: closingChannel,
        artifact: stateArtifact("STATE"),
      }),
    );
    expect(mockNotify).toHaveBeenCalledWith(
      "success",
      "Newer channel state submitted",
      expect.stringContaining("0xdispute"),
    );
  });

  it("fails closed when the contract is unavailable and exposes no sample data", () => {
    mockUsePaymentChannels.mockReturnValue(
      channelState({ configured: false, channels: [] }),
    );
    render(<PaymentChannelsPage />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Payment Channels is not deployed",
    );
    expect(screen.queryByText("ACTIVE")).not.toBeInTheDocument();
  });

  it("blocks channel creation until on-chain KYC is synchronized", () => {
    mockUsePaymentChannels.mockReturnValue(
      channelState({ kycVerified: false, channels: [] }),
    );
    render(<PaymentChannelsPage />);

    expect(
      screen.getByText("Channel KYC verification required"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open channel" })).toBeDisabled();
    expect(screen.getByText("No payment channels")).toBeInTheDocument();
  });

  it("shows unsupported legacy token records without transaction controls", () => {
    mockUsePaymentChannels.mockReturnValue(
      channelState({
        channels: [
          {
            ...activeChannel,
            token: "0x0000000000000000000000000000000000000007",
            tokenDecimals: null,
            tokenSymbol: null,
            depositADisplay: null,
            depositBDisplay: null,
            balanceADisplay: null,
            balanceBDisplay: null,
          },
        ],
      }),
    );
    render(<PaymentChannelsPage />);

    expect(screen.getByText("Unsupported token")).toBeInTheDocument();
    expect(
      screen.getByText(/Funding and signed-state actions unavailable/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fund" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Close current state" }),
    ).toBeInTheDocument();
  });
});
