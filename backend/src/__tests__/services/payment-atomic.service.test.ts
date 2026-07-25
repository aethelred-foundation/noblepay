import { Prisma } from "@prisma/client";
import { PaymentService } from "../../services/payment";

const SENDER = "0x1000000000000000000000000000000000000001";
const RECIPIENT = "0x2000000000000000000000000000000000000002";

function harness(
  options: { existing?: any; daily?: string; monthly?: string } = {},
) {
  const payment = {
    id: "payment-1",
    paymentId: `0x${"ab".repeat(32)}`,
    sender: SENDER,
    recipient: RECIPIENT,
    amount: new Prisma.Decimal("100"),
    currency: "USDC",
    purposeHash: null,
    status: "PENDING",
    riskScore: null,
    teeAttestation: null,
    initiatedAt: new Date(),
    screenedAt: null,
    settledAt: null,
    refundedAt: null,
    blockNumber: null,
    txHash: null,
    businessId: "biz-1",
    idempotencyKey: "request-key-123",
  };
  const database: any = {
    $executeRaw: jest.fn(),
    business: {
      findUnique: jest.fn().mockResolvedValue({
        id: "biz-1",
        address: SENDER,
        kycStatus: "VERIFIED",
        dailyLimit: new Prisma.Decimal("1000"),
        monthlyLimit: new Prisma.Decimal("5000"),
      }),
    },
    payment: {
      findFirst: jest.fn().mockResolvedValue(options.existing || null),
      aggregate: jest
        .fn()
        .mockResolvedValueOnce({
          _sum: {
            amount: options.daily ? new Prisma.Decimal(options.daily) : null,
          },
        })
        .mockResolvedValueOnce({
          _sum: {
            amount: options.monthly
              ? new Prisma.Decimal(options.monthly)
              : null,
          },
        }),
      create: jest.fn().mockResolvedValue(payment),
    },
    auditLog: {},
  };
  const prisma: any = {
    $transaction: jest.fn(async (callback: (transaction: any) => unknown) =>
      callback(database),
    ),
  };
  const audit: any = {
    createAuditEntryInTransaction: jest.fn().mockResolvedValue({}),
  };
  return {
    service: new PaymentService(prisma, audit),
    database,
    audit,
    payment,
  };
}

describe("PaymentService retired database-only creation", () => {
  it("requires a verified on-chain receipt instead of opening a transaction", async () => {
    const { service, database, audit } = harness();

    await expect(
      service.createPaymentWithIdempotency(
        {
          sender: SENDER,
          recipient: RECIPIENT,
          amount: "100",
          currency: "USDC",
        },
        "biz-1",
        "request-key-123",
      ),
    ).rejects.toMatchObject({
      code: "ON_CHAIN_INITIATION_REQUIRED",
      statusCode: 410,
    });

    expect(database.payment.create).not.toHaveBeenCalled();
    expect(audit.createAuditEntryInTransaction).not.toHaveBeenCalled();
  });

  it("does not replay an old off-chain idempotency record", async () => {
    const initial = harness();
    const { service, database, audit, payment } = harness({
      existing: initial.payment,
    });

    await expect(
      service.createPaymentWithIdempotency(
        {
          sender: SENDER,
          recipient: RECIPIENT,
          amount: "100",
          currency: "USDC",
        },
        "biz-1",
        "request-key-123",
      ),
    ).rejects.toMatchObject({
      code: "ON_CHAIN_INITIATION_REQUIRED",
    });

    expect(payment).toBeDefined();
    expect(database.payment.create).not.toHaveBeenCalled();
    expect(audit.createAuditEntryInTransaction).not.toHaveBeenCalled();
  });

  it("does not expose different pre-reconciliation errors for sender probes", async () => {
    const { service, database } = harness();

    await expect(
      service.createPaymentWithIdempotency(
        {
          sender: "0x3000000000000000000000000000000000000003",
          recipient: RECIPIENT,
          amount: "100",
          currency: "USDC",
        },
        "biz-1",
        "request-key-123",
      ),
    ).rejects.toMatchObject({
      code: "ON_CHAIN_INITIATION_REQUIRED",
      statusCode: 410,
    });
    expect(database.payment.create).not.toHaveBeenCalled();
  });

  it("does not accept idempotency keys as a substitute for transaction proofs", async () => {
    const initial = harness();
    const { service } = harness({ existing: initial.payment });

    await expect(
      service.createPaymentWithIdempotency(
        {
          sender: SENDER,
          recipient: RECIPIENT,
          amount: "101",
          currency: "USDC",
        },
        "biz-1",
        "request-key-123",
      ),
    ).rejects.toMatchObject({
      code: "ON_CHAIN_INITIATION_REQUIRED",
      statusCode: 410,
    });
  });
});
