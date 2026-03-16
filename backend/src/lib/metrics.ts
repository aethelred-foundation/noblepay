import client from "prom-client";

// Create a registry
export const register = new client.Registry();

// Add default metrics (GC, event loop, etc.)
client.collectDefaultMetrics({ register });

// ─── Payment Metrics ────────────────────────────────────────────────────────

export const paymentTotal = new client.Counter({
  name: "noblepay_payment_total",
  help: "Total number of payments processed",
  labelNames: ["status", "currency"] as const,
  registers: [register],
});

export const paymentAmount = new client.Histogram({
  name: "noblepay_payment_amount",
  help: "Distribution of payment amounts in USD equivalent",
  buckets: [10, 100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000],
  labelNames: ["currency"] as const,
  registers: [register],
});

// ─── Compliance Metrics ─────────────────────────────────────────────────────

export const screeningDuration = new client.Histogram({
  name: "noblepay_screening_duration_seconds",
  help: "Duration of compliance screening in seconds",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  labelNames: ["result"] as const,
  registers: [register],
});

export const compliancePassRate = new client.Gauge({
  name: "noblepay_compliance_pass_rate",
  help: "Current compliance pass rate (0-1)",
  registers: [register],
});

export const flaggedPayments = new client.Gauge({
  name: "noblepay_flagged_payments",
  help: "Number of currently flagged payments awaiting review",
  registers: [register],
});

// ─── Business Metrics ───────────────────────────────────────────────────────

export const activeBusinesses = new client.Gauge({
  name: "noblepay_active_businesses",
  help: "Number of active verified businesses",
  labelNames: ["tier"] as const,
  registers: [register],
});

// ─── API Metrics ────────────────────────────────────────────────────────────

export const httpRequestDuration = new client.Histogram({
  name: "noblepay_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

export const httpRequestTotal = new client.Counter({
  name: "noblepay_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

// ─── TEE Metrics ────────────────────────────────────────────────────────────

export const teeNodesActive = new client.Gauge({
  name: "noblepay_tee_nodes_active",
  help: "Number of active TEE nodes",
  registers: [register],
});

export const teeAttestationFailures = new client.Counter({
  name: "noblepay_tee_attestation_failures_total",
  help: "Total TEE attestation failures",
  registers: [register],
});
