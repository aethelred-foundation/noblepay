#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const compose = read("compose.production.yml");
const nginx = read("deploy/nginx/noblepay.conf");
const frontendDockerfile = read("deploy/docker/frontend.Dockerfile");
const backendDockerfile = read("deploy/docker/backend.Dockerfile");
const gatewayDockerfile = read("deploy/docker/gateway.Dockerfile");
const gatewayConfig = read("services/gateway/internal/config/config.go");
const gatewayIndexer = read("services/gateway/internal/services/indexer.go");
const gatewayServer = read("services/gateway/internal/server/server.go");
const ciWorkflow = read(".github/workflows/ci.yml");
const nodeAuditPolicy = JSON.parse(read("audit-ci.jsonc"));
const deploymentScript = read("scripts/deploy-devnet-core.mjs");
const deploymentGovernance = read("scripts/lib/deployment-governance.mjs");
const nodePackages = [
  JSON.parse(read("package.json")),
  JSON.parse(read("backend/package.json")),
  JSON.parse(read("contracts/package.json")),
];
const nestedNodeLockRoots = [
  JSON.parse(read("package-lock.json")).packages[""],
  JSON.parse(read("backend/package-lock.json")).packages[""],
  JSON.parse(read("contracts/package-lock.json")).packages[""],
];

function readEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) throw new Error(`invalid environment line: ${line}`);
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function validateExternalComplianceOrigin(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("COMPLIANCE_API_URL must be an absolute HTTPS origin");
  }
  assert.equal(parsed.protocol, "https:", "COMPLIANCE_API_URL must use HTTPS");
  assert.equal(
    parsed.username,
    "",
    "COMPLIANCE_API_URL must not contain credentials",
  );
  assert.equal(
    parsed.password,
    "",
    "COMPLIANCE_API_URL must not contain credentials",
  );
  assert.equal(
    parsed.pathname,
    "/",
    "COMPLIANCE_API_URL must be an origin without a path",
  );
  assert.equal(
    parsed.search,
    "",
    "COMPLIANCE_API_URL must not contain a query",
  );
  assert.equal(
    parsed.hash,
    "",
    "COMPLIANCE_API_URL must not contain a fragment",
  );

  const hostname = parsed.hostname.toLowerCase();
  assert.notEqual(hostname, "localhost", "COMPLIANCE_API_URL must be external");
  assert.ok(
    !hostname.endsWith(".localhost"),
    "COMPLIANCE_API_URL must be external",
  );
  if (isIP(hostname)) {
    assert.ok(
      hostname !== "0.0.0.0" &&
        hostname !== "::" &&
        hostname !== "::1" &&
        !hostname.startsWith("127."),
      "COMPLIANCE_API_URL must not use a loopback or unspecified address",
    );
  }
  assert.ok(
    !/[.](?:invalid|test|example)$/u.test(hostname),
    "COMPLIANCE_API_URL must not use a reserved test hostname",
  );
  assert.ok(
    !/(?:mock|placeholder|replace-with)/u.test(hostname),
    "COMPLIANCE_API_URL must not use a mock or placeholder hostname",
  );
}

