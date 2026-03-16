import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { PrismaClient } from "@prisma/client";
import { logger, generateCorrelationId } from "./lib/logger";
import { register, httpRequestDuration, httpRequestTotal } from "./lib/metrics";

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

// WebSocket
import { wsService } from "./services/websocket";

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3003", 10);
const NODE_ENV = process.env.NODE_ENV || "development";
const isProduction = NODE_ENV === "production";

// ─── Strict Environment Validation ─────────────────────────────────────────

export function validateProductionEnv(): void {
  const errors: string[] = [];

  if (!process.env.JWT_SECRET) {
    errors.push("JWT_SECRET is required in production");
  }

  if (!process.env.DATABASE_URL) {
    errors.push("DATABASE_URL is required in production");
  }

  if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === "*") {
    errors.push("CORS_ORIGIN must be set to a specific origin in production (wildcard '*' is not allowed)");
  }

  if (errors.length > 0) {
    for (const err of errors) {
      logger.error(`FATAL: ${err}`);
    }
    logger.error("Refusing to start — fix the environment variables above and restart.");
    process.exit(1);
  }
}

if (isProduction) {
  validateProductionEnv();
}

// Resolve CORS origin: in production it is guaranteed to be a real origin
// thanks to the validation above. In development default to localhost.
const CORS_ORIGIN: string = process.env.CORS_ORIGIN || "http://localhost:3000";

// Log validated configuration (no secrets)
logger.info("NoblePay boot configuration", {
  NODE_ENV,
  PORT,
  CORS_ORIGIN,
  DATABASE_URL: process.env.DATABASE_URL ? "(set)" : "(unset)",
  JWT_SECRET: process.env.JWT_SECRET ? "(set)" : "(unset)",
});

// ─── Prisma Client ──────────────────────────────────────────────────────────

export const prisma = new PrismaClient({
  log:
    NODE_ENV === "development"
      ? [
          { emit: "event", level: "query" },
          { emit: "event", level: "error" },
        ]
      : [{ emit: "event", level: "error" }],
});

prisma.$on("error" as never, (e: unknown) => {
  logger.error("Prisma error", { error: e });
});

// ─── Express App ────────────────────────────────────────────────────────────

const app = express();

// ─── Security Middleware ────────────────────────────────────────────────────

app.use(helmet());

app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Correlation-ID"],
    exposedHeaders: ["X-Correlation-ID", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
    maxAge: 86400,
  }),
);

// ─── Body Parsing & Compression ─────────────────────────────────────────────

app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Correlation ID Middleware ──────────────────────────────────────────────

app.use((req, res, next) => {
  const correlationId =
    (req.headers["x-correlation-id"] as string) || generateCorrelationId();
  res.setHeader("X-Correlation-ID", correlationId);
  (req as unknown as Record<string, unknown>).correlationId = correlationId;
  next();
});

// ─── Request Logging ────────────────────────────────────────────────────────

app.use(
  morgan("combined", {
    stream: {
      write: (message: string) => logger.info(message.trim(), { component: "http" }),
    },
    skip: (req) => req.url === "/health" || req.url === "/healthz" || req.url === "/readyz" || req.url === "/metrics",
  }),
);

// ─── Prometheus Metrics Middleware ──────────────────────────────────────────

app.use((req, res, next) => {
  if (req.url === "/health" || req.url === "/healthz" || req.url === "/readyz" || req.url === "/metrics") {
    next();
    return;
  }

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path || req.url;
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

// ─── Rate Limiting ──────────────────────────────────────────────────────────

// General rate limit: 100 req/min
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "RATE_LIMITED",
    message: "Too many requests. Please try again later.",
  },
  skip: (req) => req.url === "/health" || req.url === "/healthz" || req.url === "/readyz" || req.url === "/metrics",
});

// Strict rate limit for payment creation: 10 req/min
const paymentCreationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "RATE_LIMITED",
    message: "Payment creation rate limit exceeded. Maximum 10 per minute.",
  },
});

app.use(generalLimiter);

// ─── Health / Readiness Checks ──────────────────────────────────────────────

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

// Readiness probe — returns 200 only when the DB connection is healthy.
app.get("/readyz", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      status: "ready",
      service: "noblepay-api",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: "connected",
    });
  } catch {
    res.status(503).json({
      status: "not_ready",
      service: "noblepay-api",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: "disconnected",
    });
  }
});

// Legacy /health endpoint — kept for backward compatibility, delegates to readyz.
app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    res.json({
      status: "healthy",
      service: "noblepay-api",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: "connected",
    });
  } catch {
    res.status(503).json({
      status: "unhealthy",
      service: "noblepay-api",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: "disconnected",
    });
  }
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

// Apply strict rate limit to payment creation
app.use("/v1/payments", (req, res, next) => {
  if (req.method === "POST" && (req.path === "/" || req.path === "/batch")) {
    return paymentCreationLimiter(req, res, next);
  }
  next();
});

app.use("/v1/payments", paymentRoutes);
app.use("/v1/compliance", complianceRoutes);
app.use("/v1/businesses", businessRoutes);
app.use("/v1/audit", auditRoutes);
app.use("/v1/treasury", treasuryRoutes);
app.use("/v1/liquidity", liquidityRoutes);
app.use("/v1/streams", streamingRoutes);
app.use("/v1/fx", fxRoutes);
app.use("/v1/invoices", invoiceRoutes);
app.use("/v1/crosschain", crosschainRoutes);
app.use("/v1/reports", reportingRoutes);

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
        NODE_ENV === "development"
          ? err.message
          : "An internal error occurred",
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
  server.close(async () => {
    logger.info("HTTP server closed");

    try {
      // Disconnect Prisma
      await prisma.$disconnect();
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
