const mockLiquidityService = {
  getPools: jest.fn(),
  getPool: jest.fn(),
  addLiquidity: jest.fn(),
  removeLiquidity: jest.fn(),
  getPositions: jest.fn(),
  requestFlashLiquidity: jest.fn(),
  getAnalytics: jest.fn(),
};
let authenticated = true;

jest.mock("../../lib/db", () => ({ prisma: {} }));
jest.mock("../../services/audit", () => ({ AuditService: jest.fn() }));
jest.mock("../../services/liquidity", () => {
  class LiquidityError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  }
  return {
    LiquidityService: jest.fn(() => mockLiquidityService),
    LiquidityError,
  };
});
jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: (
    req: { businessId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    if (authenticated) req.businessId = "business-1";
    next();
  },
}));
jest.mock("../../middleware/rbac", () => ({
  extractRole: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

import express from "express";
import request from "supertest";
import router from "../../routes/liquidity";
import { LiquidityError } from "../../services/liquidity";

const app = express();
app.use(express.json());
app.use("/v1/liquidity", router);

describe("liquidity routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authenticated = true;
  });

  it("passes validated pagination and status to durable pool reads", async () => {
    mockLiquidityService.getPools.mockResolvedValue([{ id: "pool-1" }]);

    const response = await request(app).get(
      "/v1/liquidity/pools?status=ACTIVE&page=2&limit=10",
    );

    expect(response.status).toBe(200);
    expect(mockLiquidityService.getPools).toHaveBeenCalledWith("ACTIVE", {
      page: 2,
      limit: 10,
    });
  });

  it("rejects unknown query keys and out-of-range pagination", async () => {
    const [unknown, oversized] = await Promise.all([
      request(app).get("/v1/liquidity/pools?unexpected=true"),
      request(app).get("/v1/liquidity/pools?limit=101"),
    ]);

    expect(unknown.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(mockLiquidityService.getPools).not.toHaveBeenCalled();
  });

  it("returns one durable pool snapshot by opaque ID", async () => {
    mockLiquidityService.getPool.mockResolvedValue({ id: "pool-1" });

    const response = await request(app).get("/v1/liquidity/pools/pool-1");

    expect(response.status).toBe(200);
    expect(mockLiquidityService.getPool).toHaveBeenCalledWith("pool-1");
  });

  it("validates mutation bodies before returning fail-closed service errors", async () => {
    mockLiquidityService.addLiquidity.mockRejectedValue(
      new LiquidityError(
        "ONCHAIN_SETTLEMENT_UNAVAILABLE",
        "Receipt verifier unavailable",
        501,
      ),
    );

    const invalid = await request(app)
      .post("/v1/liquidity/pools/pool-1/add")
      .send({ amountA: "1e6", amountB: "2", extra: true });
    const valid = await request(app)
      .post("/v1/liquidity/pools/pool-1/add")
      .send({ amountA: "1", amountB: "2" });

    expect(invalid.status).toBe(400);
    expect(valid.status).toBe(501);
    expect(valid.body.error).toBe("ONCHAIN_SETTLEMENT_UNAVAILABLE");
    expect(mockLiquidityService.addLiquidity).toHaveBeenCalledWith(
      { poolId: "pool-1", amountA: "1", amountB: "2" },
      "business-1",
      "business-1",
    );
  });

  it("passes the authenticated tenant and bounded position query", async () => {
    const provider = "0x1111111111111111111111111111111111111111";
    mockLiquidityService.getPositions.mockResolvedValue([]);

    const response = await request(app).get(
      `/v1/liquidity/positions?provider=${provider}&limit=5`,
    );

    expect(response.status).toBe(200);
    expect(mockLiquidityService.getPositions).toHaveBeenCalledWith(
      "business-1",
      provider,
      { page: 1, limit: 5 },
    );
  });

  it("passes valid removal and flash requests through fail-closed guards", async () => {
    mockLiquidityService.removeLiquidity.mockRejectedValueOnce(
      new LiquidityError(
        "ONCHAIN_SETTLEMENT_UNAVAILABLE",
        "Receipt verifier unavailable",
        501,
      ),
    );
    mockLiquidityService.requestFlashLiquidity.mockRejectedValueOnce(
      new LiquidityError(
        "FLASH_LIQUIDITY_UNAVAILABLE",
        "Atomic verifier unavailable",
        501,
      ),
    );

    const removal = await request(app)
      .post("/v1/liquidity/pools/pool-1/remove")
      .send({ positionId: "position-1", percentage: 50 });
    const flash = await request(app)
      .post("/v1/liquidity/flash")
      .send({ poolId: "pool-1", amount: "100" });

    expect(removal.status).toBe(501);
    expect(flash.status).toBe(501);
    expect(mockLiquidityService.removeLiquidity).toHaveBeenCalledWith(
      { positionId: "position-1", percentage: 50 },
      "business-1",
      "business-1",
    );
    expect(mockLiquidityService.requestFlashLiquidity).toHaveBeenCalledWith(
      "pool-1",
      "100",
      "business-1",
    );
  });

  it("returns tenant-scoped liquidity analytics", async () => {
    mockLiquidityService.getAnalytics.mockResolvedValue({ totalTVL: "1000" });

    const response = await request(app).get("/v1/liquidity/analytics");

    expect(response.status).toBe(200);
    expect(mockLiquidityService.getAnalytics).toHaveBeenCalledWith(
      "business-1",
    );
  });

  it.each([
    [
      "add",
      "post",
      "/v1/liquidity/pools/pool-1/add",
      { amountA: "1", amountB: "2" },
    ],
    [
      "remove",
      "post",
      "/v1/liquidity/pools/pool-1/remove",
      { positionId: "position-1", percentage: 50 },
    ],
    ["positions", "get", "/v1/liquidity/positions", undefined],
    [
      "flash",
      "post",
      "/v1/liquidity/flash",
      { poolId: "pool-1", amount: "100" },
    ],
    ["analytics", "get", "/v1/liquidity/analytics", undefined],
  ])(
    "rejects %s without tenant identity",
    async (_name, method, path, body) => {
      authenticated = false;
      const operation = request(app)[method as "get" | "post"](path);
      if (body) operation.send(body);

      const response = await operation;

      expect(response.status).toBe(401);
      expect(response.body.error).toBe("UNAUTHORIZED");
    },
  );

  it("redacts unexpected pool service failures", async () => {
    mockLiquidityService.getPool.mockRejectedValue(
      new Error("database secret-value"),
    );

    const response = await request(app).get("/v1/liquidity/pools/pool-1");

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("secret-value");
  });
});
