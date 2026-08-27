import { PrismaClient, EventType, Severity, Prisma } from "@prisma/client";
import crypto from "crypto";
import { logger } from "../lib/logger";

const GENESIS_HASH = "0x" + "0".repeat(64);
const SERIALIZABLE_RETRIES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Synchronous audit exports are deliberately bounded. Larger evidence sets
 * must be split into adjacent periods so an authenticated tenant cannot make
 * the API retain an unbounded query result or response in Node memory.
 */
export const AUDIT_EXPORT_LIMITS = Object.freeze({
  maxRangeMs: 93 * DAY_MS,
  maxRows: 5_000,
  maxBytes: 5 * 1024 * 1024,
  queryPageSize: 250,
});

/** Database reads are paged even for an explicit full-chain verification. */
export const AUDIT_VERIFICATION_PAGE_SIZE = 500;

export interface CreateAuditEntryInput {
  businessId?: string;
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
  // Statistics do not implicitly perform an unbounded integrity scan. Call
  // /v1/audit/verify for an explicit, paged verification.
  chainIntact: null;
  chainVerification: "NOT_RUN";
  latestEntry: Date | null;
  last24hCount: number;
  last7dCount: number;
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (["string", "number", "boolean"].includes(typeof value))
    return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * Encode one RFC 4180 field and make values inert when opened in spreadsheet
 * software. Quoting alone does not prevent CSV formula injection, so a
 * reversible apostrophe is prepended when the first meaningful character is a
 * formula sigil. The original value (including any leading whitespace) remains
 * byte-for-byte present after that apostrophe for auditability.
 */
function encodeCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  let firstMeaningfulCharacter = 0;

  while (firstMeaningfulCharacter < text.length) {
    const character = text[firstMeaningfulCharacter];
    const codePoint = character.charCodeAt(0);
    const isControlCharacter =
      codePoint <= 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
    if (!isControlCharacter && !/\s/u.test(character)) break;
    firstMeaningfulCharacter += 1;
  }

