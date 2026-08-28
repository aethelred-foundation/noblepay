import { getAddress, ZeroAddress } from "ethers";

const EXTERNAL_HOST_DENYLIST = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
]);

export interface NoblePayTokenConfiguration {
  address: string;
  currency: string;
  currencyCode: string;
  decimals: number;
}

export interface NoblePayChainConfiguration {
  rpcUrl: string;
  chainId: bigint;
  networkAnchorBlock: bigint;
  networkAnchorHash: string;
  contractAddress: string;
  registryContractAddress: string;
  minimumConfirmations: number;
  tokens: NoblePayTokenConfiguration[];
}

export interface RpcNetworkIdentity {
  chainId: bigint;
}

export interface RpcAnchorBlock {
  number: bigint | number | string;
  hash?: string | null;
}

export function noblePayNetworkIdentityMatches(
  config: Pick<
    NoblePayChainConfiguration,
    "chainId" | "networkAnchorBlock" | "networkAnchorHash"
  >,
  network: RpcNetworkIdentity,
  anchorBlock: RpcAnchorBlock | null,
): boolean {
  if (network.chainId !== config.chainId || !anchorBlock) return false;
  try {
    return (
      BigInt(anchorBlock.number) === config.networkAnchorBlock &&
      anchorBlock.hash?.toLowerCase() === config.networkAnchorHash
    );
  } catch {
    return false;
  }
}

export function parseNetworkAnchorBlock(
  raw: string | undefined,
  label = "AETHELRED_NETWORK_ANCHOR_BLOCK",
): bigint {
  if (!raw || !/^\d+$/.test(raw)) {
    throw new ConfigurationError(`${label} must be an unsigned integer`);
  }
  return BigInt(raw);
}

export function parseNetworkAnchorHash(
  raw: string | undefined,
  label = "AETHELRED_NETWORK_ANCHOR_HASH",
): string {
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ConfigurationError(
      `${label} must be a 32-byte 0x-prefixed block hash`,
    );
  }
  return raw.toLowerCase();
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function parseHttpUrl(raw: string | undefined, label: string): URL {
  if (!raw) throw new ConfigurationError(`${label} is required`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError(`${label} must be a valid URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ConfigurationError(`${label} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new ConfigurationError(
      `${label} must not contain embedded credentials`,
    );
  }
  return parsed;
}

/**
 * The exact acknowledgement that puts compliance into evaluation mode.
 *
 * Deliberately a single fixed string rather than any truthy value, matching the
 * plaintext-RPC acknowledgement already used elsewhere in this stack. A boolean
 * flag can be set by accident; this cannot.
 */
export const COMPLIANCE_EVALUATION_ACKNOWLEDGEMENT =
  "acknowledge-evaluation-only-no-compliance-screening";

/** The public testnet. Evaluation mode is refused on any other chain. */
const AETHELRED_PUBLIC_TESTNET_CHAIN_ID = "7332";

/**
 * Whether this deployment may run WITHOUT an audited compliance service.
 *
 * This does not weaken screening. Every path that would call the compliance
 * service already refuses when it is unconfigured — three call sites in
 * services/compliance.ts, each throwing COMPLIANCE_SUBMISSION_NOT_CONFIGURED
 * with a 501. What this controls is narrower: whether the backend REFUSES TO
 * BOOT over the missing configuration, or boots with those paths closed so the
 * rest of the stack can be exercised.
 *
 * The distinction worth holding onto: no payment gets screened either way. The
 * difference is between a container that will not start and a container that
 * starts and declines to process payments.
 *
 * Conditions are conjunctive and neither is a default:
 *   - the exact acknowledgement string
 *   - NOBLEPAY_CHAIN_ID is the public-testnet chain id
 *
 * Mainnet cannot reach this state no matter what is set, because mainnet does
 * not run on 7332.
 *
 * An earlier version of this gate also required NEXT_PUBLIC_CHAIN_ENV=testnet.
 * That was wrong twice over: NEXT_PUBLIC_* is a frontend BUILD-time namespace
 * meaning "safe to inline into the browser bundle", which is a claim about
 * publicity and not about which network this is; and the backend container is
 * never given that variable, so the gate could not open at all under Compose.
 * NOBLEPAY_CHAIN_ID is backend-owned, already required, and already bound to
 * the operator-confirmed network anchor -- so it is the authoritative signal,
 * and a second variable restating it would only add a way to misconfigure.
 */
/**
 * The exact acknowledgement that permits a PLAINTEXT (http) chain RPC.
 *
 * The same literal the deploy scripts and the frontend build already use
 * (scripts/lib/rpc-transport-policy.mjs, next.config.js); the backend adopts
 * it rather than inventing a second one. The validator pins the two literals
 * against each other so they cannot drift.
 */
export const PLAINTEXT_RPC_ACKNOWLEDGEMENT =
  "acknowledge-evaluation-only-plaintext-rpc";

/**
 * Whether this deployment may talk to its chain RPC over plaintext http.
 *
 * Same shape as complianceEvaluationAcknowledged, for the same reasons: the
 * exact string (a boolean can be set by accident), conjoined with the
 * backend-owned public-testnet chain id. Mainnet cannot reach this state, and
 * the network-anchor check still binds whatever answers the URL to the
 * operator-confirmed chain: a plaintext transport weakens confidentiality and
 * integrity of the hop, not which network the backend will accept.
 */
export function plaintextTestnetRpcAcknowledged(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.ALLOW_INSECURE_TESTNET_RPC?.trim() === PLAINTEXT_RPC_ACKNOWLEDGEMENT &&
    env.NOBLEPAY_CHAIN_ID?.trim() === AETHELRED_PUBLIC_TESTNET_CHAIN_ID
  );
}

