import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { StreamingService, StreamError } from "../services/streaming";
import { AuditService } from "../services/audit";
import { extractRole, requirePermission, requireRole } from "../middleware/rbac";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();
const auditService = new AuditService(prisma);
const streamingService = new StreamingService(prisma, auditService);

const router = Router();

router.post("/", authenticateAPIKey, extractRole, requirePermission("streams:create"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const stream = await streamingService.createStream(req.body, req.businessId || "default");
    res.status(201).json({ success: true, data: stream });
  } catch (error) { handleError(error, res); }
});

router.get("/", authenticateAPIKey, extractRole, requirePermission("streams:read"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const filters = { ...(req.query as any), businessId: req.businessId };
    const streams = streamingService.listStreams(filters);
    res.json({ success: true, data: streams });
  } catch (error) { handleError(error, res); }
});

router.get("/:id/balance", authenticateAPIKey, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    // Verify ownership before returning balance
    const stream = streamingService.getStream(req.params.id);
    if (!stream) {
      res.status(404).json({ error: "STREAM_NOT_FOUND", message: "Stream not found" });
      return;
    }
    if (stream.businessId !== req.businessId) {
      res.status(403).json({ error: "FORBIDDEN", message: "You do not have access to this stream" });
      return;
    }
    const balance = streamingService.getStreamBalance(req.params.id);
    res.json({ success: true, data: balance });
  } catch (error) { handleError(error, res); }
});

router.post("/:id/pause", authenticateAPIKey, extractRole, requirePermission("streams:manage"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const stream = await streamingService.pauseStream(req.params.id, req.businessId || "unknown", req.businessId);
    res.json({ success: true, data: stream });
  } catch (error) { handleError(error, res); }
});

router.post("/:id/resume", authenticateAPIKey, extractRole, requirePermission("streams:manage"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const stream = await streamingService.resumeStream(req.params.id, req.businessId || "unknown", req.businessId);
    res.json({ success: true, data: stream });
  } catch (error) { handleError(error, res); }
});

router.post("/:id/cancel", authenticateAPIKey, extractRole, requirePermission("streams:manage"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await streamingService.cancelStream(req.params.id, req.businessId || "unknown", req.businessId);
    res.json({ success: true, data: result });
  } catch (error) { handleError(error, res); }
});

router.post("/:id/adjust-rate", authenticateAPIKey, extractRole, requirePermission("streams:manage"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const stream = await streamingService.adjustRate(req.params.id, req.body.ratePerSecond, req.businessId || "unknown", req.businessId);
    res.json({ success: true, data: stream });
  } catch (error) { handleError(error, res); }
});

router.post("/batch", authenticateAPIKey, extractRole, requirePermission("streams:create"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const result = await streamingService.createBatchStreams({ ...req.body, businessId: req.businessId || "default" });
    res.status(201).json({ success: true, data: result });
  } catch (error) { handleError(error, res); }
});

router.get("/analytics", authenticateAPIKey, extractRole, requireRole("ADMIN", "ANALYST"), async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const analytics = streamingService.getAnalytics(req.businessId);
    res.json({ success: true, data: analytics });
  } catch (error) { handleError(error, res); }
});

function handleError(error: unknown, res: Response): void {
  if (error instanceof StreamError) {
    res.status(error.statusCode).json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled streaming error", { error: (error as Error).message });
  res.status(500).json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
