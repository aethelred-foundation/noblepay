/**
 * FX Hooks — Custom React hooks for NoblePay foreign exchange operations.
 *
 * Provides typed hooks for FX rates with simulated real-time updates,
 * hedge management, and exposure reporting.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { FXRate, FXHedge, ExposureReport } from '@/types/defi';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const INITIAL_RATES: FXRate[] = [
  { pair: 'USD/AED', rate: 3.6725, change24h: 0.02, bid: 3.6720, ask: 3.6730, updatedAt: Date.now() },
  { pair: 'USD/GBP', rate: 0.7892, change24h: -0.15, bid: 0.7890, ask: 0.7894, updatedAt: Date.now() },
  { pair: 'USD/EUR', rate: 0.9215, change24h: -0.08, bid: 0.9213, ask: 0.9217, updatedAt: Date.now() },
  { pair: 'USD/SGD', rate: 1.3412, change24h: 0.11, bid: 1.3410, ask: 1.3414, updatedAt: Date.now() },
  { pair: 'USD/JPY', rate: 149.82, change24h: 0.35, bid: 149.80, ask: 149.84, updatedAt: Date.now() },
  { pair: 'USD/INR', rate: 83.12, change24h: -0.04, bid: 83.10, ask: 83.14, updatedAt: Date.now() },
  { pair: 'AET/USD', rate: 1.50, change24h: 2.10, bid: 1.49, ask: 1.51, updatedAt: Date.now() },
];

const MOCK_HEDGES: FXHedge[] = [
  {
    id: 'hedge-001',
    fromCurrency: 'USD',
    toCurrency: 'AED',
    notionalAmount: 2_000_000,
    lockedRate: 3.6700,
    currentRate: 3.6725,
    unrealizedPnl: 1_362,
    status: 'Active',
    expiryAt: Date.now() + 30 * 86_400_000,
    createdAt: Date.now() - 15 * 86_400_000,
    collateral: 200_000,
  },
  {
    id: 'hedge-002',
    fromCurrency: 'USD',
    toCurrency: 'GBP',
    notionalAmount: 500_000,
    lockedRate: 0.7850,
    currentRate: 0.7892,
    unrealizedPnl: -2_673,
    status: 'Active',
    expiryAt: Date.now() + 60 * 86_400_000,
    createdAt: Date.now() - 10 * 86_400_000,
    collateral: 50_000,
  },
  {
    id: 'hedge-003',
    fromCurrency: 'USD',
    toCurrency: 'EUR',
    notionalAmount: 1_000_000,
    lockedRate: 0.9180,
    currentRate: 0.9215,
    unrealizedPnl: -3_810,
    status: 'Active',
    expiryAt: Date.now() + 45 * 86_400_000,
    createdAt: Date.now() - 20 * 86_400_000,
    collateral: 100_000,
  },
];

const MOCK_EXPOSURE: ExposureReport = {
  totalExposure: 5_500_000,
  hedgedPercentage: 63.6,
  unhedgedExposure: 2_000_000,
  byPair: [
    { pair: 'USD/AED', exposure: 3_000_000, hedged: 2_000_000, unhedged: 1_000_000 },
    { pair: 'USD/GBP', exposure: 1_000_000, hedged: 500_000, unhedged: 500_000 },
    { pair: 'USD/EUR', exposure: 1_500_000, hedged: 1_000_000, unhedged: 500_000 },
  ],
  valueAtRisk: 82_500,
  generatedAt: Date.now(),
};

// ---------------------------------------------------------------------------
// useFX — FX rates, hedges, and exposure
// ---------------------------------------------------------------------------

export function useFX() {
  const [rates, setRates] = useState<FXRate[]>([]);
  const [hedges, setHedges] = useState<FXHedge[]>([]);
  const [exposure, setExposure] = useState<ExposureReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Initial load
  useEffect(() => {
    const timer = setTimeout(() => {
      setRates(INITIAL_RATES);
      setHedges(MOCK_HEDGES);
      setExposure(MOCK_EXPOSURE);
      setIsLoading(false);
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  // Simulated real-time rate updates every 3 seconds
  useEffect(() => {
    if (rates.length === 0) return;

    intervalRef.current = setInterval(() => {
      setRates((prev) =>
        prev.map((r) => {
          // Random walk: +/- 0.01% to 0.05%
          const delta = (Math.random() - 0.5) * 0.001 * r.rate;
          const newRate = Math.max(0.0001, r.rate + delta);
          const spread = r.ask - r.bid;
          return {
            ...r,
            rate: Number(newRate.toFixed(4)),
            bid: Number((newRate - spread / 2).toFixed(4)),
            ask: Number((newRate + spread / 2).toFixed(4)),
            change24h: Number((r.change24h + (Math.random() - 0.5) * 0.02).toFixed(2)),
            updatedAt: Date.now(),
          };
        }),
      );
    }, 3000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [rates.length]);

  // Update hedge PnL when rates change
  useEffect(() => {
    if (rates.length === 0 || hedges.length === 0) return;

    setHedges((prev) =>
      prev.map((h) => {
        const pair = `${h.fromCurrency}/${h.toCurrency}`;
        const currentRate = rates.find((r) => r.pair === pair);
        if (!currentRate) return h;
        const pnl = (currentRate.rate - h.lockedRate) * h.notionalAmount;
        return {
          ...h,
          currentRate: currentRate.rate,
          unrealizedPnl: Number(pnl.toFixed(2)),
        };
      }),
    );
  }, [rates, hedges.length]);

  const createHedge = useCallback(
    (params: {
      fromCurrency: string;
      toCurrency: string;
      notionalAmount: number;
      collateral: number;
      durationDays: number;
    }) => {
      const pair = `${params.fromCurrency}/${params.toCurrency}`;
      const currentRate = rates.find((r) => r.pair === pair);
      const rate = currentRate?.rate || 1;

      const newHedge: FXHedge = {
        id: `hedge-${String(Date.now()).slice(-6)}`,
        fromCurrency: params.fromCurrency,
        toCurrency: params.toCurrency,
        notionalAmount: params.notionalAmount,
        lockedRate: rate,
        currentRate: rate,
        unrealizedPnl: 0,
        status: 'Active',
        expiryAt: Date.now() + params.durationDays * 86_400_000,
        createdAt: Date.now(),
        collateral: params.collateral,
      };
      setHedges((prev) => [newHedge, ...prev]);
    },
    [rates],
  );

  const closeHedge = useCallback((hedgeId: string) => {
    setHedges((prev) =>
      prev.map((h) =>
        h.id === hedgeId ? { ...h, status: 'Settled' as const } : h,
      ),
    );
  }, []);

  return {
    rates,
    hedges,
    exposure,
    isLoading,
    createHedge,
    closeHedge,
  };
}
