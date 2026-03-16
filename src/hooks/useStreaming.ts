/**
 * Streaming Hooks — Custom React hooks for NoblePay payment streams.
 *
 * Provides typed hooks for managing continuous payment streams,
 * real-time balance calculation, and stream analytics.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { PaymentStream, StreamBalance } from '@/types/defi';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_STREAMS: PaymentStream[] = [
  {
    id: '0xstream001',
    sender: '0x1234567890abcdef1234567890abcdef12345678',
    recipient: '0xabcdef1234567890abcdef1234567890abcdef12',
    tokenSymbol: 'USDC',
    totalAmount: 120_000,
    streamedAmount: 40_000,
    ratePerSecond: 0.0463,
    startTime: Date.now() - 30 * 86_400_000,
    endTime: Date.now() + 60 * 86_400_000,
    status: 'Active',
    cancelable: true,
    lastWithdrawal: Date.now() - 7 * 86_400_000,
  },
  {
    id: '0xstream002',
    sender: '0x2345678901abcdef2345678901abcdef23456789',
    recipient: '0x1234567890abcdef1234567890abcdef12345678',
    tokenSymbol: 'AET',
    totalAmount: 50_000,
    streamedAmount: 25_000,
    ratePerSecond: 0.0193,
    startTime: Date.now() - 45 * 86_400_000,
    endTime: Date.now() + 45 * 86_400_000,
    status: 'Active',
    cancelable: true,
    lastWithdrawal: Date.now() - 3 * 86_400_000,
  },
  {
    id: '0xstream003',
    sender: '0x1234567890abcdef1234567890abcdef12345678',
    recipient: '0x3456789012abcdef3456789012abcdef34567890',
    tokenSymbol: 'USDC',
    totalAmount: 24_000,
    streamedAmount: 24_000,
    ratePerSecond: 0.0278,
    startTime: Date.now() - 120 * 86_400_000,
    endTime: Date.now() - 20 * 86_400_000,
    status: 'Completed',
    cancelable: false,
    lastWithdrawal: Date.now() - 20 * 86_400_000,
  },
  {
    id: '0xstream004',
    sender: '0x4567890123abcdef4567890123abcdef45678901',
    recipient: '0x1234567890abcdef1234567890abcdef12345678',
    tokenSymbol: 'USDT',
    totalAmount: 36_000,
    streamedAmount: 6_000,
    ratePerSecond: 0.0139,
    startTime: Date.now() - 15 * 86_400_000,
    endTime: Date.now() + 75 * 86_400_000,
    status: 'Paused',
    cancelable: true,
    lastWithdrawal: Date.now() - 5 * 86_400_000,
  },
];

// ---------------------------------------------------------------------------
// Stream analytics type
// ---------------------------------------------------------------------------

export interface StreamAnalytics {
  totalActiveStreams: number;
  totalStreamedValue: number;
  totalRemainingValue: number;
  incomingStreams: number;
  outgoingStreams: number;
  avgStreamDuration: number;
}

// ---------------------------------------------------------------------------
// useStreaming — streams, balances, and analytics
// ---------------------------------------------------------------------------

export function useStreaming(userAddress?: string) {
  const [streams, setStreams] = useState<PaymentStream[]>([]);
  const [balances, setBalances] = useState<Map<string, StreamBalance>>(new Map());
  const [analytics, setAnalytics] = useState<StreamAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load mock data
  useEffect(() => {
    const timer = setTimeout(() => {
      setStreams(MOCK_STREAMS);
      setIsLoading(false);
    }, 400);
    return () => clearTimeout(timer);
  }, []);

  // Real-time balance calculation (updates every second for active streams)
  useEffect(() => {
    if (streams.length === 0) return;

    const calculateBalances = () => {
      const now = Date.now();
      const newBalances = new Map<string, StreamBalance>();

      for (const stream of streams) {
        if (stream.status !== 'Active') continue;
        const elapsed = Math.max(0, (now - stream.startTime) / 1000);
        const totalDuration = (stream.endTime - stream.startTime) / 1000;
        const streamed = Math.min(stream.ratePerSecond * elapsed, stream.totalAmount);
        const withdrawn = stream.streamedAmount - (streamed - stream.streamedAmount);

        newBalances.set(stream.id, {
          streamId: stream.id,
          withdrawable: Math.max(0, streamed - stream.streamedAmount + (stream.totalAmount - stream.totalAmount)),
          remaining: Math.max(0, stream.totalAmount - streamed),
          deposited: stream.totalAmount,
          withdrawn: stream.totalAmount - stream.totalAmount + stream.streamedAmount,
          snapshotAt: now,
        });
      }

      setBalances(newBalances);
    };

    calculateBalances();
    intervalRef.current = setInterval(calculateBalances, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [streams]);

  // Compute analytics
  useEffect(() => {
    if (streams.length === 0) return;

    const active = streams.filter((s) => s.status === 'Active');
    const mockAddr = '0x1234567890abcdef1234567890abcdef12345678';
    const addr = userAddress || mockAddr;

    setAnalytics({
      totalActiveStreams: active.length,
      totalStreamedValue: streams.reduce((sum, s) => sum + s.streamedAmount, 0),
      totalRemainingValue: streams.reduce((sum, s) => sum + (s.totalAmount - s.streamedAmount), 0),
      incomingStreams: streams.filter((s) => s.recipient === addr).length,
      outgoingStreams: streams.filter((s) => s.sender === addr).length,
      avgStreamDuration:
        streams.reduce((sum, s) => sum + (s.endTime - s.startTime), 0) /
        streams.length /
        86_400_000,
    });
  }, [streams, userAddress]);

  const createStream = useCallback(
    (params: {
      recipient: string;
      tokenSymbol: string;
      totalAmount: number;
      durationDays: number;
    }) => {
      const now = Date.now();
      const durationMs = params.durationDays * 86_400_000;
      const newStream: PaymentStream = {
        id: `0xstream${String(Date.now()).slice(-6)}`,
        sender: userAddress || '0x1234567890abcdef1234567890abcdef12345678',
        recipient: params.recipient,
        tokenSymbol: params.tokenSymbol,
        totalAmount: params.totalAmount,
        streamedAmount: 0,
        ratePerSecond: params.totalAmount / (params.durationDays * 86_400),
        startTime: now,
        endTime: now + durationMs,
        status: 'Active',
        cancelable: true,
        lastWithdrawal: 0,
      };
      setStreams((prev) => [newStream, ...prev]);
    },
    [userAddress],
  );

  const cancelStream = useCallback((streamId: string) => {
    setStreams((prev) =>
      prev.map((s) =>
        s.id === streamId ? { ...s, status: 'Cancelled' as const } : s,
      ),
    );
  }, []);

  const pauseStream = useCallback((streamId: string) => {
    setStreams((prev) =>
      prev.map((s) =>
        s.id === streamId ? { ...s, status: 'Paused' as const } : s,
      ),
    );
  }, []);

  const resumeStream = useCallback((streamId: string) => {
    setStreams((prev) =>
      prev.map((s) =>
        s.id === streamId && s.status === 'Paused'
          ? { ...s, status: 'Active' as const }
          : s,
      ),
    );
  }, []);

  return {
    streams,
    balances,
    analytics,
    isLoading,
    createStream,
    cancelStream,
    pauseStream,
    resumeStream,
  };
}
