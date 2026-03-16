/**
 * Compliance Hooks — Custom React hooks for NoblePay compliance operations.
 *
 * Provides typed hooks for compliance engine status, screening results,
 * metrics, and sanctions list freshness.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useReadContract } from 'wagmi';
import { CONTRACT_ADDRESSES } from '@/config/chains';
import { COMPLIANCE_ORACLE_ABI } from '@/config/abis';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComplianceEngineStatus {
  operational: boolean;
  teeNodesOnline: number;
  teeNodesTotal: number;
  sanctionsListsFresh: boolean;
  lastScreeningAt: number;
  avgScreeningTimeMs: number;
}

export interface ScreeningResult {
  paymentId: string;
  sanctionsClear: boolean;
  amlRiskScore: number;
  travelRuleCompliant: boolean;
  flagReasons: string[];
  screenedBy: string;
  screeningDurationMs: number;
  attestation: string;
  timestamp: number;
}

export interface ComplianceMetrics {
  totalScreenings: number;
  passRate: number;
  flagRate: number;
  blockRate: number;
  avgScreeningTimeMs: number;
  falsePositiveRate: number;
  manualReviewQueue: number;
}

export interface SanctionsListStatus {
  name: string;
  source: string;
  lastUpdated: number;
  entryCount: number;
  isFresh: boolean;
}

export interface FlaggedPayment {
  paymentId: string;
  amount: number;
  currency: string;
  sender: string;
  riskScore: number;
  flagReason: string;
  assignedTo: string;
  status: string;
  flaggedAt: number;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// useComplianceStatus — current compliance engine status
// ---------------------------------------------------------------------------

export function useComplianceStatus() {
  return useQuery({
    queryKey: ['complianceStatus'],
    queryFn: () => fetchJson<ComplianceEngineStatus>('/v1/compliance/status'),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

// ---------------------------------------------------------------------------
// useScreeningResult — screening details for a specific payment
// ---------------------------------------------------------------------------

export function useScreeningResult(paymentId: string | undefined) {
  return useQuery({
    queryKey: ['screening', paymentId],
    queryFn: () =>
      fetchJson<ScreeningResult>(`/v1/compliance/screenings/${paymentId}`),
    enabled: !!paymentId,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// useComplianceMetrics — aggregate compliance metrics
// ---------------------------------------------------------------------------

export function useComplianceMetrics() {
  return useQuery({
    queryKey: ['complianceMetrics'],
    queryFn: () => fetchJson<ComplianceMetrics>('/v1/compliance/metrics'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// ---------------------------------------------------------------------------
// useSanctionsListStatus — freshness of each sanctions list
// ---------------------------------------------------------------------------

export function useSanctionsListStatus() {
  return useQuery({
    queryKey: ['sanctionsListStatus'],
    queryFn: () =>
      fetchJson<SanctionsListStatus[]>('/v1/compliance/sanctions/status'),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// useFlaggedPayments — flagged payments queue
// ---------------------------------------------------------------------------

export function useFlaggedPayments() {
  return useQuery({
    queryKey: ['flaggedPayments'],
    queryFn: () =>
      fetchJson<{ payments: FlaggedPayment[]; total: number }>(
        '/v1/compliance/flagged',
      ),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

// ---------------------------------------------------------------------------
// useReviewFlaggedPayment — submit review decision for a flagged payment
// ---------------------------------------------------------------------------

export function useReviewFlaggedPayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      paymentId,
      decision,
      notes,
    }: {
      paymentId: string;
      decision: 'clear' | 'escalate' | 'block';
      notes: string;
    }) =>
      fetchJson(`/v1/compliance/flagged/${paymentId}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision, notes }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flaggedPayments'] });
      queryClient.invalidateQueries({ queryKey: ['complianceMetrics'] });
    },
  });
}

// ---------------------------------------------------------------------------
// useUpdateSanctionsList — trigger a sanctions list refresh
// ---------------------------------------------------------------------------

export function useUpdateSanctionsList() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (listName: string) =>
      fetchJson('/v1/compliance/sanctions/update', {
        method: 'POST',
        body: JSON.stringify({ list: listName }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sanctionsListStatus'] });
    },
  });
}

// ---------------------------------------------------------------------------
// useRiskThresholds — on-chain risk threshold configuration
// ---------------------------------------------------------------------------

export function useRiskThresholds() {
  const { data: thresholds } = useReadContract({
    address: CONTRACT_ADDRESSES.complianceOracle as `0x${string}`,
    abi: COMPLIANCE_ORACLE_ABI,
    functionName: 'getRiskThresholds',
    query: {
      enabled: !!CONTRACT_ADDRESSES.complianceOracle,
    },
  });

  return thresholds as
    | { lowThreshold: number; highThreshold: number }
    | undefined;
}
