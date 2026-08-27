import type { Express } from "express";
import request from "supertest";

function mockEmptyRouter() {
  const { Router } = require("express") as typeof import("express");
  return Router();
}

function mockRoadmapRouter() {
  const { Router } = require("express") as typeof import("express");
  const router = Router();
  router.use((_req, res) => {
    res.status(200).json({ exposed: true });
  });
  return router;
}

jest.mock("../../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  },
  generateCorrelationId: jest.fn().mockReturnValue("roadmap-test-correlation"),
}));

jest.mock("../../lib/metrics", () => ({
  register: {
    metrics: jest.fn().mockResolvedValue(""),
    contentType: "text/plain",
  },
  httpRequestDuration: { observe: jest.fn() },
  httpRequestTotal: { inc: jest.fn() },
}));

jest.mock("../../lib/db", () => ({
  disconnectDatabase: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../lib/env-validation", () => ({
  collectProductionEnvErrors: jest.fn().mockReturnValue([]),
}));

jest.mock("../../middleware/auth", () => {
  const requireAuthentication = process.env.NODE_ENV !== "test";
  return {
    authenticateAPIKey: (
      _req: unknown,
      res: { status: (status: number) => { json: (body: unknown) => void } },
      next: () => void,
    ) =>
      requireAuthentication
        ? res.status(401).json({ error: "UNAUTHENTICATED" })
        : next(),
    tierRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
    createTierRateLimit:
      () => (_req: unknown, _res: unknown, next: () => void) =>
        next(),
  };
});

jest.mock("../../services/readiness", () => ({
  createDefaultReadinessDependencies: jest.fn().mockReturnValue({}),
  runReadinessChecks: jest.fn().mockResolvedValue({ ready: true, checks: {} }),
}));

jest.mock("../../services/websocket", () => ({
  wsService: {
    attach: jest.fn(),
    close: jest.fn(),
  },
}));

jest.mock("../../routes/payments", () => mockEmptyRouter());
jest.mock("../../routes/compliance", () => mockEmptyRouter());
jest.mock("../../routes/businesses", () => mockEmptyRouter());
jest.mock("../../routes/audit", () => mockEmptyRouter());
jest.mock("../../routes/reporting", () => mockEmptyRouter());
jest.mock("../../routes/auth", () => mockEmptyRouter());

jest.mock("../../routes/treasury", () => mockRoadmapRouter());
jest.mock("../../routes/liquidity", () => mockRoadmapRouter());
jest.mock("../../routes/streaming", () => mockRoadmapRouter());
jest.mock("../../routes/fx", () => mockRoadmapRouter());
jest.mock("../../routes/invoices", () => mockRoadmapRouter());
jest.mock("../../routes/crosschain", () => mockRoadmapRouter());
jest.mock("../../routes/ai-compliance", () => mockRoadmapRouter());

const ROADMAP_API_REQUESTS = [
  "/v1/treasury/overview",
  "/v1/liquidity/pools",
  "/v1/streams",
  "/v1/fx/rates",
  "/v1/invoices",
  "/v1/crosschain/chains",
  "/v1/ai-compliance/models",
] as const;

describe("production roadmap API exposure", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let productionApp: Express;
  let stagingApp: Express;
  let missingEnvironmentApp: Express;
  let testApp: Express;

  function loadApp(environment: string | undefined): Express {
    jest.resetModules();
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;

    const expressModule = require("express") as typeof import("express");
    const listenSpy = jest
      .spyOn(expressModule.application, "listen")
      .mockImplementation(((_port: number, callback?: () => void) => {
        callback?.();
        return { close: jest.fn() };
      }) as never);
    const processOnSpy = jest
      .spyOn(process, "on")
      .mockImplementation((() => process) as never);

    try {
      return require("../../index").default as Express;
    } finally {
      processOnSpy.mockRestore();
      listenSpy.mockRestore();
    }
  }

  beforeAll(() => {
    productionApp = loadApp("production");
    stagingApp = loadApp("staging");
    missingEnvironmentApp = loadApp(undefined);
    testApp = loadApp("test");
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it.each(ROADMAP_API_REQUESTS)(
    "returns the generic 404 rather than auth or a roadmap handler for %s",
    async (path) => {
      const response = await request(productionApp).get(path);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: "NOT_FOUND",
        message: "The requested endpoint does not exist",
      });
    },
  );

  it.each([
    ["staging", () => stagingApp],
    ["an undefined environment", () => missingEnvironmentApp],
  ] as const)("also fails closed in %s", async (_label, getApp) => {
    const response = await request(getApp()).get("/v1/treasury/overview");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: "NOT_FOUND",
      message: "The requested endpoint does not exist",
    });
  });

  it.each(ROADMAP_API_REQUESTS)(
    "keeps the roadmap preview mounted for tests at %s",
    async (path) => {
      const response = await request(testApp).get(path);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ exposed: true });
    },
  );

  it("keeps authentication on the supported API surface", async () => {
    const response = await request(productionApp).get("/v1/payments");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "UNAUTHENTICATED" });
  });
});
