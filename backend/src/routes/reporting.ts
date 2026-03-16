import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { ReportingService, ReportingError } from "../services/reporting";
import { AuditService } from "../services/audit";
import { extractRole, requirePermission } from "../middleware/rbac";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();
const auditService = new AuditService(prisma);
const reportingService = new ReportingService(prisma, auditService);

const router = Router();

router.get("/templates", authenticateAPIKey, extractRole, requirePermission("reports:read"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const jurisdiction = req.query.jurisdiction as string | undefined;
    const templates = reportingService.getTemplates(jurisdiction);
    res.json({ success: true, data: templates });
  } catch (error) { handleError(error, res); }
});

router.post("/", authenticateAPIKey, extractRole, requirePermission("reports:generate"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const report = await reportingService.generateReport(req.body, req.businessId || "unknown", req.businessId || "default");
    res.status(201).json({ success: true, data: report });
  } catch (error) { handleError(error, res); }
});

router.get("/", authenticateAPIKey, extractRole, requirePermission("reports:read"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const reports = reportingService.listReports({
      ...(req.query as any),
      businessId: req.businessId,
    });
    res.json({ success: true, data: reports });
  } catch (error) { handleError(error, res); }
});

router.get("/deadlines", authenticateAPIKey, extractRole, requirePermission("reports:read"), async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const deadlines = reportingService.getDeadlines();
    res.json({ success: true, data: deadlines });
  } catch (error) { handleError(error, res); }
});

router.get("/analytics", authenticateAPIKey, extractRole, requirePermission("reports:read"), async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const analytics = reportingService.getAnalytics();
    res.json({ success: true, data: analytics });
  } catch (error) { handleError(error, res); }
});

router.get("/:id", authenticateAPIKey, extractRole, requirePermission("reports:read"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const report = reportingService.getReport(req.params.id, req.businessId);
    res.json({ success: true, data: report });
  } catch (error) { handleError(error, res); }
});

router.post("/:id/submit", authenticateAPIKey, extractRole, requirePermission("reports:submit"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const report = await reportingService.submitReport(req.params.id, req.businessId || "unknown", req.businessId);
    res.json({ success: true, data: report });
  } catch (error) { handleError(error, res); }
});

function handleError(error: unknown, res: Response): void {
  if (error instanceof ReportingError) {
    res.status(error.statusCode).json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled reporting error", { error: (error as Error).message });
  res.status(500).json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
