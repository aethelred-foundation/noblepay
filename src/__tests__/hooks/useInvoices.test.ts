import { renderHook } from "@testing-library/react";
import { useInvoices } from "@/hooks/useInvoices";

const mockRefetch = jest.fn().mockResolvedValue(undefined);
const mockReset = jest.fn();
const mockInvalidate = jest.fn().mockResolvedValue(undefined);
const mockApiRequest = jest.fn().mockResolvedValue({});
const mockQueryOptions: Record<string, any> = {};
const mockQueryStates: Record<string, any> = {};
const mockMutationOptions: any[] = [];
let mockMutationIndex = 0;

jest.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => {
    const key = options.queryKey.join(":");
    mockQueryOptions[key] = options;
    return {
      data: mockQueryStates[key]?.data,
      isLoading: mockQueryStates[key]?.isLoading ?? false,
      error: mockQueryStates[key]?.error ?? null,
      refetch: mockRefetch,
    };
  },
  useMutation: (options: any) => {
    const index = mockMutationIndex++;
    mockMutationOptions[index] = options;
    return {
      mutateAsync: async (value: unknown) => options.mutationFn(value),
      isPending: false,
      error: null,
      reset: mockReset,
    };
  },
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}));
jest.mock("@/lib/api", () => ({
  ...jest.requireActual("@/lib/api"),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

const invoice = {
  id: "inv-verified-1",
  invoiceNumber: "NP-0001",
  businessId: "00000000-0000-4000-8000-000000000001",
  issuer: "0x1111111111111111111111111111111111111111",
  debtor: "0x2222222222222222222222222222222222222222",
  debtorName: "Buyer Ltd",
  description: "Verified services",
  amount: "1000",
  currency: "USDC",
  outstandingAmount: "600",
  financedAmount: "400",
  maturityDate: "2026-08-21T10:00:00.000Z",
  status: "PARTIALLY_FINANCED",
  discountRate: 0.02,
  creditScore: null,
  createdAt: "2026-07-21T10:00:00.000Z",
  settledAt: null,
  settlementReference: null,
};
const financing = {
  id: "finance-1",
  invoiceId: invoice.id,
  amount: "400",
  discountRate: 0.02,
  netProceeds: "392",
  factor: "factor-1",
  term: 31,
  status: "FUNDED",
  externalReference: "gateway-1",
  createdAt: "2026-07-21T10:05:00.000Z",
};

describe("useInvoices", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMutationIndex = 0;
    mockMutationOptions.length = 0;
    Object.keys(mockQueryStates).forEach((key) => delete mockQueryStates[key]);
    mockQueryStates["invoices:list"] = { data: [invoice] };
    mockQueryStates[`invoices:financing:${invoice.id}`] = { data: [financing] };
    mockQueryStates["invoices:analytics"] = {
      data: {
        totalReceivables: "1000",
        totalFinanced: "400",
        totalOutstanding: "600",
        avgDaysToPayment: 18.5,
        overdueAmount: "0",
        overdueCount: 0,
        financingUtilization: 0.4,
        agingBuckets: [{ range: "0-30 days", amount: "600", count: 1 }],
        byCurrency: { USDC: { total: "1000", financed: "400", count: 1 } },
      },
    };
    mockQueryStates[`invoices:credit-score:${invoice.businessId}`] = {
      data: {
        businessId: invoice.businessId,
        score: null,
        grade: "UNRATED",
        sampleSize: 1,
        factors: [
          {
            name: "Observed invoices",
            value: 1,
            description: "At least three matured invoices are required",
          },
        ],
        history: [],
        methodology: "NoblePay observed invoice performance v1",
        lastUpdated: "2026-07-21T10:00:00.000Z",
      },
    };
  });

  it("maps durable invoices, gateway financing history, analytics, and unrated credit", () => {
    const { result } = renderHook(() => useInvoices(invoice.businessId));

    expect(result.current.invoices[0]).toEqual(
      expect.objectContaining({
        invoiceNumber: "NP-0001",
        status: "Financed",
        outstandingAmount: 600,
        financedAmount: 400,
        creditScore: null,
      }),
    );
    expect(result.current.financingRequests[0]).toEqual(
      expect.objectContaining({
        amount: 400,
        netProceeds: 392,
        externalReference: "gateway-1",
      }),
    );
    expect(result.current.creditScore).toEqual(
      expect.objectContaining({ score: null, grade: "UNRATED", sampleSize: 1 }),
    );
    expect(result.current.analytics?.byCurrency.USDC).toEqual({
      total: 1000,
      financed: 400,
      count: 1,
    });
  });

  it("loads every authoritative invoice read endpoint", async () => {
    renderHook(() => useInvoices(invoice.businessId));
    const signal = new AbortController().signal;
    await mockQueryOptions["invoices:list"].queryFn({ signal });
    await mockQueryOptions[`invoices:financing:${invoice.id}`].queryFn({
      signal,
    });
    await mockQueryOptions["invoices:analytics"].queryFn({ signal });
    await mockQueryOptions[
      `invoices:credit-score:${invoice.businessId}`
    ].queryFn({ signal });

    expect(mockApiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/v1/invoices",
      `/v1/invoices/${invoice.id}/financing`,
      "/v1/invoices/analytics",
      `/v1/invoices/credit-score/${invoice.businessId}`,
    ]);
  });

  it("keeps invoice records available when role-gated analytics are denied", () => {
    const analyticsError = new Error("analytics permission denied");
    mockQueryStates["invoices:analytics"] = { error: analyticsError };
    const { result } = renderHook(() => useInvoices(invoice.businessId));

    expect(result.current.error).toBeNull();
    expect(result.current.analyticsError).toBe(analyticsError);
    expect(result.current.invoices).toHaveLength(1);
  });

  it("uses exact durable mutation contracts and financing idempotency", async () => {
    const { result } = renderHook(() => useInvoices(invoice.businessId));
    await result.current.createInvoice({
      payerAddress: invoice.debtor,
      payerName: "Buyer Ltd",
      amount: 1000,
      currency: "USDC",
      dueInDays: 30,
      description: "Verified services",
    });
    await result.current.requestFinancing(invoice.id, 400);
    await result.current.settleInvoice(invoice.id, "settlement-verified-1");
    await result.current.disputeInvoice(
      invoice.id,
      "The delivered services do not match the invoice.",
    );

    expect(mockApiRequest).toHaveBeenNthCalledWith(
      1,
      "/v1/invoices",
      expect.objectContaining({
        method: "POST",
        json: expect.objectContaining({
          debtor: invoice.debtor,
          amount: "1000",
          description: "Verified services",
        }),
      }),
    );
    expect(mockApiRequest).toHaveBeenNthCalledWith(
      2,
      `/v1/invoices/${invoice.id}/finance`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "Idempotency-Key": expect.stringMatching(
            /^invoice-finance-[A-Za-z0-9-]+$/,
          ),
        },
        json: { amount: "400" },
      }),
    );
    expect(mockApiRequest.mock.calls.slice(2).map(([path]) => path)).toEqual([
      `/v1/invoices/${invoice.id}/settle`,
      `/v1/invoices/${invoice.id}/dispute`,
    ]);
  });

  it("invalidates invoice reads after every successful mutation", async () => {
    renderHook(() => useInvoices(invoice.businessId));
    for (const mutation of mockMutationOptions) await mutation.onSuccess();
    expect(mockInvalidate).toHaveBeenCalledTimes(4);
    expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ["invoices"] });
  });
});
