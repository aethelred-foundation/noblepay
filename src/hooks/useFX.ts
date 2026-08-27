import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiRequest } from "@/lib/api";
import type { ExposureReport, FXHedge, FXRate } from "@/types/defi";

interface ApiRate {
  pair: string;
  bid: number;
  ask: number;
  mid: number;
  timestamp: string;
  change24h: number | null;
}

interface ApiHedge {
  id: string;
  pair: string;
  notionalAmount: string;
  entryRate: number;
  strikeRate: number | null;
  currentRate: number;
  expiryDate: string;
  status: "OPEN" | "CLOSED" | "EXPIRED" | "EXERCISED";
  marginDeposit: null;
  unrealizedPnL: string | null;
  createdAt: string;
}

interface ApiExposure {
  totalExposure: string;
  byCurrency: Record<
    string,
    {
      exposure: string;
      hedged: string;
      unhedged: null;
      hedgeRatio: null;
    }
  >;
  netExposure: null;
  valueAtRisk: null;
  calculatedAt: string;
}

function mapRate(rate: ApiRate): FXRate {
  return {
    pair: rate.pair,
    rate: rate.mid,
    change24h: rate.change24h,
    bid: rate.bid,
    ask: rate.ask,
    updatedAt: Date.parse(rate.timestamp),
  };
}

function mapHedge(hedge: ApiHedge): FXHedge {
  const [fromCurrency = "", toCurrency = ""] = hedge.pair.split("/");
  const status: FXHedge["status"] =
    hedge.status === "OPEN"
      ? "Active"
      : hedge.status === "EXPIRED"
        ? "Expired"
        : "Settled";

  return {
    id: hedge.id,
    fromCurrency,
    toCurrency,
    notionalAmount: Number(hedge.notionalAmount),
    lockedRate: hedge.strikeRate ?? hedge.entryRate,
    currentRate: hedge.currentRate,
    unrealizedPnl:
      hedge.unrealizedPnL === null ? null : Number(hedge.unrealizedPnL),
    status,
    expiryAt: Date.parse(hedge.expiryDate),
    createdAt: Date.parse(hedge.createdAt),
    collateral: null,
  };
}

function mapExposure(exposure: ApiExposure): ExposureReport {
  const byPair = Object.entries(exposure.byCurrency).map(
    ([currency, value]) => ({
      pair: currency,
      exposure: Number(value.exposure),
      hedged: Number(value.hedged),
      unhedged: null,
    }),
  );
  const totalExposure = Number(exposure.totalExposure);
  const totalHedged = byPair.reduce((sum, item) => sum + item.hedged, 0);

  return {
    totalExposure,
    hedgedPercentage:
      totalExposure > 0 ? (totalHedged / totalExposure) * 100 : 0,
    unhedgedExposure: null,
    byPair,
    valueAtRisk: null,
    generatedAt: Date.parse(exposure.calculatedAt),
  };
}

export function useFX() {
  const ratesQuery = useQuery({
    queryKey: ["fx", "rates"],
    queryFn: ({ signal }) => apiRequest<ApiRate[]>("/v1/fx/rates", { signal }),
    refetchInterval: 30_000,
  });
  const hedgesQuery = useQuery({
    queryKey: ["fx", "hedges"],
    queryFn: ({ signal }) =>
      apiRequest<ApiHedge[]>("/v1/fx/hedges", { signal }),
  });
  const exposureQuery = useQuery({
    queryKey: ["fx", "exposure"],
    queryFn: ({ signal }) =>
      apiRequest<ApiExposure>("/v1/fx/exposure", { signal }),
  });

  const rates = useMemo(
    () => (ratesQuery.data || []).map(mapRate),
    [ratesQuery.data],
  );
  const hedges = useMemo(
    () => (hedgesQuery.data || []).map(mapHedge),
    [hedgesQuery.data],
  );

  const refetch = useCallback(async () => {
    await Promise.all([
      ratesQuery.refetch(),
      hedgesQuery.refetch(),
      exposureQuery.refetch(),
    ]);
  }, [exposureQuery, hedgesQuery, ratesQuery]);

  const executionUnavailable = useCallback(
    () =>
      Promise.reject(
        new ApiError(
          "FX execution is disabled until signed settlement and receipt verification are configured.",
          { status: 501, code: "FX_EXECUTION_UNAVAILABLE" },
        ),
      ),
    [],
  );

  return {
    rates,
    hedges,
    exposure: exposureQuery.data ? mapExposure(exposureQuery.data) : null,
    isLoading: hedgesQuery.isLoading || exposureQuery.isLoading,
    ratesLoading: ratesQuery.isLoading,
    isMutating: false,
    error: hedgesQuery.error || exposureQuery.error || null,
    oracleError: ratesQuery.error || null,
    mutationsEnabled: false,
    mutationReason:
      "FX execution is disabled until signed settlement and receipt verification are configured.",
    refetch,
    createHedge: executionUnavailable,
    closeHedge: executionUnavailable,
  };
}
