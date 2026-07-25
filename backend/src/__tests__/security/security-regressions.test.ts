/** Release-blocking regressions for previously identified trust-boundary bugs. */
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import {
  createMockNext,
  createMockRequest,
  createMockResponse,
} from "../setup";
const BUSINESS_A = "business-aaa-111";
const BUSINESS_B = "business-bbb-222";
const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";

const mockAuthPrisma = {
  business: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      address: "0x1111111111111111111111111111111111111111",
    })),
  },
};

jest.mock("../../lib/db", () => ({ prisma: mockAuthPrisma }));
jest.mock("../../lib/business-registry-authorization", () => ({
  getCurrentBusinessRegistryAuthorization: jest.fn(async (address: string) => ({
    wallet: address,
    status: "VERIFIED",
    tier: "STANDARD",
    active: true,
    isAdmin: false,
    registeredAt: 1n,
    lastVerified: 1n,
    expiresAt: 2n,
    blockNumber: 100,
    blockHash: `0x${"ab".repeat(32)}`,
  })),
}));

import { authenticateAPIKey, generateJWT } from "../../middleware/auth";
import {
  extractRole,
  hasPermission,
  requireOwnership,
  requirePermission,
  requireRole,
} from "../../middleware/rbac";
import { BatchPaymentSchema } from "../../middleware/validation";
import { TreasuryService } from "../../services/treasury";
import { CrossChainService } from "../../services/crosschain";
import { InvoiceService } from "../../services/invoice";
import { AIComplianceService } from "../../services/ai-compliance";
import { validateSanctionsMetadata } from "../../services/compliance";

function treasuryProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "proposal-1",
    type: "TRANSFER",
    title: "Approved transfer",
    description: "Regression fixture",
    amount: new Prisma.Decimal("100"),
    currency: "USDC",
    recipient: WALLET_B,
    status: "PENDING",
    requiredSigs: 2,
    currentSigs: 0,
    signers: [],
    approvedBy: [],
    timelockUntil: null,
    createdBy: WALLET_A,
    businessId: BUSINESS_A,
    expiresAt: new Date(Date.now() + 86_400_000),
    executedAt: null,
    createdAt: new Date(),
    metadata: { category: "OPERATIONS" },
    ...overrides,
  } as any;
}

