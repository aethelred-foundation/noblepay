import { createMockPrisma, resetAllMocks } from "../setup";
import { LiquidityService, LiquidityError } from "../../services/liquidity";
import { AuditService } from "../../services/audit";

let prisma: ReturnType<typeof createMockPrisma>;
let auditService: AuditService;
let liquidityService: LiquidityService;

beforeEach(() => {
  resetAllMocks();
  prisma = createMockPrisma();
  auditService = new AuditService(prisma);
  jest.spyOn(auditService, "createAuditEntry").mockResolvedValue({} as any);
  liquidityService = new LiquidityService(prisma, auditService);
});

describe("LiquidityService", () => {
  // ─── getPools ──────────────────────────────────────────────────────────────

  describe("getPools", () => {
    it("should return all pools sorted by TVL", () => {
      const pools = liquidityService.getPools();
      expect(pools.length).toBeGreaterThan(0);
      for (let i = 1; i < pools.length; i++) {
        expect(parseFloat(pools[i - 1].tvl)).toBeGreaterThanOrEqual(
          parseFloat(pools[i].tvl),
        );
      }
    });

    it("should filter by status", () => {
      const active = liquidityService.getPools("ACTIVE");
      expect(active.every((p) => p.status === "ACTIVE")).toBe(true);
    });

    it("should return empty for non-matching status", () => {
      const deprecated = liquidityService.getPools("DEPRECATED");
      expect(deprecated).toHaveLength(0);
    });
  });

  // ─── getPool ───────────────────────────────────────────────────────────────

  describe("getPool", () => {
    it("should return a pool by ID", () => {
      const pool = liquidityService.getPool("pool-aet-usdc");
      expect(pool.pair).toBe("AET/USDC");
    });

    it("should throw POOL_NOT_FOUND for unknown ID", () => {
      expect(() => liquidityService.getPool("nonexistent")).toThrow(
        LiquidityError,
      );
    });
  });

  // ─── addLiquidity ──────────────────────────────────────────────────────────

  describe("addLiquidity", () => {
    it("should add liquidity and return position", async () => {
      const position = await liquidityService.addLiquidity(
        { poolId: "pool-aet-usdc", amountA: "10000", amountB: "24500" },
        "0xprovider",
        "biz-1",
      );

      expect(position.id).toMatch(/^lp-/);
      expect(position.poolId).toBe("pool-aet-usdc");
      expect(position.provider).toBe("0xprovider");
      expect(position.tier).toBe("RETAIL");
      expect(parseFloat(position.liquidityAmount)).toBe(34500);
      expect(position.sharePercentage).toBeGreaterThan(0);
    });

    it("should set tier when provided", async () => {
      const position = await liquidityService.addLiquidity(
        {
          poolId: "pool-aet-usdc",
          amountA: "10000",
          amountB: "24500",
          tier: "INSTITUTIONAL",
        },
        "0xprovider",
        "biz-1",
      );

      expect(position.tier).toBe("INSTITUTIONAL");
    });

    it("should update pool reserves", async () => {
      const poolBefore = liquidityService.getPool("pool-aet-usdc");
      const reserveABefore = parseFloat(poolBefore.reserveA);

      await liquidityService.addLiquidity(
        { poolId: "pool-aet-usdc", amountA: "5000", amountB: "12250" },
        "0xprovider",
        "biz-1",
      );

      const poolAfter = liquidityService.getPool("pool-aet-usdc");
      expect(parseFloat(poolAfter.reserveA)).toBe(reserveABefore + 5000);
    });

    it("should throw POOL_INACTIVE for non-active pools", async () => {
      // Get a pool and manually set it inactive
      const pool = liquidityService.getPool("pool-aet-usdc");
      (pool as any).status = "PAUSED";

      await expect(
        liquidityService.addLiquidity(
          { poolId: "pool-aet-usdc", amountA: "100", amountB: "245" },
          "0xprovider",
          "biz-1",
        ),
      ).rejects.toMatchObject({ code: "POOL_INACTIVE" });

      // Restore
      (pool as any).status = "ACTIVE";
    });
  });

  // ─── removeLiquidity ───────────────────────────────────────────────────────

  describe("removeLiquidity", () => {
    it("should remove partial liquidity", async () => {
      const position = await liquidityService.addLiquidity(
        { poolId: "pool-aet-usdc", amountA: "10000", amountB: "24500" },
        "0xprovider",
        "biz-1",
      );

      const result = await liquidityService.removeLiquidity(
        { positionId: position.id, percentage: 50 },
        "0xprovider",
      );

      expect(result.amountA).toBeDefined();
      expect(result.amountB).toBeDefined();
      expect(result.feesCollected).toBeDefined();

      // Position should still exist with reduced share
      const positions = liquidityService.getPositions("0xprovider");
      expect(positions).toHaveLength(1);
    });

    it("should fully remove position at 100%", async () => {
      const position = await liquidityService.addLiquidity(
        { poolId: "pool-aet-usdc", amountA: "1000", amountB: "2450" },
        "0xprovider",
        "biz-1",
      );

      await liquidityService.removeLiquidity(
        { positionId: position.id, percentage: 100 },
        "0xprovider",
      );

      const positions = liquidityService.getPositions("0xprovider");
      expect(positions).toHaveLength(0);
    });

    it("should throw POSITION_NOT_FOUND for unknown position", async () => {
      await expect(
        liquidityService.removeLiquidity(
          { positionId: "nonexistent", percentage: 50 },
          "0xactor",
        ),
      ).rejects.toMatchObject({ code: "POSITION_NOT_FOUND" });
    });
  });

  // ─── getPositions ──────────────────────────────────────────────────────────

  describe("getPositions", () => {
    it("should return all positions", async () => {
      await liquidityService.addLiquidity(
        { poolId: "pool-aet-usdc", amountA: "1000", amountB: "2450" },
        "0xprovider1",
        "biz-1",
      );

      const all = liquidityService.getPositions();
      expect(all.length).toBeGreaterThanOrEqual(1);
    });

    it("should filter by provider", async () => {
      await liquidityService.addLiquidity(
        { poolId: "pool-aet-usdc", amountA: "1000", amountB: "2450" },
        "0xproviderX",
        "biz-1",
      );

      const filtered = liquidityService.getPositions("0xproviderX");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].provider).toBe("0xproviderX");
    });
  });

  // ─── requestFlashLiquidity ─────────────────────────────────────────────────

  describe("requestFlashLiquidity", () => {
    it("should fulfill flash liquidity request", async () => {
      const request = await liquidityService.requestFlashLiquidity(
        "pool-aet-usdc",
        "100000",
        "0xborrower",
      );

      expect(request.id).toMatch(/^flash-/);
      expect(request.status).toBe("FULFILLED");
      expect(parseFloat(request.fee)).toBeCloseTo(90, 0); // 9 bps of 100k
      expect(request.currency).toBe("AET");
    });

    it("should throw for unknown pool", async () => {
      await expect(
        liquidityService.requestFlashLiquidity(
          "nonexistent",
          "1000",
          "0xborrower",
        ),
      ).rejects.toThrow(LiquidityError);
    });
  });

  // ─── getAnalytics ──────────────────────────────────────────────────────────

  describe("getAnalytics", () => {
    it("should return pool analytics", () => {
      const analytics = liquidityService.getAnalytics();

      expect(parseFloat(analytics.totalTVL)).toBeGreaterThan(0);
      expect(analytics.poolCount).toBeGreaterThan(0);
      expect(analytics.avgUtilization).toBeGreaterThan(0);
      expect(analytics.topPools.length).toBeGreaterThan(0);
    });

    it("should detect rebalancing alerts for high-utilization pools", () => {
      const analytics = liquidityService.getAnalytics();
      // USDC/USDT pool has 0.89 utilization, should trigger alert
      const alert = analytics.rebalancingAlerts.find(
        (a) => a.pair === "USDC/USDT",
      );
      expect(alert).toBeDefined();
      expect(alert!.severity).toBe("WARNING");
    });

    it("should detect CRITICAL rebalancing alert for > 0.95 utilization", () => {
      // Mutate pool utilization to trigger CRITICAL
      const pool = liquidityService.getPool("pool-usdc-usdt");
      const originalUtilization = pool.utilization;
      (pool as any).utilization = 0.97;

      const analytics = liquidityService.getAnalytics();
      const alert = analytics.rebalancingAlerts.find(
        (a) => a.pair === "USDC/USDT",
      );
      expect(alert).toBeDefined();
      expect(alert!.severity).toBe("CRITICAL");

      // Restore
      (pool as any).utilization = originalUtilization;
    });
  });

  // ─── getAnalytics (empty pools branch) ────────────────────────────────────

  describe("getAnalytics (zero pools)", () => {
    it("should return avgUtilization 0 when no active pools exist", () => {
      // Mock getPools to return empty to hit the pools.length === 0 branch
      const origGetPools = liquidityService.getPools.bind(liquidityService);
      jest.spyOn(liquidityService, "getPools").mockReturnValue([]);

      const analytics = liquidityService.getAnalytics();
      expect(analytics.avgUtilization).toBe(0);
      expect(analytics.poolCount).toBe(0);
      expect(analytics.topPools).toHaveLength(0);
      expect(analytics.rebalancingAlerts).toHaveLength(0);

      jest.restoreAllMocks();
    });
  });

  // ─── LiquidityError ───────────────────────────────────────────────────────

  describe("LiquidityError", () => {
    it("should set properties correctly", () => {
      const err = new LiquidityError("CODE", "msg", 404);
      expect(err.code).toBe("CODE");
      expect(err.statusCode).toBe(404);
      expect(err.name).toBe("LiquidityError");
    });

    it("should default statusCode to 400", () => {
      const err = new LiquidityError("CODE", "msg");
      expect(err.statusCode).toBe(400);
    });
  });
});
