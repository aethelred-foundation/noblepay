#!/usr/bin/env node
/**
 * Two-phase NoblePay core deployment and governance handoff for an explicitly
 * chosen Aethelred network.
 *
 * This command deliberately has no localhost, policy, role, token, or fee
 * defaults. Bootstrap deploys/configures under a temporary deployer, grants all
 * final roles, and starts the gate's two-step ownership transfer. Finalize runs
 * only after governance accepts ownership, removes every deployer role, and
 * then (and only then) prints the application manifest and frontend config.
 * Private keys are consumed only by viem and are never logged.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CORE_CONTRACT_KEYS,
  TEE_NODE_ACCOUNT_TYPE,
  ZERO_ADDRESS,
  assertCanonicalReleaseBlock,
  assertCheckpointDeploymentEvidence,
  assertExternallyOwnedAccountCode,
  assertGateOwnershipAccepted,
  assertNetworkAnchorBlock,
  assertPublicationReady,
  deploymentMode,
  normalizeBlockHash,
  validateDeploymentCheckpoint,
  validateGovernanceSeparation,
} from "./lib/deployment-governance.mjs";
import {
  assertNewSecureArtifactPath,
  cliPathOption,
  loadCheckpointArtifact,
  validateFinalizedEnvironment,
  writeSecureJSONFile,
} from "./lib/operator-artifacts.mjs";
import {
  plaintextRpcWarning,
  validatePrivateRpcTransport,
} from "./lib/rpc-transport-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = join(here, "..", "contracts");
const CONTRACTS = join(here, "..", "contracts", "artifacts", "src");
const BUILD_INFO_ROOT = resolve(CONTRACTS_ROOT, "artifacts", "build-info");
const SEAL_PRECOMPILE = "0x0000000000000000000000000000000000000900";
const DEPLOY_GAS = 8_000_000n;
const WRITE_GAS = 3_000_000n;
const STANDARD_DAILY_LIMIT = 50_000n * 1_000_000n;
const STABLECOIN_DECIMALS = 6;
const erc20MetadataAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function addressEnv(name) {
  const value = required(name);
  if (!isAddress(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`${name} must be a nonzero EVM address`);
  }
  return getAddress(value);
}

function uintEnv(name, max = null) {
  const raw = required(name);
  if (!/^[0-9]+$/.test(raw))
    throw new Error(`${name} must be an unsigned integer`);
  const value = BigInt(raw);
  if (max !== null && value > max) throw new Error(`${name} must be <= ${max}`);
  return value;
}

function listEnv(name, { allowEmpty = false } = {}) {
  const raw = required(name);
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowEmpty && values.length === 0)
    throw new Error(`${name} must contain at least one value`);
  return values;
}

function boolEnv(name) {
  const raw = required(name).toLowerCase();
  if (raw !== "true" && raw !== "false")
    throw new Error(`${name} must be true or false`);
  return raw === "true";
}

function publicURL(
  name,
  protocol,
  { allowCredentials = false, originOnly = false } = {},
) {
  const raw = required(name);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (parsed.protocol !== protocol) {
    throw new Error(`${name} must use ${protocol.slice(0, -1)}`);
  }
  if (
    (!allowCredentials && (parsed.username || parsed.password)) ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${name} must not contain credentials, query parameters, or fragments`,
    );
  }
  if (originOnly && parsed.pathname !== "/") {
    throw new Error(`${name} must be an origin without a path`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function publicRpcURL(name, chainEnvironment) {
  const policy = validatePrivateRpcTransport({
    chainEnvironment,
    rpcUrl: required(name),
    insecureTestnetAcknowledgement:
      process.env.ALLOW_INSECURE_TESTNET_RPC ?? "",
  });
  const parsed = new URL(policy.rpcUrl);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      `${name} must not contain credentials, query parameters, or fragments`,
    );
  }
  return {
    ...policy,
    rpcUrl: parsed.toString().replace(/\/$/, ""),
  };
}

function artifact(name, subdir = `${name}.sol`) {
  const artifactPath = join(CONTRACTS, subdir, `${name}.json`);
  const debugPath = join(CONTRACTS, subdir, `${name}.dbg.json`);
  const compiled = JSON.parse(readFileSync(artifactPath, "utf8"));
  const debug = JSON.parse(readFileSync(debugPath, "utf8"));
  const buildInfoPath = resolve(dirname(debugPath), debug.buildInfo ?? "");

  if (
    buildInfoPath !== BUILD_INFO_ROOT &&
    !buildInfoPath.startsWith(`${BUILD_INFO_ROOT}/`)
  ) {
    throw new Error(
      `${name} artifact references build info outside the Hardhat build directory`,
    );
  }

  const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf8"));
  const sourceName = compiled.sourceName;
  const output = buildInfo.output?.contracts?.[sourceName]?.[name];
  if (
    compiled.contractName !== name ||
    typeof sourceName !== "string" ||
    !output
  ) {
    throw new Error(
      `${name} artifact identity does not match its Hardhat build info`,
    );
  }

  const expectedBytecode = `0x${output.evm?.bytecode?.object ?? ""}`;
  if (compiled.bytecode !== expectedBytecode) {
    throw new Error(
      `${name} artifact bytecode does not match its Hardhat build info`,
    );
  }
  const expectedRuntimeBytecode = `0x${output.evm?.deployedBytecode?.object ?? ""}`;
  if (compiled.deployedBytecode !== expectedRuntimeBytecode) {
    throw new Error(
      `${name} runtime bytecode does not match its Hardhat build info`,
    );
  }
  if (JSON.stringify(compiled.abi) !== JSON.stringify(output.abi)) {
    throw new Error(
      `${name} artifact ABI does not match its Hardhat build info`,
    );
  }

  const settings = buildInfo.input?.settings;
  if (
    buildInfo.solcVersion !== "0.8.19" ||
    settings?.optimizer?.enabled !== true ||
    settings?.optimizer?.runs !== 200 ||
    settings?.viaIR !== true
  ) {
    throw new Error(
      `${name} artifact was not built with the reviewed compiler settings`,
    );
  }

  for (const [inputSourceName, inputSource] of Object.entries(
    buildInfo.input?.sources ?? {},
  )) {
    const localPath = inputSourceName.startsWith("@")
      ? join(CONTRACTS_ROOT, "node_modules", inputSourceName)
      : join(CONTRACTS_ROOT, inputSourceName);
    if (readFileSync(localPath, "utf8") !== inputSource.content) {
      throw new Error(
        `${name} build input ${inputSourceName} differs from the checked-out source`,
      );
    }
  }

  return {
    ...compiled,
    __runtimeReferences: {
      immutables: output.evm?.deployedBytecode?.immutableReferences ?? {},
      libraries: output.evm?.deployedBytecode?.linkReferences ?? {},
    },
  };
}

const CORE_ARTIFACTS = [
  ["BusinessRegistry"],
  ["SealSettlementGate"],
  ["NoblePay"],
  ["PaymentChannels"],
];

if (process.argv.includes("--verify-artifacts")) {
  for (const [name, subdir] of CORE_ARTIFACTS) artifact(name, subdir);
  console.log(
    "Verified NoblePay deployment artifacts against source and build info.",
  );
  process.exit(0);
}

const {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  getAddress,
  http,
  isAddress,
  keccak256,
  stringToHex,
} = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");

const DEPLOYMENT_MODE = deploymentMode(process.argv);
const VALIDATE_ONLY = process.argv.includes("--validate-only");
const CHECKPOINT_FILE = cliPathOption(process.argv, "--checkpoint-file");
const MANIFEST_FILE = cliPathOption(process.argv, "--manifest-file");

function validateCommandArguments(argv) {
  const valueOptions = new Set(["--checkpoint-file", "--manifest-file"]);
  const flagOptions = new Set(["--bootstrap", "--finalize", "--validate-only"]);
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    const optionName = argument.split("=", 1)[0];
    if (valueOptions.has(optionName)) {
      if (argument === optionName) index += 1;
      continue;
    }
    if (!flagOptions.has(argument)) {
      throw new Error(`unsupported deployment argument: ${argument}`);
    }
  }
}

validateCommandArguments(process.argv);

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function referenceRanges(value, ranges = []) {
  if (Array.isArray(value)) {
    for (const item of value) referenceRanges(item, ranges);
  } else if (value && typeof value === "object") {
    if (
      Number.isSafeInteger(value.start) &&
      Number.isSafeInteger(value.length)
    ) {
      ranges.push({ start: value.start, length: value.length });
    } else {
      for (const item of Object.values(value)) referenceRanges(item, ranges);
    }
  }
  return ranges;
}

function maskRuntimeReferences(bytecode, references) {
  if (!/^0x(?:[a-fA-F0-9]{2})*$/u.test(bytecode)) {
    throw new Error("compiled or deployed runtime bytecode is not valid hex");
  }
  const bytes = Buffer.from(bytecode.slice(2), "hex");
  for (const { start, length } of referenceRanges(references)) {
    if (start < 0 || length < 0 || start + length > bytes.length) {
      throw new Error(
        "runtime bytecode reference is outside the compiled code",
      );
    }
    bytes.fill(0, start, start + length);
  }
  return bytes.toString("hex");
}

function verifyRuntimeBytecode(name, actual, compiled) {
  const expectedMasked = maskRuntimeReferences(
    compiled.deployedBytecode,
    compiled.__runtimeReferences,
  );
  const actualMasked = maskRuntimeReferences(
    actual,
    compiled.__runtimeReferences,
  );
  if (actualMasked !== expectedMasked) {
    throw new Error(
      `${name} deployed runtime bytecode does not match the reviewed artifact`,
    );
  }
}

const CHAIN_ENV = required("CHAIN_ENV");
if (!["mainnet", "testnet", "devnet"].includes(CHAIN_ENV)) {
  throw new Error("CHAIN_ENV must be mainnet, testnet, or devnet");
}
const rpcPolicy = validatePrivateRpcTransport({
  chainEnvironment: CHAIN_ENV,
  rpcUrl: required("RPC_URL"),
  insecureTestnetAcknowledgement: process.env.ALLOW_INSECURE_TESTNET_RPC ?? "",
});
const RPC_URL = rpcPolicy.rpcUrl;
if (CHAIN_ENV !== "devnet" && !CHECKPOINT_FILE) {
  throw new Error(
    "testnet and mainnet ceremonies require --checkpoint-file with an absolute path",
  );
}
if (
  CHAIN_ENV !== "devnet" &&
  DEPLOYMENT_MODE === "finalize" &&
  !MANIFEST_FILE
) {
  throw new Error(
    "testnet and mainnet finalization requires --manifest-file with a new absolute archive path",
  );
}
if (DEPLOYMENT_MODE === "bootstrap" && MANIFEST_FILE) {
  throw new Error("--manifest-file is accepted only with --finalize");
}
const frontendRpcPolicy =
  DEPLOYMENT_MODE === "finalize"
    ? publicRpcURL("PUBLIC_AETHELRED_RPC_URL", CHAIN_ENV)
    : null;
const FRONTEND_RPC_URL = frontendRpcPolicy?.rpcUrl ?? null;
if (
  rpcPolicy.transportSecurity === "plaintext-evaluation" ||
  frontendRpcPolicy?.transportSecurity === "plaintext-evaluation"
) {
  console.warn(plaintextRpcWarning());
}
const FRONTEND_CHAIN_WS_URL =
  DEPLOYMENT_MODE === "finalize"
    ? publicURL("PUBLIC_AETHELRED_WS_URL", "wss:")
    : null;
const FRONTEND_EXPLORER_URL =
  DEPLOYMENT_MODE === "finalize"
    ? publicURL("PUBLIC_AETHELRED_EXPLORER_URL", "https:")
    : null;
const CHAIN_ID = Number(uintEnv("AETHELRED_CHAIN_ID", 0x7fffffff));
const NETWORK_ANCHOR_BLOCK = uintEnv("AETHELRED_NETWORK_ANCHOR_BLOCK");
const NETWORK_ANCHOR_HASH = normalizeBlockHash(
  required("AETHELRED_NETWORK_ANCHOR_HASH"),
  "AETHELRED_NETWORK_ANCHOR_HASH",
);
const DEPLOYER_KEY = required("DEPLOYER_KEY");
const EXPECTED_DEPLOYER = addressEnv("DEPLOYER_ADDRESS");
const ADMIN = addressEnv("ADMIN_ADDRESS");
const TREASURY = addressEnv("TREASURY_ADDRESS");
const TREASURY_MANAGER = addressEnv("TREASURY_MANAGER_ADDRESS");
const TEE_NODE = addressEnv("TEE_NODE_ADDRESS");
const COMPLIANCE_OFFICER = addressEnv("COMPLIANCE_OFFICER_ADDRESS");
const BUSINESS_VERIFIER = addressEnv("BUSINESS_VERIFIER_ADDRESS");
const BASE_FEE = uintEnv("NOBLEPAY_BASE_FEE");
const PERCENTAGE_FEE = uintEnv("NOBLEPAY_PERCENTAGE_FEE", 500n);
const PAYMENT_CHANNEL_FEE_BPS = uintEnv("PAYMENT_CHANNEL_FEE_BPS", 500n);
const TOKENS = listEnv("SUPPORTED_TOKEN_ADDRESSES").map((value) => {
  if (!isAddress(value) || /^0x0{40}$/i.test(value))
    throw new Error(`invalid supported token: ${value}`);
  return getAddress(value);
});
const NAMED_TOKENS = {
  USDC: addressEnv("USDC_TOKEN_ADDRESS"),
  USDT: addressEnv("USDT_TOKEN_ADDRESS"),
};
const ALLOWED_BACKENDS = listEnv("CEAP_ALLOWED_BACKENDS");
const MIN_VERIFICATION = required("CEAP_MIN_VERIFICATION");
const ALLOWED_PLATFORMS = listEnv("CEAP_ALLOWED_PLATFORMS");
const REQUIRE_VENDOR_ROOT = boolEnv("CEAP_REQUIRE_VENDOR_ROOT");
const DATA_RESIDENCY = listEnv("CEAP_DATA_RESIDENCY");
const SEAL_PROBE_ID = required("SEAL_PROBE_ID");
const FRONTEND_API_URL =
  DEPLOYMENT_MODE === "finalize"
    ? publicURL("FRONTEND_API_URL", "https:")
    : null;
const FRONTEND_WS_URL =
  DEPLOYMENT_MODE === "finalize" ? publicURL("FRONTEND_WS_URL", "wss:") : null;
const FRONTEND_SITE_URL =
  DEPLOYMENT_MODE === "finalize"
    ? publicURL("FRONTEND_SITE_URL", "https:", { originOnly: true })
    : null;
const WALLETCONNECT_PROJECT_ID =
  DEPLOYMENT_MODE === "finalize" ? required("WALLETCONNECT_PROJECT_ID") : null;
if (
  WALLETCONNECT_PROJECT_ID !== null &&
  !/^[0-9a-fA-F]{32}$/u.test(WALLETCONNECT_PROJECT_ID)
) {
  throw new Error(
    "WALLETCONNECT_PROJECT_ID must be a 32-character hexadecimal project id",
  );
}
const FRONTEND_APP_VERSION =
  DEPLOYMENT_MODE === "finalize" ? required("FRONTEND_APP_VERSION") : null;
if (
  FRONTEND_APP_VERSION !== null &&
  !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(FRONTEND_APP_VERSION)
) {
  throw new Error("FRONTEND_APP_VERSION has an invalid release identifier");
}
const FRONTEND_SENTRY_DSN =
  DEPLOYMENT_MODE === "finalize" && process.env.FRONTEND_SENTRY_DSN?.trim()
    ? publicURL("FRONTEND_SENTRY_DSN", "https:", { allowCredentials: true })
    : "";
if (
  new Set(TOKENS.map((token) => token.toLowerCase())).size !== TOKENS.length
) {
  throw new Error("SUPPORTED_TOKEN_ADDRESSES contains duplicates");
}
if (sameAddress(NAMED_TOKENS.USDC, NAMED_TOKENS.USDT)) {
  throw new Error(
    "USDC_TOKEN_ADDRESS and USDT_TOKEN_ADDRESS must be different contracts",
  );
}
for (const [symbol, token] of Object.entries({
  USDC: NAMED_TOKENS.USDC,
  USDT: NAMED_TOKENS.USDT,
})) {
  if (!TOKENS.some((supported) => sameAddress(supported, token))) {
    throw new Error(
      `${symbol}_TOKEN_ADDRESS must be present in SUPPORTED_TOKEN_ADDRESSES`,
    );
  }
}
if (TOKENS.length !== 2) {
  throw new Error(
    "SUPPORTED_TOKEN_ADDRESSES must contain only the USDC and USDT 6-decimal stablecoins; native/wrapped AETHEL is outside the NoblePay core release scope",
  );
}
if (BASE_FEE >= STANDARD_DAILY_LIMIT) {
  throw new Error(
    `NOBLEPAY_BASE_FEE must be less than the standard daily limit (${STANDARD_DAILY_LIMIT})`,
  );
}
const account = privateKeyToAccount(DEPLOYER_KEY);
if (!sameAddress(account.address, EXPECTED_DEPLOYER)) {
  throw new Error("DEPLOYER_KEY does not match DEPLOYER_ADDRESS");
}
validateGovernanceSeparation({
  deployer: account.address,
  governance: ADMIN,
  treasuryManager: TREASURY_MANAGER,
  treasuryBeneficiary: TREASURY,
  businessVerifier: BUSINESS_VERIFIER,
  teeNode: TEE_NODE,
  complianceOfficer: COMPLIANCE_OFFICER,
});

const CONFIGURATION_DIGEST = keccak256(
  stringToHex(
    JSON.stringify({
      admin: ADMIN,
      treasuryBeneficiary: TREASURY,
      treasuryManager: TREASURY_MANAGER,
      teeNode: TEE_NODE,
      teeNodeAccountType: TEE_NODE_ACCOUNT_TYPE,
      complianceOfficer: COMPLIANCE_OFFICER,
      businessVerifier: BUSINESS_VERIFIER,
      baseFee: BASE_FEE.toString(),
      percentageFee: PERCENTAGE_FEE.toString(),
      paymentChannelFeeBps: PAYMENT_CHANNEL_FEE_BPS.toString(),
      supportedTokens: TOKENS,
      namedTokens: NAMED_TOKENS,
      ceap: {
        allowedBackends: ALLOWED_BACKENDS,
        minVerification: MIN_VERIFICATION,
        allowedPlatforms: ALLOWED_PLATFORMS,
        requireVendorRoot: REQUIRE_VENDOR_ROOT,
        dataResidency: DATA_RESIDENCY,
      },
      sealProbeId: SEAL_PROBE_ID,
    }),
  ),
);

const CHECKPOINT_METADATA = {
  chainId: CHAIN_ID,
  chainEnvironment: CHAIN_ENV,
  networkAnchorBlock: NETWORK_ANCHOR_BLOCK.toString(),
  networkAnchorHash: NETWORK_ANCHOR_HASH,
  configurationDigest: CONFIGURATION_DIGEST,
  deployer: account.address,
  teeNodeAccountType: TEE_NODE_ACCOUNT_TYPE,
};

function emptyDeploymentCheckpoint() {
  return {
    version: 1,
    ...CHECKPOINT_METADATA,
    contracts: Object.fromEntries(CORE_CONTRACT_KEYS.map((key) => [key, null])),
  };
}

function deploymentCheckpointEnv() {
  const parsed = loadCheckpointArtifact({
    checkpointFile: CHECKPOINT_FILE,
    environmentValue: process.env.BOOTSTRAP_CHECKPOINT_JSON,
  });
  if (!parsed) {
    if (DEPLOYMENT_MODE === "finalize") {
      throw new Error(
        "a complete checkpoint file or BOOTSTRAP_CHECKPOINT_JSON is required for --finalize",
      );
    }
    return emptyDeploymentCheckpoint();
  }
  return validateDeploymentCheckpoint(parsed, {
    ...CHECKPOINT_METADATA,
    requireComplete: DEPLOYMENT_MODE === "finalize",
  });
}

const DEPLOYMENT_CHECKPOINT = deploymentCheckpointEnv();
if (MANIFEST_FILE) {
  assertNewSecureArtifactPath(MANIFEST_FILE, "finalized manifest file");
}
if (VALIDATE_ONLY) {
  console.log(
    `Validated ${DEPLOYMENT_MODE} inputs without connecting to an RPC or broadcasting a transaction.`,
  );
  process.exit(0);
}

const chain = defineChain({
  id: CHAIN_ID,
  name: `aethelred-${CHAIN_ENV}`,
  nativeCurrency: { name: "AETHEL", symbol: "AETHEL", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { timeout: 15_000 }),
});
const walletClient = createWalletClient({
  chain,
  account,
  transport: http(RPC_URL, { timeout: 15_000 }),
});
const frontendPublicClient = FRONTEND_RPC_URL
  ? createPublicClient({
      chain,
      transport: http(FRONTEND_RPC_URL, { timeout: 15_000 }),
    })
  : null;

async function receipt(hash, label) {
  const result = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 90_000,
  });
  if (result.status !== "success")
    throw new Error(`${label} reverted: ${hash}`);
  await verifyPrivateNetworkIdentity();
  return result;
}

async function deploy(name, args) {
  const compiled = artifact(name);
  const { abi, bytecode } = compiled;
  if (!bytecode || bytecode === "0x")
    throw new Error(`${name} artifact has no deploy bytecode`);
  await verifyPrivateNetworkIdentity();
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args,
    gas: DEPLOY_GAS,
  });
  const result = await receipt(hash, `${name} deployment`);
  if (!result.contractAddress)
    throw new Error(`${name} receipt has no contract address`);
  const code = await publicClient.getBytecode({
    address: result.contractAddress,
  });
  if (!code || code === "0x")
    throw new Error(`${name} has no runtime code after deployment`);
  verifyRuntimeBytecode(name, code, compiled);
  console.log(`${name}: ${result.contractAddress} (${hash})`);
  if (!result.blockHash) {
    throw new Error(`${name} deployment receipt has no block hash`);
  }
  return {
    address: getAddress(result.contractAddress),
    transactionHash: hash.toLowerCase(),
    blockNumber: result.blockNumber.toString(),
    blockHash: normalizeBlockHash(
      result.blockHash,
      `${name} deployment block hash`,
    ),
  };
}

async function write(address, abi, functionName, args = []) {
  await publicClient.simulateContract({
    address,
    abi,
    functionName,
    args,
    account,
  });
  await verifyPrivateNetworkIdentity();
  const hash = await walletClient.writeContract({
    address,
    abi,
    functionName,
    args,
    gas: WRITE_GAS,
  });
  await receipt(hash, functionName);
  return hash;
}

async function assertCode(address, label) {
  const code = await publicClient.getBytecode({ address });
  if (!code || code === "0x")
    throw new Error(`${label} ${address} has no runtime code`);
}

const DEFAULT_ADMIN_ROLE = `0x${"00".repeat(32)}`;

async function assertReviewedRuntime(
  client,
  address,
  name,
  blockNumber = undefined,
) {
  const compiled = artifact(name);
  const code = await client.getBytecode({ address, blockNumber });
  if (!code || code === "0x") {
    throw new Error(`${name} ${address} has no runtime code`);
  }
  verifyRuntimeBytecode(name, code, compiled);
}

function coreDeploymentSpecs() {
  return {
    registry: {
      name: "BusinessRegistry",
      args: [account.address],
    },
    gate: {
      name: "SealSettlementGate",
      args: [account.address],
    },
    noblePay: {
      name: "NoblePay",
      args: [account.address, TREASURY, BASE_FEE, PERCENTAGE_FEE],
    },
    paymentChannels: {
      name: "PaymentChannels",
      args: [account.address, TREASURY, PAYMENT_CHANNEL_FEE_BPS],
    },
  };
}

function checkpointContracts(checkpoint) {
  return Object.fromEntries(
    CORE_CONTRACT_KEYS.map((key) => {
      const record = checkpoint.contracts[key];
      if (!record) {
        throw new Error(
          `BOOTSTRAP_CHECKPOINT_JSON is missing the ${key} deployment`,
        );
      }
      return [key, getAddress(record.address)];
    }),
  );
}

function printDeploymentCheckpoint(checkpoint) {
  console.log(`\nBOOTSTRAP_CHECKPOINT_JSON=${JSON.stringify(checkpoint)}`);
  console.log(
    CHECKPOINT_FILE
      ? `Checkpoint persisted atomically to ${CHECKPOINT_FILE}.`
      : "Persist this complete line in the secure deployment environment before continuing.",
  );
}

function persistDeploymentCheckpoint(checkpoint) {
  if (!CHECKPOINT_FILE) return;
  writeSecureJSONFile(CHECKPOINT_FILE, checkpoint, "checkpoint file");
}

async function verifyCheckpointRecord(
  client,
  source,
  key,
  record,
  spec,
  runtimeBlockNumber = undefined,
) {
  const address = getAddress(record.address);
  const transactionHash = record.transactionHash.toLowerCase();
  const expectedBlockNumber = BigInt(record.blockNumber);
  const compiled = artifact(spec.name);
  const expectedInput = encodeDeployData({
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args: spec.args,
  });
  const [deploymentReceipt, deploymentTransaction, canonicalBlock] =
    await Promise.all([
      client.getTransactionReceipt({ hash: transactionHash }),
      client.getTransaction({ hash: transactionHash }),
      client.getBlock({ blockNumber: expectedBlockNumber }),
    ]);
  assertCheckpointDeploymentEvidence({
    key,
    record,
    expectedAddress: address,
    expectedDeployer: account.address,
    expectedInput,
    receipt: deploymentReceipt,
    transaction: deploymentTransaction,
    canonicalBlock,
    source,
  });
  await assertReviewedRuntime(client, address, spec.name, runtimeBlockNumber);
}

async function verifyCheckpointRecords(
  client,
  source,
  checkpoint,
  runtimeBlockNumber = undefined,
) {
  await assertTeeNodeAccountType(
    client,
    `${source} checkpoint TEE_NODE_ADDRESS`,
    runtimeBlockNumber,
  );
  const specs = coreDeploymentSpecs();
  for (const key of CORE_CONTRACT_KEYS) {
    const record = checkpoint.contracts[key];
    if (!record) break;
    await verifyCheckpointRecord(
      client,
      source,
      key,
      record,
      specs[key],
      runtimeBlockNumber,
    );
  }
}

async function verifyNetwork({ requireDeployerBalance }) {
  await verifyPrivateNetworkIdentity();
  if (frontendPublicClient) {
    const frontendChainId = await frontendPublicClient.getChainId();
    if (frontendChainId !== CHAIN_ID) {
      throw new Error(
        `public frontend RPC chain id ${frontendChainId} != ${CHAIN_ID}`,
      );
    }
    const frontendAnchorBlock = await frontendPublicClient.getBlock({
      blockNumber: NETWORK_ANCHOR_BLOCK,
    });
    assertNetworkAnchorBlock({
      expectedBlockNumber: NETWORK_ANCHOR_BLOCK,
      expectedBlockHash: NETWORK_ANCHOR_HASH,
      block: frontendAnchorBlock,
    });
    await assertTeeNodeAccountType(
      frontendPublicClient,
      "public-RPC TEE_NODE_ADDRESS",
    );
  }
  if (
    requireDeployerBalance &&
    (await publicClient.getBalance({ address: account.address })) === 0n
  ) {
    throw new Error("deployer has no native balance");
  }
}

async function verifyPrivateNetworkIdentity() {
  await verifyClientNetworkIdentity(publicClient, "private RPC");
}

async function verifyClientNetworkIdentity(
  client,
  source,
  teeBlockNumber = undefined,
) {
  const actualChainId = await client.getChainId();
  if (actualChainId !== CHAIN_ID)
    throw new Error(`${source} chain id ${actualChainId} != ${CHAIN_ID}`);
  const anchorBlock = await client.getBlock({
    blockNumber: NETWORK_ANCHOR_BLOCK,
  });
  assertNetworkAnchorBlock({
    expectedBlockNumber: NETWORK_ANCHOR_BLOCK,
    expectedBlockHash: NETWORK_ANCHOR_HASH,
    block: anchorBlock,
  });
  await assertTeeNodeAccountType(
    client,
    `${source} TEE_NODE_ADDRESS`,
    teeBlockNumber,
  );
}

async function assertTeeNodeAccountType(
  client,
  label,
  blockNumber = undefined,
) {
  const code = await client.getBytecode({
    address: TEE_NODE,
    blockNumber,
  });
  assertExternallyOwnedAccountCode(code, label);
}

async function captureCanonicalReleaseBlock(
  client = publicClient,
  source = "private RPC",
) {
  const block = await client.getBlock({ blockTag: "latest" });
  if (block.number === null || block.number === undefined || !block.hash) {
    throw new Error(`${source} latest block cannot be pinned for release`);
  }
  return {
    number: block.number,
    hash: normalizeBlockHash(block.hash, "release block hash"),
  };
}

async function assertReleaseBlockOnClient(client, source, releaseBlock) {
  const block = await client.getBlock({ blockNumber: releaseBlock.number });
  assertCanonicalReleaseBlock({
    expectedBlockNumber: releaseBlock.number,
    expectedBlockHash: releaseBlock.hash,
    block,
    source,
  });
}

async function verifyReleasePublicationBoundary(releaseBlock) {
  if (!frontendPublicClient) {
    throw new Error("public frontend RPC is required for release publication");
  }
  await Promise.all([
    verifyClientNetworkIdentity(publicClient, "private RPC"),
    verifyClientNetworkIdentity(frontendPublicClient, "public frontend RPC"),
  ]);
  // These exact-hash reads are deliberately the final asynchronous operation
  // before the manifest is constructed and printed.
  await Promise.all([
    assertReleaseBlockOnClient(publicClient, "private RPC", releaseBlock),
    assertReleaseBlockOnClient(
      frontendPublicClient,
      "public frontend RPC",
      releaseBlock,
    ),
  ]);
}

async function verifyExternalDependencies() {
  if (CHAIN_ENV !== "devnet") {
    await assertCode(ADMIN, "final governance multisig");
  }
  for (const token of TOKENS) {
    await assertCode(token, "supported token");
    const decimals = await publicClient.readContract({
      address: token,
      abi: erc20MetadataAbi,
      functionName: "decimals",
    });
    if (decimals !== STABLECOIN_DECIMALS) {
      throw new Error(
        `supported token ${token} has ${decimals} decimals; NoblePay requires exactly ${STABLECOIN_DECIMALS}`,
      );
    }
  }
  // A successful ABI decode proves that the chain exposes the ISeal precompile.
  // The probe need not be active; false is a valid result for a known test id.
  const sealAbi = artifact("ISeal", "interfaces/ISeal.sol").abi;
  await publicClient.readContract({
    address: SEAL_PRECOMPILE,
    abi: sealAbi,
    functionName: "verifySeal",
    args: [SEAL_PROBE_ID],
  });
}

async function readRoleIds(
  client,
  { registry, noblePay, paymentChannels },
  abis,
  blockNumber = undefined,
) {
  const [
    registryAdmin,
    verifier,
    noblePayAdmin,
    treasuryManager,
    tee,
    officer,
    channelsAdmin,
    channelsTreasuryManager,
  ] = await Promise.all([
    client.readContract({
      address: registry,
      abi: abis.registry,
      functionName: "ADMIN_ROLE",
      blockNumber,
    }),
    client.readContract({
      address: registry,
      abi: abis.registry,
      functionName: "VERIFIER_ROLE",
      blockNumber,
    }),
    client.readContract({
      address: noblePay,
      abi: abis.noblePay,
      functionName: "ADMIN_ROLE",
      blockNumber,
    }),
    client.readContract({
      address: noblePay,
      abi: abis.noblePay,
      functionName: "TREASURY_ROLE",
      blockNumber,
    }),
    client.readContract({
      address: noblePay,
      abi: abis.noblePay,
      functionName: "TEE_NODE_ROLE",
      blockNumber,
    }),
    client.readContract({
      address: noblePay,
      abi: abis.noblePay,
      functionName: "COMPLIANCE_OFFICER_ROLE",
      blockNumber,
    }),
    client.readContract({
      address: paymentChannels,
      abi: abis.paymentChannels,
      functionName: "ADMIN_ROLE",
      blockNumber,
    }),
    client.readContract({
      address: paymentChannels,
      abi: abis.paymentChannels,
      functionName: "TREASURY_ROLE",
      blockNumber,
    }),
  ]);
  return {
    registryAdmin,
    verifier,
    noblePayAdmin,
    treasuryManager,
    tee,
    officer,
    channelsAdmin,
    channelsTreasuryManager,
  };
}

function finalRoleAssignments(contracts, abis, roles) {
  return [
    {
      address: contracts.registry,
      abi: abis.registry,
      role: DEFAULT_ADMIN_ROLE,
      account: ADMIN,
      label: "BusinessRegistry DEFAULT_ADMIN_ROLE",
    },
    {
      address: contracts.registry,
      abi: abis.registry,
      role: roles.registryAdmin,
      account: ADMIN,
      label: "BusinessRegistry ADMIN_ROLE",
    },
    {
      address: contracts.registry,
      abi: abis.registry,
      role: roles.verifier,
      account: BUSINESS_VERIFIER,
      label: "BusinessRegistry VERIFIER_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: DEFAULT_ADMIN_ROLE,
      account: ADMIN,
      label: "NoblePay DEFAULT_ADMIN_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: roles.noblePayAdmin,
      account: ADMIN,
      label: "NoblePay ADMIN_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: roles.treasuryManager,
      account: TREASURY_MANAGER,
      label: "NoblePay TREASURY_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: roles.tee,
      account: TEE_NODE,
      label: "NoblePay TEE_NODE_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: roles.officer,
      account: COMPLIANCE_OFFICER,
      label: "NoblePay COMPLIANCE_OFFICER_ROLE",
    },
    {
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      role: DEFAULT_ADMIN_ROLE,
      account: ADMIN,
      label: "PaymentChannels DEFAULT_ADMIN_ROLE",
    },
    {
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      role: roles.channelsAdmin,
      account: ADMIN,
      label: "PaymentChannels ADMIN_ROLE",
    },
    {
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      role: roles.channelsTreasuryManager,
      account: TREASURY_MANAGER,
      label: "PaymentChannels TREASURY_ROLE",
    },
  ];
}

function expectedRoleMembership(contracts, abis, roles, mode) {
  const optionallyWithDeployer = (accounts, constructorGranted) => {
    if (mode === "bootstrap" && constructorGranted) {
      return [...accounts, account.address];
    }
    if (mode === "finalize-pending" && constructorGranted) {
      return [...accounts, account.address];
    }
    return accounts;
  };
  return [
    {
      address: contracts.registry,
      abi: abis.registry,
      role: DEFAULT_ADMIN_ROLE,
      accounts: optionallyWithDeployer([ADMIN], true),
      allowMissingDeployer: mode === "finalize-pending",
      label: "BusinessRegistry DEFAULT_ADMIN_ROLE",
    },
    {
      address: contracts.registry,
      abi: abis.registry,
      role: roles.registryAdmin,
      accounts: optionallyWithDeployer([ADMIN], true),
      allowMissingDeployer: mode === "finalize-pending",
      label: "BusinessRegistry ADMIN_ROLE",
    },
    {
      address: contracts.registry,
      abi: abis.registry,
      role: roles.verifier,
      accounts: optionallyWithDeployer([BUSINESS_VERIFIER], true),
      allowMissingDeployer: mode === "finalize-pending",
      label: "BusinessRegistry VERIFIER_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: DEFAULT_ADMIN_ROLE,
      accounts: optionallyWithDeployer([ADMIN], true),
      allowMissingDeployer: mode === "finalize-pending",
      label: "NoblePay DEFAULT_ADMIN_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: roles.noblePayAdmin,
      accounts: optionallyWithDeployer([ADMIN], true),
      allowMissingDeployer: mode === "finalize-pending",
      label: "NoblePay ADMIN_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: roles.treasuryManager,
      accounts: optionallyWithDeployer([TREASURY_MANAGER], true),
      allowMissingDeployer: mode === "finalize-pending",
      label: "NoblePay TREASURY_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: roles.tee,
      accounts: [TEE_NODE],
      label: "NoblePay TEE_NODE_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: roles.officer,
      accounts: [COMPLIANCE_OFFICER],
      label: "NoblePay COMPLIANCE_OFFICER_ROLE",
    },
    {
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      role: DEFAULT_ADMIN_ROLE,
      accounts: optionallyWithDeployer([ADMIN], true),
      allowMissingDeployer: mode === "finalize-pending",
      label: "PaymentChannels DEFAULT_ADMIN_ROLE",
    },
    {
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      role: roles.channelsAdmin,
      accounts: optionallyWithDeployer([ADMIN], true),
      allowMissingDeployer: mode === "finalize-pending",
      label: "PaymentChannels ADMIN_ROLE",
    },
    {
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      role: roles.channelsTreasuryManager,
      accounts: optionallyWithDeployer([TREASURY_MANAGER], true),
      allowMissingDeployer: mode === "finalize-pending",
      label: "PaymentChannels TREASURY_ROLE",
    },
  ];
}

async function assertExactRoleMembers(client, assignment, blockNumber) {
  const count = await client.readContract({
    address: assignment.address,
    abi: assignment.abi,
    functionName: "getRoleMemberCount",
    args: [assignment.role],
    blockNumber,
  });
  const actual = [];
  for (let index = 0n; index < count; index += 1n) {
    actual.push(
      await client.readContract({
        address: assignment.address,
        abi: assignment.abi,
        functionName: "getRoleMember",
        args: [assignment.role, index],
        blockNumber,
      }),
    );
  }
  const actualSet = new Set(actual.map((value) => value.toLowerCase()));
  const expectedSet = new Set(
    assignment.accounts.map((value) => value.toLowerCase()),
  );
  if (assignment.allowMissingDeployer) {
    expectedSet.delete(account.address.toLowerCase());
    actualSet.delete(account.address.toLowerCase());
  }
  if (
    actualSet.size !== expectedSet.size ||
    [...actualSet].some((value) => !expectedSet.has(value))
  ) {
    throw new Error(`${assignment.label} has unexpected role members`);
  }
}

function deployerRoleAssignments(contracts, abis, roles) {
  return [
    {
      address: contracts.registry,
      abi: abis.registry,
      role: roles.verifier,
      account: account.address,
      label: "deployer BusinessRegistry VERIFIER_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: roles.treasuryManager,
      account: account.address,
      label: "deployer NoblePay TREASURY_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: roles.tee,
      account: account.address,
      label: "deployer NoblePay TEE_NODE_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: roles.officer,
      account: account.address,
      label: "deployer NoblePay COMPLIANCE_OFFICER_ROLE",
    },
    {
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      role: roles.channelsTreasuryManager,
      account: account.address,
      label: "deployer PaymentChannels TREASURY_ROLE",
    },
    {
      address: contracts.registry,
      abi: abis.registry,
      role: roles.registryAdmin,
      account: account.address,
      label: "deployer BusinessRegistry ADMIN_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: roles.noblePayAdmin,
      account: account.address,
      label: "deployer NoblePay ADMIN_ROLE",
    },
    {
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      role: roles.channelsAdmin,
      account: account.address,
      label: "deployer PaymentChannels ADMIN_ROLE",
    },
    {
      address: contracts.registry,
      abi: abis.registry,
      role: DEFAULT_ADMIN_ROLE,
      account: account.address,
      label: "deployer BusinessRegistry DEFAULT_ADMIN_ROLE",
    },
    {
      address: contracts.noblePay,
      abi: abis.noblePay,
      role: DEFAULT_ADMIN_ROLE,
      account: account.address,
      label: "deployer NoblePay DEFAULT_ADMIN_ROLE",
    },
    {
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      role: DEFAULT_ADMIN_ROLE,
      account: account.address,
      label: "deployer PaymentChannels DEFAULT_ADMIN_ROLE",
    },
  ];
}

function bootstrapDeployerRoleAssignments(contracts, abis, roles) {
  const constructorGrantedLabels = new Set([
    "deployer BusinessRegistry VERIFIER_ROLE",
    "deployer NoblePay TREASURY_ROLE",
    "deployer PaymentChannels TREASURY_ROLE",
    "deployer BusinessRegistry ADMIN_ROLE",
    "deployer NoblePay ADMIN_ROLE",
    "deployer PaymentChannels ADMIN_ROLE",
    "deployer BusinessRegistry DEFAULT_ADMIN_ROLE",
    "deployer NoblePay DEFAULT_ADMIN_ROLE",
    "deployer PaymentChannels DEFAULT_ADMIN_ROLE",
  ]);
  return deployerRoleAssignments(contracts, abis, roles).filter((assignment) =>
    constructorGrantedLabels.has(assignment.label),
  );
}

async function hasRole(
  assignment,
  { client = publicClient, blockNumber = undefined } = {},
) {
  return client.readContract({
    address: assignment.address,
    abi: assignment.abi,
    functionName: "hasRole",
    args: [assignment.role, assignment.account],
    blockNumber,
  });
}

async function ensureRole(assignment) {
  if (await hasRole(assignment)) return;
  await write(assignment.address, assignment.abi, "grantRole", [
    assignment.role,
    assignment.account,
  ]);
  if (!(await hasRole(assignment))) {
    throw new Error(`${assignment.label} grant read-back failed`);
  }
}

async function renounceRoleIfPresent(assignment) {
  if (!(await hasRole(assignment))) return;
  await write(assignment.address, assignment.abi, "renounceRole", [
    assignment.role,
    account.address,
  ]);
  if (await hasRole(assignment)) {
    throw new Error(`${assignment.label} renunciation read-back failed`);
  }
}

function policyMatches(policy) {
  return (
    JSON.stringify(policy[0]) === JSON.stringify(ALLOWED_BACKENDS) &&
    policy[1] === MIN_VERIFICATION &&
    JSON.stringify(policy[2]) === JSON.stringify(ALLOWED_PLATFORMS) &&
    policy[3] === REQUIRE_VENDOR_ROOT &&
    JSON.stringify(policy[4]) === JSON.stringify(DATA_RESIDENCY)
  );
}

function contractAbis() {
  return {
    registry: artifact("BusinessRegistry").abi,
    gate: artifact("SealSettlementGate").abi,
    noblePay: artifact("NoblePay").abi,
    paymentChannels: artifact("PaymentChannels").abi,
  };
}

async function assertExactSupportedTokenSet(
  client,
  address,
  abi,
  deploymentRecord,
  label,
  blockNumber,
) {
  const logs = await client.getContractEvents({
    address,
    abi,
    eventName: "TokenSupported",
    fromBlock: BigInt(deploymentRecord.blockNumber),
    toBlock: blockNumber,
    strict: true,
  });
  const observed = new Map();
  for (const log of logs) {
    const token = getAddress(log.args.token);
    observed.set(token.toLowerCase(), {
      token,
      supported: log.args.supported === true,
    });
  }
  const enabled = [...observed.values()]
    .filter(({ supported }) => supported)
    .map(({ token }) => token.toLowerCase())
    .sort();
  const expected = TOKENS.map((token) => token.toLowerCase()).sort();
  if (JSON.stringify(enabled) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} enabled-token event history does not exactly match SUPPORTED_TOKEN_ADDRESSES`,
    );
  }
}

async function verifyDeploymentState(
  contracts,
  {
    checkpoint,
    requireAcceptedOwnership,
    expectedDeployerRoleState,
    client = publicClient,
    source = "private RPC",
    releaseBlock = null,
  },
) {
  const snapshot =
    releaseBlock ?? (await captureCanonicalReleaseBlock(client, source));
  await verifyClientNetworkIdentity(client, source, snapshot.number);
  await assertReleaseBlockOnClient(client, source, snapshot);
  await Promise.all([
    assertReviewedRuntime(
      client,
      contracts.registry,
      "BusinessRegistry",
      snapshot.number,
    ),
    assertReviewedRuntime(
      client,
      contracts.gate,
      "SealSettlementGate",
      snapshot.number,
    ),
    assertReviewedRuntime(
      client,
      contracts.noblePay,
      "NoblePay",
      snapshot.number,
    ),
    assertReviewedRuntime(
      client,
      contracts.paymentChannels,
      "PaymentChannels",
      snapshot.number,
    ),
  ]);

  const abis = contractAbis();
  const roles = await readRoleIds(client, contracts, abis, snapshot.number);
  const [
    configured,
    configuredRegistry,
    configuredGate,
    linkedCore,
    policy,
    channelsCore,
    channelsRegistry,
    channelsTreasury,
    channelsFee,
    noblePayTreasury,
    noblePayBaseFee,
    noblePayPercentageFee,
    gateOwner,
    gatePendingOwner,
    registryPaused,
    gatePaused,
    noblePayPaused,
    paymentChannelsPaused,
  ] = await Promise.all([
    client.readContract({
      address: contracts.noblePay,
      abi: abis.noblePay,
      functionName: "trustConfigured",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.noblePay,
      abi: abis.noblePay,
      functionName: "businessRegistry",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.noblePay,
      abi: abis.noblePay,
      functionName: "sealSettlementGate",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.registry,
      abi: abis.registry,
      functionName: "noblePayContract",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.gate,
      abi: abis.gate,
      functionName: "compliancePolicy",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      functionName: "noblePayContract",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      functionName: "businessRegistry",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      functionName: "protocolTreasury",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      functionName: "protocolFeeBps",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.noblePay,
      abi: abis.noblePay,
      functionName: "treasury",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.noblePay,
      abi: abis.noblePay,
      functionName: "baseFee",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.noblePay,
      abi: abis.noblePay,
      functionName: "percentageFee",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.gate,
      abi: abis.gate,
      functionName: "owner",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.gate,
      abi: abis.gate,
      functionName: "pendingOwner",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.registry,
      abi: abis.registry,
      functionName: "paused",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.gate,
      abi: abis.gate,
      functionName: "paused",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.noblePay,
      abi: abis.noblePay,
      functionName: "paused",
      blockNumber: snapshot.number,
    }),
    client.readContract({
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      functionName: "paused",
      blockNumber: snapshot.number,
    }),
  ]);

  if (
    !configured ||
    !sameAddress(configuredRegistry, contracts.registry) ||
    !sameAddress(configuredGate, contracts.gate)
  ) {
    throw new Error("NoblePay trust configuration read-back failed");
  }
  if (!sameAddress(linkedCore, contracts.noblePay)) {
    throw new Error("BusinessRegistry core linkage read-back failed");
  }
  if (!policyMatches(policy)) throw new Error("CEAP policy read-back failed");
  if (!sameAddress(channelsCore, contracts.noblePay)) {
    throw new Error("PaymentChannels NoblePay linkage read-back failed");
  }
  if (!sameAddress(channelsRegistry, contracts.registry)) {
    throw new Error(
      "PaymentChannels BusinessRegistry linkage read-back failed",
    );
  }
  if (!sameAddress(channelsTreasury, TREASURY)) {
    throw new Error("PaymentChannels treasury read-back failed");
  }
  if (channelsFee !== PAYMENT_CHANNEL_FEE_BPS) {
    throw new Error("PaymentChannels fee read-back failed");
  }
  if (!sameAddress(noblePayTreasury, TREASURY)) {
    throw new Error("NoblePay treasury read-back failed");
  }
  if (
    noblePayBaseFee !== BASE_FEE ||
    noblePayPercentageFee !== PERCENTAGE_FEE
  ) {
    throw new Error("NoblePay fee read-back failed");
  }
  if (registryPaused || gatePaused || noblePayPaused || paymentChannelsPaused) {
    throw new Error("core deployment is paused; refusing release publication");
  }

  const finalRoleChecks = await Promise.all(
    finalRoleAssignments(contracts, abis, roles).map((assignment) =>
      hasRole(assignment, { client, blockNumber: snapshot.number }),
    ),
  );
  if (finalRoleChecks.some((present) => present !== true)) {
    throw new Error("final governance or operator role verification failed");
  }

  const membershipMode =
    expectedDeployerRoleState === true
      ? "bootstrap"
      : expectedDeployerRoleState === false
        ? "final"
        : "finalize-pending";
  for (const assignment of expectedRoleMembership(
    contracts,
    abis,
    roles,
    membershipMode,
  )) {
    await assertExactRoleMembers(client, assignment, snapshot.number);
  }

  const configurationChecks = await Promise.all([
    ...TOKENS.map((token) =>
      client.readContract({
        address: contracts.noblePay,
        abi: abis.noblePay,
        functionName: "supportedTokens",
        args: [token],
        blockNumber: snapshot.number,
      }),
    ),
    ...TOKENS.map((token) =>
      client.readContract({
        address: contracts.paymentChannels,
        abi: abis.paymentChannels,
        functionName: "supportedTokens",
        args: [token],
        blockNumber: snapshot.number,
      }),
    ),
  ]);
  if (configurationChecks.some((value) => value !== true)) {
    throw new Error("supported-token verification failed");
  }
  await Promise.all([
    assertExactSupportedTokenSet(
      client,
      contracts.noblePay,
      abis.noblePay,
      checkpoint.contracts.noblePay,
      "NoblePay",
      snapshot.number,
    ),
    assertExactSupportedTokenSet(
      client,
      contracts.paymentChannels,
      abis.paymentChannels,
      checkpoint.contracts.paymentChannels,
      "PaymentChannels",
      snapshot.number,
    ),
  ]);

  if (requireAcceptedOwnership) {
    assertGateOwnershipAccepted({
      owner: gateOwner,
      pendingOwner: gatePendingOwner,
      governance: ADMIN,
    });
  } else {
    const pendingAcceptance =
      sameAddress(gateOwner, account.address) &&
      sameAddress(gatePendingOwner, ADMIN);
    const alreadyAccepted =
      sameAddress(gateOwner, ADMIN) &&
      sameAddress(gatePendingOwner, ZERO_ADDRESS);
    if (!pendingAcceptance && !alreadyAccepted) {
      throw new Error("SealSettlementGate ownership handoff read-back failed");
    }
  }

  if (expectedDeployerRoleState !== null) {
    const assignments =
      expectedDeployerRoleState === true
        ? bootstrapDeployerRoleAssignments(contracts, abis, roles)
        : deployerRoleAssignments(contracts, abis, roles);
    const deployerChecks = await Promise.all(
      assignments.map((assignment) =>
        hasRole(assignment, { client, blockNumber: snapshot.number }),
      ),
    );
    if (
      deployerChecks.some((present) => present !== expectedDeployerRoleState)
    ) {
      throw new Error(
        expectedDeployerRoleState
          ? "bootstrap deployer roles are incomplete"
          : "deployer retains a privileged role after finalization",
      );
    }
  }

  await assertReleaseBlockOnClient(client, source, snapshot);

  return {
    abis,
    roles,
    releaseBlock: snapshot,
    gateOwnershipAccepted:
      sameAddress(gateOwner, ADMIN) &&
      sameAddress(gatePendingOwner, ZERO_ADDRESS),
  };
}

async function bootstrap() {
  await verifyNetwork({ requireDeployerBalance: true });
  await verifyExternalDependencies();

  const checkpoint = structuredClone(DEPLOYMENT_CHECKPOINT);
  const specs = coreDeploymentSpecs();
  await verifyCheckpointRecords(publicClient, "private RPC", checkpoint);
  persistDeploymentCheckpoint(checkpoint);
  for (const key of CORE_CONTRACT_KEYS) {
    if (checkpoint.contracts[key]) continue;
    const spec = specs[key];
    checkpoint.contracts[key] = await deploy(spec.name, spec.args);
    validateDeploymentCheckpoint(checkpoint, CHECKPOINT_METADATA);
    persistDeploymentCheckpoint(checkpoint);
    printDeploymentCheckpoint(checkpoint);
  }
  const contracts = checkpointContracts(checkpoint);

  const abis = contractAbis();
  const currentPolicy = await publicClient.readContract({
    address: contracts.gate,
    abi: abis.gate,
    functionName: "compliancePolicy",
  });
  if (!policyMatches(currentPolicy)) {
    const gateOwner = await publicClient.readContract({
      address: contracts.gate,
      abi: abis.gate,
      functionName: "owner",
    });
    if (!sameAddress(gateOwner, account.address)) {
      throw new Error(
        "deployer cannot configure SealSettlementGate after ownership acceptance",
      );
    }
    await write(contracts.gate, abis.gate, "setCompliancePolicy", [
      ALLOWED_BACKENDS,
      MIN_VERIFICATION,
      ALLOWED_PLATFORMS,
      REQUIRE_VENDOR_ROOT,
      DATA_RESIDENCY,
    ]);
  }

  const trustConfigured = await publicClient.readContract({
    address: contracts.noblePay,
    abi: abis.noblePay,
    functionName: "trustConfigured",
  });
  if (!trustConfigured) {
    await write(contracts.noblePay, abis.noblePay, "configureTrust", [
      contracts.registry,
      contracts.gate,
    ]);
  }

  const registryCore = await publicClient.readContract({
    address: contracts.registry,
    abi: abis.registry,
    functionName: "noblePayContract",
  });
  if (sameAddress(registryCore, ZERO_ADDRESS)) {
    await write(contracts.registry, abis.registry, "setNoblePayContract", [
      contracts.noblePay,
    ]);
  } else if (!sameAddress(registryCore, contracts.noblePay)) {
    throw new Error(
      "BusinessRegistry is linked to a different NoblePay contract",
    );
  }

  for (const token of TOKENS) {
    const noblePaySupported = await publicClient.readContract({
      address: contracts.noblePay,
      abi: abis.noblePay,
      functionName: "supportedTokens",
      args: [token],
    });
    if (!noblePaySupported) {
      await write(contracts.noblePay, abis.noblePay, "setSupportedToken", [
        token,
        true,
      ]);
    }
    const channelsSupported = await publicClient.readContract({
      address: contracts.paymentChannels,
      abi: abis.paymentChannels,
      functionName: "supportedTokens",
      args: [token],
    });
    if (!channelsSupported) {
      await write(
        contracts.paymentChannels,
        abis.paymentChannels,
        "setSupportedToken",
        [token, true],
      );
    }
  }

  const channelsCore = await publicClient.readContract({
    address: contracts.paymentChannels,
    abi: abis.paymentChannels,
    functionName: "noblePayContract",
  });
  if (sameAddress(channelsCore, ZERO_ADDRESS)) {
    await write(
      contracts.paymentChannels,
      abis.paymentChannels,
      "setNoblePayContract",
      [contracts.noblePay],
    );
  } else if (!sameAddress(channelsCore, contracts.noblePay)) {
    throw new Error(
      "PaymentChannels is linked to a different NoblePay contract",
    );
  }

  const channelsRegistry = await publicClient.readContract({
    address: contracts.paymentChannels,
    abi: abis.paymentChannels,
    functionName: "businessRegistry",
  });
  if (sameAddress(channelsRegistry, ZERO_ADDRESS)) {
    await write(
      contracts.paymentChannels,
      abis.paymentChannels,
      "configureBusinessRegistry",
      [contracts.registry],
    );
  } else if (!sameAddress(channelsRegistry, contracts.registry)) {
    throw new Error(
      "PaymentChannels is linked to a different BusinessRegistry contract",
    );
  }

  const roles = await readRoleIds(publicClient, contracts, abis);
  for (const assignment of finalRoleAssignments(contracts, abis, roles)) {
    await ensureRole(assignment);
  }

  const [gateOwner, gatePendingOwner] = await Promise.all([
    publicClient.readContract({
      address: contracts.gate,
      abi: abis.gate,
      functionName: "owner",
    }),
    publicClient.readContract({
      address: contracts.gate,
      abi: abis.gate,
      functionName: "pendingOwner",
    }),
  ]);
  if (
    sameAddress(gateOwner, account.address) &&
    sameAddress(gatePendingOwner, ZERO_ADDRESS)
  ) {
    await write(contracts.gate, abis.gate, "transferOwnership", [ADMIN]);
  } else if (
    !(
      sameAddress(gateOwner, account.address) &&
      sameAddress(gatePendingOwner, ADMIN)
    ) &&
    !(
      sameAddress(gateOwner, ADMIN) &&
      sameAddress(gatePendingOwner, ZERO_ADDRESS)
    )
  ) {
    throw new Error("SealSettlementGate has an unexpected ownership state");
  }

  const state = await verifyDeploymentState(contracts, {
    checkpoint,
    requireAcceptedOwnership: false,
    expectedDeployerRoleState: true,
  });
  const handoff = {
    phase: state.gateOwnershipAccepted
      ? "finalization-required"
      : "governance-acceptance-required",
    applicationConfigurationReady: false,
    chainId: CHAIN_ID,
    chainEnvironment: CHAIN_ENV,
    networkAnchor: {
      blockNumber: NETWORK_ANCHOR_BLOCK.toString(),
      blockHash: NETWORK_ANCHOR_HASH,
    },
    deployer: account.address,
    governance: ADMIN,
    treasuryBeneficiary: TREASURY,
    treasuryManager: TREASURY_MANAGER,
    teeNode: TEE_NODE,
    teeNodeAccountType: TEE_NODE_ACCOUNT_TYPE,
    contracts,
    bootstrapCheckpoint: checkpoint,
    nextStep: state.gateOwnershipAccepted
      ? "run this command again with --finalize and the same checkpoint file"
      : "ADMIN_ADDRESS must call SealSettlementGate.acceptOwnership, then run --finalize with the same checkpoint file",
  };
  console.log(`\nHANDOFF_PENDING_JSON=${JSON.stringify(handoff)}`);
  console.log(
    "Application manifest and frontend environment intentionally withheld until governance finalization.",
  );
}

async function finalize() {
  await verifyNetwork({ requireDeployerBalance: false });
  await verifyExternalDependencies();
  await verifyCheckpointRecords(
    publicClient,
    "private RPC",
    DEPLOYMENT_CHECKPOINT,
  );
  const contracts = checkpointContracts(DEPLOYMENT_CHECKPOINT);
  const state = await verifyDeploymentState(contracts, {
    checkpoint: DEPLOYMENT_CHECKPOINT,
    requireAcceptedOwnership: true,
    expectedDeployerRoleState: null,
  });
  const deployerAssignments = deployerRoleAssignments(
    contracts,
    state.abis,
    state.roles,
  );
  const deployerRolesBefore = await Promise.all(
    deployerAssignments.map(hasRole),
  );
  if (
    deployerRolesBefore.some(Boolean) &&
    (await publicClient.getBalance({ address: account.address })) === 0n
  ) {
    throw new Error(
      "deployer has no native balance to finalize role renunciations",
    );
  }

  // Least-privileged ordering: operational roles first, contract admin roles
  // second, and every DEFAULT_ADMIN_ROLE only after all other removals.
  for (const assignment of deployerAssignments) {
    await renounceRoleIfPresent(assignment);
  }

  if (!frontendPublicClient) {
    throw new Error("public frontend RPC is required for finalization");
  }
  const releaseBlock = await captureCanonicalReleaseBlock();
  await verifyCheckpointRecords(
    publicClient,
    "private RPC",
    DEPLOYMENT_CHECKPOINT,
    releaseBlock.number,
  );
  await verifyCheckpointRecords(
    frontendPublicClient,
    "public frontend RPC",
    DEPLOYMENT_CHECKPOINT,
    releaseBlock.number,
  );
  const finalState = await verifyDeploymentState(contracts, {
    checkpoint: DEPLOYMENT_CHECKPOINT,
    requireAcceptedOwnership: true,
    expectedDeployerRoleState: false,
    client: publicClient,
    source: "private RPC",
    releaseBlock,
  });
  const publicFinalState = await verifyDeploymentState(contracts, {
    checkpoint: DEPLOYMENT_CHECKPOINT,
    requireAcceptedOwnership: true,
    expectedDeployerRoleState: false,
    client: frontendPublicClient,
    source: "public frontend RPC",
    releaseBlock,
  });
  assertPublicationReady({
    gateOwnershipAccepted:
      finalState.gateOwnershipAccepted &&
      publicFinalState.gateOwnershipAccepted,
    finalRolesPresent: true,
    deployerRolesRemoved: true,
    configurationVerified: true,
    runtimeBytecodeVerified: true,
    publicCheckpointVerified: true,
    releaseSnapshotVerified: true,
  });
  // Publication is a separate security boundary from the last mutation and
  // all snapshot reads. Recheck the exact pinned release hash through both RPCs
  // as the final asynchronous operation before constructing the manifest.
  await verifyReleasePublicationBoundary(releaseBlock);

  const applicationEnvironment = validateFinalizedEnvironment({
    PUBLIC_ORIGIN: FRONTEND_SITE_URL,
    PUBLIC_AETHELRED_RPC_URL: FRONTEND_RPC_URL,
    PUBLIC_AETHELRED_WS_URL: FRONTEND_CHAIN_WS_URL,
    PUBLIC_AETHELRED_EXPLORER_URL: FRONTEND_EXPLORER_URL,
    NOBLEPAY_CHAIN_ID: CHAIN_ID.toString(),
    AETHELRED_NETWORK_ANCHOR_BLOCK: NETWORK_ANCHOR_BLOCK.toString(),
    AETHELRED_NETWORK_ANCHOR_HASH: NETWORK_ANCHOR_HASH,
    NOBLEPAY_CONTRACT_ADDRESS: contracts.noblePay,
    BUSINESS_REGISTRY_CONTRACT_ADDRESS: contracts.registry,
    BUSINESS_VERIFIER_ADDRESS: BUSINESS_VERIFIER,
    PAYMENT_CHANNELS_ADDRESS: contracts.paymentChannels,
    NOBLEPAY_TOKEN_CONFIG: JSON.stringify({
      [NAMED_TOKENS.USDC]: {
        currency: "USDC",
        currencyCode: "USD",
        decimals: STABLECOIN_DECIMALS,
      },
      [NAMED_TOKENS.USDT]: {
        currency: "USDT",
        currencyCode: "USD",
        decimals: STABLECOIN_DECIMALS,
      },
    }),
    USDC_TOKEN_ADDRESS: NAMED_TOKENS.USDC,
    USDT_TOKEN_ADDRESS: NAMED_TOKENS.USDT,
    NEXT_PUBLIC_CHAIN_ENV: CHAIN_ENV,
    NEXT_PUBLIC_API_URL: FRONTEND_API_URL,
    NEXT_PUBLIC_WS_URL: FRONTEND_WS_URL,
    WALLETCONNECT_PROJECT_ID: WALLETCONNECT_PROJECT_ID,
    NEXT_PUBLIC_SENTRY_DSN: FRONTEND_SENTRY_DSN,
    NEXT_PUBLIC_APP_VERSION: FRONTEND_APP_VERSION,
    INDEXER_START_BLOCK: DEPLOYMENT_CHECKPOINT.contracts.noblePay.blockNumber,
  });
  const manifest = {
    chainId: CHAIN_ID,
    chainEnvironment: CHAIN_ENV,
    networkAnchor: {
      blockNumber: NETWORK_ANCHOR_BLOCK.toString(),
      blockHash: NETWORK_ANCHOR_HASH,
    },
    releaseBlock: {
      blockNumber: releaseBlock.number.toString(),
      blockHash: releaseBlock.hash,
    },
    deployer: account.address,
    deploymentEvidence: DEPLOYMENT_CHECKPOINT.contracts,
    admin: ADMIN,
    deployerRolesRemoved: true,
    treasuryBeneficiary: TREASURY,
    treasuryManager: TREASURY_MANAGER,
    teeNode: TEE_NODE,
    teeNodeAccountType: TEE_NODE_ACCOUNT_TYPE,
    complianceOfficer: COMPLIANCE_OFFICER,
    businessVerifier: BUSINESS_VERIFIER,
    contracts: {
      noblePay: contracts.noblePay,
      businessRegistry: contracts.registry,
      sealSettlementGate: contracts.gate,
      paymentChannels: contracts.paymentChannels,
      supportedTokens: TOKENS,
    },
    indexer: {
      contract: contracts.noblePay,
      startBlock: DEPLOYMENT_CHECKPOINT.contracts.noblePay.blockNumber,
    },
    assetPolicy: {
      mode: "approved-6-decimal-usd-stablecoins-only",
      nativePaymentsEnabled: false,
      decimals: STABLECOIN_DECIMALS,
      flatFeeUnit: "stablecoin-smallest-unit",
      standardDailyLimit: STANDARD_DAILY_LIMIT.toString(),
    },
    paymentChannels: {
      protocolFeeBps: PAYMENT_CHANNEL_FEE_BPS.toString(),
      kycMode: "live-business-registry",
      businessRegistry: contracts.registry,
    },
    ceap: {
      allowedBackends: ALLOWED_BACKENDS,
      minVerification: MIN_VERIFICATION,
      allowedPlatforms: ALLOWED_PLATFORMS,
      requireVendorRoot: REQUIRE_VENDOR_ROOT,
      dataResidency: DATA_RESIDENCY,
    },
    applicationEnvironment,
  };

  if (MANIFEST_FILE) {
    writeSecureJSONFile(
      MANIFEST_FILE,
      manifest,
      "finalized deployment manifest",
    );
  }
  console.log("\nDEPLOYMENT_MANIFEST_JSON=" + JSON.stringify(manifest));
  console.log(
    "\nFINALIZED_RELEASE_ENV_JSON=" + JSON.stringify(applicationEnvironment),
  );
  if (MANIFEST_FILE) {
    console.log(`Finalized manifest persisted to ${MANIFEST_FILE}.`);
  }
}

(DEPLOYMENT_MODE === "bootstrap" ? bootstrap() : finalize()).catch((error) => {
  console.error(
    `FAIL: ${error.shortMessage ?? error.message ?? String(error)}`,
  );
  process.exitCode = 1;
});
