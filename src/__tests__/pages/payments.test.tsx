import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PaymentsPage from "@/pages/payments";

const mockUsePayments = jest.fn();
const mockUsePaymentStats = jest.fn();
const mockUseInitiatePayment = jest.fn();
const mockUseSettlePayment = jest.fn();
const mockUseCancelPayment = jest.fn();
const mockUseRefundPayment = jest.fn();
const mockUseExecuteSettlementRecovery = jest.fn();
const mockUseSettlementRecoveryRequest = jest.fn();
const mockUseComplianceOfficerAuthorization = jest.fn();
const mockUseSubmitScreening = jest.fn();
const mockUseAuthorizeTravelRule = jest.fn();
const mockGetTravelRuleRequirement = jest.fn();
const mockInitiate = jest.fn();
const mockReset = jest.fn();
const mockAddNotification = jest.fn();
const mockSettle = jest.fn();
const mockCancel = jest.fn();
const mockRefund = jest.fn();
const mockExecuteRecovery = jest.fn();
const mockRequestRecovery = jest.fn();
const mockScreen = jest.fn();
const mockAuthorizeTravelRule = jest.fn();

jest.mock("@/config/wagmi", () => ({
  activeChain: {
    blockExplorers: { default: { url: "https://explorer.test" } },
  },
}));
jest.mock("@/hooks/usePayment", () => ({
  SUPPORTED_PAYMENT_CURRENCIES: ["USDC", "USDT"],
  usePayments: (filters: unknown) => mockUsePayments(filters),
  usePaymentStats: () => mockUsePaymentStats(),
  useInitiatePayment: () => mockUseInitiatePayment(),
  useSettlePayment: () => mockUseSettlePayment(),
  useCancelPayment: () => mockUseCancelPayment(),
  useRefundPayment: () => mockUseRefundPayment(),
  useExecuteSettlementRecovery: () => mockUseExecuteSettlementRecovery(),
  useSettlementRecoveryRequest: (paymentId: string) =>
    mockUseSettlementRecoveryRequest(paymentId),
  useComplianceOfficerAuthorization: () =>
    mockUseComplianceOfficerAuthorization(),
}));
jest.mock("@/hooks/useCompliance", () => ({
  useSubmitScreening: () => mockUseSubmitScreening(),
  useAuthorizeTravelRule: () => mockUseAuthorizeTravelRule(),
  getTravelRuleRequirement: (paymentId: string) =>
    mockGetTravelRuleRequirement(paymentId),
}));
jest.mock("@/contexts/AppContext", () => ({
  useApp: () => ({ addNotification: mockAddNotification }),
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
  ErrorState: ({ error }: any) => <div role="alert">{error.message}</div>,
  EmptyState: ({ title, body }: any) => (
    <div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  ),
}));

const payment = {
  id: "p1",
  paymentId: "payment-live-1",
  recipient: "0xrecipient",
  amount: "25",
  currency: "USDC",
  status: "SETTLED",
  initiatedAt: "2026-07-21T10:00:00Z",
  txHash: null,
};
const paymentsQuery = {
  data: { payments: [payment], page: 1, totalPages: 1 },
  isLoading: false,
  isFetching: false,
  error: null,
  refetch: jest.fn(),
};
const statsQuery = {
  data: {
    totalPayments: 1,
    totalVolume: "25",
    last24h: { count: 1, volume: "25" },
    byStatus: { SETTLED: 1 },
  },
  isLoading: false,
  error: null,
  refetch: jest.fn(),
};

