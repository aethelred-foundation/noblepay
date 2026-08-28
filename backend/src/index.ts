import express from "express";
import { rateLimit } from "express-rate-limit";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import { logger, generateCorrelationId } from "./lib/logger";
import { register, httpRequestDuration, httpRequestTotal } from "./lib/metrics";
import { disconnectDatabase } from "./lib/db";
import { collectProductionEnvErrors } from "./lib/env-validation";
import { complianceEvaluationAcknowledged, plaintextTestnetRpcAcknowledged } from "./lib/production-config";
import {
  authenticateAPIKey,
  createTierRateLimit,
  tierRateLimit,
} from "./middleware/auth";
import {
  createDefaultReadinessDependencies,
  ReadinessDependencies,
  runReadinessChecks,
} from "./services/readiness";

// Route modules
import paymentRoutes from "./routes/payments";
import complianceRoutes from "./routes/compliance";
import businessRoutes from "./routes/businesses";
import auditRoutes from "./routes/audit";
import treasuryRoutes from "./routes/treasury";
import liquidityRoutes from "./routes/liquidity";
import streamingRoutes from "./routes/streaming";
import fxRoutes from "./routes/fx";
import invoiceRoutes from "./routes/invoices";
import crosschainRoutes from "./routes/crosschain";
import reportingRoutes from "./routes/reporting";
import authRoutes from "./routes/auth";
import aiComplianceRoutes from "./routes/ai-compliance";

// WebSocket
import { wsService } from "./services/websocket";

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "4008", 10);
const NODE_ENV = process.env.NODE_ENV;
const isProduction = NODE_ENV === "production";
// Roadmap modules are available for local development and automated tests
// only. Unknown deployment environments fail closed alongside production.
const roadmapPreviewEnabled = NODE_ENV === "development" || NODE_ENV === "test";

// ─── Strict Environment Validation ─────────────────────────────────────────

export function validateProductionEnv(): void {
  const errors = collectProductionEnvErrors();

  if (errors.length > 0) {
    for (const err of errors) {
      logger.error(`FATAL: ${err}`);
    }
    logger.error(
      "Refusing to start — fix the environment variables above and restart.",
    );
    process.exit(1);
  }

  /*
   * Say it out loud, every boot.
   *
   * A deployment running without compliance screening must not be something
   * anyone discovers later from a config file. Payments still cannot be
   * screened — every screening path refuses with a 501 — so the practical
   * effect is that payment processing is closed while the rest of the service
   * runs. That is worth stating plainly rather than implying by absence.
   */
  if (complianceEvaluationAcknowledged()) {
    logger.warn(
      "EVALUATION MODE: no audited compliance service is configured. " +
        "Compliance screening is DISABLED and every payment requiring a " +
        "screening verdict will be REFUSED with 501. Acknowledged via " +
        "COMPLIANCE_EVALUATION_ACKNOWLEDGEMENT. Never use this for real traffic.",
    );
  }
  if (
    plaintextTestnetRpcAcknowledged() &&
    process.env.AETHELRED_RPC_URL?.trim().startsWith("http://")
  ) {
    logger.warn(
      "EVALUATION MODE: the chain RPC transport is PLAINTEXT http. " +
        "Traffic to the node is neither encrypted nor authenticated in " +
        "transit. Chain-id and network-anchor checks remain mandatory. " +
        "Acknowledged via ALLOW_INSECURE_TESTNET_RPC. Never use this for " +
        "real traffic.",
    );
  }
}

if (isProduction) {
  validateProductionEnv();
}

// Resolve CORS origin: in production it is guaranteed to be a real origin
// thanks to the validation above. In development default to localhost.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:3008")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Log validated configuration (no secrets)
logger.info("NoblePay boot configuration", {
  NODE_ENV,
  PORT,
  CORS_ORIGINS,
  DATABASE_URL: process.env.DATABASE_URL ? "(set)" : "(unset)",
  JWT_SECRET: process.env.JWT_SECRET ? "(set)" : "(unset)",
});

// ─── Express App ────────────────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");
// Production places exactly one managed reverse proxy in front of Express.
// This keeps client IP handling deterministic for rate-limit fallbacks.
app.set("trust proxy", 1);

