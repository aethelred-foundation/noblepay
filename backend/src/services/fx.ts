import { Prisma, PrismaClient, type FXHedge } from "@prisma/client";
import { AuditService } from "./audit";
import { readBoundedJsonResponse } from "../lib/bounded-response";

export type HedgeType = "FORWARD" | "OPTION" | "SWAP";
export type HedgeStatus = "OPEN" | "CLOSED" | "EXPIRED" | "EXERCISED";

export interface FXRate {
  pair: string;
  bid: number;
  ask: number;
  mid: number;
  timestamp: Date;
  source: string;
  change24h: number | null;
  volume24h: string | null;
  verified: true;
}

export interface CreateHedgeInput {
  pair: string;
  type: HedgeType;
  notionalAmount: string;
  currency: string;
  strikeRate?: number;
  expiryDate: string;
  premium?: string;
  marginDeposit: string;
  metadata?: Record<string, unknown>;
}

export interface FXPosition {
  id: string;
  businessId: string;
  pair: string;
  type: HedgeType;
  notionalAmount: string;
  currency: string;
  entryRate: number;
  strikeRate: number;
  currentRate: number;
  expiryDate: Date;
  status: HedgeStatus;
  marginDeposit: null;
  premium: string | null;
  unrealizedPnL: string | null;
  markToMarket: null;
  hedgeEffectiveness: null;
  createdAt: Date;
  closedAt: Date | null;
  metadata: Record<string, never>;
  dataSource: "DATABASE_SNAPSHOT";
}

export interface ExposureReport {
  totalExposure: string;
  byCurrency: Record<
    string,
    {
      exposure: string;
      hedged: string;
      unhedged: null;
      hedgeRatio: null;
    }
  >;
  netExposure: null;
  valueAtRisk: null;
  stressTestResults: Record<string, never>;
  scope: "HEDGE_NOTIONAL_ONLY";
  calculatedAt: Date;
}

export interface FXAnalytics {
  totalPositions: number;
  totalNotional: string;
  totalUnrealizedPnL: string | null;
  totalRealizedPnL: string;
  avgHedgeEffectiveness: null;
  expiringThisWeek: number;
  marginUtilization: null;
  topPairs: Array<{ pair: string; volume: string; pnl: string }>;
  dataSource: "DATABASE_SNAPSHOT";
}

interface OracleRatePayload {
  pair?: unknown;
  bid?: unknown;
  ask?: unknown;
  mid?: unknown;
  timestamp?: unknown;
  source?: unknown;
  change24h?: unknown;
  volume24h?: unknown;
}

function positionRecord(hedge: FXHedge): FXPosition {
  return {
    id: hedge.id,
    businessId: hedge.businessId,
    pair: `${hedge.baseCurrency}/${hedge.quoteCurrency}`,
    type: hedge.type,
    notionalAmount: hedge.notional.toString(),
    currency: hedge.baseCurrency,
    entryRate: hedge.spotRate.toNumber(),
    strikeRate: hedge.strikeRate.toNumber(),
    currentRate: hedge.spotRate.toNumber(),
    expiryDate: hedge.maturityDate,
    status: hedge.status,
    marginDeposit: null,
    premium: hedge.premium?.toString() ?? null,
    unrealizedPnL: hedge.pnl?.toString() ?? null,
    markToMarket: null,
    hedgeEffectiveness: null,
    createdAt: hedge.createdAt,
    closedAt: hedge.closedAt,
    metadata: {},
    dataSource: "DATABASE_SNAPSHOT",
  };
}

