import {
  createMockPrisma,
  resetAllMocks,
  VALID_ETH_ADDRESS,
} from "../setup";

const mockPrisma = createMockPrisma();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
  KYCStatus: { UNVERIFIED: "UNVERIFIED", VERIFIED: "VERIFIED", SUSPENDED: "SUSPENDED" },
  BusinessTier: { STARTER: "STARTER", STANDARD: "STANDARD", ENTERPRISE: "ENTERPRISE", INSTITUTIONAL: "INSTITUTIONAL" },
}));

const mockAuditService = { createAuditEntry: jest.fn().mockResolvedValue({}) };

jest.mock("../../services/audit", () => ({
  AuditService: jest.fn(() => mockAuditService),
}));

jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: jest.fn((req: any, _res: any, next: any) => {
    // Set default businessId for tests (can be overridden via header)
    req.businessId = req.headers["x-test-business-id"] || "biz-1";
    req.businessTier = "STANDARD";
    next();
  }),
  generateAPIKey: jest.fn(() => ({
    rawKey: "npk_" + "a".repeat(64),
    keyHash: "b".repeat(64),
  })),
}));

jest.mock("../../middleware/validation", () => ({
  validate: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  CreateBusinessSchema: {},
  UpdateBusinessSchema: {},
  ListBusinessesSchema: {},
}));

// Mock rbac middleware to pass through by default (role checks tested separately)
const mockRequireOwnership = jest.fn().mockReturnValue(true);
const mockRequireRole = jest.fn((..._roles: any[]) => (_req: any, _res: any, next: any) => next());
const mockExtractRole = jest.fn((_req: any, _res: any, next: any) => next());
const mockRequirePermission = jest.fn((..._perms: any[]) => (_req: any, _res: any, next: any) => next());
jest.mock("../../middleware/rbac", () => {
  const actual = jest.requireActual("../../middleware/rbac");
  return {
    ...actual,
    extractRole: mockExtractRole,
    requireRole: mockRequireRole,
    requirePermission: mockRequirePermission,
    requireOwnership: mockRequireOwnership,
  };
});

import express from "express";
import request from "supertest";
import businessesRouter from "../../routes/businesses";

// Capture requireRole calls made during module initialization (route definitions)
const moduleLoadRoleCalls = [...mockRequireRole.mock.calls];

const app = express();
app.use(express.json());
app.use("/v1/businesses", businessesRouter);

const baseBusiness = {
  id: "biz-1",
  address: VALID_ETH_ADDRESS,
  licenseNumber: "LIC-001",
  businessName: "Test Corp",
  jurisdiction: "UAE",
  businessType: "Fintech",
  contactEmail: "test@example.com",
  kycStatus: "UNVERIFIED",
  tier: "STARTER",
  dailyLimit: 10000,
  monthlyLimit: 100000,
  registeredAt: new Date(),
};

beforeEach(() => {
  resetAllMocks();
  mockRequireOwnership.mockReturnValue(true);
});

