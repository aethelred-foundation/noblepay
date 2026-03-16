/**
 * Treasury Route Integration Tests
 *
 * These tests exercise the real auth middleware (JWT verification, role extraction,
 * RBAC enforcement) against the treasury routes — no mocking of auth/rbac layers.
 *
 * Services (TreasuryService, AuditService) and Prisma are still mocked so we can
 * control proposal state without a live database, but every auth/authz decision
 * flows through the production code paths.
 */

// ─── Mock Logger & Metrics (infrastructure, not auth) ───────────────────────

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
};

jest.mock("../../lib/logger", () => ({
  logger: mockLogger,
  generateCorrelationId: jest.fn().mockReturnValue("int-test-corr-id"),
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
  register: { metrics: jest.fn() },
}));

// ─── Mock Prisma (DB layer only) ────────────────────────────────────────────

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

const mockPrisma: any = {
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
};

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
  BusinessTier: { STARTER: "STARTER", STANDARD: "STANDARD", ENTERPRISE: "ENTERPRISE", INSTITUTIONAL: "INSTITUTIONAL" },
}));

// ─── Mock only services, NOT auth/rbac ──────────────────────────────────────

const mockTreasuryService = {
  getOverview: jest.fn(),
  createProposal: jest.fn(),
  approveProposal: jest.fn(),
  executeProposal: jest.fn(),
  getSpendingPolicies: jest.fn(),
  getYieldStrategies: jest.fn(),
  getAnalytics: jest.fn(),
};

const mockAuditService = { createAuditEntry: jest.fn() };

jest.mock("../../services/treasury", () => {
  const actual = jest.requireActual("../../services/treasury");
  return {
    ...actual,
    TreasuryService: jest.fn(() => mockTreasuryService),
  };
});

jest.mock("../../services/audit", () => ({
  AuditService: jest.fn(() => mockAuditService),
}));

// ─── NOTE: auth.ts and rbac.ts are NOT mocked — real middleware runs ────────

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { generateJWT } from "../../middleware/auth";
import treasuryRouter from "../../routes/treasury";

// ─── App Setup ──────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/treasury", treasuryRouter);
  return app;
}

const JWT_SECRET = "test-secret"; // matches auth.ts fallback in test env

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeExpiredJWT(businessId: string, role: string): string {
  return jwt.sign(
    {
      sub: `user:${businessId}:expired`,
      businessId,
      tier: "STANDARD",
      role,
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
    },
    JWT_SECRET,
  );
}

