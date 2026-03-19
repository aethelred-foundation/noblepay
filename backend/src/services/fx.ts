import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import { logger } from "../lib/logger";
import { AuditService } from "./audit";

// ─── Types ──────────────────────────────────────────────────────────────────

export type HedgeType = "FORWARD" | "OPTION_CALL" | "OPTION_PUT";
export type HedgeStatus = "ACTIVE" | "SETTLED" | "EXPIRED" | "LIQUIDATED" | "CANCELLED";

export interface FXRate {
  pair: string;
  bid: number;
  ask: number;
  mid: number;
  timestamp: Date;
  source: string;
  change24h: number;
  volume24h: string;
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
  strikeRate: number | null;
  currentRate: number;
  expiryDate: Date;
  status: HedgeStatus;
  marginDeposit: string;
  premium: string;
  unrealizedPnL: string;
  markToMarket: string;
  hedgeEffectiveness: number;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

export interface ExposureReport {
  totalExposure: string;
  byCurrency: Record<string, { exposure: string; hedged: string; unhedged: string; hedgeRatio: number }>;
  netExposure: string;
  valueAtRisk: string;
  stressTestResults: Record<string, string>;
}

export interface FXAnalytics {
  totalPositions: number;
  totalNotional: string;
  totalUnrealizedPnL: string;
  totalRealizedPnL: string;
  avgHedgeEffectiveness: number;
  expiringThisWeek: number;
  marginUtilization: number;
  topPairs: Array<{ pair: string; volume: string; pnl: string }>;
}

// ─── Rate Data ──────────────────────────────────────────────────────────────

const BASE_RATES: Record<string, number> = {
  "AED/USD": 0.2723,
  "USD/AED": 3.6725,
  "GBP/USD": 1.2685,
  "EUR/USD": 1.0842,
  "USD/JPY": 149.52,
  "AED/GBP": 0.2147,
  "AED/EUR": 0.2512,
  "USDC/USD": 1.0001,
  "USDT/USD": 0.9999,
  "AET/USD": 2.4500,
  "AET/AED": 9.0076,
};

// ─── Service ────────────────────────────────────────────────────────────────

export class FXService {
  private positions: Map<string, FXPosition> = new Map();
  private rateHistory: Map<string, FXRate[]> = new Map();

  constructor(
    private prisma: PrismaClient,
    private auditService: AuditService,
  ) {
    this.initializeRateFeeds();
  }

  private initializeRateFeeds(): void {
    for (const [pair, rate] of Object.entries(BASE_RATES)) {
      const spread = rate * 0.001; // 10 bps spread
      const fxRate: FXRate = {
        pair,
        bid: rate - spread / 2,
        ask: rate + spread / 2,
        mid: rate,
        timestamp: new Date(),
        source: "aethelred-fx-oracle",
        change24h: (Math.random() - 0.5) * 2,
        volume24h: (Math.random() * 10000000).toFixed(2),
      };
      this.rateHistory.set(pair, [fxRate]);
    }
  }

  /**
   * Get current FX rates for all supported pairs or a specific pair.
   */
  getRates(pair?: string): FXRate[] {
    if (pair) {
      const rates = this.rateHistory.get(pair);
      if (!rates || rates.length === 0) {
        throw new FXError("PAIR_NOT_FOUND", `Currency pair ${pair} not supported`, 404);
      }
      return [rates[rates.length - 1]];
    }

    const rates: FXRate[] = [];
    for (const [, history] of this.rateHistory) {
      if (history.length > 0) {
        rates.push(history[history.length - 1]);
      }
    }
    return rates;
  }

