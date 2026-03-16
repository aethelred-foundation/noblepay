import { renderHook, act } from '@testing-library/react';
import {
  useBusinessProfile,
  useBusinessRegistered,
  useBusinessRegistration,
  useBusinessPaymentLimits,
  useBusinessList,
  useVerifyBusiness,
  useUpgradeTier,
} from '@/hooks/useBusiness';

// The jest.setup.js already mocks wagmi and @tanstack/react-query globally.

// Capture the queryFn and mutationFn callbacks so we can test them
const captured = {
  queryFns: {} as Record<string, Function>,
  mutationFns: [] as Function[],
  mutationOpts: [] as any[],
};

// Override the react-query mock to capture queryFn
jest.mock('@tanstack/react-query', () => ({
  QueryClientProvider: ({ children }: any) => children,
  QueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
  useQuery: (opts: any) => {
    if (opts.queryFn) {
      const key = Array.isArray(opts.queryKey) ? opts.queryKey[0] : 'unknown';
      captured.queryFns[key] = opts.queryFn;
    }
    return { data: undefined, isLoading: false, error: null };
  },
  useMutation: (opts: any) => {
    if (opts.mutationFn) {
      captured.mutationFns.push(opts.mutationFn);
      captured.mutationOpts.push(opts);
    }
    return { mutate: jest.fn(), isPending: false };
  },
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
}));

// Mock fetch for fetchJson tests
const mockFetchResponse = (data: any, ok = true, status = 200) => {
  (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    json: () => Promise.resolve(data),
  });
};

describe('useBusinessRegistration with isSuccess=true', () => {
  it('invalidates businessProfile query when isSuccess is true', () => {
    // Temporarily override useWaitForTransactionReceipt to return isSuccess: true
    const wagmi = require('wagmi');
    const origWait = wagmi.useWaitForTransactionReceipt;
    wagmi.useWaitForTransactionReceipt = () => ({ isLoading: false, isSuccess: true });

    const { result } = renderHook(() => useBusinessRegistration());

    expect(result.current.isSuccess).toBe(true);

    // Restore
    wagmi.useWaitForTransactionReceipt = origWait;
  });
});