  if ("=+-@".includes(text[firstMeaningfulCharacter] || "")) {
    text = `'${text}`;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

export class AuditService {
  constructor(private prisma: PrismaClient) {}

  async createAuditEntry(input: CreateAuditEntryInput) {
    return this.withSerializableRetry(() =>
      this.prisma.$transaction(
        (transaction) => this.createAuditEntryInTransaction(transaction, input),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    ).then((entry) => {
      logger.debug("Audit entry created");
      return entry;
    });
  }

  /** Create an audit entry inside an existing serializable domain transaction. */
  async createAuditEntryInTransaction(
    transaction: Prisma.TransactionClient,
    input: CreateAuditEntryInput,
  ) {
    const severity = input.severity || "INFO";
    const chainKey = input.businessId || "__noblepay_system__";

    // A per-tenant transaction-scoped advisory lock prevents concurrent
    // writers from forking the audit chain.
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${chainKey}))`;
    const previousEntry = await transaction.auditLog.findFirst({
      where: input.businessId
        ? { businessId: input.businessId }
        : { businessId: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { entryHash: true, createdAt: true },
    });

    const previousHash = previousEntry?.entryHash || GENESIS_HASH;
    // PostgreSQL stores millisecond precision here. Force strictly increasing
    // tenant timestamps so several audit writes in one batch transaction have
    // an unambiguous chain order independent of UUID sorting.
    const createdAt = new Date(
      Math.max(Date.now(), (previousEntry?.createdAt?.getTime() || 0) + 1),
    );
    const entryHash = this.computeEntryHash({
      businessId: input.businessId || null,
      eventType: input.eventType,
      actor: input.actor,
      description: input.description,
      severity,
      blockNumber: input.blockNumber || null,
      txHash: input.txHash || null,
      metadata: input.metadata || null,
      previousHash,
      createdAt,
    });

    return transaction.auditLog.create({
      data: {
        eventId: entryHash,
        entryHash,
        businessId: input.businessId || null,
        eventType: input.eventType,
        actor: input.actor,
        description: input.description,
        severity,
        blockNumber: input.blockNumber || null,
        txHash: input.txHash || null,
        previousHash,
        metadata: input.metadata
          ? (input.metadata as Prisma.JsonObject)
          : undefined,
        createdAt,
      },
    });
  }

  async getAuditEntry(id: string, businessId = "__unauthenticated__") {
    return this.prisma.auditLog.findFirst({
      where: {
        businessId,
        OR: id.startsWith("0x")
          ? [{ eventId: id }, { entryHash: id }]
          : [{ id }],
      },
    });
  }

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
    const { page, limit, sortOrder, eventType, severity, actor, from, to } =
      params;
    const businessId = params.businessId || "__unauthenticated__";
    const where: Prisma.AuditLogWhereInput = { businessId };

    if (eventType) where.eventType = eventType as EventType;
    if (severity) where.severity = severity as Severity;
    if (actor) where.actor = { contains: actor, mode: "insensitive" };
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: sortOrder }, { id: sortOrder }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async verifyChainIntegrity(businessId = "__unauthenticated__"): Promise<{
    intact: boolean;
    totalEntries: number;
    verified: number;
    brokenAt?: string;
    message: string;
  }> {
    const totalEntries = await this.prisma.auditLog.count({
      where: { businessId },
    });
    let expectedPreviousHash = GENESIS_HASH;
    let verified = 0;
    let cursor: string | undefined;

    while (verified < totalEntries) {
      const requested = Math.min(
        AUDIT_VERIFICATION_PAGE_SIZE,
        totalEntries - verified,
      );
      const entries = await this.prisma.auditLog.findMany({
        where: { businessId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: requested,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      // A disappearing row means the chain changed during this verification.
      // Never report such an incomplete snapshot as intact.
      if (entries.length === 0) {
        return {
          intact: false,
          totalEntries,
          verified,
          message: "Audit chain changed while integrity was being verified",
        };
      }

      for (const entry of entries.slice(0, requested)) {
        const expectedEntryHash = this.computeEntryHash({
          businessId: entry.businessId,
          eventType: entry.eventType,
          actor: entry.actor,
          description: entry.description,
          severity: entry.severity,
          blockNumber: entry.blockNumber,
          txHash: entry.txHash,
          metadata: entry.metadata,
          previousHash: entry.previousHash || GENESIS_HASH,
          createdAt: entry.createdAt,
        });

        if (
          entry.previousHash !== expectedPreviousHash ||
          entry.entryHash !== expectedEntryHash
        ) {
          return {
            intact: false,
            totalEntries,
            verified,
            brokenAt: entry.id,
            message: `Audit chain integrity check failed at entry ${entry.id}`,
          };
        }

        expectedPreviousHash = entry.entryHash;
        cursor = entry.id;
        verified++;
      }
    }

    return {
      intact: true,
      totalEntries,
      verified,
      message:
        totalEntries === 0
          ? "No audit entries to verify"
          : `All ${totalEntries} entries verified. Chain integrity intact.`,
    };
  }

  async generateExport(options: AuditExportOptions): Promise<{
    format: string;
    entries: number;
    data: string;
    generatedAt: Date;
  }> {
    const from = new Date(options.from);
    const to = new Date(options.to);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
      throw new AuditError(
        "INVALID_EXPORT_RANGE",
        "Audit export dates must be valid ISO-8601 values",
        400,
      );
    }
    if (from > to) {
      throw new AuditError(
        "INVALID_EXPORT_RANGE",
        "Audit export range must be ordered",
        400,
      );
    }
    if (to.getTime() - from.getTime() > AUDIT_EXPORT_LIMITS.maxRangeMs) {
      throw new AuditError(
        "AUDIT_EXPORT_RANGE_EXCEEDED",
        "Audit exports are limited to 93 days; split the request into adjacent periods",
        422,
      );
    }

    const where: Prisma.AuditLogWhereInput = {
      businessId: options.businessId || "__unauthenticated__",
      createdAt: { gte: from, lte: to },
    };
    if (options.eventTypes?.length)
      where.eventType = { in: options.eventTypes as EventType[] };

    const generatedAt = new Date();
    const chunks: string[] = [];
    let bytes = 0;
    let entryCount = 0;
    let cursor: string | undefined;

    const append = (chunk: string): void => {
      const nextBytes = bytes + Buffer.byteLength(chunk, "utf8");
      if (nextBytes > AUDIT_EXPORT_LIMITS.maxBytes) {
        throw new AuditError(
          "AUDIT_EXPORT_SIZE_EXCEEDED",
          "Audit export exceeds the 5 MiB synchronous response limit; narrow the period or omit metadata",
          413,
        );
      }
      chunks.push(chunk);
      bytes = nextBytes;
    };

    const headers = [
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
    ];
    if (options.includeMetadata) headers.push("metadata");

    if (options.format === "csv") {
      append(headers.map(encodeCsvCell).join(","));
    } else {
      append(
        `{"exportedAt":${JSON.stringify(generatedAt.toISOString())},"period":{"from":${JSON.stringify(options.from)},"to":${JSON.stringify(options.to)}},"entries":[`,
      );
    }

    let hasMoreEntries = true;
    while (hasMoreEntries) {
      const remaining = AUDIT_EXPORT_LIMITS.maxRows - entryCount;
      const take = Math.min(AUDIT_EXPORT_LIMITS.queryPageSize, remaining + 1);
      const entries = await this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (entries.length === 0) {
        hasMoreEntries = false;
        continue;
      }

      for (const entry of entries) {
        if (entryCount >= AUDIT_EXPORT_LIMITS.maxRows) {
          throw new AuditError(
            "AUDIT_EXPORT_ROW_LIMIT_EXCEEDED",
            "Audit exports are limited to 5,000 entries; narrow the period or event filters",
            413,
          );
        }

        if (options.format === "csv") {
          const row = [
            entry.eventId,
            entry.entryHash,
            entry.businessId || "",
            entry.eventType,
            entry.actor,
            entry.description,
            entry.severity,
            entry.blockNumber?.toString() || "",
            entry.txHash || "",
            entry.previousHash || "",
            entry.createdAt.toISOString(),
            ...(options.includeMetadata
              ? [
                  entry.metadata === null || entry.metadata === undefined
                    ? ""
                    : JSON.stringify(entry.metadata),
                ]
              : []),
          ]
            .map(encodeCsvCell)
            .join(",");
          append(`\r\n${row}`);
        } else {
          const exported = {
            eventId: entry.eventId,
            entryHash: entry.entryHash,
            businessId: entry.businessId,
            eventType: entry.eventType,
            actor: entry.actor,
            description: entry.description,
            severity: entry.severity,
            blockNumber: entry.blockNumber?.toString() || null,
            txHash: entry.txHash,
            previousHash: entry.previousHash,
            createdAt: entry.createdAt.toISOString(),
            ...(options.includeMetadata ? { metadata: entry.metadata } : {}),
          };
          append(`${entryCount === 0 ? "" : ","}${JSON.stringify(exported)}`);
        }
        entryCount++;
      }

      cursor = entries[entries.length - 1].id;
      hasMoreEntries = entries.length >= take;
    }

    if (options.format === "json") {
      append(`],"totalEntries":${entryCount}}`);
    }
    const data = chunks.join("");

    logger.info("Audit export generated");
    return {
      format: options.format,
      entries: entryCount,
      data,
      generatedAt,
    };
  }

  async getAuditStats(businessId = "__unauthenticated__"): Promise<AuditStats> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const scope = { businessId };

    const [
      totalEntries,
      byType,
      bySeverity,
      latest,
      last24hCount,
      last7dCount,
    ] = await Promise.all([
      this.prisma.auditLog.count({ where: scope }),
      this.prisma.auditLog.groupBy({
        by: ["eventType"],
        _count: { id: true },
        where: scope,
      }),
      this.prisma.auditLog.groupBy({
        by: ["severity"],
        _count: { id: true },
        where: scope,
      }),
      this.prisma.auditLog.findFirst({
        where: scope,
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      this.prisma.auditLog.count({
        where: { ...scope, createdAt: { gte: last24h } },
      }),
      this.prisma.auditLog.count({
        where: { ...scope, createdAt: { gte: last7d } },
      }),
    ]);

    const byEventType: Record<string, number> = {};
    for (const item of byType) byEventType[item.eventType] = item._count.id;
    const bySeverityMap: Record<string, number> = {};
    for (const item of bySeverity)
      bySeverityMap[item.severity] = item._count.id;
    return {
      totalEntries,
      byEventType,
      bySeverity: bySeverityMap,
      chainIntact: null,
      chainVerification: "NOT_RUN",
      latestEntry: latest?.createdAt || null,
      last24hCount,
      last7dCount,
    };
  }

  private computeEntryHash(input: {
    businessId: string | null;
    eventType: EventType;
    actor: string;
    description: string;
    severity: Severity;
    blockNumber: bigint | null;
    txHash: string | null;
    metadata: unknown;
    previousHash: string;
    createdAt: Date;
  }): string {
    const payload = canonicalize(input);
    return "0x" + crypto.createHash("sha256").update(payload).digest("hex");
  }

  private async withSerializableRetry<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < SERIALIZABLE_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034";
        if (!retryable || attempt === SERIALIZABLE_RETRIES - 1) throw error;
      }
    }
    throw new Error("Unreachable serializable retry state");
  }
}

export class AuditError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "AuditError";
  }
}
