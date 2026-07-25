import { Prisma } from "@prisma/client";
import {
  REPORT_GENERATION_LIMITS,
  RegulatoryGateway,
  ReportingError,
  ReportingService,
} from "../../services/reporting";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR = "0x1111111111111111111111111111111111111111";
const NOW = new Date("2026-07-21T00:00:00.000Z");
const HASH = `0x${"a".repeat(64)}`;

function report(overrides: Record<string, unknown> = {}) {
  return {
    id: "rpt-1",
    templateId: "tpl-sar",
    businessId: BUSINESS_ID,
    jurisdiction: "UAE",
    reportType: "SAR",
    periodStart: new Date("2026-01-01T00:00:00.000Z"),
    periodEnd: new Date("2026-03-31T23:59:59.999Z"),
    status: "GENERATED",
    contentHash: HASH,
    reportData: { suspiciousActivityCount: 1 },
    summary: {
      totalTransactions: 1,
      totalVolume: "10000.00",
      flaggedTransactions: 1,
      blockedTransactions: 0,
      sanctionsHits: 1,
      travelRuleCompliance: 100,
      avgRiskScore: 80,
      highRiskEntities: 2,
    },
    generatedBy: ACTOR,
    submittedBy: null,
    notes: null,
    fileSizeBytes: 100,
    generationDurationMs: 250,
    metadata: {},
    regulatorRef: null,
    submittedAt: null,
    acknowledgedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as any;
}

function database() {
  const db: any = {
    payment: { findMany: jest.fn() },
    regulatoryReport: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest
        .fn()
        .mockResolvedValue({ _avg: { generationDurationMs: null } }),
    },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(async (operation: (tx: any) => unknown) =>
    operation(db),
  );
  return db;
}

describe("ReportingService hardened persistence", () => {
  let db: ReturnType<typeof database>;
  let audit: { createAuditEntryInTransaction: jest.Mock };

  beforeEach(() => {
    db = database();
    audit = { createAuditEntryInTransaction: jest.fn().mockResolvedValue({}) };
  });

  it("returns defensive copies of templates and includes international templates for a jurisdiction", () => {
    const service = new ReportingService(db, audit as any, null, () => NOW);
    const all = service.getTemplates();
    all[0].name = "tampered";
    expect(service.getTemplates()[0].name).not.toBe("tampered");
    const uae = service.getTemplates("UAE");
    expect(uae.length).toBeGreaterThan(1);
    expect(
      uae.every((item) => ["UAE", "INTERNATIONAL"].includes(item.jurisdiction)),
    ).toBe(true);
  });

  it("rejects unknown templates and missing tenant before reading payments", async () => {
    const service = new ReportingService(db, audit as any, null, () => NOW);
    const request = {
      templateId: "missing",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    };
    await expect(
      service.generateReport(request, ACTOR, BUSINESS_ID),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    await expect(
      service.generateReport({ ...request, templateId: "tpl-sar" }, ACTOR, ""),
    ).rejects.toMatchObject({ code: "TENANT_REQUIRED", statusCode: 401 });
    expect(db.payment.findMany).not.toHaveBeenCalled();
  });

  it("rejects reversed, oversized and unsupported filter ranges", async () => {
    const service = new ReportingService(db, audit as any, null, () => NOW);
    await expect(
      service.generateReport(
        { templateId: "tpl-sar", dateFrom: "2026-02-01", dateTo: "2026-01-01" },
        ACTOR,
        BUSINESS_ID,
      ),
    ).rejects.toMatchObject({ code: "INVALID_DATE_RANGE" });
    await expect(
      service.generateReport(
        { templateId: "tpl-sar", dateFrom: "2024-01-01", dateTo: "2026-01-01" },
        ACTOR,
        BUSINESS_ID,
      ),
    ).rejects.toMatchObject({ code: "INVALID_DATE_RANGE" });
    await expect(
      service.generateReport(
        {
          templateId: "tpl-sar",
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31",
          filters: { status: "UNKNOWN" },
        },
        ACTOR,
        BUSINESS_ID,
      ),
    ).rejects.toMatchObject({ code: "INVALID_FILTER" });
  });

  it("builds a report exclusively from persisted tenant payment and screening evidence", async () => {
    db.payment.findMany.mockResolvedValue([
      {
        paymentId: "pay-1",
        sender: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        recipient: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        amount: new Prisma.Decimal("10000"),
        currency: "USD",
        status: "FLAGGED",
        riskScore: 80,
        initiatedAt: new Date("2026-01-15T00:00:00.000Z"),
        screenings: [
          {
            sanctionsClear: false,
            amlRiskScore: 80,
            travelRuleCompliant: true,
            status: "ESCALATED",
          },
        ],
        travelRuleRecord: { id: "travel-1" },
      },
    ]);
    db.regulatoryReport.create.mockImplementation(({ data }: any) =>
      report({
        ...data,
        createdAt: NOW,
        submittedAt: null,
        acknowledgedAt: null,
        regulatorRef: null,
      }),
    );
    const service = new ReportingService(db, audit as any, null, () => NOW);
    const result = await service.generateReport(
      {
        templateId: "tpl-sar",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        filters: { currency: "USD" },
      },
      ACTOR,
      BUSINESS_ID,
    );
    expect(result.summary).toMatchObject({
      totalTransactions: 1,
      totalVolume: "10000.00",
      flaggedTransactions: 1,
      sanctionsHits: 1,
      highRiskEntities: 2,
    });
    expect(result.contentHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(db.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          businessId: BUSINESS_ID,
          currency: "USD",
        }),
        take: 2_001,
        select: expect.objectContaining({
          paymentId: true,
          screenings: expect.objectContaining({ take: 11 }),
          travelRuleRecord: { select: { id: true } },
        }),
      }),
    );
    expect(audit.createAuditEntryInTransaction).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ businessId: BUSINESS_ID }),
    );
  });

  it("uses tenant-scoped lookups and conceals foreign reports", async () => {
    db.regulatoryReport.findFirst.mockResolvedValue(null);
    const service = new ReportingService(db, audit as any, null, () => NOW);
    await expect(
      service.getReport("rpt-foreign", BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "REPORT_NOT_FOUND",
      statusCode: 404,
    });
    expect(db.regulatoryReport.findFirst).toHaveBeenCalledWith({
      where: {
        id: "rpt-foreign",
        businessId: BUSINESS_ID,
        fileSizeBytes: {
          not: null,
          lte: REPORT_GENERATION_LIMITS.maxBytes,
        },
      },
    });
  });

  it("maps public list status to the database status while preserving tenant scope", async () => {
    db.regulatoryReport.findMany.mockResolvedValue([report()]);
    db.regulatoryReport.count.mockResolvedValue(21);
    const service = new ReportingService(db, audit as any, null, () => NOW);
    const results = await service.listReports({
      businessId: BUSINESS_ID,
      type: "SAR",
      status: "READY",
      jurisdiction: "UAE",
    });
    expect(results.data[0].status).toBe("READY");
    expect(results.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 21,
      totalPages: 2,
    });
    expect(db.regulatoryReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          businessId: BUSINESS_ID,
          reportType: "SAR",
          status: "GENERATED",
          jurisdiction: "UAE",
        },
        skip: 0,
        take: 20,
        select: expect.not.objectContaining({ reportData: true }),
      }),
    );
  });

  it("rejects invalid service-level report pagination before querying", async () => {
    const service = new ReportingService(db, audit as any, null, () => NOW);
    await expect(
      service.listReports({ businessId: BUSINESS_ID, page: 0, limit: 20 }),
    ).rejects.toMatchObject({ code: "INVALID_PAGINATION", statusCode: 400 });
    await expect(
      service.listReports({ businessId: BUSINESS_ID, page: 1, limit: 51 }),
    ).rejects.toMatchObject({ code: "INVALID_PAGINATION", statusCode: 400 });
    await expect(
      service.listReports({
        businessId: BUSINESS_ID,
        page: 1_000_001,
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PAGINATION", statusCode: 400 });
    expect(db.regulatoryReport.findMany).not.toHaveBeenCalled();
  });

  it("does not mark a report submitted without a configured regulator gateway", async () => {
    db.regulatoryReport.findFirst.mockResolvedValue(report());
    const service = new ReportingService(db, audit as any, null, () => NOW);
    await expect(
      service.submitReport("rpt-1", ACTOR, BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "REGULATORY_SUBMISSION_NOT_CONFIGURED",
      statusCode: 501,
    });
    expect(db.regulatoryReport.updateMany).not.toHaveBeenCalled();
  });

  it("rejects submission of non-generated or integrity-invalid reports", async () => {
    const gateway = { submit: jest.fn() };
    const service = new ReportingService(
      db,
      audit as any,
      gateway as any,
      () => NOW,
    );
    db.regulatoryReport.findFirst.mockResolvedValueOnce(
      report({ status: "SUBMITTED" }),
    );
    await expect(
      service.submitReport("rpt-1", ACTOR, BUSINESS_ID),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    db.regulatoryReport.findFirst.mockResolvedValueOnce(
      report({ contentHash: "not-a-hash" }),
    );
    await expect(
      service.submitReport("rpt-1", ACTOR, BUSINESS_ID),
    ).rejects.toMatchObject({ code: "REPORT_INTEGRITY_INVALID" });
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it("atomically persists a verified regulator receipt", async () => {
    const gateway: RegulatoryGateway = {
      submit: jest
        .fn()
        .mockResolvedValue({ reference: "regulator-123", status: "SUBMITTED" }),
    };
    db.regulatoryReport.findFirst.mockResolvedValue(report());
    db.regulatoryReport.updateMany.mockResolvedValue({ count: 1 });
    db.regulatoryReport.findUnique.mockResolvedValue(
      report({
        status: "SUBMITTED",
        regulatorRef: "regulator-123",
        submittedAt: NOW,
      }),
    );
    const service = new ReportingService(db, audit as any, gateway, () => NOW);
    const submitted = await service.submitReport("rpt-1", ACTOR, BUSINESS_ID);
    expect(submitted).toMatchObject({
      status: "SUBMITTED",
      regulatorRef: "regulator-123",
    });
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: "rpt-1",
        businessId: BUSINESS_ID,
        contentHash: HASH,
      }),
    );
    expect(db.regulatoryReport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rpt-1", businessId: BUSINESS_ID, status: "GENERATED" },
      }),
    );
    expect(audit.createAuditEntryInTransaction).toHaveBeenCalled();
  });

  it("rejects a concurrent submission state change", async () => {
    const gateway = {
      submit: jest
        .fn()
        .mockResolvedValue({ reference: "reg-1", status: "SUBMITTED" }),
    };
    db.regulatoryReport.findFirst.mockResolvedValue(report());
    db.regulatoryReport.updateMany.mockResolvedValue({ count: 0 });
    const service = new ReportingService(
      db,
      audit as any,
      gateway as any,
      () => NOW,
    );
    await expect(
      service.submitReport("rpt-1", ACTOR, BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "INVALID_STATE",
      statusCode: 409,
    });
    expect(audit.createAuditEntryInTransaction).not.toHaveBeenCalled();
  });

  it("calculates analytics from persisted report status and duration", async () => {
    db.regulatoryReport.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    db.regulatoryReport.groupBy
      .mockResolvedValueOnce([
        { reportType: "SAR", _count: { id: 1 } },
        { reportType: "CTR", _count: { id: 1 } },
      ])
      .mockResolvedValueOnce([
        { status: "SUBMITTED", _count: { id: 1 } },
        { status: "REJECTED_BY_REGULATOR", _count: { id: 1 } },
      ]);
    db.regulatoryReport.aggregate.mockResolvedValue({
      _avg: { generationDurationMs: 500 },
    });
    const service = new ReportingService(db, audit as any, null, () => NOW);
    const analytics = await service.getAnalytics(BUSINESS_ID);
    expect(analytics).toMatchObject({
      totalReports: 2,
      submissionRate: 0.5,
      complianceScore: 0,
      avgGenerationTime: 0.5,
      deadlinesAvailable: false,
    });
    expect(analytics.reportsByStatus).toEqual({ SUBMITTED: 1, REJECTED: 1 });
    expect(db.regulatoryReport.findMany).not.toHaveBeenCalled();
    expect(db.regulatoryReport.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId: BUSINESS_ID } }),
    );
  });

  it("exposes stable error metadata", () => {
    const error = new ReportingError("INVALID_STATE", "invalid", 409);
    expect(error).toMatchObject({
      name: "ReportingError",
      code: "INVALID_STATE",
      statusCode: 409,
    });
  });
});