/** Durable hedge ledger plus a strictly configured, freshness-checked oracle. */
export class FXService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly _auditService: AuditService,
    private readonly oracleFetch: typeof fetch = fetch,
  ) {}

  async getRates(pair?: string): Promise<FXRate[]> {
    const oracleUrl = process.env.FX_ORACLE_URL;
    if (!oracleUrl) {
      throw new FXError(
        "FX_ORACLE_UNAVAILABLE",
        "FX rates are unavailable because FX_ORACLE_URL is not configured",
        503,
      );
    }

    let url: URL;
    try {
      url = new URL(oracleUrl);
    } catch {
      throw new FXError(
        "FX_ORACLE_MISCONFIGURED",
        "FX_ORACLE_URL is invalid",
        503,
      );
    }
    if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
      throw new FXError(
        "FX_ORACLE_MISCONFIGURED",
        "The production FX oracle must use HTTPS",
        503,
      );
    }
    if (pair) url.searchParams.set("pair", pair);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.oracleFetch(url, {
        headers: process.env.FX_ORACLE_API_KEY
          ? { Authorization: `Bearer ${process.env.FX_ORACLE_API_KEY}` }
          : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new FXError(
          "FX_ORACLE_UNAVAILABLE",
          `FX oracle returned HTTP ${response.status}`,
          503,
        );
      }
      const payload = await readBoundedJsonResponse(response);
      const candidate =
        payload && typeof payload === "object" && "data" in payload
          ? (payload as { data: unknown }).data
          : payload;
      const rows = Array.isArray(candidate) ? candidate : [candidate];
      const rates = rows.map((row) => this.validateOracleRate(row));
      const filtered = pair
        ? rates.filter((rate) => rate.pair.toUpperCase() === pair.toUpperCase())
        : rates;
      if (filtered.length === 0) {
        throw new FXError(
          "PAIR_NOT_FOUND",
          pair
            ? `Currency pair ${pair} is not quoted by the oracle`
            : "The FX oracle returned no rates",
          pair ? 404 : 503,
        );
      }
      return filtered;
    } catch (error) {
      if (error instanceof FXError) throw error;
      throw new FXError(
        "FX_ORACLE_UNAVAILABLE",
        "The configured FX oracle could not be reached",
        503,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async createHedge(
    _input: CreateHedgeInput,
    _trader: string,
    _businessId: string,
  ): Promise<never> {
    throw this.executionUnavailable();
  }

  async closePosition(
    _positionId: string,
    _actor: string,
    _businessId?: string,
  ): Promise<never> {
    throw this.executionUnavailable();
  }

  async getPosition(
    positionId: string,
    businessId: string,
  ): Promise<FXPosition> {
    const position = await this.prisma.fXHedge.findFirst({
      where: { id: positionId, businessId },
    });
    if (!position) {
      throw new FXError("POSITION_NOT_FOUND", "Position not found", 404);
    }
    return positionRecord(position);
  }

  async listPositions(
    businessId: string,
    filters?: { status?: HedgeStatus; page?: number; limit?: number },
  ): Promise<FXPosition[]> {
    const positions = await this.prisma.fXHedge.findMany({
      where: { businessId, status: filters?.status },
      orderBy: { createdAt: "desc" },
      skip:
        filters?.page && filters.limit
          ? (filters.page - 1) * filters.limit
          : undefined,
      take: filters?.limit,
    });
    return positions.map(positionRecord);
  }

  async markToMarket(businessId: string): Promise<FXPosition[]> {
    return this.listPositions(businessId);
  }

  async getExposure(businessId: string): Promise<ExposureReport> {
    const positions = await this.prisma.fXHedge.findMany({
      where: { businessId, status: "OPEN" },
    });
    const byCurrency: ExposureReport["byCurrency"] = {};
    let total = new Prisma.Decimal(0);
    for (const position of positions) {
      total = total.add(position.notional);
      const current = byCurrency[position.baseCurrency]?.hedged ?? "0";
      const hedged = new Prisma.Decimal(current)
        .add(position.notional)
        .toString();
      byCurrency[position.baseCurrency] = {
        exposure: hedged,
        hedged,
        unhedged: null,
        hedgeRatio: null,
      };
    }
    return {
      totalExposure: total.toString(),
      byCurrency,
      netExposure: null,
      valueAtRisk: null,
      stressTestResults: {},
      scope: "HEDGE_NOTIONAL_ONLY",
      calculatedAt: new Date(),
    };
  }

  async getAnalytics(businessId: string): Promise<FXAnalytics> {
    const positions = await this.prisma.fXHedge.findMany({
      where: { businessId },
    });
    const open = positions.filter((position) => position.status === "OPEN");
    const oneWeekLater = new Date(Date.now() + 7 * 86_400_000);
    let totalNotional = new Prisma.Decimal(0);
    let realized = new Prisma.Decimal(0);
    let unrealized = new Prisma.Decimal(0);
    let hasUnrealized = false;
    const pairs: Record<
      string,
      { volume: Prisma.Decimal; pnl: Prisma.Decimal }
    > = {};

    for (const position of positions) {
      const pair = `${position.baseCurrency}/${position.quoteCurrency}`;
      const entry = pairs[pair] ?? {
        volume: new Prisma.Decimal(0),
        pnl: new Prisma.Decimal(0),
      };
      entry.volume = entry.volume.add(position.notional);
      if (position.pnl) entry.pnl = entry.pnl.add(position.pnl);
      pairs[pair] = entry;
      if (position.status === "OPEN") {
        totalNotional = totalNotional.add(position.notional);
        if (position.pnl) {
          unrealized = unrealized.add(position.pnl);
          hasUnrealized = true;
        }
      } else if (position.status === "CLOSED" && position.pnl) {
        realized = realized.add(position.pnl);
      }
    }

    return {
      totalPositions: open.length,
      totalNotional: totalNotional.toString(),
      totalUnrealizedPnL: hasUnrealized ? unrealized.toString() : null,
      totalRealizedPnL: realized.toString(),
      avgHedgeEffectiveness: null,
      expiringThisWeek: open.filter(
        (position) => position.maturityDate <= oneWeekLater,
      ).length,
      marginUtilization: null,
      topPairs: Object.entries(pairs)
        .map(([pair, values]) => ({
          pair,
          volume: values.volume.toString(),
          pnl: values.pnl.toString(),
        }))
        .sort((left, right) => Number(right.volume) - Number(left.volume))
        .slice(0, 5),
      dataSource: "DATABASE_SNAPSHOT",
    };
  }

  private validateOracleRate(value: unknown): FXRate {
    if (!value || typeof value !== "object") {
      throw new FXError(
        "FX_ORACLE_INVALID_RESPONSE",
        "FX oracle returned an invalid rate payload",
        503,
      );
    }
    const row = value as OracleRatePayload;
    const pair = typeof row.pair === "string" ? row.pair.trim() : "";
    const bid = Number(row.bid);
    const ask = Number(row.ask);
    const mid = Number(row.mid);
    const timestamp = new Date(String(row.timestamp ?? ""));
    const source = typeof row.source === "string" ? row.source.trim() : "";
    const maxAge = Number(process.env.FX_ORACLE_MAX_AGE_MS || 120_000);
    const age = Date.now() - timestamp.getTime();
    if (
      !/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/i.test(pair) ||
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      !Number.isFinite(mid) ||
      bid <= 0 ||
      ask < bid ||
      mid < bid ||
      mid > ask ||
      Number.isNaN(timestamp.getTime()) ||
      age < -30_000 ||
      age > maxAge ||
      !source
    ) {
      throw new FXError(
        "FX_ORACLE_INVALID_RESPONSE",
        "FX oracle returned an invalid or stale rate",
        503,
      );
    }
    return {
      pair: pair.toUpperCase(),
      bid,
      ask,
      mid,
      timestamp,
      source,
      change24h:
        row.change24h === undefined || !Number.isFinite(Number(row.change24h))
          ? null
          : Number(row.change24h),
      volume24h: row.volume24h === undefined ? null : String(row.volume24h),
      verified: true,
    };
  }

  private executionUnavailable(): FXError {
    return new FXError(
      "FX_EXECUTION_UNAVAILABLE",
      "FX trading is disabled until a broker or contract receipt verifier is configured",
      501,
    );
  }
}

export class FXError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "FXError";
  }
}