describe("PaymentsPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUsePayments.mockReturnValue(paymentsQuery);
    mockUsePaymentStats.mockReturnValue(statsQuery);
    mockInitiate.mockResolvedValue(payment);
    mockUseInitiatePayment.mockReturnValue({
      initiate: mockInitiate,
      reset: mockReset,
      isPending: false,
      error: null,
    });
    mockUseSettlePayment.mockReturnValue({
      execute: mockSettle,
      isPending: false,
      error: null,
    });
    mockUseCancelPayment.mockReturnValue({
      execute: mockCancel,
      isPending: false,
      error: null,
    });
    mockUseRefundPayment.mockReturnValue({
      execute: mockRefund,
      isPending: false,
      error: null,
    });
    mockUseExecuteSettlementRecovery.mockReturnValue({
      execute: mockExecuteRecovery,
      isPending: false,
      error: null,
    });
    mockUseSettlementRecoveryRequest.mockReturnValue({
      recoveryRequest: {
        executeAfter: 0n,
        expiresAt: 0n,
        requestedBy: "0x0000000000000000000000000000000000000000",
      },
      request: mockRequestRecovery,
      isRequesting: false,
      requestError: null,
      isLoading: false,
      error: null,
    });
    mockUseSubmitScreening.mockReturnValue({
      mutateAsync: mockScreen,
      isPending: false,
      error: null,
    });
    mockUseAuthorizeTravelRule.mockReturnValue({
      mutateAsync: mockAuthorizeTravelRule,
      isPending: false,
      error: null,
    });
    mockGetTravelRuleRequirement.mockResolvedValue({
      required: false,
      authorized: false,
      thresholdUsd: "1000.00",
      currency: "USDC",
    });
    mockAuthorizeTravelRule.mockResolvedValue({
      payloadCommitment: `0x${"a".repeat(64)}`,
    });
    mockUseComplianceOfficerAuthorization.mockReturnValue({
      isComplianceOfficer: false,
      isLoading: false,
      error: null,
    });
    mockScreen.mockResolvedValue({ status: "PASSED" });
  });

  it("renders the reconciled payment ledger and live filters", () => {
    render(<PaymentsPage />);
    expect(screen.getByText("payment-live-1")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Payment status"), {
      target: { value: "SETTLED" },
    });
    expect(mockUsePayments).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "SETTLED", page: 1 }),
    );
  });

  it("initiates a payment through the production hook", async () => {
    render(<PaymentsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New payment/ }));
    expect(mockReset).toHaveBeenCalled();
    const asset = screen.getByLabelText("Asset");
    expect(asset).toHaveTextContent("USDC");
    expect(asset).toHaveTextContent("USDT");
    expect(asset).not.toHaveTextContent("AETHEL");
    fireEvent.change(screen.getByLabelText("Recipient address"), {
      target: { value: "0xnew" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText("Payment purpose"), {
      target: { value: "Invoice 42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review in wallet" }));
    await waitFor(() =>
      expect(mockInitiate).toHaveBeenCalledWith({
        recipient: "0xnew",
        amount: "10",
        currency: "USDC",
        purpose: "Invoice 42",
      }),
    );
    expect(mockAddNotification).toHaveBeenCalledWith(
      "success",
      "Payment recorded",
      expect.any(String),
    );
  });

  it("renders the no-records state without sample transactions", () => {
    mockUsePayments.mockReturnValue({
      ...paymentsQuery,
      data: { payments: [], page: 1, totalPages: 1 },
    });
    render(<PaymentsPage />);
    expect(screen.getByText("No verified payments")).toBeInTheDocument();
  });

  it("submits a pending payment cancellation through the wallet lifecycle", async () => {
    const pendingPayment = {
      ...payment,
      paymentId: `0x${"1".repeat(64)}`,
      status: "PENDING",
    };
    mockUsePayments.mockReturnValue({
      ...paymentsQuery,
      data: { payments: [pendingPayment], page: 1, totalPages: 1 },
    });
    mockCancel.mockResolvedValue({
      payment: { ...pendingPayment, status: "CANCELLED" },
    });

    render(<PaymentsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(mockCancel).toHaveBeenCalledWith({
        paymentId: pendingPayment.paymentId,
      }),
    );
    expect(mockAddNotification).toHaveBeenCalledWith(
      "success",
      "Payment cancel confirmed",
      expect.stringContaining("independently verified"),
    );
  });

  it("submits a below-threshold pending record without requesting private data", async () => {
    const pendingPayment = {
      ...payment,
      id: "8cc8aa75-06da-4d9c-b8e4-452f69074548",
      paymentId: `0x${"3".repeat(64)}`,
      status: "PENDING",
    };
    mockUsePayments.mockReturnValue({
      ...paymentsQuery,
      data: { payments: [pendingPayment], page: 1, totalPages: 1 },
    });

    render(<PaymentsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Screen" }));

    await waitFor(() =>
      expect(mockGetTravelRuleRequirement).toHaveBeenCalledWith(
        pendingPayment.id,
      ),
    );
    await waitFor(() =>
      expect(mockScreen).toHaveBeenCalledWith({
        paymentId: pendingPayment.id,
        priority: "normal",
      }),
    );
    expect(mockAddNotification).toHaveBeenCalledWith(
      "success",
      "Screening verified",
      expect.stringContaining("never signs the verifier transaction"),
    );
  });

  it("collects above-threshold IVMS101 fields and prompts a wallet authorization before screening", async () => {
    const pendingPayment = {
      ...payment,
      id: "8cc8aa75-06da-4d9c-b8e4-452f69074548",
      paymentId: `0x${"3".repeat(64)}`,
      amount: "2500",
      status: "PENDING",
    };
    mockUsePayments.mockReturnValue({
      ...paymentsQuery,
      data: { payments: [pendingPayment], page: 1, totalPages: 1 },
    });
    mockGetTravelRuleRequirement.mockResolvedValue({
      required: true,
      authorized: false,
      thresholdUsd: "1000.00",
      currency: "USDC",
    });

    render(<PaymentsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Screen" }));
    expect(
      await screen.findByRole("dialog", {
        name: "Authorize Travel Rule data",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/stores only AES-256-GCM ciphertext/i),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Originator legal name"), {
      target: { value: "Acme Trading LLC" },
    });
    fireEvent.change(screen.getByLabelText("Originator account"), {
      target: { value: "AE-001" },
    });
    fireEvent.change(screen.getByLabelText("Originator registered address"), {
      target: { value: "Dubai, AE" },
    });
    fireEvent.change(screen.getByLabelText("Beneficiary legal name"), {
      target: { value: "Beneficiary Ltd" },
    });
    fireEvent.change(screen.getByLabelText("Beneficiary account"), {
      target: { value: "GB-002" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Sign authorization and screen" }),
    );

    await waitFor(() =>
      expect(mockAuthorizeTravelRule).toHaveBeenCalledWith({
        paymentId: pendingPayment.id,
        data: {
          originatorName: "Acme Trading LLC",
          originatorAccount: "AE-001",
          originatorAddress: "Dubai, AE",
          beneficiaryName: "Beneficiary Ltd",
          beneficiaryAccount: "GB-002",
        },
      }),
    );
    await waitFor(() =>
      expect(mockScreen).toHaveBeenCalledWith({
        paymentId: pendingPayment.id,
        priority: "normal",
      }),
    );
  });

  it("offers a refund for an on-chain blocked payment mirrored as rejected", async () => {
    const rejectedPayment = {
      ...payment,
      paymentId: `0x${"2".repeat(64)}`,
      status: "REJECTED",
    };
    mockUsePayments.mockReturnValue({
      ...paymentsQuery,
      data: { payments: [rejectedPayment], page: 1, totalPages: 1 },
    });
    mockRefund.mockResolvedValue({
      payment: { ...rejectedPayment, status: "REFUNDED" },
    });

    render(<PaymentsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));

    await waitFor(() =>
      expect(mockRefund).toHaveBeenCalledWith({
        paymentId: rejectedPayment.paymentId,
      }),
    );
  });

  it("shows a flagged refund only when the connected wallet has the contract role", () => {
    const flaggedPayment = {
      ...payment,
      paymentId: `0x${"4".repeat(64)}`,
      status: "FLAGGED",
    };
    mockUsePayments.mockReturnValue({
      ...paymentsQuery,
      data: { payments: [flaggedPayment], page: 1, totalPages: 1 },
    });

    const { rerender } = render(<PaymentsPage />);
    expect(screen.getByText("Compliance officer required")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Officer refund" }),
    ).not.toBeInTheDocument();

    mockUseComplianceOfficerAuthorization.mockReturnValue({
      isComplianceOfficer: true,
      isLoading: false,
      error: null,
    });
    rerender(<PaymentsPage />);
    expect(
      screen.getByRole("button", { name: "Officer refund" }),
    ).toBeInTheDocument();
  });

  it("offers the governed recovery notice only to an on-chain compliance officer", async () => {
    const passedPayment = {
      ...payment,
      paymentId: `0x${"5".repeat(64)}`,
      status: "PASSED",
    };
    mockUsePayments.mockReturnValue({
      ...paymentsQuery,
      data: { payments: [passedPayment], page: 1, totalPages: 1 },
    });

    const { rerender } = render(<PaymentsPage />);
    expect(
      screen.queryByRole("button", { name: "Request recovery" }),
    ).not.toBeInTheDocument();

    mockUseComplianceOfficerAuthorization.mockReturnValue({
      isComplianceOfficer: true,
      isLoading: false,
      error: null,
    });
    mockRequestRecovery.mockResolvedValue(`0x${"6".repeat(64)}`);
    rerender(<PaymentsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Request recovery" }));

    await waitFor(() => expect(mockRequestRecovery).toHaveBeenCalledTimes(1));
    expect(mockAddNotification).toHaveBeenCalledWith(
      "success",
      "Recovery notice recorded",
      expect.stringContaining("Settlement remains available"),
    );
  });

  it("executes a matured recovery through receipt reconciliation", async () => {
    const passedPayment = {
      ...payment,
      paymentId: `0x${"7".repeat(64)}`,
      status: "PASSED",
    };
    mockUsePayments.mockReturnValue({
      ...paymentsQuery,
      data: { payments: [passedPayment], page: 1, totalPages: 1 },
    });
    mockUseComplianceOfficerAuthorization.mockReturnValue({
      isComplianceOfficer: true,
      isLoading: false,
      error: null,
    });
    const now = BigInt(Math.floor(Date.now() / 1000));
    mockUseSettlementRecoveryRequest.mockReturnValue({
      recoveryRequest: {
        executeAfter: now - 1n,
        expiresAt: now + 3600n,
        requestedBy: "0x1234567890abcdef1234567890abcdef12345678",
      },
      request: mockRequestRecovery,
      isRequesting: false,
      requestError: null,
      isLoading: false,
      error: null,
    });
    mockExecuteRecovery.mockResolvedValue({
      payment: { ...passedPayment, status: "REFUNDED" },
      method: "executeSettlementRecovery",
    });

    render(<PaymentsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Execute recovery" }));

    await waitFor(() =>
      expect(mockExecuteRecovery).toHaveBeenCalledWith({
        paymentId: passedPayment.paymentId,
      }),
    );
    expect(mockAddNotification).toHaveBeenCalledWith(
      "success",
      "Settlement recovery confirmed",
      expect.stringContaining("independently verified"),
    );
  });
});
