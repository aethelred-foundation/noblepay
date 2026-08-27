import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  apiRequest,
  apiRequestEnvelope,
  type ApiPagination,
  withQuery,
} from "@/lib/api";

export interface ReportTemplate {
  id: string;
  type: string;
  name: string;
  description: string;
  jurisdiction: string;
  requiredFields: string[];
  filingFrequency: string;
  regulatoryBody: string;
  format: string;
}

export interface RegulatoryReport {
  id: string;
  templateId: string;
  type: string;
  name: string;
  jurisdiction: string;
  dateFrom: string;
  dateTo: string;
  status: string;
  data: Record<string, unknown>;
  summary: {
    totalTransactions: number;
    totalVolume: string;
    flaggedTransactions: number;
    blockedTransactions: number;
    sanctionsHits: number;
    travelRuleCompliance: number;
    avgRiskScore: number;
    highRiskEntities: number;
  };
  generatedAt: string;
  submittedAt: string | null;
  notes: string;
}

export type RegulatoryReportSummary = Omit<RegulatoryReport, "data">;

export interface GenerateReportInput {
  templateId: string;
  dateFrom: string;
  dateTo: string;
  notes?: string;
}

export function useReportTemplates() {
  return useQuery({
    queryKey: ["report-templates"],
    queryFn: () => apiRequest<ReportTemplate[]>("/v1/reports/templates"),
    staleTime: 5 * 60_000,
  });
}

export function useReports(page = 1, limit = 20) {
  const query = useQuery({
    queryKey: ["reports", page, limit],
    queryFn: () =>
      apiRequestEnvelope<RegulatoryReportSummary[]>(
        withQuery("/v1/reports", { page, limit }),
      ),
    staleTime: 15_000,
  });
  return {
    ...query,
    data: query.data?.data,
    pagination: query.data?.pagination as ApiPagination | undefined,
  };
}

export function fetchRegulatoryReport(reportId: string) {
  return apiRequest<RegulatoryReport>(
    `/v1/reports/${encodeURIComponent(reportId)}`,
  );
}

export function useGenerateReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GenerateReportInput) =>
      apiRequest<RegulatoryReport>("/v1/reports", {
        method: "POST",
        json: input,
        timeoutMs: 60_000,
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["reports"] }),
  });
}