  /**
   * Create a new FX hedge position.
   */
  async createHedge(
    input: CreateHedgeInput,
    trader: string,
    businessId: string,
  ): Promise<FXPosition> {
    const currentRates = this.getRates(input.pair);
    if (currentRates.length === 0) {
      throw new FXError("PAIR_NOT_FOUND", `Currency pair ${input.pair} not supported`, 404);
    }

    const currentRate = currentRates[0].mid;
    const positionId =
      "fx-" +
      crypto
        .createHash("sha256")
        .update(`${trader}:${input.pair}:${Date.now()}`)
        .digest("hex")
        .slice(0, 16);

    const expiryDate = new Date(input.expiryDate);
    if (expiryDate <= new Date()) {
      throw new FXError("INVALID_EXPIRY", "Expiry date must be in the future");
    }

    // Calculate premium for options
    let premium = "0";
    if (input.type === "OPTION_CALL" || input.type === "OPTION_PUT") {
      premium = input.premium || this.calculateOptionPremium(
        input.pair,
        parseFloat(input.notionalAmount),
        input.strikeRate || currentRate,
        expiryDate,
        input.type,
      );
    }

    // Validate margin
    const requiredMargin = this.calculateRequiredMargin(input.type, input.notionalAmount, input.pair);
    if (parseFloat(input.marginDeposit) < requiredMargin) {
      throw new FXError(
        "INSUFFICIENT_MARGIN",
        `Required margin: ${requiredMargin.toFixed(2)}, provided: ${input.marginDeposit}`,
      );
    }

    const position: FXPosition = {
      id: positionId,
      businessId,
      pair: input.pair,
      type: input.type,
      notionalAmount: input.notionalAmount,
      currency: input.currency,
      entryRate: currentRate,
      strikeRate: input.strikeRate || null,
      currentRate,
      expiryDate,
      status: "ACTIVE",
      marginDeposit: input.marginDeposit,
      premium,
      unrealizedPnL: "0",
      markToMarket: input.notionalAmount,
      hedgeEffectiveness: 1.0,
      createdAt: new Date(),
      metadata: input.metadata || {},
    };

    this.positions.set(positionId, position);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor: trader,
      description: `FX hedge created: ${input.type} ${input.pair} notional ${input.notionalAmount}`,
      severity: "MEDIUM",
      metadata: { positionId, pair: input.pair, type: input.type, entryRate: currentRate },
    });

    logger.info("FX hedge position created", {
      positionId,
      pair: input.pair,
      type: input.type,
      notionalAmount: input.notionalAmount,
      entryRate: currentRate,
    });

