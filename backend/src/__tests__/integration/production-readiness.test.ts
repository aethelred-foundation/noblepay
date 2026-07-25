/**
 * Production Readiness Integration Tests
 *
 * Validates health/readiness endpoints, CORS enforcement, and strict
 * environment validation that prevents the server from starting without
 * required configuration in production mode.
 */

// ─── Mock Logger & Metrics ──────────────────────────────────────────────────

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
};

jest.mock("../../lib/logger", () => ({
  logger: mockLogger,
  generateCorrelationId: jest.fn().mockReturnValue("prod-test-corr-id"),
  createRequestLogger: jest.fn().mockReturnValue(mockLogger),
}));

jest.mock("../../lib/metrics", () => ({
  paymentTotal: { inc: jest.fn() },
  paymentAmount: { observe: jest.fn() },
  screeningDuration: { observe: jest.fn() },
  compliancePassRate: { set: jest.fn() },
  flaggedPayments: { set: jest.fn() },
  activeBusinesses: { set: jest.fn() },
  httpRequestDuration: { observe: jest.fn() },
  httpRequestTotal: { inc: jest.fn() },
  teeAttestationFailures: { inc: jest.fn() },
  register: {
    metrics: jest.fn().mockResolvedValue(""),
    contentType: "text/plain",
  },
}));

// ─── Mock Prisma ────────────────────────────────────────────────────────────

function createMockModel() {
  return {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
    upsert: jest.fn(),
  };
}

const mockPrisma = {
  payment: createMockModel(),
  business: createMockModel(),
  auditLog: createMockModel(),
  complianceScreening: createMockModel(),
  tEENode: createMockModel(),
  aPIKey: createMockModel(),
  travelRuleRecord: createMockModel(),
  treasuryProposal: createMockModel(),
  $connect: jest.fn(),
  $disconnect: jest.fn(),
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  $on: jest.fn(),
};

jest.mock("@prisma/client", () => ({
  ...jest.requireActual("@prisma/client"),
  PrismaClient: jest.fn().mockImplementation(() => mockPrisma),
  BusinessTier: {
    STARTER: "STARTER",
    STANDARD: "STANDARD",
    ENTERPRISE: "ENTERPRISE",
    INSTITUTIONAL: "INSTITUTIONAL",
  },
}));

// ─── Mock WebSocket service ─────────────────────────────────────────────────

jest.mock("../../services/websocket", () => ({
  wsService: {
    attach: jest.fn(),
    broadcast: jest.fn(),
  },
}));

// ─── Mock route modules ─────────────────────────────────────────────────────

jest.mock("../../routes/payments", () => {
  const { Router } = require("express");
  return Router();
});
jest.mock("../../routes/compliance", () => {
  const { Router } = require("express");
  return Router();
});
jest.mock("../../routes/businesses", () => {
  const { Router } = require("express");
  return Router();
});
jest.mock("../../routes/audit", () => {
  const { Router } = require("express");
  return Router();
});
jest.mock("../../routes/treasury", () => {
  const { Router } = require("express");
  return Router();
});
jest.mock("../../routes/liquidity", () => {
  const { Router } = require("express");
  return Router();
});
jest.mock("../../routes/streaming", () => {
  const { Router } = require("express");
  return Router();
});
jest.mock("../../routes/fx", () => {
  const { Router } = require("express");
  return Router();
});
jest.mock("../../routes/invoices", () => {
  const { Router } = require("express");
  return Router();
});
jest.mock("../../routes/crosschain", () => {
  const { Router } = require("express");
  return Router();
});
jest.mock("../../routes/reporting", () => {
  const { Router } = require("express");
  return Router();
});

