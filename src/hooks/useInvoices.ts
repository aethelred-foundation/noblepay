import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiRequest } from "@/lib/api";
import type {
  CreditScore,
  FinancingRequest,
  Invoice,
  InvoiceAnalytics,
  InvoiceStatus,
} from "@/types/invoice";

interface ApiInvoice {
  id: string;
  invoiceNumber: string;
  businessId: string;
  issuer: string;
  debtor: string;
  debtorName: string;
  description: string;
  amount: string;
  currency: string;
  outstandingAmount: string;
  financedAmount: string;
  maturityDate: string;
  status:
    | "DRAFT"
    | "ISSUED"
    | "FINANCED"
    | "PARTIALLY_FINANCED"
    | "SETTLED"
    | "OVERDUE"
    | "DISPUTED"
    | "CANCELLED"
    | "WRITTEN_OFF";
  discountRate: number | null;
  creditScore: number | null;
  createdAt: string;
  settledAt: string | null;
  settlementReference: string | null;
}

interface ApiFinancingRequest {
  id: string;
  invoiceId: string;
  amount: string;
  discountRate: number | null;
  netProceeds: string | null;
  factor: string | null;
  term: number;
  status: FinancingRequest["status"];
  externalReference: string | null;
  createdAt: string;
}

interface ApiCreditScore extends Omit<CreditScore, "updatedAt"> {
  lastUpdated: string;
}

interface ApiAnalytics {
  totalReceivables: string;
  totalFinanced: string;
  totalOutstanding: string;
  avgDaysToPayment: number;
  overdueAmount: string;
  overdueCount: number;
  financingUtilization: number;
  agingBuckets: Array<{ range: string; amount: string; count: number }>;
  byCurrency: Record<
    string,
    { total: string; financed: string; count: number }
  >;
}

export interface CreateInvoiceInput {
  payerAddress: string;
  payerName: string;
  amount: number;
  currency: string;
  dueInDays: number;
  description: string;
}

function mapStatus(status: ApiInvoice["status"]): InvoiceStatus {
  const statuses: Record<ApiInvoice["status"], InvoiceStatus> = {
    DRAFT: "Draft",
    ISSUED: "Issued",
    FINANCED: "Financed",
    PARTIALLY_FINANCED: "Financed",
    SETTLED: "Paid",
    OVERDUE: "Overdue",
    DISPUTED: "Disputed",
    CANCELLED: "Cancelled",
    WRITTEN_OFF: "WrittenOff",
  };
  return statuses[status];
}

function mapInvoice(invoice: ApiInvoice): Invoice {
  const dueAt = Date.parse(invoice.maturityDate);
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    issuer: invoice.issuer,
    payer: invoice.debtor,
    payerName: invoice.debtorName,
    amount: Number(invoice.amount),
    outstandingAmount: Number(invoice.outstandingAmount),
    financedAmount: Number(invoice.financedAmount),
    currency: invoice.currency,
    status: mapStatus(invoice.status),
    issuedAt: Date.parse(invoice.createdAt),
    dueAt,
    paidAt: invoice.settledAt ? Date.parse(invoice.settledAt) : 0,
    daysUntilDue: Math.ceil((dueAt - Date.now()) / 86_400_000),
    description: invoice.description,
    settlementReference: invoice.settlementReference,
    discountRate: invoice.discountRate,
    creditScore: invoice.creditScore,
  };
}

function mapFinancing(request: ApiFinancingRequest): FinancingRequest {
  return {
    id: request.id,
    invoiceId: request.invoiceId,
    amount: Number(request.amount),
    discountRate: request.discountRate,
    netProceeds:
      request.netProceeds === null ? null : Number(request.netProceeds),
    factor: request.factor,
    termDays: request.term,
    status: request.status,
    externalReference: request.externalReference,
    createdAt: Date.parse(request.createdAt),
  };
}

function secureIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return `invoice-finance-${cryptoApi.randomUUID()}`;
  }
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `invoice-finance-${Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  }
  throw new ApiError("Secure idempotency generation is unavailable", {
    code: "SECURE_RANDOM_UNAVAILABLE",
  });
}

export function useInvoices(businessId?: string) {
  const queryClient = useQueryClient();
  const invoicesQuery = useQuery({
    queryKey: ["invoices", "list"],
    queryFn: ({ signal }) =>
      apiRequest<ApiInvoice[]>("/v1/invoices", { signal }),
  });
  const invoiceIds = (invoicesQuery.data || []).map((invoice) => invoice.id);
  const financingQuery = useQuery({
    queryKey: ["invoices", "financing", invoiceIds.join(",")],
    enabled: invoiceIds.length > 0,
    queryFn: async ({ signal }) =>
      (
        await Promise.all(
          invoiceIds.map((invoiceId) =>
            apiRequest<ApiFinancingRequest[]>(
              `/v1/invoices/${encodeURIComponent(invoiceId)}/financing`,
              { signal },
            ),
          ),
        )
      ).flat(),
  });
  const analyticsQuery = useQuery({
    queryKey: ["invoices", "analytics"],
    queryFn: ({ signal }) =>
      apiRequest<ApiAnalytics>("/v1/invoices/analytics", { signal }),
  });
  const creditQuery = useQuery({
    queryKey: ["invoices", "credit-score", businessId],
    queryFn: ({ signal }) =>
      apiRequest<ApiCreditScore>(
        `/v1/invoices/credit-score/${encodeURIComponent(businessId!)}`,
        { signal },
      ),
    enabled: Boolean(businessId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["invoices"] });
  const createMutation = useMutation({
    mutationFn: (params: CreateInvoiceInput) =>
      apiRequest<ApiInvoice>("/v1/invoices", {
        method: "POST",
        json: {
          debtor: params.payerAddress,
          debtorName: params.payerName,
          amount: String(params.amount),
          currency: params.currency,
          maturityDate: new Date(
            Date.now() + params.dueInDays * 86_400_000,
          ).toISOString(),
          description: params.description,
        },
      }),
    onSuccess: invalidate,
  });
  const financeMutation = useMutation({
    mutationFn: ({
      invoiceId,
      amount,
    }: {
      invoiceId: string;
      amount: number;
    }) =>
      apiRequest<ApiFinancingRequest>(
        `/v1/invoices/${encodeURIComponent(invoiceId)}/finance`,
        {
          method: "POST",
          headers: { "Idempotency-Key": secureIdempotencyKey() },
          json: { amount: String(amount) },
        },
      ),
    onSuccess: invalidate,
  });
  const settleMutation = useMutation({
    mutationFn: ({
      invoiceId,
      settlementReference,
    }: {
      invoiceId: string;
      settlementReference: string;
    }) =>
      apiRequest<ApiInvoice>(
        `/v1/invoices/${encodeURIComponent(invoiceId)}/settle`,
        { method: "POST", json: { settlementReference } },
      ),
    onSuccess: invalidate,
  });
  const disputeMutation = useMutation({
    mutationFn: ({
      invoiceId,
      reason,
    }: {
      invoiceId: string;
      reason: string;
    }) =>
      apiRequest(`/v1/invoices/${encodeURIComponent(invoiceId)}/dispute`, {
        method: "POST",
        json: { reason },
      }),
    onSuccess: invalidate,
  });

  const invoices = useMemo(
    () => (invoicesQuery.data || []).map(mapInvoice),
    [invoicesQuery.data],
  );
  const financingRequests = useMemo(
    () => (financingQuery.data || []).map(mapFinancing),
    [financingQuery.data],
  );
  const analytics: InvoiceAnalytics | null = analyticsQuery.data
    ? {
        totalReceivables: Number(analyticsQuery.data.totalReceivables),
        totalOutstanding: Number(analyticsQuery.data.totalOutstanding),
        overdueAmount: Number(analyticsQuery.data.overdueAmount),
        overdueCount: analyticsQuery.data.overdueCount,
        totalFinanced: Number(analyticsQuery.data.totalFinanced),
        avgDaysToPay: analyticsQuery.data.avgDaysToPayment,
        financingUtilization: analyticsQuery.data.financingUtilization,
        agingBuckets: analyticsQuery.data.agingBuckets.map((bucket) => ({
          ...bucket,
          amount: Number(bucket.amount),
        })),
        byCurrency: Object.fromEntries(
          Object.entries(analyticsQuery.data.byCurrency).map(
            ([currency, value]) => [
              currency,
              {
                total: Number(value.total),
                financed: Number(value.financed),
                count: value.count,
              },
            ],
          ),
        ),
      }
    : null;
  const creditScore: CreditScore | null = creditQuery.data
    ? {
        ...creditQuery.data,
        updatedAt: Date.parse(creditQuery.data.lastUpdated),
      }
    : null;

  const requestFinancing = useCallback(
    (invoiceId: string, amount: number) =>
      financeMutation.mutateAsync({ invoiceId, amount }),
    [financeMutation],
  );
  const settleInvoice = useCallback(
    (invoiceId: string, settlementReference: string) =>
      settleMutation.mutateAsync({ invoiceId, settlementReference }),
    [settleMutation],
  );
  const disputeInvoice = useCallback(
    (invoiceId: string, reason: string) =>
      disputeMutation.mutateAsync({ invoiceId, reason }),
    [disputeMutation],
  );
  const refetch = useCallback(async () => {
    createMutation.reset();
    financeMutation.reset();
    settleMutation.reset();
    disputeMutation.reset();
    await Promise.all([
      invoicesQuery.refetch(),
      financingQuery.refetch(),
      analyticsQuery.refetch(),
      ...(businessId ? [creditQuery.refetch()] : []),
    ]);
  }, [
    analyticsQuery,
    businessId,
    createMutation,
    creditQuery,
    disputeMutation,
    financeMutation,
    financingQuery,
    invoicesQuery,
    settleMutation,
  ]);

  return {
    invoices,
    financingRequests,
    creditScore,
    analytics,
    isLoading:
      invoicesQuery.isLoading ||
      analyticsQuery.isLoading ||
      (invoiceIds.length > 0 && financingQuery.isLoading) ||
      (businessId ? creditQuery.isLoading : false),
    isMutating:
      createMutation.isPending ||
      financeMutation.isPending ||
      settleMutation.isPending ||
      disputeMutation.isPending,
    error:
      invoicesQuery.error ||
      financingQuery.error ||
      (businessId ? creditQuery.error : null) ||
      null,
    analyticsError: analyticsQuery.error || null,
    actionError:
      createMutation.error ||
      financeMutation.error ||
      settleMutation.error ||
      disputeMutation.error ||
      null,
    refetch,
    createInvoice: createMutation.mutateAsync,
    requestFinancing,
    settleInvoice,
    disputeInvoice,
  };
}