export function complianceEvaluationAcknowledged(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.COMPLIANCE_EVALUATION_ACKNOWLEDGEMENT?.trim() ===
      COMPLIANCE_EVALUATION_ACKNOWLEDGEMENT &&
    env.NOBLEPAY_CHAIN_ID?.trim() === AETHELRED_PUBLIC_TESTNET_CHAIN_ID
  );
}

export function parseExternalComplianceUrl(
  raw = process.env.COMPLIANCE_API_URL,
): URL {
  const parsed = parseHttpUrl(raw, "COMPLIANCE_API_URL");
  const hostname = parsed.hostname.toLowerCase();
  const privateIpv4 =
    /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(
      hostname,
    );
  const privateIpv6 =
    hostname === "::1" ||
    /^(?:fc|fd|fe8|fe9|fea|feb)/.test(hostname.replace(/^\[|\]$/g, ""));
  if (
    parsed.protocol !== "https:" ||
    !raw ||
    raw !== parsed.origin ||
    EXTERNAL_HOST_DENYLIST.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".invalid") ||
    hostname === "example.com" ||
    hostname.endsWith(".example.com") ||
    hostname.includes("replace-with") ||
    hostname.includes("mock") ||
    hostname.includes("fixture") ||
    privateIpv4 ||
    privateIpv6
  ) {
    throw new ConfigurationError(
      "COMPLIANCE_API_URL must be the exact external HTTPS origin of the deployed compliance service",
    );
  }
  return parsed;
}

