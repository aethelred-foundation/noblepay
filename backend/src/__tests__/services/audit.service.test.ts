import { createMockPrisma, resetAllMocks, mockLogger } from "../setup";
import {
  AUDIT_EXPORT_LIMITS,
  AUDIT_VERIFICATION_PAGE_SIZE,
  AuditService,
} from "../../services/audit";

let prisma: ReturnType<typeof createMockPrisma>;
let auditService: AuditService;

function parseRfc4180(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csv.length; index++) {
    const character = csv[index];
    if (quoted) {
      if (character === '"' && csv[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      if (field !== "") throw new Error("Unexpected quote in CSV field");
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\r" && csv[index + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += 1;
    } else {
      field += character;
    }
  }

  if (quoted) throw new Error("Unterminated quoted CSV field");
  row.push(field);
  rows.push(row);
  return rows;
}

beforeEach(() => {
  resetAllMocks();
  prisma = createMockPrisma();
  prisma.$executeRaw = jest.fn();
  prisma.$transaction.mockImplementation(
    async (callback: (transaction: typeof prisma) => unknown) =>
      callback(prisma),
  );
  auditService = new AuditService(prisma);
});

describe("AuditService", () => {
  // ─── createAuditEntry ────────────────────────────────────────────────────

  describe("createAuditEntry", () => {
    it("should create an entry with hash chaining", async () => {
      prisma.auditLog.findFirst.mockResolvedValue({
        entryHash: "0xprevioushash",
        createdAt: new Date("2026-07-21T00:00:00.000Z"),
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
      prisma.auditLog.findFirst.mockResolvedValue({ id: "1", eventId: hash });

      await auditService.getAuditEntry(hash);

      expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
        where: {
          businessId: "__unauthenticated__",
          OR: [{ eventId: hash }, { entryHash: hash }],
        },
      });
    });

    it("should look up by UUID when id does not start with 0x", async () => {
      prisma.auditLog.findFirst.mockResolvedValue({ id: "uuid-1" });

      await auditService.getAuditEntry("uuid-1");

      expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
        where: {
          businessId: "__unauthenticated__",
          OR: [{ id: "uuid-1" }],
        },
      });
    });

    it("should return null when not found", async () => {
      prisma.auditLog.findFirst.mockResolvedValue(null);
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
        from: "2024-04-01T00:00:00Z",
        to: "2024-06-30T23:59:59Z",
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
      prisma.auditLog.count.mockResolvedValue(0);
      prisma.auditLog.findMany.mockResolvedValue([]);

      const result = await auditService.verifyChainIntegrity();

      expect(result.intact).toBe(true);
      expect(result.totalEntries).toBe(0);
    });

    it("should return intact:true with valid chain", async () => {
      const entries: any[] = [];
      prisma.auditLog.findFirst.mockImplementation(async () => {
        const previous = entries[entries.length - 1];
        return previous
          ? { entryHash: previous.entryHash, createdAt: previous.createdAt }
          : null;
      });
      prisma.auditLog.create.mockImplementation(async ({ data }: any) => {
        const entry = { id: String(entries.length + 1), ...data };
        entries.push(entry);
        return entry;
      });
      for (let index = 0; index < 3; index++) {
        await auditService.createAuditEntry({
          eventType: "SYSTEM_EVENT",
          actor: "system",
          description: `Entry ${index + 1}`,
        });
      }
      prisma.auditLog.count.mockResolvedValue(3);
      prisma.auditLog.findMany.mockResolvedValue(entries);

      const result = await auditService.verifyChainIntegrity();

      expect(result.intact).toBe(true);
      expect(result.totalEntries).toBe(3);
      expect(result.verified).toBe(3);
    });

    it("should detect broken chain", async () => {
      const entries: any[] = [];
      prisma.auditLog.findFirst.mockImplementation(async () => {
        const previous = entries[entries.length - 1];
        return previous
          ? { entryHash: previous.entryHash, createdAt: previous.createdAt }
          : null;
      });
      prisma.auditLog.create.mockImplementation(async ({ data }: any) => {
        const entry = { id: String(entries.length + 1), ...data };
        entries.push(entry);
        return entry;
      });
      for (let index = 0; index < 3; index++) {
        await auditService.createAuditEntry({
          eventType: "SYSTEM_EVENT",
          actor: "system",
          description: `Entry ${index + 1}`,
        });
      }
      entries[1].previousHash = `0x${"f".repeat(64)}`;
      prisma.auditLog.count.mockResolvedValue(3);
      prisma.auditLog.findMany.mockResolvedValue(entries);

      const result = await auditService.verifyChainIntegrity();

      expect(result.intact).toBe(false);
      expect(result.brokenAt).toBe("2");
      expect(result.message).toContain("integrity check failed");
    });

    it("verifies a large chain in bounded cursor pages", async () => {
      const businessId = "business-paged";
      const entries = Array.from(
        { length: AUDIT_VERIFICATION_PAGE_SIZE + 1 },
        (_, index) => ({
          id: `entry-${String(index).padStart(4, "0")}`,
          businessId,
          eventType: "SYSTEM_EVENT",
          actor: "system",
          description: `Entry ${index}`,
          severity: "INFO",
          blockNumber: null,
          txHash: null,
          metadata: null,
          previousHash: "",
          entryHash: "",
          createdAt: new Date(1_700_000_000_000 + index),
        }),
      );
      let previousHash = `0x${"0".repeat(64)}`;
      for (const entry of entries) {
        entry.previousHash = previousHash;
        entry.entryHash = (auditService as any).computeEntryHash({
          businessId: entry.businessId,
          eventType: entry.eventType,
          actor: entry.actor,
          description: entry.description,
          severity: entry.severity,
          blockNumber: entry.blockNumber,
          txHash: entry.txHash,
          metadata: entry.metadata,
          previousHash: entry.previousHash,
          createdAt: entry.createdAt,
        });
        previousHash = entry.entryHash;
      }
      prisma.auditLog.count.mockResolvedValue(entries.length);
      prisma.auditLog.findMany
        .mockResolvedValueOnce(entries.slice(0, AUDIT_VERIFICATION_PAGE_SIZE))
        .mockResolvedValueOnce(entries.slice(AUDIT_VERIFICATION_PAGE_SIZE));

      await expect(
        auditService.verifyChainIntegrity(businessId),
      ).resolves.toMatchObject({
        intact: true,
        totalEntries: entries.length,
        verified: entries.length,
      });
      expect(prisma.auditLog.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ take: AUDIT_VERIFICATION_PAGE_SIZE }),
      );
      expect(prisma.auditLog.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          take: 1,
          cursor: { id: entries[AUDIT_VERIFICATION_PAGE_SIZE - 1].id },
          skip: 1,
        }),
      );
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
        from: "2024-04-01T00:00:00Z",
        to: "2024-06-30T23:59:59Z",
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
        from: "2024-04-01T00:00:00Z",
        to: "2024-06-30T23:59:59Z",
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
        from: "2024-04-01T00:00:00Z",
        to: "2024-06-30T23:59:59Z",
        includeMetadata: true,
      });

      const parsed = JSON.parse(result.data);
      expect(parsed.entries[0].metadata).toEqual({ test: true });
    });

    it("should include metadata column in CSV when requested", async () => {
      prisma.auditLog.findMany.mockResolvedValue(sampleEntries);

      const result = await auditService.generateExport({
        format: "csv",
        from: "2024-04-01T00:00:00Z",
        to: "2024-06-30T23:59:59Z",
        includeMetadata: true,
      });

      const header = result.data.split("\n")[0];
      expect(header).toContain("metadata");
    });

    it("should round-trip every CSV column and neutralize spreadsheet formulas", async () => {
      const metadata = {
        reason: 'matched "review,required"',
        evidence: "first line\r\nsecond line\nthird line",
        sourceValues: ["=SUM(A1:A2)", "+1", "-2", "@lookup"],
        nested: { key: "value,with,commas" },
      };
      prisma.auditLog.findMany.mockResolvedValue([
        {
          eventId: '=HYPERLINK("https://invalid.example","open")',
          entryHash: "+SUM(1,1)",
          businessId: " @tenant-reference",
          eventType: "PAYMENT_CREATED",
          actor: "\t=cmd|' /C calc'!A0",
          description: 'Evidence, with "quotes"\r\nand a second\nline',
          severity: "HIGH",
          blockNumber: BigInt(42),
          txHash: "-1+1",
          previousHash: "0xprevious",
          createdAt: new Date("2024-06-01T10:00:00.000Z"),
          metadata,
        },
      ]);

      const result = await auditService.generateExport({
        format: "csv",
        from: "2024-04-01T00:00:00Z",
        to: "2024-06-30T23:59:59Z",
        includeMetadata: true,
      });

      const [headers, row] = parseRfc4180(result.data);
      expect(headers).toEqual([
        "eventId",
        "entryHash",
        "businessId",
        "eventType",
        "actor",
        "description",
        "severity",
        "blockNumber",
        "txHash",
        "previousHash",
        "createdAt",
        "metadata",
      ]);
      expect(row).toEqual([
        '\'=HYPERLINK("https://invalid.example","open")',
        "'+SUM(1,1)",
        "' @tenant-reference",
        "PAYMENT_CREATED",
        "'\t=cmd|' /C calc'!A0",
        'Evidence, with "quotes"\r\nand a second\nline',
        "HIGH",
        "42",
        "'-1+1",
        "0xprevious",
        "2024-06-01T10:00:00.000Z",
        JSON.stringify(metadata),
      ]);
      expect(row).toHaveLength(headers.length);
      expect(JSON.parse(row[headers.indexOf("metadata")])).toEqual(metadata);
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
        from: "2024-04-01T00:00:00Z",
        to: "2024-06-30T23:59:59Z",
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
        from: "2024-04-01T00:00:00Z",
        to: "2024-06-30T23:59:59Z",
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
        from: "2024-04-01T00:00:00Z",
        to: "2024-06-30T23:59:59Z",
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
        from: "2024-04-01T00:00:00Z",
        to: "2024-06-30T23:59:59Z",
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

    it("rejects reversed and over-93-day ranges before querying", async () => {
      await expect(
        auditService.generateExport({
          format: "json",
          from: "2024-02-01T00:00:00Z",
          to: "2024-01-01T00:00:00Z",
        }),
      ).rejects.toMatchObject({
        code: "INVALID_EXPORT_RANGE",
        statusCode: 400,
      });
      await expect(
        auditService.generateExport({
          format: "json",
          from: "2024-01-01T00:00:00Z",
          to: "2024-12-31T23:59:59Z",
        }),
      ).rejects.toMatchObject({
        code: "AUDIT_EXPORT_RANGE_EXCEEDED",
        statusCode: 422,
      });
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    it("rejects exports above the row cap with a typed 413", async () => {
      prisma.auditLog.findMany.mockResolvedValue(
        Array.from({ length: AUDIT_EXPORT_LIMITS.maxRows + 1 }, (_, index) => ({
          ...sampleEntries[0],
          id: `entry-${index}`,
          eventId: `event-${index}`,
          entryHash: `hash-${index}`,
        })),
      );

      await expect(
        auditService.generateExport({
          format: "json",
          from: "2024-06-01T00:00:00Z",
          to: "2024-06-02T00:00:00Z",
        }),
      ).rejects.toMatchObject({
        code: "AUDIT_EXPORT_ROW_LIMIT_EXCEEDED",
        statusCode: 413,
      });
    });

    it("rejects exports above the response-byte cap with a typed 413", async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        {
          ...sampleEntries[0],
          id: "large-entry",
          description: "x".repeat(AUDIT_EXPORT_LIMITS.maxBytes),
        },
      ]);

      await expect(
        auditService.generateExport({
          format: "csv",
          from: "2024-06-01T00:00:00Z",
          to: "2024-06-02T00:00:00Z",
        }),
      ).rejects.toMatchObject({
        code: "AUDIT_EXPORT_SIZE_EXCEEDED",
        statusCode: 413,
      });
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
      const stats = await auditService.getAuditStats();

      expect(stats.totalEntries).toBe(100);
      expect(stats.byEventType.PAYMENT_CREATED).toBe(60);
      expect(stats.bySeverity.HIGH).toBe(20);
      expect(stats.last24hCount).toBe(10);
      expect(stats.last7dCount).toBe(50);
      expect(stats.chainIntact).toBeNull();
      expect(stats.chainVerification).toBe("NOT_RUN");
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    it("should handle empty database", async () => {
      prisma.auditLog.count.mockResolvedValue(0);
      prisma.auditLog.groupBy.mockResolvedValue([]);
      prisma.auditLog.findFirst.mockResolvedValue(null);
      const stats = await auditService.getAuditStats();

      expect(stats.totalEntries).toBe(0);
      expect(stats.latestEntry).toBeNull();
      expect(stats.chainIntact).toBeNull();
    });
  });
});
