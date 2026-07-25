import { ComplianceError, ComplianceService } from "../../services/compliance";
import { createMockPrisma, resetAllMocks } from "../setup";

const PAYMENT_ID = `0x${"a".repeat(64)}`;
const TX_HASH = `0x${"b".repeat(64)}`;

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    paymentId: PAYMENT_ID,
    businessId: "biz-1",
    sender: "0x1111111111111111111111111111111111111111",
    recipient: "0x2222222222222222222222222222222222222222",
    amount: { toString: () => "100" },
    currency: "USDC",
    purposeHash: null,
    status: "PENDING",
    initiatedAt: new Date("2026-07-21T00:00:00.000Z"),
    ...overrides,
  };
}

describe("ComplianceService", () => {
  const originalUrl = process.env.COMPLIANCE_API_URL;
  const originalKey = process.env.COMPLIANCE_API_KEY;
  let prisma: ReturnType<typeof createMockPrisma>;
  let audit: {
    createAuditEntry: jest.Mock;
    createAuditEntryInTransaction: jest.Mock;
  };
  let service: ComplianceService;

  beforeEach(() => {
    resetAllMocks();
    delete process.env.COMPLIANCE_API_URL;
    delete process.env.COMPLIANCE_API_KEY;
    prisma = createMockPrisma();
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: typeof prisma) => unknown) =>
        callback(prisma),
    );
    prisma.complianceSubmissionIntent.upsert.mockImplementation(
      ({ create }: { create: Record<string, unknown> }) => ({
        ...create,
        state: "PENDING",
      }),
    );
    prisma.complianceSubmissionIntent.updateMany.mockResolvedValue({
      count: 1,
    });
    audit = {
      createAuditEntry: jest.fn().mockResolvedValue({}),
      createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
    };
    service = new ComplianceService(
      prisma,
      audit as never,
      {
        verify: jest.fn(),
      } as never,
    );
  });

  afterAll(() => {
    if (originalUrl === undefined) delete process.env.COMPLIANCE_API_URL;
    else process.env.COMPLIANCE_API_URL = originalUrl;
    if (originalKey === undefined) delete process.env.COMPLIANCE_API_KEY;
    else process.env.COMPLIANCE_API_KEY = originalKey;
  });

  describe("submitForScreening", () => {
    it("tenant-scopes payment lookup and conceals missing payments", async () => {
      prisma.payment.findFirst.mockResolvedValue(null);

      await expect(
        service.submitForScreening(
          {
            paymentId: "11111111-1111-4111-8111-111111111111",
            priority: "normal",
          },
          "biz-1",
        ),
      ).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND", statusCode: 404 });
      expect(prisma.payment.findFirst).toHaveBeenCalledWith({
        where: {
          id: "11111111-1111-4111-8111-111111111111",
          businessId: "biz-1",
        },
      });
    });

    it("rejects a non-pending payment without verified screening evidence", async () => {
      prisma.payment.findFirst.mockResolvedValue(
        payment({ status: "SETTLED" }),
      );
      prisma.complianceScreening.findFirst.mockResolvedValue(null);
      prisma.complianceSubmissionIntent.findUnique.mockResolvedValue(null);

      await expect(
        service.submitForScreening(
          {
            paymentId: "11111111-1111-4111-8111-111111111111",
            priority: "high",
          },
          "biz-1",
        ),
      ).rejects.toMatchObject({ code: "INVALID_STATE", statusCode: 409 });
    });

    it("replays only an existing screening backed by a submission transaction", async () => {
      prisma.payment.findFirst.mockResolvedValue(
        payment({ status: "APPROVED" }),
      );
      prisma.complianceScreening.findFirst.mockResolvedValue({
        id: "screen-1",
        sanctionsClear: true,
        amlRiskScore: 10,
        travelRuleCompliant: true,
        status: "PASSED",
        flagReason: null,
        screenedBy: "0x3333333333333333333333333333333333333333",
        screeningDuration: 25,
        submissionTxHash: TX_HASH,
        submissionBlockNumber: 90n,
      });
      prisma.complianceSubmissionIntent.findUnique.mockResolvedValue({
        paymentId: "11111111-1111-4111-8111-111111111111",
        requestId: "11111111-1111-4111-8111-111111111111",
        state: "COMPLETED",
        submissionTxHash: TX_HASH,
        confirmations: 4,
      });

      await expect(
        service.submitForScreening(
          {
            paymentId: "11111111-1111-4111-8111-111111111111",
            priority: "normal",
          },
          "biz-1",
        ),
      ).resolves.toMatchObject({
        paymentId: PAYMENT_ID,
        status: "PASSED",
        submissionTxHash: TX_HASH,
        submissionBlockNumber: "90",
        confirmations: 4,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("fails closed when the audited submission service is not configured", async () => {
      prisma.payment.findFirst.mockResolvedValue(payment());

      await expect(
        service.submitForScreening(
          {
            paymentId: "11111111-1111-4111-8111-111111111111",
            priority: "urgent",
          },
          "biz-1",
        ),
      ).rejects.toMatchObject({
        code: "COMPLIANCE_SUBMISSION_NOT_CONFIGURED",
        statusCode: 501,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  it("returns screening history only through a tenant relation", async () => {
    prisma.complianceScreening.findMany.mockResolvedValue([{ id: "screen-1" }]);

    await expect(
      service.getScreeningResult(PAYMENT_ID, "biz-1"),
    ).resolves.toEqual([{ id: "screen-1" }]);
    expect(prisma.complianceScreening.findMany).toHaveBeenCalledWith({
      where: { paymentId: PAYMENT_ID, payment: { businessId: "biz-1" } },
      orderBy: { createdAt: "desc" },
    });
  });

  it("returns 404 when a tenant has no screening history", async () => {
    prisma.complianceScreening.findMany.mockResolvedValue([]);
    await expect(
      service.getScreeningResult(PAYMENT_ID, "biz-1"),
    ).rejects.toMatchObject({
      code: "SCREENING_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("computes tenant-scoped compliance metrics", async () => {
    prisma.complianceScreening.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    prisma.complianceScreening.aggregate
      .mockResolvedValueOnce({ _avg: { amlRiskScore: 17 } })
      .mockResolvedValueOnce({ _avg: { screeningDuration: 42 } });
    prisma.payment.count.mockResolvedValue(2);

    await expect(service.getComplianceMetrics("biz-1")).resolves.toEqual({
      totalScreenings: 10,
      passedScreenings: 8,
      failedScreenings: 1,
      averageRiskScore: 17,
      averageScreeningDuration: 42,
      passRate: 0.8,
      flaggedCount: 2,
      underReviewCount: 1,
    });
  });

  it("returns zero-safe metrics when no screenings have been recorded", async () => {
    prisma.complianceScreening.count.mockResolvedValue(0);
    prisma.complianceScreening.aggregate
      .mockResolvedValueOnce({ _avg: { amlRiskScore: null } })
      .mockResolvedValueOnce({ _avg: { screeningDuration: null } });
    prisma.payment.count.mockResolvedValue(0);

    await expect(service.getComplianceMetrics()).resolves.toEqual({
      totalScreenings: 0,
      passedScreenings: 0,
      failedScreenings: 0,
      averageRiskScore: 0,
      averageScreeningDuration: 0,
      passRate: 0,
      flaggedCount: 0,
      underReviewCount: 0,
    });
  });

  it("tenant-scopes and paginates the flagged queue", async () => {
    prisma.payment.findMany.mockResolvedValue([payment({ status: "FLAGGED" })]);
    prisma.payment.count.mockResolvedValue(21);

    const result = await service.getFlaggedPayments("biz-1", 2, 20);

    expect(result.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 21,
      totalPages: 2,
    });
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId: "biz-1", status: "FLAGGED" },
        skip: 20,
        take: 20,
      }),
    );
  });

  it("supports the legacy numeric flagged-queue pagination without granting a tenant", async () => {
    prisma.payment.findMany.mockResolvedValue([]);
    prisma.payment.count.mockResolvedValue(0);
    const result = await service.getFlaggedPayments(2, 5);
    expect(result.pagination).toEqual({
      page: 2,
      limit: 5,
      total: 0,
      totalPages: 0,
    });
    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { businessId: "__unauthenticated__", status: "FLAGGED" },
        skip: 5,
        take: 5,
      }),
    );
  });

  it("rejects review when the tenant payment is not flagged", async () => {
    prisma.payment.findFirst.mockResolvedValue(payment({ status: "PENDING" }));
    await expect(
      service.reviewFlaggedPayment(
        "11111111-1111-4111-8111-111111111111",
        "escalate",
        "reason",
        "reviewer",
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE", statusCode: 409 });
  });

  it("conceals a missing payment from the review workflow", async () => {
    prisma.payment.findFirst.mockResolvedValue(null);
    await expect(
      service.reviewFlaggedPayment(
        "11111111-1111-4111-8111-111111111111",
        "escalate",
        "reason",
        "reviewer",
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND", statusCode: 404 });
  });

  it("requires a verified screening before escalating a flagged payment", async () => {
    prisma.payment.findFirst.mockResolvedValue(payment({ status: "FLAGGED" }));
    prisma.complianceScreening.findFirst.mockResolvedValue(null);
    await expect(
      service.reviewFlaggedPayment(
        "11111111-1111-4111-8111-111111111111",
        "escalate",
        "reason",
        "reviewer",
        "biz-1",
      ),
    ).rejects.toMatchObject({ code: "SCREENING_NOT_FOUND", statusCode: 404 });
  });

  it("persists a tenant escalation and its audit atomically", async () => {
    prisma.payment.findFirst.mockResolvedValue(payment({ status: "FLAGGED" }));
    prisma.complianceScreening.findFirst.mockResolvedValue({ id: "screen-1" });
    prisma.complianceScreening.update.mockResolvedValue({ id: "screen-1" });

    const result = await service.reviewFlaggedPayment(
      "11111111-1111-4111-8111-111111111111",
      "escalate",
      "manual resolution needed",
      "reviewer",
      "biz-1",
    );

    expect(prisma.complianceScreening.update).toHaveBeenCalledWith({
      where: { id: "screen-1" },
      data: { status: "ESCALATED", flagReason: "manual resolution needed" },
    });
    expect(audit.createAuditEntryInTransaction).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        businessId: "biz-1",
        eventType: "COMPLIANCE_ESCALATED",
      }),
    );
    expect(result).toMatchObject({
      decision: "escalate",
      newStatus: "FLAGGED",
    });
  });

  it("fails sanctions health closed when the external service is not configured", async () => {
    await expect(service.getSanctionsStatus()).rejects.toMatchObject({
      code: "SANCTIONS_SERVICE_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("treats an invalid external compliance origin as unconfigured", async () => {
    process.env.COMPLIANCE_API_URL = "http://localhost:3000";
    await expect(service.getSanctionsStatus()).rejects.toMatchObject({
      code: "SANCTIONS_SERVICE_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("fails sanctions refresh closed without both URL and credential", async () => {
    await expect(service.updateSanctionsList("admin")).rejects.toBeInstanceOf(
      ComplianceError,
    );
    expect(audit.createAuditEntry).not.toHaveBeenCalled();
  });
});
