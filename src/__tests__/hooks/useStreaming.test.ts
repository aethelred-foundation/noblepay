import { renderHook, act } from '@testing-library/react';
import { useStreaming } from '@/hooks/useStreaming';

describe('useStreaming', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns loading state initially', () => {
    const { result } = renderHook(() => useStreaming());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.streams).toEqual([]);
    expect(result.current.balances.size).toBe(0);
    expect(result.current.analytics).toBeNull();
  });

  it('loads mock data after timeout', () => {
    const { result } = renderHook(() => useStreaming());

    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.streams.length).toBe(4);
  });

  it('computes analytics after loading', () => {
    const { result } = renderHook(() => useStreaming());

    act(() => {
      jest.advanceTimersByTime(500);
    });

    // Allow useEffect for analytics to run
    act(() => {
      jest.advanceTimersByTime(0);
    });

    expect(result.current.analytics).not.toBeNull();
    const analytics = result.current.analytics!;
    expect(analytics.totalActiveStreams).toBe(2); // 2 Active streams
    expect(analytics.totalStreamedValue).toBeGreaterThan(0);
    expect(analytics.totalRemainingValue).toBeGreaterThan(0);
  });

  it('analytics computes incoming/outgoing streams correctly', () => {
    const { result } = renderHook(() =>
      useStreaming('0x1234567890abcdef1234567890abcdef12345678'),
    );

    act(() => {
      jest.advanceTimersByTime(500);
    });

    act(() => {
      jest.advanceTimersByTime(0);
    });

    const analytics = result.current.analytics!;
    // Streams where user is sender: stream001 and stream003
    expect(analytics.outgoingStreams).toBe(2);
    // Streams where user is recipient: stream002 and stream004
    expect(analytics.incomingStreams).toBe(2);
  });

  it('streams have correct structure', () => {
    const { result } = renderHook(() => useStreaming());

    act(() => {
      jest.advanceTimersByTime(500);
    });

    const stream = result.current.streams[0];
    expect(stream).toHaveProperty('id');
    expect(stream).toHaveProperty('sender');
    expect(stream).toHaveProperty('recipient');
    expect(stream).toHaveProperty('tokenSymbol');
    expect(stream).toHaveProperty('totalAmount');
    expect(stream).toHaveProperty('streamedAmount');
    expect(stream).toHaveProperty('ratePerSecond');
    expect(stream).toHaveProperty('startTime');
    expect(stream).toHaveProperty('endTime');
    expect(stream).toHaveProperty('status');
    expect(stream).toHaveProperty('cancelable');
    expect(stream).toHaveProperty('lastWithdrawal');
  });

  it('includes streams of various statuses', () => {
    const { result } = renderHook(() => useStreaming());

    act(() => {
      jest.advanceTimersByTime(500);
    });

    const statuses = result.current.streams.map((s) => s.status);
    expect(statuses).toContain('Active');
    expect(statuses).toContain('Completed');
    expect(statuses).toContain('Paused');
  });

  it('computes balances for active streams', () => {
    const { result } = renderHook(() => useStreaming());

    act(() => {
      jest.advanceTimersByTime(500);
    });

    // After loading, balances should be computed for active streams
    act(() => {
      jest.advanceTimersByTime(1100);
    });

    // Active streams should have balances
    const activeStreams = result.current.streams.filter((s) => s.status === 'Active');
    for (const stream of activeStreams) {
      const balance = result.current.balances.get(stream.id);
      expect(balance).toBeDefined();
      expect(balance).toHaveProperty('streamId');
      expect(balance).toHaveProperty('withdrawable');
      expect(balance).toHaveProperty('remaining');
      expect(balance).toHaveProperty('deposited');
      expect(balance).toHaveProperty('withdrawn');
      expect(balance).toHaveProperty('snapshotAt');
    }
  });

  it('createStream adds a new active stream', () => {
    const { result } = renderHook(() =>
      useStreaming('0x1234567890abcdef1234567890abcdef12345678'),
    );

    act(() => {
      jest.advanceTimersByTime(500);
    });

    const initialCount = result.current.streams.length;

    act(() => {
      result.current.createStream({
        recipient: '0xrecipient',
        tokenSymbol: 'USDC',
        totalAmount: 10_000,
        durationDays: 30,
      });
    });

    expect(result.current.streams.length).toBe(initialCount + 1);
    const newStream = result.current.streams[0]; // prepended
    expect(newStream.status).toBe('Active');
    expect(newStream.cancelable).toBe(true);
    expect(newStream.totalAmount).toBe(10_000);
    expect(newStream.tokenSymbol).toBe('USDC');
    expect(newStream.streamedAmount).toBe(0);
    expect(newStream.sender).toBe('0x1234567890abcdef1234567890abcdef12345678');
    expect(newStream.recipient).toBe('0xrecipient');
    expect(newStream.ratePerSecond).toBeCloseTo(10_000 / (30 * 86_400), 4);
  });

  it('createStream uses default address when no userAddress', () => {
    const { result } = renderHook(() => useStreaming());

    act(() => {
      jest.advanceTimersByTime(500);
    });

    act(() => {
      result.current.createStream({
        recipient: '0xrecipient',
        tokenSymbol: 'USDC',
        totalAmount: 5_000,
        durationDays: 10,
      });
    });

    const newStream = result.current.streams[0];
    expect(newStream.sender).toBe('0x1234567890abcdef1234567890abcdef12345678');
  });

  it('cancelStream sets stream status to Cancelled', () => {
    const { result } = renderHook(() => useStreaming());

    act(() => {
      jest.advanceTimersByTime(500);
    });

    act(() => {
      result.current.cancelStream('0xstream001');
    });

    const cancelled = result.current.streams.find((s) => s.id === '0xstream001');
    expect(cancelled?.status).toBe('Cancelled');
  });

  it('cancelStream does not affect other streams', () => {
    const { result } = renderHook(() => useStreaming());

    act(() => {
      jest.advanceTimersByTime(500);
    });

    act(() => {
      result.current.cancelStream('0xstream001');
    });

    const stream2 = result.current.streams.find((s) => s.id === '0xstream002');
    expect(stream2?.status).toBe('Active');
  });

  it('pauseStream sets stream status to Paused', () => {
    const { result } = renderHook(() => useStreaming());

    act(() => {
      jest.advanceTimersByTime(500);
    });

    act(() => {
      result.current.pauseStream('0xstream001');
    });

    const paused = result.current.streams.find((s) => s.id === '0xstream001');
    expect(paused?.status).toBe('Paused');
  });

  it('resumeStream sets paused stream to Active', () => {
    const { result } = renderHook(() => useStreaming());

    act(() => {
      jest.advanceTimersByTime(500);
    });

    // stream004 is Paused
    act(() => {
      result.current.resumeStream('0xstream004');
    });

    const resumed = result.current.streams.find((s) => s.id === '0xstream004');
    expect(resumed?.status).toBe('Active');
  });

  it('resumeStream only resumes paused streams', () => {
    const { result } = renderHook(() => useStreaming());

    act(() => {
      jest.advanceTimersByTime(500);
    });

    // stream003 is Completed, should not resume
    act(() => {
      result.current.resumeStream('0xstream003');
    });

    const stream = result.current.streams.find((s) => s.id === '0xstream003');
    expect(stream?.status).toBe('Completed');
  });

  it('cleans up timers on unmount', () => {
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const { unmount } = renderHook(() => useStreaming());

    act(() => {
      jest.advanceTimersByTime(500);
    });

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
