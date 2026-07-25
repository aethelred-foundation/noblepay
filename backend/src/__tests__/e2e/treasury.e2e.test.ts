import { Prisma } from "@prisma/client";
import crypto from "crypto";
import { getAddress } from "ethers";

const proposals = new Map<string, any>();
let nextProposal = 1;
const audit = { createAuditEntry: jest.fn().mockResolvedValue({}) };

const activePolicy = {
  id: "policy-operations",
  category: "OPERATIONS",
  dailyLimit: new Prisma.Decimal("100000"),
  monthlyLimit: new Prisma.Decimal("1000000"),
  requiresMultiSig: true,
  approvalThreshold: 2,
  isActive: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const mockPrisma: any = {
  aPIKey: { findUnique: jest.fn(), update: jest.fn() },
  business: { findUnique: jest.fn() },
  spendingPolicy: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  yieldStrategy: { findMany: jest.fn() },
  treasuryProposal: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  $transaction: jest.fn(),
};

jest.mock("../../lib/db", () => ({ prisma: mockPrisma }));
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
jest.mock("../../services/audit", () => ({
  AuditService: jest.fn(() => audit),
}));

import express from "express";
import request from "supertest";
import { generateJWT, hashAPIKey } from "../../middleware/auth";
import treasuryRouter from "../../routes/treasury";

const app = express();
app.use(express.json());
app.use("/v1/treasury", treasuryRouter);

const apiKeys = new Map<string, any>();

function walletForBusiness(businessId: string): string {
  return getAddress(
    `0x${Buffer.from(businessId).toString("hex").slice(0, 40).padEnd(40, "0")}`,
  );
}

function token(businessId: string, role: string, signer: string): string {
  void signer;
  return generateJWT(
    businessId,
    "STANDARD",
    role,
    walletForBusiness(businessId),
  );
}

function apiKeyToken(businessId: string, keyId: string): string {
  const rawKey = `npk_${crypto.randomBytes(32).toString("hex")}`;
  apiKeys.set(hashAPIKey(rawKey), {
    id: keyId,
    businessId,
    status: "ACTIVE",
    business: { id: businessId, address: walletForBusiness(businessId) },
  });
  return rawKey;
}

function validTransfer(overrides: Record<string, unknown> = {}) {
  return {
    title: "Vendor payment",
    description: "Verified operational settlement",
    type: "TRANSFER",
    amount: "7500",
    currency: "USDC",
    category: "OPERATIONS",
    recipient: "0x2222222222222222222222222222222222222222",
    ...overrides,
  };
}

function configureDurableDatabase(): void {
  proposals.clear();
  nextProposal = 1;
  mockPrisma.spendingPolicy.findFirst.mockResolvedValue(activePolicy);
  mockPrisma.spendingPolicy.findMany.mockResolvedValue([activePolicy]);
  mockPrisma.yieldStrategy.findMany.mockResolvedValue([]);
  mockPrisma.treasuryProposal.create.mockImplementation(
    async ({ data }: any) => {
      const now = new Date();
      const proposal = {
        id: `prop-${nextProposal++}`,
        ...data,
        createdAt: now,
        updatedAt: now,
        executedAt: null,
      };
      proposals.set(proposal.id, proposal);
      return proposal;
    },
  );
  mockPrisma.treasuryProposal.findFirst.mockImplementation(
    async ({ where }: any) => {
      const proposal = proposals.get(where.id);
      return proposal && proposal.businessId === where.businessId
        ? proposal
        : null;
    },
  );
  mockPrisma.treasuryProposal.findMany.mockImplementation(
    async ({ where, skip = 0, take }: any) => {
      const filtered = [...proposals.values()].filter(
        (proposal) =>
          (!where?.businessId || proposal.businessId === where.businessId) &&
          (!where?.status || proposal.status === where.status),
      );
      return filtered.slice(skip, take === undefined ? undefined : skip + take);
    },
  );
  mockPrisma.treasuryProposal.update.mockImplementation(
    async ({ where, data }: any) => {
      const current = proposals.get(where.id);
      if (!current) throw new Error("missing proposal");
      const updated = { ...current, ...data, updatedAt: new Date() };
      proposals.set(where.id, updated);
      return updated;
    },
  );
  mockPrisma.$transaction.mockImplementation(
    async (operation: (tx: any) => unknown) => operation(mockPrisma),
  );
}

describe("Treasury HTTP lifecycle with durable workflow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    apiKeys.clear();
    mockPrisma.aPIKey.findUnique.mockImplementation(
      ({ where }: { where: { keyHash: string } }) =>
        apiKeys.get(where.keyHash) || null,
    );
    mockPrisma.aPIKey.update.mockResolvedValue({});
    mockPrisma.business.findUnique.mockImplementation(
      ({ where }: { where: { id: string } }) => ({
        id: where.id,
        address: walletForBusiness(where.id),
      }),
    );
    audit.createAuditEntry.mockResolvedValue({});
    configureDurableDatabase();
  });

  it("rejects requests without a verified identity", async () => {
    const response = await request(app).get("/v1/treasury/overview");
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("UNAUTHORIZED");
  });

  it("enforces role authorization before proposal validation or persistence", async () => {
    const response = await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${token("biz-a", "VIEWER", "viewer-a")}`)
      .send({});
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("FORBIDDEN");
    expect(mockPrisma.treasuryProposal.create).not.toHaveBeenCalled();
  });

  it("validates transfer evidence before reaching the durable workflow", async () => {
    const response = await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "admin-a")}`)
      .send(validTransfer({ recipient: undefined }));
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("VALIDATION_ERROR");
    expect(mockPrisma.treasuryProposal.create).not.toHaveBeenCalled();
  });

  it("persists a valid proposal with signer and tenant identities from the JWT", async () => {
    const response = await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "admin-a")}`)
      .send(validTransfer());
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      id: "prop-1",
      proposer: walletForBusiness("biz-a"),
      businessId: "biz-a",
      requiredApprovals: 2,
      currentApprovals: 0,
      status: "PENDING",
      dataSource: "DATABASE_WORKFLOW",
    });
    expect(mockPrisma.treasuryProposal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        createdBy: walletForBusiness("biz-a"),
        businessId: "biz-a",
        amount: expect.any(Prisma.Decimal),
        approvedBy: [],
      }),
    });
    expect(audit.createAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-a",
        actor: walletForBusiness("biz-a"),
      }),
    );
  });

  it("fails closed when a monetary category has no durable spending policy", async () => {
    mockPrisma.spendingPolicy.findFirst.mockResolvedValue(null);
    const response = await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "admin-a")}`)
      .send(validTransfer());
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("POLICY_NOT_FOUND");
    expect(mockPrisma.treasuryProposal.create).not.toHaveBeenCalled();
  });

  it("does not count role-labeled sessions for one registered wallet as distinct approvals", async () => {
    const created = await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "creator-a")}`)
      .send(validTransfer());
    const first = await request(app)
      .post(`/v1/treasury/proposals/${created.body.data.id}/approve`)
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "signer-a")}`)
      .send({});
    const replay = await request(app)
      .post(`/v1/treasury/proposals/${created.body.data.id}/approve`)
      .set(
        "Authorization",
        `Bearer ${token("biz-a", "TREASURY_MANAGER", "signer-b")}`,
      )
      .send({});
    expect(first.body.data).toEqual({
      approved: false,
      remainingApprovals: 1,
      status: "PENDING",
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("DUPLICATE_APPROVAL");
    expect(proposals.get(created.body.data.id).approvedBy).toEqual([
      walletForBusiness("biz-a"),
    ]);
    expect(proposals.get(created.body.data.id).status).toBe("PENDING");
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate signer approval without mutating the threshold", async () => {
    const created = await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "creator-a")}`)
      .send(validTransfer());
    const auth = `Bearer ${token("biz-a", "ADMIN", "signer-a")}`;
    await request(app)
      .post(`/v1/treasury/proposals/${created.body.data.id}/approve`)
      .set("Authorization", auth)
      .send({});
    const duplicate = await request(app)
      .post(`/v1/treasury/proposals/${created.body.data.id}/approve`)
      .set("Authorization", auth)
      .send({});
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe("DUPLICATE_APPROVAL");
    expect(proposals.get(created.body.data.id).currentSigs).toBe(1);
  });

  it("rejects multiple API keys before they can propose, approve, execute, or form quorum", async () => {
    const created = await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "creator-a")}`)
      .send(validTransfer());
    expect(created.status).toBe(201);

    const keyA = apiKeyToken("biz-a", "key-a");
    const keyB = apiKeyToken("biz-a", "key-b");
    const attemptedProposal = await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${keyA}`)
      .send(validTransfer({ title: "Credential quorum bypass" }));
    const attemptedApprovalA = await request(app)
      .post(`/v1/treasury/proposals/${created.body.data.id}/approve`)
      .set("Authorization", `Bearer ${keyA}`)
      .send({});
    const attemptedApprovalB = await request(app)
      .post(`/v1/treasury/proposals/${created.body.data.id}/approve`)
      .set("Authorization", `Bearer ${keyB}`)
      .send({});
    const attemptedExecution = await request(app)
      .post(`/v1/treasury/proposals/${created.body.data.id}/execute`)
      .set("Authorization", `Bearer ${keyB}`)
      .send({});

    for (const response of [
      attemptedProposal,
      attemptedApprovalA,
      attemptedApprovalB,
      attemptedExecution,
    ]) {
      expect(response.status).toBe(403);
      expect(response.body.error).toBe("WALLET_SESSION_REQUIRED");
    }
    expect(proposals.size).toBe(1);
    expect(proposals.get(created.body.data.id)).toMatchObject({
      approvedBy: [],
      currentSigs: 0,
      status: "PENDING",
    });
  });

  it("conceals another tenant's proposal during approval", async () => {
    const created = await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "creator-a")}`)
      .send(validTransfer());
    const response = await request(app)
      .post(`/v1/treasury/proposals/${created.body.data.id}/approve`)
      .set("Authorization", `Bearer ${token("biz-b", "ADMIN", "attacker-b")}`)
      .send({});
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("PROPOSAL_NOT_FOUND");
    expect(proposals.get(created.body.data.id).approvedBy).toEqual([]);
  });

  it("marks an expired proposal durably and refuses approval", async () => {
    const created = await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "creator-a")}`)
      .send(validTransfer());
    proposals.get(created.body.data.id).expiresAt = new Date(
      "2000-01-01T00:00:00.000Z",
    );
    const response = await request(app)
      .post(`/v1/treasury/proposals/${created.body.data.id}/approve`)
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "signer-a")}`)
      .send({});
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("PROPOSAL_EXPIRED");
    expect(proposals.get(created.body.data.id).status).toBe("EXPIRED");
  });

  it("fails execution closed until an on-chain receipt verifier is configured", async () => {
    const created = await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "creator-a")}`)
      .send(validTransfer());
    const response = await request(app)
      .post(`/v1/treasury/proposals/${created.body.data.id}/execute`)
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "executor-a")}`)
      .send({});
    expect(response.status).toBe(501);
    expect(response.body.error).toBe("TREASURY_EXECUTION_UNAVAILABLE");
    expect(proposals.get(created.body.data.id).status).toBe("PENDING");
    expect(mockPrisma.treasuryProposal.update).not.toHaveBeenCalled();
  });

  it("lists only authenticated-tenant proposals with bounded pagination", async () => {
    await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${token("biz-a", "ADMIN", "a")}`)
      .send(validTransfer());
    await request(app)
      .post("/v1/treasury/proposals")
      .set("Authorization", `Bearer ${token("biz-b", "ADMIN", "b")}`)
      .send(validTransfer());
    const response = await request(app)
      .get("/v1/treasury/proposals?status=PENDING&page=1&limit=10")
      .set("Authorization", `Bearer ${token("biz-a", "VIEWER", "reader-a")}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].businessId).toBe("biz-a");
    expect(mockPrisma.treasuryProposal.findMany).toHaveBeenLastCalledWith({
      where: { businessId: "biz-a", status: "PENDING" },
      orderBy: { createdAt: "desc" },
      skip: 0,
      take: 10,
    });
  });

  it("rejects excess pagination before querying storage", async () => {
    const response = await request(app)
      .get("/v1/treasury/proposals?page=1&limit=101")
      .set("Authorization", `Bearer ${token("biz-a", "VIEWER", "reader-a")}`);
    expect(response.status).toBe(400);
    expect(mockPrisma.treasuryProposal.findMany).not.toHaveBeenCalled();
  });
});