function validatePublicURL(name, raw, protocol, { originOnly = false } = {}) {
  assert.ok(raw, `${name} is required for production validation`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  assert.equal(
    parsed.protocol,
    protocol,
    `${name} must use ${protocol.slice(0, -1)}`,
  );
  assert.equal(parsed.username, "", `${name} must not contain credentials`);
  assert.equal(parsed.password, "", `${name} must not contain credentials`);
  assert.equal(parsed.search, "", `${name} must not contain a query`);
  assert.equal(parsed.hash, "", `${name} must not contain a fragment`);
  if (originOnly) {
    assert.equal(
      parsed.pathname,
      "/",
      `${name} must be an origin without a path`,
    );
  }
}

const envFileIndex = process.argv.indexOf("--env-file");
const deploymentEnv =
  envFileIndex >= 0 ? readEnvFile(process.argv[envFileIndex + 1]) : process.env;

const complianceAPIURL = deploymentEnv.COMPLIANCE_API_URL;
assert.ok(
  complianceAPIURL,
  "COMPLIANCE_API_URL is required for production validation",
);
validateExternalComplianceOrigin(complianceAPIURL);
assert.match(
  deploymentEnv.COMPLIANCE_MAX_DATASET_AGE_HOURS ?? "",
  /^[1-9][0-9]*$/u,
  "COMPLIANCE_MAX_DATASET_AGE_HOURS must be a positive integer",
);
assert.match(
  deploymentEnv.TRAVEL_RULE_THRESHOLD_USD ?? "",
  /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/u,
  "TRAVEL_RULE_THRESHOLD_USD must be a bounded decimal",
);
assert.ok(
  Number(deploymentEnv.TRAVEL_RULE_THRESHOLD_USD) > 0,
  "TRAVEL_RULE_THRESHOLD_USD must be greater than zero",
);
const travelRuleActiveKeyId = deploymentEnv.TRAVEL_RULE_ACTIVE_KEY_ID ?? "";
assert.match(
  travelRuleActiveKeyId,
  /^[A-Za-z0-9._-]{1,64}$/u,
  "TRAVEL_RULE_ACTIVE_KEY_ID must be a valid key identifier",
);
let travelRuleKeyring;
try {
  travelRuleKeyring = JSON.parse(
    deploymentEnv.TRAVEL_RULE_ENCRYPTION_KEYS ?? "",
  );
} catch {
  throw new Error("TRAVEL_RULE_ENCRYPTION_KEYS must be a JSON object");
}
assert.ok(
  travelRuleKeyring &&
    typeof travelRuleKeyring === "object" &&
    !Array.isArray(travelRuleKeyring),
  "TRAVEL_RULE_ENCRYPTION_KEYS must be a JSON object",
);
const travelRuleKeyEntries = Object.entries(travelRuleKeyring);
assert.ok(
  travelRuleKeyEntries.length >= 1 && travelRuleKeyEntries.length <= 8,
  "TRAVEL_RULE_ENCRYPTION_KEYS must contain 1-8 keys",
);
for (const [keyId, encoded] of travelRuleKeyEntries) {
  assert.match(
    keyId,
    /^[A-Za-z0-9._-]{1,64}$/u,
    "TRAVEL_RULE_ENCRYPTION_KEYS contains an invalid key identifier",
  );
  assert.equal(
    typeof encoded,
    "string",
    "Travel Rule encryption keys must be base64 strings",
  );
  const decoded = Buffer.from(encoded, "base64");
  assert.equal(
    decoded.length,
    32,
    "Travel Rule encryption keys must be 32 bytes",
  );
  assert.equal(
    decoded.toString("base64"),
    encoded,
    "Travel Rule encryption keys must use canonical base64",
  );
}
assert.ok(
  Object.hasOwn(travelRuleKeyring, travelRuleActiveKeyId),
  "TRAVEL_RULE_ACTIVE_KEY_ID must be present in the keyring",
);

const chainId = deploymentEnv.NOBLEPAY_CHAIN_ID ?? "";
assert.match(
  chainId,
  /^[1-9][0-9]*$/u,
  "NOBLEPAY_CHAIN_ID must be a positive integer",
);
assert.ok(
  Number.isSafeInteger(Number(chainId)),
  "NOBLEPAY_CHAIN_ID must be a positive safe integer",
);
if (deploymentEnv.NEXT_PUBLIC_AETHELRED_CHAIN_ID) {
  assert.equal(
    deploymentEnv.NEXT_PUBLIC_AETHELRED_CHAIN_ID,
    chainId,
    "frontend and backend Aethelred chain IDs must match",
  );
}
const networkAnchorBlock = deploymentEnv.AETHELRED_NETWORK_ANCHOR_BLOCK ?? "";
assert.match(
  networkAnchorBlock,
  /^\d+$/u,
  "AETHELRED_NETWORK_ANCHOR_BLOCK must be an unsigned integer",
);
const networkAnchorHash = deploymentEnv.AETHELRED_NETWORK_ANCHOR_HASH ?? "";
assert.match(
  networkAnchorHash,
  /^0x[0-9a-fA-F]{64}$/u,
  "AETHELRED_NETWORK_ANCHOR_HASH must be a 32-byte 0x-prefixed hash",
);
const businessVerifierAddress = deploymentEnv.BUSINESS_VERIFIER_ADDRESS ?? "";
assert.match(
  businessVerifierAddress,
  /^0x[0-9a-fA-F]{40}$/u,
  "BUSINESS_VERIFIER_ADDRESS must be a valid EVM address",
);
assert.notEqual(
  businessVerifierAddress.toLowerCase(),
  "0x0000000000000000000000000000000000000000",
  "BUSINESS_VERIFIER_ADDRESS must not be the zero address",
);
if (deploymentEnv.NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_BLOCK) {
  assert.equal(
    deploymentEnv.NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_BLOCK,
    networkAnchorBlock,
    "frontend and backend network anchor block numbers must match",
  );
}
if (deploymentEnv.NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_HASH) {
  assert.equal(
    deploymentEnv.NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_HASH.toLowerCase(),
    networkAnchorHash.toLowerCase(),
    "frontend and backend network anchor hashes must match",
  );
}
validatePublicURL(
  "PUBLIC_AETHELRED_RPC_URL",
  deploymentEnv.PUBLIC_AETHELRED_RPC_URL,
  "https:",
);
validatePublicURL(
  "PUBLIC_AETHELRED_WS_URL",
  deploymentEnv.PUBLIC_AETHELRED_WS_URL,
  "wss:",
);
validatePublicURL(
  "PUBLIC_AETHELRED_EXPLORER_URL",
  deploymentEnv.PUBLIC_AETHELRED_EXPLORER_URL,
  "https:",
);
validatePublicURL("PUBLIC_ORIGIN", deploymentEnv.PUBLIC_ORIGIN, "https:", {
  originOnly: true,
});

assert.match(
  compose,
  /:3008:3008"/u,
  "Compose must publish the frontend on port 3008",
);
assert.match(
  compose,
  /NEXT_PUBLIC_SITE_URL: \$\{PUBLIC_ORIGIN:\?set PUBLIC_ORIGIN\}/u,
  "Frontend metadata must receive the operator-supplied public origin",
);
assert.match(
  compose,
  /:4008:4008"/u,
  "Compose must publish the backend on port 4008",
);
assert.match(
  compose,
  /BUSINESS_VERIFIER_ADDRESS: \$\{BUSINESS_VERIFIER_ADDRESS:\?set BUSINESS_VERIFIER_ADDRESS\}/u,
  "Backend Compose must require the independently configured BusinessRegistry verifier",
);
assert.match(
  compose,
  /:4018:4018"/u,
  "Compose must publish the optional gateway on port 4018",
);
assert.match(
  compose,
  /NEXT_PUBLIC_AETHELRED_CHAIN_ID: \$\{NOBLEPAY_CHAIN_ID:\?set NOBLEPAY_CHAIN_ID\}/u,
  "Frontend and backend must receive the same operator-confirmed chain ID",
);
for (const anchorVariable of [
  "AETHELRED_NETWORK_ANCHOR_BLOCK",
  "AETHELRED_NETWORK_ANCHOR_HASH",
]) {
  assert.match(
    compose,
    new RegExp(
      `${anchorVariable}: \\$\\{${anchorVariable}:\\?set ${anchorVariable}\\}`,
      "u",
    ),
    `Backend must require ${anchorVariable}`,
  );
  assert.equal(
    (compose.match(new RegExp(`^      ${anchorVariable}:`, "gmu")) ?? [])
      .length,
    2,
    `Backend and optional gateway must both receive ${anchorVariable}`,
  );
  assert.match(
    compose,
    new RegExp(
      `NEXT_PUBLIC_${anchorVariable}: \\$\\{${anchorVariable}:\\?set ${anchorVariable}\\}`,
      "u",
    ),
    `Frontend build must receive the same ${anchorVariable}`,
  );
  assert.match(
    frontendDockerfile,
    new RegExp(`ARG NEXT_PUBLIC_${anchorVariable}`, "u"),
    `Frontend image must declare ${anchorVariable} as an immutable build argument`,
  );
}
for (const gatewayIdentityVariable of [
  "NOBLEPAY_CHAIN_ID",
  "AETHELRED_NETWORK_ANCHOR_BLOCK",
  "AETHELRED_NETWORK_ANCHOR_HASH",
]) {
  assert.ok(
    gatewayConfig.includes(gatewayIdentityVariable),
    `Gateway config must require ${gatewayIdentityVariable}`,
  );
}
assert.match(
  gatewayServer,
  /NewAnchoredConfirmedRPCBlockchainIndexer/u,
  "Production gateway must construct the identity-anchored indexer",
);
assert.match(
  gatewayIndexer,
  /func \(bi \*BlockchainIndexer\) verifyNetworkIdentity/u,
  "Gateway indexer must verify immutable network identity",
);
assert.ok(
  (gatewayIndexer.match(/bi[.]verifyNetworkIdentity\(ctx\)/gu) ?? []).length >=
    3,
  "Gateway indexer must verify network identity at startup, before polls, and before webhook projection",
);
assert.match(
  compose,
  /INDEXER_CONFIRMATIONS: \$\{INDEXER_CONFIRMATIONS:-2\}/u,
  "Gateway confirmations must be operator-tunable with a safe nonzero default",
);
for (const gatewayOnlyVariable of [
  "GATEWAY_API_KEY",
  "WEBHOOK_SECRET",
  "INDEXER_START_BLOCK",
]) {
  assert.match(
    compose,
    new RegExp(
      `${gatewayOnlyVariable}: \\$\\{${gatewayOnlyVariable}:-\\}`,
      "u",
    ),
    `${gatewayOnlyVariable} must not block the base stack when the gateway profile is disabled`,
  );
}
assert.doesNotMatch(
  compose,
  /NEXT_PUBLIC_AETHELRED_RPC_URL: \$\{AETHELRED_RPC_URL/u,
  "The private backend RPC must never be copied into the browser build",
);
assert.doesNotMatch(
  compose,
  /^  compliance:/mu,
  "Compose must not package the test-only Rust service",
);
assert.match(
  compose,
  /COMPLIANCE_API_URL: \$\{COMPLIANCE_API_URL:\?set COMPLIANCE_API_URL\}/u,
  "Production must require an external compliance-service origin",
);
assert.doesNotMatch(
  compose,
  /COMPLIANCE_(?:SERVICE_URL|TEE_URL)/u,
  "Production must use only COMPLIANCE_API_URL",
);
assert.doesNotMatch(
  compose,
  /mock-tee/u,
  "Production Compose must never enable mock TEE",
);
for (const roadmapAdapterVariable of [
  "AI_COMPLIANCE_ENGINE_URL",
  "AI_COMPLIANCE_ENGINE_API_KEY",
  "INVOICE_FINANCING_SERVICE_URL",
  "INVOICE_FINANCING_API_KEY",
  "FX_ORACLE_URL",
  "FX_ORACLE_API_KEY",
  "FX_ORACLE_MAX_AGE_MS",
  "CROSSCHAIN_CHAINS_JSON",
]) {
  assert.doesNotMatch(
    compose,
    new RegExp(`${roadmapAdapterVariable}:`, "u"),
    `Production Compose must not activate roadmap adapter ${roadmapAdapterVariable}`,
  );
}
for (const adapterVariable of [
  "REGULATORY_REPORTING_URL",
  "REGULATORY_REPORTING_API_KEY",
]) {
  assert.match(
    compose,
    new RegExp(`${adapterVariable}: \\$\\{${adapterVariable}:-\\}`, "u"),
    `Compose must forward optional governed adapter ${adapterVariable}`,
  );
}
assert.match(
  nginx,
  /location \/api\/ \{[\s\S]*?proxy_pass http:\/\/noblepay_backend\//u,
  "Nginx must strip the public /api prefix before forwarding to Express /v1 routes",
);
assert.match(
  nginx,
  /location ~ \^\/api\/\(\?:metrics\|health\|healthz\|readyz\)\/\?\$ \{ return 404; \}/u,
  "Nginx must block operational endpoints with and without a trailing slash",
);
assert.match(frontendDockerfile, /EXPOSE 3008/u);
assert.doesNotMatch(
  `${frontendDockerfile}\n${backendDockerfile}`,
  /FROM node:(?:20|22)[.]/u,
  "Production Node images must not use an EOL or superseded runtime line",
);
assert.equal(
  (frontendDockerfile.match(/FROM node:24[.]18[.]0-bookworm-slim/gu) ?? [])
    .length,
  2,
  "Frontend build and runtime stages must use Node 24.18.0",
);
assert.match(
  frontendDockerfile,
  /\.next\/standalone/u,
  "Frontend runtime must use the Next.js standalone output",
);
assert.doesNotMatch(
  frontendDockerfile.split("FROM node:24.18.0-bookworm-slim AS runtime")[1] ??
    "",
  /COPY[^\n]*node_modules/u,
  "Frontend runtime must not copy the build-stage dependency tree",
);
assert.match(
  read("next.config.js"),
  /output: "standalone"/u,
  "Next.js must produce standalone output",
);
assert.match(backendDockerfile, /EXPOSE 4008/u);
assert.equal(
  (backendDockerfile.match(/FROM node:24[.]18[.]0-bookworm-slim/gu) ?? [])
    .length,
  3,
  "Backend build, dependency, and runtime stages must use Node 24.18.0",
);
assert.match(
  backendDockerfile,
  /npm ci --omit=dev --ignore-scripts/u,
  "Backend runtime dependencies must exclude development packages",
);
assert.match(
  compose,
  /migrate:[\s\S]*?target: migration/u,
  "Migration must use the Prisma CLI image target",
);
assert.match(
  compose,
  /image: postgres:16[.]14-alpine3[.]24/u,
  "Production PostgreSQL must use the current supported 16.14 patch image",
);
assert.match(
  compose,
  /image: nginxinc\/nginx-unprivileged:1[.]30[.]4-alpine3[.]24/u,
  "The edge must use the current exact unprivileged Nginx image",
);
assert.match(
  gatewayDockerfile,
  /^FROM golang:1[.]25[.]12-bookworm AS build$/mu,
  "Gateway builds must use patched Go 1.25.12",
);
assert.match(
  gatewayDockerfile,
  /^FROM debian:13[.]6-slim AS runtime$/mu,
  "Gateway runtime must use the current Debian stable patch image",
);
assert.match(gatewayDockerfile, /EXPOSE 4018/u);
assert.match(
  gatewayDockerfile,
  /USER 65532:65532/u,
  "Gateway runtime must remain unprivileged",
);
assert.match(
  compose,
  /private:\n    internal: true/u,
  "Database traffic must remain on an internal Docker network",
);
assert.match(
  compose,
  /condition: service_completed_successfully/u,
  "Backend startup must wait for successful migrations",
);
for (const healthTarget of [
  "http://127.0.0.1:3008/",
  "http://127.0.0.1:4008/readyz",
  "http://127.0.0.1:4018/readyz",
  "http://127.0.0.1:8080/",
]) {
  assert.ok(
    `${compose}\n${frontendDockerfile}\n${backendDockerfile}\n${gatewayDockerfile}`.includes(
      healthTarget,
    ),
    `Production health checks must cover ${healthTarget}`,
  );
}

const nodeVersions = [...ciWorkflow.matchAll(/node-version: "([^"]+)"/gu)].map(
  (match) => match[1],
);
assert.deepEqual(
  nodeVersions,
  ["24.18.0", "24.18.0", "24.18.0"],
  "Every Node CI job must use Node 24.18.0",
);
assert.match(ciWorkflow, /go-version: "1[.]25[.]12"/u);
assert.match(ciWorkflow, /toolchain: 1[.]90[.]0/u);
assert.match(ciWorkflow, /govulncheck@v1[.]6[.]0/u);
assert.match(ciWorkflow, /run: govulncheck [.][/][.][.][.]/u);
assert.match(
  ciWorkflow,
  /run: npx hardhat clean && npx hardhat compile/u,
  "Contract CI must compile from a clean artifact directory",
);
assert.match(
  ciWorkflow,
  /run: node [.][.]\/scripts\/deploy-devnet-core[.]mjs --verify-artifacts/u,
  "Contract CI must validate regenerated deployment artifacts",
);
assert.match(
  nodePackages[0].scripts?.["validate:contracts"] ?? "",
  /npx hardhat clean && npx hardhat compile && node [.][.]\/scripts\/deploy-devnet-core[.]mjs --verify-artifacts && node [.][.]\/scripts\/test-deployment-governance[.]mjs && npx hardhat test/u,
  "Local contract validation must verify artifacts immediately after a clean compile",
);
assert.match(
  deploymentScript,
  /build input \$\{inputSourceName\} differs from the checked-out source/u,
  "Deployment must reject artifacts built from stale source inputs",
);
assert.match(
  deploymentScript,
  /verifyRuntimeBytecode\(name, code, compiled\)/u,
  "Deployment must compare on-chain runtime code with the reviewed artifact",
);
assert.match(
  deploymentScript,
  /mainnet and testnet deployments require an HTTPS RPC_URL/u,
  "Remote network deployments must require an authenticated HTTPS transport",
);
assert.match(
  deploymentScript,
  /const anchorBlock = await client[.]getBlock\(\{\s*blockNumber: NETWORK_ANCHOR_BLOCK/u,
  "Every parameterized deployment RPC identity check must query the operator-confirmed network anchor",
);
assert.match(
  deploymentScript,
  /verifyClientNetworkIdentity\(publicClient, "private RPC"\)/u,
  "Both deployment phases must bind the private RPC to the immutable network anchor",
);
assert.match(
  deploymentScript,
  /verifyClientNetworkIdentity\(frontendPublicClient, "public frontend RPC"\)/u,
  "Final publication must bind the browser-facing RPC to the immutable network anchor",
);
assert.match(
  deploymentScript,
  /NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_HASH=/u,
  "Finalized frontend environment must include the immutable network anchor",
);
assert.match(
  deploymentGovernance,
  /select exactly one deployment phase: --bootstrap or --finalize/u,
  "Contract deployment must require an explicit handoff phase",
);
assert.match(
  deploymentScript,
  /TREASURY_MANAGER_ADDRESS/u,
  "Treasury role management must be separate from the fee beneficiary",
);
assert.match(
  deploymentScript,
  /configureBusinessRegistry/u,
  "PaymentChannels must be bound to the live BusinessRegistry during bootstrap",
);
assert.match(
  deploymentScript,
  /assertCode\(ADMIN, "final governance multisig"\)/u,
  "Remote deployment governance must be a deployed multisig contract",
);
assert.match(
  deploymentScript,
  /core deployment is paused; refusing release publication/u,
  "Final deployment publication must reject paused core contracts",
);
assert.doesNotMatch(
  deploymentScript,
  /(?:batchSetKYCStatus|PAYMENT_CHANNEL_KYC_ADDRESSES)/u,
  "Deployment must not create a mutable payment-channel KYC allowlist",
);
assert.match(
  deploymentScript,
  /transferOwnership/u,
  "Bootstrap must initiate the SealSettlementGate two-step ownership transfer",
);
for (const bootstrapConstructor of [
  /name: "BusinessRegistry",\s*args: \[account[.]address\]/u,
  /name: "SealSettlementGate",\s*args: \[account[.]address\]/u,
  /name: "NoblePay",\s*args: \[account[.]address,/u,
  /name: "PaymentChannels",\s*args: \[account[.]address,/u,
]) {
  assert.match(
    deploymentScript,
    bootstrapConstructor,
    "Every core contract must bootstrap under the temporary deployer",
  );
}
assert.doesNotMatch(
  deploymentScript,
  /name: "(?:BusinessRegistry|SealSettlementGate|NoblePay|PaymentChannels)",\s*args: \[\s*ADMIN/u,
  "Core constructors must not bypass the two-phase handoff",
);
assert.match(
  deploymentScript,
  /renounceRoleIfPresent/u,
  "Finalize must remove temporary deployer roles",
);
assert.match(
  deploymentScript,
  /assertPublicationReady/u,
  "Manifest publication must be guarded by finalized handoff checks",
);
const checkpointVerifier = deploymentScript.slice(
  deploymentScript.indexOf("async function verifyCheckpointRecord("),
  deploymentScript.indexOf("async function verifyCheckpointRecords("),
);
for (const clientBoundCheckpointProof of [
  /client[.]getTransactionReceipt/u,
  /client[.]getTransaction/u,
  /client[.]getBlock/u,
  /assertReviewedRuntime\(client,/u,
]) {
  assert.match(
    checkpointVerifier,
    clientBoundCheckpointProof,
    "Checkpoint receipts, creation transactions, canonical blocks, and reviewed runtime must be proven by the RPC client being attested",
  );
}
const releaseStateVerifier = deploymentScript.slice(
  deploymentScript.indexOf("async function verifyDeploymentState("),
  deploymentScript.indexOf("async function bootstrap("),
);
assert.doesNotMatch(
  releaseStateVerifier,
  /publicClient[.](?:readContract|getContractEvents|getBytecode)/u,
  "Pinned release verification must never escape its parameterized RPC client",
);
assert.match(
  releaseStateVerifier,
  /blockNumber: snapshot[.]number/u,
  "Final contract state and role reads must be pinned to the release block",
);
assert.match(
  deploymentScript,
  /toBlock: blockNumber/u,
  "Enabled-token event history must end at the pinned release block",
);
assert.match(
  deploymentScript,
  /getBytecode\(\{\s*address: TEE_NODE,\s*blockNumber/u,
  "The TEE EOA assertion must support pinned release-block verification",
);
assert.match(
  releaseStateVerifier,
  /assertReleaseBlockOnClient\(client, source, snapshot\)/u,
  "The release hash must be rechecked after all pinned state reads",
);
assert.match(
  deploymentGovernance,
  /release block is no longer canonical; refusing publication/u,
  "A late release-block reorg must fail closed",
);
assert.match(
  deploymentGovernance,
  /publicCheckpointVerified/u,
  "Publication readiness must require browser-facing checkpoint verification",
);
const finalPublication = deploymentScript.slice(
  deploymentScript.indexOf("const releaseBlock = await"),
  deploymentScript.indexOf("DEPLOYMENT_MANIFEST_JSON="),
);
assert.match(
  finalPublication,
  /verifyCheckpointRecords\(\s*frontendPublicClient,\s*"public frontend RPC",\s*DEPLOYMENT_CHECKPOINT,\s*releaseBlock[.]number/u,
  "The browser-facing RPC must prove the complete deployment checkpoint at the release snapshot",
);
assert.match(
  finalPublication,
  /client: frontendPublicClient,\s*source: "public frontend RPC",\s*releaseBlock/u,
  "The browser-facing RPC must prove final roles, configuration, runtime, and token history at the release snapshot",
);
assert.ok(
  finalPublication.indexOf("assertPublicationReady({") <
    finalPublication.indexOf("await verifyReleasePublicationBoundary"),
  "Handoff checks must precede the final private/public release-hash boundary",
);
assert.ok(
  finalPublication.indexOf("await verifyReleasePublicationBoundary") <
    finalPublication.indexOf("const manifest ="),
  "The exact private/public release hashes must be the final asynchronous check before manifest construction",
);
assert.match(
  finalPublication,
  /releaseBlock: \{\s*blockNumber: releaseBlock[.]number[.]toString\(\),\s*blockHash: releaseBlock[.]hash/u,
  "The finalized manifest must archive the exact release snapshot",
);
assert.ok(
  deploymentScript.indexOf("assertPublicationReady({") <
    deploymentScript.indexOf("DEPLOYMENT_MANIFEST_JSON="),
  "Handoff checks must run before deployment manifest publication",
);
assert.match(
  ciWorkflow,
  /run: node [.][.]\/scripts\/test-deployment-governance[.]mjs/u,
  "Contract CI must test governance handoff invariants",
);
for (const requiredValidatorEnv of [
  "TRAVEL_RULE_THRESHOLD_USD",
  "TRAVEL_RULE_ACTIVE_KEY_ID",
  "TRAVEL_RULE_ENCRYPTION_KEYS",
]) {
  assert.match(
    ciWorkflow,
    new RegExp(`^\\s+${requiredValidatorEnv}:`, "mu"),
    `Production configuration CI must provide ${requiredValidatorEnv}`,
  );
}
assert.match(
  nodePackages[0].scripts?.["validate:contracts"] ?? "",
  /node [.][.]\/scripts\/test-deployment-governance[.]mjs/u,
  "Local contract validation must test governance handoff invariants",
);
for (const nodePackage of nodePackages) {
  assert.equal(
    nodePackage.engines?.node,
    ">=24.18.0",
    `${nodePackage.name} must declare the supported Node runtime floor`,
  );
  assert.equal(
    nodePackage.devDependencies?.["audit-ci"],
    "7.1.0",
    `${nodePackage.name} must pin the reviewed audit-ci release`,
  );
}
for (const lockRoot of nestedNodeLockRoots) {
  assert.equal(
    lockRoot.engines?.node,
    ">=24.18.0",
    `${lockRoot.name} lock metadata must match its Node runtime floor`,
  );
}
assert.equal(
  (
    ciWorkflow.match(
      /run: npx --no-install audit-ci --config (?:[.][.]\/)?audit-ci[.]jsonc/gu,
    ) ?? []
  ).length,
  3,
  "Frontend, backend, and contract tooling graphs must use the bounded audit policy",
);
assert.equal(
  (ciWorkflow.match(/run: npm audit --omit=dev --audit-level=moderate/gu) ?? [])
    .length,
  3,
  "Frontend, backend, and contract runtime graphs must be audited separately",
);
assert.equal(
  nodeAuditPolicy.allowlist?.length,
  1,
  "The Node tooling audit policy must contain exactly one advisory exception",
);
assert.deepEqual(
  Object.keys(nodeAuditPolicy.allowlist[0] ?? {}),
  ["GHSA-mh99-v99m-4gvg"],
  "The Node tooling audit policy may exempt only the reviewed brace-expansion advisory",
);
assert.equal(
  nodeAuditPolicy.allowlist[0]?.["GHSA-mh99-v99m-4gvg"]?.expiry,
  "2026-08-01T00:00:00Z",
  "The brace-expansion tooling exception must remain short-lived",
);
assert.match(
  nodeAuditPolicy.allowlist[0]?.["GHSA-mh99-v99m-4gvg"]?.notes ?? "",
  /dev\/test/u,
  "The tooling exception must document that production dependencies remain covered",
);
assert.equal(
  (ciWorkflow.match(/^\s+timeout-minutes: [1-9][0-9]*$/gmu) ?? []).length,
  7,
  "Every CI job must have a finite timeout",
);
assert.equal(
  (ciWorkflow.match(/docker build --pull/gu) ?? []).length,
  3,
  "Every application image build must refresh its exact base-image tag",
);
for (const actionReference of ciWorkflow.matchAll(/^\s*uses:\s+([^\s#]+)/gmu)) {
  assert.match(
    actionReference[1],
    /@[0-9a-f]{40}$/u,
    `GitHub Action ${actionReference[1]} must be pinned to an immutable commit`,
  );
}
for (const rustGate of [
  "cargo fmt --all -- --check",
  "cargo clippy --locked --all-targets --all-features -- -D warnings",
  "cargo test --locked --all-features",
  "cargo test --locked --no-default-features",
  "cargo test --locked --doc --all-features",
  "cargo audit --deny warnings",
]) {
  assert.ok(ciWorkflow.includes(rustGate), `CI must run ${rustGate}`);
}

console.log("production configuration assertions passed");
