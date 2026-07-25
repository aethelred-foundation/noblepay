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
  business: {
    findUnique: jest.fn(),
  },
  aPIKey: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};
const mockCurrentAuthorization = jest.fn();

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrismaInstance),
}));
jest.mock("../../lib/business-registry-authorization", () => ({
  getCurrentBusinessRegistryAuthorization: (address: string) =>
    mockCurrentAuthorization(address),
}));

import jwt from "jsonwebtoken";
import {
  authenticateAPIKey,
  createTierRateLimit,
  tierRateLimit,
  generateJWT,
  generateAPIKey,
} from "../../middleware/auth";

beforeEach(() => {
  resetAllMocks();
  (jwt.verify as jest.Mock).mockReset();
  mockPrismaInstance.aPIKey.findUnique.mockReset();
  mockPrismaInstance.aPIKey.update.mockReset();
  mockPrismaInstance.business.findUnique.mockReset();
  mockPrismaInstance.business.findUnique.mockResolvedValue({
    id: "biz-1",
    address: "0x1234567890abcdef1234567890abcdef12345678",
  });
  mockCurrentAuthorization.mockReset();
  mockCurrentAuthorization.mockResolvedValue({
    active: true,
    status: "VERIFIED",
    tier: "STANDARD",
    isAdmin: false,
  });
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
        sub: "0x1234567890abcdef1234567890abcdef12345678",
        businessId: "biz-1",
        tier: "STANDARD",
        role: "ADMIN",
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

    it.each(["SUSPENDED", "REVOKED"])(
      "revokes an existing wallet session immediately when chain status is %s",
      async (status) => {
        (jwt.verify as jest.Mock).mockReturnValue({
          sub: "0x1234567890abcdef1234567890abcdef12345678",
          businessId: "biz-1",
          tier: "STANDARD",
          role: "ADMIN",
          iat: 1,
          exp: 2,
        });
        mockCurrentAuthorization.mockResolvedValue({
          active: false,
          status,
          tier: "STANDARD",
          isAdmin: false,
        });
        const req = createMockRequest({
          headers: { authorization: "Bearer header.payload.signature" },
        });
        const res = createMockResponse();
        const next = createMockNext();

        await authenticateAPIKey(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ error: "BUSINESS_INACTIVE" }),
        );
        expect(next).not.toHaveBeenCalled();
      },
    );

    it("fails a valid session closed when canonical chain authorization is unavailable", async () => {
      (jwt.verify as jest.Mock).mockReturnValue({
        sub: "0x1234567890abcdef1234567890abcdef12345678",
        businessId: "biz-1",
        tier: "STANDARD",
        role: "ADMIN",
        iat: 1,
        exp: 2,
      });
      mockCurrentAuthorization.mockRejectedValue(new Error("RPC unavailable"));
      const req = createMockRequest({
        headers: { authorization: "Bearer header.payload.signature" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(next).not.toHaveBeenCalled();
    });

    it("overwrites stale session tier and downgrades removed chain-admin privilege", async () => {
      (jwt.verify as jest.Mock).mockReturnValue({
        sub: "0x1234567890abcdef1234567890abcdef12345678",
        businessId: "biz-1",
        tier: "STANDARD",
        role: "SUPER_ADMIN",
        iat: 1,
        exp: 2,
      });
      mockCurrentAuthorization.mockResolvedValue({
        active: true,
        status: "VERIFIED",
        tier: "ENTERPRISE",
        isAdmin: false,
      });
      const req = createMockRequest({
        headers: { authorization: "Bearer header.payload.signature" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.businessTier).toBe("ENTERPRISE");
      expect(req.jwtPayload).toMatchObject({
        tier: "ENTERPRISE",
        role: "ADMIN",
      });
    });

    it("rejects an unsafe cookie-authenticated request without a CSRF header", async () => {
      const req = createMockRequest({
        method: "POST",
        headers: {
          cookie: "noblepay_session=session-token; noblepay_csrf=csrf-token",
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "CSRF_VALIDATION_FAILED" }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("accepts a matching double-submit CSRF token for a wallet session", async () => {
      (jwt.verify as jest.Mock).mockReturnValue({
        sub: "0x1234567890abcdef1234567890abcdef12345678",
        businessId: "biz-1",
        tier: "STANDARD",
        role: "ADMIN",
        iat: 1,
        exp: 2,
      });
      const req = createMockRequest({
        method: "POST",
        headers: {
          cookie: "noblepay_session=session-token; noblepay_csrf=csrf-token",
          "x-csrf-token": "csrf-token",
        },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.authType).toBe("cookie");
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
          address: "0x2234567890abcdef1234567890abcdef12345678",
          tier: "ENTERPRISE",
          kycStatus: "VERIFIED",
        },
      };
      mockPrismaInstance.aPIKey.findUnique.mockResolvedValue(apiKey);
      mockCurrentAuthorization.mockResolvedValue({
        active: true,
        status: "VERIFIED",
        tier: "ENTERPRISE",
        isAdmin: false,
      });
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
        business: {
          address: "0x2234567890abcdef1234567890abcdef12345678",
          kycStatus: "SUSPENDED",
          tier: "STANDARD",
        },
      });
      mockCurrentAuthorization.mockResolvedValue({
        active: false,
        status: "SUSPENDED",
        tier: "STANDARD",
        isAdmin: false,
      });

      const req = createMockRequest({
        headers: { authorization: "Bearer suspended-biz" },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authenticateAPIKey(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "BUSINESS_INACTIVE" }),
      );
    });

    it("should return 503 on unexpected authentication service error", async () => {
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

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "AUTHENTICATION_UNAVAILABLE" }),
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
          address: "0x2234567890abcdef1234567890abcdef12345678",
          tier: "ENTERPRISE",
          kycStatus: "VERIFIED",
        },
      };
      mockPrismaInstance.aPIKey.findUnique.mockResolvedValue(apiKey);
      mockCurrentAuthorization.mockResolvedValue({
        active: true,
        status: "VERIFIED",
        tier: "ENTERPRISE",
        isAdmin: false,
      });
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
    it("should call next when within rate limit", async () => {
      const limiter = createTierRateLimit({
        store: {
          consume: jest.fn().mockResolvedValue({
            count: 1,
            resetAt: new Date(Date.now() + 60_000),
          }),
        },
      });
      const req = createMockRequest({
        businessId: "biz-rate-test",
        businessTier: "ENTERPRISE",
      });
      const res = createMockResponse();
      const next = createMockNext();

      await limiter(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", 5000);
    });

    it("should call next when businessId is missing", async () => {
      const req = createMockRequest({
        businessId: undefined,
        businessTier: undefined,
      });
      const res = createMockResponse();
      const next = createMockNext();

      await tierRateLimit(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should set rate limit headers", async () => {
      const resetAt = new Date(Date.now() + 60_000);
      const limiter = createTierRateLimit({
        store: {
          consume: jest.fn().mockResolvedValue({ count: 1, resetAt }),
        },
      });
      const req = createMockRequest({
        businessId: "biz-headers",
        businessTier: "STANDARD",
      });
      const res = createMockResponse();
      const next = createMockNext();

      await limiter(req, res, next);

      expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", 300);
      expect(res.setHeader).toHaveBeenCalledWith(
        "X-RateLimit-Remaining",
        expect.any(Number),
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        "X-RateLimit-Reset",
        expect.any(Number),
      );
    });

    it("should return 429 when rate limit is exceeded", async () => {
      const limiter = createTierRateLimit({
        store: {
          consume: jest.fn().mockResolvedValue({
            count: 301,
            resetAt: new Date(Date.now() + 60_000),
          }),
        },
      });
      const req = createMockRequest({
        businessId: "biz-rate-exceeded",
        businessTier: "STANDARD",
      });
      const res = createMockResponse();
      const next = createMockNext();

      await limiter(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "RATE_LIMITED",
          retryAfter: expect.any(Number),
        }),
      );
    });
  });

  // ─── rate limit cleanup ──────────────────────────────────────────────────────

  describe("rate limit cleanup", () => {
    it("delegates expiry cleanup to the durable store", async () => {
      const consume = jest.fn().mockResolvedValue({
        count: 1,
        resetAt: new Date(Date.now() + 60_000),
      });
      const limiter = createTierRateLimit({ store: { consume } });
      const req = createMockRequest({
        businessId: "biz-cleanup-isolated",
        businessTier: "STANDARD",
      });
      const res = createMockResponse();
      const next = createMockNext();

      await limiter(req, res, next);

      expect(consume).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: "biz-cleanup-isolated",
          expiresAt: expect.any(Date),
        }),
      );
      expect(next).toHaveBeenCalled();
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
        {
          algorithm: "HS256",
          expiresIn: 900,
          issuer: "noblepay-api",
          audience: "noblepay-web",
        },
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
        {
          algorithm: "HS256",
          expiresIn: 900,
          issuer: "noblepay-api",
          audience: "noblepay-web",
        },
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
      const crypto = require("crypto");
      const { rawKey, keyHash } = generateAPIKey();
      const recomputed = crypto
        .createHash("sha256")
        .update(rawKey)
        .digest("hex");
      expect(keyHash).toBe(recomputed);
    });
  });

  // ─── NP-02: JWT_SECRET validation ────────────────────────────────────────

  describe("JWT_SECRET validation (NP-02)", () => {
    it("should fail closed when JWT_SECRET is unset in non-test mode", () => {
      const originalEnv = process.env.NODE_ENV;
      const originalSecret = process.env.JWT_SECRET;

      // Remove JWT_SECRET and set to production mode
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = "production";

      expect(() => generateJWT("biz-1", "STANDARD")).toThrow(
        "JWT_SECRET is not configured",
      );

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
