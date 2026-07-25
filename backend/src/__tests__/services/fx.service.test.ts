import { Prisma } from "@prisma/client";
import { FXService } from "../../services/fx";
import type { AuditService } from "../../services/audit";

const now = new Date("2026-07-21T12:00:00.000Z");

function hedge(overrides: Record<string, unknown> = {}) {
  return {
    id: "hedge-1",
    businessId: "business-1",
    baseCurrency: "USDC",
    quoteCurrency: "AED",
    type: "FORWARD",
    notional: new Prisma.Decimal("1000"),
    spotRate: new Prisma.Decimal("3.67"),
    strikeRate: new Prisma.Decimal("3.7"),
    maturityDate: new Date("2026-08-01T00:00:00.000Z"),
    status: "OPEN",
    premium: null,
    pnl: null,
    createdAt: now,
    closedAt: null,
    ...overrides,
  };
}

function setup(oracleFetch: jest.Mock = jest.fn()) {
  const prisma = {
    fXHedge: { findMany: jest.fn(), findFirst: jest.fn() },
  };
  const service = new FXService(
    prisma as never,
    {} as AuditService,
    oracleFetch as typeof fetch,
  );
  return { prisma, service, oracleFetch };
}

function quote(overrides: Record<string, unknown> = {}) {
  return {
    pair: "USDC/AED",
    bid: 3.66,
    ask: 3.68,
    mid: 3.67,
    timestamp: now.toISOString(),
    source: "licensed-oracle",
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("FXService production behavior", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    process.env = {
      ...originalEnv,
      FX_ORACLE_URL: "https://oracle.example/rates",
      FX_ORACLE_MAX_AGE_MS: "120000",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
  });

  it("accepts only a fresh, internally consistent oracle quote", async () => {
    const { service, oracleFetch } = setup();
    oracleFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            pair: "USDC/AED",
            bid: 3.66,
            ask: 3.68,
            mid: 3.67,
            timestamp: now.toISOString(),
            source: "licensed-oracle",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const rates = await service.getRates("USDC/AED");

    expect(rates).toEqual([
      expect.objectContaining({
        pair: "USDC/AED",
        verified: true,
        change24h: null,
        source: "licensed-oracle",
      }),
    ]);
    expect(String(oracleFetch.mock.calls[0][0])).toContain("pair=USDC%2FAED");
  });

  it("authenticates configured oracle requests and preserves optional market fields", async () => {
    process.env.FX_ORACLE_API_KEY = "oracle-secret";
    const { service, oracleFetch } = setup();
    oracleFetch.mockResolvedValue(
      jsonResponse([
        quote({ change24h: -0.02, volume24h: "1000000" }),
        quote({ pair: "EUR/AED", bid: 4, ask: 4.1, mid: 4.05 }),
      ]),
    );

    const rates = await service.getRates();

    expect(rates).toHaveLength(2);
    expect(rates[0]).toMatchObject({ change24h: -0.02, volume24h: "1000000" });
    expect(oracleFetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: { Authorization: "Bearer oracle-secret" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("fails closed when the oracle is missing, stale, or inconsistent", async () => {
    const { service, oracleFetch } = setup();
    delete process.env.FX_ORACLE_URL;
    await expect(service.getRates()).rejects.toMatchObject({
      code: "FX_ORACLE_UNAVAILABLE",
      statusCode: 503,
    });

    process.env.FX_ORACLE_URL = "https://oracle.example/rates";
    oracleFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          pair: "USDC/AED",
          bid: 3.7,
          ask: 3.6,
          mid: 3.65,
          timestamp: new Date(now.getTime() - 300_000).toISOString(),
          source: "bad-oracle",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(service.getRates()).rejects.toMatchObject({
      code: "FX_ORACLE_INVALID_RESPONSE",
      statusCode: 503,
    });
  });

  it.each([
    ["not a URL", "not-a-url", "test"],
    ["plain HTTP in production", "http://oracle.internal/rates", "production"],
  ])(
    "rejects an oracle configuration using %s",
    async (_name, url, nodeEnv) => {
      process.env.FX_ORACLE_URL = url;
      process.env.NODE_ENV = nodeEnv;
      const { service, oracleFetch } = setup();

      await expect(service.getRates()).rejects.toMatchObject({
        code: "FX_ORACLE_MISCONFIGURED",
        statusCode: 503,
      });
      expect(oracleFetch).not.toHaveBeenCalled();
    },
  );

  it("maps upstream HTTP failures and network failures to stable unavailable errors", async () => {
    const { service, oracleFetch } = setup();
    oracleFetch.mockResolvedValueOnce(jsonResponse({ error: "busy" }, 429));
    await expect(service.getRates()).rejects.toMatchObject({
      code: "FX_ORACLE_UNAVAILABLE",
      statusCode: 503,
    });

    oracleFetch.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED secret-host"),
    );
    await expect(service.getRates()).rejects.toMatchObject({
      code: "FX_ORACLE_UNAVAILABLE",
      message: "The configured FX oracle could not be reached",
      statusCode: 503,
    });
  });

  it("distinguishes an unquoted pair from an empty oracle response", async () => {
    const { service, oracleFetch } = setup();
    oracleFetch.mockResolvedValueOnce(
      jsonResponse([quote({ pair: "EUR/AED", bid: 4, ask: 4.1, mid: 4.05 })]),
    );
    await expect(service.getRates("USDC/AED")).rejects.toMatchObject({
      code: "PAIR_NOT_FOUND",
      statusCode: 404,
    });

    oracleFetch.mockResolvedValueOnce(jsonResponse([]));
    await expect(service.getRates()).rejects.toMatchObject({
      code: "PAIR_NOT_FOUND",
      statusCode: 503,
    });
  });

  it.each([
    ["null payload", null],
    ["invalid pair", quote({ pair: "USDC-AED" })],
    ["non-numeric bid", quote({ bid: "not-a-number" })],
    ["non-numeric ask", quote({ ask: "not-a-number" })],
    ["non-numeric midpoint", quote({ mid: "not-a-number" })],
    ["non-positive bid", quote({ bid: 0 })],
    ["crossed market", quote({ bid: 3.7, ask: 3.6 })],
    ["midpoint below bid", quote({ mid: 3.5 })],
    ["midpoint above ask", quote({ mid: 4 })],
    ["invalid timestamp", quote({ timestamp: "not-a-date" })],
    [
      "future timestamp",
      quote({ timestamp: new Date(now.getTime() + 60_000).toISOString() }),
    ],
    ["missing source", quote({ source: "" })],
  ])(
    "rejects a %s response without exposing it as verified",
    async (_name, payload) => {
      const { service, oracleFetch } = setup();
      oracleFetch.mockResolvedValue(jsonResponse(payload));

      await expect(service.getRates()).rejects.toMatchObject({
        code: "FX_ORACLE_INVALID_RESPONSE",
        statusCode: 503,
      });
    },
  );

  it("tenant-scopes and paginates persisted hedge records", async () => {
    const { prisma, service } = setup();
    prisma.fXHedge.findMany.mockResolvedValue([hedge()]);

    const positions = await service.listPositions("business-1", {
      status: "OPEN",
      page: 3,
      limit: 10,
    });

    expect(positions[0]).toEqual(
      expect.objectContaining({
        businessId: "business-1",
        marginDeposit: null,
        unrealizedPnL: null,
        dataSource: "DATABASE_SNAPSHOT",
      }),
    );
    expect(prisma.fXHedge.findMany).toHaveBeenCalledWith({
      where: { businessId: "business-1", status: "OPEN" },
      orderBy: { createdAt: "desc" },
      skip: 20,
      take: 10,
    });
  });

  it("supports unfiltered history and maps optional durable values", async () => {
    const { prisma, service } = setup();
    prisma.fXHedge.findMany.mockResolvedValue([
      hedge({
        status: "CLOSED",
        premium: new Prisma.Decimal("2.5"),
        pnl: new Prisma.Decimal("17"),
        closedAt: now,
      }),
    ]);

    const positions = await service.listPositions("business-1");

    expect(positions[0]).toMatchObject({
      premium: "2.5",
      unrealizedPnL: "17",
      closedAt: now,
    });
    expect(prisma.fXHedge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: undefined, take: undefined }),
    );
  });

  it("tenant-scopes direct position reads and conceals missing records", async () => {
    const { prisma, service } = setup();
    prisma.fXHedge.findFirst.mockResolvedValueOnce(hedge());

    await expect(
      service.getPosition("hedge-1", "business-1"),
    ).resolves.toMatchObject({
      id: "hedge-1",
      businessId: "business-1",
    });
    expect(prisma.fXHedge.findFirst).toHaveBeenCalledWith({
      where: { id: "hedge-1", businessId: "business-1" },
    });

    prisma.fXHedge.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.getPosition("foreign-hedge", "business-1"),
    ).rejects.toMatchObject({ code: "POSITION_NOT_FOUND", statusCode: 404 });
  });

  it("keeps mark-to-market as a durable snapshot read", async () => {
    const { prisma, service } = setup();
    prisma.fXHedge.findMany.mockResolvedValue([hedge()]);

    const positions = await service.markToMarket("business-1");

    expect(positions).toHaveLength(1);
    expect(prisma.fXHedge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId: "business-1" } }),
    );
  });

  it("fails unverified hedge execution closed", async () => {
    const { service } = setup();
    await expect(
      service.createHedge(
        {
          pair: "USDC/AED",
          type: "FORWARD",
          notionalAmount: "1000",
          currency: "USDC",
          expiryDate: "2026-08-01T00:00:00.000Z",
          marginDeposit: "100",
        },
        "signer-1",
        "business-1",
      ),
    ).rejects.toMatchObject({
      code: "FX_EXECUTION_UNAVAILABLE",
      statusCode: 501,
    });
    await expect(
      service.closePosition("hedge-1", "signer-1", "business-1"),
    ).rejects.toMatchObject({ statusCode: 501 });
  });

  it("reports only durable hedge notional and marks unknown risk fields null", async () => {
    const { prisma, service } = setup();
    prisma.fXHedge.findMany.mockResolvedValue([hedge()]);

    const exposure = await service.getExposure("business-1");

    expect(exposure).toEqual(
      expect.objectContaining({
        totalExposure: "1000",
        netExposure: null,
        valueAtRisk: null,
        scope: "HEDGE_NOTIONAL_ONLY",
      }),
    );
  });

  it("aggregates repeated-currency exposure without inventing unhedged values", async () => {
    const { prisma, service } = setup();
    prisma.fXHedge.findMany.mockResolvedValue([
      hedge({ id: "hedge-1", notional: new Prisma.Decimal("1000") }),
      hedge({ id: "hedge-2", notional: new Prisma.Decimal("250") }),
      hedge({
        id: "hedge-3",
        baseCurrency: "EUR",
        quoteCurrency: "AED",
        notional: new Prisma.Decimal("50"),
      }),
    ]);

    const exposure = await service.getExposure("business-1");

    expect(exposure.totalExposure).toBe("1300");
    expect(exposure.byCurrency).toEqual({
      USDC: {
        exposure: "1250",
        hedged: "1250",
        unhedged: null,
        hedgeRatio: null,
      },
      EUR: { exposure: "50", hedged: "50", unhedged: null, hedgeRatio: null },
    });
  });

  it("derives hedge analytics from open and realized durable PnL", async () => {
    const { prisma, service } = setup();
    prisma.fXHedge.findMany.mockResolvedValue([
      hedge({
        id: "open-with-pnl",
        pnl: new Prisma.Decimal("10"),
        maturityDate: new Date(now.getTime() + 86_400_000),
      }),
      hedge({
        id: "closed-with-pnl",
        status: "CLOSED",
        pnl: new Prisma.Decimal("7"),
        notional: new Prisma.Decimal("2000"),
      }),
      hedge({
        id: "expired-no-pnl",
        status: "EXPIRED",
        baseCurrency: "EUR",
        quoteCurrency: "AED",
        notional: new Prisma.Decimal("500"),
      }),
    ]);

    const analytics = await service.getAnalytics("business-1");

    expect(analytics).toMatchObject({
      totalPositions: 1,
      totalNotional: "1000",
      totalUnrealizedPnL: "10",
      totalRealizedPnL: "7",
      expiringThisWeek: 1,
      dataSource: "DATABASE_SNAPSHOT",
    });
    expect(analytics.topPairs[0]).toEqual({
      pair: "USDC/AED",
      volume: "3000",
      pnl: "17",
    });
  });

  it("uses null unrealized PnL for an empty analytics snapshot", async () => {
    const { prisma, service } = setup();
    prisma.fXHedge.findMany.mockResolvedValue([]);

    await expect(service.getAnalytics("business-1")).resolves.toMatchObject({
      totalPositions: 0,
      totalUnrealizedPnL: null,
      topPairs: [],
    });
  });
});