// ─── Security Middleware ────────────────────────────────────────────────────

app.use(helmet());

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || CORS_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Correlation-ID",
      "X-CSRF-Token",
      "Idempotency-Key",
    ],
    exposedHeaders: [
      "X-Correlation-ID",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "X-CSRF-Token",
      "Idempotency-Key",
    ],
    maxAge: 86400,
  }),
);

// ─── Body Parsing & Compression ─────────────────────────────────────────────

app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(
  express.urlencoded({ extended: false, limit: "256kb", parameterLimit: 100 }),
);

// ─── Correlation ID Middleware ──────────────────────────────────────────────

app.use((req, res, next) => {
  const suppliedCorrelationId = req.headers["x-correlation-id"];
  const correlationId =
    typeof suppliedCorrelationId === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(suppliedCorrelationId)
      ? suppliedCorrelationId
      : generateCorrelationId();
  res.setHeader("X-Correlation-ID", correlationId);
  (req as unknown as Record<string, unknown>).correlationId = correlationId;
  next();
});

// ─── Request Logging ────────────────────────────────────────────────────────

app.use(
  morgan("combined", {
    stream: {
      write: (message: string) =>
        logger.info(message.trim(), { component: "http" }),
    },
    skip: (req) =>
      req.url === "/health" ||
      req.url === "/healthz" ||
      req.url === "/readyz" ||
      req.url === "/metrics",
  }),
);

// ─── Prometheus Metrics Middleware ──────────────────────────────────────────

app.use((req, res, next) => {
  if (
    req.url === "/health" ||
    req.url === "/healthz" ||
    req.url === "/readyz" ||
    req.url === "/metrics"
  ) {
    next();
    return;
  }

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    // Never use attacker-controlled URLs as Prometheus labels. Unknown and
    // rejected paths share a bounded label instead of growing cardinality.
    const route =
      typeof req.route?.path === "string" ? req.route.path : "unmatched";
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
    };

    httpRequestDuration.observe(labels, duration);
    httpRequestTotal.inc(labels);
  });

  next();
});

// ─── Health / Readiness Checks ──────────────────────────────────────────────

let readinessDependencies: ReadinessDependencies =
  createDefaultReadinessDependencies();

/** Test-only injection point for deterministic readiness endpoint coverage. */
export function setReadinessDependenciesForTest(
  dependencies: ReadinessDependencies,
): void {
  if (NODE_ENV !== "test")
    throw new Error("Readiness dependencies can only be replaced in tests");
  readinessDependencies = dependencies;
}

