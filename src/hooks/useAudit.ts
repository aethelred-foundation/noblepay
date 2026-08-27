import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, apiRequestEnvelope, withQuery } from "@/lib/api";

export interface AuditEntry {
  id: string;
  eventId: string;
  eventType: string;
  actor: string;
  description: string;
  severity: string;
  blockNumber: string | null;
  txHash: string | null;
  previousHash: string | null;
  entryHash: string;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
}

export interface AuditStats {
  totalEntries: number;
  byEventType: Record<string, number>;
  bySeverity: Record<string, number>;
  chainIntact: boolean | null;
  chainVerification: "NOT_RUN";
  latestEntry: string | null;
  last24hCount: number;
  last7dCount: number;
}

export interface IntegrityResult {
  intact: boolean;
  totalEntries: number;
  verified: number;
  brokenAt?: string;
  message: string;
}

export interface AuditFilters {
  eventType?: string;
  severity?: string;
  actor?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export function useAuditEntries(filters: AuditFilters = {}) {
  return useQuery({
    queryKey: ["audit", filters],
    queryFn: async () => {
      const response = await apiRequestEnvelope<AuditEntry[]>(
        withQuery("/v1/audit", {
          ...filters,
          page: filters.page ?? 1,
          limit: filters.limit ?? 20,
        }),
      );
      return {
        entries: response.data,
        total: response.pagination?.total ?? response.data.length,
        page: response.pagination?.page ?? filters.page ?? 1,
        totalPages: response.pagination?.totalPages ?? 1,
      };
    },
    staleTime: 10_000,
  });
}

export function useAuditStats() {
  return useQuery({
    queryKey: ["audit-stats"],
    queryFn: () => apiRequest<AuditStats>("/v1/audit/stats"),
    staleTime: 30_000,
  });
}

export function useVerifyAuditChain() {
  return useMutation({
    mutationFn: () => apiRequest<IntegrityResult>("/v1/audit/verify"),
  });
}

export function useExportAudit() {
  return useMutation({
    mutationFn: async ({ from, to }: { from: string; to: string }) => {
      const csv = await apiRequest<string>("/v1/audit/export", {
        method: "POST",
        json: { format: "csv", from, to, includeMetadata: true },
        timeoutMs: 60_000,
      });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `noblepay-audit-${from.slice(0, 10)}-${to.slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    },
  });
}
