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
  teeNodesActive: { set: jest.fn() },
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
import app, { validateProductionEnv } from "../../index";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Production Readiness", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ "1": 1 }]);

      const res = await request(app).get("/readyz");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "ready",
        service: "noblepay-api",
        database: "connected",
      });
    });

    it("returns 503 when database is unreachable", async () => {
      mockPrisma.$queryRaw.mockRejectedValueOnce(
        new Error("Connection refused"),
      );

      const res = await request(app).get("/readyz");

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        status: "not_ready",
        database: "disconnected",
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

    beforeEach(() => {
      originalExit = process.exit;
      // Override process.exit to throw instead of killing the test runner
      process.exit = jest.fn(() => {
        throw new Error("process.exit called");
      }) as never;

      // Save env vars
      savedEnv.JWT_SECRET = process.env.JWT_SECRET;
      savedEnv.DATABASE_URL = process.env.DATABASE_URL;
      savedEnv.CORS_ORIGIN = process.env.CORS_ORIGIN;
    });

    afterEach(() => {
      process.exit = originalExit;
      // Restore env vars
      if (savedEnv.JWT_SECRET !== undefined) {
        process.env.JWT_SECRET = savedEnv.JWT_SECRET;
      } else {
        delete process.env.JWT_SECRET;
      }
      if (savedEnv.DATABASE_URL !== undefined) {
        process.env.DATABASE_URL = savedEnv.DATABASE_URL;
      } else {
        delete process.env.DATABASE_URL;
      }
      if (savedEnv.CORS_ORIGIN !== undefined) {
        process.env.CORS_ORIGIN = savedEnv.CORS_ORIGIN;
      } else {
        delete process.env.CORS_ORIGIN;
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
      process.env.JWT_SECRET = "prod-secret-long-enough";
      process.env.DATABASE_URL = "postgresql://localhost/noblepay";
      process.env.CORS_ORIGIN = "https://noblepay.example.com";

      // Should NOT throw or call process.exit
      validateProductionEnv();
      expect(process.exit).not.toHaveBeenCalled();
    });
  });
});
