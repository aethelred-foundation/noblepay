import { Prisma } from "@prisma/client";
const mockVerifyTreasuryExecution = jest.fn();
jest.mock("../../services/treasury-execution", () => ({
  verifyTreasuryExecution: (...a: unknown[]) => mockVerifyTreasuryExecution(...a),
  TreasuryExecutionError: class extends Error {},
}));

import { TreasuryError, TreasuryService } from "../../services/treasury";
import type { AuditService } from "../../services/audit";

const now = new Date("2026-07-21T12:00:00.000Z");
const signer = "0x1111111111111111111111111111111111111111";

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "proposal-1",
    type: "TRANSFER",
    title: "Infrastructure payment",
    description: "Pay the infrastructure supplier",
    amount: new Prisma.Decimal("500"),
    currency: "USDC",
    recipient: "0x2222222222222222222222222222222222222222",
    status: "PENDING",
    requiredSigs: 2,
    currentSigs: 0,
    signers: [],
    approvedBy: [],
    timelockUntil: null,
    createdBy: signer,
    businessId: "business-1",
    expiresAt: new Date("2026-07-28T12:00:00.000Z"),
    executedAt: null,
    createdAt: now,
    metadata: { category: "INFRASTRUCTURE" },
    ...overrides,
  };
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    id: "policy-1",
    category: "INFRASTRUCTURE",
    dailyLimit: new Prisma.Decimal("1000"),
    monthlyLimit: new Prisma.Decimal("10000"),
    requiresMultiSig: true,
    approvalThreshold: 2,
    isActive: true,
    updatedAt: now,
    ...overrides,
  };
}

function strategy(overrides: Record<string, unknown> = {}) {
  return {
    id: "strategy-1",
    protocol: "VerifiedProtocol",
    name: "USDC reserve",
    allocatedAmount: new Prisma.Decimal("1000"),
    currency: "USDC",
    apy: new Prisma.Decimal("2.5"),
    riskLevel: "LOW",
    isActive: true,
    totalYieldEarned: new Prisma.Decimal("25"),
    lastHarvestAt: null,
    createdAt: now,
    ...overrides,
  };
}