export function parsePositiveInteger(
  raw: string | undefined,
  label: string,
): number {
  if (!raw || !/^\d+$/.test(raw)) {
    throw new ConfigurationError(`${label} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConfigurationError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function parseNonZeroAddress(
  raw: string | undefined,
  label: string,
): string {
  if (!raw) throw new ConfigurationError(`${label} is required`);
  let address: string;
  try {
    address = getAddress(raw);
  } catch {
    throw new ConfigurationError(`${label} must be a valid EVM address`);
  }
  if (address === ZeroAddress)
    throw new ConfigurationError(`${label} must not be the zero address`);
  return address;
}

export function parseBusinessVerifierAddress(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return parseNonZeroAddress(
    env.BUSINESS_VERIFIER_ADDRESS,
    "BUSINESS_VERIFIER_ADDRESS",
  );
}

export function parseTokenConfiguration(
  raw = process.env.NOBLEPAY_TOKEN_CONFIG,
): NoblePayTokenConfiguration[] {
  if (!raw)
    throw new ConfigurationError(
      "NOBLEPAY_TOKEN_CONFIG must be a non-empty JSON object",
    );
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new ConfigurationError(
      "NOBLEPAY_TOKEN_CONFIG must contain valid JSON",
    );
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new ConfigurationError(
      "NOBLEPAY_TOKEN_CONFIG must be a non-empty JSON object",
    );
  }
  const entries = Object.entries(decoded as Record<string, unknown>);
  if (entries.length === 0) {
    throw new ConfigurationError(
      "NOBLEPAY_TOKEN_CONFIG must contain at least one token",
    );
  }

  const currencies = new Set<string>();
  return entries.map(([rawAddress, rawValue]) => {
    const address = parseNonZeroAddress(
      rawAddress,
      "NOBLEPAY_TOKEN_CONFIG token address",
    );
    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      throw new ConfigurationError(
        `NOBLEPAY_TOKEN_CONFIG entry ${address} must be an object`,
      );
    }
    const value = rawValue as Record<string, unknown>;
    const currency =
      typeof value.currency === "string"
        ? value.currency.trim().toUpperCase()
        : "";
    const currencyCode =
      typeof value.currencyCode === "string"
        ? value.currencyCode.trim().toUpperCase()
        : currency.slice(0, 3);
    const decimals = value.decimals;
    if (!/^USD[A-Z0-9]{1,7}$/.test(currency)) {
      throw new ConfigurationError(
        `NOBLEPAY_TOKEN_CONFIG entry ${address} must identify a USD stablecoin`,
      );
    }
    if (currencyCode !== "USD") {
      throw new ConfigurationError(
        `NOBLEPAY_TOKEN_CONFIG entry ${address} must use currencyCode USD`,
      );
    }
    if (decimals !== 6) {
      throw new ConfigurationError(
        `NOBLEPAY_TOKEN_CONFIG entry ${address} must use 6 decimals`,
      );
    }
    if (currencies.has(currency)) {
      throw new ConfigurationError(
        `NOBLEPAY_TOKEN_CONFIG contains duplicate currency ${currency}`,
      );
    }
    currencies.add(currency);
    return { address, currency, currencyCode, decimals: decimals as number };
  });
}

export function loadNoblePayChainConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): NoblePayChainConfiguration {
  const rpcUrl = parseHttpUrl(
    env.AETHELRED_RPC_URL,
    "AETHELRED_RPC_URL",
  ).toString();
  let chainId: bigint;
  try {
    chainId = BigInt(env.NOBLEPAY_CHAIN_ID || "");
  } catch {
    throw new ConfigurationError(
      "NOBLEPAY_CHAIN_ID must be a positive integer",
    );
  }
  if (chainId <= 0n)
    throw new ConfigurationError(
      "NOBLEPAY_CHAIN_ID must be a positive integer",
    );
  return {
    rpcUrl,
    chainId,
    networkAnchorBlock: parseNetworkAnchorBlock(
      env.AETHELRED_NETWORK_ANCHOR_BLOCK,
    ),
    networkAnchorHash: parseNetworkAnchorHash(
      env.AETHELRED_NETWORK_ANCHOR_HASH,
    ),
    contractAddress: parseNonZeroAddress(
      env.NOBLEPAY_CONTRACT_ADDRESS,
      "NOBLEPAY_CONTRACT_ADDRESS",
    ),
    registryContractAddress: parseNonZeroAddress(
      env.BUSINESS_REGISTRY_CONTRACT_ADDRESS,
      "BUSINESS_REGISTRY_CONTRACT_ADDRESS",
    ),
    minimumConfirmations: parsePositiveInteger(
      env.NOBLEPAY_MIN_CONFIRMATIONS || "1",
      "NOBLEPAY_MIN_CONFIRMATIONS",
    ),
    tokens: parseTokenConfiguration(env.NOBLEPAY_TOKEN_CONFIG),
  };
}

/** Convert a human decimal string to an exact base-10 smallest-unit integer. */
export function decimalToSmallestUnits(raw: string, decimals: number): string {
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new ConfigurationError(
      "Payment amount is not an unsigned base-10 decimal",
    );
  }
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) {
    throw new ConfigurationError(
      "Payment amount has more precision than the configured token supports",
    );
  }
  const normalizedFraction = fraction.slice(0, decimals).padEnd(decimals, "0");
  const value =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(normalizedFraction || "0");
  if (value <= 0n)
    throw new ConfigurationError("Payment amount must be greater than zero");
  return value.toString(10);
}

export function tokenForCurrency(
  currency: string,
  tokens = parseTokenConfiguration(),
): NoblePayTokenConfiguration {
  const normalized = currency.trim().toUpperCase();
  const token = tokens.find(
    (candidate) =>
      candidate.currency === normalized ||
      candidate.currencyCode === normalized,
  );
  if (!token)
    throw new ConfigurationError(
      `No token decimals are configured for currency ${normalized}`,
    );
  return token;
}

export function configuredSanctionsMaxAgeMs(
  raw = process.env.COMPLIANCE_MAX_DATASET_AGE_HOURS,
): number {
  const hours = parsePositiveInteger(
    raw || "24",
    "COMPLIANCE_MAX_DATASET_AGE_HOURS",
  );
  return hours * 60 * 60 * 1000;
}
