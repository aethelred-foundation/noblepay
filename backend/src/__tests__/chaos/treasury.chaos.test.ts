import { Prisma } from "@prisma/client";
import { TreasuryService } from "../../services/treasury";

const BUSINESS_ID = "business-chaos";
const SIGNER = "0x1111111111111111111111111111111111111111";
const NOW = new Date("2026-07-21T12:00:00.000Z");

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "proposal-chaos",
    type: "TRANSFER",
    title: "Chaos transfer",
    description: "Exercise durable failure boundaries",
    amount: new Prisma.Decimal("500"),
    currency: "USDC",
    recipient: "0x2222222222222222222222222222222222222222",
    status: "PENDING",
    requiredSigs: 2,
    currentSigs: 0,
    signers: [],
    approvedBy: [],
    timelockUntil: null,
    createdBy: SIGNER,
    businessId: BUSINESS_ID,
    expiresAt: new Date("2026-07-28T12:00:00.000Z"),
    executedAt: null,
    createdAt: NOW,
    metadata: { category: "OPERATIONS" },
    ...overrides,
  } as any;
}

function setup() {
  const prisma: any = {
    spendingPolicy: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
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
  const audit = { createAuditEntry: jest.fn().mockResolvedValue({}) };
  prisma.$transaction.mockImplementation(
    async (operation: (tx: any) => unknown) => operation(prisma),
  );
  prisma.spendingPolicy.findFirst.mockResolvedValue({
    category: "OPERATIONS",
    requiresMultiSig: true,
    approvalThreshold: 2,
    isActive: true,
  });
  return { prisma, audit, service: new TreasuryService(prisma, audit as any) };
}

const validInput = {
  title: "Chaos transfer",
  description: "Exercise durable failure boundaries",
  type: "TRANSFER" as const,
  amount: "500",
  currency: "USDC",
  recipient: "0x2222222222222222222222222222222222222222",
  category: "OPERATIONS" as const,
};

describe("Treasury durable chaos boundaries", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(NOW));
  afterEach(() => jest.useRealTimers());

  it("returns a typed service-unavailable error when proposal persistence fails", async () => {
    const { prisma, service } = setup();
    prisma.treasuryProposal.create.mockRejectedValue(
      new Error("database unavailable"),
    );
    await expect(
      service.createProposal(validInput, SIGNER, BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_FAILURE",
      statusCode: 503,
    });
  });

  it("does not attempt persistence when policy storage has no active monetary policy", async () => {
    const { prisma, service } = setup();
    prisma.spendingPolicy.findFirst.mockResolvedValue(null);
    await expect(
      service.createProposal(validInput, SIGNER, BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "POLICY_NOT_FOUND",
      statusCode: 409,
    });
    expect(prisma.treasuryProposal.create).not.toHaveBeenCalled();
  });

  it("rejects positive-zero monetary values before any database lookup", async () => {
    const { prisma, service } = setup();
    await expect(
      service.createProposal(
        { ...validInput, amount: "0" },
        SIGNER,
        BUSINESS_ID,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_MONETARY_PROPOSAL",
      statusCode: 400,
    });
    expect(prisma.spendingPolicy.findFirst).not.toHaveBeenCalled();
  });

  it("conceals missing or foreign proposals during approval", async () => {
    const { prisma, service } = setup();
    prisma.treasuryProposal.findFirst.mockResolvedValue(null);
    await expect(
      service.approveProposal("proposal-foreign", SIGNER, BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "PROPOSAL_NOT_FOUND",
      statusCode: 404,
    });
    expect(prisma.treasuryProposal.findFirst).toHaveBeenCalledWith({
      where: { id: "proposal-foreign", businessId: BUSINESS_ID },
    });
  });

  it("translates a transaction outage into a typed persistence failure", async () => {
    const { prisma, service } = setup();
    prisma.$transaction.mockRejectedValue(
      new Error("serialization connection lost"),
    );
    await expect(
      service.approveProposal("proposal-chaos", SIGNER, BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "PERSISTENCE_FAILURE",
      statusCode: 503,
    });
  });

  it("durably expires a stale proposal and refuses its approval", async () => {
    const { prisma, service } = setup();
    prisma.treasuryProposal.findFirst.mockResolvedValue(
      proposal({ expiresAt: new Date("2026-07-20T00:00:00.000Z") }),
    );
    prisma.treasuryProposal.update.mockResolvedValue(
      proposal({ status: "EXPIRED" }),
    );
    await expect(
      service.approveProposal("proposal-chaos", SIGNER, BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "PROPOSAL_EXPIRED",
      statusCode: 409,
    });
    expect(prisma.treasuryProposal.update).toHaveBeenCalledWith({
      where: { id: "proposal-chaos" },
      data: { status: "EXPIRED" },
    });
  });

  it("rejects a duplicate signer inside the serializable transaction", async () => {
    const { prisma, service } = setup();
    prisma.treasuryProposal.findFirst.mockResolvedValue(
      proposal({ approvedBy: [SIGNER], currentSigs: 1 }),
    );
    await expect(
      service.approveProposal("proposal-chaos", SIGNER, BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "DUPLICATE_APPROVAL",
      statusCode: 409,
    });
    expect(prisma.treasuryProposal.update).not.toHaveBeenCalled();
  });

  it("does not accept another approval after a competing transaction reached threshold", async () => {
    const { prisma, service } = setup();
    prisma.treasuryProposal.findFirst.mockResolvedValue(
      proposal({
        status: "APPROVED",
        approvedBy: ["signer-a", "signer-b"],
        currentSigs: 2,
      }),
    );
    await expect(
      service.approveProposal("proposal-chaos", "signer-c", BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "INVALID_STATE",
      statusCode: 409,
    });
    expect(prisma.treasuryProposal.update).not.toHaveBeenCalled();
  });

  it("never performs a DB-only execution when receipt verification is unavailable", async () => {
    const { prisma, service } = setup();
    await expect(
      service.executeProposal("proposal-chaos", SIGNER, BUSINESS_ID),
    ).rejects.toMatchObject({
      code: "TREASURY_EXECUTION_UNAVAILABLE",
      statusCode: 501,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.treasuryProposal.update).not.toHaveBeenCalled();
  });

  it("keeps list reads tenant-scoped when no records are available", async () => {
    const { prisma, service } = setup();
    prisma.treasuryProposal.findMany.mockResolvedValue([]);
    await expect(
      service.listProposals(BUSINESS_ID, "PENDING", { page: 100, limit: 100 }),
    ).resolves.toEqual([]);
    expect(prisma.treasuryProposal.findMany).toHaveBeenCalledWith({
      where: { businessId: BUSINESS_ID, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      skip: 9900,
      take: 100,
    });
  });
});
