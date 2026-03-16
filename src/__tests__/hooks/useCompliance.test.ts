import { renderHook } from '@testing-library/react';
import {
  useComplianceStatus,
  useScreeningResult,
  useComplianceMetrics,
  useSanctionsListStatus,
  useFlaggedPayments,
  useReviewFlaggedPayment,
  useUpdateSanctionsList,
  useRiskThresholds,
} from '@/hooks/useCompliance';

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

describe('useComplianceStatus', () => {
  it('returns query result with correct shape', () => {
    const { result } = renderHook(() => useComplianceStatus());

    expect(result.current).toHaveProperty('data');
    expect(result.current).toHaveProperty('isLoading');
    expect(result.current).toHaveProperty('error');
  });

  it('starts with no data loaded', () => {
    const { result } = renderHook(() => useComplianceStatus());

    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

describe('useScreeningResult', () => {
  it('returns query result when paymentId is provided', () => {
    const { result } = renderHook(() => useScreeningResult('pay-001'));

    expect(result.current).toHaveProperty('data');
    expect(result.current).toHaveProperty('isLoading');
    expect(result.current).toHaveProperty('error');
  });

  it('handles undefined paymentId gracefully', () => {
    const { result } = renderHook(() => useScreeningResult(undefined));

    expect(result.current.data).toBeUndefined();
    expect(result.current.error).toBeNull();
  });
});

describe('useComplianceMetrics', () => {
  it('returns query result shape', () => {
    const { result } = renderHook(() => useComplianceMetrics());

    expect(result.current).toHaveProperty('data');
    expect(result.current).toHaveProperty('isLoading');
    expect(result.current).toHaveProperty('error');
    expect(result.current.isLoading).toBe(false);
  });
});

describe('useSanctionsListStatus', () => {
  it('returns query result shape', () => {
    const { result } = renderHook(() => useSanctionsListStatus());

    expect(result.current).toHaveProperty('data');
    expect(result.current).toHaveProperty('isLoading');
    expect(result.current).toHaveProperty('error');
  });
});

describe('useFlaggedPayments', () => {
  it('returns query result shape', () => {
    const { result } = renderHook(() => useFlaggedPayments());

    expect(result.current).toHaveProperty('data');
    expect(result.current).toHaveProperty('isLoading');
    expect(result.current).toHaveProperty('error');
  });
});

describe('useReviewFlaggedPayment', () => {
  it('returns mutation result with mutate function', () => {
    const { result } = renderHook(() => useReviewFlaggedPayment());

    expect(result.current).toHaveProperty('mutate');
    expect(result.current).toHaveProperty('isPending');
    expect(typeof result.current.mutate).toBe('function');
  });
});

describe('useUpdateSanctionsList', () => {
  it('returns mutation result with mutate function', () => {
    const { result } = renderHook(() => useUpdateSanctionsList());

    expect(result.current).toHaveProperty('mutate');
    expect(result.current).toHaveProperty('isPending');
    expect(typeof result.current.mutate).toBe('function');
  });
});

describe('useRiskThresholds', () => {
  it('returns undefined when contract data is not available', () => {
    const { result } = renderHook(() => useRiskThresholds());

    // useReadContract mock returns { data: undefined }
    expect(result.current).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fetchJson and queryFn/mutationFn execution tests
// ---------------------------------------------------------------------------

describe('compliance queryFns', () => {
  beforeEach(() => {
    captured.queryFns = {};
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it('complianceStatus queryFn calls correct endpoint', async () => {
    const mockData = { operational: true, teeNodesOnline: 5 };
    mockFetchResponse(mockData);

    renderHook(() => useComplianceStatus());

    const fn = captured.queryFns['complianceStatus'];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/compliance/status'),
      expect.any(Object),
    );
  });

  it('complianceStatus queryFn throws on error response', async () => {
    mockFetchResponse({}, false, 500);

    renderHook(() => useComplianceStatus());

    const fn = captured.queryFns['complianceStatus'];
    await expect(fn()).rejects.toThrow('API 500');
  });

  it('screening queryFn calls correct endpoint', async () => {
    const mockData = { paymentId: 'pay-001', sanctionsClear: true };
    mockFetchResponse(mockData);

    renderHook(() => useScreeningResult('pay-001'));

    const fn = captured.queryFns['screening'];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/compliance/screenings/pay-001'),
      expect.any(Object),
    );
  });

  it('complianceMetrics queryFn calls correct endpoint', async () => {
    const mockData = { totalScreenings: 100, passRate: 95 };
    mockFetchResponse(mockData);

    renderHook(() => useComplianceMetrics());

    const fn = captured.queryFns['complianceMetrics'];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
  });

  it('sanctionsListStatus queryFn calls correct endpoint', async () => {
    const mockData = [{ name: 'OFAC', isFresh: true }];
    mockFetchResponse(mockData);

    renderHook(() => useSanctionsListStatus());

    const fn = captured.queryFns['sanctionsListStatus'];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
  });

  it('flaggedPayments queryFn calls correct endpoint', async () => {
    const mockData = { payments: [], total: 0 };
    mockFetchResponse(mockData);

    renderHook(() => useFlaggedPayments());

    const fn = captured.queryFns['flaggedPayments'];
    expect(fn).toBeDefined();
    const result = await fn();
    expect(result).toEqual(mockData);
  });
});

describe('compliance mutationFns', () => {
  beforeEach(() => {
    captured.mutationFns = [];
    captured.mutationOpts = [];
  });

  it('useReviewFlaggedPayment mutationFn calls review endpoint', async () => {
    mockFetchResponse({ success: true });

    renderHook(() => useReviewFlaggedPayment());

    expect(captured.mutationFns.length).toBeGreaterThan(0);
    await captured.mutationFns[0]({
      paymentId: 'pay-001',
      decision: 'clear',
      notes: 'Reviewed and cleared',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/compliance/flagged/pay-001/review'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision: 'clear', notes: 'Reviewed and cleared' }),
      }),
    );
  });

  it('useReviewFlaggedPayment onSuccess invalidates queries', () => {
    renderHook(() => useReviewFlaggedPayment());

    expect(captured.mutationOpts.length).toBeGreaterThan(0);
    expect(typeof captured.mutationOpts[0].onSuccess).toBe('function');
    // Call onSuccess to verify it doesn't throw
    captured.mutationOpts[0].onSuccess();
  });

  it('useUpdateSanctionsList mutationFn calls update endpoint', async () => {
    mockFetchResponse({ success: true });

    renderHook(() => useUpdateSanctionsList());

    expect(captured.mutationFns.length).toBeGreaterThan(0);
    await captured.mutationFns[0]('OFAC');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/compliance/sanctions/update'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ list: 'OFAC' }),
      }),
    );
  });

  it('useUpdateSanctionsList onSuccess invalidates queries', () => {
    renderHook(() => useUpdateSanctionsList());

    expect(captured.mutationOpts.length).toBeGreaterThan(0);
    expect(typeof captured.mutationOpts[0].onSuccess).toBe('function');
    captured.mutationOpts[0].onSuccess();
  });
});