describe("Businesses Routes", () => {
  // ─── POST /v1/businesses ────────────────────────────────────────────────────

  describe("POST /v1/businesses", () => {
    it("should register a new business", async () => {
      mockPrisma.business.findFirst.mockResolvedValue(null);
      mockPrisma.business.create.mockResolvedValue(baseBusiness);
      mockPrisma.aPIKey.create.mockResolvedValue({});

      const res = await request(app)
        .post("/v1/businesses")
        .send({
          address: VALID_ETH_ADDRESS,
          licenseNumber: "LIC-001",
          businessName: "Test Corp",
          jurisdiction: "UAE",
          businessType: "Fintech",
          contactEmail: "test@example.com",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.apiKey).toBeDefined();
    });

    it("should return 409 when business already exists", async () => {
      mockPrisma.business.findFirst.mockResolvedValue(baseBusiness);

      const res = await request(app)
        .post("/v1/businesses")
        .send({
          address: VALID_ETH_ADDRESS,
          licenseNumber: "LIC-001",
          businessName: "Test Corp",
          jurisdiction: "UAE",
          businessType: "Fintech",
          contactEmail: "test@example.com",
        });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("DUPLICATE_BUSINESS");
    });

    it("should return 500 on unexpected error", async () => {
      mockPrisma.business.findFirst.mockRejectedValue(new Error("DB error"));

      const res = await request(app)
        .post("/v1/businesses")
        .send({ address: VALID_ETH_ADDRESS, licenseNumber: "LIC-002", businessName: "Fail Corp", jurisdiction: "UAE", businessType: "Fintech", contactEmail: "x@y.com" });

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /v1/businesses ─────────────────────────────────────────────────────

  describe("GET /v1/businesses", () => {
    it("should list businesses", async () => {
      mockPrisma.business.findMany.mockResolvedValue([baseBusiness]);
      mockPrisma.business.count.mockResolvedValue(1);

      const res = await request(app).get("/v1/businesses");

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.pagination).toBeDefined();
    });

    it("should filter by kycStatus", async () => {
      mockPrisma.business.findMany.mockResolvedValue([baseBusiness]);
      mockPrisma.business.count.mockResolvedValue(1);

      const res = await request(app).get("/v1/businesses?kycStatus=VERIFIED");

      expect(res.status).toBe(200);
    });

    it("should filter by tier", async () => {
      mockPrisma.business.findMany.mockResolvedValue([baseBusiness]);
      mockPrisma.business.count.mockResolvedValue(1);

      const res = await request(app).get("/v1/businesses?tier=STARTER");

      expect(res.status).toBe(200);
    });

    it("should filter by jurisdiction", async () => {
      mockPrisma.business.findMany.mockResolvedValue([baseBusiness]);
      mockPrisma.business.count.mockResolvedValue(1);

      const res = await request(app).get("/v1/businesses?jurisdiction=UAE");

      expect(res.status).toBe(200);
    });

    it("should return 500 on error", async () => {
      mockPrisma.business.findMany.mockRejectedValue(new Error("DB error"));

      const res = await request(app).get("/v1/businesses");

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /v1/businesses/:id ─────────────────────────────────────────────────

  describe("GET /v1/businesses/:id", () => {
    it("should return business by ID", async () => {
      mockPrisma.business.findUnique.mockResolvedValue({
        ...baseBusiness,
        apiKeys: [{ id: "key-1", name: "Default", lastUsed: null, status: "ACTIVE", createdAt: new Date() }],
      });

      const res = await request(app).get("/v1/businesses/biz-1");

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("biz-1");
    });

    it("should return 404 when business not found", async () => {
      mockPrisma.business.findUnique.mockResolvedValue(null);

      const res = await request(app).get("/v1/businesses/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("BUSINESS_NOT_FOUND");
    });

    it("should return 500 on error", async () => {
      mockPrisma.business.findUnique.mockRejectedValue(new Error("DB error"));

      const res = await request(app).get("/v1/businesses/biz-1");

      expect(res.status).toBe(500);
    });
  });

  // ─── PATCH /v1/businesses/:id ───────────────────────────────────────────────

  describe("PATCH /v1/businesses/:id", () => {
    it("should update a business", async () => {
      mockPrisma.business.findUnique.mockResolvedValue(baseBusiness);
      mockPrisma.business.update.mockResolvedValue({
        ...baseBusiness,
        businessName: "Updated Corp",
      });

      const res = await request(app)
        .patch("/v1/businesses/biz-1")
        .send({ businessName: "Updated Corp" });

      expect(res.status).toBe(200);
      expect(res.body.data.businessName).toBe("Updated Corp");
    });

    it("should return 404 when business not found", async () => {
      mockPrisma.business.findUnique.mockResolvedValue(null);

      // Must use same business ID as the authenticated caller to pass ownership check
      const res = await request(app)
        .patch("/v1/businesses/biz-1")
        .set("x-test-business-id", "biz-1")
        .send({ businessName: "X" });

      expect(res.status).toBe(404);
    });

    it("should return 500 on error", async () => {
      mockPrisma.business.findUnique.mockRejectedValue(new Error("DB error"));

      const res = await request(app)
        .patch("/v1/businesses/biz-1")
        .set("x-test-business-id", "biz-1")
        .send({ businessName: "Fail" });

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /v1/businesses/:id/verify ─────────────────────────────────────────

  describe("POST /v1/businesses/:id/verify", () => {
    it("should verify a business", async () => {
      mockPrisma.business.findUnique.mockResolvedValue({ ...baseBusiness, kycStatus: "UNVERIFIED" });
      mockPrisma.business.update.mockResolvedValue({ ...baseBusiness, kycStatus: "VERIFIED", tier: "STARTER" });
      mockPrisma.business.count.mockResolvedValue(5);

      const res = await request(app).post("/v1/businesses/biz-1/verify");

      expect(res.status).toBe(200);
      expect(res.body.message).toBe("Business KYC verified successfully");
    });

    it("should return 404 when business not found", async () => {
      mockPrisma.business.findUnique.mockResolvedValue(null);

      const res = await request(app).post("/v1/businesses/nonexistent/verify");

      expect(res.status).toBe(404);
    });

    it("should return 409 when already verified", async () => {
      mockPrisma.business.findUnique.mockResolvedValue({ ...baseBusiness, kycStatus: "VERIFIED" });

      const res = await request(app).post("/v1/businesses/biz-1/verify");

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("ALREADY_VERIFIED");
    });

    it("should return 500 on error", async () => {
      mockPrisma.business.findUnique.mockRejectedValue(new Error("DB error"));

      const res = await request(app).post("/v1/businesses/biz-1/verify");

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /v1/businesses/:id/suspend ────────────────────────────────────────

  describe("POST /v1/businesses/:id/suspend", () => {
    it("should suspend a business and revoke API keys", async () => {
      mockPrisma.business.findUnique.mockResolvedValue({ ...baseBusiness, kycStatus: "VERIFIED" });
      mockPrisma.business.update.mockResolvedValue({ ...baseBusiness, kycStatus: "SUSPENDED" });
      mockPrisma.aPIKey.updateMany.mockResolvedValue({ count: 2 });

      const res = await request(app).post("/v1/businesses/biz-1/suspend");

      expect(res.status).toBe(200);
      expect(res.body.message).toContain("suspended");
      expect(mockPrisma.aPIKey.updateMany).toHaveBeenCalled();
    });

    it("should return 409 when already suspended", async () => {
      mockPrisma.business.findUnique.mockResolvedValue({ ...baseBusiness, kycStatus: "SUSPENDED" });

      const res = await request(app).post("/v1/businesses/biz-1/suspend");

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("ALREADY_SUSPENDED");
    });

    it("should return 404 when business not found", async () => {
      mockPrisma.business.findUnique.mockResolvedValue(null);

      const res = await request(app).post("/v1/businesses/nonexistent/suspend");

      expect(res.status).toBe(404);
    });

    it("should return 500 on error", async () => {
      mockPrisma.business.findUnique.mockRejectedValue(new Error("DB error"));

      const res = await request(app).post("/v1/businesses/biz-1/suspend");

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /v1/businesses/:id/upgrade ────────────────────────────────────────

  describe("POST /v1/businesses/:id/upgrade", () => {
    it("should upgrade a verified business tier", async () => {
      mockPrisma.business.findUnique.mockResolvedValue({
        ...baseBusiness,
        kycStatus: "VERIFIED",
        tier: "STARTER",
      });
      mockPrisma.business.update.mockResolvedValue({
        ...baseBusiness,
        tier: "STANDARD",
        dailyLimit: 50000,
        monthlyLimit: 500000,
      });

      const res = await request(app).post("/v1/businesses/biz-1/upgrade");

      expect(res.status).toBe(200);
      expect(res.body.message).toContain("STANDARD");
    });

    it("should return 403 when business not KYC verified", async () => {
      mockPrisma.business.findUnique.mockResolvedValue({
        ...baseBusiness,
        kycStatus: "UNVERIFIED",
      });

      const res = await request(app).post("/v1/businesses/biz-1/upgrade");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("KYC_REQUIRED");
    });

    it("should return 409 when at max tier", async () => {
      mockPrisma.business.findUnique.mockResolvedValue({
        ...baseBusiness,
        kycStatus: "VERIFIED",
        tier: "INSTITUTIONAL",
      });

      const res = await request(app).post("/v1/businesses/biz-1/upgrade");

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("MAX_TIER");
    });

    it("should return 404 when business not found", async () => {
      mockPrisma.business.findUnique.mockResolvedValue(null);

      const res = await request(app).post("/v1/businesses/nonexistent/upgrade");

      expect(res.status).toBe(404);
    });

    it("should return 500 on error", async () => {
      mockPrisma.business.findUnique.mockRejectedValue(new Error("DB error"));

      const res = await request(app).post("/v1/businesses/biz-1/upgrade");

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /v1/businesses/:id/limits ──────────────────────────────────────────

  describe("GET /v1/businesses/:id/limits", () => {
    it("should return business payment limits", async () => {
      mockPrisma.business.findUnique.mockResolvedValue(baseBusiness);
      mockPrisma.payment.aggregate
        .mockResolvedValueOnce({ _sum: { amount: 5000 }, _count: { id: 10 } })
        .mockResolvedValueOnce({ _sum: { amount: 20000 }, _count: { id: 50 } });

      const res = await request(app).get("/v1/businesses/biz-1/limits");

      expect(res.status).toBe(200);
      expect(res.body.data.tier).toBe("STARTER");
      expect(res.body.data.daily).toBeDefined();
      expect(res.body.data.monthly).toBeDefined();
    });

    it("should return 404 when business not found", async () => {
      mockPrisma.business.findUnique.mockResolvedValue(null);

      const res = await request(app).get("/v1/businesses/nonexistent/limits");

      expect(res.status).toBe(404);
    });

    it("should handle null aggregate sums", async () => {
      mockPrisma.business.findUnique.mockResolvedValue(baseBusiness);
      mockPrisma.payment.aggregate
        .mockResolvedValueOnce({ _sum: { amount: null }, _count: { id: 0 } })
        .mockResolvedValueOnce({ _sum: { amount: null }, _count: { id: 0 } });

      const res = await request(app).get("/v1/businesses/biz-1/limits");

      expect(res.status).toBe(200);
      expect(res.body.data.daily.used).toBe("0");
      expect(res.body.data.monthly.used).toBe("0");
    });

    it("should return 500 on error", async () => {
      mockPrisma.business.findUnique.mockRejectedValue(new Error("DB error"));

      const res = await request(app).get("/v1/businesses/biz-1/limits");

      expect(res.status).toBe(500);
    });
  });

  // ─── NP-03 Tenant Isolation Tests ────────────────────────────────────────────

  describe("Tenant isolation (NP-03)", () => {
    it("should return 403 when tenant A tries to read tenant B's record", async () => {
      // Mock requireOwnership to deny access
      mockRequireOwnership.mockReturnValue(false);

      const res = await request(app)
        .get("/v1/businesses/biz-other")
        .set("x-test-business-id", "biz-1");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("should return 403 when tenant A tries to PATCH tenant B's record", async () => {
      // The PATCH route checks req.businessId !== req.params.id directly
      const res = await request(app)
        .patch("/v1/businesses/biz-other")
        .set("x-test-business-id", "biz-1")
        .send({ businessName: "Hacked Corp" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("should allow owner to PATCH their own record", async () => {
      mockPrisma.business.findUnique.mockResolvedValue(baseBusiness);
      mockPrisma.business.update.mockResolvedValue({
        ...baseBusiness,
        businessName: "Updated Corp",
      });

      const res = await request(app)
        .patch("/v1/businesses/biz-1")
        .set("x-test-business-id", "biz-1")
        .send({ businessName: "Updated Corp" });

      expect(res.status).toBe(200);
    });

    it("should enforce admin/compliance role for verify endpoint", () => {
      // Verify requireRole was called with ADMIN + COMPLIANCE_OFFICER at route definition time
      const verifyCalls = moduleLoadRoleCalls.filter(
        (c: any[]) => c.length === 2 && c[0] === "ADMIN" && c[1] === "COMPLIANCE_OFFICER",
      );
      expect(verifyCalls.length).toBe(1);
    });

    it("should enforce admin role for list, suspend and upgrade endpoints", () => {
      // Verify requireRole was called with just ADMIN (for list, suspend, and upgrade)
      const adminOnlyCalls = moduleLoadRoleCalls.filter(
        (c: any[]) => c.length === 1 && c[0] === "ADMIN",
      );
      expect(adminOnlyCalls.length).toBeGreaterThanOrEqual(3); // list + suspend + upgrade
    });

    it("should return 403 when non-owner queries another business's limits", async () => {
      mockRequireOwnership.mockReturnValue(false);

      const res = await request(app)
        .get("/v1/businesses/biz-other/limits")
        .set("x-test-business-id", "biz-1");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });
  });
});