    return position;
  }

  /**
   * Get a single position by ID.
   */
  getPosition(positionId: string): FXPosition | undefined {
    return this.positions.get(positionId);
  }

  /**
   * List positions with optional businessId scope.
   */
  listPositions(businessId?: string): FXPosition[] {
    let positions = Array.from(this.positions.values());
    if (businessId) {
      positions = positions.filter((p) => p.businessId === businessId);
    }
    return positions;
  }

  /**
   * Close an FX position and realize P&L.
   */
  async closePosition(
    positionId: string,
    actor: string,
    businessId?: string,
  ): Promise<{ position: FXPosition; realizedPnL: string }> {
    const position = this.positions.get(positionId);
    if (!position) {
      throw new FXError("POSITION_NOT_FOUND", "Position not found", 404);
    }
    if (businessId && position.businessId !== businessId) {
      throw new FXError("FORBIDDEN", "You do not have permission to close this position", 403);
    }
    if (position.status !== "ACTIVE") {
      throw new FXError("INVALID_STATE", `Cannot close position in ${position.status} state`, 409);
    }

    const currentRates = this.getRates(position.pair);
    const currentRate = currentRates[0].mid;

    const pnl = this.calculatePnL(position, currentRate);
    position.status = "SETTLED";
    position.currentRate = currentRate;
    position.unrealizedPnL = "0";
    this.positions.set(positionId, position);

    await this.auditService.createAuditEntry({
      eventType: "SYSTEM_EVENT",
      actor,
      description: `FX position ${positionId} closed. Realized P&L: ${pnl}`,
      severity: "MEDIUM",
      metadata: { positionId, realizedPnL: pnl, exitRate: currentRate },
    });

    logger.info("FX position closed", { positionId, realizedPnL: pnl, exitRate: currentRate });

    return { position, realizedPnL: pnl };
  }

  /**
   * Calculate mark-to-market for all active positions.
   */
  markToMarket(businessId?: string): FXPosition[] {
    const updated: FXPosition[] = [];

    for (const [id, position] of this.positions) {
      if (position.status !== "ACTIVE") continue;
      if (businessId && position.businessId !== businessId) continue;

      try {
        const currentRates = this.getRates(position.pair);
        const currentRate = currentRates[0].mid;

        const pnl = this.calculatePnL(position, currentRate);
        position.currentRate = currentRate;
        position.unrealizedPnL = pnl;
        position.markToMarket = (
          parseFloat(position.notionalAmount) + parseFloat(pnl)
        ).toFixed(2);

        // Calculate hedge effectiveness (IFRS 9)
        const rateChange = (currentRate - position.entryRate) / position.entryRate;
        position.hedgeEffectiveness = Math.min(
          1.0,
          Math.max(0.0, 1.0 - Math.abs(rateChange) * 0.1),
        );

        this.positions.set(id, position);
        updated.push(position);
      } catch {
        // Skip positions with unavailable rates
      }
    }

    return updated;
  }

  /**
   * Get portfolio exposure report.
   */
  getExposure(businessId: string): ExposureReport {
    const byCurrency: Record<string, { exposure: string; hedged: string; unhedged: string; hedgeRatio: number }> = {};
    let totalExposure = 0;

    for (const position of this.positions.values()) {
      if (position.status !== "ACTIVE") continue;
      if (businessId && position.businessId !== businessId) continue;

      const currency = position.pair.split("/")[0];
      if (!byCurrency[currency]) {
        byCurrency[currency] = { exposure: "0", hedged: "0", unhedged: "0", hedgeRatio: 0 };
      }

      const notional = parseFloat(position.notionalAmount);
      const current = parseFloat(byCurrency[currency].hedged);
      byCurrency[currency].hedged = (current + notional).toFixed(2);
      totalExposure += notional;
    }

    // Calculate hedge ratios
    for (const [currency, data] of Object.entries(byCurrency)) {
      const exposure = parseFloat(data.exposure) || parseFloat(data.hedged) * 1.5;
      data.exposure = exposure.toFixed(2);
      data.unhedged = (exposure - parseFloat(data.hedged)).toFixed(2);
      data.hedgeRatio = exposure > 0 ? parseFloat(data.hedged) / exposure : 0;
    }

    // Value-at-Risk (simplified historical VaR at 95% confidence)
    const var95 = totalExposure * 0.023; // ~2.3% for major FX pairs

    return {
      totalExposure: totalExposure.toFixed(2),
      byCurrency,
      netExposure: totalExposure.toFixed(2),
      valueAtRisk: var95.toFixed(2),
      stressTestResults: {
        "10% USD depreciation": (totalExposure * 0.10).toFixed(2),
        "5% AED depeg": (totalExposure * 0.05).toFixed(2),
        "Brexit-style shock": (totalExposure * 0.15).toFixed(2),
        "EM currency crisis": (totalExposure * 0.25).toFixed(2),
      },
    };
  }

  /**
   * Get FX analytics.
   */
  getAnalytics(businessId?: string): FXAnalytics {
    let allPositions = Array.from(this.positions.values());
    if (businessId) {
      allPositions = allPositions.filter((p) => p.businessId === businessId);
    }
    const activePositions = allPositions.filter(
      (p) => p.status === "ACTIVE",
    );

    const now = new Date();
    const oneWeekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    let totalNotional = 0;
    let totalUnrealizedPnL = 0;
    let totalRealizedPnL = 0;
    let totalEffectiveness = 0;

    const pairVolumes: Map<string, { volume: number; pnl: number }> = new Map();

    for (const pos of allPositions) {
      const notional = parseFloat(pos.notionalAmount);
      const pnl = parseFloat(pos.unrealizedPnL);

      if (pos.status === "ACTIVE") {
        totalNotional += notional;
        totalUnrealizedPnL += pnl;
        totalEffectiveness += pos.hedgeEffectiveness;
      } else if (pos.status === "SETTLED") {
        totalRealizedPnL += pnl;
      }

      const existing = pairVolumes.get(pos.pair) || { volume: 0, pnl: 0 };
      pairVolumes.set(pos.pair, {
        volume: existing.volume + notional,
        pnl: existing.pnl + pnl,
      });
    }

    const topPairs = Array.from(pairVolumes.entries())
      .map(([pair, data]) => ({
        pair,
        volume: data.volume.toFixed(2),
        pnl: data.pnl.toFixed(2),
      }))
      .sort((a, b) => parseFloat(b.volume) - parseFloat(a.volume))
      .slice(0, 5);

    const totalMargin = activePositions.reduce(
      (sum, p) => sum + parseFloat(p.marginDeposit),
      0,
    );
    const maxMargin = totalNotional * 0.1; // 10% max margin

    return {
      totalPositions: activePositions.length,
      totalNotional: totalNotional.toFixed(2),
      totalUnrealizedPnL: totalUnrealizedPnL.toFixed(2),
      totalRealizedPnL: totalRealizedPnL.toFixed(2),
      avgHedgeEffectiveness:
        activePositions.length > 0
          ? totalEffectiveness / activePositions.length
          : 0,
      expiringThisWeek: activePositions.filter(
        (p) => p.expiryDate <= oneWeekLater,
      ).length,
      marginUtilization: maxMargin > 0 ? totalMargin / maxMargin : 0,
      topPairs,
    };
  }

  /**
   * Simplified Black-Scholes option premium calculation.
   */
  private calculateOptionPremium(
    pair: string,
    notional: number,
    strike: number,
    expiry: Date,
    type: HedgeType,
  ): string {
    const timeToExpiry = (expiry.getTime() - Date.now()) / (365.25 * 24 * 60 * 60 * 1000);
    const volatility = 0.08; // 8% annualized vol for major pairs
    const riskFreeRate = 0.05;

    // Simplified premium: intrinsic value + time value
    const currentRate = BASE_RATES[pair] || 1;
    const intrinsic = type === "OPTION_CALL"
      ? Math.max(0, currentRate - strike)
      : Math.max(0, strike - currentRate);

    const timeValue = currentRate * volatility * Math.sqrt(timeToExpiry);
    const premium = (intrinsic + timeValue) * notional * 0.01; // 1% of notional as base

    return premium.toFixed(2);
  }

  /**
   * Calculate required margin for a position.
   */
  private calculateRequiredMargin(type: HedgeType, notional: string, pair: string): number {
    const notionalNum = parseFloat(notional);
    const marginRate = type === "FORWARD" ? 0.05 : 0.02; // 5% for forwards, 2% for options
    return notionalNum * marginRate;
  }

  /**
   * Calculate P&L for a position at a given rate.
   */
  private calculatePnL(position: FXPosition, currentRate: number): string {
    const notional = parseFloat(position.notionalAmount);
    const rateDiff = currentRate - position.entryRate;

    switch (position.type) {
      case "FORWARD":
        return (notional * rateDiff / position.entryRate).toFixed(2);
      case "OPTION_CALL": {
        const callPayoff = Math.max(0, currentRate - (position.strikeRate || position.entryRate));
        return (notional * callPayoff / position.entryRate - parseFloat(position.premium)).toFixed(2);
      }
      case "OPTION_PUT": {
        const putPayoff = Math.max(0, (position.strikeRate || position.entryRate) - currentRate);
        return (notional * putPayoff / position.entryRate - parseFloat(position.premium)).toFixed(2);
      }
      default:
        return "0";
    }
  }
}

// ─── Error Class ────────────────────────────────────────────────────────────

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
