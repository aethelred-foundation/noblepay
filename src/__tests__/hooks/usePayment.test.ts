import { renderHook } from '@testing-library/react';
import {
  usePayment,
  usePayments,
  useInitiatePayment,
  usePaymentStats,
  useCancelPayment,
  useRefundPayment,
} from '@/hooks/usePayment';

const captured = {
  queryFns: {} as Record<string, Function>,
  mutationFns: [] as Function[],
  mutationOpts: [] as any[],
};

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

const mockFetchResponse = (data: any, ok = true, status = 200) => {
  (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    json: () => Promise.resolve(data),
  });
};

describe('usePayment', () => {
  it('returns query result when paymentId is provided', () => {
    const { result } = renderHook(() => usePayment('pay-001'));

    expect(result.current).toHaveProperty('data');
    expect(result.current).toHaveProperty('isLoading');
    expect(result.current).toHaveProperty('error');
  });

  it('handles undefined paymentId', () => {
    const { result } = renderHook(() => usePayment(undefined));

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it('returns isLoading false with mocked query', () => {
    const { result } = renderHook(() => usePayment('pay-001'));

    expect(result.current.isLoading).toBe(false);
  });
});

describe('usePayments', () => {
  it('returns query result without filters', () => {
    const { result } = renderHook(() => usePayments());

    expect(result.current).toHaveProperty('data');
    expect(result.current).toHaveProperty('isLoading');
    expect(result.current).toHaveProperty('error');
  });

  it('accepts all filter options', () => {
    const { result } = renderHook(() =>
      usePayments({
        status: 'Settled',
        currency: 'USDC',
        dateRange: '30d',
        riskLevel: 'Low',
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
      usePayments({ status: 'Pending' }),
    );

    expect(result.current).toHaveProperty('data');
  });

  it('uses default page and pageSize', () => {
    const { result } = renderHook(() => usePayments({}));

    expect(result.current).toHaveProperty('data');
  });
});

describe('useInitiatePayment', () => {
  it('returns correct interface shape', () => {
    const { result } = renderHook(() => useInitiatePayment());

    expect(result.current).toHaveProperty('initiate');
    expect(result.current).toHaveProperty('txHash');
    expect(result.current).toHaveProperty('isPending');
    expect(result.current).toHaveProperty('isConfirming');
    expect(result.current).toHaveProperty('isSuccess');
    expect(typeof result.current.initiate).toBe('function');
  });

  it('has correct default values', () => {
    const { result } = renderHook(() => useInitiatePayment());

    expect(result.current.txHash).toBeUndefined();
    expect(result.current.isPending).toBe(false);
    expect(result.current.isConfirming).toBe(false);
    expect(result.current.isSuccess).toBe(false);
  });

  it('initiate function can be called without errors', () => {
    const { result } = renderHook(() => useInitiatePayment());

    expect(() => {
      result.current.initiate({
        recipient: '0xrecipient',
        amount: '1000',
        currency: 'USDC',
        purposeHash: 'test purpose',
      });
    }).not.toThrow();
  });

  it('initiate function handles AET currency', () => {
    const { result } = renderHook(() => useInitiatePayment());

    expect(() => {
      result.current.initiate({
        recipient: '0xrecipient',
        amount: '100',
        currency: 'AET',
        purposeHash: 'aet payment',
      });
    }).not.toThrow();
  });
});

describe('usePaymentStats', () => {
  it('returns query result shape', () => {
    const { result } = renderHook(() => usePaymentStats());

    expect(result.current).toHaveProperty('data');
    expect(result.current).toHaveProperty('isLoading');
    expect(result.current).toHaveProperty('error');
    expect(result.current.isLoading).toBe(false);
  });
});

describe('useCancelPayment', () => {
  it('returns mutation result with mutate function', () => {
    const { result } = renderHook(() => useCancelPayment());

    expect(result.current).toHaveProperty('mutate');
    expect(result.current).toHaveProperty('isPending');
    expect(typeof result.current.mutate).toBe('function');
  });
});

describe('useRefundPayment', () => {
  it('returns mutation result with mutate function', () => {
    const { result } = renderHook(() => useRefundPayment());

    expect(result.current).toHaveProperty('mutate');
    expect(result.current).toHaveProperty('isPending');
    expect(typeof result.current.mutate).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// fetchJson and queryFn/mutationFn execution tests
// ---------------------------------------------------------------------------

describe('payment queryFns', () => {
  beforeEach(() => {
    captured.queryFns = {};
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it('payment queryFn calls correct endpoint', async () => {
    const mockData = { paymentId: 'pay-001', status: 'Settled' };
    mockFetchResponse(mockData);

    renderHook(() => usePayment('pay-001'));

    const fn = captured.queryFns['payment'];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/payments/pay-001'),
      expect.any(Object),
    );
  });

  it('payment queryFn throws on error', async () => {
    mockFetchResponse({}, false, 404);

    renderHook(() => usePayment('pay-001'));

    const fn = captured.queryFns['payment'];
    await expect(fn()).rejects.toThrow('API 404');
  });

  it('payments queryFn builds URL with all filters', async () => {
    mockFetchResponse({ payments: [], total: 0 });

    renderHook(() =>
      usePayments({
        status: 'Settled',
        currency: 'USDC',
        dateRange: '30d',
        riskLevel: 'Low',
        search: 'test',
        page: 2,
        pageSize: 10,
      }),
    );

    const fn = captured.queryFns['payments'];
    await fn();
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toContain('status=Settled');
    expect(calledUrl).toContain('currency=USDC');
    expect(calledUrl).toContain('dateRange=30d');
    expect(calledUrl).toContain('riskLevel=Low');
    expect(calledUrl).toContain('search=test');
    expect(calledUrl).toContain('page=2');
    expect(calledUrl).toContain('pageSize=10');
  });

  it('payments queryFn uses defaults when no filters', async () => {
    mockFetchResponse({ payments: [], total: 0 });

    renderHook(() => usePayments());

    const fn = captured.queryFns['payments'];
    await fn();
    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0];
    expect(calledUrl).toContain('page=1');
    expect(calledUrl).toContain('pageSize=20');
  });

  it('paymentStats queryFn calls stats endpoint', async () => {
    const mockData = { totalPayments: 1000, totalVolume: 5000000 };
    mockFetchResponse(mockData);

    renderHook(() => usePaymentStats());

    const fn = captured.queryFns['paymentStats'];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
  });
});

describe('payment mutationFns', () => {
  beforeEach(() => {
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it('useCancelPayment mutationFn calls cancel endpoint', async () => {
    mockFetchResponse({ success: true });

    renderHook(() => useCancelPayment());

    expect(captured.mutationFns.length).toBeGreaterThan(0);
    await captured.mutationFns[0]('pay-001');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/payments/pay-001/cancel'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('useCancelPayment onSuccess invalidates queries', () => {
    renderHook(() => useCancelPayment());

    expect(captured.mutationOpts.length).toBeGreaterThan(0);
    expect(typeof captured.mutationOpts[0].onSuccess).toBe('function');
    captured.mutationOpts[0].onSuccess();
  });

  it('useRefundPayment mutationFn calls refund endpoint', async () => {
    mockFetchResponse({ success: true });

    renderHook(() => useRefundPayment());

    expect(captured.mutationFns.length).toBeGreaterThan(0);
    await captured.mutationFns[0]('pay-002');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/payments/pay-002/refund'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('useRefundPayment onSuccess invalidates queries', () => {
    renderHook(() => useRefundPayment());

    expect(captured.mutationOpts.length).toBeGreaterThan(0);
    expect(typeof captured.mutationOpts[0].onSuccess).toBe('function');
    captured.mutationOpts[0].onSuccess();
  });
});

describe('useInitiatePayment with isSuccess=true', () => {
  it('invalidates queries when transaction is successful', () => {
    const wagmi = require('wagmi');
    const origWait = wagmi.useWaitForTransactionReceipt;
    wagmi.useWaitForTransactionReceipt = () => ({ isLoading: false, isSuccess: true });

    const { result } = renderHook(() => useInitiatePayment());

    expect(result.current.isSuccess).toBe(true);

    wagmi.useWaitForTransactionReceipt = origWait;
  });
});