// Liveness probe — always returns 200 if the process is running.
app.get("/healthz", (_req, res) => {
  res.json({
    status: "alive",
    service: "noblepay-api",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Readiness is fail-closed across storage, compliance freshness, chain identity,
// and both production contract deployments. Only coarse states are exposed.
app.get("/readyz", async (_req, res) => {
  const result = await runReadinessChecks(readinessDependencies);
  res.status(result.ready ? 200 : 503).json({
    status: result.ready ? "ready" : "not_ready",
    service: "noblepay-api",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    checks: result.checks,
  });
});

// Legacy /health endpoint remains a readiness alias for older orchestration.
app.get("/health", async (_req, res) => {
  const result = await runReadinessChecks(readinessDependencies);
  res.status(result.ready ? 200 : 503).json({
    status: result.ready ? "healthy" : "unhealthy",
    service: "noblepay-api",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    checks: result.checks,
  });
});

// ─── Prometheus Metrics Endpoint ────────────────────────────────────────────

app.get("/metrics", async (_req, res) => {
  try {
    const metrics = await register.metrics();
    res.set("Content-Type", register.contentType);
    res.send(metrics);
  } catch (error) {
    res.status(500).send("Error collecting metrics");
  }
});

// ─── API Routes ─────────────────────────────────────────────────────────────

// A process-local IP ceiling provides immediate abuse containment and is
// deliberately installed through the standard package recognized by security
// analysis. Authenticated routes additionally consume the PostgreSQL-backed,
// tenant-scoped counters below, which remain authoritative across replicas.
const processApiRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 6_000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "RATE_LIMITED",
    message: "Too many API requests. Please retry later.",
  },
});
app.use("/v1", processApiRateLimit);

const roadmapApiPaths = [
  "/v1/treasury",
  "/v1/liquidity",
  "/v1/streams",
  "/v1/fx",
  "/v1/invoices",
  "/v1/crosschain",
  "/v1/ai-compliance",
];
const authenticatedApiPaths = [
  "/v1/payments",
  "/v1/compliance",
  "/v1/audit",
  "/v1/reports",
  ...(roadmapPreviewEnabled ? roadmapApiPaths : []),
];
app.use(authenticatedApiPaths, authenticateAPIKey, tierRateLimit);

// Registration is the only public business route. Every other business route
// is authenticated and consumes the same durable tenant counter.
app.use("/v1/businesses", (req, res, next) => {
  if (req.method === "POST" && req.path === "/") return next();
  return authenticateAPIKey(req, res, next);
});
app.use("/v1/businesses", (req, res, next) => {
  if (req.method === "POST" && req.path === "/") return next();
  return tierRateLimit(req, res, next);
});

// Challenge and verification have separate durable public counters in their
// router. Session inspection/logout are authenticated and tenant-limited here.
app.use("/v1/auth", (req, res, next) => {
  if (req.path === "/challenge" || req.path === "/verify") return next();
  return authenticateAPIKey(req, res, next);
});
app.use("/v1/auth", (req, res, next) => {
  if (req.path === "/challenge" || req.path === "/verify") return next();
  return tierRateLimit(req, res, next);
});

const paymentWriteLimiter = createTierRateLimit({
  scope: "payment-write",
  limitOverride: 10,
});
app.use("/v1/payments", (req, res, next) => {
  if (req.method === "POST") return paymentWriteLimiter(req, res, next);
  next();
});

app.use("/v1/payments", paymentRoutes);
app.use("/v1/auth", authRoutes);
app.use("/v1/compliance", complianceRoutes);
app.use("/v1/businesses", businessRoutes);
app.use("/v1/audit", auditRoutes);
app.use("/v1/reports", reportingRoutes);

if (roadmapPreviewEnabled) {
  app.use("/v1/treasury", treasuryRoutes);
  app.use("/v1/liquidity", liquidityRoutes);
  app.use("/v1/streams", streamingRoutes);
  app.use("/v1/fx", fxRoutes);
  app.use("/v1/invoices", invoiceRoutes);
  app.use("/v1/crosschain", crosschainRoutes);
  app.use("/v1/ai-compliance", aiComplianceRoutes);
}

// ─── 404 Handler ────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({
    error: "NOT_FOUND",
    message: "The requested endpoint does not exist",
  });
});

// ─── Global Error Handler ───────────────────────────────────────────────────

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    logger.error("Unhandled error", {
      error: err.message,
      stack: err.stack,
    });

    res.status(500).json({
      error: "INTERNAL_ERROR",
      message:
        NODE_ENV === "development" ? err.message : "An internal error occurred",
    });
  },
);

// ─── Server Startup ─────────────────────────────────────────────────────────

// Guard: only bind the listening socket when running as the main entry point
// (not when imported by test harnesses via require/import).
let server: ReturnType<typeof app.listen> | undefined;

if (NODE_ENV !== "test") {
  server = app.listen(PORT, () => {
    logger.info(`NoblePay API server started`, {
      port: PORT,
      environment: NODE_ENV,
      pid: process.pid,
    });

    // Attach WebSocket server
    wsService.attach(server!);
    logger.info("WebSocket server attached on /ws");
  });
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

async function gracefulShutdown(signal: string) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  if (!server) {
    process.exit(0);
    return;
  }

  // Stop accepting new connections
  wsService.close();
  server.close(async () => {
    logger.info("HTTP server closed");

    try {
      await disconnectDatabase();
      logger.info("Database connections closed");
    } catch (error) {
      logger.error("Error during shutdown", {
        error: (error as Error).message,
      });
    }

    process.exit(0);
  });

  // Force shutdown after 30 seconds.
  // .unref() so this timer doesn't itself prevent a clean exit.
  const forceTimer = setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 30_000);
  forceTimer.unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

export { server };
export default app;
