import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { AuthenticatedRequest, authenticateAPIKey, tierRateLimit } from "../middleware/auth";
import {
  validate,
  CreatePaymentSchema,
  ListPaymentsSchema,
  BatchPaymentSchema,
} from "../middleware/validation";
import { PaymentService, PaymentError } from "../services/payment";
import { AuditService } from "../services/audit";
import { extractRole, requirePermission, requireRole } from "../middleware/rbac";
import { logger } from "../lib/logger";

const prisma = new PrismaClient();
const auditService = new AuditService(prisma);
const paymentService = new PaymentService(prisma, auditService);

const router = Router();

// ─── POST /v1/payments — Create a new payment ──────────────────────────────

router.post(
  "/",
  authenticateAPIKey,
  extractRole,
  requirePermission("payments:create"),
  tierRateLimit,
  validate(CreatePaymentSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const businessId = req.businessId!;

      // Validate business limits
      const limitsCheck = await paymentService.validateBusinessLimits(
        businessId,
        req.body.amount,
        req.body.currency,
      );

      if (!limitsCheck.allowed) {
        res.status(403).json({
          error: "LIMIT_EXCEEDED",
          message: limitsCheck.reason,
        });
        return;
      }

      // Calculate fees
      const fees = paymentService.calculateFees(req.body.amount, req.businessTier!);

      const payment = await paymentService.createPayment(req.body, businessId);

      res.status(201).json({
        success: true,
        data: {
          ...payment,
          amount: payment.amount.toString(),
          fees,
        },
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/payments — List payments ───────────────────────────────────────

router.get(
  "/",
  authenticateAPIKey,
  extractRole,
  requirePermission("payments:read"),
  validate(ListPaymentsSchema, "query"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      // Scope payment listing to the authenticated business
      const result = await paymentService.listPayments(req.query as any, req.businessId);

      res.json({
        success: true,
        data: result.data.map((p) => ({
          ...p,
          amount: p.amount.toString(),
        })),
        pagination: result.pagination,
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/payments/stats — Dashboard statistics ──────────────────────────

router.get(
  "/stats",
  authenticateAPIKey,
  extractRole,
  requireRole("ADMIN", "ANALYST"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const stats = await paymentService.getStats(req.businessId);
      res.json({ success: true, data: stats });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── GET /v1/payments/:id — Get payment details ────────────────────────────

router.get(
  "/:id",
  authenticateAPIKey,
  extractRole,
  requirePermission("payments:read"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const payment = await paymentService.getPayment(req.params.id);

      if (!payment) {
        res.status(404).json({
          error: "PAYMENT_NOT_FOUND",
          message: "Payment not found",
        });
        return;
      }

      // Tenant isolation: verify payment belongs to the authenticated business
      if (payment.businessId && payment.businessId !== req.businessId) {
        res.status(403).json({
          error: "FORBIDDEN",
          message: "You do not have access to this payment",
        });
        return;
      }

      res.json({
        success: true,
        data: {
          ...payment,
          amount: payment.amount.toString(),
        },
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/payments/:id/cancel — Cancel a pending payment ───────────────

router.post(
  "/:id/cancel",
  authenticateAPIKey,
  extractRole,
  requirePermission("payments:cancel"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const payment = await paymentService.cancelPayment(
        req.params.id,
        req.businessId || "unknown",
      );

      res.json({
        success: true,
        data: {
          ...payment,
          amount: payment.amount.toString(),
        },
        message: "Payment cancelled successfully",
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/payments/:id/refund — Refund a settled payment ───────────────

router.post(
  "/:id/refund",
  authenticateAPIKey,
  extractRole,
  requirePermission("payments:refund"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const payment = await paymentService.refundPayment(
        req.params.id,
        req.businessId || "unknown",
      );

      res.json({
        success: true,
        data: {
          ...payment,
          amount: payment.amount.toString(),
        },
        message: "Payment refunded successfully",
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── POST /v1/payments/batch — Bulk payment creation ────────────────────────

router.post(
  "/batch",
  authenticateAPIKey,
  extractRole,
  requirePermission("payments:create"),
  tierRateLimit,
  validate(BatchPaymentSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await paymentService.batchProcessPayments(
        req.body.payments,
        req.businessId!,
      );

      res.status(201).json({
        success: true,
        data: {
          succeeded: result.succeeded.map((p) => ({
            ...p,
            amount: p.amount.toString(),
          })),
          failed: result.failed,
        },
        summary: {
          total: req.body.payments.length,
          succeeded: result.succeeded.length,
          failed: result.failed.length,
        },
      });
    } catch (error) {
      handleError(error, res);
    }
  },
);

// ─── Error Handler ──────────────────────────────────────────────────────────

function handleError(error: unknown, res: Response): void {
  if (error instanceof PaymentError) {
    res.status(error.statusCode).json({
      error: error.code,
      message: error.message,
    });
    return;
  }

  logger.error("Unhandled payment error", {
    error: (error as Error).message,
    stack: (error as Error).stack,
  });

  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "An internal error occurred",
  });
}

export default router;
