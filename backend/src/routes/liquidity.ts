import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { LiquidityService, LiquidityError } from "../services/liquidity";
import { AuditService } from "../services/audit";
import { extractRole, requirePermission, requireRole } from "../middleware/rbac";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();
const auditService = new AuditService(prisma);
const liquidityService = new LiquidityService(prisma, auditService);

const router = Router();

router.get("/pools", authenticateAPIKey, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const status = req.query.status as any;
    const pools = liquidityService.getPools(status);
    res.json({ success: true, data: pools });
  } catch (error) { handleError(error, res); }
});

router.get("/pools/:id", authenticateAPIKey, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const pool = liquidityService.getPool(req.params.id);
    res.json({ success: true, data: pool });
  } catch (error) { handleError(error, res); }
});

router.post("/pools/:id/add", authenticateAPIKey, extractRole, requirePermission("liquidity:manage"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const position = await liquidityService.addLiquidity(
      { ...req.body, poolId: req.params.id },
      req.businessId || "unknown",
      req.businessId || "default",
    );
    res.status(201).json({ success: true, data: position });
  } catch (error) { handleError(error, res); }
});

router.post("/pools/:id/remove", authenticateAPIKey, extractRole, requirePermission("liquidity:manage"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await liquidityService.removeLiquidity(req.body, req.businessId || "unknown", req.businessId);
    res.json({ success: true, data: result });
  } catch (error) { handleError(error, res); }
});

router.get("/positions", authenticateAPIKey, extractRole, requirePermission("liquidity:read"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const provider = req.query.provider as string | undefined;
    const positions = liquidityService.getPositions(provider, req.businessId);
    res.json({ success: true, data: positions });
  } catch (error) { handleError(error, res); }
});

router.post("/flash", authenticateAPIKey, extractRole, requirePermission("liquidity:manage"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await liquidityService.requestFlashLiquidity(req.body.poolId, req.body.amount, req.businessId || "unknown");
    res.status(201).json({ success: true, data: result });
  } catch (error) { handleError(error, res); }
});

router.get("/analytics", authenticateAPIKey, extractRole, requireRole("ADMIN", "ANALYST"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const analytics = liquidityService.getAnalytics(req.businessId);
    res.json({ success: true, data: analytics });
  } catch (error) { handleError(error, res); }
});

function handleError(error: unknown, res: Response): void {
  if (error instanceof LiquidityError) {
    res.status(error.statusCode).json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled liquidity error", { error: (error as Error).message });
  res.status(500).json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