function treasuryHarness(initial: any) {
  let stored = initial;
  const prisma: any = {
    treasuryProposal: {
      findFirst: jest.fn(async ({ where }: any) =>
        stored &&
        stored.id === where.id &&
        stored.businessId === where.businessId
          ? stored
          : null,
      ),
      update: jest.fn(async ({ data }: any) => {
        stored = { ...stored, ...data };
        return stored;
      }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (operation: (tx: any) => unknown) => operation(prisma),
  );
  const audit = { createAuditEntry: jest.fn().mockResolvedValue({}) };
  return {
    prisma,
    audit,
    service: new TreasuryService(prisma, audit as any),
    stored: () => stored,
  };
}

describe("NP-01/NP-07: treasury approval replay and signer collision", () => {
  it("counts each distinct signer exactly once", async () => {
    const harness = treasuryHarness(treasuryProposal());
    const first = await harness.service.approveProposal(
      "proposal-1",
      "signer-a",
      BUSINESS_A,
    );
    const second = await harness.service.approveProposal(
      "proposal-1",
      "signer-b",
      BUSINESS_A,
    );
    expect(first).toEqual({
      approved: false,
      remainingApprovals: 1,
      status: "PENDING",
    });
    expect(second).toEqual({
      approved: true,
      remainingApprovals: 0,
      status: "APPROVED",
    });
    expect(harness.stored().approvedBy).toEqual(["signer-a", "signer-b"]);
  });

  it("rejects an exact signer replay without a second update", async () => {
    const harness = treasuryHarness(
      treasuryProposal({ approvedBy: ["same-signer"], currentSigs: 1 }),
    );
    await expect(
      harness.service.approveProposal("proposal-1", "same-signer", BUSINESS_A),
    ).rejects.toMatchObject({
      code: "DUPLICATE_APPROVAL",
      statusCode: 409,
    });
    expect(harness.prisma.treasuryProposal.update).not.toHaveBeenCalled();
  });

  it("treats two users presenting the same signer identity as the same approver", async () => {
    const harness = treasuryHarness(treasuryProposal());
    await harness.service.approveProposal(
      "proposal-1",
      "shared-wallet",
      BUSINESS_A,
    );
    await expect(
      harness.service.approveProposal(
        "proposal-1",
        "shared-wallet",
        BUSINESS_A,
      ),
    ).rejects.toMatchObject({
      code: "DUPLICATE_APPROVAL",
    });
    expect(harness.stored().currentSigs).toBe(1);
  });

  it("maps transaction infrastructure failure to a 503 without local fallback", async () => {
    const harness = treasuryHarness(treasuryProposal());
    harness.prisma.$transaction.mockRejectedValue(new Error("database down"));
    await expect(
      harness.service.approveProposal("proposal-1", "signer-a", BUSINESS_A),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_FAILURE",
      statusCode: 503,
    });
    expect(harness.prisma.treasuryProposal.update).not.toHaveBeenCalled();
  });
});

describe("NP-02/NP-04: session token verification", () => {
  it.each([
    [
      "wrong signature",
      jwt.sign(
        {
          sub: "attacker",
          businessId: BUSINESS_A,
          tier: "STANDARD",
          role: "ADMIN",
        },
        "wrong-secret",
      ),
    ],
    [
      "alg:none",
      `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "attacker", businessId: BUSINESS_A, tier: "STANDARD", role: "ADMIN", exp: 4_000_000_000 })).toString("base64url")}.`,
    ],
  ])("returns 401, never 500, for %s", async (_name, token) => {
    const req = createMockRequest({
      headers: { authorization: `Bearer ${token}` },
      businessId: undefined,
    });
    const res = createMockResponse();
    const next = createMockNext();
    await authenticateAPIKey(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it.each([
    {},
    { authorization: "Bearer " },
    { authorization: "Basic attacker" },
  ])("rejects empty or non-bearer credentials %#", async (headers) => {
    const req = createMockRequest({ headers, businessId: undefined });
    const res = createMockResponse();
    const next = createMockNext();
    await authenticateAPIKey(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("accepts a generated token with issuer, audience, role and signer intact", async () => {
    const token = generateJWT(BUSINESS_A, "STANDARD", "OPERATOR", WALLET_A);
    const req = createMockRequest({
      headers: { authorization: `Bearer ${token}` },
      businessId: undefined,
    });
    const res = createMockResponse();
    const next = createMockNext();
    await authenticateAPIKey(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req).toMatchObject({
      businessId: BUSINESS_A,
      signerId: WALLET_A,
    });
  });
});

describe("NP-03/NP-11: role and ownership claims", () => {
  it("ignores X-User-Role and X-User-Id headers", () => {
    const req = createMockRequest({
      headers: { "x-user-role": "SUPER_ADMIN", "x-user-id": "attacker" },
      jwtPayload: {
        sub: "signed-user",
        businessId: BUSINESS_A,
        tier: "STANDARD",
        role: "OPERATOR",
      },
    });
    extractRole(req, createMockResponse(), createMockNext());
    expect(req.userRole).toBe("OPERATOR");
    expect(req.userId).toBe("signed-user");
  });

  it("does not grant VIEWER privileged treasury, reporting, audit, or admin permissions", () => {
    for (const permission of [
      "treasury:propose",
      "treasury:approve",
      "treasury:execute",
      "reports:generate",
      "audit:export",
      "businesses:manage",
      "settings:manage",
      "admin:all",
    ]) {
      expect(hasPermission("VIEWER", permission as any)).toBe(false);
    }
  });

  it("blocks VIEWER through both role and permission middleware", () => {
    const roleNext = createMockNext();
    const permissionNext = createMockNext();
    const roleRes = createMockResponse();
    const permissionRes = createMockResponse();
    requireRole("ADMIN", "TREASURY_MANAGER")(
      createMockRequest({ userRole: "VIEWER" }),
      roleRes,
      roleNext,
    );
    requirePermission("reports:generate")(
      createMockRequest({ userRole: "VIEWER" }),
      permissionRes,
      permissionNext,
    );
    expect(roleNext).not.toHaveBeenCalled();
    expect(permissionNext).not.toHaveBeenCalled();
    expect(roleRes.status).toHaveBeenCalledWith(403);
    expect(permissionRes.status).toHaveBeenCalledWith(403);
  });

  it("rejects ownership when the tenant IDs differ or are missing", () => {
    expect(
      requireOwnership(
        createMockRequest({ businessId: BUSINESS_A }),
        BUSINESS_B,
      ),
    ).toBe(false);
    expect(
      requireOwnership(
        createMockRequest({ businessId: undefined }),
        BUSINESS_A,
      ),
    ).toBe(false);
  });
});

describe("NP-05/NP-10: compliance data fails closed", () => {
  it("rejects metadata that advertises mock, test, or fixture sanctions data", () => {
    const generated = new Date().toISOString();
    const base = {
      total_entries: 100,
      last_updated: {
        OFAC: generated,
        "UAE Central Bank": generated,
        UN: generated,
        EU: generated,
      },
      dataset_generated_at: generated,
      dataset_digest: "a".repeat(64),
    };
    for (const source of ["mock dataset", "test feed", "fixture source"]) {
      expect(() => validateSanctionsMetadata({ ...base, source })).toThrow(
        expect.objectContaining({
          code: "SANCTIONS_DATASET_INVALID",
          statusCode: 503,
        }),
      );
    }
  });

  it("rejects stale sanctions data instead of reporting it fresh", () => {
    const stale = "2020-01-01T00:00:00.000Z";
    expect(() =>
      validateSanctionsMetadata(
        {
          total_entries: 100,
          last_updated: {
            OFAC: stale,
            "UAE Central Bank": stale,
            UN: stale,
            EU: stale,
          },
          source: "Official regulator feed",
          dataset_generated_at: stale,
          dataset_digest: "b".repeat(64),
        },
        Date.parse("2026-07-21T00:00:00.000Z"),
        86_400_000,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "SANCTIONS_DATASET_STALE",
        statusCode: 503,
      }),
    );
  });

  it("rejects incomplete list coverage", () => {
    const generated = new Date().toISOString();
    expect(() =>
      validateSanctionsMetadata({
        total_entries: 100,
        last_updated: { OFAC: generated, UN: generated, EU: generated },
        source: "Official regulator feed",
        dataset_generated_at: generated,
        dataset_digest: "c".repeat(64),
      }),
    ).toThrow(expect.objectContaining({ code: "SANCTIONS_DATASET_INVALID" }));
  });
});

describe("NP-06: cross-chain recovery and tenant boundaries", () => {
  it("fails transfer initiation and recovery closed without verified receipts", async () => {
    const prisma: any = {
      crossChainTransfer: { create: jest.fn(), update: jest.fn() },
    };
    const service = new CrossChainService(prisma, {} as any, jest.fn());
    await expect(
      service.initiateTransfer(
        {
          sourceChain: "aethelred",
          destinationChain: "ethereum",
          token: "USDC",
          amount: "1",
          recipient: WALLET_B,
        },
        WALLET_A,
        BUSINESS_A,
      ),
    ).rejects.toMatchObject({
      code: "BRIDGE_EXECUTION_UNAVAILABLE",
      statusCode: 501,
    });
    await expect(
      service.recoverTransfer("transfer-1", WALLET_A, BUSINESS_A),
    ).rejects.toMatchObject({
      code: "RECOVERY_EXECUTION_UNAVAILABLE",
      statusCode: 501,
    });
    expect(prisma.crossChainTransfer.create).not.toHaveBeenCalled();
    expect(prisma.crossChainTransfer.update).not.toHaveBeenCalled();
  });

  it("conceals a transfer not owned by the tenant wallet", async () => {
    const prisma: any = {
      business: {
        findUnique: jest.fn().mockResolvedValue({ address: WALLET_A }),
      },
      crossChainTransfer: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new CrossChainService(prisma, {} as any, jest.fn());
    await expect(
      service.getTransfer("transfer-b", BUSINESS_A),
    ).rejects.toMatchObject({
      code: "TRANSFER_NOT_FOUND",
      statusCode: 404,
    });
    expect(prisma.crossChainTransfer.findFirst).toHaveBeenCalledWith({
      where: {
        id: "transfer-b",
        sender: { equals: WALLET_A, mode: "insensitive" },
      },
    });
  });

  it("rejects a caller-supplied sender that differs from the authenticated wallet", async () => {
    const prisma: any = {
      business: {
        findUnique: jest.fn().mockResolvedValue({ address: WALLET_A }),
      },
      crossChainTransfer: { findMany: jest.fn() },
    };
    const service = new CrossChainService(prisma, {} as any, jest.fn());
    await expect(
      service.listTransfers({ businessId: BUSINESS_A, sender: WALLET_B }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
    expect(prisma.crossChainTransfer.findMany).not.toHaveBeenCalled();
  });
});

describe("NP-12: shared batch validation cannot bypass payment validation", () => {
  const validPayment = {
    sender: WALLET_A,
    recipient: WALLET_B,
    amount: "10.5",
    currency: "USDC",
    purposeHash: `0x${"a".repeat(64)}`,
  };

  it("accepts a bounded batch of individually valid payments", () => {
    expect(
      BatchPaymentSchema.safeParse({ payments: [validPayment] }).success,
    ).toBe(true);
  });

  it.each([
    [{ ...validPayment, sender: "not-an-address" }, "invalid address"],
    [{ ...validPayment, amount: "0" }, "zero amount"],
    [{ ...validPayment, currency: "usdc" }, "lowercase currency"],
  ])("rejects %s (%s)", (payment) => {
    expect(BatchPaymentSchema.safeParse({ payments: [payment] }).success).toBe(
      false,
    );
  });

  it("rejects empty and oversized batches", () => {
    expect(BatchPaymentSchema.safeParse({ payments: [] }).success).toBe(false);
    expect(
      BatchPaymentSchema.safeParse({
        payments: Array.from({ length: 101 }, () => validPayment),
      }).success,
    ).toBe(false);
  });
});

describe("mutation adapters remain fail-closed", () => {
  it("blocks invoice financing without a verified gateway", async () => {
    const prisma: any = {
      invoice: { findFirst: jest.fn() },
      invoiceFinancingRequest: { create: jest.fn() },
    };
    const service = new InvoiceService(prisma, {} as any, null);
    await expect(
      service.requestFinancing(
        "invoice-1",
        "10",
        WALLET_A,
        BUSINESS_A,
        "key-1",
      ),
    ).rejects.toMatchObject({
      code: "INVOICE_FINANCING_NOT_CONFIGURED",
      statusCode: 501,
    });
    expect(prisma.invoice.findFirst).not.toHaveBeenCalled();
    expect(prisma.invoiceFinancingRequest.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "decision",
      (service: AIComplianceService) =>
        service.runDecision("model-1", "payment-1", BUSINESS_A, "key-1"),
      "AI_DECISION_VERIFICATION_UNAVAILABLE",
    ],
    [
      "override",
      (service: AIComplianceService) =>
        service.overrideDecision(
          "decision-1",
          "APPROVE",
          WALLET_A,
          "reason",
          BUSINESS_A,
        ),
      "AI_DECISION_MUTATIONS_UNAVAILABLE",
    ],
    [
      "appeal",
      (service: AIComplianceService) =>
        service.submitAppeal("decision-1", WALLET_A, "reason", BUSINESS_A),
      "AI_APPEAL_VERIFICATION_UNAVAILABLE",
    ],
  ])("blocks unverified AI %s mutation", async (_name, operation, code) => {
    const prisma: any = {
      aIDecision: { create: jest.fn(), update: jest.fn() },
      aIAppeal: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    const service = new AIComplianceService(prisma, {} as any, null);
    await expect(operation(service)).rejects.toMatchObject({
      code,
      statusCode: 501,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
