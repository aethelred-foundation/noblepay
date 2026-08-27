import {
  createMockPrisma,
  resetAllMocks,
  VALID_BYTES32,
  VALID_ETH_ADDRESS,
} from "../setup";

const mockPrisma = createMockPrisma();
const mockRegistrationService = { register: jest.fn() };
const mockReconciliationService = {
  reconcileVerification: jest.fn(),
  reconcileTierUpgrade: jest.fn(),
  reconcileSuspension: jest.fn(),
  reconcileReinstatement: jest.fn(),
  reconcileRevocation: jest.fn(),
  getOnChainLimits: jest.fn(),
};
let ownershipAllowed = true;

jest.mock("../../lib/db", () => ({ prisma: mockPrisma }));
jest.mock("../../services/audit", () => ({ AuditService: jest.fn() }));
jest.mock("../../services/business-registration", () => {
  class BusinessRegistrationError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  }
  return {
    BusinessRegistrationService: jest.fn(() => mockRegistrationService),
    BusinessRegistrationError,
  };
});
jest.mock("../../services/business-reconciliation", () => {
  class BusinessReconciliationError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode = 400,
    ) {
      super(message);
    }
  }
  return {
    BusinessReconciliationService: jest.fn(() => mockReconciliationService),
    BusinessReconciliationError,
  };
});
jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: (req: any, _res: unknown, next: () => void) => {
    req.businessId = req.headers["x-test-business-id"] || "biz-1";
    req.signerId = "0x1111111111111111111111111111111111111111";
    next();
  },
  createPublicRateLimit:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
}));
jest.mock("../../middleware/validation", () => ({
  validate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  CreateBusinessSchema: {},
  UpdateBusinessSchema: {},
  ListBusinessesSchema: {},
  BusinessVerificationSchema: {},
  BusinessTierUpgradeSchema: {},
}));
jest.mock("../../middleware/rbac", () => ({
  extractRole: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireCurrentPlatformAdmin: (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next(),
  revalidatePlatformAdmin: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  requireOwnership: () => ownershipAllowed,
}));

import express from "express";
import request from "supertest";
import router from "../../routes/businesses";
import { BusinessRegistrationError } from "../../services/business-registration";
import { BusinessReconciliationError } from "../../services/business-reconciliation";

const app = express();
app.use(express.json());
app.use("/v1/businesses", router);

function business(overrides: Record<string, unknown> = {}) {
  return {
    id: "biz-1",
    address: VALID_ETH_ADDRESS,
    licenseNumber: "DMCC-12345",
    businessName: "Noble Merchant",
    jurisdiction: "UAE",
    businessType: "Payments",
    complianceOfficer: "0x2222222222222222222222222222222222222222",
    contactEmail: "ops@noble.test",
    kycStatus: "PENDING",
    tier: "STANDARD",
    dailyLimit: { toString: () => "50000" },
    monthlyLimit: { toString: () => "500000" },
    registrationBlockNumber: 99n,
    registeredAt: new Date("2026-07-21T00:00:00.000Z"),
    ...overrides,
  };
}

describe("business routes", () => {
  beforeEach(() => {
    resetAllMocks();
    ownershipAllowed = true;
  });

  it("persists a newly reconciled registration and serializes chain values", async () => {
    mockRegistrationService.register.mockResolvedValue({
      business: business(),
      apiKey: "npk_secret-returned-once",
      replayed: false,
      confirmations: 3,
      chainId: "7332",
    });

    const response = await request(app).post("/v1/businesses").send({
      address: VALID_ETH_ADDRESS,
      txHash: VALID_BYTES32,
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      business: {
        id: "biz-1",
        dailyLimit: "50000",
        monthlyLimit: "500000",
        registrationBlockNumber: "99",
      },
      replayed: false,
      confirmations: 3,
      chainId: "7332",
    });
  });

  it("returns 200 for an idempotently replayed registration", async () => {
    mockRegistrationService.register.mockResolvedValue({
      business: business(),
      apiKey: "",
      replayed: true,
      confirmations: 3,
      chainId: "7332",
    });
    const response = await request(app).post("/v1/businesses").send({});
    expect(response.status).toBe(200);
    expect(response.body.data.replayed).toBe(true);
  });

  it("preserves registration verification errors", async () => {
    mockRegistrationService.register.mockRejectedValue(
      new BusinessRegistrationError("INVALID_SIGNATURE", "bad signature", 401),
    );
    const response = await request(app).post("/v1/businesses").send({});
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("INVALID_SIGNATURE");
  });

  it("lists serialized businesses with bounded defaults", async () => {
    mockPrisma.business.findMany.mockResolvedValue([business()]);
    mockPrisma.business.count.mockResolvedValue(1);
    const response = await request(app).get("/v1/businesses");
    expect(response.status).toBe(200);
    expect(response.body.data[0].dailyLimit).toBe("50000");
    expect(response.body.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
    expect(mockPrisma.business.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 20,
      }),
    );
  });

  it("returns an owned business and conceals unauthorized records", async () => {
    mockPrisma.business.findUnique.mockResolvedValue(business({ apiKeys: [] }));
    const owned = await request(app).get("/v1/businesses/biz-1");
    expect(owned.status).toBe(200);

    ownershipAllowed = false;
    const foreign = await request(app)
      .get("/v1/businesses/biz-2")
      .set("x-test-business-id", "biz-1");
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe("FORBIDDEN");
  });

  it("updates only the authenticated tenant's off-chain profile", async () => {
    mockPrisma.business.findUnique.mockResolvedValue(business());
    mockPrisma.business.update.mockResolvedValue(
      business({ contactEmail: "new@noble.test" }),
    );
    const response = await request(app)
      .patch("/v1/businesses/biz-1")
      .send({ contactEmail: "new@noble.test" });
    expect(response.status).toBe(200);
    expect(mockPrisma.business.update).toHaveBeenCalledWith({
      where: { id: "biz-1" },
      data: { contactEmail: "new@noble.test" },
    });

    const denied = await request(app)
      .patch("/v1/businesses/biz-2")
      .send({ contactEmail: "x@noble.test" });
    expect(denied.status).toBe(403);
  });

  it("reconciles verification from an exact chain transaction", async () => {
    mockReconciliationService.reconcileVerification.mockResolvedValue({
      business: business({ kycStatus: "VERIFIED" }),
      replayed: false,
      txHash: VALID_BYTES32,
      confirmations: 4,
      chainId: "7332",
    });
    mockPrisma.business.count.mockResolvedValue(5);

    const response = await request(app)
      .post("/v1/businesses/biz-1/verify")
      .send({ txHash: VALID_BYTES32 });

    expect(response.status).toBe(200);
    expect(
      mockReconciliationService.reconcileVerification,
    ).toHaveBeenCalledWith("biz-1", VALID_BYTES32);
    expect(response.body.data.business.kycStatus).toBe("VERIFIED");
  });

  it("allows a platform admin to reconcile another tenant's verification", async () => {
    ownershipAllowed = false;
    const response = await request(app)
      .post("/v1/businesses/biz-2/verify")
      .set("x-test-business-id", "biz-1")
      .send({ txHash: VALID_BYTES32 });

    expect(response.status).toBe(200);
    expect(
      mockReconciliationService.reconcileVerification,
    ).toHaveBeenCalledWith("biz-2", VALID_BYTES32);
  });

  it.each([
    ["suspend", "reconcileSuspension", "SUSPENDED"],
    ["reinstate", "reconcileReinstatement", "VERIFIED"],
    ["revoke", "reconcileRevocation", "REVOKED"],
  ] as const)(
    "reconciles the %s lifecycle transaction",
    async (path, method, status) => {
      mockReconciliationService[method].mockResolvedValue({
        business: business({ kycStatus: status }),
        replayed: false,
        txHash: VALID_BYTES32,
        confirmations: 4,
        chainId: "7332",
      });
      const response = await request(app)
        .post(`/v1/businesses/biz-1/${path}`)
        .send({ txHash: VALID_BYTES32 });
      expect(response.status).toBe(200);
      expect(mockReconciliationService[method]).toHaveBeenCalledWith(
        "biz-1",
        VALID_BYTES32,
      );
      expect(response.body.data.business.kycStatus).toBe(status);
    },
  );

  it("reconciles a tier upgrade from chain evidence", async () => {
    mockReconciliationService.reconcileTierUpgrade.mockResolvedValue({
      business: business({ tier: "PREMIUM" }),
      replayed: false,
      txHash: VALID_BYTES32,
      confirmations: 4,
      chainId: "7332",
    });
    const response = await request(app)
      .post("/v1/businesses/biz-1/upgrade")
      .send({ newTier: "PREMIUM", txHash: VALID_BYTES32 });
    expect(response.status).toBe(200);
    expect(mockReconciliationService.reconcileTierUpgrade).toHaveBeenCalledWith(
      "biz-1",
      "PREMIUM",
      VALID_BYTES32,
    );
  });

  it("allows a platform admin to reconcile another tenant's tier", async () => {
    ownershipAllowed = false;
    const response = await request(app)
      .post("/v1/businesses/biz-2/upgrade")
      .set("x-test-business-id", "biz-1")
      .send({ newTier: "PREMIUM", txHash: VALID_BYTES32 });

    expect(response.status).toBe(200);
    expect(mockReconciliationService.reconcileTierUpgrade).toHaveBeenCalledWith(
      "biz-2",
      "PREMIUM",
      VALID_BYTES32,
    );
  });

  it("returns verified on-chain limits only to the owner", async () => {
    mockReconciliationService.getOnChainLimits.mockResolvedValue({
      tier: "STANDARD",
      source: "onchain",
    });
    const response = await request(app).get("/v1/businesses/biz-1/limits");
    expect(response.status).toBe(200);
    expect(response.body.data.source).toBe("onchain");

    ownershipAllowed = false;
    const denied = await request(app).get("/v1/businesses/biz-2/limits");
    expect(denied.status).toBe(403);
  });

  it("preserves reconciliation errors", async () => {
    mockReconciliationService.reconcileVerification.mockRejectedValue(
      new BusinessReconciliationError(
        "WRONG_REGISTRY_CONTRACT",
        "wrong contract",
        422,
      ),
    );
    const response = await request(app)
      .post("/v1/businesses/biz-1/verify")
      .send({ txHash: VALID_BYTES32 });
    expect(response.status).toBe(422);
    expect(response.body.error).toBe("WRONG_REGISTRY_CONTRACT");
  });
});
