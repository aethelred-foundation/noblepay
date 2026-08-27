import { renderHook } from "@testing-library/react";
import {
  useAuditEntries,
  useAuditStats,
  useExportAudit,
  useVerifyAuditChain,
} from "@/hooks/useAudit";

const mockApiRequest = jest.fn();
const mockApiRequestEnvelope = jest.fn();
const mockQueryOptions: Record<string, any> = {};

jest.mock("@/lib/api", () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  apiRequestEnvelope: (...args: unknown[]) => mockApiRequestEnvelope(...args),
  withQuery: (
    path: string,
    values: Record<string, string | number | boolean | null | undefined>,
  ) => {
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    });
    const query = params.toString();
    return query ? `${path}?${query}` : path;
  },
}));

jest.mock("@tanstack/react-query", () => ({
  useQuery: (options: any) => {
    mockQueryOptions[String(options.queryKey[0])] = options;
    return { data: undefined, isLoading: false, error: null };
  },
  useMutation: (options: any) => ({
    mutateAsync: (variables: unknown) => options.mutationFn(variables),
    mutate: (variables: unknown) => options.mutationFn(variables),
    isPending: false,
    error: null,
  }),
}));

describe("audit hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockQueryOptions).forEach(
      (key) => delete mockQueryOptions[key],
    );
  });

  it("requests canonical audit entries with server-side filters and pagination", async () => {
    const entry = {
      id: "audit-1",
      eventId: "evt-1",
      eventType: "PAYMENT_SETTLED",
      actor: "0xactor",
      description: "Payment settled",
      severity: "INFO",
      blockNumber: "120",
      txHash: "0xhash",
      previousHash: null,
      entryHash: "0xentry",
      createdAt: "2026-07-21T10:00:00Z",
    };
    mockApiRequestEnvelope.mockResolvedValue({
      data: [entry],
      pagination: { total: 41, page: 2, totalPages: 3 },
    });

    renderHook(() =>
      useAuditEntries({
        eventType: "PAYMENT_SETTLED",
        severity: "INFO",
        actor: "0xactor",
        page: 2,
        limit: 20,
      }),
    );
    const result = await mockQueryOptions.audit.queryFn();

    expect(mockApiRequestEnvelope).toHaveBeenCalledWith(
      "/v1/audit?eventType=PAYMENT_SETTLED&severity=INFO&actor=0xactor&page=2&limit=20",
    );
    expect(result).toEqual({
      entries: [entry],
      total: 41,
      page: 2,
      totalPages: 3,
    });
  });

  it("uses safe pagination defaults when the envelope omits metadata", async () => {
    mockApiRequestEnvelope.mockResolvedValue({ data: [] });
    renderHook(() => useAuditEntries());

    await expect(mockQueryOptions.audit.queryFn()).resolves.toEqual({
      entries: [],
      total: 0,
      page: 1,
      totalPages: 1,
    });
    expect(mockApiRequestEnvelope).toHaveBeenCalledWith(
      "/v1/audit?page=1&limit=20",
    );
  });

  it("loads audit statistics and verifies the hash chain on demand", async () => {
    const stats = { totalEntries: 9, chainIntact: true };
    const integrity = {
      intact: true,
      totalEntries: 9,
      verified: 9,
      message: "Chain intact",
    };
    mockApiRequest
      .mockResolvedValueOnce(stats)
      .mockResolvedValueOnce(integrity);

    renderHook(() => useAuditStats());
    const statsResult = await mockQueryOptions["audit-stats"].queryFn();
    const { result } = renderHook(() => useVerifyAuditChain());
    const verifyResult = await result.current.mutateAsync(undefined);

    expect(statsResult).toBe(stats);
    expect(verifyResult).toBe(integrity);
    expect(mockApiRequest).toHaveBeenNthCalledWith(1, "/v1/audit/stats");
    expect(mockApiRequest).toHaveBeenNthCalledWith(2, "/v1/audit/verify");
  });

  it("downloads the server-generated CSV with an auditable date range", async () => {
    mockApiRequest.mockResolvedValue(
      "event_id,event_type\nevt-1,PAYMENT_SETTLED",
    );
    const createObjectURL = jest.fn(() => "blob:audit-export");
    const revokeObjectURL = jest.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    const click = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const originalCreate = document.createElement.bind(document);
    let anchor: HTMLAnchorElement | undefined;
    const createElement = jest
      .spyOn(document, "createElement")
      .mockImplementation(((
        tagName: string,
        options?: ElementCreationOptions,
      ) => {
        const element = originalCreate(tagName, options);
        if (tagName.toLowerCase() === "a")
          anchor = element as HTMLAnchorElement;
        return element;
      }) as typeof document.createElement);

    const { result } = renderHook(() => useExportAudit());
    await result.current.mutateAsync({
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-21T23:59:59.999Z",
    });

    expect(mockApiRequest).toHaveBeenCalledWith("/v1/audit/export", {
      method: "POST",
      json: {
        format: "csv",
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-07-21T23:59:59.999Z",
        includeMetadata: true,
      },
      timeoutMs: 60_000,
    });
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(anchor).toMatchObject({
      href: "blob:audit-export",
      download: "noblepay-audit-2026-07-01-2026-07-21.csv",
    });
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audit-export");

    createElement.mockRestore();
    click.mockRestore();
  });
});
