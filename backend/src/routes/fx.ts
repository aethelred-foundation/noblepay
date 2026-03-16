import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { FXService, FXError } from "../services/fx";
import { AuditService } from "../services/audit";
import { extractRole, requirePermission, requireRole } from "../middleware/rbac";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();
const auditService = new AuditService(prisma);
const fxService = new FXService(prisma, auditService);

const router = Router();

router.get("/rates", authenticateAPIKey, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const pair = req.query.pair as string | undefined;
    const rates = fxService.getRates(pair);
    res.json({ success: true, data: rates });
  } catch (error) { handleError(error, res); }
});

router.post("/hedges", authenticateAPIKey, extractRole, requirePermission("fx:trade"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const position = await fxService.createHedge(req.body, req.businessId || "unknown", req.businessId || "default");
    res.status(201).json({ success: true, data: position });
  } catch (error) { handleError(error, res); }
});

router.get("/hedges", authenticateAPIKey, extractRole, requirePermission("fx:read"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const positions = fxService.markToMarket(req.businessId);
    res.json({ success: true, data: positions });
  } catch (error) { handleError(error, res); }
});

router.post("/hedges/:id/close", authenticateAPIKey, extractRole, requirePermission("fx:trade"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await fxService.closePosition(req.params.id, req.businessId || "unknown", req.businessId);
    res.json({ success: true, data: result });
  } catch (error) { handleError(error, res); }
});

router.get("/exposure", authenticateAPIKey, extractRole, requirePermission("fx:read"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const exposure = fxService.getExposure(req.businessId || "default");
    res.json({ success: true, data: exposure });
  } catch (error) { handleError(error, res); }
});

router.get("/analytics", authenticateAPIKey, extractRole, requireRole("ADMIN", "ANALYST"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const analytics = fxService.getAnalytics(req.businessId);
    res.json({ success: true, data: analytics });
  } catch (error) { handleError(error, res); }
});

function handleError(error: unknown, res: Response): void {
  if (error instanceof FXError) {
    res.status(error.statusCode).json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled FX error", { error: (error as Error).message });
  res.status(500).json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