function makeJWT(
  businessId: string,
  role: string,
  userId?: string,
): string {
  return generateJWT(businessId, "STANDARD" as any, role, userId);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Treasury Integration Tests (real auth/rbac)", () => {
  let app: express.Express;

  beforeAll(() => {
    process.env.NODE_ENV = "test";
    app = buildApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default service stubs so routes don't blow up when auth passes
    mockTreasuryService.getOverview.mockResolvedValue({
      totalAUM: "38700000",
      allocations: {},
      yieldEarned: "0",
      pendingProposals: 0,
      activeStrategies: 0,
      signerCount: 5,
      monthlySpend: {},
    });
    mockTreasuryService.getSpendingPolicies.mockReturnValue([]);
    mockTreasuryService.getYieldStrategies.mockReturnValue([]);
    mockTreasuryService.getAnalytics.mockResolvedValue({});
  });

  // ─── 1. Missing Authorization header => 401 ──────────────────────────────

  describe("Missing / invalid credentials", () => {
    it("should return 401 when no Authorization header is present", async () => {
      const res = await request(app).get("/v1/treasury/overview");

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("UNAUTHORIZED");
    });

    it("should return 401 when Authorization header has no Bearer prefix", async () => {
      const res = await request(app)
        .get("/v1/treasury/overview")
        .set("Authorization", "Basic abc123");

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("UNAUTHORIZED");
    });

    it("should return 401 when JWT is expired", async () => {
      const expiredToken = makeExpiredJWT("biz-1", "ADMIN");

      const res = await request(app)
        .get("/v1/treasury/overview")
        .set("Authorization", `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("UNAUTHORIZED");
    });

    it("should return 401 when JWT is signed with wrong secret", async () => {
      const badToken = jwt.sign(
        { sub: "user:biz-1:bad", businessId: "biz-1", tier: "STANDARD", role: "ADMIN" },
        "wrong-secret-key",
        { expiresIn: "1h" },
      );

      const res = await request(app)
        .get("/v1/treasury/overview")
        .set("Authorization", `Bearer ${badToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("UNAUTHORIZED");
    });

    it("should return 401 when Bearer token is garbage", async () => {
      const res = await request(app)
        .get("/v1/treasury/overview")
        .set("Authorization", "Bearer not.a.real.token.at.all");

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("UNAUTHORIZED");
    });
  });

  // ─── 2. Role downgrade: VIEWER cannot do treasury write ops => 403 ────────

  describe("RBAC enforcement (role downgrade)", () => {
    it("VIEWER should be allowed treasury:read (GET /overview)", async () => {
      const token = makeJWT("biz-viewer", "VIEWER");

      const res = await request(app)
        .get("/v1/treasury/overview")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("VIEWER should be denied proposal creation (POST /proposals) => 403", async () => {
      const token = makeJWT("biz-viewer", "VIEWER");

      const res = await request(app)
        .post("/v1/treasury/proposals")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "Test", description: "Nope", type: "TRANSFER", amount: "100" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("VIEWER should be denied proposal approval => 403", async () => {
      const token = makeJWT("biz-viewer", "VIEWER");

      const res = await request(app)
        .post("/v1/treasury/proposals/prop-1/approve")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("VIEWER should be denied proposal execution => 403", async () => {
      const token = makeJWT("biz-viewer", "VIEWER");

      const res = await request(app)
        .post("/v1/treasury/proposals/prop-1/execute")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("ANALYST should be denied proposal creation => 403", async () => {
      const token = makeJWT("biz-analyst", "ANALYST");

      const res = await request(app)
        .post("/v1/treasury/proposals")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "Test", description: "Nope", type: "TRANSFER" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("OPERATOR should be denied proposal creation => 403", async () => {
      const token = makeJWT("biz-op", "OPERATOR");

      const res = await request(app)
        .post("/v1/treasury/proposals")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "Test", description: "Nope", type: "TRANSFER" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });
  });

  // ─── 3. Wrong tenant accessing another's proposal => 403 ─────────────────

  describe("Cross-tenant isolation", () => {
    it("should return 403 when tenant B tries to approve tenant A proposal", async () => {
      const tokenTenantB = makeJWT("biz-tenant-b", "ADMIN");

      mockTreasuryService.approveProposal.mockRejectedValue(
        new (jest.requireActual("../../services/treasury").TreasuryError)(
          "FORBIDDEN",
          "You do not have permission to approve this proposal",
          403,
        ),
      );

      const res = await request(app)
        .post("/v1/treasury/proposals/prop-tenant-a/approve")
        .set("Authorization", `Bearer ${tokenTenantB}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("should return 403 when tenant B tries to execute tenant A proposal", async () => {
      const tokenTenantB = makeJWT("biz-tenant-b", "ADMIN");

      mockTreasuryService.executeProposal.mockRejectedValue(
        new (jest.requireActual("../../services/treasury").TreasuryError)(
          "FORBIDDEN",
          "You do not have permission to execute this proposal",
          403,
        ),
      );

      const res = await request(app)
        .post("/v1/treasury/proposals/prop-tenant-a/execute")
        .set("Authorization", `Bearer ${tokenTenantB}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });
  });

  // ─── 4. Expired proposal => appropriate error ─────────────────────────────

  describe("Proposal lifecycle errors", () => {
    it("should return 409 when approving an expired proposal", async () => {
      const token = makeJWT("biz-1", "ADMIN");

      mockTreasuryService.approveProposal.mockRejectedValue(
        new (jest.requireActual("../../services/treasury").TreasuryError)(
          "PROPOSAL_EXPIRED",
          "Proposal has expired and can no longer be approved",
          409,
        ),
      );

      const res = await request(app)
        .post("/v1/treasury/proposals/prop-expired/approve")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("PROPOSAL_EXPIRED");
    });

    it("should return 409 when executing a PENDING (not yet approved) proposal", async () => {
      const token = makeJWT("biz-1", "ADMIN");

      mockTreasuryService.executeProposal.mockRejectedValue(
        new (jest.requireActual("../../services/treasury").TreasuryError)(
          "INVALID_STATE",
          "Proposal is in PENDING state, expected APPROVED",
          409,
        ),
      );

      const res = await request(app)
        .post("/v1/treasury/proposals/prop-pending/execute")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("INVALID_STATE");
    });

    it("should return 409 when proposal has insufficient approvals", async () => {
      const token = makeJWT("biz-1", "ADMIN");

      mockTreasuryService.executeProposal.mockRejectedValue(
        new (jest.requireActual("../../services/treasury").TreasuryError)(
          "INSUFFICIENT_APPROVALS",
          "Proposal requires 2 approvals but has 1",
          409,
        ),
      );

      const res = await request(app)
        .post("/v1/treasury/proposals/prop-underapproved/execute")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("INSUFFICIENT_APPROVALS");
    });
  });

  // ─── 5. Missing signer identity (signerId) on approve/execute => 401 ─────

  describe("Signer identity enforcement", () => {
    // The route itself checks req.signerId; with a valid JWT, signerId is always
    // set from decoded.sub. To test the "no signerId" path, we need a token that
    // passes JWT verification but has no sub — which jwt.sign will always include.
    // Instead, we test via API key path where the key is not found (401).
    // The route-level signerId check is a defense-in-depth measure.

    it("should return 401 when API key is invalid (no signerId established)", async () => {
      // Use a non-JWT bearer token that also fails API key lookup
      mockPrisma.aPIKey.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .post("/v1/treasury/proposals/prop-1/approve")
        .set("Authorization", "Bearer npk_0000000000000000000000000000000000000000000000000000000000000000");

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("UNAUTHORIZED");
    });
  });

  // ─── 6. Happy path: create => approve => execute with real JWT auth ───────

  describe("Happy path: full proposal lifecycle", () => {
    it("ADMIN can create a proposal", async () => {
      const token = makeJWT("biz-happy", "ADMIN", "admin-user-1");

      mockTreasuryService.createProposal.mockResolvedValue({
        id: "prop-happy-1",
        title: "Q2 Budget",
        type: "BUDGET_ALLOCATION",
        status: "PENDING",
        requiredApprovals: 2,
        currentApprovals: 0,
      });

      const res = await request(app)
        .post("/v1/treasury/proposals")
        .set("Authorization", `Bearer ${token}`)
        .send({
          title: "Q2 Budget",
          description: "Allocate Q2 operational budget",
          type: "BUDGET_ALLOCATION",
          amount: "5000",
          category: "OPERATIONS",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe("prop-happy-1");
      expect(res.body.data.status).toBe("PENDING");

      // Verify the service was called with the correct businessId from JWT
      expect(mockTreasuryService.createProposal).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Q2 Budget" }),
        "biz-happy",  // businessId from JWT passed as proposer
        "biz-happy",  // businessId from JWT
      );
    });

    it("TREASURY_MANAGER can create a proposal", async () => {
      const token = makeJWT("biz-happy", "TREASURY_MANAGER", "tm-user-1");

      mockTreasuryService.createProposal.mockResolvedValue({
        id: "prop-happy-2",
        status: "PENDING",
      });

      const res = await request(app)
        .post("/v1/treasury/proposals")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "Transfer", description: "Move funds", type: "TRANSFER", amount: "1000" });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it("ADMIN can approve a proposal and signerId flows through", async () => {
      const signerId = "admin-approver-1";
      const token = makeJWT("biz-happy", "ADMIN", signerId);

      mockTreasuryService.approveProposal.mockResolvedValue({
        approved: false,
        remainingApprovals: 1,
        status: "PENDING",
      });

      const res = await request(app)
        .post("/v1/treasury/proposals/prop-happy-1/approve")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.remainingApprovals).toBe(1);

      // Verify signerId from JWT sub was passed to the service
      expect(mockTreasuryService.approveProposal).toHaveBeenCalledWith(
        "prop-happy-1",
        signerId,       // signerId derived from JWT sub
        "biz-happy",    // businessId from JWT
      );
    });

    it("second ADMIN approval moves proposal to APPROVED", async () => {
      const signerId = "admin-approver-2";
      const token = makeJWT("biz-happy", "ADMIN", signerId);

      mockTreasuryService.approveProposal.mockResolvedValue({
        approved: true,
        remainingApprovals: 0,
        status: "APPROVED",
      });

      const res = await request(app)
        .post("/v1/treasury/proposals/prop-happy-1/approve")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("APPROVED");
      expect(res.body.data.approved).toBe(true);
    });

    it("ADMIN can execute an approved proposal", async () => {
      const token = makeJWT("biz-happy", "ADMIN", "admin-executor-1");

      mockTreasuryService.executeProposal.mockResolvedValue({
        success: true,
        txHash: "0xabcdef1234567890",
      });

      const res = await request(app)
        .post("/v1/treasury/proposals/prop-happy-1/execute")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.success).toBe(true);
      expect(res.body.data.txHash).toBe("0xabcdef1234567890");

      expect(mockTreasuryService.executeProposal).toHaveBeenCalledWith(
        "prop-happy-1",
        "admin-executor-1",
        "biz-happy",
      );
    });
  });

  // ─── 7. Read-only endpoints with valid JWT ────────────────────────────────

  describe("Read endpoints with valid auth", () => {
    it("GET /policies returns data with valid JWT", async () => {
      const token = makeJWT("biz-read", "ADMIN");
      mockTreasuryService.getSpendingPolicies.mockReturnValue([
        { category: "OPERATIONS", dailyLimit: "50000" },
      ]);

      const res = await request(app)
        .get("/v1/treasury/policies")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("GET /yield returns data with valid JWT", async () => {
      const token = makeJWT("biz-read", "ADMIN");
      mockTreasuryService.getYieldStrategies.mockReturnValue([
        { id: "ys-001", protocol: "Staking", currentAPY: 8.5 },
      ]);

      const res = await request(app)
        .get("/v1/treasury/yield")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it("GET /analytics returns data with valid JWT", async () => {
      const token = makeJWT("biz-read", "ADMIN");
      mockTreasuryService.getAnalytics.mockResolvedValue({
        totalInflows: "2450000",
        period: "month",
      });

      const res = await request(app)
        .get("/v1/treasury/analytics?period=month")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalInflows).toBe("2450000");
    });

    it("VIEWER can read policies (treasury:read permission)", async () => {
      const token = makeJWT("biz-read", "VIEWER");
      mockTreasuryService.getSpendingPolicies.mockReturnValue([]);

      const res = await request(app)
        .get("/v1/treasury/policies")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
    });

    it("VIEWER can read yield strategies", async () => {
      const token = makeJWT("biz-read", "VIEWER");
      mockTreasuryService.getYieldStrategies.mockReturnValue([]);

      const res = await request(app)
        .get("/v1/treasury/yield")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
    });

    it("VIEWER can read analytics", async () => {
      const token = makeJWT("biz-read", "VIEWER");
      mockTreasuryService.getAnalytics.mockResolvedValue({});

      const res = await request(app)
        .get("/v1/treasury/analytics")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
    });
  });

  // ─── 8. COMPLIANCE_OFFICER lacks treasury write roles ─────────────────────

  describe("Role boundary: COMPLIANCE_OFFICER", () => {
    it("COMPLIANCE_OFFICER should be denied proposal creation => 403", async () => {
      const token = makeJWT("biz-co", "COMPLIANCE_OFFICER");

      const res = await request(app)
        .post("/v1/treasury/proposals")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "Test", description: "No", type: "TRANSFER" });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("FORBIDDEN");
    });

    it("COMPLIANCE_OFFICER should be denied proposal approval => 403", async () => {
      const token = makeJWT("biz-co", "COMPLIANCE_OFFICER");

      const res = await request(app)
        .post("/v1/treasury/proposals/prop-1/approve")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(403);
    });
  });
});
