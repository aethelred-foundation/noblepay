import { Prisma, PrismaClient, type FXHedge } from "@prisma/client";
import { AuditService } from "./audit";
import { readBoundedJsonResponse } from "../lib/bounded-response";
import { verifyHedgeClose, verifyHedgeOpen } from "./fx-execution";
import type { ChainHedgeType, ChainPositionStatus } from "./fx-chain";
import type { NoblePayChainConfiguration } from "../lib/production-config";

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
  /**
   * The contract's own type and status, null for rows that predate on-chain
   * linkage. Surfaced separately from `type` and `status` because those use the
   * database enums, which cannot express OPTION_CALL vs OPTION_PUT, LIQUIDATED,
   * or EMERGENCY_UNWOUND — see docs/audit/NP-FX-01. A caller that needs to know
   * whether a position was liquidated must read onChainStatus; `status` will
   * say CLOSED.
   */
  onChainPositionId: string | null;
  onChainHedgeType: ChainHedgeType | null;
  onChainStatus: ChainPositionStatus | null;
  openTxHash: string | null;
  closeTxHash: string | null;
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
    onChainPositionId: hedge.onChainPositionId,
    onChainHedgeType: (hedge.onChainHedgeType as ChainHedgeType) ?? null,
    onChainStatus: (hedge.onChainStatus as ChainPositionStatus) ?? null,
    openTxHash: hedge.openTxHash,
    closeTxHash: hedge.closeTxHash,
  };
}

/**
 * How a terminal chain status lands in the narrower database enum.
 *
 * Two of these are lossy and deliberately so: LIQUIDATED and EMERGENCY_UNWOUND
 * both become CLOSED because HedgeStatus has nothing better. The real value is
 * kept in onChainStatus rather than discarded, which is the only reason this
 * mapping is acceptable at all. See docs/audit/NP-FX-01.
 */
const CHAIN_STATUS_TO_DB: Record<string, HedgeStatus> = {
  SETTLED: "CLOSED",
  EXERCISED: "EXERCISED",
  EXPIRED: "EXPIRED",
  LIQUIDATED: "CLOSED",
  EMERGENCY_UNWOUND: "CLOSED",
};