function setup() {
  const prisma = {
    yieldStrategy: { findMany: jest.fn() },
    treasuryProposal: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    spendingPolicy: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const auditService = {
    createAuditEntry: jest.fn().mockResolvedValue({}),
  };
  const service = new TreasuryService(
    prisma as never,
    auditService as unknown as AuditService,
  );
  return { prisma, service, auditService };
}

describe("TreasuryService production behavior", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it("builds an overview only from durable allocations and proposals", async () => {
    const { prisma, service } = setup();
    prisma.yieldStrategy.findMany.mockResolvedValue([strategy()]);
    prisma.treasuryProposal.findMany.mockResolvedValue([
      proposal(),
      proposal({
        id: "proposal-2",
        status: "EXECUTED",
        executedAt: now,
        amount: new Prisma.Decimal("100"),
        approvedBy: [signer],
      }),
    ]);

    const overview = await service.getOverview("business-1");

    expect(overview).toEqual(
      expect.objectContaining({
        allocations: { USDC: "1000" },
        yieldEarned: "25",
        pendingProposals: 1,
        signerCount: 1,
        valuationScope: "RECORDED_YIELD_ALLOCATIONS_ONLY",
        dataSource: "DATABASE_LEDGER",
      }),
    );
    expect(overview.monthlySpend.INFRASTRUCTURE).toBe("100");
  });

  it("tenant-scopes and paginates proposal history", async () => {
    const { prisma, service } = setup();
    prisma.treasuryProposal.findMany.mockResolvedValue([proposal()]);

    const records = await service.listProposals("business-1", "PENDING", {
      page: 2,
      limit: 20,
    });

    expect(records[0]).toEqual(
      expect.objectContaining({
        businessId: "business-1",
        category: "INFRASTRUCTURE",
        dataSource: "DATABASE_WORKFLOW",
      }),
    );
    expect(prisma.treasuryProposal.findMany).toHaveBeenCalledWith({
      where: { businessId: "business-1", status: "PENDING" },
      orderBy: { createdAt: "desc" },
      skip: 20,
      take: 20,
    });
  });

  it("persists a policy-backed proposal and emits an audit event", async () => {
    const { prisma, service, auditService } = setup();
    prisma.spendingPolicy.findFirst.mockResolvedValue(policy());
    prisma.treasuryProposal.create.mockResolvedValue(proposal());

    const record = await service.createProposal(
      {
        title: "Infrastructure payment",
        description: "Pay the infrastructure supplier",
        type: "TRANSFER",
        amount: "500",
        currency: "USDC",
        recipient: "0x2222222222222222222222222222222222222222",
        category: "INFRASTRUCTURE",
      },
      signer,
      "business-1",
    );

    expect(record.id).toBe("proposal-1");
    expect(prisma.treasuryProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          businessId: "business-1",
          requiredSigs: 2,
          status: "PENDING",
        }),
      }),
    );
    expect(auditService.createAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "business-1", actor: signer }),
    );
  });

  it("refuses monetary proposals without an active durable policy", async () => {
    const { prisma, service } = setup();
    prisma.spendingPolicy.findFirst.mockResolvedValue(null);

    await expect(
      service.createProposal(
        {
          title: "Payment",
          description: "A valid description",
          type: "TRANSFER",
          amount: "10",
          currency: "USDC",
          category: "OPERATIONS",
        },
        signer,
        "business-1",
      ),
    ).rejects.toMatchObject({ code: "POLICY_NOT_FOUND", statusCode: 409 });
    expect(prisma.treasuryProposal.create).not.toHaveBeenCalled();
  });

  it("approves a tenant proposal transactionally without duplicate local state", async () => {
    const { prisma, service } = setup();
    const pending = proposal();
    const approved = proposal({
      status: "APPROVED",
      currentSigs: 2,
      approvedBy: ["0x3333333333333333333333333333333333333333", signer],
    });
    prisma.treasuryProposal.findFirst.mockResolvedValue(pending);
    prisma.treasuryProposal.update.mockResolvedValue(approved);
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback({ treasuryProposal: prisma.treasuryProposal }),
    );

    const result = await service.approveProposal(
      "proposal-1",
      signer,
      "business-1",
    );

    expect(result).toEqual({
      approved: true,
      remainingApprovals: 0,
      status: "APPROVED",
    });
    expect(prisma.treasuryProposal.findFirst).toHaveBeenCalledWith({
      where: { id: "proposal-1", businessId: "business-1" },
    });
  });

  // Execution is no longer blanket-disabled — a receipt verifier now exists —
  // but it still fails closed. What changed is that each refusal names a
  // reason instead of every call returning the same 501.
  describe("treasury execution", () => {
    const execution = {
      txHash:
        "0xc62faafeb160571853128e25efc65388ca483c22504742b7b455dfcc8ade5faa",
      onChainProposalId:
        "0xb0e5549ef29f19213987c37c736b4955892f71e833ef1379f5306e02a77ebe6e",
    };
    const chainConfig = {
      rpcUrl: "http://rpc.invalid",
      minimumConfirmations: 1,
    } as never;

    it("refuses a proposal that is not APPROVED", async () => {
      const { prisma, service } = setup();
      prisma.treasuryProposal.findFirst.mockResolvedValue(
        proposal({ status: "PENDING" }),
      );
      await expect(
        service.executeProposal(
          "proposal-1",
          signer,
          "business-1",
          execution,
          chainConfig,
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE", statusCode: 409 });
      expect(mockVerifyTreasuryExecution).not.toHaveBeenCalled();
    });

    it("refuses a proposal that does not exist for this business", async () => {
      const { prisma, service } = setup();
      prisma.treasuryProposal.findFirst.mockResolvedValue(null);
      await expect(
        service.executeProposal(
          "proposal-1",
          signer,
          "business-1",
          execution,
          chainConfig,
        ),
      ).rejects.toMatchObject({ code: "PROPOSAL_NOT_FOUND", statusCode: 404 });
    });

    it("is idempotent when the same transaction is reported twice", async () => {
      const { prisma, service } = setup();
      prisma.treasuryProposal.findFirst.mockResolvedValue(
        proposal({
          status: "EXECUTED",
          executionTxHash: execution.txHash.toLowerCase(),
          onChainProposalId: execution.onChainProposalId.toLowerCase(),
          executedAt: now,
        }),
      );
      const result = await service.executeProposal(
        "proposal-1",
        signer,
        "business-1",
        execution,
        chainConfig,
      );
      expect(result.status).toBe("EXECUTED");
      // No re-verification and no second write for a replayed report.
      expect(mockVerifyTreasuryExecution).not.toHaveBeenCalled();
      expect(prisma.treasuryProposal.update).not.toHaveBeenCalled();
    });

    it("conflicts when a DIFFERENT transaction claims the same proposal", async () => {
      // Not a retry — a contradiction. Two transactions cannot both have
      // settled one proposal, and silently accepting the second would
      // overwrite the evidence for the first.
      const { prisma, service } = setup();
      prisma.treasuryProposal.findFirst.mockResolvedValue(
        proposal({
          status: "EXECUTED",
          executionTxHash: `0x${"9".repeat(64)}`,
        }),
      );
      await expect(
        service.executeProposal(
          "proposal-1",
          signer,
          "business-1",
          execution,
          chainConfig,
        ),
      ).rejects.toMatchObject({ code: "ALREADY_EXECUTED", statusCode: 409 });
    });

    it("records the verified receipt, not the caller's claim", async () => {
      const { prisma, service } = setup();
      prisma.treasuryProposal.findFirst.mockResolvedValue(
        proposal({ status: "APPROVED" }),
      );
      prisma.treasuryProposal.update.mockResolvedValue(
        proposal({ status: "EXECUTED" }),
      );
      mockVerifyTreasuryExecution.mockResolvedValue({
        onChainProposalId: execution.onChainProposalId.toLowerCase(),
        txHash: execution.txHash.toLowerCase(),
        executor: "0x3333333333333333333333333333333333333333",
        blockNumber: 4242,
        blockHash: "0xblock",
        confirmations: 5,
        amount: "50000",
        executedAt: now,
      });

      const result = await service.executeProposal(
        "proposal-1",
        signer,
        "business-1",
        execution,
        chainConfig,
      );

      expect(result.blockNumber).toBe(4242);
      // executedAt comes from the block, not from Date.now().
      expect(prisma.treasuryProposal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "EXECUTED",
            executedAt: now,
            executionTxHash: execution.txHash.toLowerCase(),
          }),
        }),
      );
    });
  });

  it("returns only persisted policies and yield strategies with pagination", async () => {
    const { prisma, service } = setup();
    prisma.spendingPolicy.findMany.mockResolvedValue([policy()]);
    prisma.yieldStrategy.findMany.mockResolvedValue([strategy()]);

    const [policies, strategies] = await Promise.all([
      service.getSpendingPolicies({ page: 1, limit: 10 }),
      service.getYieldStrategies({ page: 2, limit: 5 }),
    ]);

    expect(policies[0]).toEqual(
      expect.objectContaining({ dataSource: "DATABASE_POLICY" }),
    );
    expect(strategies[0]).toEqual(
      expect.objectContaining({
        totalYieldEarned: "25",
        dataSource: "DATABASE_STRATEGY",
      }),
    );
    expect(prisma.yieldStrategy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 5, take: 5 }),
    );
  });
});

