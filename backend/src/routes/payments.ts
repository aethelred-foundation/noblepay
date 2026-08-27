import { Router, Response } from "express";
import { prisma } from "../lib/db";
import {
  AuthenticatedRequest,
  authenticateAPIKey,
  tierRateLimit,
} from "../middleware/auth";
import {
  validate,
  ListPaymentsSchema,
  ReconcilePaymentSchema,
  PaymentIdentifierParamsSchema,
  PaymentLifecycleSchema,
  ListPaymentsInput,
} from "../middleware/validation";
import { PaymentService, PaymentError } from "../services/payment";
import { AuditService } from "../services/audit";
import {
  extractRole,
  requirePermission,
  requireRole,
} from "../middleware/rbac";
import { logger } from "../lib/logger";
import { PaymentReconciliationService } from "../services/payment-reconciliation";
import { wsService } from "../services/websocket";

const auditService = new AuditService(prisma);
const paymentService = new PaymentService(prisma, auditService);
const reconciliationService = new PaymentReconciliationService(
  prisma,
  auditService,
);

const router = Router();

// ─── POST /v1/payments — Create a new payment ──────────────────────────────

router.post(
  "/",
  authenticateAPIKey,
  extractRole,
  requirePermission("payments:create"),
  tierRateLimit,
  (_req: AuthenticatedRequest, res: Response): void => {
    res.status(410).json({
      error: "ON_CHAIN_INITIATION_REQUIRED",
      message:
        "Database-only payment creation has been retired; submit NoblePay.initiatePayment and POST its receipt to /v1/payments/reconcile",
      reconcileEndpoint: "/v1/payments/reconcile",
    });
  },
);

// ─── POST /v1/payments/reconcile — Verify and persist a wallet transaction ─

router.post(
  "/reconcile",
  authenticateAPIKey,
  extractRole,
  requirePermission("payments:create"),
  tierRateLimit,
  validate(ReconcilePaymentSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const result = await reconciliationService.reconcile(
        req.body,
        req.businessId!,
      );
      publishPaymentUpdate(req.businessId!, {
        event: "payment_reconciled",
        recordId: result.payment.id,
        paymentId: result.payment.paymentId,
        status: result.payment.status,
        riskScore: result.payment.riskScore,
        txHash: result.payment.txHash,
        blockNumber: result.payment.blockNumber?.toString() || null,
        replayed: result.replayed,
        confirmations: result.confirmations,
        chainId: result.chainId,
      });
      res.status(result.replayed ? 200 : 201).json({
        success: true,
        data: {
          ...result.payment,
          amount: result.payment.amount.toString(),
          blockNumber: result.payment.blockNumber?.toString() || null,
          replayed: result.replayed,
          confirmations: result.confirmations,
          chainId: result.chainId,
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
      const result = await paymentService.listPayments(
        req.query as unknown as ListPaymentsInput,
        req.businessId,
      );

      res.json({
        success: true,
        data: result.data.map((p) => ({
          ...p,
          amount: p.amount.toString(),
          blockNumber: p.blockNumber?.toString() || null,
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
  validate(PaymentIdentifierParamsSchema, "params"),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const payment = await paymentService.getPayment(
        req.params.id,
        req.businessId!,
      );

      if (!payment) {
        res.status(404).json({
          error: "PAYMENT_NOT_FOUND",
          message: "Payment not found",
        });
        return;
      }

      const { travelRuleRecord, ...safePayment } = payment;
      res.json({
        success: true,
        data: {
          ...safePayment,
          amount: payment.amount.toString(),
          blockNumber: payment.blockNumber?.toString() || null,
          travelRule: {
            authorized: Boolean(travelRuleRecord),
            shared: travelRuleRecord?.shared || false,
            sharedAt: travelRuleRecord?.sharedAt || null,
          },
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
  validate(PaymentIdentifierParamsSchema, "params"),
  validate(PaymentLifecycleSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await reconcileLifecycle(req, res, "cancel");
  },
);

// ─── POST /v1/payments/:id/refund — Reconcile direct or delayed-gate refund ─

router.post(
  "/:id/refund",
  authenticateAPIKey,
  extractRole,
  requirePermission("payments:refund"),
  validate(PaymentIdentifierParamsSchema, "params"),
  validate(PaymentLifecycleSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await reconcileLifecycle(req, res, "refund");
  },
);

// ─── POST /v1/payments/:id/settle — Reconcile verified settlement ─────────

router.post(
  "/:id/settle",
  authenticateAPIKey,
  extractRole,
  requirePermission("payments:create"),
  validate(PaymentIdentifierParamsSchema, "params"),
  validate(PaymentLifecycleSchema),
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await reconcileLifecycle(req, res, "settle");
  },
);

// ─── POST /v1/payments/batch — Bulk payment creation ────────────────────────

router.post(
  "/batch",
  authenticateAPIKey,
  extractRole,
  requirePermission("payments:create"),
  tierRateLimit,
  (_req: AuthenticatedRequest, res: Response): void => {
    res.status(410).json({
      error: "ON_CHAIN_BATCH_INITIATION_REQUIRED",
      message:
        "Database-only batch creation has been retired; submit NoblePay.initiatePaymentBatch, then reconcile each emitted payment with this transaction hash and its paymentId",
      reconcileEndpoint: "/v1/payments/reconcile",
    });
  },
);

async function reconcileLifecycle(
  req: AuthenticatedRequest,
  res: Response,
  action: "settle" | "cancel" | "refund",
): Promise<void> {
  try {
    const result = await reconciliationService.reconcileLifecycle(
      req.params.id,
      action,
      req.body.txHash,
      req.businessId!,
    );
    publishPaymentUpdate(req.businessId!, {
      event: `payment_${result.action}`,
      recordId: result.payment.id,
      paymentId: result.payment.paymentId,
      status: result.payment.status,
      riskScore: result.payment.riskScore,
      txHash: result.txHash,
      blockNumber: result.payment.blockNumber?.toString() || null,
      replayed: result.replayed,
      confirmations: result.confirmations,
      chainId: result.chainId,
      method: result.method,
    });
    res.status(result.replayed ? 200 : 201).json({
      success: true,
      data: {
        payment: {
          ...result.payment,
          amount: result.payment.amount.toString(),
          blockNumber: result.payment.blockNumber?.toString() || null,
        },
        action: result.action,
        method: result.method,
        txHash: result.txHash,
        confirmations: result.confirmations,
        chainId: result.chainId,
        replayed: result.replayed,
      },
    });
  } catch (error) {
    handleError(error, res);
  }
}

function publishPaymentUpdate(
  businessId: string,
  payload: Record<string, unknown>,
): void {
  void wsService
    .broadcast("payments", "payment_update", payload, businessId)
    .catch(() => {
      // Reconciliation is already durable; a transient live-channel failure
      // must not change the authoritative HTTP result.
      logger.warn("Payment WebSocket notification failed");
    });
}

// ─── Error Handler ──────────────────────────────────────────────────────────

function handleError(error: unknown, res: Response): void {
  if (error instanceof PaymentError) {
    res.status(error.statusCode).json({
      error: error.code,
      message: error.message,
    });
    return;
  }

  logger.error("Unhandled payment error");

  res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "An internal error occurred",
  });
}

export default router;