import request from "supertest";
import app, {
  setReadinessDependenciesForTest,
  validateProductionEnv,
} from "../../index";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Production Readiness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setReadinessDependenciesForTest({
      database: jest.fn().mockResolvedValue(undefined),
      compliance: jest.fn().mockResolvedValue(undefined),
      rpc: jest.fn().mockResolvedValue(undefined),
      contracts: jest.fn().mockResolvedValue(undefined),
    });
  });

  // ─── Health Endpoint ────────────────────────────────────────────────────

  describe("GET /healthz", () => {
    it("returns 200 with alive status", async () => {
      const res = await request(app).get("/healthz");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "alive",
        service: "noblepay-api",
      });
      expect(res.body).toHaveProperty("uptime");
      expect(res.body).toHaveProperty("timestamp");
    });
  });

  // ─── Readiness Endpoint ─────────────────────────────────────────────────

  describe("GET /readyz", () => {
    it("returns 200 when database is available", async () => {
      const res = await request(app).get("/readyz");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "ready",
        service: "noblepay-api",
        checks: {
          database: "ready",
          compliance: "ready",
          rpc: "ready",
          contracts: "ready",
        },
      });
    });

    it("returns 503 when database is unreachable", async () => {
      setReadinessDependenciesForTest({
        database: jest.fn().mockRejectedValue(new Error("Connection refused")),
        compliance: jest.fn().mockResolvedValue(undefined),
        rpc: jest.fn().mockResolvedValue(undefined),
        contracts: jest.fn().mockResolvedValue(undefined),
      });

      const res = await request(app).get("/readyz");

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        status: "not_ready",
        checks: expect.objectContaining({ database: "unavailable" }),
      });
    });
  });

  // ─── CORS Enforcement ──────────────────────────────────────────────────

  describe("CORS enforcement", () => {
    it("does not use wildcard CORS by default", async () => {
      // The default CORS origin should be http://localhost:3000, not *
      const res = await request(app)
        .options("/v1/payments")
        .set("Origin", "https://evil.example.com")
        .set("Access-Control-Request-Method", "POST");

      // The cors middleware should NOT echo back an unauthorized origin
      const allowOrigin = res.headers["access-control-allow-origin"];
      expect(allowOrigin).not.toBe("*");
      expect(allowOrigin).not.toBe("https://evil.example.com");
    });
  });

  // ─── Production Environment Validation ─────────────────────────────────

  describe("validateProductionEnv", () => {
    let originalExit: typeof process.exit;
    const savedEnv: Record<string, string | undefined> = {};
    const productionKeys = [
      "JWT_SECRET",
      "COMPLIANCE_API_KEY",
      "DATABASE_URL",
      "AETHELRED_RPC_URL",
      "NOBLEPAY_CHAIN_ID",
      "AETHELRED_NETWORK_ANCHOR_BLOCK",
      "AETHELRED_NETWORK_ANCHOR_HASH",
      "NOBLEPAY_CONTRACT_ADDRESS",
      "BUSINESS_REGISTRY_CONTRACT_ADDRESS",
      "BUSINESS_VERIFIER_ADDRESS",
      "NOBLEPAY_MIN_CONFIRMATIONS",
      "NOBLEPAY_TOKEN_CONFIG",
      "COMPLIANCE_API_URL",
      "COMPLIANCE_MAX_DATASET_AGE_HOURS",
      "TRAVEL_RULE_THRESHOLD_USD",
      "TRAVEL_RULE_ACTIVE_KEY_ID",
      "TRAVEL_RULE_ENCRYPTION_KEYS",
      "PUBLIC_ORIGIN",
      "CORS_ORIGIN",
    ];

    beforeEach(() => {
      originalExit = process.exit;
      // Override process.exit to throw instead of killing the test runner
      process.exit = jest.fn(() => {
        throw new Error("process.exit called");
      }) as never;

      // Save env vars
      for (const key of productionKeys) savedEnv[key] = process.env[key];
    });

    afterEach(() => {
      process.exit = originalExit;
      // Restore env vars
      for (const key of productionKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    it("rejects missing JWT_SECRET in production", () => {
      delete process.env.JWT_SECRET;
      process.env.DATABASE_URL = "postgresql://localhost/noblepay";
      process.env.CORS_ORIGIN = "https://noblepay.example.com";

      expect(() => validateProductionEnv()).toThrow("process.exit called");
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("JWT_SECRET"),
      );
    });

    it("rejects missing DATABASE_URL in production", () => {
      process.env.JWT_SECRET = "prod-secret";
      delete process.env.DATABASE_URL;
      process.env.CORS_ORIGIN = "https://noblepay.example.com";

      expect(() => validateProductionEnv()).toThrow("process.exit called");
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("DATABASE_URL"),
      );
    });

    it("rejects wildcard CORS_ORIGIN in production", () => {
      process.env.JWT_SECRET = "prod-secret";
      process.env.DATABASE_URL = "postgresql://localhost/noblepay";
      process.env.CORS_ORIGIN = "*";

      expect(() => validateProductionEnv()).toThrow("process.exit called");
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("CORS_ORIGIN"),
      );
    });

    it("passes when all production env vars are properly set", () => {
      process.env.JWT_SECRET = "j".repeat(32);
      process.env.COMPLIANCE_API_KEY = "c".repeat(32);
      process.env.DATABASE_URL = "postgresql://localhost/noblepay";
      process.env.AETHELRED_RPC_URL = "https://rpc.aethelred.network";
      process.env.NOBLEPAY_CHAIN_ID = "7332";
      process.env.AETHELRED_NETWORK_ANCHOR_BLOCK = "1";
      process.env.AETHELRED_NETWORK_ANCHOR_HASH = `0x${"ab".repeat(32)}`;
      process.env.NOBLEPAY_CONTRACT_ADDRESS =
        "0x1111111111111111111111111111111111111111";
      process.env.BUSINESS_REGISTRY_CONTRACT_ADDRESS =
        "0x2222222222222222222222222222222222222222";
      process.env.BUSINESS_VERIFIER_ADDRESS =
        "0x4444444444444444444444444444444444444444";
      process.env.NOBLEPAY_MIN_CONFIRMATIONS = "2";
      process.env.NOBLEPAY_TOKEN_CONFIG = JSON.stringify({
        "0x3333333333333333333333333333333333333333": {
          currency: "USDC",
          currencyCode: "USD",
          decimals: 6,
        },
      });
      process.env.COMPLIANCE_API_URL = "https://compliance.aethelred.network";
      process.env.COMPLIANCE_MAX_DATASET_AGE_HOURS = "24";
      process.env.TRAVEL_RULE_THRESHOLD_USD = "1000.00";
      process.env.TRAVEL_RULE_ACTIVE_KEY_ID = "test-key";
      process.env.TRAVEL_RULE_ENCRYPTION_KEYS = JSON.stringify({
        "test-key": Buffer.alloc(32, 5).toString("base64"),
      });
      process.env.PUBLIC_ORIGIN = "https://noblepay.example.com";
      process.env.CORS_ORIGIN = "https://noblepay.example.com";

      // Should NOT throw or call process.exit
      validateProductionEnv();
      expect(process.exit).not.toHaveBeenCalled();
    });
  });
});
