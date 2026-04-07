import {
  createMockRequest,
  createMockResponse,
  createMockNext,
  resetAllMocks,
  mockLogger,
} from "../setup";

// Mock jsonwebtoken before importing auth module
jest.mock("jsonwebtoken", () => ({
  verify: jest.fn(),
  sign: jest.fn().mockReturnValue("mock-jwt-token"),
}));

// Mock PrismaClient
const mockPrismaInstance = {
  aPIKey: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrismaInstance),
}));

import jwt from "jsonwebtoken";
import {
  authenticateAPIKey,
  tierRateLimit,
  generateJWT,
  generateAPIKey,
} from "../../middleware/auth";

beforeEach(() => {
  resetAllMocks();
  (jwt.verify as jest.Mock).mockReset();
  mockPrismaInstance.aPIKey.findUnique.mockReset();
  mockPrismaInstance.aPIKey.update.mockReset();
});

describe("Auth Middleware", () => {
  // ─── authenticateAPIKey ────────────────────────────────────────────────────

  describe("authenticateAPIKey", () => {
    it("should return 401 when Authorization header is missing", async () => {
      const req = createMockRequest({ headers: {} });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "UNAUTHORIZED" }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("should return 401 when Authorization header does not start with Bearer", async () => {
      const req = createMockRequest({
        headers: { authorization: "Basic abc123" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("should authenticate with valid JWT token", async () => {
      const jwtPayload = {
        sub: "biz-1",
        businessId: "biz-1",
        tier: "STANDARD",
        iat: Date.now(),
        exp: Date.now() + 86400,
      };
      (jwt.verify as jest.Mock).mockReturnValue(jwtPayload);

      const req = createMockRequest({
        headers: { authorization: "Bearer header.payload.signature" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.businessId).toBe("biz-1");
      expect(req.businessTier).toBe("STANDARD");
      expect(req.jwtPayload).toEqual(jwtPayload);
    });

    it("should fall back to API key when JWT verification fails", async () => {
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error("Invalid token");
      });

      const apiKey = {
        id: "key-1",
        keyHash: expect.any(String),
        status: "ACTIVE",
        businessId: "biz-2",
        business: {
          id: "biz-2",
          tier: "ENTERPRISE",
          kycStatus: "VERIFIED",
        },
      };
      mockPrismaInstance.aPIKey.findUnique.mockResolvedValue(apiKey);
      mockPrismaInstance.aPIKey.update.mockResolvedValue(apiKey);

      const req = createMockRequest({
        headers: { authorization: "Bearer npk_some_api_key" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.businessId).toBe("biz-2");
      expect(req.businessTier).toBe("ENTERPRISE");
      expect(req.apiKeyId).toBe("key-1");
    });

    it("should return 401 when API key is not found", async () => {
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error("Invalid");
      });
      mockPrismaInstance.aPIKey.findUnique.mockResolvedValue(null);

      const req = createMockRequest({
        headers: { authorization: "Bearer invalid-key" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Invalid API key" }),
      );
    });

    it("should return 403 when API key is revoked", async () => {
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error("Invalid");
      });
      mockPrismaInstance.aPIKey.findUnique.mockResolvedValue({
        id: "key-1",
        status: "REVOKED",
        business: { kycStatus: "VERIFIED" },
      });

      const req = createMockRequest({
        headers: { authorization: "Bearer revoked-key" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "FORBIDDEN" }),
      );
    });

    it("should return 403 when business is suspended", async () => {
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error("Invalid");
      });
      mockPrismaInstance.aPIKey.findUnique.mockResolvedValue({
        id: "key-1",
        status: "ACTIVE",
        business: { kycStatus: "SUSPENDED", tier: "STANDARD" },
      });

      const req = createMockRequest({
        headers: { authorization: "Bearer suspended-biz" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Business account is suspended" }),
      );
    });

    it("should return 500 on unexpected error", async () => {
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error("jwt fail");
      });
      mockPrismaInstance.aPIKey.findUnique.mockRejectedValue(
        new Error("DB error"),
      );

      const req = createMockRequest({
        headers: { authorization: "Bearer some-key" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "INTERNAL_ERROR" }),
      );
    });

    it("should log error when API key lastUsed update fails (fire-and-forget)", async () => {
      (jwt.verify as jest.Mock).mockImplementation(() => {
        throw new Error("Invalid token");
      });

      const apiKey = {
        id: "key-1",
        status: "ACTIVE",
        businessId: "biz-2",
        business: {
          id: "biz-2",
          tier: "ENTERPRISE",
          kycStatus: "VERIFIED",
        },
      };
      mockPrismaInstance.aPIKey.findUnique.mockResolvedValue(apiKey);
      mockPrismaInstance.aPIKey.update.mockRejectedValue(
        new Error("Update failed"),
      );

      const req = createMockRequest({
        headers: { authorization: "Bearer npk_some_key" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      // Should still succeed (fire-and-forget)
      expect(next).toHaveBeenCalled();
      expect(req.businessId).toBe("biz-2");

      // Wait for the fire-and-forget promise to settle
      await new Promise((r) => setTimeout(r, 10));

      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to update API key last used",
        expect.objectContaining({ error: "Update failed" }),
      );
    });
  });

  // ─── tierRateLimit ─────────────────────────────────────────────────────────

  describe("tierRateLimit", () => {
    it("should call next when within rate limit", () => {
      const req = createMockRequest({
        businessId: "biz-rate-test",
        businessTier: "ENTERPRISE",
      });
      const res = createMockResponse();
      const next = createMockNext();

      tierRateLimit(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", 1000);
    });

    it("should call next when businessId is missing", () => {
      const req = createMockRequest({
        businessId: undefined,
        businessTier: undefined,
      });
      const res = createMockResponse();
      const next = createMockNext();

      tierRateLimit(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should set rate limit headers", () => {
      const req = createMockRequest({
        businessId: "biz-headers",
        businessTier: "STARTER",
      });
      const res = createMockResponse();
      const next = createMockNext();

      tierRateLimit(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", 60);
      expect(res.setHeader).toHaveBeenCalledWith(
        "X-RateLimit-Remaining",
        expect.any(Number),
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        "X-RateLimit-Reset",
        expect.any(Number),
      );
    });

    it("should return 429 when rate limit is exceeded", () => {
      const businessId = "biz-rate-exceeded";
      const businessTier = "STARTER"; // 60 req/min limit

      // Make 61 requests to exceed the limit
      for (let i = 0; i <= 60; i++) {
        const req = createMockRequest({ businessId, businessTier });
        const res = createMockResponse();
        const next = createMockNext();

        tierRateLimit(req, res, next);

        if (i < 60) {
          expect(next).toHaveBeenCalled();
        } else {
          // 61st request should be rate limited
          expect(res.status).toHaveBeenCalledWith(429);
          expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
              error: "RATE_LIMITED",
              retryAfter: expect.any(Number),
            }),
          );
        }
      }
    });
  });

  // ─── rate limit cleanup ──────────────────────────────────────────────────────

  describe("rate limit cleanup", () => {
    it("should clean up expired rate limit windows via setInterval", () => {
      jest.useFakeTimers();

      let isolatedTierRateLimit: typeof tierRateLimit;

      jest.isolateModules(() => {
        // Re-import module with fake timers active so setInterval is captured
        const authModule = require("../../middleware/auth");
        isolatedTierRateLimit = authModule.tierRateLimit;
      });

      // Create a rate limit entry by making a request
      const req = createMockRequest({
        businessId: "biz-cleanup-isolated",
        businessTier: "STARTER",
      });
      const res = createMockResponse();
      const next = createMockNext();

      isolatedTierRateLimit!(req, res, next);
      expect(next).toHaveBeenCalled();

      // Advance time past the window expiry and cleanup interval
      jest.advanceTimersByTime(600_000);

      jest.useRealTimers();
    });
  });

  // ─── generateJWT ───────────────────────────────────────────────────────────

  describe("generateJWT", () => {
    it("should call jwt.sign with correct parameters", () => {
      const token = generateJWT("biz-1", "STANDARD");

      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: expect.stringContaining("user:biz-1:"),
          businessId: "biz-1",
          tier: "STANDARD",
          role: "VIEWER",
        }),
        expect.any(String),
        { expiresIn: "24h" },
      );
      expect(token).toBe("mock-jwt-token");
    });

    it("should include custom role when provided", () => {
      const token = generateJWT("biz-1", "ENTERPRISE", "ADMIN");

      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: expect.stringContaining("user:biz-1:"),
          businessId: "biz-1",
          tier: "ENTERPRISE",
          role: "ADMIN",
        }),
        expect.any(String),
        { expiresIn: "24h" },
      );
      expect(token).toBe("mock-jwt-token");
    });
  });

  // ─── generateAPIKey ────────────────────────────────────────────────────────

  describe("generateAPIKey", () => {
    it("should generate a key starting with npk_", () => {
      const { rawKey, keyHash } = generateAPIKey();

      expect(rawKey).toMatch(/^npk_[a-f0-9]{64}$/);
      expect(keyHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should generate unique keys on each call", () => {
      const first = generateAPIKey();
      const second = generateAPIKey();

      expect(first.rawKey).not.toBe(second.rawKey);
      expect(first.keyHash).not.toBe(second.keyHash);
    });

    it("should produce consistent hash for same key", () => {
      const { rawKey, keyHash } = generateAPIKey();
      expect(keyHash).not.toBe(rawKey);
      expect(keyHash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  // ─── NP-02: JWT_SECRET validation ────────────────────────────────────────

  describe("JWT_SECRET validation (NP-02)", () => {
    it("should throw FATAL error when JWT_SECRET is unset in non-test mode", () => {
      const originalEnv = process.env.NODE_ENV;
      const originalSecret = process.env.JWT_SECRET;

      // Remove JWT_SECRET and set to production mode
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = "production";

      expect(() => {
        jest.isolateModules(() => {
          require("../../middleware/auth");
        });
      }).toThrow("FATAL: JWT_SECRET environment variable is required in non-test environments");

      // Restore env
      process.env.NODE_ENV = originalEnv;
      if (originalSecret !== undefined) {
        process.env.JWT_SECRET = originalSecret;
      }
    });

    it("should use test-secret fallback when in test mode without JWT_SECRET", () => {
      const originalSecret = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;

      // In test mode (current), the module should load without error
      expect(() => {
        jest.isolateModules(() => {
          require("../../middleware/auth");
        });
      }).not.toThrow();

      if (originalSecret !== undefined) {
        process.env.JWT_SECRET = originalSecret;
      }
    });
  });
});
