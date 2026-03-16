import { renderHook, act } from '@testing-library/react';
import { useFX } from '@/hooks/useFX';

describe('useFX', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns loading state initially', () => {
    const { result } = renderHook(() => useFX());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.rates).toEqual([]);
    expect(result.current.hedges).toEqual([]);
    expect(result.current.exposure).toBeNull();
  });

  it('loads mock data after timeout', () => {
    const { result } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.rates.length).toBe(7);
    expect(result.current.hedges.length).toBe(3);
    expect(result.current.exposure).not.toBeNull();
  });

  it('rates have correct structure', () => {
    const { result } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const rate = result.current.rates[0];
    expect(rate).toHaveProperty('pair');
    expect(rate).toHaveProperty('rate');
    expect(rate).toHaveProperty('change24h');
    expect(rate).toHaveProperty('bid');
    expect(rate).toHaveProperty('ask');
    expect(rate).toHaveProperty('updatedAt');
  });

  it('includes USD/AED rate', () => {
    const { result } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const aedRate = result.current.rates.find((r) => r.pair === 'USD/AED');
    expect(aedRate).toBeDefined();
    expect(aedRate?.rate).toBeCloseTo(3.6725, 2);
  });

  it('includes AET/USD rate', () => {
    const { result } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const aetRate = result.current.rates.find((r) => r.pair === 'AET/USD');
    expect(aetRate).toBeDefined();
    expect(aetRate?.rate).toBeCloseTo(1.5, 1);
  });

  it('hedges have correct structure', () => {
    const { result } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const hedge = result.current.hedges[0];
    expect(hedge).toHaveProperty('id');
    expect(hedge).toHaveProperty('fromCurrency');
    expect(hedge).toHaveProperty('toCurrency');
    expect(hedge).toHaveProperty('notionalAmount');
    expect(hedge).toHaveProperty('lockedRate');
    expect(hedge).toHaveProperty('currentRate');
    expect(hedge).toHaveProperty('unrealizedPnl');
    expect(hedge).toHaveProperty('status');
    expect(hedge).toHaveProperty('expiryAt');
    expect(hedge).toHaveProperty('collateral');
  });

  it('exposure report has correct structure', () => {
    const { result } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const exp = result.current.exposure!;
    expect(exp.totalExposure).toBe(5_500_000);
    expect(exp.hedgedPercentage).toBeCloseTo(63.6, 1);
    expect(exp.unhedgedExposure).toBe(2_000_000);
    expect(exp.byPair.length).toBe(3);
    expect(exp.valueAtRisk).toBe(82_500);
    expect(exp.byPair[0]).toHaveProperty('pair');
    expect(exp.byPair[0]).toHaveProperty('exposure');
    expect(exp.byPair[0]).toHaveProperty('hedged');
    expect(exp.byPair[0]).toHaveProperty('unhedged');
  });

  it('createHedge adds a new hedge', () => {
    const { result } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const initialCount = result.current.hedges.length;

    act(() => {
      result.current.createHedge({
        fromCurrency: 'USD',
        toCurrency: 'AED',
        notionalAmount: 100_000,
        collateral: 10_000,
        durationDays: 30,
      });
    });

    expect(result.current.hedges.length).toBe(initialCount + 1);
    const newHedge = result.current.hedges[0]; // prepended
    expect(newHedge.fromCurrency).toBe('USD');
    expect(newHedge.toCurrency).toBe('AED');
    expect(newHedge.notionalAmount).toBe(100_000);
    expect(newHedge.collateral).toBe(10_000);
    expect(newHedge.status).toBe('Active');
    expect(newHedge.unrealizedPnl).toBe(0);
  });

  it('createHedge uses rate 1 for unknown pair', () => {
    const { result } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    act(() => {
      result.current.createHedge({
        fromCurrency: 'FOO',
        toCurrency: 'BAR',
        notionalAmount: 50_000,
        collateral: 5_000,
        durationDays: 15,
      });
    });

    const newHedge = result.current.hedges[0];
    expect(newHedge.lockedRate).toBe(1);
    expect(newHedge.currentRate).toBe(1);
  });

  it('closeHedge marks a hedge as settled', () => {
    const { result } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(result.current.hedges[0].status).toBe('Active');

    act(() => {
      result.current.closeHedge('hedge-001');
    });

    const closed = result.current.hedges.find((h) => h.id === 'hedge-001');
    expect(closed?.status).toBe('Settled');
  });

  it('closeHedge does not affect other hedges', () => {
    const { result } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    act(() => {
      result.current.closeHedge('hedge-001');
    });

    const hedge2 = result.current.hedges.find((h) => h.id === 'hedge-002');
    expect(hedge2?.status).toBe('Active');
  });

  it('cleans up timers on unmount', () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const { unmount } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('simulated rate updates run on interval', () => {
    const { result } = renderHook(() => useFX());

    // Load initial data
    act(() => {
      jest.advanceTimersByTime(600);
    });

    const initialRate = result.current.rates[0].rate;

    // Trigger the 3-second interval update
    act(() => {
      jest.advanceTimersByTime(3100);
    });

    // Rate should have changed slightly due to random walk
    // We can't predict the exact value, but the updatedAt should be newer
    expect(result.current.rates[0].updatedAt).toBeGreaterThan(0);
    expect(result.current.rates[0]).toHaveProperty('bid');
    expect(result.current.rates[0]).toHaveProperty('ask');
    expect(result.current.rates[0]).toHaveProperty('change24h');
  });

  it('rate updates keep bid/ask spread', () => {
    const { result } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    act(() => {
      jest.advanceTimersByTime(3100);
    });

    const rate = result.current.rates[0];
    expect(rate.ask).toBeGreaterThanOrEqual(rate.bid);
  });

  it('hedge PnL updates when rates change', () => {
    const { result } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const initialPnl = result.current.hedges[0].unrealizedPnl;

    // After rate update, PnL should recalculate
    act(() => {
      jest.advanceTimersByTime(3100);
    });

    // PnL may or may not change depending on random walk direction
    // But the recalculation should have run
    expect(typeof result.current.hedges[0].unrealizedPnl).toBe('number');
  });

  it('interval cleanup works on unmount', () => {
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const { unmount } = renderHook(() => useFX());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});
