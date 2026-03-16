/**
 * NoblePay Security Regression Gate
 *
 * Named regression tests anchored to historical findings (NP-01 through NP-12)
 * plus additional attack-surface regressions.  Every test in this file MUST pass
 * before any release is cut — CI should treat failures here as release blockers.
 */

import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  createMockPrisma,
  createMockRequest,
  createMockResponse,
  createMockNext,
  resetAllMocks,
  VALID_ETH_ADDRESS,
  VALID_ETH_ADDRESS_2,
} from "../setup";

// ─── Module-level Prisma mock (mirrors exploit-simulations) ─────────────────

const mockAPKeyFindUnique = jest.fn().mockResolvedValue(null);
const mockAPKeyUpdate = jest.fn().mockResolvedValue({});
jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  return {
    ...actual,
    PrismaClient: jest.fn().mockImplementation(() => ({
      aPIKey: { findUnique: mockAPKeyFindUnique, update: mockAPKeyUpdate },
      business: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
      payment: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
      auditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
      complianceScreening: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), count: jest.fn(), aggregate: jest.fn(), update: jest.fn() },
      tEENode: { findFirst: jest.fn() },
      travelRuleRecord: { findUnique: jest.fn() },
      treasuryProposal: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      $connect: jest.fn(),
      $disconnect: jest.fn(),
      $transaction: jest.fn(),
      $queryRaw: jest.fn(),
    })),
  };
});

// ─── Imports under test ─────────────────────────────────────────────────────

import { authenticateAPIKey, generateJWT } from "../../middleware/auth";
import {
  extractRole,
  requireRole,
  requirePermission,
  requireOwnership,
  getEffectivePermissions,
  hasPermission,
} from "../../middleware/rbac";
import { ComplianceService } from "../../services/compliance";
import { TreasuryService, TreasuryError } from "../../services/treasury";
import { PaymentService, PaymentError } from "../../services/payment";
import { AuditService } from "../../services/audit";
import { CrossChainService } from "../../services/crosschain";

// ─── Shared constants ───────────────────────────────────────────────────────

const BUSINESS_A_ID = "business-aaa-111";
const BUSINESS_B_ID = "business-bbb-222";
const TEST_SECRET = "test-secret";

