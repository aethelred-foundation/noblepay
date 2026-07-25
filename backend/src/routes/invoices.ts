import { Router, Response } from "express";
import { z } from "zod";
import { AuthenticatedRequest, authenticateAPIKey } from "../middleware/auth";
import { InvoiceService, InvoiceError } from "../services/invoice";
import { AuditService } from "../services/audit";
import {
  extractRole,
  requireOwnership,
  requirePermission,
  requireRole,
} from "../middleware/rbac";
import { validate } from "../middleware/validation";
import { logger } from "../lib/logger";
import { prisma } from "../lib/db";

const auditService = new AuditService(prisma);
const invoiceService = new InvoiceService(prisma, auditService);
const router = Router();

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address");
const positiveDecimal = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .refine((value) => Number(value) > 0, "Amount must be greater than zero");
const invoiceId = z
  .object({
    id: z
      .string()
      .min(5)
      .max(100)
      .regex(/^inv-[a-zA-Z0-9-]+$/),
  })
  .strict();
const createSchema = z
  .object({
    debtor: address,
    debtorName: z.string().trim().min(1).max(255),
    amount: positiveDecimal,
    currency: z.string().regex(/^[A-Z0-9]{2,10}$/),
    maturityDate: z
      .string()
      .max(35)
      .refine(
        (value) => Number.isFinite(new Date(value).getTime()),
        "Invalid maturity date",
      ),
    description: z.string().trim().min(1).max(2_000),
    purchaseOrderRef: z.string().trim().min(1).max(200).optional(),
    gracePeriodDays: z.number().int().min(0).max(365).optional(),
    latePenaltyRate: z.number().min(0).max(1).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();
const listSchema = z
  .object({
    issuer: address.optional(),
    debtor: address.optional(),
    status: z
      .enum([
        "DRAFT",
        "ISSUED",
        "FINANCED",
        "PARTIALLY_FINANCED",
        "SETTLED",
        "OVERDUE",
        "DISPUTED",
        "CANCELLED",
        "WRITTEN_OFF",
      ])
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Z0-9]{2,10}$/)
      .optional(),
  })
  .strict();
const financingSchema = z.object({ amount: positiveDecimal }).strict();
const settlementSchema = z
  .object({ settlementReference: z.string().trim().min(1).max(200) })
  .strict();
const disputeSchema = z
  .object({ reason: z.string().trim().min(10).max(2_000) })
  .strict();
const businessParams = z.object({ businessId: z.string().uuid() }).strict();

function tenant(req: AuthenticatedRequest): string {
  if (!req.businessId)
    throw new InvoiceError(
      "TENANT_REQUIRED",
      "Authenticated business is required",
      401,
    );
  return req.businessId;
}

function actor(req: AuthenticatedRequest): string {
  return req.signerId || req.jwtPayload?.sub || "authenticated-user";
}

function idempotencyKey(req: AuthenticatedRequest): string {
  const value = req.headers["idempotency-key"];
  const key = Array.isArray(value) ? value[0] : value;
  if (typeof key !== "string" || !/^[A-Za-z0-9._~-]{8,120}$/.test(key)) {
    throw new InvoiceError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "A valid Idempotency-Key header is required",
      400,
    );
  }
  return key;
}

router.post(
  "/",
  authenticateAPIKey,
  extractRole,
  requirePermission("invoices:create"),
  validate(createSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const invoice = await invoiceService.createInvoice(
        req.body,
        actor(req),
        tenant(req),
      );
      res.status(201).json({ success: true, data: invoice });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/",
  authenticateAPIKey,
  extractRole,
  requirePermission("invoices:read"),
  validate(listSchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const invoices = await invoiceService.listInvoices({
        businessId: tenant(req),
        issuer: req.query.issuer as string | undefined,
        debtor: req.query.debtor as string | undefined,
        status: req.query.status as never,
        currency: req.query.currency as string | undefined,
      });
      res.json({ success: true, data: invoices });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/credit-score/:businessId",
  authenticateAPIKey,
  extractRole,
  requirePermission("invoices:read"),
  validate(businessParams, "params"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!requireOwnership(req as never, req.params.businessId)) {
        res.status(403).json({
          error: "FORBIDDEN",
          message: "You do not have access to this business credit score",
        });
        return;
      }
      const score = await invoiceService.getCreditScore(req.params.businessId);
      res.json({ success: true, data: score });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/analytics",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN", "ANALYST"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const analytics = await invoiceService.getAnalytics(tenant(req));
      res.json({ success: true, data: analytics });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/:id/financing",
  authenticateAPIKey,
  extractRole,
  requirePermission("invoices:read"),
  validate(invoiceId, "params"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const requests = await invoiceService.listFinancingRequests(
        req.params.id,
        tenant(req),
      );
      res.json({ success: true, data: requests });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/:id/finance",
  authenticateAPIKey,
  extractRole,
  requirePermission("invoices:finance"),
  validate(invoiceId, "params"),
  validate(financingSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await invoiceService.requestFinancing(
        req.params.id,
        req.body.amount,
        actor(req),
        tenant(req),
        idempotencyKey(req),
      );
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/:id/settle",
  authenticateAPIKey,
  extractRole,
  requirePermission("invoices:manage"),
  validate(invoiceId, "params"),
  validate(settlementSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const invoice = await invoiceService.settleInvoice(
        req.params.id,
        actor(req),
        tenant(req),
        req.body.settlementReference,
      );
      res.json({ success: true, data: invoice });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.post(
  "/:id/dispute",
  authenticateAPIKey,
  extractRole,
  requirePermission("invoices:manage"),
  validate(invoiceId, "params"),
  validate(disputeSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const dispute = await invoiceService.raiseDispute(
        req.params.id,
        req.body.reason,
        actor(req),
        tenant(req),
      );
      res.status(201).json({ success: true, data: dispute });
    } catch (error) {
      handleError(error, res);
    }
  },
);

router.get(
  "/:id",
  authenticateAPIKey,
  extractRole,
  requirePermission("invoices:read"),
  validate(invoiceId, "params"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const invoice = await invoiceService.getInvoice(
        req.params.id,
        tenant(req),
      );
      res.json({ success: true, data: invoice });
    } catch (error) {
      handleError(error, res);
    }
  },
);

function handleError(error: unknown, res: Response): void {
  if (error instanceof InvoiceError) {
    res
      .status(error.statusCode)
      .json({ error: error.code, message: error.message });
    return;
  }
  logger.error("Unhandled invoice error", { error: (error as Error).message });
  res
    .status(500)
    .json({ error: "INTERNAL_ERROR", message: "An internal error occurred" });
}

export default router;