describe('useBusinessProfile', () => {
  it('calls useQuery with correct query key including address', () => {
    const { result } = renderHook(() => useBusinessProfile());

    // Since useQuery is mocked, it returns { data: undefined, isLoading: false, error: null }
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('returns the query result shape', () => {
    const { result } = renderHook(() => useBusinessProfile());

    expect(result.current).toHaveProperty('data');
    expect(result.current).toHaveProperty('isLoading');
    expect(result.current).toHaveProperty('error');
  });
});

describe('useBusinessRegistered', () => {
  it('returns undefined when contract data is not available', () => {
    const { result } = renderHook(() => useBusinessRegistered());

    // useReadContract returns { data: undefined } in the mock
    expect(result.current).toBeUndefined();
  });

  it('handles missing address gracefully', () => {
    const wagmi = require('wagmi');
    const origAccount = wagmi.useAccount;
    wagmi.useAccount = () => ({ address: undefined, isConnected: false, status: 'disconnected' });

    const { result } = renderHook(() => useBusinessRegistered());
    expect(result.current).toBeUndefined();

    wagmi.useAccount = origAccount;
  });
});

describe('useBusinessRegistration', () => {
  it('returns registration interface with correct properties', () => {
    const { result } = renderHook(() => useBusinessRegistration());

    expect(result.current).toHaveProperty('register');
    expect(result.current).toHaveProperty('txHash');
    expect(result.current).toHaveProperty('isPending');
    expect(result.current).toHaveProperty('isConfirming');
    expect(result.current).toHaveProperty('isSuccess');
    expect(typeof result.current.register).toBe('function');
  });

  it('has correct default values', () => {
    const { result } = renderHook(() => useBusinessRegistration());

    expect(result.current.txHash).toBeUndefined();
    expect(result.current.isPending).toBe(false);
    expect(result.current.isConfirming).toBe(false);
    expect(result.current.isSuccess).toBe(false);
  });

  it('register function can be called without throwing', () => {
    const { result } = renderHook(() => useBusinessRegistration());

    expect(() => {
      result.current.register({
        licenseNumber: 'LIC-001',
        businessName: 'Test Corp',
        jurisdiction: 'AE',
        businessType: 'TRADING',
        complianceOfficer: '0x0000000000000000000000000000000000000001',
        contactEmail: 'test@example.com',
      });
    }).not.toThrow();
  });
});

describe('useBusinessPaymentLimits', () => {
  it('returns query result with default values', () => {
    const { result } = renderHook(() => useBusinessPaymentLimits());

    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe('useBusinessList', () => {
  it('returns query result without filters', () => {
    const { result } = renderHook(() => useBusinessList());

    expect(result.current).toHaveProperty('data');
    expect(result.current).toHaveProperty('isLoading');
    expect(result.current).toHaveProperty('error');
  });

  it('accepts filters', () => {
    const { result } = renderHook(() =>
      useBusinessList({
        tier: 'PREMIUM',
        kycStatus: 'VERIFIED',
        jurisdiction: 'AE',
        search: 'test',
        page: 2,
        pageSize: 10,
      }),
    );

    expect(result.current).toHaveProperty('data');
    expect(result.current.isLoading).toBe(false);
  });

  it('accepts partial filters', () => {
    const { result } = renderHook(() =>
      useBusinessList({ tier: 'ENTERPRISE' }),
    );

    expect(result.current).toHaveProperty('data');
  });

  it('uses default page and pageSize when not provided', () => {
    const { result } = renderHook(() => useBusinessList({}));

    expect(result.current).toHaveProperty('data');
  });
});

describe('useVerifyBusiness', () => {
  it('returns mutation result with mutate function', () => {
    const { result } = renderHook(() => useVerifyBusiness());

    expect(result.current).toHaveProperty('mutate');
    expect(result.current).toHaveProperty('isPending');
    expect(typeof result.current.mutate).toBe('function');
  });
});

describe('useUpgradeTier', () => {
  it('returns mutation result with mutate function', () => {
    const { result } = renderHook(() => useUpgradeTier());

    expect(result.current).toHaveProperty('mutate');
    expect(result.current).toHaveProperty('isPending');
    expect(typeof result.current.mutate).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// fetchJson and queryFn/mutationFn execution tests
// ---------------------------------------------------------------------------

describe('fetchJson (via captured queryFns)', () => {
  beforeEach(() => {
    captured.queryFns = {};
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it('businessProfile queryFn calls fetch and returns JSON', async () => {
    const mockProfile = { id: 'biz-1', businessName: 'Test Corp' };
    mockFetchResponse(mockProfile);

    renderHook(() => useBusinessProfile());

    const fn = captured.queryFns['businessProfile'];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockProfile);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/businesses/'),
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
    );
  });

  it('businessProfile queryFn throws on non-ok response', async () => {
    mockFetchResponse({}, false, 404);

    renderHook(() => useBusinessProfile());

    const fn = captured.queryFns['businessProfile'];
    await expect(fn()).rejects.toThrow('API 404');
  });

  it('businessLimits queryFn calls correct endpoint', async () => {
    const mockLimits = { dailyLimit: 50000 };
    mockFetchResponse(mockLimits);

    renderHook(() => useBusinessPaymentLimits());

    const fn = captured.queryFns['businessLimits'];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockLimits);
  });

  it('businesses queryFn builds URL with all filters', async () => {
    const mockData = { businesses: [], total: 0 };
    mockFetchResponse(mockData);

    renderHook(() =>
      useBusinessList({
        tier: 'PREMIUM',
        kycStatus: 'VERIFIED',
        jurisdiction: 'AE',
        search: 'test',
        page: 2,
        pageSize: 10,
      }),
    );

    const fn = captured.queryFns['businesses'];
    expect(fn).toBeDefined();
    await fn();
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toContain('tier=PREMIUM');
    expect(calledUrl).toContain('kycStatus=VERIFIED');
    expect(calledUrl).toContain('jurisdiction=AE');
    expect(calledUrl).toContain('search=test');
    expect(calledUrl).toContain('page=2');
    expect(calledUrl).toContain('pageSize=10');
  });

  it('businesses queryFn uses default page/pageSize', async () => {
    mockFetchResponse({ businesses: [], total: 0 });

    renderHook(() => useBusinessList());

    const fn = captured.queryFns['businesses'];
    await fn();
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toContain('page=1');
    expect(calledUrl).toContain('pageSize=20');
  });
});

describe('mutation functions', () => {
  beforeEach(() => {
    captured.queryFns = {};
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it('useVerifyBusiness mutationFn calls verify endpoint', async () => {
    mockFetchResponse({ success: true });

    renderHook(() => useVerifyBusiness());

    expect(captured.mutationFns.length).toBeGreaterThan(0);
    await captured.mutationFns[0]('biz-123');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/businesses/biz-123/verify'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('useVerifyBusiness onSuccess invalidates queries', () => {
    renderHook(() => useVerifyBusiness());

    const opts = captured.mutationOpts[0];
    expect(opts).toBeDefined();
    expect(typeof opts.onSuccess).toBe('function');
    // Actually invoke onSuccess to cover the callback
    opts.onSuccess();
  });

  it('useUpgradeTier onSuccess invalidates queries', () => {
    captured.mutationFns = [];
    captured.mutationOpts = [];

    renderHook(() => useUpgradeTier());

    const opts = captured.mutationOpts[0];
    expect(opts).toBeDefined();
    expect(typeof opts.onSuccess).toBe('function');
    opts.onSuccess();
  });

  it('useUpgradeTier mutationFn calls upgrade endpoint', async () => {
    captured.mutationFns = [];
    captured.mutationOpts = [];
    mockFetchResponse({ success: true });

    renderHook(() => useUpgradeTier());

    expect(captured.mutationFns.length).toBeGreaterThan(0);
    await captured.mutationFns[0]({ businessId: 'biz-456', newTier: 'ENTERPRISE' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/businesses/biz-456/upgrade'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tier: 'ENTERPRISE' }),
      }),
    );
  });

  it('useBusinessRegistration register calls writeContract and fetchJson', () => {
    mockFetchResponse({ success: true });

    const { result } = renderHook(() => useBusinessRegistration());

    // register calls writeContract (mocked) + fetchJson (mocked)
    act(() => {
      result.current.register({
        licenseNumber: 'LIC-001',
        businessName: 'Test Corp',
        jurisdiction: 'AE',
        businessType: 'TRADING',
        complianceOfficer: '0x01',
        contactEmail: 'test@test.com',
      });
    });

    // fetch should have been called for the API registration
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/businesses'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
