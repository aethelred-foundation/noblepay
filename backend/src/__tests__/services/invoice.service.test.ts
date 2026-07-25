import { Prisma } from "@prisma/client";
import {
  InvoiceError,
  InvoiceFinancingGateway,
  InvoiceService,
} from "../../services/invoice";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR = "0x1111111111111111111111111111111111111111";
const NOW = new Date("2026-07-21T00:00:00.000Z");

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    invoiceNumber: "inv-1",
    businessId: BUSINESS_ID,
    issuer: ACTOR,
    debtor: "0x2222222222222222222222222222222222222222",
    debtorName: "Acme Buyer",
    description: "Verified receivable",
    amount: new Prisma.Decimal("1000"),
    currency: "USDC",
    issueDate: new Date("2026-07-01T00:00:00.000Z"),
    dueDate: new Date("2026-08-20T00:00:00.000Z"),
    status: "SUBMITTED",
    financedAmount: new Prisma.Decimal(0),
    purchaseOrderRef: null,
    gracePeriodDays: 30,
    latePenaltyRate: new Prisma.Decimal("0.015"),
    discountRate: null,
    creditScore: null,
    settledAt: null,
    settlementReference: null,
    metadata: {},
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    disputeReason: null,
    ...overrides,
  } as any;
}

function database() {
  const db: any = {
    business: { findUnique: jest.fn() },
    invoice: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    invoiceFinancingRequest: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    invoiceDispute: { create: jest.fn(), findFirst: jest.fn() },
    creditScore: { upsert: jest.fn() },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(async (operation: (tx: any) => unknown) =>
    operation(db),
  );
  return db;
}

const input = {
  debtor: "0x2222222222222222222222222222222222222222",
  debtorName: "Acme Buyer",
  amount: "1000",
  currency: "USDC",
  maturityDate: "2027-07-20T00:00:00.000Z",
  description: "Verified receivable",
};

describe("InvoiceService hardened persistence", () => {
  let db: ReturnType<typeof database>;
  let audit: { createAuditEntryInTransaction: jest.Mock };

  beforeEach(() => {
    db = database();
    audit = { createAuditEntryInTransaction: jest.fn().mockResolvedValue({}) };
  });

  it("requires an authenticated tenant before invoice creation", async () => {
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    await expect(service.createInvoice(input, ACTOR, "")).rejects.toMatchObject(
      {
        code: "TENANT_REQUIRED",
        statusCode: 401,
      },
    );
    expect(db.business.findUnique).not.toHaveBeenCalled();
  });

  it("rejects invalid amounts and maturity before a database write", async () => {
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    await expect(
      service.createInvoice({ ...input, amount: "-1" }, ACTOR, BUSINESS_ID),
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(
      service.createInvoice({ ...input, amount: "0" }, ACTOR, BUSINESS_ID),
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(
      service.createInvoice(
        { ...input, maturityDate: NOW.toISOString() },
        ACTOR,
        BUSINESS_ID,
      ),
    ).rejects.toMatchObject({ code: "INVALID_MATURITY" });
    expect(db.invoice.create).not.toHaveBeenCalled();
  });

  it("does not let an unverified business issue an invoice", async () => {
    db.business.findUnique.mockResolvedValue({
      address: ACTOR,
      kycStatus: "PENDING",
    });
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    await expect(
      service.createInvoice(input, ACTOR, BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "BUSINESS_NOT_VERIFIED",
      statusCode: 403,
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("atomically persists a verified invoice and its audit event", async () => {
    db.business.findUnique.mockResolvedValue({
      address: ACTOR,
      kycStatus: "VERIFIED",
    });
    db.invoice.create.mockImplementation(({ data }: any) =>
      invoice({
        ...data,
        invoiceNumber: data.id,
        issueDate: data.issueDate,
        dueDate: data.dueDate,
        discountRate: null,
        creditScore: null,
        settledAt: null,
        settlementReference: null,
      }),
    );
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    const result = await service.createInvoice(input, ACTOR, BUSINESS_ID);
    expect(result).toMatchObject({
      businessId: BUSINESS_ID,
      issuer: ACTOR,
      status: "ISSUED",
    });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          businessId: BUSINESS_ID,
          status: "SUBMITTED",
        }),
      }),
    );
    expect(audit.createAuditEntryInTransaction).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        businessId: BUSINESS_ID,
        actor: ACTOR,
      }),
    );
  });

  it("uses a tenant-scoped lookup and conceals missing invoices", async () => {
    db.invoice.findFirst.mockResolvedValue(null);
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    await expect(
      service.getInvoice("inv-foreign", BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "INVOICE_NOT_FOUND",
      statusCode: 404,
    });
    expect(db.invoice.findFirst).toHaveBeenCalledWith({
      where: { id: "inv-foreign", businessId: BUSINESS_ID },
    });
  });

  it("fails closed without a verified financing gateway and performs no read or write", async () => {
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    await expect(
      service.requestFinancing(
        "inv-1",
        "500",
        ACTOR,
        BUSINESS_ID,
        "finance-key",
      ),
    ).rejects.toMatchObject({
      code: "INVOICE_FINANCING_NOT_CONFIGURED",
      statusCode: 501,
    });
    expect(db.invoice.findFirst).not.toHaveBeenCalled();
    expect(db.invoiceFinancingRequest.create).not.toHaveBeenCalled();
  });

  it("returns an exact idempotent financing replay without calling the gateway", async () => {
    const gateway = {
      requestFinancing: jest.fn(),
      verifySettlement: jest.fn(),
    };
    db.invoiceFinancingRequest.findFirst.mockResolvedValue({
      id: "fund-1",
      invoiceId: "inv-1",
      businessId: BUSINESS_ID,
      idempotencyKey: "finance-key",
      amount: new Prisma.Decimal("500"),
      discountRate: null,
      netProceeds: null,
      factor: null,
      termDays: 30,
      status: "PENDING",
      externalReference: "gateway-1",
      createdAt: NOW,
    });
    const service = new InvoiceService(
      db,
      audit as any,
      gateway as any,
      () => NOW,
    );
    const replay = await service.requestFinancing(
      "inv-1",
      "500",
      ACTOR,
      BUSINESS_ID,
      "finance-key",
    );
    expect(replay).toMatchObject({
      id: "fund-1",
      amount: "500",
      externalReference: "gateway-1",
    });
    expect(gateway.requestFinancing).not.toHaveBeenCalled();
  });

  it("rejects a financing receipt whose amount differs from the request", async () => {
    const gateway: InvoiceFinancingGateway = {
      requestFinancing: jest.fn().mockResolvedValue({
        externalReference: "gateway-1",
        status: "PENDING",
        amount: "499",
      }),
      verifySettlement: jest.fn(),
    };
    db.invoiceFinancingRequest.findFirst.mockResolvedValue(null);
    db.invoice.findFirst.mockResolvedValue(invoice());
    const service = new InvoiceService(db, audit as any, gateway, () => NOW);
    await expect(
      service.requestFinancing(
        "inv-1",
        "500",
        ACTOR,
        BUSINESS_ID,
        "finance-key",
      ),
    ).rejects.toMatchObject({
      code: "GATEWAY_AMOUNT_MISMATCH",
      statusCode: 503,
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("fails settlement closed without a verified receipt provider", async () => {
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    await expect(
      service.settleInvoice("inv-1", ACTOR, BUSINESS_ID, "settle-ref"),
    ).rejects.toMatchObject({
      code: "INVOICE_SETTLEMENT_NOT_CONFIGURED",
      statusCode: 501,
    });
    expect(db.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("raises a dispute atomically inside the authenticated tenant", async () => {
    db.invoice.findFirst.mockResolvedValue(invoice());
    db.invoiceDispute.findFirst.mockResolvedValue(null);
    db.invoiceDispute.create.mockResolvedValue({
      id: "dispute-1",
      invoiceId: "inv-1",
      businessId: BUSINESS_ID,
      reason: "Goods did not match",
      status: "OPEN",
      raisedBy: ACTOR,
      reviewer: null,
      resolution: null,
      createdAt: NOW,
      resolvedAt: null,
    });
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    const result = await service.raiseDispute(
      "inv-1",
      "Goods did not match",
      ACTOR,
      BUSINESS_ID,
    );
    expect(result.status).toBe("OPEN");
    expect(db.invoice.findFirst).toHaveBeenCalledWith({
      where: { id: "inv-1", businessId: BUSINESS_ID },
    });
    expect(db.invoice.update).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      data: { status: "DISPUTED", disputeReason: "Goods did not match" },
    });
    expect(audit.createAuditEntryInTransaction).toHaveBeenCalled();
  });

  it("rejects a second active dispute without creating another record", async () => {
    db.invoice.findFirst.mockResolvedValue(invoice());
    db.invoiceDispute.findFirst.mockResolvedValue({ id: "existing" });
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    await expect(
      service.raiseDispute("inv-1", "duplicate", ACTOR, BUSINESS_ID),
    ).rejects.toMatchObject({ code: "DISPUTE_ALREADY_OPEN", statusCode: 409 });
    expect(db.invoiceDispute.create).not.toHaveBeenCalled();
  });

  it("filters invoice reads by tenant and maps partial financing state", async () => {
    db.invoice.findMany.mockResolvedValue([
      invoice({ financedAmount: new Prisma.Decimal("250") }),
    ]);
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    const results = await service.listInvoices({
      businessId: BUSINESS_ID,
      status: "PARTIALLY_FINANCED",
      currency: "USDC",
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: "PARTIALLY_FINANCED",
      outstandingAmount: "750",
    });
    expect(db.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          businessId: BUSINESS_ID,
          currency: "USDC",
          status: "SUBMITTED",
        },
      }),
    );
  });

  it("keeps credit unscored until three observed invoices exist", async () => {
    db.invoice.findMany.mockResolvedValue([
      invoice({
        status: "SETTLED",
        settledAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
      invoice({ id: "inv-2", status: "WRITTEN_OFF" }),
    ]);
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    const score = await service.getCreditScore(BUSINESS_ID);
    expect(score).toMatchObject({
      score: null,
      grade: "UNRATED",
      sampleSize: 2,
    });
    expect(db.creditScore.upsert).not.toHaveBeenCalled();
  });

  it("derives analytics from persisted tenant invoices", async () => {
    db.invoice.findMany.mockResolvedValue([
      invoice({
        amount: new Prisma.Decimal("1000"),
        financedAmount: new Prisma.Decimal("250"),
      }),
      invoice({
        id: "inv-2",
        amount: new Prisma.Decimal("500"),
        financedAmount: new Prisma.Decimal(0),
        status: "SETTLED",
        settledAt: new Date("2026-07-11T00:00:00.000Z"),
      }),
    ]);
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    const analytics = await service.getAnalytics(BUSINESS_ID);
    expect(analytics).toMatchObject({
      totalReceivables: "1500.00",
      totalFinanced: "250.00",
      totalOutstanding: "750.00",
      financingUtilization: 0.166667,
    });
    expect(analytics.byCurrency.USDC).toEqual({
      total: "1500.00",
      financed: "250.00",
      count: 2,
    });
    expect(db.invoice.findMany).toHaveBeenCalledWith({
      where: { businessId: BUSINESS_ID },
    });
  });

  it("exposes stable error metadata", () => {
    const error = new InvoiceError("INVALID_STATE", "state changed", 409);
    expect(error).toMatchObject({
      name: "InvoiceError",
      code: "INVALID_STATE",
      statusCode: 409,
    });
  });
});

describe("InvoiceService production branch behavior", () => {
  let db: ReturnType<typeof database>;
  let audit: { createAuditEntryInTransaction: jest.Mock };
  let originalFetch: typeof global.fetch;
  const originalEnvironment = {
    url: process.env.INVOICE_FINANCING_SERVICE_URL,
    key: process.env.INVOICE_FINANCING_API_KEY,
    node: process.env.NODE_ENV,
  };
  const financingInput = {
    idempotencyKey: "finance-key",
    invoiceId: "inv-1",
    businessId: BUSINESS_ID,
    issuer: ACTOR,
    debtor: "0x2222222222222222222222222222222222222222",
    amount: "500",
    currency: "USDC",
    maturityDate: "2026-08-20T00:00:00.000Z",
  };

  function configuredAdapter(): InvoiceFinancingGateway | null {
    return (new InvoiceService(db, audit as any) as any).gateway;
  }

  function explicitGateway(
    receipt: Partial<
      Awaited<ReturnType<InvoiceFinancingGateway["requestFinancing"]>>
    > = {},
  ) {
    return {
      requestFinancing: jest.fn().mockResolvedValue({
        externalReference: "gateway-1",
        status: "PENDING",
        amount: "500",
        ...receipt,
      }),
      verifySettlement: jest.fn().mockResolvedValue({
        externalReference: "settle-ref",
        status: "SETTLED",
        amount: "1000",
        currency: "USDC",
        settledAt: NOW,
      }),
    } as unknown as InvoiceFinancingGateway & {
      requestFinancing: jest.Mock;
      verifySettlement: jest.Mock;
    };
  }

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  beforeEach(() => {
    db = database();
    audit = { createAuditEntryInTransaction: jest.fn().mockResolvedValue({}) };
    delete process.env.INVOICE_FINANCING_SERVICE_URL;
    delete process.env.INVOICE_FINANCING_API_KEY;
    process.env.NODE_ENV = "test";
    global.fetch = jest.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalEnvironment.url === undefined)
      delete process.env.INVOICE_FINANCING_SERVICE_URL;
    else process.env.INVOICE_FINANCING_SERVICE_URL = originalEnvironment.url;
    if (originalEnvironment.key === undefined)
      delete process.env.INVOICE_FINANCING_API_KEY;
    else process.env.INVOICE_FINANCING_API_KEY = originalEnvironment.key;
    if (originalEnvironment.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment.node;
  });

  it("keeps the default gateway disabled when no remote is configured", () => {
    expect(configuredAdapter()).toBeNull();
  });

  it.each([
    ["https://finance.aethelred.network", undefined],
    [undefined, "secret"],
  ])(
    "fails closed when only one gateway credential is configured",
    async (url, key) => {
      if (url) process.env.INVOICE_FINANCING_SERVICE_URL = url;
      if (key) process.env.INVOICE_FINANCING_API_KEY = key;
      const adapter = configuredAdapter()!;
      await expect(
        adapter.requestFinancing(financingInput),
      ).rejects.toMatchObject({
        code: "FINANCING_GATEWAY_MISCONFIGURED",
        statusCode: 503,
      });
      await expect(
        adapter.verifySettlement({
          invoiceId: "inv-1",
          businessId: BUSINESS_ID,
          settlementReference: "settle-ref",
          amount: "1000",
          currency: "USDC",
        }),
      ).rejects.toMatchObject({ code: "FINANCING_GATEWAY_MISCONFIGURED" });
    },
  );

  it("rejects an invalid URL and cleartext production endpoint", async () => {
    process.env.INVOICE_FINANCING_API_KEY = "secret";
    process.env.INVOICE_FINANCING_SERVICE_URL = "http://[";
    await expect(
      configuredAdapter()!.requestFinancing(financingInput),
    ).rejects.toThrow("URL is invalid");

    process.env.NODE_ENV = "production";
    process.env.INVOICE_FINANCING_SERVICE_URL =
      "http://finance.aethelred.network";
    await expect(
      configuredAdapter()!.requestFinancing(financingInput),
    ).rejects.toThrow("must use HTTPS");
  });

  it("posts an idempotent financing request and normalizes optional receipt values", async () => {
    process.env.INVOICE_FINANCING_API_KEY = "secret";
    process.env.INVOICE_FINANCING_SERVICE_URL =
      "https://finance.aethelred.network/base";
    (global.fetch as jest.Mock).mockResolvedValue(
      new Response(
        JSON.stringify({
          externalReference: "gateway-1",
          status: "APPROVED",
          amount: 500,
          discountRate: 0.05,
          netProceeds: 475,
          factor: "factor-a",
        }),
        { status: 200 },
      ),
    );

    await expect(
      configuredAdapter()!.requestFinancing(financingInput),
    ).resolves.toEqual({
      externalReference: "gateway-1",
      status: "APPROVED",
      amount: "500",
      discountRate: "0.05",
      netProceeds: "475",
      factor: "factor-a",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      new URL("https://finance.aethelred.network/v1/financing"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-API-Key": "secret",
          "Idempotency-Key": "finance-key",
        }),
      }),
    );
  });

  it("accepts a receipt without optional pricing fields", async () => {
    process.env.INVOICE_FINANCING_API_KEY = "secret";
    process.env.INVOICE_FINANCING_SERVICE_URL =
      "https://finance.aethelred.network";
    (global.fetch as jest.Mock).mockResolvedValue(
      new Response(
        JSON.stringify({
          externalReference: "gateway-1",
          status: "PENDING",
          amount: "500",
        }),
        { status: 200 },
      ),
    );
    await expect(
      configuredAdapter()!.requestFinancing(financingInput),
    ).resolves.toMatchObject({
      discountRate: undefined,
      netProceeds: undefined,
      factor: undefined,
    });
  });

  it("classifies remote rejection, invalid JSON shape, and transport failure", async () => {
    process.env.INVOICE_FINANCING_API_KEY = "secret";
    process.env.INVOICE_FINANCING_SERVICE_URL =
      "https://finance.aethelred.network";

    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response("{}", { status: 503 }),
    );
    await expect(
      configuredAdapter()!.requestFinancing(financingInput),
    ).rejects.toMatchObject({
      code: "FINANCING_GATEWAY_UNAVAILABLE",
    });

    for (const body of ["null", "[]", '"string"']) {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(body, { status: 200 }),
      );
      await expect(
        configuredAdapter()!.requestFinancing(financingInput),
      ).rejects.toMatchObject({
        code: "INVALID_GATEWAY_RESPONSE",
      });
    }

    (global.fetch as jest.Mock).mockRejectedValueOnce(
      new Error("connection reset"),
    );
    await expect(
      configuredAdapter()!.requestFinancing(financingInput),
    ).rejects.toMatchObject({
      code: "FINANCING_GATEWAY_UNAVAILABLE",
      message: "Invoice financing gateway is unavailable",
    });
  });

  it("rejects invalid gateway statuses and references", async () => {
    process.env.INVOICE_FINANCING_API_KEY = "secret";
    process.env.INVOICE_FINANCING_SERVICE_URL =
      "https://finance.aethelred.network";
    const adapter = configuredAdapter()!;
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          externalReference: "gateway-1",
          status: "UNKNOWN",
          amount: "500",
        }),
        { status: 200 },
      ),
    );
    await expect(adapter.requestFinancing(financingInput)).rejects.toThrow(
      "invalid status",
    );

    for (const externalReference of [undefined, "", "x".repeat(201)]) {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            externalReference,
            status: "PENDING",
            amount: "500",
          }),
          { status: 200 },
        ),
      );
      await expect(adapter.requestFinancing(financingInput)).rejects.toThrow(
        "invalid reference",
      );
    }
  });

  it("verifies a settlement without forwarding an idempotency header", async () => {
    process.env.INVOICE_FINANCING_API_KEY = "secret";
    process.env.INVOICE_FINANCING_SERVICE_URL =
      "https://finance.aethelred.network";
    (global.fetch as jest.Mock).mockResolvedValue(
      new Response(
        JSON.stringify({
          externalReference: "settle-ref",
          status: "SETTLED",
          amount: 1000,
          currency: "USDC",
          settledAt: NOW.toISOString(),
        }),
        { status: 200 },
      ),
    );
    await expect(
      configuredAdapter()!.verifySettlement({
        invoiceId: "inv-1",
        businessId: BUSINESS_ID,
        settlementReference: "settle-ref",
        amount: "1000",
        currency: "USDC",
      }),
    ).resolves.toMatchObject({
      externalReference: "settle-ref",
      status: "SETTLED",
      amount: "1000",
      currency: "USDC",
      settledAt: NOW,
    });
    expect(
      (global.fetch as jest.Mock).mock.calls[0][1].headers,
    ).not.toHaveProperty("Idempotency-Key");
  });

  it.each([
    [{ status: "PENDING", settledAt: NOW.toISOString() }, "status"],
    [{ status: "SETTLED", settledAt: "not-a-date" }, "date"],
  ])("rejects a settlement with invalid %s", async (partial) => {
    process.env.INVOICE_FINANCING_API_KEY = "secret";
    process.env.INVOICE_FINANCING_SERVICE_URL =
      "https://finance.aethelred.network";
    (global.fetch as jest.Mock).mockResolvedValue(
      new Response(
        JSON.stringify({
          externalReference: "settle-ref",
          amount: "1000",
          currency: "USDC",
          ...partial,
        }),
        { status: 200 },
      ),
    );
    await expect(
      configuredAdapter()!.verifySettlement({
        invoiceId: "inv-1",
        businessId: BUSINESS_ID,
        settlementReference: "settle-ref",
        amount: "1000",
        currency: "USDC",
      }),
    ).rejects.toThrow("did not confirm settlement");
  });

  it("rejects a missing business and maturities outside the allowed window", async () => {
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    db.business.findUnique.mockResolvedValue(null);
    await expect(
      service.createInvoice(input, ACTOR, BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "BUSINESS_NOT_FOUND",
    });
    await expect(
      service.createInvoice(
        { ...input, maturityDate: "not-a-date" },
        ACTOR,
        BUSINESS_ID,
      ),
    ).rejects.toMatchObject({ code: "INVALID_MATURITY" });
    await expect(
      service.createInvoice(
        { ...input, maturityDate: "2030-01-01T00:00:00.000Z" },
        ACTOR,
        BUSINESS_ID,
      ),
    ).rejects.toMatchObject({ code: "INVALID_MATURITY" });
  });

  it("persists explicitly supplied optional invoice terms", async () => {
    db.business.findUnique.mockResolvedValue({
      address: ACTOR,
      kycStatus: "VERIFIED",
    });
    db.invoice.create.mockImplementation(({ data }: any) =>
      invoice({ ...data, invoiceNumber: data.id }),
    );
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    await service.createInvoice(
      {
        ...input,
        purchaseOrderRef: "PO-9",
        gracePeriodDays: 14,
        latePenaltyRate: 0.02,
        metadata: { shipment: "seal-9" },
      },
      ACTOR,
      BUSINESS_ID,
    );
    expect(db.invoice.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          purchaseOrderRef: "PO-9",
          gracePeriodDays: 14,
          metadata: { shipment: "seal-9" },
        }),
      }),
    );
  });

  it.each([
    [{ invoiceId: "inv-other" }, "invoice"],
    [{ amount: new Prisma.Decimal("499") }, "amount"],
  ])(
    "rejects an idempotency replay conflict on %s",
    async (override, _label) => {
      db.invoiceFinancingRequest.findFirst.mockResolvedValue({
        id: "fund-1",
        invoiceId: "inv-1",
        amount: new Prisma.Decimal("500"),
        discountRate: null,
        netProceeds: null,
        factor: null,
        termDays: 30,
        status: "PENDING",
        externalReference: "gateway-1",
        createdAt: NOW,
        ...override,
      });
      await expect(
        new InvoiceService(
          db,
          audit as any,
          explicitGateway(),
          () => NOW,
        ).requestFinancing("inv-1", "500", ACTOR, BUSINESS_ID, "finance-key"),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    },
  );

  it.each([
    [null, "INVOICE_NOT_FOUND"],
    [invoice({ status: "DISPUTED" }), "INVALID_STATE"],
    [
      invoice({ financedAmount: new Prisma.Decimal("900") }),
      "EXCEEDS_OUTSTANDING",
    ],
  ])("rejects ineligible financing state %#", async (stored, code) => {
    db.invoiceFinancingRequest.findFirst.mockResolvedValue(null);
    db.invoice.findFirst.mockResolvedValue(stored);
    await expect(
      new InvoiceService(
        db,
        audit as any,
        explicitGateway(),
        () => NOW,
      ).requestFinancing("inv-1", "500", ACTOR, BUSINESS_ID, "finance-key"),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    [{ discountRate: "invalid" }, "valid decimal"],
    [{ discountRate: "-0.1" }, "between 0 and 1"],
    [{ discountRate: "1.1" }, "between 0 and 1"],
    [
      {
        status: "FUNDED",
        discountRate: undefined,
        netProceeds: "475",
        factor: "factor-a",
      },
      "pricing",
    ],
    [
      {
        status: "FUNDED",
        discountRate: "0.05",
        netProceeds: undefined,
        factor: "factor-a",
      },
      "pricing",
    ],
    [
      {
        status: "FUNDED",
        discountRate: "0.05",
        netProceeds: "501",
        factor: "factor-a",
      },
      "pricing",
    ],
    [
      {
        status: "FUNDED",
        discountRate: "0.05",
        netProceeds: "475",
        factor: undefined,
      },
      "pricing",
    ],
  ])("rejects invalid financing receipt %#", async (receipt, message) => {
    db.invoiceFinancingRequest.findFirst.mockResolvedValue(null);
    db.invoice.findFirst.mockResolvedValue(invoice());
    await expect(
      new InvoiceService(
        db,
        audit as any,
        explicitGateway(receipt as any),
        () => NOW,
      ).requestFinancing("inv-1", "500", ACTOR, BUSINESS_ID, "finance-key"),
    ).rejects.toThrow(message);
  });

  it("returns an exact replay won by another transaction", async () => {
    const replay = {
      id: "fund-race",
      invoiceId: "inv-1",
      amount: new Prisma.Decimal("500"),
      discountRate: null,
      netProceeds: null,
      factor: null,
      termDays: 30,
      status: "PENDING",
      externalReference: "gateway-race",
      createdAt: NOW,
    };
    db.invoiceFinancingRequest.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(replay);
    db.invoice.findFirst.mockResolvedValueOnce(invoice());
    await expect(
      new InvoiceService(
        db,
        audit as any,
        explicitGateway(),
        () => NOW,
      ).requestFinancing("inv-1", "500", ACTOR, BUSINESS_ID, "finance-key"),
    ).resolves.toMatchObject({ id: "fund-race" });
    expect(db.invoiceFinancingRequest.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ invoiceId: "inv-other" }, "invoice"],
    [{ amount: new Prisma.Decimal("499") }, "amount"],
  ])(
    "rejects a conflicting replay won during the transaction (%s)",
    async (override, _label) => {
      const replay = {
        id: "fund-race",
        invoiceId: "inv-1",
        amount: new Prisma.Decimal("500"),
        ...override,
      };
      db.invoiceFinancingRequest.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(replay);
      db.invoice.findFirst.mockResolvedValueOnce(invoice());
      await expect(
        new InvoiceService(
          db,
          audit as any,
          explicitGateway(),
          () => NOW,
        ).requestFinancing("inv-1", "500", ACTOR, BUSINESS_ID, "finance-key"),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    },
  );

  it.each([
    [null, "INVOICE_NOT_FOUND"],
    [
      invoice({ financedAmount: new Prisma.Decimal("900") }),
      "EXCEEDS_OUTSTANDING",
    ],
  ])(
    "rechecks the invoice after acquiring the financing lock %#",
    async (current, code) => {
      db.invoiceFinancingRequest.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      db.invoice.findFirst
        .mockResolvedValueOnce(invoice())
        .mockResolvedValueOnce(current);
      await expect(
        new InvoiceService(
          db,
          audit as any,
          explicitGateway(),
          () => NOW,
        ).requestFinancing("inv-1", "500", ACTOR, BUSINESS_ID, "finance-key"),
      ).rejects.toMatchObject({ code });
    },
  );

  it.each([
    ["PENDING", "500", "INFO", "SUBMITTED"],
    ["FUNDED", "500", "MEDIUM", "SUBMITTED"],
    ["FUNDED", "1000", "MEDIUM", "FINANCED"],
  ])(
    "persists a %s financing receipt atomically",
    async (status, amount, severity, resultingStatus) => {
      const gateway = explicitGateway(
        status === "FUNDED"
          ? {
              status: "FUNDED",
              amount,
              discountRate: "0.05",
              netProceeds: amount === "1000" ? "950" : "475",
              factor: "factor-a",
            }
          : { amount },
      );
      const current = invoice();
      const request = {
        id: `fund-${status}-${amount}`,
        invoiceId: "inv-1",
        amount: new Prisma.Decimal(amount),
        discountRate: status === "FUNDED" ? new Prisma.Decimal("0.05") : null,
        netProceeds:
          status === "FUNDED"
            ? new Prisma.Decimal(amount === "1000" ? "950" : "475")
            : null,
        factor: status === "FUNDED" ? "factor-a" : null,
        termDays: 30,
        status,
        externalReference: "gateway-1",
        createdAt: NOW,
      };
      db.invoiceFinancingRequest.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      db.invoice.findFirst
        .mockResolvedValueOnce(current)
        .mockResolvedValueOnce(current);
      db.invoiceFinancingRequest.create.mockResolvedValue(request);
      await expect(
        new InvoiceService(
          db,
          audit as any,
          gateway,
          () => NOW,
        ).requestFinancing("inv-1", amount, ACTOR, BUSINESS_ID, "finance-key"),
      ).resolves.toMatchObject({ status, amount });
      expect(audit.createAuditEntryInTransaction).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ severity }),
      );
      if (status === "FUNDED") {
        expect(db.invoice.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: resultingStatus }),
          }),
        );
      } else {
        expect(db.invoice.update).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [null, "INVOICE_NOT_FOUND"],
    [invoice({ status: "DISPUTED" }), "INVALID_STATE"],
  ])("rejects an invoice that cannot be settled %#", async (stored, code) => {
    db.invoice.findFirst.mockResolvedValue(stored);
    await expect(
      new InvoiceService(
        db,
        audit as any,
        explicitGateway(),
        () => NOW,
      ).settleInvoice("inv-1", ACTOR, BUSINESS_ID, "settle-ref"),
    ).rejects.toMatchObject({ code });
  });

  it("returns an already-settled invoice without calling the gateway", async () => {
    const gateway = explicitGateway();
    db.invoice.findFirst.mockResolvedValue(
      invoice({ status: "SETTLED", settledAt: NOW }),
    );
    await expect(
      new InvoiceService(db, audit as any, gateway, () => NOW).settleInvoice(
        "inv-1",
        ACTOR,
        BUSINESS_ID,
        "settle-ref",
      ),
    ).resolves.toMatchObject({ status: "SETTLED", outstandingAmount: "0" });
    expect(gateway.verifySettlement).not.toHaveBeenCalled();
  });

  it.each([
    [{ amount: "999" }, "amount"],
    [{ currency: "EUR" }, "currency"],
    [{ externalReference: "other-ref" }, "reference"],
  ])(
    "rejects a settlement receipt with mismatched %s",
    async (receipt, _label) => {
      const gateway = explicitGateway();
      gateway.verifySettlement.mockResolvedValue({
        externalReference: "settle-ref",
        status: "SETTLED",
        amount: "1000",
        currency: "USDC",
        settledAt: NOW,
        ...receipt,
      });
      db.invoice.findFirst.mockResolvedValue(invoice());
      await expect(
        new InvoiceService(db, audit as any, gateway, () => NOW).settleInvoice(
          "inv-1",
          ACTOR,
          BUSINESS_ID,
          "settle-ref",
        ),
      ).rejects.toMatchObject({ code: "SETTLEMENT_MISMATCH" });
    },
  );

  it("fails when settlement loses the state race or the updated row disappears", async () => {
    const gateway = explicitGateway();
    db.invoice.findFirst.mockResolvedValue(invoice());
    db.invoice.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      new InvoiceService(db, audit as any, gateway, () => NOW).settleInvoice(
        "inv-1",
        ACTOR,
        BUSINESS_ID,
        "settle-ref",
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    db.invoice.updateMany.mockResolvedValueOnce({ count: 1 });
    db.invoice.findUnique.mockResolvedValueOnce(null);
    await expect(
      new InvoiceService(db, audit as any, gateway, () => NOW).settleInvoice(
        "inv-1",
        ACTOR,
        BUSINESS_ID,
        "settle-ref",
      ),
    ).rejects.toMatchObject({ code: "INVOICE_NOT_FOUND" });
  });

  it("settles and repays financed requests in one audited transaction", async () => {
    const gateway = explicitGateway();
    db.invoice.findFirst.mockResolvedValue(invoice());
    db.invoice.updateMany.mockResolvedValue({ count: 1 });
    db.invoice.findUnique.mockResolvedValue(
      invoice({
        status: "SETTLED",
        settledAt: NOW,
        settlementReference: "settle-ref",
      }),
    );
    await expect(
      new InvoiceService(db, audit as any, gateway, () => NOW).settleInvoice(
        "inv-1",
        ACTOR,
        BUSINESS_ID,
        "settle-ref",
      ),
    ).resolves.toMatchObject({
      status: "SETTLED",
      settlementReference: "settle-ref",
    });
    expect(db.invoiceFinancingRequest.updateMany).toHaveBeenCalledWith({
      where: { invoiceId: "inv-1", businessId: BUSINESS_ID, status: "FUNDED" },
      data: { status: "REPAID" },
    });
  });

  it.each([
    [null, "INVOICE_NOT_FOUND"],
    [invoice({ status: "SETTLED" }), "INVALID_STATE"],
    [invoice({ status: "WRITTEN_OFF" }), "INVALID_STATE"],
  ])("rejects an invalid dispute target %#", async (stored, code) => {
    db.invoice.findFirst.mockResolvedValue(stored);
    await expect(
      new InvoiceService(db, audit as any, null, () => NOW).raiseDispute(
        "inv-1",
        "reason",
        ACTOR,
        BUSINESS_ID,
      ),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    "DRAFT",
    "ISSUED",
    "FINANCED",
    "SETTLED",
    "OVERDUE",
    "DISPUTED",
    "WRITTEN_OFF",
    "CANCELLED",
  ] as const)(
    "maps the %s list filter to its persisted representation",
    async (status) => {
      db.invoice.findMany.mockResolvedValue([]);
      await new InvoiceService(db, audit as any, null, () => NOW).listInvoices({
        businessId: BUSINESS_ID,
        issuer: ACTOR,
        debtor: "buyer",
        currency: "USDC",
        status,
      });
      expect(db.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            businessId: BUSINESS_ID,
            issuer: ACTOR,
            debtor: "buyer",
            currency: "USDC",
          }),
        }),
      );
    },
  );

  it("lists unfiltered invoices and drops records outside a requested mapped status", async () => {
    db.invoice.findMany.mockResolvedValue([
      invoice(),
      invoice({ id: "inv-2", status: "SETTLED" }),
    ]);
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    await expect(
      service.listInvoices({ businessId: BUSINESS_ID }),
    ).resolves.toHaveLength(2);
    await expect(
      service.listInvoices({ businessId: BUSINESS_ID, status: "ISSUED" }),
    ).resolves.toHaveLength(1);
  });

  it("conceals financing requests for a missing invoice and maps full pricing", async () => {
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    db.invoice.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.listFinancingRequests("inv-1", BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "INVOICE_NOT_FOUND",
    });
    db.invoice.findFirst.mockResolvedValueOnce({ id: "inv-1" });
    db.invoiceFinancingRequest.findMany.mockResolvedValue([
      {
        id: "fund-1",
        invoiceId: "inv-1",
        amount: new Prisma.Decimal("500"),
        discountRate: new Prisma.Decimal("0.05"),
        netProceeds: new Prisma.Decimal("475"),
        factor: "factor-a",
        termDays: 30,
        status: "FUNDED",
        externalReference: "gateway-1",
        createdAt: NOW,
      },
    ]);
    await expect(
      service.listFinancingRequests("inv-1", BUSINESS_ID),
    ).resolves.toEqual([
      expect.objectContaining({
        discountRate: 0.05,
        netProceeds: "475",
        factor: "factor-a",
      }),
    ]);
  });

  it("persists a rated credit score from mature payment outcomes", async () => {
    db.invoice.findMany.mockResolvedValue([
      invoice({
        id: "on-time",
        status: "SETTLED",
        settledAt: new Date("2026-07-10T00:00:00Z"),
        dueDate: new Date("2026-07-15T00:00:00Z"),
      }),
      invoice({
        id: "late",
        status: "SETTLED",
        settledAt: new Date("2026-07-20T00:00:00Z"),
        dueDate: new Date("2026-07-10T00:00:00Z"),
        gracePeriodDays: 0,
      }),
      invoice({ id: "default", status: "WRITTEN_OFF" }),
      invoice({
        id: "mature-open",
        status: "SUBMITTED",
        dueDate: new Date("2026-06-01T00:00:00Z"),
        gracePeriodDays: 0,
      }),
      invoice({
        id: "future",
        status: "SUBMITTED",
        dueDate: new Date("2026-08-01T00:00:00Z"),
      }),
    ]);
    const score = await new InvoiceService(
      db,
      audit as any,
      null,
      () => NOW,
    ).getCreditScore(BUSINESS_ID);
    expect(score).toMatchObject({
      sampleSize: 4,
      grade: expect.any(String),
      score: expect.any(Number),
    });
    expect(db.creditScore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId: BUSINESS_ID },
        create: expect.objectContaining({ totalInvoices: 4 }),
      }),
    );
  });

  it("covers all aging buckets, overdue balances, and empty analytics", async () => {
    db.invoice.findMany.mockResolvedValue([
      invoice({
        id: "age-10",
        issueDate: new Date("2026-07-11T00:00:00Z"),
        dueDate: new Date("2026-07-20T00:00:00Z"),
        currency: "USDC",
      }),
      invoice({
        id: "age-45",
        issueDate: new Date("2026-06-06T00:00:00Z"),
        dueDate: new Date("2026-07-01T00:00:00Z"),
        currency: "USDC",
      }),
      invoice({
        id: "age-75",
        issueDate: new Date("2026-05-07T00:00:00Z"),
        dueDate: new Date("2026-06-01T00:00:00Z"),
        currency: "EUR",
      }),
      invoice({
        id: "age-120",
        issueDate: new Date("2026-03-01T00:00:00Z"),
        dueDate: new Date("2026-04-01T00:00:00Z"),
        currency: "EUR",
      }),
      invoice({
        id: "settled",
        status: "SETTLED",
        settledAt: new Date("2026-06-30T00:00:00Z"),
        issueDate: new Date("2026-07-01T00:00:00Z"),
      }),
    ]);
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    const analytics = await service.getAnalytics(BUSINESS_ID);
    expect(analytics.agingBuckets.map((bucket) => bucket.count)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(analytics.overdueCount).toBe(4);
    expect(analytics.avgDaysToPayment).toBe(0);

    db.invoice.findMany.mockResolvedValue([]);
    await expect(service.getAnalytics(BUSINESS_ID)).resolves.toMatchObject({
      avgDaysToPayment: 0,
      financingUtilization: 0,
      byCurrency: {},
    });
  });

  it("maps persisted nullable and status variants without leaking malformed metadata", async () => {
    db.invoice.findFirst
      .mockResolvedValueOnce(
        invoice({ businessId: null, status: "DRAFT", metadata: null }),
      )
      .mockResolvedValueOnce(
        invoice({
          status: "FINANCED",
          discountRate: new Prisma.Decimal("0.1"),
          creditScore: 720,
          metadata: [],
        }),
      );
    const service = new InvoiceService(db, audit as any, null, () => NOW);
    await expect(
      service.getInvoice("inv-1", BUSINESS_ID),
    ).resolves.toMatchObject({
      businessId: "",
      status: "DRAFT",
      metadata: {},
    });
    await expect(
      service.getInvoice("inv-2", BUSINESS_ID),
    ).resolves.toMatchObject({
      status: "FINANCED",
      discountRate: 0.1,
      creditScore: 720,
      metadata: {},
    });
  });

  it("uses the default InvoiceError status for caller validation failures", () => {
    expect(new InvoiceError("INVALID", "invalid")).toMatchObject({
      statusCode: 400,
    });
  });
});
