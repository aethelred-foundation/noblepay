import {
  createMockPrisma,
  resetAllMocks,
} from "../setup";

const mockPrisma = createMockPrisma();
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

const mockAuditService = {
  listAuditEntries: jest.fn(),
  verifyChainIntegrity: jest.fn(),
  getAuditStats: jest.fn(),
  getAuditEntry: jest.fn(),
  generateExport: jest.fn(),
  createAuditEntry: jest.fn(),
};

jest.mock("../../services/audit", () => ({
  AuditService: jest.fn(() => mockAuditService),
}));

jest.mock("../../middleware/auth", () => ({
  authenticateAPIKey: jest.fn((_req: any, _res: any, next: any) => next()),
}));

jest.mock("../../middleware/rbac", () => ({
  extractRole: jest.fn((_req: any, _res: any, next: any) => next()),
  requirePermission: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

jest.mock("../../middleware/validation", () => ({
  validate: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  ListAuditSchema: {},
  AuditExportSchema: {},
}));

import express from "express";
import request from "supertest";
import auditRouter from "../../routes/audit";

const app = express();
app.use(express.json());
app.use("/v1/audit", auditRouter);

beforeEach(() => {
  resetAllMocks();
});

describe("Audit Routes", () => {
  // ─── GET /v1/audit ──────────────────────────────────────────────────────────

  describe("GET /v1/audit", () => {
    it("should list audit entries", async () => {
      mockAuditService.listAuditEntries.mockResolvedValue({
        data: [
          { id: "audit-1", eventType: "PAYMENT_CREATED", blockNumber: BigInt(100) },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      });

      const res = await request(app).get("/v1/audit");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].blockNumber).toBe("100");
    });

    it("should handle null blockNumber", async () => {
      mockAuditService.listAuditEntries.mockResolvedValue({
        data: [{ id: "audit-1", eventType: "PAYMENT_CREATED", blockNumber: null }],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      });

      const res = await request(app).get("/v1/audit");

      expect(res.body.data[0].blockNumber).toBeNull();
    });

    it("should return 500 on error", async () => {
      mockAuditService.listAuditEntries.mockRejectedValue(new Error("DB error"));

      const res = await request(app).get("/v1/audit");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("INTERNAL_ERROR");
    });
  });

  // ─── GET /v1/audit/verify ───────────────────────────────────────────────────

  describe("GET /v1/audit/verify", () => {
    it("should verify chain integrity", async () => {
      mockAuditService.verifyChainIntegrity.mockResolvedValue({
        valid: true,
        entriesChecked: 50,
        errors: [],
      });

      const res = await request(app).get("/v1/audit/verify");

      expect(res.status).toBe(200);
      expect(res.body.data.valid).toBe(true);
    });

    it("should return 500 on error", async () => {
      mockAuditService.verifyChainIntegrity.mockRejectedValue(new Error("DB error"));

      const res = await request(app).get("/v1/audit/verify");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("INTERNAL_ERROR");
    });
  });

  // ─── GET /v1/audit/stats ────────────────────────────────────────────────────

  describe("GET /v1/audit/stats", () => {
    it("should return audit statistics", async () => {
      mockAuditService.getAuditStats.mockResolvedValue({
        totalEntries: 200,
        byEventType: { PAYMENT_CREATED: 100, BUSINESS_REGISTERED: 50 },
      });

      const res = await request(app).get("/v1/audit/stats");

      expect(res.status).toBe(200);
      expect(res.body.data.totalEntries).toBe(200);
    });

    it("should return 500 on error", async () => {
      mockAuditService.getAuditStats.mockRejectedValue(new Error("DB error"));

      const res = await request(app).get("/v1/audit/stats");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("INTERNAL_ERROR");
    });
  });

  // ─── GET /v1/audit/:id ─────────────────────────────────────────────────────

  describe("GET /v1/audit/:id", () => {
    it("should return an audit entry by ID", async () => {
      mockAuditService.getAuditEntry.mockResolvedValue({
        id: "audit-1",
        eventType: "PAYMENT_CREATED",
        blockNumber: BigInt(42),
      });

      const res = await request(app).get("/v1/audit/audit-1");

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("audit-1");
      expect(res.body.data.blockNumber).toBe("42");
    });

    it("should return 404 when audit entry not found", async () => {
      mockAuditService.getAuditEntry.mockResolvedValue(null);

      const res = await request(app).get("/v1/audit/nonexistent");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("AUDIT_ENTRY_NOT_FOUND");
    });

    it("should handle entry with blockNumber as 0 (falsy BigInt)", async () => {
      mockAuditService.getAuditEntry.mockResolvedValue({
        id: "audit-2",
        eventType: "SYSTEM_EVENT",
        blockNumber: BigInt(0),
      });

      const res = await request(app).get("/v1/audit/audit-2");

      expect(res.status).toBe(200);
      expect(res.body.data.blockNumber).toBe("0");
    });

    it("should handle entry with undefined blockNumber", async () => {
      mockAuditService.getAuditEntry.mockResolvedValue({
        id: "audit-3",
        eventType: "SYSTEM_EVENT",
      });

      const res = await request(app).get("/v1/audit/audit-3");

      expect(res.status).toBe(200);
      expect(res.body.data.blockNumber).toBeNull();
    });

    it("should return 500 on error", async () => {
      mockAuditService.getAuditEntry.mockRejectedValue(new Error("DB error"));

      const res = await request(app).get("/v1/audit/audit-1");

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("INTERNAL_ERROR");
    });
  });

  // ─── POST /v1/audit/export ──────────────────────────────────────────────────

  describe("POST /v1/audit/export", () => {
    it("should export audit data as JSON", async () => {
      mockAuditService.generateExport.mockResolvedValue({
        format: "json",
        entries: 10,
        generatedAt: new Date().toISOString(),
        data: JSON.stringify([{ id: "audit-1" }]),
      });

      const res = await request(app)
        .post("/v1/audit/export")
        .send({ format: "json", from: "2024-01-01", to: "2024-03-31" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.format).toBe("json");
    });

    it("should export audit data as CSV", async () => {
      mockAuditService.generateExport.mockResolvedValue({
        format: "csv",
        entries: 10,
        generatedAt: new Date().toISOString(),
        data: "id,event\naudit-1,PAYMENT_CREATED",
      });

      const res = await request(app)
        .post("/v1/audit/export")
        .send({ format: "csv", from: "2024-01-01", to: "2024-03-31" });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.text).toContain("audit-1");
    });

    it("should return 500 on error", async () => {
      mockAuditService.generateExport.mockRejectedValue(new Error("Export error"));

      const res = await request(app)
        .post("/v1/audit/export")
        .send({ format: "json", from: "2024-01-01", to: "2024-03-31" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("INTERNAL_ERROR");
    });
  });
});
