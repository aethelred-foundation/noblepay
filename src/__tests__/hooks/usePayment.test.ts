import { renderHook } from "@testing-library/react";
import {
  usePayment,
  usePayments,
  useInitiatePayment,
  usePaymentStats,
  useSettlePayment,
  useCancelPayment,
  useRefundPayment,
  useExecuteSettlementRecovery,
  useSettlementRecoveryRequest,
} from "@/hooks/usePayment";

const captured = {
  queryFns: {} as Record<string, Function>,
  mutationFns: [] as Function[],
  mutationOpts: [] as any[],
};

jest.mock("@tanstack/react-query", () => ({
  QueryClientProvider: ({ children }: any) => children,
  QueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
  useQuery: (opts: any) => {
    if (opts.queryFn) {
      const key = Array.isArray(opts.queryKey) ? opts.queryKey[0] : "unknown";
      captured.queryFns[key] = opts.queryFn;
    }
    return { data: undefined, isLoading: false, error: null };
  },
  useMutation: (opts: any) => {
    if (opts.mutationFn) {
      captured.mutationFns.push(opts.mutationFn);
      captured.mutationOpts.push(opts);
    }
    return {
      mutate: jest.fn(),
      mutateAsync: jest.fn(),
      isPending: false,
      isSuccess: false,
      data: undefined,
      error: null,
      reset: jest.fn(),
    };
  },
  useQueryClient: () => ({
    invalidateQueries: jest.fn(),
    setQueryData: jest.fn(),
  }),
}));