/** Durable hedge ledger plus a strictly configured, freshness-checked oracle. */
export class FXService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly auditService: AuditService,
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

  /**
   * Record a hedge position that has already been opened on chain.
   *
   * The API holds no key and places no trade. The hedger opens the position in
   * FXHedgingVault from their own wallet, reports the transaction, and the
   * record is written only if the chain corroborates it.
   *
   * `onChainHedgeType` is required and separate from `input.type` because the
   * database enum cannot carry the distinction: OPTION says nothing about call
   * versus put, which are opposite positions.
   */
  async createHedge(
    input: CreateHedgeInput,
    trader: string,
    businessId: string,
    opening: {
      txHash: string;
      onChainPositionId: string;
      onChainHedgeType: ChainHedgeType;
    },
    config: NoblePayChainConfiguration,
  ): Promise<FXPosition> {
    // The vault creates forwards and options. There is no swap, so a SWAP hedge
    // can never have a receipt and is refused here rather than being mapped
    // onto something the vault might plausibly have emitted.
    if (input.type === "SWAP") {
      throw new FXError(
        "FX_UNSUPPORTED_HEDGE_TYPE",
        "FXHedgingVault cannot create a SWAP position, so one cannot be verified",
        422,
      );
    }
    const typesAgree =
      input.type === "FORWARD"
        ? opening.onChainHedgeType === "FORWARD"
        : opening.onChainHedgeType === "OPTION_CALL" ||
          opening.onChainHedgeType === "OPTION_PUT";
    if (!typesAgree) {
      throw new FXError(
        "FX_TYPE_MISMATCH",
        `A ${input.type} hedge cannot be opened as ${opening.onChainHedgeType}`,
        422,
      );
    }

    const existing = await this.prisma.fXHedge.findFirst({
      where: { onChainPositionId: opening.onChainPositionId.toLowerCase() },
    });
    if (existing) {
      if (existing.openTxHash === opening.txHash.toLowerCase()) {
        return positionRecord(existing);
      }
      throw new FXError(
        "POSITION_ALREADY_RECORDED",
        `This on-chain position is already recorded under ${existing.openTxHash ?? "an unrecorded transaction"}`,
        409,
      );
    }

    // Throws FXExecutionError with a specific reason if any check fails.
    const verified = await verifyHedgeOpen(config, {
      txHash: opening.txHash,
      onChainPositionId: opening.onChainPositionId,
      expectedHedger: trader,
      expectedHedgeType: opening.onChainHedgeType,
    });

    const [base, quote] = input.pair.split("/");
    const created = await this.prisma.fXHedge.create({
      data: {
        businessId,
        type: input.type,
        baseCurrency: base ?? input.currency,
        quoteCurrency: quote ?? input.currency,
        // The caller's decimal figures, in the units these columns have always
        // held. The chain's raw values are not written here: converting needs
        // the vault's RATE_PRECISION and the token's decimals, and guessing
        // either is how NP-TREASURY-01 happened.
        notional: new Prisma.Decimal(input.notionalAmount),
        strikeRate: new Prisma.Decimal(input.strikeRate ?? 0),
        spotRate: new Prisma.Decimal(input.strikeRate ?? 0),
        premium: input.premium ? new Prisma.Decimal(input.premium) : null,
        maturityDate: verified.maturityDate ?? new Date(input.expiryDate),
        status: "OPEN",
        onChainPositionId: verified.onChainPositionId,
        openTxHash: verified.txHash,
        onChainHedgeType: verified.hedgeType,
        onChainStatus: verified.chainStatus,
      },
    });

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: trader,
      description: `FX hedge opened on chain: ${verified.hedgeType} ${input.pair} via ${verified.txHash}`,
      severity: "HIGH",
      businessId,
      metadata: {
        hedgeId: created.id,
        onChainPositionId: verified.onChainPositionId,
        txHash: verified.txHash,
        blockNumber: verified.blockNumber,
        hedgeType: verified.hedgeType,
        notionalAmount: verified.notionalAmount,
        amountBasis: "RAW_CONTRACT_UNITS",
      },
    });

    return positionRecord(created);
  }

  /**
   * Record a position leaving ACTIVE.
   *
   * The caller does not say how it closed — the chain does. A position can be
   * settled, exercised, expired, liquidated or emergency-unwound, and those are
   * not interchangeable: a liquidation is a margin failure with collateral
   * seized. The close kind is read from the receipt and preserved in
   * onChainStatus, because the database's own status enum flattens the last two
   * onto CLOSED.
   */
  async closePosition(
    positionId: string,
    actor: string,
    businessId: string,
    closing: { txHash: string },
    config: NoblePayChainConfiguration,
  ): Promise<FXPosition> {
    const position = await this.prisma.fXHedge.findFirst({
      where: { id: positionId, businessId },
    });
    if (!position) {
      throw new FXError("POSITION_NOT_FOUND", "Position not found", 404);
    }
    if (position.status !== "OPEN") {
      // Already closed; replaying is not an error, but it must not overwrite
      // the close kind already recorded.
      return positionRecord(position);
    }
    if (!position.onChainPositionId) {
      throw new FXError(
        "POSITION_NOT_ON_CHAIN",
        "This position has no on-chain id, so a close receipt cannot be matched to it",
        409,
      );
    }

    const verified = await verifyHedgeClose(config, {
      txHash: closing.txHash,
      onChainPositionId: position.onChainPositionId,
      expectedHedger: actor,
    });

    const updated = await this.prisma.fXHedge.update({
      where: { id: position.id },
      data: {
        status: CHAIN_STATUS_TO_DB[verified.chainStatus] ?? "CLOSED",
        onChainStatus: verified.chainStatus,
        closeTxHash: verified.txHash,
        closedAt: verified.closedAt,
        // Signed: a loss is negative on chain and must stay negative here.
        pnl: verified.pnl === null ? null : new Prisma.Decimal(verified.pnl),
      },
    });

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      // The close kind is in the description on purpose: a liquidation should
      // be legible in the audit trail without decoding metadata.
      description: `FX position closed on chain as ${verified.closeKind}: ${position.id} via ${verified.txHash}`,
      severity:
        verified.closeKind === "LIQUIDATED" ||
        verified.closeKind === "EMERGENCY_UNWOUND"
          ? "CRITICAL"
          : "HIGH",
      businessId,
      metadata: {
        hedgeId: position.id,
        onChainPositionId: verified.onChainPositionId,
        txHash: verified.txHash,
        blockNumber: verified.blockNumber,
        closeKind: verified.closeKind,
        chainStatus: verified.chainStatus,
        pnl: verified.pnl,
        settlementAmount: verified.settlementAmount,
        amountBasis: "RAW_CONTRACT_UNITS",
      },
    });

    return positionRecord(updated);
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
