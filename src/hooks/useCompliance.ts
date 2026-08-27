import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, apiRequestEnvelope } from "@/lib/api";
import { useSignMessage } from "wagmi";

export interface ComplianceEngineStatus {
  engineStatus: "healthy";
  checkedAt: string;
  settlementEvidence: "verified_per_submission";
  sanctions: SanctionsStatus;
}

export interface ScreeningResult {
  id: string;
  paymentId: string;
  sanctionsClear: boolean;
  amlRiskScore: number;
  travelRuleCompliant: boolean;
  status: string;
  flagReason: string | null;
  screenedBy: string;
  screeningDuration: number;
  investigationHash?: string | null;
  createdAt?: string;
}

export interface ComplianceMetrics {
  totalScreenings: number;
  passedScreenings: number;
  failedScreenings: number;
  averageRiskScore: number;
  averageScreeningDuration: number;
  passRate: number;
  flaggedCount: number;
  underReviewCount: number;
}

export interface SanctionsStatus {
  lastUpdated: string | null;
  listsLoaded: string[];
  totalEntries: number;
  status: "fresh" | "stale" | "updating" | "unavailable";
}

export interface FlaggedPayment {
  id: string;
  paymentId: string;
  amount: string;
  currency: string;
  sender: string;
  recipient: string;
  riskScore: number | null;
  status: string;
  initiatedAt: string;
  screenings?: ScreeningResult[];
}

export interface TravelRuleData {
  originatorName: string;
  originatorAccount: string;
  originatorAddress: string;
  beneficiaryName: string;
  beneficiaryAccount: string;
  originatorNationalId?: string;
  beneficiaryInstitution?: string;
}

export interface TravelRuleRequirement {
  required: boolean;
  authorized: boolean;
  thresholdUsd: string;
  currency: string;
}

export function getTravelRuleRequirement(paymentId: string) {
  return apiRequest<TravelRuleRequirement>(
    `/v1/compliance/travel-rule/requirements/${paymentId}`,
  );
}

export function useAuthorizeTravelRule() {
  const { signMessageAsync } = useSignMessage();
  return useMutation({
    mutationFn: async ({
      paymentId,
      data,
    }: {
      paymentId: string;
      data: TravelRuleData;
    }) => {
      const challenge = await apiRequest<{
        challengeId: string;
        message: string;
        payloadCommitment: string;
        expiresAt: string;
      }>("/v1/compliance/travel-rule/challenge", {
        method: "POST",
        json: { paymentId, data },
      });
      const signature = await signMessageAsync({ message: challenge.message });
      return apiRequest<{
        payloadCommitment: string;
        authorizedBy: string;
      }>("/v1/compliance/travel-rule/authorize", {
        method: "POST",
        json: {
          paymentId,
          challengeId: challenge.challengeId,
          signature,
          data,
        },
      });
    },
  });
}

export function useComplianceStatus() {
  return useQuery({
    queryKey: ["complianceStatus"],
    queryFn: () => apiRequest<ComplianceEngineStatus>("/v1/compliance/status"),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useScreeningResult(paymentId: string | undefined) {
  return useQuery({
    queryKey: ["screening", paymentId],
    queryFn: () =>
      apiRequest<ScreeningResult[]>(`/v1/compliance/screenings/${paymentId}`),
    enabled: Boolean(paymentId),
    staleTime: 30_000,
  });
}

export function useComplianceMetrics() {
  return useQuery({
    queryKey: ["complianceMetrics"],
    queryFn: () => apiRequest<ComplianceMetrics>("/v1/compliance/metrics"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useSanctionsListStatus() {
  return useQuery({
    queryKey: ["sanctionsListStatus"],
    queryFn: () =>
      apiRequest<SanctionsStatus>("/v1/compliance/sanctions/status"),
    staleTime: 60_000,
  });
}

export function useFlaggedPayments() {
  return useQuery({
    queryKey: ["flaggedPayments"],
    queryFn: async () => {
      const response = await apiRequestEnvelope<FlaggedPayment[]>(
        "/v1/compliance/flagged",
      );
      return {
        payments: response.data,
        total: response.pagination?.total ?? response.data.length,
      };
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useReviewFlaggedPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      paymentId,
      decision,
      reason,
    }: {
      paymentId: string;
      decision: "escalate";
      reason: string;
    }) =>
      apiRequest(`/v1/compliance/flagged/${paymentId}/review`, {
        method: "POST",
        json: { decision, reason },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["flaggedPayments"] });
      void queryClient.invalidateQueries({ queryKey: ["complianceMetrics"] });
      void queryClient.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

export function useUpdateSanctionsList() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest("/v1/compliance/sanctions/update", { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sanctionsListStatus"] });
      void queryClient.invalidateQueries({ queryKey: ["complianceStatus"] });
    },
  });
}

export function useSubmitScreening() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      paymentId,
      priority = "normal",
    }: {
      paymentId: string;
      priority?: "normal" | "high" | "urgent";
    }) =>
      apiRequest<ScreeningResult>("/v1/compliance/screen", {
        method: "POST",
        json: { paymentId, priority },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["complianceMetrics"] });
      void queryClient.invalidateQueries({ queryKey: ["flaggedPayments"] });
      void queryClient.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}
