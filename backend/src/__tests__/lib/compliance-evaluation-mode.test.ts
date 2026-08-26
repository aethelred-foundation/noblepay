/**
 * Compliance evaluation mode.
 *
 * This is the one acknowledgement in the stack that touches a compliance
 * control, so the tests are about what it does NOT do. It must not make
 * screening permissive, it must not be reachable on mainnet, and it must not be
 * possible to enable by accident.
 *
 * The property that matters most: a payment that needs a screening verdict is
 * still REFUSED. Evaluation mode changes whether the process boots, not whether
 * money can move unscreened.
 */

import {
  COMPLIANCE_EVALUATION_ACKNOWLEDGEMENT,
  complianceEvaluationAcknowledged,
} from "../../lib/production-config";
import { collectProductionEnvErrors } from "../../lib/env-validation";
import { runReadinessChecks } from "../../services/readiness";

const ACK = COMPLIANCE_EVALUATION_ACKNOWLEDGEMENT;

function evaluationEnv(
  over: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    COMPLIANCE_EVALUATION_ACKNOWLEDGEMENT: ACK,
    NEXT_PUBLIC_CHAIN_ENV: "testnet",
    NOBLEPAY_CHAIN_ID: "7332",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

describe("complianceEvaluationAcknowledged", () => {
  it("accepts the exact acknowledgement on the public testnet", () => {
    expect(complianceEvaluationAcknowledged(evaluationEnv())).toBe(true);
  });

  it("refuses a merely truthy value", () => {
    // A boolean flag can be set by accident. A fixed sentence cannot.
    for (const value of ["true", "1", "yes", "acknowledge", ""]) {
      expect(
        complianceEvaluationAcknowledged(
          evaluationEnv({ COMPLIANCE_EVALUATION_ACKNOWLEDGEMENT: value }),
        ),
      ).toBe(false);
    }
  });

  it("cannot be reached on mainnet", () => {
    expect(
      complianceEvaluationAcknowledged(
        evaluationEnv({ NEXT_PUBLIC_CHAIN_ENV: "mainnet" }),
      ),
    ).toBe(false);
  });

  it("cannot be reached on another chain id", () => {
    expect(
      complianceEvaluationAcknowledged(
        evaluationEnv({ NOBLEPAY_CHAIN_ID: "1" }),
      ),
    ).toBe(false);
  });

  it("is off when nothing is set", () => {
    expect(complianceEvaluationAcknowledged({})).toBe(false);
  });
});

describe("boot validation", () => {
  const base = {
    JWT_SECRET: "a".repeat(32),
    API_KEY_HASH_SECRET: "b".repeat(32),
    DATABASE_URL: "postgresql://u:p@postgres:5432/db",
  };

  it("still demands compliance configuration without the acknowledgement", () => {
    const errors = collectProductionEnvErrors({
      ...base,
      NEXT_PUBLIC_CHAIN_ENV: "testnet",
      NOBLEPAY_CHAIN_ID: "7332",
    } as NodeJS.ProcessEnv);
    expect(errors.join("\n")).toMatch(/COMPLIANCE_API_KEY/u);
    expect(errors.join("\n")).toMatch(/COMPLIANCE_API_URL/u);
  });

  it("drops only the compliance faults when acknowledged", () => {
    const errors = collectProductionEnvErrors({
      ...base,
      ...evaluationEnv(),
    } as NodeJS.ProcessEnv);
    const joined = errors.join("\n");
    expect(joined).not.toMatch(/COMPLIANCE_API_KEY/u);
    expect(joined).not.toMatch(/COMPLIANCE_API_URL/u);
  });

  it("still validates a compliance URL that WAS supplied", () => {
    // Acknowledging the absence of a service is not a licence to point at a
    // broken one; half-configured is worse than absent.
    const errors = collectProductionEnvErrors({
      ...base,
      ...evaluationEnv({ COMPLIANCE_API_URL: "http://localhost:9000" }),
    } as NodeJS.ProcessEnv);
    expect(errors.join("\n")).toMatch(/COMPLIANCE_API_URL/u);
  });
});

describe("readiness reporting", () => {
  const ok = () => Promise.resolve();

  it("reports evaluation-unconfigured rather than ready", async () => {
    // "ready" would tell a monitoring system that screening works.
    const result = await runReadinessChecks(
      { database: ok, compliance: ok, rpc: ok, contracts: ok },
      5_000,
      true,
    );
    expect(result.checks.compliance).toBe("evaluation-unconfigured");
    expect(result.ready).toBe(true);
  });

  it("reports plain ready when a real service answered", async () => {
    const result = await runReadinessChecks(
      { database: ok, compliance: ok, rpc: ok, contracts: ok },
      5_000,
      false,
    );
    expect(result.checks.compliance).toBe("ready");
  });

  it("does not mask a genuinely failing dependency", async () => {
    const result = await runReadinessChecks(
      {
        database: () => Promise.reject(new Error("down")),
        compliance: ok,
        rpc: ok,
        contracts: ok,
      },
      5_000,
      true,
    );
    expect(result.checks.database).toBe("unavailable");
    expect(result.ready).toBe(false);
  });
});
