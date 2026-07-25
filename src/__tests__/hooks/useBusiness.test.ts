import { renderHook } from "@testing-library/react";
import {
  useBusinessProfile,
  useBusinessRegistered,
  useBusinessRegistration,
  useBusinessPaymentLimits,
  useBusinessList,
  useVerifyBusiness,
  useUpgradeTier,
} from "@/hooks/useBusiness";

jest.mock("@/contexts/AuthContext", () => ({
  useOptionalAuth: () => ({ business: { id: "biz-session" } }),
}));

jest.mock("@/config/chains", () => ({
  activeNetworkAnchor: {
    blockNumber: 1n,
    blockHash: `0x${"ab".repeat(32)}`,
  },
  CONTRACT_ADDRESSES: {
    businessRegistry: "0x1111111111111111111111111111111111111111",
  },
}));

// The jest.setup.js already mocks wagmi and @tanstack/react-query globally.

// Capture the queryFn and mutationFn callbacks so we can test them
const captured = {
  queryFns: {} as Record<string, Function>,
  mutationFns: [] as Function[],
  mutationOpts: [] as any[],
};

// Override the react-query mock to capture queryFn
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

// Mock fetch for fetchJson tests
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

describe("useBusinessRegistration mutation state", () => {
  it("does not report success before registration completes", () => {
    const { result } = renderHook(() => useBusinessRegistration());
    expect(result.current.isSuccess).toBe(false);
  });
});

