import { Router, Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { ReportingService, ReportingError } from "../services/reporting";
import { AuditService } from "../services/audit";
import { extractRole, requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validation";
import { logger } from "../lib/logger";
import { prisma } from "../lib/db";

const auditService = new AuditService(prisma);
const reportingService = new ReportingService(prisma, auditService);
const router = Router();

const reportTypes = [
  "SAR",
  "CTR",
  "STR",
  "FATF_TRAVEL_RULE",
  "SANCTIONS_SUMMARY",
  "AML_QUARTERLY",
  "RISK_ASSESSMENT",
  "CUSTOM",
] as const;
const reportStatuses = [
  "DRAFT",
  "GENERATING",
  "READY",
  "SUBMITTED",
  "ACKNOWLEDGED",
  "REJECTED",
] as const;
const isoDate = z
  .string()
  .min(10)
  .max(35)
  .refine(
    (value) => Number.isFinite(new Date(value).getTime()),
    "Invalid ISO-8601 date",
  );
const reportId = z
  .object({
    id: z
      .string()
      .min(5)
      .max(100)
      .regex(/^rpt-[a-zA-Z0-9-]+$/),
  })
  .strict();
const generateSchema = z
  .object({
    templateId: z.string().min(1).max(100),
    dateFrom: isoDate,
    dateTo: isoDate,
    filters: z
      .object({
        currency: z
          .string()
          .regex(/^[A-Z0-9]{2,10}$/)
          .optional(),
        status: z
          .enum([
            "PENDING",
            "SCREENING",
            "APPROVED",
            "SETTLED",
            "CANCELLED",
            "REFUNDED",
            "FLAGGED",
            "REJECTED",
          ])
          .optional(),
      })
      .strict()
      .optional(),
    notes: z.string().max(2_000).optional(),
  })
  .strict();
const listSchema = z
  .object({
    type: z.enum(reportTypes).optional(),
    status: z.enum(reportStatuses).optional(),
    jurisdiction: z.string().trim().min(2).max(100).optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
const templateQuery = z
  .object({ jurisdiction: z.string().trim().min(2).max(100).optional() })
  .strict();

function tenant(req: AuthenticatedRequest): string {
  if (!req.businessId)
    throw new ReportingError(
      "TENANT_REQUIRED",
      "Authenticated business is required",
      401,
    );
  return req.businessId;
}

function actor(req: AuthenticatedRequest): string {
  return req.signerId || req.jwtPayload?.sub || "authenticated-user";
}

router.get(
  "/templates",
  authenticateAPIKey,
  extractRole,
  requirePermission("reports:read"),
  validate(templateQuery, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      tenant(req);
      const templates = reportingService.getTemplates(
        req.query.jurisdiction as string | undefined,
      );
      res.json({ success: true, data: templates });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/",
  authenticateAPIKey,
  extractRole,
  requirePermission("reports:generate"),
  validate(generateSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const report = await reportingService.generateReport(
        req.body,
        actor(req),
        tenant(req),
      );
      res.status(201).json({ success: true, data: report });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/",
  authenticateAPIKey,
  extractRole,
  requirePermission("reports:read"),
  validate(listSchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const reports = await reportingService.listReports({
        businessId: tenant(req),
        type: req.query.type as never,
        status: req.query.status as never,
        jurisdiction: req.query.jurisdiction as string | undefined,
        page: req.query.page as unknown as number,
        limit: req.query.limit as unknown as number,
      });
      res.json({
        success: true,
        data: reports.data,
        pagination: reports.pagination,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/analytics",
  authenticateAPIKey,
  extractRole,
  requirePermission("reports:read"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const analytics = await reportingService.getAnalytics(tenant(req));
      res.json({ success: true, data: analytics });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// A regulator-calendar adapter is not part of this release. Keep the reserved
// route indistinguishable from an unknown endpoint instead of allowing the
// generic `/:id` matcher to expose validation details or a placeholder API.
router.all("/deadlines", (_req, res: Response): void => {
  res.status(404).json({ error: "NOT_FOUND", message: "Not found" });
});

router.get(
  "/:id",
  authenticateAPIKey,
  extractRole,
  requirePermission("reports:read"),
  validate(reportId, "params"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const report = await reportingService.getReport(
        req.params.id,
        tenant(req),
      );
      res.json({ success: true, data: report });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/:id/submit",
  authenticateAPIKey,
  extractRole,
  requirePermission("reports:submit"),
  validate(reportId, "params"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (
      process.env.NODE_ENV === "production" &&
      (!process.env.REGULATORY_REPORTING_URL?.trim() ||
        !process.env.REGULATORY_REPORTING_API_KEY?.trim())
    ) {
      res.status(404).json({ error: "NOT_FOUND", message: "Not found" });
      return;
    }
    try {
      const report = await reportingService.submitReport(
        req.params.id,
        actor(req),
        tenant(req),
      );
      res.json({ success: true, data: report });
    } catch (error) {
      handleError(error, res);
    }
  },
);

function handleError(error: unknown, res: Response): void {
  if (error instanceof ReportingError) {
    res
      .status(error.statusCode)
      .json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled reporting error", {
    error: (error as Error).message,
  });
  res
    .status(500)
    .json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
