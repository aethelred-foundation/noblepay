import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { CrossChainService, CrossChainError } from "../services/crosschain";
import { AuditService } from "../services/audit";
import { extractRole, requirePermission, requireRole } from "../middleware/rbac";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();
const auditService = new AuditService(prisma);
const crossChainService = new CrossChainService(prisma, auditService);

const router = Router();

router.get("/chains", authenticateAPIKey, async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const chains = crossChainService.getChains();
    res.json({ success: true, data: chains });
  } catch (error) { handleError(error, res); }
});

router.get("/routes", authenticateAPIKey, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { source, destination, token, amount } = req.query as Record<string, string>;
    const routes = crossChainService.getRoutes(source, destination, token, amount);
    res.json({ success: true, data: routes });
  } catch (error) { handleError(error, res); }
});

router.post("/transfers", authenticateAPIKey, extractRole, requirePermission("crosschain:initiate"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const transfer = await crossChainService.initiateTransfer(req.body, req.businessId || "unknown", req.businessId || "default");
    res.status(201).json({ success: true, data: transfer });
  } catch (error) { handleError(error, res); }
});

router.get("/transfers", authenticateAPIKey, extractRole, requirePermission("crosschain:read"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const filters = { ...(req.query as any), businessId: req.businessId };
    const transfers = crossChainService.listTransfers(filters);
    res.json({ success: true, data: transfers });
  } catch (error) { handleError(error, res); }
});

router.get("/transfers/:id", authenticateAPIKey, extractRole, requirePermission("crosschain:read"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const transfer = crossChainService.getTransfer(req.params.id, req.businessId);
    res.json({ success: true, data: transfer });
  } catch (error) { handleError(error, res); }
});

router.post("/recover", authenticateAPIKey, extractRole, requirePermission("crosschain:manage"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await crossChainService.recoverTransfer(req.body.transferId, req.businessId || "unknown", req.businessId);
    res.json({ success: true, data: result });
  } catch (error) { handleError(error, res); }
});

router.get("/relays", authenticateAPIKey, async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const nodes = crossChainService.getRelayNodes();
    res.json({ success: true, data: nodes });
  } catch (error) { handleError(error, res); }
});

router.get("/analytics", authenticateAPIKey, extractRole, requireRole("ADMIN", "ANALYST"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const analytics = crossChainService.getAnalytics(req.businessId);
    res.json({ success: true, data: analytics });
  } catch (error) { handleError(error, res); }
});

function handleError(error: unknown, res: Response): void {
  if (error instanceof CrossChainError) {
    res.status(error.statusCode).json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled cross-chain error", { error: (error as Error).message });
  res.status(500).json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