describe("TreasuryService fail-closed branches", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it("maps nullable proposal data and supports an unpaginated tenant list", async () => {
    const { prisma, service } = setup();
    prisma.treasuryProposal.findMany.mockResolvedValue([
      proposal({
        id: "proposal-nullable",
        amount: null,
        currency: null,
        recipient: null,
        metadata: null,
      }),
      proposal({ id: "proposal-array", metadata: [] }),
      proposal({
        id: "proposal-invalid-category",
        metadata: { category: "NOT_ALLOWED" },
      }),
    ]);
    const records = await service.listProposals("business-1");
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      amount: null,
      category: null,
      metadata: {},
    });
    expect(records[1]).toMatchObject({ category: null, metadata: {} });
    expect(records[2].category).toBeNull();
    expect(prisma.treasuryProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: undefined,
        take: undefined,
      }),
    );
  });

  it("creates a non-monetary proposal without inventing a policy dependency", async () => {
    const { prisma, service } = setup();
    prisma.treasuryProposal.create.mockImplementation(({ data }: any) =>
      proposal({
        ...data,
        amount: null,
        currency: null,
        recipient: null,
        metadata: {},
      }),
    );
    const record = await service.createProposal(
      {
        title: "  Rotate signers  ",
        description: "  Update the signer policy  ",
        type: "POLICY_CHANGE",
      },
      signer,
      "business-1",
    );
    expect(record).toMatchObject({
      amount: null,
      requiredApprovals: 1,
      category: null,
    });
    expect(prisma.spendingPolicy.findFirst).not.toHaveBeenCalled();
    expect(prisma.treasuryProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: "Rotate signers",
          description: "Update the signer policy",
          timelockUntil: null,
        }),
      }),
    );
  });

  it("uses a single-signature policy, timelock, normalized currency, and caller metadata", async () => {
    const { prisma, service } = setup();
    prisma.spendingPolicy.findFirst.mockResolvedValue(
      policy({ requiresMultiSig: false, approvalThreshold: 9 }),
    );
    prisma.treasuryProposal.create.mockImplementation(({ data }: any) =>
      proposal({ ...data }),
    );
    await service.createProposal(
      {
        title: "Supplier payment",
        description: "Pay a verified supplier",
        type: "TRANSFER",
        amount: "25",
        currency: " usdc ",
        recipient: " recipient ",
        category: "OPERATIONS",
        timelockHours: 12,
        metadata: { ticket: "OPS-42" },
      },
      signer,
      "business-1",
    );
    expect(prisma.treasuryProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requiredSigs: 1,
          currency: "USDC",
          recipient: "recipient",
          timelockUntil: new Date(now.getTime() + 12 * 3_600_000),
          metadata: { ticket: "OPS-42", category: "OPERATIONS" },
        }),
      }),
    );
  });

  it("maps a proposal database failure without losing its cause", async () => {
    const { prisma, service } = setup();
    prisma.spendingPolicy.findFirst.mockResolvedValue(policy());
    const cause = new Error("database unavailable");
    prisma.treasuryProposal.create.mockRejectedValue(cause);
    await expect(
      service.createProposal(
        {
          title: "Payment",
          description: "Pay supplier",
          type: "TRANSFER",
          amount: "10",
          currency: "USDC",
          category: "OPERATIONS",
        },
        signer,
        "business-1",
      ),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_FAILURE",
      statusCode: 503,
      cause,
    });
  });

  it.each([
    [
      { title: "", description: "description", type: "TRANSFER" },
      "INVALID_PROPOSAL",
    ],
    [{ title: "title", description: "", type: "TRANSFER" }, "INVALID_PROPOSAL"],
    [
      { title: "title", description: "description", type: "UNKNOWN" },
      "INVALID_PROPOSAL_TYPE",
    ],
    [
      {
        title: "title",
        description: "description",
        type: "TRANSFER",
        category: "UNKNOWN",
      },
      "INVALID_SPENDING_CATEGORY",
    ],
    [
      {
        title: "title",
        description: "description",
        type: "TRANSFER",
        amount: "invalid",
        currency: "USDC",
        category: "OPERATIONS",
      },
      "INVALID_AMOUNT",
    ],
    [
      {
        title: "title",
        description: "description",
        type: "TRANSFER",
        amount: "0",
        currency: "USDC",
        category: "OPERATIONS",
      },
      "INVALID_MONETARY_PROPOSAL",
    ],
    [
      {
        title: "title",
        description: "description",
        type: "TRANSFER",
        amount: "10",
        category: "OPERATIONS",
      },
      "INVALID_MONETARY_PROPOSAL",
    ],
    [
      {
        title: "title",
        description: "description",
        type: "TRANSFER",
        amount: "10",
        currency: "USDC",
      },
      "INVALID_MONETARY_PROPOSAL",
    ],
  ])("rejects malformed proposal input %#", async (input, code) => {
    const { service } = setup();
    await expect(
      service.createProposal(input as any, signer, "business-1"),
    ).rejects.toMatchObject({ code });
  });

  it.each([-1, 0.5, 721])(
    "rejects the invalid timelock %s",
    async (timelockHours) => {
      const { service } = setup();
      await expect(
        service.createProposal(
          {
            title: "Policy update",
            description: "Update treasury policy",
            type: "POLICY_CHANGE",
            timelockHours,
          },
          signer,
          "business-1",
        ),
      ).rejects.toMatchObject({ code: "INVALID_TIMELOCK" });
    },
  );

  it.each([
    [null, "PROPOSAL_NOT_FOUND"],
    [proposal({ status: "APPROVED" }), "INVALID_STATE"],
    [proposal({ approvedBy: [signer] }), "DUPLICATE_APPROVAL"],
  ])("rejects an invalid approval target %#", async (stored, code) => {
    const { prisma, service } = setup();
    prisma.treasuryProposal.findFirst.mockResolvedValue(stored);
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback({ treasuryProposal: prisma.treasuryProposal }),
    );
    await expect(
      service.approveProposal("proposal-1", signer, "business-1"),
    ).rejects.toMatchObject({ code });
  });

  it("expires an overdue proposal atomically", async () => {
    const { prisma, service } = setup();
    prisma.treasuryProposal.findFirst.mockResolvedValue(
      proposal({
        expiresAt: new Date(now.getTime() - 1),
      }),
    );
    prisma.treasuryProposal.update.mockResolvedValue(
      proposal({ status: "EXPIRED" }),
    );
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback({ treasuryProposal: prisma.treasuryProposal }),
    );
    await expect(
      service.approveProposal("proposal-1", signer, "business-1"),
    ).rejects.toMatchObject({ code: "PROPOSAL_EXPIRED" });
    expect(prisma.treasuryProposal.update).toHaveBeenCalledWith({
      where: { id: "proposal-1" },
      data: { status: "EXPIRED" },
    });
  });

  it("records a partial approval with the remaining signature count", async () => {
    const { prisma, service } = setup();
    prisma.treasuryProposal.findFirst.mockResolvedValue(
      proposal({ requiredSigs: 3 }),
    );
    prisma.treasuryProposal.update.mockResolvedValue(
      proposal({
        requiredSigs: 3,
        currentSigs: 1,
        approvedBy: [signer],
        status: "PENDING",
      }),
    );
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: unknown) => Promise<unknown>) =>
        callback({ treasuryProposal: prisma.treasuryProposal }),
    );
    await expect(
      service.approveProposal("proposal-1", signer, "business-1"),
    ).resolves.toEqual({
      approved: false,
      remainingApprovals: 2,
      status: "PENDING",
    });
  });

  it("distinguishes serialization conflicts from generic approval persistence failures", async () => {
    const serialization = setup();
    serialization.prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("serialization conflict", {
        code: "P2034",
        clientVersion: "5.8.1",
      }),
    );
    await expect(
      serialization.service.approveProposal("proposal-1", signer, "business-1"),
    ).rejects.toMatchObject({ code: "APPROVAL_CONFLICT", statusCode: 409 });

    const failure = setup();
    const cause = new Error("database unavailable");
    failure.prisma.$transaction.mockRejectedValue(cause);
    await expect(
      failure.service.approveProposal("proposal-1", signer, "business-1"),
    ).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE", cause });
  });

  it("validates absent, daily, monthly, and allowed spending policies", async () => {
    const { prisma, service } = setup();
    prisma.spendingPolicy.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(policy())
      .mockResolvedValueOnce(policy())
      .mockResolvedValueOnce(policy());
    await expect(
      service.validateSpendingPolicy("10", "OPERATIONS", {
        daily: "0",
        monthly: "0",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("No active"),
    });
    await expect(
      service.validateSpendingPolicy("100", "OPERATIONS", {
        daily: "950",
        monthly: "0",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Daily"),
    });
    await expect(
      service.validateSpendingPolicy("100", "OPERATIONS", {
        daily: "0",
        monthly: "9950",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Monthly"),
    });
    await expect(
      service.validateSpendingPolicy("100", "OPERATIONS", {
        daily: "0",
        monthly: "0",
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it("updates a durable spending policy and conceals a missing category", async () => {
    const { prisma, service } = setup();
    prisma.spendingPolicy.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.updateSpendingPolicy("OPERATIONS", { active: false }),
    ).rejects.toMatchObject({ code: "POLICY_NOT_FOUND", statusCode: 404 });

    prisma.spendingPolicy.findFirst.mockResolvedValueOnce(policy());
    prisma.spendingPolicy.update.mockResolvedValue(
      policy({
        dailyLimit: new Prisma.Decimal("2000"),
        monthlyLimit: new Prisma.Decimal("20000"),
        requiresMultiSig: false,
        approvalThreshold: 1,
        isActive: false,
      }),
    );
    const updated = await service.updateSpendingPolicy("INFRASTRUCTURE", {
      dailyLimit: "2000",
      monthlyLimit: "20000",
      requiresApproval: false,
      minApprovals: 1,
      active: false,
    });
    expect(updated).toMatchObject({
      dailyLimit: "2000",
      monthlyLimit: "20000",
      active: false,
    });
  });

  it.each(["day", "week", "month", "quarter"] as const)(
    "derives %s analytics from executed proposals and recorded yield",
    async (period) => {
      const { prisma, service } = setup();
      prisma.treasuryProposal.findMany.mockResolvedValue([
        proposal({ id: "no-amount", status: "EXECUTED", amount: null }),
        proposal({
          id: "ops",
          status: "EXECUTED",
          amount: new Prisma.Decimal("300"),
          metadata: { category: "OPERATIONS" },
        }),
        proposal({
          id: "infra",
          status: "EXECUTED",
          amount: new Prisma.Decimal("200"),
          metadata: { category: "INFRASTRUCTURE" },
        }),
        proposal({
          id: "uncategorized",
          status: "EXECUTED",
          amount: new Prisma.Decimal("100"),
          metadata: { category: "INVALID" },
        }),
      ]);
      prisma.yieldStrategy.findMany.mockResolvedValue([
        strategy({ totalYieldEarned: new Prisma.Decimal("25") }),
        strategy({
          id: "strategy-2",
          totalYieldEarned: new Prisma.Decimal("5"),
        }),
      ]);
      const analytics = await service.getAnalytics("business-1", period);
      expect(analytics).toMatchObject({
        period,
        businessId: "business-1",
        totalOutflows: "600",
        yieldGenerated: "30",
      });
      expect(analytics.topCategories).toEqual([
        { category: "OPERATIONS", amount: "300", percentage: 50 },
        { category: "INFRASTRUCTURE", amount: "200", percentage: 100 / 3 },
      ]);
    },
  );

  it("preserves the default error status and optional cause behavior", () => {
    const withoutCause = new TreasuryError("INVALID", "invalid");
    expect(withoutCause).toMatchObject({ statusCode: 400 });
    expect(withoutCause).not.toHaveProperty("cause");
  });
});
