const mockFXService = {
  getRates: jest.fn(),
  createHedge: jest.fn(),
  listPositions: jest.fn(),
  closePosition: jest.fn(),
  getExposure: jest.fn(),
  getAnalytics: jest.fn(),
};
let authenticated = true;

jest.mock("../../lib/db", () => ({ prisma: {} }));
jest.mock("../../services/audit", () => ({ AuditService: jest.fn() }));
jest.mock("../../services/fx", () => {
  class FXError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  }
  return { FXService: jest.fn(() => mockFXService), FXError };
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
import router from "../../routes/fx";
import { FXError } from "../../services/fx";

const app = express();
app.use(express.json());
app.use("/v1/fx", router);

describe("FX routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authenticated = true;
  });

  it("accepts only a normalized pair query", async () => {
    mockFXService.getRates.mockResolvedValue([]);

    const valid = await request(app).get("/v1/fx/rates?pair=USDC%2FAED");
    const invalid = await request(app).get("/v1/fx/rates?pair=usdc%2Faed");

    expect(valid.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(mockFXService.getRates).toHaveBeenCalledTimes(1);
    expect(mockFXService.getRates).toHaveBeenCalledWith("USDC/AED");
  });

  it("preserves explicit oracle availability failures", async () => {
    mockFXService.getRates.mockRejectedValue(
      new FXError("FX_ORACLE_UNAVAILABLE", "Oracle unavailable", 503),
    );

    const response = await request(app).get("/v1/fx/rates");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "FX_ORACLE_UNAVAILABLE",
      message: "Oracle unavailable",
    });
  });

  it("passes bounded, allowlisted filters to tenant hedge history", async () => {
    mockFXService.listPositions.mockResolvedValue([]);

    const response = await request(app).get(
      "/v1/fx/hedges?status=OPEN&page=3&limit=10",
    );

    expect(response.status).toBe(200);
    expect(mockFXService.listPositions).toHaveBeenCalledWith("business-1", {
      status: "OPEN",
      page: 3,
      limit: 10,
    });
  });

  it("rejects malformed or unknown hedge fields before execution", async () => {
    const response = await request(app)
      .post("/v1/fx/hedges")
      .send({ pair: "USDC/AED", notionalAmount: "1e9", fake: true });

    expect(response.status).toBe(400);
    expect(mockFXService.createHedge).not.toHaveBeenCalled();
  });

  it("returns the explicit fail-closed execution status for a valid hedge", async () => {
    mockFXService.createHedge.mockRejectedValue(
      new FXError("FX_EXECUTION_UNAVAILABLE", "No receipt verifier", 501),
    );
    const body = {
      pair: "USDC/AED",
      type: "FORWARD",
      notionalAmount: "1000",
      currency: "USDC",
      expiryDate: new Date(Date.now() + 86_400_000).toISOString(),
      marginDeposit: "100",
    };

    const response = await request(app).post("/v1/fx/hedges").send(body);

    expect(response.status).toBe(501);
    expect(response.body.error).toBe("FX_EXECUTION_UNAVAILABLE");
    expect(mockFXService.createHedge).toHaveBeenCalledWith(
      body,
      "business-1",
      "business-1",
    );
  });

  it("rejects payload fields on the close endpoint", async () => {
    const response = await request(app)
      .post("/v1/fx/hedges/hedge-1/close")
      .send({ settlementRate: 3.7 });

    expect(response.status).toBe(400);
    expect(mockFXService.closePosition).not.toHaveBeenCalled();
  });

  it("passes a valid close request through to the fail-closed execution guard", async () => {
    mockFXService.closePosition.mockRejectedValue(
      new FXError("FX_EXECUTION_UNAVAILABLE", "No receipt verifier", 501),
    );

    const response = await request(app)
      .post("/v1/fx/hedges/hedge-1/close")
      .send({});

    expect(response.status).toBe(501);
    expect(mockFXService.closePosition).toHaveBeenCalledWith(
      "hedge-1",
      "business-1",
      "business-1",
    );
  });

  it.each([
    ["exposure", "getExposure", { totalExposure: "100" }],
    ["analytics", "getAnalytics", { totalPositions: 1 }],
  ])("returns tenant-scoped %s snapshots", async (path, method, result) => {
    (mockFXService as any)[method].mockResolvedValue(result);

    const response = await request(app).get(`/v1/fx/${path}`);

    expect(response.status).toBe(200);
    expect((mockFXService as any)[method]).toHaveBeenCalledWith("business-1");
  });

  it.each([
    [
      "create",
      "post",
      "/v1/fx/hedges",
      {
        pair: "USDC/AED",
        type: "FORWARD",
        notionalAmount: "1000",
        currency: "USDC",
        expiryDate: "2027-08-01T00:00:00.000Z",
        marginDeposit: "100",
      },
    ],
    ["history", "get", "/v1/fx/hedges", undefined],
    ["close", "post", "/v1/fx/hedges/hedge-1/close", {}],
    ["exposure", "get", "/v1/fx/exposure", undefined],
    ["analytics", "get", "/v1/fx/analytics", undefined],
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

  it("maps unexpected service errors to a redacted response", async () => {
    mockFXService.getRates.mockRejectedValue(new Error("oracle secret-value"));

    const response = await request(app).get("/v1/fx/rates");

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("secret-value");
  });
});
