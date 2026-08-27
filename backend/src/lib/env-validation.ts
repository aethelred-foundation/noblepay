import {
  complianceEvaluationAcknowledged,
  configuredSanctionsMaxAgeMs,
  loadNoblePayChainConfiguration,
  parseBusinessVerifierAddress,
  parseExternalComplianceUrl,
} from "./production-config";
import {
  configuredTravelRuleThresholdUsd,
  loadTravelRuleEncryptionConfiguration,
} from "./travel-rule";

function secretIsStrong(value: string | undefined): boolean {
  return Boolean(value && Buffer.byteLength(value, "utf8") >= 32);
}

function explicitOrigins(raw: string | undefined): string[] | null {
  const values = (raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.includes("*")) return null;
  for (const value of values) {
    try {
      const parsed = new URL(value);
      if (parsed.origin !== value || parsed.protocol !== "https:") return null;
    } catch {
      return null;
    }
  }
  return values;
}

/** Returns every production configuration fault without exposing secret values. */
export function collectProductionEnvErrors(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const errors: string[] = [];
  if (!secretIsStrong(env.JWT_SECRET))
    errors.push("JWT_SECRET must be at least 32 bytes");
  if (!secretIsStrong(env.API_KEY_HASH_SECRET)) {
    errors.push("API_KEY_HASH_SECRET must be at least 32 bytes");
  }
  /*
   * Compliance configuration is required unless this deployment has explicitly
   * acknowledged running without an audited compliance service. The
   * acknowledgement does not make screening permissive: every screening path
   * refuses when the service is unconfigured, and continues to do so here. It
   * only decides whether that missing configuration stops the process from
   * booting at all.
   */
  const complianceEvaluation = complianceEvaluationAcknowledged(env);
  if (!complianceEvaluation && !secretIsStrong(env.COMPLIANCE_API_KEY)) {
    errors.push("COMPLIANCE_API_KEY must be at least 32 bytes");
  }
  if (!env.DATABASE_URL) errors.push("DATABASE_URL is required");

  try {
    const chain = loadNoblePayChainConfiguration(env);
    if (new URL(chain.rpcUrl).protocol !== "https:") {
      errors.push("AETHELRED_RPC_URL must use HTTPS in production");
    }
  } catch (error) {
    errors.push((error as Error).message);
  }
  try {
    parseBusinessVerifierAddress(env);
  } catch (error) {
    errors.push((error as Error).message);
  }
  if (!complianceEvaluation) {
    try {
      parseExternalComplianceUrl(env.COMPLIANCE_API_URL);
    } catch (error) {
      errors.push((error as Error).message);
    }
  } else if (env.COMPLIANCE_API_URL?.trim()) {
    // Acknowledged, but a URL was supplied anyway. Still validate it: a
    // half-configured compliance service is a worse state than none, and the
    // acknowledgement is for the absence of one, not for a broken one.
    try {
      parseExternalComplianceUrl(env.COMPLIANCE_API_URL);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  try {
    configuredSanctionsMaxAgeMs(env.COMPLIANCE_MAX_DATASET_AGE_HOURS);
  } catch (error) {
    errors.push((error as Error).message);
  }
  try {
    loadTravelRuleEncryptionConfiguration(env);
  } catch (error) {
    errors.push((error as Error).message);
  }
  try {
    configuredTravelRuleThresholdUsd(env.TRAVEL_RULE_THRESHOLD_USD);
  } catch (error) {
    errors.push((error as Error).message);
  }

  let publicOrigin: URL | null = null;
  try {
    publicOrigin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN) : null;
    if (
      !publicOrigin ||
      publicOrigin.protocol !== "https:" ||
      publicOrigin.origin !== env.PUBLIC_ORIGIN
    ) {
      throw new Error();
    }
  } catch {
    errors.push("PUBLIC_ORIGIN must be an exact HTTPS origin");
  }

  const origins = explicitOrigins(env.CORS_ORIGIN);
  if (!origins) {
    errors.push("CORS_ORIGIN must contain explicit HTTPS origins");
  } else if (publicOrigin && !origins.includes(publicOrigin.origin)) {
    errors.push("CORS_ORIGIN must include PUBLIC_ORIGIN");
  }
  return [...new Set(errors)];
}
