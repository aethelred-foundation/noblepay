import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import InvoiceFinancingPage from "@/pages/invoice-financing";

const mockUseInvoices = jest.fn();
const mockCreateInvoice = jest.fn();
const mockRequestFinancing = jest.fn();
const mockSettleInvoice = jest.fn();
const mockDisputeInvoice = jest.fn();

jest.mock("@/hooks/useInvoices", () => ({
  useInvoices: (businessId?: string) => mockUseInvoices(businessId),
}));
jest.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ business: { id: "business-1" } }),
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

const invoice = {
  id: "inv-verified-1",
  invoiceNumber: "NP-0001",
  issuer: "0x1111111111111111111111111111111111111111",
  payer: "0x2222222222222222222222222222222222222222",
  payerName: "Buyer Ltd",
  amount: 1000,
  outstandingAmount: 600,
  financedAmount: 400,
  currency: "USDC",
  status: "Financed",
  issuedAt: Date.UTC(2026, 0, 1),
  dueAt: Date.UTC(2026, 1, 1),
};
const ready = {
  invoices: [invoice],
  financingRequests: [
    {
      id: "finance-1",
      invoiceId: invoice.id,
      amount: 400,
      netProceeds: 392,
      termDays: 30,
      status: "FUNDED",
    },
  ],
  creditScore: {
    score: null,
    grade: "UNRATED",
    sampleSize: 1,
    methodology: "NoblePay observed invoice performance v1",
    updatedAt: Date.UTC(2026, 0, 1),
  },
  analytics: {
    overdueCount: 0,
    avgDaysToPay: 18,
    byCurrency: { USDC: { total: 1000, financed: 400, count: 1 } },
  },
  isLoading: false,
  isMutating: false,
  error: null,
  actionError: null,
  analyticsError: null,
  refetch: jest.fn(),
  createInvoice: mockCreateInvoice,
  requestFinancing: mockRequestFinancing,
  settleInvoice: mockSettleInvoice,
  disputeInvoice: mockDisputeInvoice,
};

describe("InvoiceFinancingPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateInvoice.mockResolvedValue({});
    mockRequestFinancing.mockResolvedValue({});
    mockSettleInvoice.mockResolvedValue({});
    mockDisputeInvoice.mockResolvedValue({});
    mockUseInvoices.mockReturnValue(ready);
  });

  it("renders durable invoices, financing receipts, currency totals, and honest credit", () => {
    render(<InvoiceFinancingPage />);
    expect(mockUseInvoices).toHaveBeenCalledWith("business-1");
    expect(screen.getByText("Buyer Ltd")).toBeInTheDocument();
    expect(screen.getByText("finance-1")).toBeInTheDocument();
    expect(screen.getByText("Unrated")).toBeInTheDocument();
    expect(screen.getAllByText(/1,000 USDC/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/tokenization/i)).toBeNull();
  });

  it("creates an invoice and requests verified financing", async () => {
    render(<InvoiceFinancingPage />);
    fireEvent.change(screen.getByLabelText("Payer wallet"), {
      target: { value: invoice.payer },
    });
    fireEvent.change(screen.getByLabelText("Payer name"), {
      target: { value: "New Buyer" },
    });
    fireEvent.change(screen.getByLabelText("Amount"), {
      target: { value: "500" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Verified services" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create invoice" }));
    await waitFor(() =>
      expect(mockCreateInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          payerAddress: invoice.payer,
          payerName: "New Buyer",
          amount: 500,
          currency: "USDC",
        }),
      ),
    );

    fireEvent.change(screen.getByLabelText("Financing amount"), {
      target: { value: "200" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request financing" }));
    await waitFor(() =>
      expect(mockRequestFinancing).toHaveBeenCalledWith(invoice.id, 200),
    );
  });

  it("submits settlement verification and durable disputes", async () => {
    render(<InvoiceFinancingPage />);
    fireEvent.change(screen.getByLabelText("Settlement reference"), {
      target: { value: "settlement-verified-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify settlement" }));
    await waitFor(() =>
      expect(mockSettleInvoice).toHaveBeenCalledWith(
        invoice.id,
        "settlement-verified-1",
      ),
    );

    fireEvent.change(screen.getByLabelText("Dispute reason"), {
      target: { value: "The delivered services do not match the invoice." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Raise dispute" }));
    await waitFor(() =>
      expect(mockDisputeInvoice).toHaveBeenCalledWith(
        invoice.id,
        "The delivered services do not match the invoice.",
      ),
    );
  });

  it("renders action errors without replacing durable reads", () => {
    mockUseInvoices.mockReturnValue({
      ...ready,
      actionError: new Error("Financing gateway is not configured"),
    });
    render(<InvoiceFinancingPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Financing gateway is not configured",
    );
    expect(screen.getByText("Buyer Ltd")).toBeInTheDocument();
  });
});
