/**
 * Tests for lib/metrics.ts
 *
 * This test file imports the REAL metrics module (not the mock from setup.ts)
 * to get coverage on the actual source file.
 */

describe("Metrics module", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("should export the registry", () => {
    const metrics = require("../../lib/metrics");
    expect(metrics.register).toBeDefined();
    expect(typeof metrics.register.metrics).toBe("function");
  });

  it("should export paymentTotal counter", () => {
    const metrics = require("../../lib/metrics");
    expect(metrics.paymentTotal).toBeDefined();

    // Verify it's a Counter with correct name
    const metricObj = (metrics.paymentTotal as any);
    expect(metricObj.name).toBe("noblepay_payment_total");
  });

  it("should export paymentAmount histogram", () => {
    const metrics = require("../../lib/metrics");
    expect(metrics.paymentAmount).toBeDefined();

    const metricObj = (metrics.paymentAmount as any);
    expect(metricObj.name).toBe("noblepay_payment_amount");
  });

  it("should export screeningDuration histogram", () => {
    const metrics = require("../../lib/metrics");
    expect(metrics.screeningDuration).toBeDefined();

    const metricObj = (metrics.screeningDuration as any);
    expect(metricObj.name).toBe("noblepay_screening_duration_seconds");
  });

  it("should export compliancePassRate gauge", () => {
    const metrics = require("../../lib/metrics");
    expect(metrics.compliancePassRate).toBeDefined();

    const metricObj = (metrics.compliancePassRate as any);
    expect(metricObj.name).toBe("noblepay_compliance_pass_rate");
  });

  it("should export flaggedPayments gauge", () => {
    const metrics = require("../../lib/metrics");
    expect(metrics.flaggedPayments).toBeDefined();

    const metricObj = (metrics.flaggedPayments as any);
    expect(metricObj.name).toBe("noblepay_flagged_payments");
  });

  it("should export activeBusinesses gauge", () => {
    const metrics = require("../../lib/metrics");
    expect(metrics.activeBusinesses).toBeDefined();

    const metricObj = (metrics.activeBusinesses as any);
    expect(metricObj.name).toBe("noblepay_active_businesses");
  });

  it("should export httpRequestDuration histogram", () => {
    const metrics = require("../../lib/metrics");
    expect(metrics.httpRequestDuration).toBeDefined();

    const metricObj = (metrics.httpRequestDuration as any);
    expect(metricObj.name).toBe("noblepay_http_request_duration_seconds");
  });

  it("should export httpRequestTotal counter", () => {
    const metrics = require("../../lib/metrics");
    expect(metrics.httpRequestTotal).toBeDefined();

    const metricObj = (metrics.httpRequestTotal as any);
    expect(metricObj.name).toBe("noblepay_http_requests_total");
  });

  it("should export teeNodesActive gauge", () => {
    const metrics = require("../../lib/metrics");
    expect(metrics.teeNodesActive).toBeDefined();

    const metricObj = (metrics.teeNodesActive as any);
    expect(metricObj.name).toBe("noblepay_tee_nodes_active");
  });

  it("should export teeAttestationFailures counter", () => {
    const metrics = require("../../lib/metrics");
    expect(metrics.teeAttestationFailures).toBeDefined();

    const metricObj = (metrics.teeAttestationFailures as any);
    expect(metricObj.name).toBe("noblepay_tee_attestation_failures_total");
  });

  it("should allow incrementing counters", () => {
    const metrics = require("../../lib/metrics");

    expect(() => {
      metrics.paymentTotal.inc({ status: "completed", currency: "USDC" });
      metrics.httpRequestTotal.inc({ method: "GET", route: "/test", status_code: "200" });
      metrics.teeAttestationFailures.inc();
    }).not.toThrow();
  });

  it("should allow observing histograms", () => {
    const metrics = require("../../lib/metrics");

    expect(() => {
      metrics.paymentAmount.observe({ currency: "USDC" }, 100);
      metrics.screeningDuration.observe({ result: "passed" }, 0.5);
      metrics.httpRequestDuration.observe({ method: "GET", route: "/test", status_code: "200" }, 0.1);
    }).not.toThrow();
  });

  it("should allow setting gauges", () => {
    const metrics = require("../../lib/metrics");

    expect(() => {
      metrics.compliancePassRate.set(0.95);
      metrics.flaggedPayments.set(5);
      metrics.activeBusinesses.set({ tier: "STANDARD" }, 10);
      metrics.teeNodesActive.set(3);
    }).not.toThrow();
  });

  it("should register all metrics in the registry", async () => {
    const metrics = require("../../lib/metrics");
    const registeredMetrics = await metrics.register.getMetricsAsJSON();

    const names = registeredMetrics.map((m: any) => m.name);
    expect(names).toContain("noblepay_payment_total");
    expect(names).toContain("noblepay_payment_amount");
    expect(names).toContain("noblepay_screening_duration_seconds");
    expect(names).toContain("noblepay_compliance_pass_rate");
    expect(names).toContain("noblepay_flagged_payments");
    expect(names).toContain("noblepay_active_businesses");
    expect(names).toContain("noblepay_http_request_duration_seconds");
    expect(names).toContain("noblepay_http_requests_total");
    expect(names).toContain("noblepay_tee_nodes_active");
    expect(names).toContain("noblepay_tee_attestation_failures_total");
  });
});
