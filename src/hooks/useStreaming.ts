import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiRequest } from "@/lib/api";
import type { PaymentStream, StreamBalance } from "@/types/defi";

export interface StreamAnalytics {
  totalActiveStreams: number;
  totalStreamedValue: number;
  totalRemainingValue: number;
  incomingStreams: number;
  outgoingStreams: number;
  avgStreamDuration: number;
}

interface ApiStream {
  id: string;
  streamId: string;
  sender: string;
  recipient: string;
  totalAmount: string;
  streamedAmount: string;
  withdrawnAmount: string;
  currency: string;
  ratePerSecond: string;
  startTime: string;
  endTime: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  lastWithdrawAt: string | null;
}

interface ApiBalance {
  streamId: string;
  withdrawable: string;
  streamed: string;
  remaining: string;
  calculatedAt: string;
}

interface ApiAnalytics {
  totalActiveStreams: number;
  totalStreamedVolume: string;
}

function mapStream(stream: ApiStream): PaymentStream {
  return {
    id: stream.streamId || stream.id,
    sender: stream.sender,
    recipient: stream.recipient,
    tokenSymbol: stream.currency,
    totalAmount: Number(stream.totalAmount),
    streamedAmount: Number(stream.streamedAmount),
    ratePerSecond: Number(stream.ratePerSecond),
    startTime: Date.parse(stream.startTime),
    endTime: Date.parse(stream.endTime),
    status:
      stream.status === "ACTIVE"
        ? "Active"
        : stream.status === "PAUSED"
          ? "Paused"
          : stream.status === "COMPLETED"
            ? "Completed"
            : "Cancelled",
    cancelable: false,
    lastWithdrawal: stream.lastWithdrawAt
      ? Date.parse(stream.lastWithdrawAt)
      : null,
  };
}

export function useStreaming(userAddress?: string) {
  const streamsQuery = useQuery({
    queryKey: ["streams", "list", userAddress],
    queryFn: ({ signal }) => apiRequest<ApiStream[]>("/v1/streams", { signal }),
  });
  const balancesQuery = useQuery({
    queryKey: [
      "streams",
      "balances",
      (streamsQuery.data || []).map((stream) => stream.streamId),
    ],
    queryFn: ({ signal }) =>
      Promise.all(
        (streamsQuery.data || []).map((stream) =>
          apiRequest<ApiBalance>(
            `/v1/streams/${encodeURIComponent(stream.streamId)}/balance`,
            { signal },
          ),
        ),
      ),
    enabled: !!streamsQuery.data,
    refetchInterval: 10_000,
  });
  const analyticsQuery = useQuery({
    queryKey: ["streams", "analytics"],
    queryFn: ({ signal }) =>
      apiRequest<ApiAnalytics>("/v1/streams/analytics", { signal }),
  });

  const streams = useMemo(
    () => (streamsQuery.data || []).map(mapStream),
    [streamsQuery.data],
  );
  const balances = useMemo(
    () =>
      new Map<string, StreamBalance>(
        (balancesQuery.data || []).map((balance) => [
          balance.streamId,
          {
            streamId: balance.streamId,
            withdrawable: Number(balance.withdrawable),
            remaining: Number(balance.remaining),
            deposited: Number(balance.streamed) + Number(balance.remaining),
            withdrawn:
              Number(
                (streamsQuery.data || []).find(
                  (stream) => stream.streamId === balance.streamId,
                )?.withdrawnAmount,
              ) || 0,
            snapshotAt: Date.parse(balance.calculatedAt),
          },
        ]),
      ),
    [balancesQuery.data, streamsQuery.data],
  );

  const unavailable = useCallback(async () => {
    throw new ApiError("Payment stream execution is not configured", {
      status: 501,
      code: "ONCHAIN_SETTLEMENT_UNAVAILABLE",
    });
  }, []);
  const refetch = useCallback(async () => {
    await Promise.all([
      streamsQuery.refetch(),
      balancesQuery.refetch(),
      analyticsQuery.refetch(),
    ]);
  }, [analyticsQuery, balancesQuery, streamsQuery]);
  const analytics: StreamAnalytics | null = analyticsQuery.data
    ? {
        totalActiveStreams: analyticsQuery.data.totalActiveStreams,
        totalStreamedValue: Number(analyticsQuery.data.totalStreamedVolume),
        totalRemainingValue: Array.from(balances.values()).reduce(
          (sum, balance) => sum + balance.remaining,
          0,
        ),
        incomingStreams: userAddress
          ? streams.filter(
              (stream) =>
                stream.recipient.toLowerCase() === userAddress.toLowerCase(),
            ).length
          : 0,
        outgoingStreams: userAddress
          ? streams.filter(
              (stream) =>
                stream.sender.toLowerCase() === userAddress.toLowerCase(),
            ).length
          : 0,
        avgStreamDuration:
          streams.length > 0
            ? streams.reduce(
                (sum, stream) => sum + stream.endTime - stream.startTime,
                0,
              ) /
              streams.length /
              86_400_000
            : 0,
      }
    : null;

  return {
    streams,
    balances,
    analytics,
    isLoading:
      streamsQuery.isLoading ||
      balancesQuery.isLoading ||
      analyticsQuery.isLoading,
    isMutating: false,
    error:
      streamsQuery.error || balancesQuery.error || analyticsQuery.error || null,
    refetch,
    mutationsEnabled: false,
    mutationReason:
      "Stream changes remain disabled until contract transactions and receipts can be verified.",
    createStream: unavailable,
    cancelStream: unavailable,
    pauseStream: unavailable,
    resumeStream: unavailable,
  };
}
