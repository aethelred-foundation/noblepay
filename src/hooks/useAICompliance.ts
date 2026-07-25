import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api";
import type {
  AIAppeal,
  AIBiasMetric,
  AIComplianceAnalytics,
  AIDecision,
  AIModel,
  BehavioralScore,
  NetworkAnalysis,
} from "@/types/compliance";

interface ApiModel extends Omit<AIModel, "deployedAt" | "lastEvaluated"> {
  deployedAt: string;
  lastEvaluated: string | null;
}

interface ApiDecision extends Omit<AIDecision, "createdAt"> {
  createdAt: string;
}

interface ApiAppeal extends Omit<AIAppeal, "submittedAt" | "resolvedAt"> {
  submittedAt: string;
  resolvedAt: string | null;
}

interface ApiAnalytics extends Omit<AIComplianceAnalytics, "recentDecisions"> {
  recentDecisions: ApiDecision[];
  modelPerformance: unknown[];
}

function mapModel(model: ApiModel): AIModel {
  return {
    ...model,
    deployedAt: Date.parse(model.deployedAt),
    lastEvaluated: model.lastEvaluated ? Date.parse(model.lastEvaluated) : null,
  };
}

function mapDecision(decision: ApiDecision): AIDecision {
  return { ...decision, createdAt: Date.parse(decision.createdAt) };
}

function mapAppeal(appeal: ApiAppeal): AIAppeal {
  return {
    ...appeal,
    submittedAt: Date.parse(appeal.submittedAt),
    resolvedAt: appeal.resolvedAt ? Date.parse(appeal.resolvedAt) : null,
  };
}

export function useAICompliance() {
  const modelsQuery = useQuery({
    queryKey: ["ai-compliance", "models"],
    queryFn: ({ signal }) =>
      apiRequest<ApiModel[]>("/v1/ai-compliance/models", { signal }),
  });
  const decisionsQuery = useQuery({
    queryKey: ["ai-compliance", "decisions"],
    queryFn: ({ signal }) =>
      apiRequest<ApiDecision[]>("/v1/ai-compliance/decisions?limit=50", {
        signal,
      }),
  });
  const analyticsQuery = useQuery({
    queryKey: ["ai-compliance", "analytics"],
    queryFn: ({ signal }) =>
      apiRequest<ApiAnalytics>("/v1/ai-compliance/analytics", { signal }),
  });
  const biasQuery = useQuery({
    queryKey: ["ai-compliance", "bias-metrics"],
    queryFn: ({ signal }) =>
      apiRequest<AIBiasMetric[]>("/v1/ai-compliance/bias-metrics", { signal }),
  });
  const reviewQueueQuery = useQuery({
    queryKey: ["ai-compliance", "review-queue"],
    queryFn: ({ signal }) =>
      apiRequest<ApiDecision[]>("/v1/ai-compliance/review-queue", { signal }),
  });
  const appealsQuery = useQuery({
    queryKey: ["ai-compliance", "appeals"],
    queryFn: ({ signal }) =>
      apiRequest<ApiAppeal[]>("/v1/ai-compliance/appeals", { signal }),
  });
  const models = useMemo(
    () => (modelsQuery.data || []).map(mapModel),
    [modelsQuery.data],
  );
  const decisions = useMemo(
    () => (decisionsQuery.data || []).map(mapDecision),
    [decisionsQuery.data],
  );
  const reviewQueue = useMemo(
    () => (reviewQueueQuery.data || []).map(mapDecision),
    [reviewQueueQuery.data],
  );
  const appeals = useMemo(
    () => (appealsQuery.data || []).map(mapAppeal),
    [appealsQuery.data],
  );
  const analytics: AIComplianceAnalytics | null = analyticsQuery.data
    ? {
        ...analyticsQuery.data,
        recentDecisions: analyticsQuery.data.recentDecisions.map(mapDecision),
      }
    : null;

  const refetch = useCallback(async () => {
    await Promise.all([
      modelsQuery.refetch(),
      decisionsQuery.refetch(),
      analyticsQuery.refetch(),
      biasQuery.refetch(),
      reviewQueueQuery.refetch(),
      appealsQuery.refetch(),
    ]);
  }, [
    analyticsQuery,
    appealsQuery,
    biasQuery,
    decisionsQuery,
    modelsQuery,
    reviewQueueQuery,
  ]);

  const getBehavioralScore = useCallback(
    (_address: string): BehavioralScore | undefined => undefined,
    [],
  );

  const queryError =
    modelsQuery.error ||
    decisionsQuery.error ||
    analyticsQuery.error ||
    biasQuery.error ||
    appealsQuery.error ||
    null;
  return {
    models,
    decisions,
    reviewQueue,
    appeals,
    analytics,
    biasMetrics: biasQuery.data || [],
    behavioralScores: [] as BehavioralScore[],
    networkAnalysis: null as NetworkAnalysis | null,
    unsupportedCapabilities: ["behavioral-scores", "network-analysis"] as const,
    isLoading:
      modelsQuery.isLoading ||
      decisionsQuery.isLoading ||
      analyticsQuery.isLoading ||
      biasQuery.isLoading ||
      reviewQueueQuery.isLoading ||
      appealsQuery.isLoading,
    error: queryError,
    reviewQueueError: reviewQueueQuery.error || null,
    refetch,
    getBehavioralScore,
  };
}
