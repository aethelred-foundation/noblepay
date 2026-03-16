import { createMockPrisma, resetAllMocks } from "../setup";
import { FXService, FXError } from "../../services/fx";
import { AuditService } from "../../services/audit";

let prisma: ReturnType<typeof createMockPrisma>;
let auditService: AuditService;
let fxService: FXService;

beforeEach(() => {
  resetAllMocks();
  prisma = createMockPrisma();
  auditService = new AuditService(prisma);
  jest.spyOn(auditService, "createAuditEntry").mockResolvedValue({} as any);
  fxService = new FXService(prisma, auditService);
});

describe("FXService", () => {
  // ─── getRates ──────────────────────────────────────────────────────────────

  describe("getRates", () => {
    it("should return all rates when no pair specified", () => {
      const rates = fxService.getRates();
      expect(rates.length).toBeGreaterThan(0);
      expect(rates[0]).toHaveProperty("pair");
      expect(rates[0]).toHaveProperty("bid");
      expect(rates[0]).toHaveProperty("ask");
      expect(rates[0]).toHaveProperty("mid");
    });

    it("should return specific pair rate", () => {
      const rates = fxService.getRates("AED/USD");
      expect(rates).toHaveLength(1);
      expect(rates[0].pair).toBe("AED/USD");
    });

    it("should throw PAIR_NOT_FOUND for unsupported pair", () => {
      expect(() => fxService.getRates("XXX/YYY")).toThrow(FXError);
    });

    it("should have correct bid/ask spread", () => {
      const rates = fxService.getRates("AED/USD");
      expect(rates[0].bid).toBeLessThan(rates[0].ask);
      expect(rates[0].mid).toBeGreaterThan(rates[0].bid);
      expect(rates[0].mid).toBeLessThan(rates[0].ask);
    });
  });

  // ─── createHedge ───────────────────────────────────────────────────────────

  describe("createHedge", () => {
    const baseHedge = {
      pair: "AED/USD",
      type: "FORWARD" as const,
      notionalAmount: "100000",
      currency: "AED",
      expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      marginDeposit: "10000",
    };

    it("should create a forward hedge position", async () => {
      const position = await fxService.createHedge(
        baseHedge,
        "0xtrader",
        "biz-1",
      );

      expect(position.id).toMatch(/^fx-/);
      expect(position.pair).toBe("AED/USD");
      expect(position.type).toBe("FORWARD");
      expect(position.status).toBe("ACTIVE");
      expect(position.entryRate).toBeGreaterThan(0);
      expect(auditService.createAuditEntry).toHaveBeenCalled();
    });

    it("should create an option position", async () => {
      const position = await fxService.createHedge(
        {
          ...baseHedge,
          type: "OPTION_CALL",
          strikeRate: 0.28,
          marginDeposit: "5000",
        },
        "0xtrader",
        "biz-1",
      );

      expect(position.type).toBe("OPTION_CALL");
      expect(parseFloat(position.premium)).toBeGreaterThanOrEqual(0);
    });

    it("should throw INVALID_EXPIRY for past expiry date", async () => {
      await expect(
        fxService.createHedge(
          {
            ...baseHedge,
            expiryDate: new Date(Date.now() - 1000).toISOString(),
          },
          "0xtrader",
          "biz-1",
        ),
      ).rejects.toMatchObject({ code: "INVALID_EXPIRY" });
    });

    it("should throw INSUFFICIENT_MARGIN when margin is too low", async () => {
      await expect(
        fxService.createHedge(
          { ...baseHedge, marginDeposit: "1" },
          "0xtrader",
          "biz-1",
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_MARGIN" });
    });

    it("should throw PAIR_NOT_FOUND for unsupported pair", async () => {
      await expect(
        fxService.createHedge(
          { ...baseHedge, pair: "XXX/YYY" },
          "0xtrader",
          "biz-1",
        ),
      ).rejects.toThrow(FXError);
    });
  });

  // ─── closePosition ─────────────────────────────────────────────────────────

  describe("closePosition", () => {
    it("should close an active position and return P&L", async () => {
      const position = await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "FORWARD",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "10000",
        },
        "0xtrader",
        "biz-1",
      );

      const result = await fxService.closePosition(position.id, "0xtrader");

      expect(result.position.status).toBe("SETTLED");
      expect(result.realizedPnL).toBeDefined();
    });

    it("should throw POSITION_NOT_FOUND for unknown position", async () => {
      await expect(
        fxService.closePosition("nonexistent", "0xactor"),
      ).rejects.toMatchObject({ code: "POSITION_NOT_FOUND", statusCode: 404 });
    });

    it("should throw INVALID_STATE for already settled position", async () => {
      const position = await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "FORWARD",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "10000",
        },
        "0xtrader",
        "biz-1",
      );
      await fxService.closePosition(position.id, "0xtrader");

      await expect(
        fxService.closePosition(position.id, "0xtrader"),
      ).rejects.toMatchObject({ code: "INVALID_STATE", statusCode: 409 });
    });
  });

  // ─── markToMarket ──────────────────────────────────────────────────────────

  describe("markToMarket", () => {
    it("should return empty array with no positions", () => {
      const result = fxService.markToMarket();
      expect(result).toEqual([]);
    });

    it("should update active positions", async () => {
      await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "FORWARD",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "10000",
        },
        "0xtrader",
        "biz-1",
      );

      const updated = fxService.markToMarket();
      expect(updated).toHaveLength(1);
      expect(updated[0].hedgeEffectiveness).toBeDefined();
    });
  });

  // ─── markToMarket (catch branch — unavailable rate) ─────────────────────
  describe("markToMarket (catch branch for unavailable rates)", () => {
    it("should skip positions with unavailable rates", async () => {
      const position = await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "FORWARD",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "10000",
        },
        "0xtrader",
        "biz-1",
      );

      // Mutate pair to something that doesn't exist in rate feeds
      (position as any).pair = "ZZZ/QQQ";

      const marked = fxService.markToMarket();
      // The position should be skipped (catch block), so no results
      expect(marked).toHaveLength(0);
    });
  });

  // ─── getExposure ───────────────────────────────────────────────────────────

  describe("getExposure", () => {
    it("should return exposure report", async () => {
      await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "FORWARD",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "10000",
        },
        "0xtrader",
        "biz-1",
      );

      const exposure = fxService.getExposure("biz-1");

      expect(exposure.totalExposure).toBeDefined();
      expect(exposure.valueAtRisk).toBeDefined();
      expect(exposure.stressTestResults).toHaveProperty("10% USD depreciation");
    });

    it("should return zeroes with no positions", () => {
      const exposure = fxService.getExposure("biz-1");
      expect(exposure.totalExposure).toBe("0.00");
    });
  });

  // ─── getAnalytics ──────────────────────────────────────────────────────────

  describe("getAnalytics", () => {
    it("should return analytics with zero positions", () => {
      const analytics = fxService.getAnalytics();
      expect(analytics.totalPositions).toBe(0);
      expect(analytics.totalNotional).toBe("0.00");
    });

    it("should calculate analytics with positions", async () => {
      await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "FORWARD",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "10000",
        },
        "0xtrader",
        "biz-1",
      );

      const analytics = fxService.getAnalytics();
      expect(analytics.totalPositions).toBe(1);
      expect(parseFloat(analytics.totalNotional)).toBe(100000);
      expect(analytics.expiringThisWeek).toBe(1);
    });

    it("should calculate topPairs from multiple pair positions", async () => {
      await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "FORWARD",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "10000",
        },
        "0xtrader",
        "biz-1",
      );

      await fxService.createHedge(
        {
          pair: "GBP/USD",
          type: "FORWARD",
          notionalAmount: "50000",
          currency: "GBP",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "5000",
        },
        "0xtrader",
        "biz-1",
      );

      const analytics = fxService.getAnalytics();
      expect(analytics.topPairs.length).toBeGreaterThanOrEqual(2);
    });

    it("should include settled positions in realizedPnL", async () => {
      const position = await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "FORWARD",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "10000",
        },
        "0xtrader",
        "biz-1",
      );

      await fxService.closePosition(position.id, "0xtrader");

      const analytics = fxService.getAnalytics();
      expect(analytics.totalRealizedPnL).toBeDefined();
    });
  });

  // ─── markToMarket (option types) ─────────────────────────────────────────

  describe("markToMarket (option types)", () => {
    it("should calculate P&L for OPTION_CALL positions", async () => {
      await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "OPTION_CALL",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "5000",
          strikeRate: 0.28,
        },
        "0xtrader",
        "biz-1",
      );

      const marked = fxService.markToMarket();
      expect(marked).toHaveLength(1);
      expect(marked[0].unrealizedPnL).toBeDefined();
    });

    it("should calculate P&L for OPTION_PUT positions", async () => {
      await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "OPTION_PUT",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "5000",
          strikeRate: 0.28,
        },
        "0xtrader",
        "biz-1",
      );

      const marked = fxService.markToMarket();
      expect(marked).toHaveLength(1);
      expect(marked[0].unrealizedPnL).toBeDefined();
    });
  });

  // ─── createHedge (PAIR_NOT_FOUND in getRates) ────────────────────────────

  describe("createHedge (edge cases)", () => {
    it("should throw PAIR_NOT_FOUND when pair has no rates", async () => {
      await expect(
        fxService.createHedge(
          {
            pair: "ZZZ/QQQ",
            type: "FORWARD",
            notionalAmount: "100000",
            currency: "ZZZ",
            expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            marginDeposit: "10000",
          },
          "0xtrader",
          "biz-1",
        ),
      ).rejects.toMatchObject({ code: "PAIR_NOT_FOUND" });
    });
  });

  // ─── createHedge edge cases (premium, metadata, strikeRate) ─────────────

  describe("createHedge (option with explicit premium and metadata)", () => {
    it("should use provided premium when specified for options", async () => {
      const position = await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "OPTION_CALL",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "5000",
          strikeRate: 0.28,
          premium: "500",
        },
        "0xtrader",
        "biz-1",
      );

      expect(position.premium).toBe("500");
    });

    it("should use metadata when provided", async () => {
      const position = await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "FORWARD",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "10000",
          metadata: { reference: "trade-123" },
        },
        "0xtrader",
        "biz-1",
      );

      expect(position.metadata).toEqual({ reference: "trade-123" });
    });

    it("should set strikeRate to null for forwards", async () => {
      const position = await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "FORWARD",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "10000",
        },
        "0xtrader",
        "biz-1",
      );

      expect(position.strikeRate).toBeNull();
    });
  });

  // ─── calculatePnL default branch ──────────────────────────────────────────

  describe("calculatePnL (default branch)", () => {
    it("should return '0' for unknown position type via markToMarket", async () => {
      const position = await fxService.createHedge(
        {
          pair: "AED/USD",
          type: "FORWARD",
          notionalAmount: "100000",
          currency: "AED",
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          marginDeposit: "10000",
        },
        "0xtrader",
        "biz-1",
      );

      // Mutate position type to something not in the switch
      (position as any).type = "SWAP";

      const marked = fxService.markToMarket();
      expect(marked).toHaveLength(1);
      expect(marked[0].unrealizedPnL).toBe("0");
    });
  });

  // ─── FXError ───────────────────────────────────────────────────────────────

  describe("FXError", () => {
    it("should set properties correctly", () => {
      const err = new FXError("CODE", "msg", 404);
      expect(err.code).toBe("CODE");
      expect(err.statusCode).toBe(404);
      expect(err.name).toBe("FXError");
    });
  });
});
