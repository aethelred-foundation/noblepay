import { AuditService } from "../../services/audit";

describe("AuditService canonical tenant chain", () => {
  it("serializes tenant writes and detects content tampering", async () => {
    const entries: any[] = [];
    const transaction: any = {
      $executeRaw: jest.fn(),
      auditLog: {
        findFirst: jest.fn(async () => {
          const previous = entries[entries.length - 1];
          return previous ? { entryHash: previous.entryHash } : null;
        }),
        create: jest.fn(async ({ data }: any) => {
          const entry = { id: `entry-${entries.length + 1}`, ...data };
          entries.push(entry);
          return entry;
        }),
      },
    };
    const prisma: any = {
      $transaction: jest.fn(async (callback: (database: any) => unknown) =>
        callback(transaction),
      ),
      auditLog: {
        count: jest.fn(async () => entries.length),
        findMany: jest.fn(async () => entries),
      },
    };
    const service = new AuditService(prisma);

    await service.createAuditEntry({
      businessId: "biz-1",
      eventType: "PAYMENT_CREATED",
      actor: "wallet:1",
      description: "Payment created",
      metadata: { amount: "10", nested: { currency: "USDC" } },
    });
    await service.createAuditEntry({
      businessId: "biz-1",
      eventType: "COMPLIANCE_PASSED",
      actor: "tee:1",
      description: "Compliance passed",
    });

    await expect(service.verifyChainIntegrity("biz-1")).resolves.toMatchObject({
      intact: true,
      totalEntries: 2,
      verified: 2,
    });
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(2);

    entries[0].description = "tampered";
    await expect(service.verifyChainIntegrity("biz-1")).resolves.toMatchObject({
      intact: false,
      brokenAt: "entry-1",
    });
  });
});