describe("ReportingService production branch behavior", () => {
  let db: ReturnType<typeof database>;
  let audit: { createAuditEntryInTransaction: jest.Mock };
  let originalFetch: typeof global.fetch;
  const originalEnvironment = {
    url: process.env.REGULATORY_REPORTING_URL,
    key: process.env.REGULATORY_REPORTING_API_KEY,
    node: process.env.NODE_ENV,
  };

  const gatewayInput = {
    reportId: "rpt-1",
    businessId: BUSINESS_ID,
    reportType: "SAR" as const,
    jurisdiction: "UAE",
    contentHash: HASH,
    data: { suspiciousActivityCount: 1 },
    summary: report().summary,
  };

  function configuredAdapter(): RegulatoryGateway | null {
    return (new ReportingService(db, audit as any) as any).regulatoryGateway;
  }

  function payment(overrides: Record<string, unknown> = {}) {
    return {
      id: "payment-row-1",
      paymentId: "pay-1",
      sender: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      recipient: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      amount: new Prisma.Decimal("10000"),
      currency: "USD",
      status: "APPROVED",
      riskScore: 20,
      initiatedAt: new Date("2026-01-15T00:00:00.000Z"),
      screenings: [
        {
          sanctionsClear: true,
          amlRiskScore: 20,
          travelRuleCompliant: true,
          status: "PASSED",
        },
      ],
      travelRuleRecord: { id: "travel-1" },
      ...overrides,
    } as any;
  }

  function prepareGeneratedReport() {
    db.regulatoryReport.create.mockImplementation(({ data }: any) =>
      report({
        ...data,
        createdAt: NOW,
        submittedAt: null,
        acknowledgedAt: null,
        regulatorRef: null,
      }),
    );
  }

  async function generate(
    templateId: string,
    rows: any[] = [],
    inputOverrides: Record<string, unknown> = {},
  ) {
    db.payment.findMany.mockResolvedValue(rows);
    prepareGeneratedReport();
    return new ReportingService(
      db,
      audit as any,
      null,
      () => NOW,
    ).generateReport(
      {
        templateId,
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        ...inputOverrides,
      } as any,
      ACTOR,
      BUSINESS_ID,
    );
  }

  it("rejects payment and nested-screening cardinality above synchronous limits", async () => {
    await expect(
      generate(
        "tpl-sar",
        Array.from(
          { length: REPORT_GENERATION_LIMITS.maxPayments + 1 },
          (_, index) =>
            payment({ id: `row-${index}`, paymentId: `pay-${index}` }),
        ),
      ),
    ).rejects.toMatchObject({
      code: "REPORT_ROW_LIMIT_EXCEEDED",
      statusCode: 413,
    });

    await expect(
      generate("tpl-sar", [
        payment({
          screenings: Array.from(
            {
              length: REPORT_GENERATION_LIMITS.maxScreeningsPerPayment + 1,
            },
            () => ({
              sanctionsClear: true,
              amlRiskScore: 1,
              travelRuleCompliant: true,
              status: "PASSED",
            }),
          ),
        }),
      ]),
    ).rejects.toMatchObject({
      code: "REPORT_SCREENING_LIMIT_EXCEEDED",
      statusCode: 413,
    });
    expect(db.regulatoryReport.create).not.toHaveBeenCalled();
  });

  it("rejects canonical report content above five MiB before persistence", async () => {
    await expect(
      generate("tpl-sar", [
        payment({
          status: "FLAGGED",
          sender: "x".repeat(REPORT_GENERATION_LIMITS.maxBytes),
        }),
      ]),
    ).rejects.toMatchObject({
      code: "REPORT_SIZE_LIMIT_EXCEEDED",
      statusCode: 413,
    });
    expect(db.regulatoryReport.create).not.toHaveBeenCalled();
  });

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  beforeEach(() => {
    db = database();
    audit = { createAuditEntryInTransaction: jest.fn().mockResolvedValue({}) };
    delete process.env.REGULATORY_REPORTING_URL;
    delete process.env.REGULATORY_REPORTING_API_KEY;
    process.env.NODE_ENV = "test";
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalEnvironment.url === undefined)
      delete process.env.REGULATORY_REPORTING_URL;
    else process.env.REGULATORY_REPORTING_URL = originalEnvironment.url;
    if (originalEnvironment.key === undefined)
      delete process.env.REGULATORY_REPORTING_API_KEY;
    else process.env.REGULATORY_REPORTING_API_KEY = originalEnvironment.key;
    if (originalEnvironment.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment.node;
  });

  it("keeps regulatory submission disabled without configuration", () => {
    expect(configuredAdapter()).toBeNull();
  });

  it.each([
    ["https://regulator.aethelred.network", undefined],
    [undefined, "secret"],
  ])("fails closed with incomplete regulator credentials", async (url, key) => {
    if (url) process.env.REGULATORY_REPORTING_URL = url;
    if (key) process.env.REGULATORY_REPORTING_API_KEY = key;
    await expect(
      configuredAdapter()!.submit(gatewayInput),
    ).rejects.toMatchObject({
      code: "REGULATORY_GATEWAY_MISCONFIGURED",
      statusCode: 503,
    });
  });

  it("rejects an invalid URL and a cleartext production URL", async () => {
    process.env.REGULATORY_REPORTING_API_KEY = "secret";
    process.env.REGULATORY_REPORTING_URL = "http://[";
    await expect(configuredAdapter()!.submit(gatewayInput)).rejects.toThrow(
      "URL is invalid",
    );

    process.env.NODE_ENV = "production";
    process.env.REGULATORY_REPORTING_URL = "http://regulator.aethelred.network";
    await expect(configuredAdapter()!.submit(gatewayInput)).rejects.toThrow(
      "must use HTTPS",
    );
  });

  it.each([
    [undefined, "SUBMITTED", undefined],
    [NOW.toISOString(), "ACKNOWLEDGED", NOW],
  ])(
    "submits through the configured gateway with acknowledgement %s",
    async (acknowledgedAt, status, expected) => {
      process.env.REGULATORY_REPORTING_API_KEY = "secret";
      process.env.REGULATORY_REPORTING_URL =
        "https://regulator.aethelred.network/base";
      (global.fetch as jest.Mock).mockResolvedValue(
        new Response(
          JSON.stringify({
            reference: "reg-1",
            status,
            acknowledgedAt,
          }),
          { status: 200 },
        ),
      );
      await expect(configuredAdapter()!.submit(gatewayInput)).resolves.toEqual({
        reference: "reg-1",
        status,
        acknowledgedAt: expected,
      });
      expect(global.fetch).toHaveBeenCalledWith(
        new URL("https://regulator.aethelred.network/v1/reports"),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "X-API-Key": "secret",
            "Idempotency-Key": HASH,
          }),
        }),
      );
    },
  );

  it("classifies regulator rejection and transport failure", async () => {
    process.env.REGULATORY_REPORTING_API_KEY = "secret";
    process.env.REGULATORY_REPORTING_URL =
      "https://regulator.aethelred.network";
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response("{}", { status: 503 }),
    );
    await expect(
      configuredAdapter()!.submit(gatewayInput),
    ).rejects.toMatchObject({
      code: "REGULATORY_GATEWAY_UNAVAILABLE",
    });
    (global.fetch as jest.Mock).mockRejectedValueOnce(
      new Error("connection reset"),
    );
    await expect(
      configuredAdapter()!.submit(gatewayInput),
    ).rejects.toMatchObject({
      code: "REGULATORY_GATEWAY_UNAVAILABLE",
      message: "Regulatory gateway is unavailable",
    });
  });

  it.each([
    [{ reference: 42, status: "SUBMITTED" }, "reference type"],
    [{ reference: "", status: "SUBMITTED" }, "empty reference"],
    [{ reference: "x".repeat(201), status: "SUBMITTED" }, "long reference"],
    [{ reference: "reg-1", status: "PENDING" }, "status"],
    [
      { reference: "reg-1", status: "ACKNOWLEDGED", acknowledgedAt: "invalid" },
      "time",
    ],
  ])("rejects an invalid regulatory receipt (%s)", async (body, _label) => {
    process.env.REGULATORY_REPORTING_API_KEY = "secret";
    process.env.REGULATORY_REPORTING_URL =
      "https://regulator.aethelred.network";
    (global.fetch as jest.Mock).mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );
    await expect(
      configuredAdapter()!.submit(gatewayInput),
    ).rejects.toMatchObject({
      code: "REGULATORY_GATEWAY_INVALID_RESPONSE",
    });
  });

  it("accepts full ISO timestamps and rejects invalid boundaries", async () => {
    await expect(
      generate("tpl-sar", [], {
        dateFrom: "2026-01-01T12:00:00.000Z",
        dateTo: "2026-01-02T12:00:00.000Z",
      }),
    ).resolves.toMatchObject({ type: "SAR" });
    await expect(
      generate("tpl-sar", [], { dateFrom: "invalid" }),
    ).rejects.toMatchObject({
      code: "INVALID_DATE_RANGE",
    });
    await expect(
      generate("tpl-sar", [], { dateTo: "invalid" }),
    ).rejects.toMatchObject({
      code: "INVALID_DATE_RANGE",
    });
  });

  it("applies a supported status filter and persists report notes", async () => {
    const generated = await generate("tpl-sar", [], {
      filters: { status: "SETTLED" },
      notes: "Reviewed by compliance",
    });
    expect(generated.notes).toBe("Reviewed by compliance");
    expect(db.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "SETTLED" }),
      }),
    );
  });

  it.each(["tpl-sar", "tpl-str"])(
    "builds suspicious activity evidence for %s",
    async (templateId) => {
      const generated = await generate(templateId, [
        payment({ status: "FLAGGED" }),
        payment({ paymentId: "rejected", status: "REJECTED" }),
        payment({
          paymentId: "failed",
          status: "APPROVED",
          screenings: [
            {
              sanctionsClear: true,
              amlRiskScore: 50,
              travelRuleCompliant: false,
              status: "FAILED",
            },
          ],
        }),
        payment({
          paymentId: "escalated",
          screenings: [
            {
              sanctionsClear: true,
              amlRiskScore: 50,
              travelRuleCompliant: false,
              status: "ESCALATED",
            },
          ],
        }),
        payment({ paymentId: "clear", riskScore: null, screenings: [] }),
      ]);
      expect(generated.data).toMatchObject({ suspiciousActivityCount: 4 });
      expect(generated.summary).toMatchObject({
        flaggedTransactions: 4,
        blockedTransactions: 1,
      });
    },
  );

  it("builds CTR threshold evidence for AED, USD, and unsupported currencies", async () => {
    const generated = await generate("tpl-ctr", [
      payment({
        paymentId: "aed-at",
        currency: "AED",
        amount: new Prisma.Decimal("55000"),
      }),
      payment({
        paymentId: "aed-under",
        currency: "AED",
        amount: new Prisma.Decimal("54999"),
      }),
      payment({
        paymentId: "usd-at",
        currency: "USD",
        amount: new Prisma.Decimal("10000"),
      }),
      payment({
        paymentId: "usd-under",
        currency: "USD",
        amount: new Prisma.Decimal("9999"),
      }),
      payment({
        paymentId: "eur",
        currency: "EUR",
        amount: new Prisma.Decimal("20000"),
      }),
    ]);
    expect(generated.data).toMatchObject({
      totalReportable: 2,
      unsupportedCurrencies: ["EUR"],
    });
    expect((generated.data.volumeByCurrency as any).AED).toBe("109999.00");
  });

  it("builds travel-rule evidence from screenings and persisted records", async () => {
    const generated = await generate("tpl-fatf", [
      payment({ paymentId: "compliant" }),
      payment({
        paymentId: "mixed",
        travelRuleRecord: null,
        screenings: [
          {
            sanctionsClear: true,
            amlRiskScore: 20,
            travelRuleCompliant: true,
            status: "PASSED",
          },
          {
            sanctionsClear: true,
            amlRiskScore: 30,
            travelRuleCompliant: false,
            status: "PASSED",
          },
        ],
      }),
      payment({
        paymentId: "unscreened",
        screenings: [],
        travelRuleRecord: null,
      }),
    ]);
    expect(generated.data).toMatchObject({
      travelRuleCompliance: { total: 2, compliant: 1 },
      missingTravelRuleRecords: ["mixed", "unscreened"],
    });
  });

  it("builds sanctions screening evidence with hits and unscreened payments", async () => {
    const generated = await generate("tpl-sanctions", [
      payment({
        paymentId: "hit",
        screenings: [
          {
            sanctionsClear: false,
            amlRiskScore: 90,
            travelRuleCompliant: true,
            status: "ESCALATED",
          },
        ],
      }),
      payment({ paymentId: "clear" }),
      payment({ paymentId: "none", screenings: [] }),
    ]);
    expect(generated.data).toMatchObject({
      screeningVolume: 2,
      hits: ["hit"],
      sanctionsHits: 1,
    });
  });

  it("builds all AML risk buckets and escalation counts", async () => {
    const generated = await generate("tpl-aml", [
      payment({ paymentId: "low", riskScore: 29 }),
      payment({ paymentId: "medium", riskScore: 30 }),
      payment({ paymentId: "medium-high", riskScore: 69 }),
      payment({
        paymentId: "high",
        riskScore: 70,
        screenings: [
          {
            sanctionsClear: true,
            amlRiskScore: 70,
            travelRuleCompliant: true,
            status: "ESCALATED",
          },
        ],
      }),
      payment({ paymentId: "none", riskScore: null }),
    ]);
    expect(generated.data).toMatchObject({
      riskDistribution: { low: 1, medium: 2, high: 1, unscored: 1 },
      escalations: 1,
    });
  });

  it("builds risk assessment evidence with high-risk and unscored payments", async () => {
    const generated = await generate("tpl-risk", [
      payment({ paymentId: "high", riskScore: 90 }),
      payment({ paymentId: "zero", riskScore: 0 }),
      payment({ paymentId: "none", riskScore: null }),
    ]);
    expect(generated.data).toMatchObject({
      highRiskPayments: ["high"],
      unscoredPayments: ["none"],
    });
    expect(generated.summary.highRiskEntities).toBe(2);
  });

  it("produces zero summary rates when no screening or risk evidence exists", async () => {
    const generated = await generate("tpl-risk", [
      payment({ riskScore: null, screenings: [] }),
    ]);
    expect(generated.summary).toMatchObject({
      travelRuleCompliance: 0,
      avgRiskScore: 0,
    });
  });

  it("conceals a missing report before submission", async () => {
    db.regulatoryReport.findFirst.mockResolvedValue(null);
    await expect(
      new ReportingService(
        db,
        audit as any,
        { submit: jest.fn() } as any,
        () => NOW,
      ).submitReport("missing", ACTOR, BUSINESS_ID),
    ).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
  });

  it.each(["DRAFT", "SUBMITTED", "ACKNOWLEDGED", "REJECTED_BY_REGULATOR"])(
    "maps the %s database status in submission errors",
    async (status) => {
      db.regulatoryReport.findFirst.mockResolvedValue(report({ status }));
      await expect(
        new ReportingService(
          db,
          audit as any,
          { submit: jest.fn() } as any,
          () => NOW,
        ).submitReport("rpt-1", ACTOR, BUSINESS_ID),
      ).rejects.toMatchObject({ code: "INVALID_STATE" });
    },
  );

  it.each([null, "", "0x1234"])(
    "rejects the invalid content hash %s",
    async (contentHash) => {
      db.regulatoryReport.findFirst.mockResolvedValue(report({ contentHash }));
      await expect(
        new ReportingService(
          db,
          audit as any,
          { submit: jest.fn() } as any,
          () => NOW,
        ).submitReport("rpt-1", ACTOR, BUSINESS_ID),
      ).rejects.toMatchObject({ code: "REPORT_INTEGRITY_INVALID" });
    },
  );

  it.each([
    [undefined, NOW],
    [new Date("2026-07-20T00:00:00Z"), new Date("2026-07-20T00:00:00Z")],
  ])(
    "persists acknowledged submission time %#",
    async (receiptTime, expectedTime) => {
      const gateway = {
        submit: jest.fn().mockResolvedValue({
          reference: "reg-ack",
          status: "ACKNOWLEDGED",
          acknowledgedAt: receiptTime,
        }),
      };
      db.regulatoryReport.findFirst.mockResolvedValue(report());
      db.regulatoryReport.updateMany.mockResolvedValue({ count: 1 });
      db.regulatoryReport.findUnique.mockResolvedValue(
        report({
          status: "ACKNOWLEDGED",
          regulatorRef: "reg-ack",
          submittedAt: NOW,
          acknowledgedAt: expectedTime,
        }),
      );
      await expect(
        new ReportingService(
          db,
          audit as any,
          gateway as any,
          () => NOW,
        ).submitReport("rpt-1", ACTOR, BUSINESS_ID),
      ).resolves.toMatchObject({
        status: "ACKNOWLEDGED",
        acknowledgedAt: expectedTime,
      });
      expect(db.regulatoryReport.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ acknowledgedAt: expectedTime }),
        }),
      );
    },
  );

  it("fails if a submitted report disappears after its atomic update", async () => {
    const gateway = {
      submit: jest
        .fn()
        .mockResolvedValue({ reference: "reg-1", status: "SUBMITTED" }),
    };
    db.regulatoryReport.findFirst.mockResolvedValue(report());
    db.regulatoryReport.updateMany.mockResolvedValue({ count: 1 });
    db.regulatoryReport.findUnique.mockResolvedValue(null);
    await expect(
      new ReportingService(
        db,
        audit as any,
        gateway as any,
        () => NOW,
      ).submitReport("rpt-1", ACTOR, BUSINESS_ID),
    ).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
  });

  it("requires a tenant and supports unfiltered report lists", async () => {
    const service = new ReportingService(db, audit as any, null, () => NOW);
    await expect(service.listReports({ businessId: "" })).rejects.toMatchObject(
      { code: "TENANT_REQUIRED" },
    );
    db.regulatoryReport.findMany.mockResolvedValue([]);
    await expect(
      service.listReports({ businessId: BUSINESS_ID }),
    ).resolves.toEqual({
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
    expect(db.regulatoryReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId: BUSINESS_ID },
      }),
    );
  });

  it.each([
    "DRAFT",
    "READY",
    "SUBMITTED",
    "ACKNOWLEDGED",
    "REJECTED",
    "GENERATING",
  ] as const)(
    "maps public report status %s for persistence",
    async (status) => {
      db.regulatoryReport.findMany.mockResolvedValue([]);
      await new ReportingService(db, audit as any, null, () => NOW).listReports(
        { businessId: BUSINESS_ID, status },
      );
      expect(db.regulatoryReport.findMany).toHaveBeenCalled();
    },
  );

  it("maps unknown templates, nullable fields, malformed JSON summaries, and every persisted status", async () => {
    db.regulatoryReport.findMany.mockResolvedValue([
      report({
        id: "draft",
        templateId: "custom-template",
        reportType: "CUSTOM",
        status: "DRAFT",
        reportData: null,
        summary: null,
        generatedBy: null,
        fileSizeBytes: null,
        notes: null,
      }),
      report({
        id: "ack",
        status: "ACKNOWLEDGED",
        reportData: [],
        summary: { totalTransactions: Number.NaN, totalVolume: 42 },
      }),
    ]);
    const result = await new ReportingService(
      db,
      audit as any,
      null,
      () => NOW,
    ).listReports({ businessId: BUSINESS_ID });
    expect(result.data[0]).toMatchObject({
      type: "CUSTOM",
      name: "CUSTOM",
      status: "DRAFT",
      generatedBy: "",
      fileSize: "unknown",
      notes: "",
      summary: { totalTransactions: 0, totalVolume: "0" },
    });
    expect(result.data[0]).not.toHaveProperty("data");
    expect(result.data[1]).toMatchObject({
      status: "ACKNOWLEDGED",
      summary: { totalTransactions: 0, totalVolume: "0" },
    });
    expect(result.data[1]).not.toHaveProperty("data");
  });

  it("returns zero analytics without reports or measured generation durations", async () => {
    await expect(
      new ReportingService(db, audit as any, null, () => NOW).getAnalytics(
        BUSINESS_ID,
      ),
    ).resolves.toMatchObject({
      totalReports: 0,
      complianceScore: 0,
      submissionRate: 0,
      avgGenerationTime: 0,
    });
  });

  it("aggregates repeated report types and statuses", async () => {
    db.regulatoryReport.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);
    db.regulatoryReport.groupBy
      .mockResolvedValueOnce([{ reportType: "SAR", _count: { id: 2 } }])
      .mockResolvedValueOnce([
        { status: "SUBMITTED", _count: { id: 1 } },
        { status: "ACKNOWLEDGED", _count: { id: 1 } },
      ]);
    db.regulatoryReport.aggregate.mockResolvedValue({
      _avg: { generationDurationMs: 1000 },
    });
    const analytics = await new ReportingService(
      db,
      audit as any,
      null,
      () => NOW,
    ).getAnalytics(BUSINESS_ID);
    expect(analytics.reportsByType).toEqual({ SAR: 2 });
    expect(analytics).toMatchObject({
      complianceScore: 100,
      submissionRate: 1,
      avgGenerationTime: 1,
    });
  });

  it("uses the default ReportingError status", () => {
    expect(new ReportingError("INVALID", "invalid")).toMatchObject({
      statusCode: 400,
    });
  });
});
