import { Router, Response } from "express";
import { prisma } from "../lib/db";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import {
  validate,
  ListAuditSchema,
  AuditExportSchema,
  type ListAuditInput,
} from "../middleware/validation";
import { AuditError, AuditService } from "../services/audit";
import { extractRole, requirePermission } from "../middleware/rbac";
import { logger } from "../lib/logger";

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
      const query = req.query as unknown as ListAuditInput;
      const result = await auditService.listAuditEntries({
        ...query,
        businessId: req.businessId!,
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
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await auditService.verifyChainIntegrity(req.businessId!);

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
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const stats = await auditService.getAuditStats(req.businessId!);

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
      const entry = await auditService.getAuditEntry(
        req.params.id,
        req.businessId!,
      );

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
        businessId: req.businessId!,
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
  if (error instanceof AuditError) {
    res
      .status(error.statusCode)
      .json({ error: error.code, message: error.message });
    return;
  }
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