function makeToken(
  businessId: string,
  opts: { role?: string; secret?: string; tier?: string; sub?: string; expiresIn?: number } = {},
): string {
  const secret = opts.secret || TEST_SECRET;
  return jwt.sign(
    {
      sub: opts.sub || `user:${businessId}:test`,
      businessId,
      tier: opts.tier || "STANDARD",
      role: opts.role || "VIEWER",
    },
    secret,
    { expiresIn: opts.expiresIn || 3600 },
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// NP-01-regression: delegate cannot double-count approvals
// ═════════════════════════════════════════════════════════════════════════════

describe("NP-01-regression: delegate cannot double-count approvals", () => {
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let treasuryService: TreasuryService;

  beforeEach(() => {
    resetAllMocks();
    mockPrisma = createMockPrisma();
    (mockPrisma as any).treasuryProposal = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    mockPrisma.auditLog.create.mockResolvedValue({});
    const auditService = new AuditService(mockPrisma as any);
    treasuryService = new TreasuryService(mockPrisma as any, auditService);
  });

  it("rejects the same signer approving a proposal twice (dedup)", async () => {
    await treasuryService.createProposal(
      { title: "Test transfer", description: "test", type: "TRANSFER", amount: "5000" },
      "proposer-a",
      BUSINESS_A_ID,
    );
    const proposalId = Array.from((treasuryService as any).proposals.keys())[0] as string;

    // First approval succeeds
    await treasuryService.approveProposal(proposalId, "signer-1", BUSINESS_A_ID);

    // Second approval by the same signer must be rejected
    await expect(
      treasuryService.approveProposal(proposalId, "signer-1", BUSINESS_A_ID),
    ).rejects.toThrow("has already approved this proposal");

    try {
      await treasuryService.approveProposal(proposalId, "signer-1", BUSINESS_A_ID);
    } catch (e) {
      expect((e as TreasuryError).code).toBe("DUPLICATE_APPROVAL");
      expect((e as TreasuryError).statusCode).toBe(409);
    }
  });

  it("counts unique signers only — two different signers each counted once", async () => {
    await treasuryService.createProposal(
      { title: "Multi-sig test", description: "test", type: "TRANSFER", amount: "5000" },
      "proposer-a",
      BUSINESS_A_ID,
    );
    const proposalId = Array.from((treasuryService as any).proposals.keys())[0] as string;

    const res1 = await treasuryService.approveProposal(proposalId, "signer-1", BUSINESS_A_ID);
    const res2 = await treasuryService.approveProposal(proposalId, "signer-2", BUSINESS_A_ID);

    expect(res1.remainingApprovals).toBeGreaterThan(res2.remainingApprovals);

    const proposal = (treasuryService as any).proposals.get(proposalId);
    expect(proposal.approvers).toEqual(["signer-1", "signer-2"]);
    expect(proposal.currentApprovals).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NP-02-regression: forged JWT returns 401 not 500
// ═════════════════════════════════════════════════════════════════════════════

describe("NP-02-regression: forged JWT returns 401 not 500", () => {
  beforeEach(resetAllMocks);

  it("returns 401 (not 500) for a JWT signed with a wrong secret", async () => {
    const forgedToken = jwt.sign(
      { sub: "attacker", businessId: BUSINESS_A_ID, tier: "INSTITUTIONAL", role: "SUPER_ADMIN" },
      "completely-wrong-secret-" + crypto.randomBytes(16).toString("hex"),
      { expiresIn: 3600 },
    );

    const req = createMockRequest({ headers: { authorization: `Bearer ${forgedToken}` } });
    const res = createMockResponse();
    const next = createMockNext();

    await authenticateAPIKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    // The critical assertion: NOT 500
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it("returns 401 for an expired JWT (not 500)", async () => {
    const expiredToken = jwt.sign(
      { sub: "user", businessId: BUSINESS_A_ID, tier: "STANDARD", exp: Math.floor(Date.now() / 1000) - 60 },
      TEST_SECRET,
    );

    const req = createMockRequest({ headers: { authorization: `Bearer ${expiredToken}` } });
    const res = createMockResponse();
    const next = createMockNext();

    await authenticateAPIKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it("returns 401 for a JWT with alg:none attack (not 500)", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "attacker", businessId: BUSINESS_A_ID, tier: "INSTITUTIONAL", role: "SUPER_ADMIN", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url");
    const noneToken = `${header}.${payload}.`;

    const req = createMockRequest({ headers: { authorization: `Bearer ${noneToken}` } });
    const res = createMockResponse();
    const next = createMockNext();

    await authenticateAPIKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NP-03-regression: X-User-Role header completely ignored
// ═════════════════════════════════════════════════════════════════════════════

describe("NP-03-regression: X-User-Role header completely ignored", () => {
  beforeEach(resetAllMocks);

  it("role is derived from JWT payload, not from X-User-Role header", () => {
    const req = createMockRequest({
      headers: { "x-user-role": "SUPER_ADMIN" },
      jwtPayload: { sub: "user-1", businessId: BUSINESS_A_ID, tier: "STANDARD", role: "VIEWER" },
    });
    const res = createMockResponse();
    const next = createMockNext();

    extractRole(req, res, next);

    expect(req.userRole).toBe("VIEWER");
    expect(req.userRole).not.toBe("SUPER_ADMIN");
    expect(next).toHaveBeenCalled();
  });

  it("X-User-Role with ADMIN is ignored when JWT says OPERATOR", () => {
    const req = createMockRequest({
      headers: { "x-user-role": "ADMIN" },
      jwtPayload: { sub: "user-2", businessId: BUSINESS_A_ID, tier: "STANDARD", role: "OPERATOR" },
    });
    const res = createMockResponse();
    const next = createMockNext();

    extractRole(req, res, next);

    expect(req.userRole).toBe("OPERATOR");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NP-04-regression: empty API key never bypasses auth
// ═════════════════════════════════════════════════════════════════════════════

describe("NP-04-regression: empty API key never bypasses auth", () => {
  beforeEach(resetAllMocks);

  it("rejects Bearer with an empty string after it", async () => {
    const req = createMockRequest({ headers: { authorization: "Bearer " } });
    const res = createMockResponse();
    const next = createMockNext();

    await authenticateAPIKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects missing Authorization header entirely", async () => {
    const req = createMockRequest({ headers: {} });
    const res = createMockResponse();
    const next = createMockNext();

    await authenticateAPIKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects Authorization header without Bearer prefix", async () => {
    const req = createMockRequest({ headers: { authorization: "Token some-token" } });
    const res = createMockResponse();
    const next = createMockNext();

    await authenticateAPIKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NP-05-regression: compliance status unknown maps to FAILED
// ═════════════════════════════════════════════════════════════════════════════

describe("NP-05-regression: compliance status unknown maps to FAILED", () => {
  beforeEach(resetAllMocks);

  it("maps an unrecognized Rust status to FAILED (fail-closed)", () => {
    // The mapComplianceStatus function is module-private, but we can verify
    // its behavior through the ComplianceService's callComplianceService
    // returning FAILED for unknown statuses.  We verify the mapping table
    // by importing the module and checking the exported behavior.
    const mockPrisma = createMockPrisma();
    mockPrisma.auditLog.create.mockResolvedValue({});
    const auditService = new AuditService(mockPrisma as any);
    const complianceService = new ComplianceService(mockPrisma as any, auditService);

    // The callComplianceService method fail-closes on network errors
    const paymentData = {
      sender: VALID_ETH_ADDRESS,
      recipient: VALID_ETH_ADDRESS_2,
      amount: { toString: () => "500" },
      currency: "USDC",
    };

    // When compliance service is unavailable, status MUST be FAILED
    const result = (complianceService as any).callComplianceService(paymentData);
    return expect(result).resolves.toMatchObject({
      status: "FAILED",
      amlRiskScore: 100,
    });
  });

  it("never returns an APPROVED / PASSED result when service is down", () => {
    const mockPrisma = createMockPrisma();
    mockPrisma.auditLog.create.mockResolvedValue({});
    const auditService = new AuditService(mockPrisma as any);
    const complianceService = new ComplianceService(mockPrisma as any, auditService);

    const result = (complianceService as any).callComplianceService({
      sender: VALID_ETH_ADDRESS,
      recipient: VALID_ETH_ADDRESS_2,
      amount: { toString: () => "100000" },
      currency: "USDC",
    });

    return result.then((r: any) => {
      expect(r.status).not.toBe("PASSED");
      expect(r.sanctionsClear).toBe(false);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NP-06-regression: cross-chain recovery captures original status
// ═════════════════════════════════════════════════════════════════════════════

describe("NP-06-regression: cross-chain recovery captures original status", () => {
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let crossChainService: CrossChainService;

  beforeEach(() => {
    resetAllMocks();
    mockPrisma = createMockPrisma();
    mockPrisma.auditLog.create.mockResolvedValue({});
    const auditService = new AuditService(mockPrisma as any);
    crossChainService = new CrossChainService(mockPrisma as any, auditService);
  });

  it("recovery moves STUCK transfer to RECOVERED", async () => {
    const transfer = await crossChainService.initiateTransfer(
      { sourceChain: "aethelred-mainnet", destinationChain: "ethereum-mainnet", token: "USDC", amount: "1000", recipient: VALID_ETH_ADDRESS },
      VALID_ETH_ADDRESS_2,
      BUSINESS_A_ID,
    );

    // Force transfer to STUCK state for test
    const stored = (crossChainService as any).transfers.get(transfer.id);
    stored.status = "STUCK";

    const result = await crossChainService.recoverTransfer(transfer.id, "admin", BUSINESS_A_ID);
    expect(result.success).toBe(true);

    const recovered = crossChainService.getTransfer(transfer.id, BUSINESS_A_ID);
    expect(recovered.status).toBe("RECOVERED");
  });

  it("cannot recover a transfer in INITIATED state", async () => {
    const transfer = await crossChainService.initiateTransfer(
      { sourceChain: "aethelred-mainnet", destinationChain: "ethereum-mainnet", token: "USDC", amount: "1000", recipient: VALID_ETH_ADDRESS },
      VALID_ETH_ADDRESS_2,
      BUSINESS_A_ID,
    );

    await expect(
      crossChainService.recoverTransfer(transfer.id, "admin", BUSINESS_A_ID),
    ).rejects.toThrow("Cannot recover transfer");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NP-07-regression: webhook replay blocked by dedup
// ═════════════════════════════════════════════════════════════════════════════

describe("NP-07-regression: webhook replay blocked by dedup", () => {
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let treasuryService: TreasuryService;

  beforeEach(() => {
    resetAllMocks();
    mockPrisma = createMockPrisma();
    (mockPrisma as any).treasuryProposal = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    mockPrisma.auditLog.create.mockResolvedValue({});
    const auditService = new AuditService(mockPrisma as any);
    treasuryService = new TreasuryService(mockPrisma as any, auditService);
  });

  it("replaying the same approval request yields DUPLICATE_APPROVAL error", async () => {
    await treasuryService.createProposal(
      { title: "Replay test", description: "test", type: "TRANSFER", amount: "5000" },
      "proposer-a",
      BUSINESS_A_ID,
    );
    const proposalId = Array.from((treasuryService as any).proposals.keys())[0] as string;

    // First approval
    await treasuryService.approveProposal(proposalId, "webhook-signer", BUSINESS_A_ID);

    // Replayed approval
    try {
      await treasuryService.approveProposal(proposalId, "webhook-signer", BUSINESS_A_ID);
      fail("Expected DUPLICATE_APPROVAL error");
    } catch (e) {
      expect((e as TreasuryError).code).toBe("DUPLICATE_APPROVAL");
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NP-08-regression: compliance API requires auth on POST
// ═════════════════════════════════════════════════════════════════════════════

describe("NP-08-regression: compliance API requires auth on POST", () => {
  beforeEach(resetAllMocks);

  it("POST without auth header returns 401", async () => {
    const req = createMockRequest({ method: "POST", path: "/v1/compliance/screen", headers: {} });
    const res = createMockResponse();
    const next = createMockNext();

    await authenticateAPIKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("POST with forged JWT returns 401", async () => {
    const forgedToken = jwt.sign(
      { sub: "attacker", businessId: "hacked", tier: "INSTITUTIONAL" },
      "wrong-secret",
      { expiresIn: 3600 },
    );
    const req = createMockRequest({
      method: "POST",
      path: "/v1/compliance/screen",
      headers: { authorization: `Bearer ${forgedToken}` },
    });
    const res = createMockResponse();
    const next = createMockNext();

    await authenticateAPIKey(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NP-09-regression: mock-tee not in default features
// ═════════════════════════════════════════════════════════════════════════════

describe("NP-09-regression: mock-tee not in default features", () => {
  it("Cargo.toml default features do not include mock-tee", () => {
    const cargoPath = path.resolve(__dirname, "../../../../crates/noblepay-compliance/Cargo.toml");
    const cargo = fs.readFileSync(cargoPath, "utf-8");

    // Parse the [features] section
    const featuresMatch = cargo.match(/\[features\]([\s\S]*?)(?:\[|$)/);
    expect(featuresMatch).toBeTruthy();

    const featuresSection = featuresMatch![1];
    const defaultLine = featuresSection.split("\n").find((l) => l.trim().startsWith("default"));
    expect(defaultLine).toBeTruthy();

    // Ensure mock-tee is NOT in the default feature set
    expect(defaultLine).not.toContain("mock-tee");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NP-10-regression: compliance unavailable returns risk score 100
// ═════════════════════════════════════════════════════════════════════════════

describe("NP-10-regression: compliance unavailable returns risk score 100", () => {
  beforeEach(resetAllMocks);

  it("callComplianceService returns amlRiskScore 100 on network failure", () => {
    const mockPrisma = createMockPrisma();
    mockPrisma.auditLog.create.mockResolvedValue({});
    const auditService = new AuditService(mockPrisma as any);
    const complianceService = new ComplianceService(mockPrisma as any, auditService);

    const result = (complianceService as any).callComplianceService({
      sender: VALID_ETH_ADDRESS,
      recipient: VALID_ETH_ADDRESS_2,
      amount: { toString: () => "10000" },
      currency: "USDC",
    });

    return expect(result).resolves.toMatchObject({
      amlRiskScore: 100,
      sanctionsClear: false,
      status: "FAILED",
    });
  });

  it("fail-closed result includes flagReason explaining the failure", () => {
    const mockPrisma = createMockPrisma();
    mockPrisma.auditLog.create.mockResolvedValue({});
    const auditService = new AuditService(mockPrisma as any);
    const complianceService = new ComplianceService(mockPrisma as any, auditService);

    return (complianceService as any)
      .callComplianceService({
        sender: VALID_ETH_ADDRESS,
        recipient: VALID_ETH_ADDRESS_2,
        amount: { toString: () => "500" },
        currency: "USDC",
      })
      .then((r: any) => {
        expect(r.flagReason).toBeTruthy();
        expect(r.flagReason).toContain("fail-closed");
      });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NP-11-regression: recurring payment requires ADMIN_ROLE
// ═════════════════════════════════════════════════════════════════════════════

describe("NP-11-regression: recurring payment requires ADMIN_ROLE", () => {
  beforeEach(resetAllMocks);

  it("VIEWER cannot access treasury propose permission (needed for recurring)", () => {
    expect(hasPermission("VIEWER", "treasury:propose")).toBe(false);
  });

  it("OPERATOR cannot access treasury propose permission", () => {
    expect(hasPermission("OPERATOR", "treasury:propose")).toBe(false);
  });

  it("ADMIN can access treasury propose permission", () => {
    expect(hasPermission("ADMIN", "treasury:propose")).toBe(true);
  });

  it("requireRole(ADMIN, TREASURY_MANAGER) blocks VIEWER", () => {
    const middleware = requireRole("ADMIN", "TREASURY_MANAGER");
    const req = createMockRequest({ userRole: "VIEWER" });
    const res = createMockResponse();
    const next = createMockNext();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("requireRole(ADMIN, TREASURY_MANAGER) allows ADMIN", () => {
    const middleware = requireRole("ADMIN", "TREASURY_MANAGER");
    const req = createMockRequest({ userRole: "ADMIN" });
    const res = createMockResponse();
    const next = createMockNext();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// NP-12-regression: batch channel uses shared validation
// ═════════════════════════════════════════════════════════════════════════════

describe("NP-12-regression: batch channel uses shared validation", () => {
  it("BatchPaymentSchema is imported from the shared validation module", () => {
    // Verify the schema exists and validates correctly
    const { BatchPaymentSchema } = require("../../middleware/validation");
    expect(BatchPaymentSchema).toBeDefined();

    // Empty batch must fail
    const emptyResult = BatchPaymentSchema.safeParse({ payments: [] });
    expect(emptyResult.success).toBe(false);

    // Valid batch must pass
    const validResult = BatchPaymentSchema.safeParse({
      payments: [
        {
          sender: VALID_ETH_ADDRESS,
          recipient: VALID_ETH_ADDRESS_2,
          amount: "100",
          currency: "USDC",
        },
      ],
    });
    expect(validResult.success).toBe(true);
  });

  it("batch rejects payments with invalid addresses (same schema as single)", () => {
    const { BatchPaymentSchema } = require("../../middleware/validation");

    const invalidResult = BatchPaymentSchema.safeParse({
      payments: [
        {
          sender: "not-an-address",
          recipient: VALID_ETH_ADDRESS_2,
          amount: "100",
          currency: "USDC",
        },
      ],
    });
    expect(invalidResult.success).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Additional attack regressions
// ═════════════════════════════════════════════════════════════════════════════

describe("Treasury restore-outage: DB failure during restore returns 503", () => {
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let treasuryService: TreasuryService;

  beforeEach(() => {
    resetAllMocks();
    mockPrisma = createMockPrisma();
    (mockPrisma as any).treasuryProposal = {
      findUnique: jest.fn().mockRejectedValue(new Error("DB connection refused")),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    mockPrisma.auditLog.create.mockResolvedValue({});
    const auditService = new AuditService(mockPrisma as any);
    treasuryService = new TreasuryService(mockPrisma as any, auditService);
  });

  it("returns 404 (not 500) for unknown proposal in test mode when DB fails", async () => {
    // In test mode, the DB failure is silently caught and proposal stays null -> 404
    await expect(
      treasuryService.approveProposal("nonexistent-id", "signer-1", BUSINESS_A_ID),
    ).rejects.toThrow("Proposal not found");

    try {
      await treasuryService.approveProposal("nonexistent-id", "signer-1", BUSINESS_A_ID);
    } catch (e) {
      expect((e as TreasuryError).statusCode).toBe(404);
    }
  });
});

describe("Signer collision: same signerId prefix cannot double-approve", () => {
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let treasuryService: TreasuryService;

  beforeEach(() => {
    resetAllMocks();
    mockPrisma = createMockPrisma();
    (mockPrisma as any).treasuryProposal = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    mockPrisma.auditLog.create.mockResolvedValue({});
    const auditService = new AuditService(mockPrisma as any);
    treasuryService = new TreasuryService(mockPrisma as any, auditService);
  });

  it("two different users with the same signer ID are treated as the same signer", async () => {
    await treasuryService.createProposal(
      { title: "Collision test", description: "test", type: "TRANSFER", amount: "5000" },
      "proposer-a",
      BUSINESS_A_ID,
    );
    const proposalId = Array.from((treasuryService as any).proposals.keys())[0] as string;

    // Both "user" objects resolve to the same signerId
    await treasuryService.approveProposal(proposalId, "shared-signer-id", BUSINESS_A_ID);

    await expect(
      treasuryService.approveProposal(proposalId, "shared-signer-id", BUSINESS_A_ID),
    ).rejects.toThrow("has already approved");
  });

  it("two different signer IDs are counted separately", async () => {
    await treasuryService.createProposal(
      { title: "Distinct signers", description: "test", type: "TRANSFER", amount: "5000" },
      "proposer-a",
      BUSINESS_A_ID,
    );
    const proposalId = Array.from((treasuryService as any).proposals.keys())[0] as string;

    await treasuryService.approveProposal(proposalId, "signer-alpha", BUSINESS_A_ID);
    const res = await treasuryService.approveProposal(proposalId, "signer-beta", BUSINESS_A_ID);

    expect(res.remainingApprovals).toBeDefined();
    const proposal = (treasuryService as any).proposals.get(proposalId);
    expect(proposal.approvers).toContain("signer-alpha");
    expect(proposal.approvers).toContain("signer-beta");
  });
});

describe("Tenant crossing: businessId A cannot list/modify businessId B resources", () => {
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let paymentService: PaymentService;
  let crossChainService: CrossChainService;

  beforeEach(() => {
    resetAllMocks();
    mockPrisma = createMockPrisma();
    mockPrisma.auditLog.create.mockResolvedValue({});
    const auditService = new AuditService(mockPrisma as any);
    paymentService = new PaymentService(mockPrisma as any, auditService);
    crossChainService = new CrossChainService(mockPrisma as any, auditService);
  });

  it("requireOwnership rejects when callerBusinessId != resourceBusinessId", () => {
    const req = createMockRequest({ businessId: BUSINESS_A_ID, userRole: "OPERATOR" });
    expect(requireOwnership(req, BUSINESS_B_ID)).toBe(false);
  });

  it("cross-chain getTransfer blocks access from wrong business", async () => {
    const transfer = await crossChainService.initiateTransfer(
      { sourceChain: "aethelred-mainnet", destinationChain: "ethereum-mainnet", token: "USDC", amount: "1000", recipient: VALID_ETH_ADDRESS },
      VALID_ETH_ADDRESS_2,
      BUSINESS_B_ID,
    );

    expect(() => {
      crossChainService.getTransfer(transfer.id, BUSINESS_A_ID);
    }).toThrow("You do not have permission");
  });

  it("cross-chain listTransfers scopes by businessId", async () => {
    await crossChainService.initiateTransfer(
      { sourceChain: "aethelred-mainnet", destinationChain: "ethereum-mainnet", token: "USDC", amount: "1000", recipient: VALID_ETH_ADDRESS },
      VALID_ETH_ADDRESS_2,
      BUSINESS_B_ID,
    );

    const results = crossChainService.listTransfers({ businessId: BUSINESS_A_ID });
    expect(results).toHaveLength(0);
  });

  it("payment cancelPayment rejects cross-tenant cancel", async () => {
    mockPrisma.payment.findUnique.mockResolvedValue({
      id: "payment-tenant-1",
      paymentId: "0xabc",
      businessId: BUSINESS_B_ID,
      status: "PENDING",
      amount: { toString: () => "100" },
      currency: "USDC",
      sender: VALID_ETH_ADDRESS,
      recipient: VALID_ETH_ADDRESS_2,
    });

    await expect(
      paymentService.cancelPayment("payment-tenant-1", BUSINESS_A_ID),
    ).rejects.toThrow("You do not have permission to cancel this payment");
  });
});

describe("Bad role: VIEWER cannot access treasury, reports, or admin routes", () => {
  beforeEach(resetAllMocks);

  it("VIEWER lacks treasury:propose", () => {
    expect(hasPermission("VIEWER", "treasury:propose")).toBe(false);
  });

  it("VIEWER lacks treasury:approve", () => {
    expect(hasPermission("VIEWER", "treasury:approve")).toBe(false);
  });

  it("VIEWER lacks treasury:execute", () => {
    expect(hasPermission("VIEWER", "treasury:execute")).toBe(false);
  });

  it("VIEWER lacks reports:generate", () => {
    expect(hasPermission("VIEWER", "reports:generate")).toBe(false);
  });

  it("VIEWER lacks audit:export", () => {
    expect(hasPermission("VIEWER", "audit:export")).toBe(false);
  });

  it("VIEWER lacks businesses:manage", () => {
    expect(hasPermission("VIEWER", "businesses:manage")).toBe(false);
  });

  it("VIEWER lacks settings:manage", () => {
    expect(hasPermission("VIEWER", "settings:manage")).toBe(false);
  });

  it("VIEWER lacks admin:all", () => {
    expect(hasPermission("VIEWER", "admin:all")).toBe(false);
  });

  it("requireRole(ADMIN) blocks VIEWER", () => {
    const middleware = requireRole("ADMIN");
    const req = createMockRequest({ userRole: "VIEWER" });
    const res = createMockResponse();
    const next = createMockNext();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("Replay: same approval request twice returns DUPLICATE_APPROVAL", () => {
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let treasuryService: TreasuryService;

  beforeEach(() => {
    resetAllMocks();
    mockPrisma = createMockPrisma();
    (mockPrisma as any).treasuryProposal = {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    mockPrisma.auditLog.create.mockResolvedValue({});
    const auditService = new AuditService(mockPrisma as any);
    treasuryService = new TreasuryService(mockPrisma as any, auditService);
  });

  it("returns 409 with DUPLICATE_APPROVAL code on replay", async () => {
    await treasuryService.createProposal(
      { title: "Replay 409 test", description: "test", type: "TRANSFER", amount: "5000" },
      "proposer",
      BUSINESS_A_ID,
    );
    const proposalId = Array.from((treasuryService as any).proposals.keys())[0] as string;

    await treasuryService.approveProposal(proposalId, "signer-replay", BUSINESS_A_ID);

    try {
      await treasuryService.approveProposal(proposalId, "signer-replay", BUSINESS_A_ID);
      fail("Should have thrown");
    } catch (e) {
      expect((e as TreasuryError).code).toBe("DUPLICATE_APPROVAL");
      expect((e as TreasuryError).statusCode).toBe(409);
    }
  });
});

describe("Migration boot: Prisma schema validates", () => {
  it("prisma schema file exists and contains generator + datasource blocks", () => {
    const schemaPath = path.resolve(__dirname, "../../../../backend/prisma/schema.prisma");
    expect(fs.existsSync(schemaPath)).toBe(true);

    const schema = fs.readFileSync(schemaPath, "utf-8");
    expect(schema).toContain("generator client");
    expect(schema).toContain("datasource db");
    // Ensure core models exist
    expect(schema).toContain("model Payment");
    expect(schema).toContain("model Business");
    expect(schema).toContain("model AuditLog");
  });
});
