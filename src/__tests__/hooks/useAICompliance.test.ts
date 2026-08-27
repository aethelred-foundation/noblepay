import { renderHook } from "@testing-library/react";
import { useAICompliance } from "@/hooks/useAICompliance";

const mockRefetch = jest.fn().mockResolvedValue(undefined);
const mockApiRequest = jest.fn().mockResolvedValue({});
const mockQueryOptions: Record<string, any> = {};
const mockQueryStates: Record<string, any> = {};

jest.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => {
    const key = options.queryKey.join(":");
    mockQueryOptions[key] = options;
    return {
      data: mockQueryStates[key]?.data,
      isLoading: mockQueryStates[key]?.isLoading ?? false,
      error: mockQueryStates[key]?.error ?? null,
      refetch: mockRefetch,
    };
  },
}));
jest.mock("@/lib/api", () => ({
  ...jest.requireActual("@/lib/api"),
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
}));

const timestamp = "2026-07-21T10:00:00.000Z";
const decision = {
  id: "dec-verified-1",
  modelId: "model-1",
  modelVersion: "1.0.0",
  paymentId: "payment-1",
  outcome: "ESCALATE",
  originalOutcome: "FLAG",
  confidence: 0.68,
  riskScore: 72,
  factors: [{ name: "corridor", contribution: 0.4, value: "AE-US" }],
  explanation: "Verified engine explanation",
  processingTimeMs: 24,
  teeAttestation: null,
  humanOverride: false,
  overrideBy: null,
  overrideReason: null,
  createdAt: timestamp,
};
const model = {
  id: "model-1",
  name: "Payments Risk",
  version: "1.0.0",
  type: "PAYMENT_RISK",
  status: "ACTIVE",
  accuracy: 0.97,
  precision: 0.96,
  recall: 0.95,
  f1Score: 0.955,
  falsePositiveRate: null,
  falseNegativeRate: null,
  teeAttested: true,
  attestationHash: null,
  trainingDataHash: null,
  deployedAt: timestamp,
  lastEvaluated: null,
  totalDecisions: 12,
  metadata: {},
};
const appeal = {
  id: "00000000-0000-4000-8000-000000000001",
  decisionId: decision.id,
  paymentId: decision.paymentId,
  submittedBy: "reviewer-1",
  reason: "The payment documentation should be reviewed.",
  status: "SUBMITTED",
  externalReference: "appeal-ext-1",
  reviewer: null,
  reviewNotes: null,
  originalOutcome: "ESCALATE",
  finalOutcome: null,
  submittedAt: timestamp,
  resolvedAt: null,
};

describe("useAICompliance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockQueryStates).forEach((key) => delete mockQueryStates[key]);
    mockQueryStates["ai-compliance:models"] = { data: [model] };
    mockQueryStates["ai-compliance:decisions"] = { data: [decision] };
    mockQueryStates["ai-compliance:analytics"] = {
      data: {
        activeModels: 1,
        totalDecisions: 1,
        avgConfidence: 0.68,
        avgProcessingTime: 24,
        escalationRate: 1,
        humanOverrideRate: 0,
        appealRate: 1,
        appealOverturnRate: 0,
        modelPerformance: [],
        biasMetrics: [],
        recentDecisions: [decision],
      },
    };
    mockQueryStates["ai-compliance:bias-metrics"] = {
      data: [
        {
          jurisdiction: "AE",
          totalScreened: 1,
          flagRate: 1,
          blockRate: 0,
          falsePositiveRate: 0,
          avgProcessingTime: 24,
          deviationFromGlobal: null,
        },
      ],
    };
    mockQueryStates["ai-compliance:review-queue"] = { data: [decision] };
    mockQueryStates["ai-compliance:appeals"] = { data: [appeal] };
  });

  it("maps all durable AI records and preserves unknown metrics as null", () => {
    const { result } = renderHook(() => useAICompliance());

    expect(result.current.models[0]).toEqual(
      expect.objectContaining({
        status: "ACTIVE",
        falsePositiveRate: null,
        deployedAt: Date.parse(timestamp),
      }),
    );
    expect(result.current.decisions[0]).toEqual(
      expect.objectContaining({
        outcome: "ESCALATE",
        originalOutcome: "FLAG",
        createdAt: Date.parse(timestamp),
      }),
    );
    expect(result.current.appeals[0]).toEqual(
      expect.objectContaining({
        status: "SUBMITTED",
        resolvedAt: null,
      }),
    );
    expect(result.current.reviewQueue).toHaveLength(1);
    expect(result.current.biasMetrics).toHaveLength(1);
    expect(result.current.unsupportedCapabilities).toEqual([
      "behavioral-scores",
      "network-analysis",
    ]);
  });

  it("uses every server-authoritative AI read endpoint", async () => {
    renderHook(() => useAICompliance());
    const signal = new AbortController().signal;
    for (const key of [
      "ai-compliance:models",
      "ai-compliance:decisions",
      "ai-compliance:analytics",
      "ai-compliance:bias-metrics",
      "ai-compliance:review-queue",
      "ai-compliance:appeals",
    ]) {
      await mockQueryOptions[key].queryFn({ signal });
    }
    expect(mockApiRequest.mock.calls.map(([path]) => path)).toEqual([
      "/v1/ai-compliance/models",
      "/v1/ai-compliance/decisions?limit=50",
      "/v1/ai-compliance/analytics",
      "/v1/ai-compliance/bias-metrics",
      "/v1/ai-compliance/review-queue",
      "/v1/ai-compliance/appeals",
    ]);
  });

  it("keeps read-only AI records available when review permission is denied", () => {
    const reviewError = new Error("review permission denied");
    mockQueryStates["ai-compliance:review-queue"] = { error: reviewError };
    const { result } = renderHook(() => useAICompliance());

    expect(result.current.error).toBeNull();
    expect(result.current.reviewQueueError).toBe(reviewError);
    expect(result.current.decisions).toHaveLength(1);
  });

  it("does not expose unverified AI mutation methods", () => {
    const { result } = renderHook(() => useAICompliance());
    expect(result.current).not.toHaveProperty("runDecision");
    expect(result.current).not.toHaveProperty("overrideDecision");
    expect(result.current).not.toHaveProperty("appealDecision");
    expect(result.current).not.toHaveProperty("resolveAppeal");
  });
});
