import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { InvoiceService, InvoiceError } from "../services/invoice";
import { AuditService } from "../services/audit";
import { extractRole, requireOwnership, requirePermission, requireRole } from "../middleware/rbac";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();
const auditService = new AuditService(prisma);
const invoiceService = new InvoiceService(prisma, auditService);

const router = Router();

router.post("/", authenticateAPIKey, extractRole, requirePermission("invoices:create"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const invoice = await invoiceService.createInvoice(req.body, req.businessId || "unknown", req.businessId || "default");
    res.status(201).json({ success: true, data: invoice });
  } catch (error) { handleError(error, res); }
});

router.get("/", authenticateAPIKey, extractRole, requirePermission("invoices:read"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const filters = { ...(req.query as any), businessId: req.businessId };
    const invoices = invoiceService.listInvoices(filters);
    res.json({ success: true, data: invoices });
  } catch (error) { handleError(error, res); }
});

router.get("/credit-score/:businessId", authenticateAPIKey, extractRole, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Ownership check: caller can only view their own credit score unless admin
    if (!requireOwnership(req as any, req.params.businessId)) {
      res.status(403).json({ error: "FORBIDDEN", message: "You do not have access to this business's credit score" });
      return;
    }
    const score = invoiceService.getCreditScore(req.params.businessId);
    res.json({ success: true, data: score });
  } catch (error) { handleError(error, res); }
});

router.get("/analytics", authenticateAPIKey, extractRole, requireRole("ADMIN", "ANALYST"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const analytics = invoiceService.getAnalytics(req.businessId);
    res.json({ success: true, data: analytics });
  } catch (error) { handleError(error, res); }
});

router.post("/:id/finance", authenticateAPIKey, extractRole, requirePermission("invoices:finance"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await invoiceService.requestFinancing(req.params.id, req.body.amount, req.businessId || "unknown", req.businessId);
    res.status(201).json({ success: true, data: result });
  } catch (error) { handleError(error, res); }
});

router.post("/:id/settle", authenticateAPIKey, extractRole, requirePermission("invoices:manage"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const invoice = await invoiceService.settleInvoice(req.params.id, req.businessId || "unknown", req.businessId);
    res.json({ success: true, data: invoice });
  } catch (error) { handleError(error, res); }
});

router.post("/:id/dispute", authenticateAPIKey, extractRole, requirePermission("invoices:manage"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await invoiceService.raiseDispute(req.params.id, req.body.reason, req.businessId || "unknown", req.businessId);
    res.json({ success: true, data: result });
  } catch (error) { handleError(error, res); }
});

function handleError(error: unknown, res: Response): void {
  if (error instanceof InvoiceError) {
    res.status(error.statusCode).json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled invoice error", { error: (error as Error).message });
  res.status(500).json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
