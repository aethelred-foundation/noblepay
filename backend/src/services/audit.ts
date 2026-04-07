import { PrismaClient, EventType, Severity, Prisma } from "@prisma/client";
import crypto from "crypto";
import { logger, maskIdentifier } from "../lib/logger";

const DEFAULT_AUDIT_CHAIN_SECRET = "noblepay-audit-chain-development-secret";

export interface CreateAuditEntryInput {
  eventType: EventType;
  actor: string;
  description: string;
  severity?: Severity;
  blockNumber?: bigint;
  txHash?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditExportOptions {
  format: "json" | "csv";
  from: string;
  to: string;
  eventTypes?: string[];
  includeMetadata?: boolean;
  businessId?: string;
}

export interface AuditStats {
  totalEntries: number;
  byEventType: Record<string, number>;
  bySeverity: Record<string, number>;
  chainIntact: boolean;
  latestEntry: Date | null;
  last24hCount: number;
  last7dCount: number;
}

export class AuditService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create an audit entry with hash chaining for tamper-evidence.
   * Each entry's eventId is derived from its content + the previous entry's hash.
   */
  async createAuditEntry(input: CreateAuditEntryInput) {
    // Get the previous entry's eventId for hash chaining
    const previousEntry = await this.prisma.auditLog.findFirst({
      orderBy: { createdAt: "desc" },
      select: { eventId: true },
    });

    const previousHash = previousEntry?.eventId || "0x" + "0".repeat(64);

    // Compute deterministic event ID (hash chain)
    const eventId = this.computeEventId(input, previousHash);

    const entry = await this.prisma.auditLog.create({
      data: {
        eventId,
        eventType: input.eventType,
        actor: input.actor,
        description: input.description,
        severity: input.severity || "INFO",
        blockNumber: input.blockNumber || null,
        txHash: input.txHash || null,
        previousHash,
        metadata: input.metadata ? (input.metadata as Prisma.JsonObject) : undefined,
      },
    });

    logger.debug("Audit entry created", {
      eventId,
      eventType: input.eventType,
      actorRef: maskIdentifier(input.actor),
    });

    return entry;
  }

  /**
   * Get a single audit entry by ID or eventId.
   */
  async getAuditEntry(id: string) {
    if (id.startsWith("0x")) {
      return this.prisma.auditLog.findUnique({ where: { eventId: id } });
    }
    return this.prisma.auditLog.findUnique({ where: { id } });
  }

