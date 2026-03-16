import { createMockPrisma, resetAllMocks, mockLogger } from "../setup";
import { AuditService } from "../../services/audit";

let prisma: ReturnType<typeof createMockPrisma>;
let auditService: AuditService;

beforeEach(() => {
  resetAllMocks();
  prisma = createMockPrisma();
  auditService = new AuditService(prisma);
});

describe("AuditService", () => {
  // ─── createAuditEntry ────────────────────────────────────────────────────

  describe("createAuditEntry", () => {
    it("should create an entry with hash chaining", async () => {
      prisma.auditLog.findFirst.mockResolvedValue({
        eventId: "0xprevioushash",
      });
      prisma.auditLog.create.mockResolvedValue({
        id: "entry-1",
        eventId: "0xnewhash",
        eventType: "PAYMENT_CREATED",
      });

      const result = await auditService.createAuditEntry({
        eventType: "PAYMENT_CREATED",
        actor: "0x123",
        description: "Test payment",
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: "PAYMENT_CREATED",
          actor: "0x123",
          description: "Test payment",
          severity: "INFO",
          previousHash: "0xprevioushash",
          eventId: expect.stringMatching(/^0x[a-f0-9]{64}$/),
        }),
      });
      expect(result).toBeDefined();
    });

    it("should use genesis hash when no previous entry exists", async () => {
      prisma.auditLog.findFirst.mockResolvedValue(null);
      prisma.auditLog.create.mockResolvedValue({ id: "1" });

      await auditService.createAuditEntry({
        eventType: "SYSTEM_EVENT",
        actor: "system",
        description: "First entry",
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          previousHash: "0x" + "0".repeat(64),
        }),
      });
    });

    it("should use provided severity", async () => {
      prisma.auditLog.findFirst.mockResolvedValue(null);
      prisma.auditLog.create.mockResolvedValue({ id: "1" });

      await auditService.createAuditEntry({
        eventType: "COMPLIANCE_FAILED",
        actor: "tee-1",
        description: "Failed screening",
        severity: "HIGH",
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ severity: "HIGH" }),
      });
    });

    it("should store optional blockNumber and txHash", async () => {
      prisma.auditLog.findFirst.mockResolvedValue(null);
      prisma.auditLog.create.mockResolvedValue({ id: "1" });

      await auditService.createAuditEntry({
        eventType: "PAYMENT_SETTLED",
        actor: "0x123",
        description: "Settled",
        blockNumber: BigInt(12345),
        txHash: "0xtxhash",
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          blockNumber: BigInt(12345),
          txHash: "0xtxhash",
        }),
      });
    });

    it("should store metadata as JSON", async () => {
      prisma.auditLog.findFirst.mockResolvedValue(null);
      prisma.auditLog.create.mockResolvedValue({ id: "1" });

      await auditService.createAuditEntry({
        eventType: "PAYMENT_CREATED",
        actor: "0x123",
        description: "Created",
        metadata: { paymentId: "pay-1", amount: "100" },
      });

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: { paymentId: "pay-1", amount: "100" },
        }),
      });
    });
  });

  // ─── getAuditEntry ─────────────────────────────────────────────────────────

  describe("getAuditEntry", () => {
    it("should look up by eventId when id starts with 0x", async () => {
      const hash = "0x" + "a".repeat(64);
      prisma.auditLog.findUnique.mockResolvedValue({ id: "1", eventId: hash });

      await auditService.getAuditEntry(hash);

      expect(prisma.auditLog.findUnique).toHaveBeenCalledWith({
        where: { eventId: hash },
      });
    });

    it("should look up by UUID when id does not start with 0x", async () => {
      prisma.auditLog.findUnique.mockResolvedValue({ id: "uuid-1" });

      await auditService.getAuditEntry("uuid-1");

      expect(prisma.auditLog.findUnique).toHaveBeenCalledWith({
        where: { id: "uuid-1" },
      });
    });

    it("should return null when not found", async () => {
      prisma.auditLog.findUnique.mockResolvedValue(null);
      const result = await auditService.getAuditEntry("missing");
      expect(result).toBeNull();
    });
  });

  // ─── listAuditEntries ──────────────────────────────────────────────────────

  describe("listAuditEntries", () => {
    it("should return paginated entries", async () => {
      prisma.auditLog.findMany.mockResolvedValue([{ id: "1" }]);
      prisma.auditLog.count.mockResolvedValue(1);

      const result = await auditService.listAuditEntries({
        page: 1,
        limit: 20,
        sortOrder: "desc",
      });

      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.totalPages).toBe(1);
    });

    it("should apply eventType filter", async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      await auditService.listAuditEntries({
        page: 1,
        limit: 20,
        sortOrder: "desc",
        eventType: "PAYMENT_CREATED",
      });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ eventType: "PAYMENT_CREATED" }),
        }),
      );
    });

    it("should apply severity filter", async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      await auditService.listAuditEntries({
        page: 1,
        limit: 20,
        sortOrder: "desc",
        severity: "HIGH",
      });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ severity: "HIGH" }),
        }),
      );
    });

    it("should apply actor filter with case-insensitive contains", async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      await auditService.listAuditEntries({
        page: 1,
        limit: 20,
        sortOrder: "desc",
        actor: "0x123",
      });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            actor: { contains: "0x123", mode: "insensitive" },
          }),
        }),
      );
    });

    it("should apply date range filters", async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      await auditService.listAuditEntries({
        page: 1,
        limit: 20,
        sortOrder: "desc",
        from: "2024-01-01T00:00:00Z",
        to: "2024-12-31T23:59:59Z",
      });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: expect.objectContaining({
              gte: expect.any(Date),
              lte: expect.any(Date),
            }),
          }),
        }),
      );
    });
  });

  // ─── verifyChainIntegrity ──────────────────────────────────────────────────

  describe("verifyChainIntegrity", () => {
    it("should return intact:true with no entries", async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);

      const result = await auditService.verifyChainIntegrity();

      expect(result.intact).toBe(true);
      expect(result.totalEntries).toBe(0);
    });

    it("should return intact:true with valid chain", async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        { id: "1", eventId: "0xaaa", previousHash: "0x" + "0".repeat(64) },
        { id: "2", eventId: "0xbbb", previousHash: "0xaaa" },
        { id: "3", eventId: "0xccc", previousHash: "0xbbb" },
      ]);

      const result = await auditService.verifyChainIntegrity();

      expect(result.intact).toBe(true);
      expect(result.totalEntries).toBe(3);
      expect(result.verified).toBe(2);
    });

    it("should detect broken chain", async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        { id: "1", eventId: "0xaaa", previousHash: "0x" + "0".repeat(64) },
        { id: "2", eventId: "0xbbb", previousHash: "0xWRONG" },
        { id: "3", eventId: "0xccc", previousHash: "0xbbb" },
      ]);

      const result = await auditService.verifyChainIntegrity();

      expect(result.intact).toBe(false);
      expect(result.brokenAt).toBe("2");
      expect(result.message).toContain("Chain broken");
    });
  });

  // ─── generateExport ────────────────────────────────────────────────────────

  describe("generateExport", () => {
    const sampleEntries = [
      {
        eventId: "0xaaa",
        eventType: "PAYMENT_CREATED",
        actor: "0x123",
        description: "Created payment",
        severity: "INFO",
        blockNumber: null,
        txHash: null,
        previousHash: "0x" + "0".repeat(64),
        createdAt: new Date("2024-06-01T10:00:00Z"),
        metadata: { test: true },
      },
    ];

    it("should generate JSON export", async () => {
      prisma.auditLog.findMany.mockResolvedValue(sampleEntries);

      const result = await auditService.generateExport({
        format: "json",
        from: "2024-01-01T00:00:00Z",
        to: "2024-12-31T23:59:59Z",
      });

      expect(result.format).toBe("json");
      expect(result.entries).toBe(1);
      const parsed = JSON.parse(result.data);
      expect(parsed.totalEntries).toBe(1);
      expect(parsed.entries[0].eventId).toBe("0xaaa");
    });

    it("should generate CSV export", async () => {
      prisma.auditLog.findMany.mockResolvedValue(sampleEntries);

      const result = await auditService.generateExport({
        format: "csv",
        from: "2024-01-01T00:00:00Z",
        to: "2024-12-31T23:59:59Z",
      });

      expect(result.format).toBe("csv");
      const lines = result.data.split("\n");
      expect(lines[0]).toContain("eventId");
      expect(lines).toHaveLength(2); // header + 1 row
    });

    it("should include metadata when requested", async () => {
      prisma.auditLog.findMany.mockResolvedValue(sampleEntries);

      const result = await auditService.generateExport({
        format: "json",
        from: "2024-01-01T00:00:00Z",
        to: "2024-12-31T23:59:59Z",
        includeMetadata: true,
      });

      const parsed = JSON.parse(result.data);
      expect(parsed.entries[0].metadata).toEqual({ test: true });
    });

    it("should include metadata column in CSV when requested", async () => {
      prisma.auditLog.findMany.mockResolvedValue(sampleEntries);

      const result = await auditService.generateExport({
        format: "csv",
        from: "2024-01-01T00:00:00Z",
        to: "2024-12-31T23:59:59Z",
        includeMetadata: true,
      });

      const header = result.data.split("\n")[0];
      expect(header).toContain("metadata");
    });

    it("should handle blockNumber in CSV export", async () => {
      const entriesWithBlockNumber = [
        {
          ...sampleEntries[0],
          blockNumber: BigInt(42),
          txHash: "0xtxhash123",
        },
      ];
      prisma.auditLog.findMany.mockResolvedValue(entriesWithBlockNumber);

      const result = await auditService.generateExport({
        format: "csv",
        from: "2024-01-01T00:00:00Z",
        to: "2024-12-31T23:59:59Z",
      });

      expect(result.data).toContain("42");
      expect(result.data).toContain("0xtxhash123");
    });

    it("should handle null metadata in CSV export with includeMetadata", async () => {
      const entriesNoMetadata = [
        {
          ...sampleEntries[0],
          metadata: null,
        },
      ];
      prisma.auditLog.findMany.mockResolvedValue(entriesNoMetadata);

      const result = await auditService.generateExport({
        format: "csv",
        from: "2024-01-01T00:00:00Z",
        to: "2024-12-31T23:59:59Z",
        includeMetadata: true,
      });

      const lines = result.data.split("\n");
      expect(lines[0]).toContain("metadata");
      // The metadata column should be empty string for null
      expect(lines).toHaveLength(2);
    });

    it("should handle null previousHash in CSV export", async () => {
      const entriesNullPrevHash = [
        {
          eventId: "0xaaa",
          eventType: "PAYMENT_CREATED",
          actor: "0x123",
          description: "Created payment",
          severity: "INFO",
          blockNumber: null,
          txHash: null,
          previousHash: null,
          createdAt: new Date("2024-06-01T10:00:00Z"),
          metadata: null,
        },
      ];
      prisma.auditLog.findMany.mockResolvedValue(entriesNullPrevHash);

      const result = await auditService.generateExport({
        format: "csv",
        from: "2024-01-01T00:00:00Z",
        to: "2024-12-31T23:59:59Z",
      });

      const lines = result.data.split("\n");
      expect(lines).toHaveLength(2);
      // The previousHash field should be empty string
      const dataRow = lines[1];
      expect(dataRow).toBeDefined();
    });

    it("should filter by eventTypes", async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);

      await auditService.generateExport({
        format: "json",
        from: "2024-01-01T00:00:00Z",
        to: "2024-12-31T23:59:59Z",
        eventTypes: ["PAYMENT_CREATED", "PAYMENT_SETTLED"],
      });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            eventType: { in: ["PAYMENT_CREATED", "PAYMENT_SETTLED"] },
          }),
        }),
      );
    });

    it("should handle empty export", async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);

      const result = await auditService.generateExport({
        format: "json",
        from: "2024-01-01T00:00:00Z",
        to: "2024-01-02T00:00:00Z",
      });

      expect(result.entries).toBe(0);
    });
  });

  // ─── getAuditStats ─────────────────────────────────────────────────────────

  describe("getAuditStats", () => {
    it("should aggregate audit statistics", async () => {
      prisma.auditLog.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(10) // last24h
        .mockResolvedValueOnce(50); // last7d
      prisma.auditLog.groupBy
        .mockResolvedValueOnce([
          { eventType: "PAYMENT_CREATED", _count: { id: 60 } },
          { eventType: "SYSTEM_EVENT", _count: { id: 40 } },
        ])
        .mockResolvedValueOnce([
          { severity: "INFO", _count: { id: 80 } },
          { severity: "HIGH", _count: { id: 20 } },
        ]);
      prisma.auditLog.findFirst.mockResolvedValue({
        createdAt: new Date("2024-06-01"),
      });
      // verifyChainIntegrity mocks
      prisma.auditLog.findMany.mockResolvedValue([]);

      const stats = await auditService.getAuditStats();

      expect(stats.totalEntries).toBe(100);
      expect(stats.byEventType.PAYMENT_CREATED).toBe(60);
      expect(stats.bySeverity.HIGH).toBe(20);
      expect(stats.last24hCount).toBe(10);
      expect(stats.last7dCount).toBe(50);
      expect(stats.chainIntact).toBe(true);
    });

    it("should handle empty database", async () => {
      prisma.auditLog.count.mockResolvedValue(0);
      prisma.auditLog.groupBy.mockResolvedValue([]);
      prisma.auditLog.findFirst.mockResolvedValue(null);
      prisma.auditLog.findMany.mockResolvedValue([]);

      const stats = await auditService.getAuditStats();

      expect(stats.totalEntries).toBe(0);
      expect(stats.latestEntry).toBeNull();
    });
  });
});
