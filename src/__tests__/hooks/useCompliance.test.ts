import { renderHook } from "@testing-library/react";
import {
  useComplianceStatus,
  useScreeningResult,
  useComplianceMetrics,
  useSanctionsListStatus,
  useFlaggedPayments,
  useReviewFlaggedPayment,
  useUpdateSanctionsList,
  useSubmitScreening,
  useAuthorizeTravelRule,
} from "@/hooks/useCompliance";

const mockSignMessageAsync = jest.fn();

jest.mock("wagmi", () => ({
  useSignMessage: () => ({ signMessageAsync: mockSignMessageAsync }),
}));

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
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
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

describe("useComplianceStatus", () => {
  it("returns query result with correct shape", () => {
    const { result } = renderHook(() => useComplianceStatus());

    expect(result.current).toHaveProperty("data");
    expect(result.current).toHaveProperty("isLoading");
    expect(result.current).toHaveProperty("error");
  });

  it("starts with no data loaded", () => {
    const { result } = renderHook(() => useComplianceStatus());

    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe("useScreeningResult", () => {
  it("returns query result when paymentId is provided", () => {
    const { result } = renderHook(() => useScreeningResult("pay-001"));

    expect(result.current).toHaveProperty("data");
    expect(result.current).toHaveProperty("isLoading");
    expect(result.current).toHaveProperty("error");
  });

  it("handles undefined paymentId gracefully", () => {
    const { result } = renderHook(() => useScreeningResult(undefined));

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });
});

describe("useComplianceMetrics", () => {
  it("returns query result shape", () => {
    const { result } = renderHook(() => useComplianceMetrics());

    expect(result.current).toHaveProperty("data");
    expect(result.current).toHaveProperty("isLoading");
    expect(result.current).toHaveProperty("error");
    expect(result.current.isLoading).toBe(false);
  });
});

describe("useSanctionsListStatus", () => {
  it("returns query result shape", () => {
    const { result } = renderHook(() => useSanctionsListStatus());

    expect(result.current).toHaveProperty("data");
    expect(result.current).toHaveProperty("isLoading");
    expect(result.current).toHaveProperty("error");
  });
});

describe("useFlaggedPayments", () => {
  it("returns query result shape", () => {
    const { result } = renderHook(() => useFlaggedPayments());

    expect(result.current).toHaveProperty("data");
    expect(result.current).toHaveProperty("isLoading");
    expect(result.current).toHaveProperty("error");
  });
});

describe("useReviewFlaggedPayment", () => {
  it("returns mutation result with mutate function", () => {
    const { result } = renderHook(() => useReviewFlaggedPayment());

    expect(result.current).toHaveProperty("mutate");
    expect(result.current).toHaveProperty("isPending");
    expect(typeof result.current.mutate).toBe("function");
  });
});

describe("useUpdateSanctionsList", () => {
  it("returns mutation result with mutate function", () => {
    const { result } = renderHook(() => useUpdateSanctionsList());

    expect(result.current).toHaveProperty("mutate");
    expect(result.current).toHaveProperty("isPending");
    expect(typeof result.current.mutate).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// fetchJson and queryFn/mutationFn execution tests
// ---------------------------------------------------------------------------

describe("compliance queryFns", () => {
  beforeEach(() => {
    captured.queryFns = {};
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it("complianceStatus queryFn calls correct endpoint", async () => {
    const mockData = {
      engineStatus: "healthy",
      checkedAt: "2026-07-22T00:00:00.000Z",
      settlementEvidence: "verified_per_submission",
      sanctions: { status: "fresh" },
    };
    mockFetchResponse(mockData);

    renderHook(() => useComplianceStatus());

    const fn = captured.queryFns["complianceStatus"];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/compliance/status"),
      expect.any(Object),
    );
  });

  it("complianceStatus queryFn throws on error response", async () => {
    mockFetchResponse({}, false, 500);

    renderHook(() => useComplianceStatus());

    const fn = captured.queryFns["complianceStatus"];
    await expect(fn()).rejects.toThrow("Request failed with status 500");
  });

  it("screening queryFn calls correct endpoint", async () => {
    const mockData = { paymentId: "pay-001", sanctionsClear: true };
    mockFetchResponse(mockData);

    renderHook(() => useScreeningResult("pay-001"));

    const fn = captured.queryFns["screening"];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/compliance/screenings/pay-001"),
      expect.any(Object),
    );
  });

  it("complianceMetrics queryFn calls correct endpoint", async () => {
    const mockData = { totalScreenings: 100, passRate: 95 };
    mockFetchResponse(mockData);

    renderHook(() => useComplianceMetrics());

    const fn = captured.queryFns["complianceMetrics"];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
  });

  it("sanctionsListStatus queryFn calls correct endpoint", async () => {
    const mockData = [{ name: "OFAC", isFresh: true }];
    mockFetchResponse(mockData);

    renderHook(() => useSanctionsListStatus());

    const fn = captured.queryFns["sanctionsListStatus"];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
  });

  it("flaggedPayments queryFn calls correct endpoint", async () => {
    mockFetchResponse({
      success: true,
      data: [],
      pagination: { total: 0 },
    });

    renderHook(() => useFlaggedPayments());

    const fn = captured.queryFns["flaggedPayments"];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual({ payments: [], total: 0 });
  });
});

describe("compliance mutationFns", () => {
  beforeEach(() => {
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it("useReviewFlaggedPayment mutationFn calls review endpoint", async () => {
    mockFetchResponse({ success: true });

    renderHook(() => useReviewFlaggedPayment());

    expect(captured.mutationFns.length).toBeGreaterThan(0);
    await captured.mutationFns[0]({
      paymentId: "pay-001",
      decision: "escalate",
      reason: "Requires governed resolution",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/compliance/flagged/pay-001/review"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          decision: "escalate",
          reason: "Requires governed resolution",
        }),
      }),
    );
  });

  it("useReviewFlaggedPayment onSuccess invalidates queries", () => {
    renderHook(() => useReviewFlaggedPayment());

    expect(captured.mutationOpts.length).toBeGreaterThan(0);
    expect(typeof captured.mutationOpts[0].onSuccess).toBe("function");
    // Call onSuccess to verify it doesn't throw
    captured.mutationOpts[0].onSuccess();
  });

  it("useUpdateSanctionsList mutationFn calls update endpoint", async () => {
    mockFetchResponse({ success: true });

    renderHook(() => useUpdateSanctionsList());

    expect(captured.mutationFns.length).toBeGreaterThan(0);
    await captured.mutationFns[0]();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/compliance/sanctions/update"),
      expect.objectContaining({
        method: "POST",
        body: undefined,
      }),
    );
  });

  it("useUpdateSanctionsList onSuccess invalidates queries", () => {
    renderHook(() => useUpdateSanctionsList());

    expect(captured.mutationOpts.length).toBeGreaterThan(0);
    expect(typeof captured.mutationOpts[0].onSuccess).toBe("function");
    captured.mutationOpts[0].onSuccess();
  });

  it("useSubmitScreening sends the database record id and priority", async () => {
    mockFetchResponse({ success: true, data: { status: "PASSED" } });

    renderHook(() => useSubmitScreening());

    await captured.mutationFns[0]({
      paymentId: "record-uuid",
      priority: "high",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/compliance/screen"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ paymentId: "record-uuid", priority: "high" }),
      }),
    );
  });

  it("wallet-signs the exact Travel Rule challenge before authorization", async () => {
    const data = {
      originatorName: "Acme Trading LLC",
      originatorAccount: "AE-001",
      originatorAddress: "Dubai, AE",
      beneficiaryName: "Beneficiary Ltd",
      beneficiaryAccount: "GB-002",
    };
    const challengeId = "11111111-1111-4111-8111-111111111111";
    mockSignMessageAsync.mockResolvedValue(`0x${"ab".repeat(65)}`);
    document.cookie = "noblepay_csrf=test-csrf; path=/";
    (global.fetch as jest.Mock) = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: () =>
          Promise.resolve({
            success: true,
            data: {
              challengeId,
              message: "tenant-bound Travel Rule challenge",
              payloadCommitment: `0x${"cd".repeat(32)}`,
              expiresAt: "2026-07-22T00:05:00.000Z",
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: () =>
          Promise.resolve({
            success: true,
            data: { payloadCommitment: `0x${"cd".repeat(32)}` },
          }),
      });

    renderHook(() => useAuthorizeTravelRule());
    await captured.mutationFns[0]({ paymentId: "record-uuid", data });

    expect(mockSignMessageAsync).toHaveBeenCalledWith({
      message: "tenant-bound Travel Rule challenge",
    });
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/v1/compliance/travel-rule/challenge"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ paymentId: "record-uuid", data }),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/v1/compliance/travel-rule/authorize"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          paymentId: "record-uuid",
          challengeId,
          signature: `0x${"ab".repeat(65)}`,
          data,
        }),
      }),
    );
  });
});
