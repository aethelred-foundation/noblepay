import { renderHook } from "@testing-library/react";
import {
  fetchRegulatoryReport,
  useGenerateReport,
  useReports,
  useReportTemplates,
} from "@/hooks/useReporting";

const mockApiRequest = jest.fn();
const mockApiRequestEnvelope = jest.fn();
const mockInvalidateQueries = jest.fn();
const mockQueryOptions: Record<string, any> = {};

jest.mock("@/lib/api", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  apiRequestEnvelope: (...args: unknown[]) => mockApiRequestEnvelope(...args),
  withQuery: (path: string, values: Record<string, unknown>) =>
    `${path}?${new URLSearchParams(
      Object.entries(values).map(([key, value]) => [key, String(value)]),
    ).toString()}`,
}));

jest.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => {
    mockQueryOptions[String(options.queryKey[0])] = options;
    return { data: undefined, isLoading: false, error: null };
  },
  useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
  useMutation: (options: any) => ({
    mutateAsync: async (variables: unknown) => {
      const value = await options.mutationFn(variables);
      await options.onSuccess?.(value, variables, undefined);
      return value;
    },
    isPending: false,
    error: null,
  }),
}));

describe("regulatory reporting hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockQueryOptions).forEach(
      (key) => delete mockQueryOptions[key],
    );
  });

  it("loads regulator-defined templates from the production endpoint", async () => {
    const templates = [
      {
        id: "uae-str",
        type: "STR",
        name: "Suspicious transaction report",
      },
    ];
    mockApiRequest.mockResolvedValue(templates);

    const { result } = renderHook(() => useReportTemplates());
    const loaded = await mockQueryOptions["report-templates"].queryFn();

    expect(result.current.isLoading).toBe(false);
    expect(loaded).toBe(templates);
    expect(mockApiRequest).toHaveBeenCalledWith("/v1/reports/templates");
    expect(mockQueryOptions["report-templates"].staleTime).toBe(300_000);
  });

  it("loads generated reports without seeded client-side records", async () => {
    const reports = [{ id: "report-1", status: "GENERATED" }];
    const envelope = {
      data: reports,
      pagination: { page: 2, limit: 10, total: 11, totalPages: 2 },
    };
    mockApiRequestEnvelope.mockResolvedValue(envelope);

    renderHook(() => useReports(2, 10));
    await expect(mockQueryOptions.reports.queryFn()).resolves.toBe(envelope);
    expect(mockApiRequestEnvelope).toHaveBeenCalledWith(
      "/v1/reports?page=2&limit=10",
    );
    expect(mockQueryOptions.reports.staleTime).toBe(15_000);
  });

  it("retrieves one complete bounded report for download", async () => {
    const report = { id: "rpt-1", data: { evidence: true } };
    mockApiRequest.mockResolvedValue(report);
    await expect(fetchRegulatoryReport("rpt-1")).resolves.toBe(report);
    expect(mockApiRequest).toHaveBeenCalledWith("/v1/reports/rpt-1");
  });

  it("generates a report server-side and refreshes the report ledger", async () => {
    const input = {
      templateId: "uae-str",
      dateFrom: "2026-07-01T00:00:00.000Z",
      dateTo: "2026-07-21T23:59:59.999Z",
      notes: "Monthly filing",
    };
    const generated = { id: "report-2", ...input, status: "GENERATED" };
    mockApiRequest.mockResolvedValue(generated);

    const { result } = renderHook(() => useGenerateReport());
    await expect(result.current.mutateAsync(input)).resolves.toBe(generated);

    expect(mockApiRequest).toHaveBeenCalledWith("/v1/reports", {
      method: "POST",
      json: input,
      timeoutMs: 60_000,
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["reports"],
    });
  });
});
