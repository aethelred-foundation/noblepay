import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { validate, ListAuditSchema, AuditExportSchema } from "../middleware/validation";
import { AuditService } from "../services/audit";
import { extractRole, requirePermission } from "../middleware/rbac";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();
const auditService = new AuditService(prisma);

const router = Router();

// ─── GET /v1/audit — List audit entries ─────────────────────────────────────

router.get(
  "/",
  authenticateAPIKey,
  extractRole,
  requirePermission("audit:read"),
  validate(ListAuditSchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await auditService.listAuditEntries({
        ...(req.query as any),
        businessId: req.businessId,
      });

      res.json({
        success: true,
        data: result.data.map((entry) => ({
          ...entry,
          blockNumber: entry.blockNumber?.toString() || null,
        })),
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/audit/verify — Verify audit chain integrity ───────────────────

router.get(
  "/verify",
  authenticateAPIKey,
  extractRole,
  requirePermission("audit:read"),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await auditService.verifyChainIntegrity();

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/audit/stats — Audit statistics ────────────────────────────────

router.get(
  "/stats",
  authenticateAPIKey,
  extractRole,
  requirePermission("audit:read"),
  async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const stats = await auditService.getAuditStats();

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/audit/:id — Get audit entry details ───────────────────────────

router.get(
  "/:id",
  authenticateAPIKey,
  extractRole,
  requirePermission("audit:read"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const entry = await auditService.getAuditEntry(req.params.id);

      if (!entry) {
        res.status(404).json({
          error: "AUDIT_ENTRY_NOT_FOUND",
          message: "Audit entry not found",
        });
        return;
      }

      res.json({
        success: true,
        data: {
          ...entry,
          blockNumber: entry.blockNumber?.toString() || null,
        },
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/audit/export — Generate regulatory export ────────────────────

router.post(
  "/export",
  authenticateAPIKey,
  extractRole,
  requirePermission("audit:export"),
  validate(AuditExportSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await auditService.generateExport({
        ...req.body,
        businessId: req.businessId,
      });

      // Set appropriate content type
      if (req.body.format === "csv") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="audit-export-${Date.now()}.csv"`,
        );
        res.send(result.data);
      } else {
        res.json({
          success: true,
          data: {
            format: result.format,
            entries: result.entries,
            generatedAt: result.generatedAt,
            export: JSON.parse(result.data),
          },
        });
      }
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── Error Handler ──────────────────────────────────────────────────────────

function handleError(error: unknown, res: Response): void {
  logger.error("Unhandled audit error", {
    error: (error as Error).message,
    stack: (error as Error).stack,
  });

  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "An internal error occurred",
  });
}

export default router;
