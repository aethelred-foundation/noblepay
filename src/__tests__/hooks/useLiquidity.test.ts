import { renderHook, act } from '@testing-library/react';
import { useLiquidity } from '@/hooks/useLiquidity';

describe('useLiquidity', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns loading state initially', () => {
    const { result } = renderHook(() => useLiquidity());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.pools).toEqual([]);
    expect(result.current.positions).toEqual([]);
    expect(result.current.analytics).toBeNull();
  });

  it('loads mock data after timeout', () => {
    const { result } = renderHook(() => useLiquidity());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.pools.length).toBe(4);
    expect(result.current.positions.length).toBe(2);
    expect(result.current.analytics).not.toBeNull();
  });

  it('pools have correct structure', () => {
    const { result } = renderHook(() => useLiquidity());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const pool = result.current.pools[0];
    expect(pool).toHaveProperty('address');
    expect(pool).toHaveProperty('name');
    expect(pool).toHaveProperty('tokenA');
    expect(pool).toHaveProperty('tokenB');
    expect(pool).toHaveProperty('tvl');
    expect(pool).toHaveProperty('volume24h');
    expect(pool).toHaveProperty('apy');
    expect(pool).toHaveProperty('feeBps');
    expect(pool).toHaveProperty('status');
    expect(pool).toHaveProperty('reserveA');
    expect(pool).toHaveProperty('reserveB');
    expect(pool).toHaveProperty('lpCount');
    expect(pool).toHaveProperty('createdAt');
  });

  it('positions have correct structure', () => {
    const { result } = renderHook(() => useLiquidity());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const pos = result.current.positions[0];
    expect(pos).toHaveProperty('id');
    expect(pos).toHaveProperty('poolAddress');
    expect(pos).toHaveProperty('poolName');
    expect(pos).toHaveProperty('lpTokens');
    expect(pos).toHaveProperty('poolShare');
    expect(pos).toHaveProperty('valueUsd');
    expect(pos).toHaveProperty('unclaimedFees');
    expect(pos).toHaveProperty('impermanentLoss');
    expect(pos).toHaveProperty('enteredAt');
  });

  it('analytics has correct computed values', () => {
    const { result } = renderHook(() => useLiquidity());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const analytics = result.current.analytics!;
    expect(analytics.totalPools).toBe(4);
    expect(analytics.totalTvl).toBe(8_500_000 + 15_200_000 + 2_100_000 + 5_600_000);
    expect(analytics.totalVolume24h).toBe(1_200_000 + 3_400_000 + 450_000 + 890_000);
    expect(analytics.avgApy).toBeCloseTo((12.3 + 4.8 + 18.7 + 6.2) / 4, 1);
    expect(analytics.totalFeesEarned24h).toBeGreaterThan(0);
  });

  it('addLiquidity increases pool TVL and reserves', () => {
    const { result } = renderHook(() => useLiquidity());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const originalTvl = result.current.pools[0].tvl;
    const originalReserveA = result.current.pools[0].reserveA;
    const originalReserveB = result.current.pools[0].reserveB;

    act(() => {
      result.current.addLiquidity('0xpool001', 10_000, 5_000);
    });

    const updated = result.current.pools.find((p) => p.address === '0xpool001')!;
    expect(updated.tvl).toBe(originalTvl + 15_000);
    expect(updated.reserveA).toBe(originalReserveA + 10_000);
    expect(updated.reserveB).toBe(originalReserveB + 5_000);
  });

  it('addLiquidity does not affect other pools', () => {
    const { result } = renderHook(() => useLiquidity());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const pool2Tvl = result.current.pools.find((p) => p.address === '0xpool002')!.tvl;

    act(() => {
      result.current.addLiquidity('0xpool001', 10_000, 5_000);
    });

    expect(result.current.pools.find((p) => p.address === '0xpool002')!.tvl).toBe(pool2Tvl);
  });

  it('removeLiquidity removes a position', () => {
    const { result } = renderHook(() => useLiquidity());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(result.current.positions.length).toBe(2);

    act(() => {
      result.current.removeLiquidity('pos-001');
    });

    expect(result.current.positions.length).toBe(1);
    expect(result.current.positions.find((p) => p.id === 'pos-001')).toBeUndefined();
    expect(result.current.positions.find((p) => p.id === 'pos-002')).toBeDefined();
  });

  it('claimFees resets unclaimed fees to zero', () => {
    const { result } = renderHook(() => useLiquidity());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    expect(result.current.positions[0].unclaimedFees).toBeGreaterThan(0);

    act(() => {
      result.current.claimFees('pos-001');
    });

    const updated = result.current.positions.find((p) => p.id === 'pos-001');
    expect(updated?.unclaimedFees).toBe(0);
  });

  it('claimFees does not affect other positions', () => {
    const { result } = renderHook(() => useLiquidity());

    act(() => {
      jest.advanceTimersByTime(600);
    });

    const pos2Fees = result.current.positions.find((p) => p.id === 'pos-002')!.unclaimedFees;

    act(() => {
      result.current.claimFees('pos-001');
    });

    expect(result.current.positions.find((p) => p.id === 'pos-002')!.unclaimedFees).toBe(
      pos2Fees,
    );
  });

  it('cleans up timer on unmount', () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const { unmount } = renderHook(() => useLiquidity());

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