  /**
   * List audit entries with filtering and pagination.
   */
  async listAuditEntries(params: {
    page: number;
    limit: number;
    sortOrder: "asc" | "desc";
    eventType?: string;
    severity?: string;
    actor?: string;
    from?: string;
    to?: string;
    businessId?: string;
  }) {
    const { page, limit, sortOrder, eventType, severity, actor, from, to, businessId } = params;

    const where: Prisma.AuditLogWhereInput = {};

    if (eventType) where.eventType = eventType as EventType;
    if (severity) where.severity = severity as Severity;
    if (actor) where.actor = { contains: actor, mode: "insensitive" };

    // Scope audit entries to the requesting tenant's businessId
    if (businessId) {
      where.actor = where.actor
        ? { AND: [where.actor as any, { contains: businessId, mode: "insensitive" }] } as any
        : { contains: businessId, mode: "insensitive" };
    }

    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Verify the integrity of the audit chain.
   * Walks through all entries and verifies each hash links to the previous.
   */
  async verifyChainIntegrity(): Promise<{
    intact: boolean;
    totalEntries: number;
    verified: number;
    brokenAt?: string;
    message: string;
  }> {
    const entries = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, eventId: true, previousHash: true, createdAt: true },
    });

    if (entries.length === 0) {
      return {
        intact: true,
        totalEntries: 0,
        verified: 0,
        message: "No audit entries to verify",
      };
    }

    let verified = 0;
    for (let i = 1; i < entries.length; i++) {
      const current = entries[i];
      const previous = entries[i - 1];

      if (current.previousHash !== previous.eventId) {
        return {
          intact: false,
          totalEntries: entries.length,
          verified,
          brokenAt: current.id,
          message: `Chain broken at entry ${current.id} (index ${i}). Expected previousHash ${previous.eventId}, got ${current.previousHash}`,
        };
      }
      verified++;
    }

    return {
      intact: true,
      totalEntries: entries.length,
      verified,
      message: `All ${entries.length} entries verified. Chain integrity intact.`,
    };
  }

  /**
   * Generate a regulatory export of audit entries.
   */
  async generateExport(options: AuditExportOptions): Promise<{
    format: string;
    entries: number;
    data: string;
    generatedAt: Date;
  }> {
    const where: Prisma.AuditLogWhereInput = {
      createdAt: {
        gte: new Date(options.from),
        lte: new Date(options.to),
      },
    };

    if (options.eventTypes && options.eventTypes.length > 0) {
      where.eventType = { in: options.eventTypes as EventType[] };
    }

    // Scope export to the requesting tenant's businessId
    if (options.businessId) {
      where.actor = { contains: options.businessId, mode: "insensitive" };
    }

    const entries = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "asc" },
    });

    let data: string;

    if (options.format === "csv") {
      const headers = [
        "eventId",
        "eventType",
        "actor",
        "description",
        "severity",
        "blockNumber",
        "txHash",
        "previousHash",
        "createdAt",
      ];
      if (options.includeMetadata) headers.push("metadata");

      const rows = entries.map((entry) => {
        const row = [
          entry.eventId,
          entry.eventType,
          entry.actor,
          `"${entry.description.replace(/"/g, '""')}"`,
          entry.severity,
          entry.blockNumber?.toString() || "",
          entry.txHash || "",
          entry.previousHash || "",
          entry.createdAt.toISOString(),
        ];
        if (options.includeMetadata) {
          row.push(entry.metadata ? JSON.stringify(entry.metadata) : "");
        }
        return row.join(",");
      });

      data = [headers.join(","), ...rows].join("\n");
    } else {
      const exportEntries = entries.map((entry) => {
        const obj: Record<string, unknown> = {
          eventId: entry.eventId,
          eventType: entry.eventType,
          actor: entry.actor,
          description: entry.description,
          severity: entry.severity,
          blockNumber: entry.blockNumber?.toString() || null,
          txHash: entry.txHash,
          previousHash: entry.previousHash,
          createdAt: entry.createdAt.toISOString(),
        };
        if (options.includeMetadata) {
          obj.metadata = entry.metadata;
        }
        return obj;
      });

      data = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          period: { from: options.from, to: options.to },
          totalEntries: exportEntries.length,
          entries: exportEntries,
        },
        null,
        2,
      );
    }

    logger.info("Audit export generated", {
      format: options.format,
      entries: entries.length,
      from: options.from,
      to: options.to,
    });

    return {
      format: options.format,
      entries: entries.length,
      data,
      generatedAt: new Date(),
    };
  }

  /**
   * Get audit statistics.
   */
  async getAuditStats(): Promise<AuditStats> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [totalEntries, byType, bySeverity, latest, last24hCount, last7dCount] =
      await Promise.all([
        this.prisma.auditLog.count(),
        this.prisma.auditLog.groupBy({
          by: ["eventType"],
          _count: { id: true },
        }),
        this.prisma.auditLog.groupBy({
          by: ["severity"],
          _count: { id: true },
        }),
        this.prisma.auditLog.findFirst({
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
        this.prisma.auditLog.count({ where: { createdAt: { gte: last24h } } }),
        this.prisma.auditLog.count({ where: { createdAt: { gte: last7d } } }),
      ]);

    const byEventType: Record<string, number> = {};
    for (const t of byType) {
      byEventType[t.eventType] = t._count.id;
    }

    const bySev: Record<string, number> = {};
    for (const s of bySeverity) {
      bySev[s.severity] = s._count.id;
    }

    // Verify chain integrity
    const integrity = await this.verifyChainIntegrity();

    return {
      totalEntries,
      byEventType,
      bySeverity: bySev,
      chainIntact: integrity.intact,
      latestEntry: latest?.createdAt || null,
      last24hCount,
      last7dCount,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private computeEventId(input: CreateAuditEntryInput, previousHash: string): string {
    const payload = JSON.stringify({
      eventType: input.eventType,
      actor: input.actor,
      description: input.description,
      severity: input.severity || "INFO",
      previousHash,
      timestamp: Date.now(),
    });

    const chainSecret = process.env.AUDIT_CHAIN_SECRET || DEFAULT_AUDIT_CHAIN_SECRET;
    return "0x" + crypto.createHmac("sha256", chainSecret).update(payload).digest("hex");
  }
}