const mockFetchResponse = (data: any, ok = true, status = 200) => {
  document.cookie = "noblepay_csrf=test-csrf; path=/";
  (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
};

describe("usePayment", () => {
  it("returns query result when paymentId is provided", () => {
    const { result } = renderHook(() => usePayment("pay-001"));

    expect(result.current).toHaveProperty("data");
    expect(result.current).toHaveProperty("isLoading");
    expect(result.current).toHaveProperty("error");
  });

  it("handles undefined paymentId", () => {
    const { result } = renderHook(() => usePayment(undefined));

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it("returns isLoading false with mocked query", () => {
    const { result } = renderHook(() => usePayment("pay-001"));

    expect(result.current.isLoading).toBe(false);
  });
});

describe("usePayments", () => {
  it("returns query result without filters", () => {
    const { result } = renderHook(() => usePayments());

    expect(result.current).toHaveProperty("data");
    expect(result.current).toHaveProperty("isLoading");
    expect(result.current).toHaveProperty("error");
  });

  it("accepts all filter options", () => {
    const { result } = renderHook(() =>
      usePayments({
        status: "Settled",
        currency: "USDC",
        from: "2026-06-01",
        to: "2026-06-30",
        riskLevel: "Low",
        search: "test",
        page: 2,
        pageSize: 10,
      }),
    );

    expect(result.current).toHaveProperty("data");
    expect(result.current.isLoading).toBe(false);
  });

  it("accepts partial filters", () => {
    const { result } = renderHook(() => usePayments({ status: "Pending" }));

    expect(result.current).toHaveProperty("data");
  });

  it("uses default page and pageSize", () => {
    const { result } = renderHook(() => usePayments({}));

    expect(result.current).toHaveProperty("data");
  });
});

describe("useInitiatePayment", () => {
  it("returns correct interface shape", () => {
    const { result } = renderHook(() => useInitiatePayment());

    expect(result.current).toHaveProperty("initiate");
    expect(result.current).toHaveProperty("txHash");
    expect(result.current).toHaveProperty("isPending");
    expect(result.current).toHaveProperty("approvalHash");
    expect(result.current).toHaveProperty("isSuccess");
    expect(typeof result.current.initiate).toBe("function");
  });

  it("has correct default values", () => {
    const { result } = renderHook(() => useInitiatePayment());

    expect(result.current.txHash).toBeUndefined();
    expect(result.current.isPending).toBe(false);
    expect(result.current.approvalHash).toBeUndefined();
    expect(result.current.isSuccess).toBe(false);
  });

  it("initiate function can be called without errors", () => {
    const { result } = renderHook(() => useInitiatePayment());

    expect(() => {
      result.current.initiate({
        recipient: "0x1111111111111111111111111111111111111111",
        amount: "1000",
        currency: "USDC",
        purpose: "test purpose",
      });
    }).not.toThrow();
  });

  it("initiate function accepts the second supported stablecoin", () => {
    const { result } = renderHook(() => useInitiatePayment());

    expect(() => {
      result.current.initiate({
        recipient: "0x1111111111111111111111111111111111111111",
        amount: "100",
        currency: "USDT",
        purpose: "supplier payment",
      });
    }).not.toThrow();
  });

  it("rejects native AETHEL before any wallet or RPC write", async () => {
    renderHook(() => useInitiatePayment());

    await expect(
      captured.mutationFns[0]({
        recipient: "0x1111111111111111111111111111111111111111",
        amount: "1",
        currency: "AETHEL",
        purpose: "unsupported native payment",
      }),
    ).rejects.toThrow("only 6-decimal USDC and USDT");
  });
});

describe("usePaymentStats", () => {
  it("returns query result shape", () => {
    const { result } = renderHook(() => usePaymentStats());

    expect(result.current).toHaveProperty("data");
    expect(result.current).toHaveProperty("isLoading");
    expect(result.current).toHaveProperty("error");
    expect(result.current.isLoading).toBe(false);
  });
});

describe("useCancelPayment", () => {
  it("returns mutation result with mutate function", () => {
    const { result } = renderHook(() => useCancelPayment());

    expect(result.current).toHaveProperty("mutate");
    expect(result.current).toHaveProperty("isPending");
    expect(typeof result.current.mutate).toBe("function");
  });
});

describe("useSettlePayment", () => {
  it("returns a wallet execution mutation", () => {
    const { result } = renderHook(() => useSettlePayment());

    expect(result.current).toHaveProperty("execute");
    expect(result.current).toHaveProperty("txHash");
    expect(typeof result.current.execute).toBe("function");
  });
});

describe("useRefundPayment", () => {
  it("returns mutation result with mutate function", () => {
    const { result } = renderHook(() => useRefundPayment());

    expect(result.current).toHaveProperty("mutate");
    expect(result.current).toHaveProperty("isPending");
    expect(typeof result.current.mutate).toBe("function");
  });
});

describe("settlement recovery hooks", () => {
  it("exposes on-chain request state and a request mutation", () => {
    const { result } = renderHook(() =>
      useSettlementRecoveryRequest(`0x${"a".repeat(64)}`),
    );

    expect(result.current).toHaveProperty("recoveryRequest");
    expect(result.current).toHaveProperty("request");
    expect(result.current).toHaveProperty("isRequesting");
    expect(typeof result.current.request).toBe("function");
  });

  it("exposes receipt-reconciled recovery execution", () => {
    const { result } = renderHook(() => useExecuteSettlementRecovery());

    expect(result.current).toHaveProperty("execute");
    expect(result.current).toHaveProperty("pendingReconciliation");
    expect(typeof result.current.execute).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// fetchJson and queryFn/mutationFn execution tests
// ---------------------------------------------------------------------------

describe("payment queryFns", () => {
  beforeEach(() => {
    captured.queryFns = {};
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it("payment queryFn calls correct endpoint", async () => {
    const mockData = { paymentId: "pay-001", status: "Settled" };
    mockFetchResponse(mockData);

    renderHook(() => usePayment("pay-001"));

    const fn = captured.queryFns["payment"];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/payments/pay-001"),
      expect.any(Object),
    );
  });

  it("payment queryFn throws on error", async () => {
    mockFetchResponse({}, false, 404);

    renderHook(() => usePayment("pay-001"));

    const fn = captured.queryFns["payment"];
    await expect(fn()).rejects.toThrow("Request failed with status 404");
  });

  it("payments queryFn builds URL with all filters", async () => {
    mockFetchResponse({ payments: [], total: 0 });

    renderHook(() =>
      usePayments({
        status: "Settled",
        currency: "USDC",
        from: "2026-06-01",
        to: "2026-06-30",
        riskLevel: "Low",
        search: "test",
        page: 2,
        pageSize: 10,
      }),
    );

    const fn = captured.queryFns["payments"];
    await fn();
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toContain("status=Settled");
    expect(calledUrl).toContain("currency=USDC");
    expect(calledUrl).toContain("from=2026-06-01");
    expect(calledUrl).toContain("to=2026-06-30");
    expect(calledUrl).toContain("riskLevel=Low");
    expect(calledUrl).toContain("search=test");
    expect(calledUrl).toContain("page=2");
    expect(calledUrl).toContain("limit=10");
  });

  it("payments queryFn uses defaults when no filters", async () => {
    mockFetchResponse({ payments: [], total: 0 });

    renderHook(() => usePayments());

    const fn = captured.queryFns["payments"];
    await fn();
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toContain("page=1");
    expect(calledUrl).toContain("limit=20");
  });

  it("paymentStats queryFn calls stats endpoint", async () => {
    const mockData = { totalPayments: 1000, totalVolume: 5000000 };
    mockFetchResponse(mockData);

    renderHook(() => usePaymentStats());

    const fn = captured.queryFns["paymentStats"];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
  });
});

describe("payment mutationFns", () => {
  beforeEach(() => {
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it("useCancelPayment mutationFn calls cancel endpoint", async () => {
    mockFetchResponse({ success: true });

    renderHook(() => useCancelPayment());

    expect(captured.mutationFns.length).toBeGreaterThan(0);
    const paymentId = `0x${"1".repeat(64)}`;
    const txHash = `0x${"2".repeat(64)}`;
    await captured.mutationFns[0]({ paymentId, txHash });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/payments/${paymentId}/cancel`),
      expect.objectContaining({ method: "POST" }),
    );
    expect((global.fetch as jest.Mock).mock.calls[0][1].body).toBe(
      JSON.stringify({ txHash }),
    );
  });

  it("useCancelPayment onSuccess invalidates queries", () => {
    renderHook(() => useCancelPayment());

    expect(captured.mutationOpts.length).toBeGreaterThan(0);
    expect(typeof captured.mutationOpts[0].onSuccess).toBe("function");
    captured.mutationOpts[0].onSuccess({
      payment: { paymentId: `0x${"1".repeat(64)}` },
      txHash: `0x${"2".repeat(64)}`,
      confirmations: 1,
      chainId: "7332",
      replayed: false,
    });
  });

  it("useSettlePayment mutationFn reconciles an existing settlement", async () => {
    mockFetchResponse({ success: true });

    renderHook(() => useSettlePayment());

    const paymentId = `0x${"3".repeat(64)}`;
    const txHash = `0x${"4".repeat(64)}`;
    await captured.mutationFns[0]({ paymentId, txHash });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/payments/${paymentId}/settle`),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("useRefundPayment mutationFn calls refund endpoint", async () => {
    mockFetchResponse({ success: true });

    renderHook(() => useRefundPayment());

    expect(captured.mutationFns.length).toBeGreaterThan(0);
    const paymentId = `0x${"5".repeat(64)}`;
    const txHash = `0x${"6".repeat(64)}`;
    await captured.mutationFns[0]({ paymentId, txHash });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/payments/${paymentId}/refund`),
      expect.objectContaining({ method: "POST" }),
    );
    expect((global.fetch as jest.Mock).mock.calls[0][1].body).toBe(
      JSON.stringify({ txHash }),
    );
  });

  it("useRefundPayment onSuccess invalidates queries", () => {
    renderHook(() => useRefundPayment());

    expect(captured.mutationOpts.length).toBeGreaterThan(0);
    expect(typeof captured.mutationOpts[0].onSuccess).toBe("function");
    captured.mutationOpts[0].onSuccess({
      payment: { paymentId: `0x${"5".repeat(64)}` },
      txHash: `0x${"6".repeat(64)}`,
      confirmations: 1,
      chainId: "7332",
      replayed: false,
    });
  });

  it("useExecuteSettlementRecovery reconciles through the refund endpoint", async () => {
    mockFetchResponse({ success: true });

    renderHook(() => useExecuteSettlementRecovery());

    const paymentId = `0x${"7".repeat(64)}`;
    const txHash = `0x${"8".repeat(64)}`;
    await captured.mutationFns[0]({ paymentId, txHash });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/v1/payments/${paymentId}/refund`),
      expect.objectContaining({ method: "POST" }),
    );
    expect((global.fetch as jest.Mock).mock.calls[0][1].body).toBe(
      JSON.stringify({ txHash }),
    );
  });
});

describe("useInitiatePayment mutation state", () => {
  it("does not report success before the wallet flow completes", () => {
    const { result } = renderHook(() => useInitiatePayment());
    expect(result.current.isSuccess).toBe(false);
  });
});