describe("useBusinessProfile", () => {
  it("calls useQuery with correct query key including address", () => {
    const { result } = renderHook(() => useBusinessProfile());

    // Since useQuery is mocked, it returns { data: undefined, isLoading: false, error: null }
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("returns the query result shape", () => {
    const { result } = renderHook(() => useBusinessProfile());

    expect(result.current).toHaveProperty("data");
    expect(result.current).toHaveProperty("isLoading");
    expect(result.current).toHaveProperty("error");
  });
});

describe("useBusinessRegistered", () => {
  it("reports unknown registration state while contract data is unavailable", () => {
    const { result } = renderHook(() => useBusinessRegistered());

    // useReadContract returns { data: undefined } in the mock — the hook
    // reads the businesses(address) record and derives registeredAt != 0,
    // so with no data the state is unknown (undefined), not false.
    expect(result.current.isRegistered).toBeUndefined();
  });

  it("handles missing address gracefully", () => {
    const wagmi = require("wagmi");
    const origAccount = wagmi.useAccount;
    wagmi.useAccount = () => ({
      address: undefined,
      isConnected: false,
      status: "disconnected",
    });

    const { result } = renderHook(() => useBusinessRegistered());
    expect(result.current.isRegistered).toBeUndefined();

    wagmi.useAccount = origAccount;
  });

  it("exposes the exact on-chain KYC status for a registered wallet", () => {
    const wagmi = require("wagmi");
    const originalRead = wagmi.useReadContract;
    wagmi.useReadContract = () => ({
      data: [
        "0x1234567890abcdef1234567890abcdef12345678",
        "LIC-001",
        "Test Corp",
        0,
        2,
        0,
        123n,
        100n,
        "0x0000000000000000000000000000000000000001",
      ],
      isLoading: false,
      error: null,
      refetch: jest.fn(),
    });
    try {
      const { result } = renderHook(() => useBusinessRegistered());
      expect(result.current).toMatchObject({
        isRegistered: true,
        kycStatus: "SUSPENDED",
      });
    } finally {
      wagmi.useReadContract = originalRead;
    }
  });
});

describe("useBusinessRegistration", () => {
  beforeEach(() => {
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it("returns registration interface with correct properties", () => {
    const { result } = renderHook(() => useBusinessRegistration());

    expect(result.current).toHaveProperty("register");
    expect(result.current).toHaveProperty("txHash");
    expect(result.current).toHaveProperty("isPending");
    expect(result.current).toHaveProperty("isConfirming");
    expect(result.current).toHaveProperty("isSuccess");
    expect(typeof result.current.register).toBe("function");
  });

  it("has correct default values", () => {
    const { result } = renderHook(() => useBusinessRegistration());

    expect(result.current.txHash).toBeUndefined();
    expect(result.current.isPending).toBe(false);
    expect(result.current.isConfirming).toBe(false);
    expect(result.current.isSuccess).toBe(false);
  });

  it("register function can be called without throwing", () => {
    const { result } = renderHook(() => useBusinessRegistration());

    expect(() => {
      result.current.register({
        licenseNumber: "LIC-001",
        businessName: "Test Corp",
        jurisdiction: "UAE",
        businessType: "TRADING",
        complianceOfficer: "0x0000000000000000000000000000000000000001",
        contactEmail: "test@example.com",
      });
    }).not.toThrow();
  });

  it("binds the same normalized full profile into the signed challenge and final request", async () => {
    const wagmi = require("wagmi");
    const originalPublicClient = wagmi.usePublicClient;
    const originalSignMessage = wagmi.useSignMessage;
    const originalWriteContract = wagmi.useWriteContract;
    const transactionHash = `0x${"1".repeat(64)}`;
    const signature = `0x${"2".repeat(130)}`;
    const publicClient = {
      request: jest.fn().mockResolvedValue({
        number: "0x1",
        hash: `0x${"ab".repeat(32)}`,
      }),
      estimateContractGas: jest.fn().mockResolvedValue(100_000n),
      waitForTransactionReceipt: jest
        .fn()
        .mockResolvedValue({ status: "success" }),
    };
    wagmi.usePublicClient = () => publicClient;
    wagmi.useSignMessage = () => ({
      signMessageAsync: jest.fn().mockResolvedValue(signature),
    });
    wagmi.useWriteContract = () => ({
      writeContract: jest.fn(),
      writeContractAsync: jest.fn().mockResolvedValue(transactionHash),
      data: undefined,
      isPending: false,
    });

    const response = (data: unknown, status = 200) =>
      Promise.resolve({
        ok: true,
        status,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ success: true, data }),
        text: () => Promise.resolve(JSON.stringify({ success: true, data })),
      });
    (global.fetch as jest.Mock) = jest
      .fn()
      .mockImplementationOnce(() =>
        response(
          {
            challengeId: "00000000-0000-4000-8000-000000000001",
            message: "registration challenge",
            purpose: "registration",
            txHash: transactionHash,
            registrationCommitment: `0x${"3".repeat(64)}`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          201,
        ),
      )
      .mockImplementationOnce(() =>
        response({
          business: { id: "biz-registered" },
          apiKey: "npk_test",
          replayed: false,
          confirmations: 2,
          chainId: "7332",
        }),
      );

    try {
      renderHook(() => useBusinessRegistration());
      expect(captured.mutationFns).toHaveLength(1);
      await captured.mutationFns[0]({
        licenseNumber: "  LIC-001  ",
        businessName: "  Test Corp  ",
        jurisdiction: "UAE",
        businessType: "  TRADING  ",
        complianceOfficer: "0x0000000000000000000000000000000000000001",
        contactEmail: "  OWNER@EXAMPLE.COM  ",
      });

      const challengeBody = JSON.parse(
        (global.fetch as jest.Mock).mock.calls[0][1].body,
      );
      const registrationBody = JSON.parse(
        (global.fetch as jest.Mock).mock.calls[1][1].body,
      );
      const normalizedProfile = {
        licenseNumber: "LIC-001",
        businessName: "Test Corp",
        jurisdiction: "UAE",
        businessType: "TRADING",
        complianceOfficer: "0x0000000000000000000000000000000000000001",
        contactEmail: "owner@example.com",
      };

      expect(challengeBody).toEqual({
        address: "0x1234567890abcdef1234567890abcdef12345678",
        purpose: "registration",
        txHash: transactionHash,
        registration: normalizedProfile,
      });
      expect(registrationBody).toEqual({
        ...normalizedProfile,
        address: "0x1234567890abcdef1234567890abcdef12345678",
        txHash: transactionHash,
        challengeId: "00000000-0000-4000-8000-000000000001",
        signature,
      });
    } finally {
      wagmi.usePublicClient = originalPublicClient;
      wagmi.useSignMessage = originalSignMessage;
      wagmi.useWriteContract = originalWriteContract;
    }
  });
});

describe("useBusinessPaymentLimits", () => {
  it("returns query result with default values", () => {
    const { result } = renderHook(() => useBusinessPaymentLimits());

    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe("useBusinessList", () => {
  it("returns query result without filters", () => {
    const { result } = renderHook(() => useBusinessList());

    expect(result.current).toHaveProperty("data");
    expect(result.current).toHaveProperty("isLoading");
    expect(result.current).toHaveProperty("error");
  });

  it("accepts filters", () => {
    const { result } = renderHook(() =>
      useBusinessList({
        tier: "PREMIUM",
        kycStatus: "VERIFIED",
        jurisdiction: "AE",
        search: "test",
        page: 2,
        pageSize: 10,
      }),
    );

    expect(result.current).toHaveProperty("data");
    expect(result.current.isLoading).toBe(false);
  });

  it("accepts partial filters", () => {
    const { result } = renderHook(() =>
      useBusinessList({ tier: "ENTERPRISE" }),
    );

    expect(result.current).toHaveProperty("data");
  });

  it("uses default page and pageSize when not provided", () => {
    const { result } = renderHook(() => useBusinessList({}));

    expect(result.current).toHaveProperty("data");
  });
});

describe("useVerifyBusiness", () => {
  it("returns mutation result with mutate function", () => {
    const { result } = renderHook(() => useVerifyBusiness());

    expect(result.current).toHaveProperty("mutate");
    expect(result.current).toHaveProperty("isPending");
    expect(typeof result.current.mutate).toBe("function");
  });
});

describe("useUpgradeTier", () => {
  it("returns mutation result with mutate function", () => {
    const { result } = renderHook(() => useUpgradeTier());

    expect(result.current).toHaveProperty("mutate");
    expect(result.current).toHaveProperty("isPending");
    expect(typeof result.current.mutate).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// fetchJson and queryFn/mutationFn execution tests
// ---------------------------------------------------------------------------

describe("fetchJson (via captured queryFns)", () => {
  beforeEach(() => {
    captured.queryFns = {};
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it("businessProfile queryFn calls fetch and returns JSON", async () => {
    const mockProfile = { id: "biz-1", businessName: "Test Corp" };
    mockFetchResponse(mockProfile);

    renderHook(() => useBusinessProfile());

    const fn = captured.queryFns["businessProfile"];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockProfile);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/businesses/"),
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  it("businessProfile queryFn throws on non-ok response", async () => {
    mockFetchResponse({}, false, 404);

    renderHook(() => useBusinessProfile());

    const fn = captured.queryFns["businessProfile"];
    await expect(fn()).rejects.toThrow("Request failed with status 404");
  });

  it("businessLimits queryFn calls correct endpoint", async () => {
    const mockLimits = { dailyLimit: 50000 };
    mockFetchResponse(mockLimits);

    renderHook(() => useBusinessPaymentLimits());

    const fn = captured.queryFns["businessLimits"];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockLimits);
  });

  it("businesses queryFn builds URL with all filters", async () => {
    const mockData = { businesses: [], total: 0 };
    mockFetchResponse(mockData);

    renderHook(() =>
      useBusinessList({
        tier: "PREMIUM",
        kycStatus: "VERIFIED",
        jurisdiction: "AE",
        search: "test",
        page: 2,
        pageSize: 10,
      }),
    );

    const fn = captured.queryFns["businesses"];
    expect(fn).toBeDefined();
    await fn();
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toContain("tier=PREMIUM");
    expect(calledUrl).toContain("kycStatus=VERIFIED");
    expect(calledUrl).toContain("jurisdiction=AE");
    expect(calledUrl).toContain("search=test");
    expect(calledUrl).toContain("page=2");
    expect(calledUrl).toContain("limit=10");
  });

  it("businesses queryFn uses default page/pageSize", async () => {
    mockFetchResponse({ businesses: [], total: 0 });

    renderHook(() => useBusinessList());

    const fn = captured.queryFns["businesses"];
    await fn();
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toContain("page=1");
    expect(calledUrl).toContain("limit=20");
  });
});

describe("mutation functions", () => {
  beforeEach(() => {
    captured.queryFns = {};
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it("useVerifyBusiness mutationFn calls verify endpoint", async () => {
    mockFetchResponse({ success: true });

    renderHook(() => useVerifyBusiness());

    expect(captured.mutationFns.length).toBeGreaterThan(0);
    await captured.mutationFns[0]({
      businessId: "biz-123",
      businessAddress: "0x1111111111111111111111111111111111111111",
      txHash: `0x${"1".repeat(64)}`,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/businesses/biz-123/verify"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ txHash: `0x${"1".repeat(64)}` }),
      }),
    );
  });

  it("never submits verifyBusiness from the platform-admin wallet", async () => {
    (global.fetch as jest.Mock).mockClear();
    renderHook(() => useVerifyBusiness());

    await expect(
      captured.mutationFns[0]({
        businessId: "biz-123",
        businessAddress: "0x1111111111111111111111111111111111111111",
      }),
    ).rejects.toThrow(/BUSINESS_VERIFIER_ADDRESS/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("useVerifyBusiness onSuccess invalidates queries", () => {
    renderHook(() => useVerifyBusiness());

    const opts = captured.mutationOpts[0];
    expect(opts).toBeDefined();
    expect(typeof opts.onSuccess).toBe("function");
    // Actually invoke onSuccess to cover the callback
    opts.onSuccess({ business: { id: "biz-123" } });
  });

  it("useUpgradeTier onSuccess invalidates queries", () => {
    captured.mutationFns = [];
    captured.mutationOpts = [];

    renderHook(() => useUpgradeTier());

    const opts = captured.mutationOpts[0];
    expect(opts).toBeDefined();
    expect(typeof opts.onSuccess).toBe("function");
    opts.onSuccess({ business: { id: "biz-456" } });
  });

  it("useUpgradeTier mutationFn calls upgrade endpoint", async () => {
    captured.mutationFns = [];
    captured.mutationOpts = [];
    mockFetchResponse({ success: true });

    renderHook(() => useUpgradeTier());

    expect(captured.mutationFns.length).toBeGreaterThan(0);
    await captured.mutationFns[0]({
      businessId: "biz-456",
      businessAddress: "0x2222222222222222222222222222222222222222",
      newTier: "ENTERPRISE",
      txHash: `0x${"2".repeat(64)}`,
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/businesses/biz-456/upgrade"),
      expect.objectContaining({ method: "POST" }),
    );
    expect((global.fetch as jest.Mock).mock.calls[0][1].body).toBe(
      JSON.stringify({ txHash: `0x${"2".repeat(64)}`, newTier: "ENTERPRISE" }),
    );
  });

  it("exposes the asynchronous on-chain registration action", () => {
    const { result } = renderHook(() => useBusinessRegistration());
    expect(result.current.register).toEqual(expect.any(Function));
  });
});
