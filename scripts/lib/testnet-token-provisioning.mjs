import { isDeepStrictEqual } from "node:util";

import { getAddress, isAddress, keccak256, stringToHex } from "viem";

import { validatePrivateRpcTransport } from "./rpc-transport-policy.mjs";

export const TOKEN_PROVISIONING_KIND =
  "noblepay-public-testnet-token-provisioning";
export const TOKEN_PROVISIONING_VERSION = 2;
export const TOKEN_PROVISIONING_CONFIRMATION =
  "deploy-publicly-mintable-test-tokens";

export const TESTNET_TOKEN_SPECS = Object.freeze({
  USDC: Object.freeze({
    name: "NoblePay Public Testnet USD Coin",
    symbol: "USDC",
    decimals: 6,
  }),
  USDT: Object.freeze({
    name: "NoblePay Public Testnet Tether USD",
    symbol: "USDT",
    decimals: 6,
  }),
});

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
const BLOCK_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-fA-F]{40}$/u;
const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const FORBIDDEN_MANIFEST_KEYS = new Set([
  "DEPLOYER_KEY",
  "PRIVATE_KEY",
  "RPC_URL",
  "TOKEN_PROVISIONER_KEY",
  "TOKEN_PROVISIONER_KEY_FILE",
  "deployerKey",
  "privateKey",
  "rpcUrl",
  "tokenProvisionerKey",
  "tokenProvisionerKeyFile",
]);

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveSafeInteger(value, label, { allowZero = false } = {}) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be an unsigned decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${label} is outside the supported integer range`);
  }
  return parsed;
}

function normalizedBlockHash(value, label) {
  if (!BLOCK_HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a 32-byte 0x-prefixed hash`);
  }
  return value.toLowerCase();
}

function normalizedAddress(value, label) {
  if (!ADDRESS_PATTERN.test(value) || !isAddress(value)) {
    throw new Error(`${label} must be a valid 0x address`);
  }
  if (/^0x0{40}$/iu.test(value)) {
    throw new Error(`${label} must not be the zero address`);
  }
  return getAddress(value);
}

function optionalExistingToken(environment, symbol) {
  const addressName = `EXISTING_${symbol}_TOKEN_ADDRESS`;
  const tokenNameName = `EXISTING_${symbol}_TOKEN_NAME`;
  const address = environment[addressName]?.trim() ?? "";
  const name = environment[tokenNameName]?.trim() ?? "";
  if (!address && !name) return null;
  if (!address || !name) {
    throw new Error(
      `${addressName} and ${tokenNameName} must be supplied together`,
    );
  }
  if (name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error(
      `${tokenNameName} must be a printable 1-128 character name`,
    );
  }
  return {
    address: normalizedAddress(address, addressName),
    name,
  };
}

export function validateProvisioningEnvironment(
  environment,
  { validateOnly = false, requireKeyFile = true } = {},
) {
  if (required(environment, "CHAIN_ENV") !== "testnet") {
    throw new Error(
      "CHAIN_ENV must be exactly testnet; this command cannot run on devnet or mainnet",
    );
  }

  const rpcPolicy = validatePrivateRpcTransport({
    chainEnvironment: "testnet",
    rpcUrl: required(environment, "RPC_URL"),
    insecureTestnetAcknowledgement:
      environment.ALLOW_INSECURE_TESTNET_RPC ?? "",
  });

  const chainId = positiveSafeInteger(
    required(environment, "AETHELRED_CHAIN_ID"),
    "AETHELRED_CHAIN_ID",
  );
  const networkAnchorBlock = positiveSafeInteger(
    required(environment, "AETHELRED_NETWORK_ANCHOR_BLOCK"),
    "AETHELRED_NETWORK_ANCHOR_BLOCK",
    { allowZero: true },
  );
  const networkAnchorHash = normalizedBlockHash(
    required(environment, "AETHELRED_NETWORK_ANCHOR_HASH"),
    "AETHELRED_NETWORK_ANCHOR_HASH",
  );
  const sourceCommit = required(
    environment,
    "NOBLEPAY_SOURCE_COMMIT",
  ).toLowerCase();
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error(
      "NOBLEPAY_SOURCE_COMMIT must be a reviewed 40-character commit SHA",
    );
  }
  const provisioner = normalizedAddress(
    required(environment, "TOKEN_PROVISIONER_ADDRESS"),
    "TOKEN_PROVISIONER_ADDRESS",
  );
  const configuredKeyFile =
    environment.TOKEN_PROVISIONER_KEY_FILE?.trim() ?? "";
  const keyFile = requireKeyFile
    ? required(environment, "TOKEN_PROVISIONER_KEY_FILE")
    : configuredKeyFile || null;
  if (keyFile && !keyFile.startsWith("/")) {
    throw new Error("TOKEN_PROVISIONER_KEY_FILE must be an absolute path");
  }
  if (environment.DEPLOYER_KEY?.trim() || environment.PRIVATE_KEY?.trim()) {
    throw new Error(
      "inline private-key variables are prohibited; use TOKEN_PROVISIONER_KEY_FILE",
    );
  }
  const existingTokens = {
    USDC: optionalExistingToken(environment, "USDC"),
    USDT: optionalExistingToken(environment, "USDT"),
  };
  if (
    existingTokens.USDC &&
    existingTokens.USDT &&
    existingTokens.USDC.address.toLowerCase() ===
      existingTokens.USDT.address.toLowerCase()
  ) {
    throw new Error(
      "EXISTING_USDC_TOKEN_ADDRESS and EXISTING_USDT_TOKEN_ADDRESS must be different contracts",
    );
  }

  const confirmation =
    environment.CONFIRM_TESTNET_TOKEN_PROVISIONING?.trim() ?? "";
  if (validateOnly) {
    if (confirmation && confirmation !== "false") {
      throw new Error(
        "keep CONFIRM_TESTNET_TOKEN_PROVISIONING=false during --validate-only",
      );
    }
  } else if (confirmation !== TOKEN_PROVISIONING_CONFIRMATION) {
    throw new Error(
      `set CONFIRM_TESTNET_TOKEN_PROVISIONING=${TOKEN_PROVISIONING_CONFIRMATION} only for the transaction-bearing run`,
    );
  }

  return {
    rpcUrl: rpcPolicy.rpcUrl,
    rpcTransportSecurity: rpcPolicy.transportSecurity,
    evaluationOnlyRpc: rpcPolicy.evaluationOnly,
    keyFile,
    publicConfiguration: {
      chainEnvironment: "testnet",
      chainId,
      networkAnchor: {
        blockNumber: String(networkAnchorBlock),
        blockHash: networkAnchorHash,
      },
      sourceCommit,
      provisioner,
      existingTokens,
    },
  };
}

export function artifactIdentity(artifact) {
  const hasAbiEntry = (type, name, inputTypes, outputTypes = []) =>
    artifact?.abi?.some(
      (entry) =>
        entry.type === type &&
        (name === null || entry.name === name) &&
        isDeepStrictEqual(
          (entry.inputs ?? []).map((input) => input.type),
          inputTypes,
        ) &&
        isDeepStrictEqual(
          (entry.outputs ?? []).map((output) => output.type),
          outputTypes,
        ),
    );
  if (
    artifact?.contractName !== "MockERC20" ||
    artifact?.sourceName !== "src/MockERC20.sol" ||
    !/^0x[0-9a-fA-F]+$/u.test(artifact.bytecode ?? "") ||
    !/^0x[0-9a-fA-F]+$/u.test(artifact.deployedBytecode ?? "") ||
    Object.keys(artifact.linkReferences ?? {}).length !== 0 ||
    Object.keys(artifact.deployedLinkReferences ?? {}).length !== 0 ||
    !hasAbiEntry("constructor", null, ["string", "string", "uint8"]) ||
    !hasAbiEntry("function", "mint", ["address", "uint256"]) ||
    !hasAbiEntry("function", "name", [], ["string"]) ||
    !hasAbiEntry("function", "symbol", [], ["string"]) ||
    !hasAbiEntry("function", "decimals", [], ["uint8"])
  ) {
    throw new Error(
      "MockERC20 artifact is missing, linked, or malformed; run a clean reviewed Hardhat compile",
    );
  }
  return {
    contractName: artifact.contractName,
    sourceName: artifact.sourceName,
    creationBytecodeHash: keccak256(artifact.bytecode),
    runtimeBytecodeHash: keccak256(artifact.deployedBytecode),
  };
}

export function provisioningMetadata(publicConfiguration, artifact) {
  const metadata = {
    kind: TOKEN_PROVISIONING_KIND,
    version: TOKEN_PROVISIONING_VERSION,
    ...publicConfiguration,
    artifact,
    tokenSpecs: TESTNET_TOKEN_SPECS,
    issuancePolicy: "permissionless-mint-testnet-only",
  };
  return {
    ...metadata,
    configurationDigest: keccak256(stringToHex(JSON.stringify(metadata))),
  };
}

export function createProvisioningCheckpoint(metadata) {
  return {
    ...metadata,
    tokens: {
      USDC: null,
      USDT: null,
    },
  };
}

function validateTokenRecord(record, symbol) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${symbol} checkpoint record must be an object`);
  }

  if (record.origin === "adopted") {
    if (record.status !== "confirmed") {
      throw new Error(`${symbol} adopted checkpoint must be confirmed`);
    }
    normalizedAddress(record.address, `${symbol} address`);
    if (
      typeof record.name !== "string" ||
      !record.name ||
      record.name.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(record.name)
    ) {
      throw new Error(`${symbol} adopted checkpoint name is invalid`);
    }
    if (!/^(?:0|[1-9][0-9]*)$/u.test(record.blockNumber ?? "")) {
      throw new Error(`${symbol} checkpoint block number is invalid`);
    }
    normalizedBlockHash(record.blockHash, `${symbol} checkpoint block hash`);
    normalizedBlockHash(
      record.runtimeBytecodeHash,
      `${symbol} runtime bytecode hash`,
    );
    const keys = Object.keys(record).sort();
    if (
      !isDeepStrictEqual(keys, [
        "address",
        "blockHash",
        "blockNumber",
        "name",
        "origin",
        "runtimeBytecodeHash",
        "status",
      ])
    ) {
      throw new Error(`${symbol} adopted checkpoint has unexpected fields`);
    }
    return record;
  }

  if (record.origin !== "deployed") {
    throw new Error(`${symbol} checkpoint origin is invalid`);
  }
  if (!["prepared", "broadcast", "confirmed"].includes(record.status)) {
    throw new Error(`${symbol} checkpoint record has an invalid status`);
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(record.nonce ?? "")) {
    throw new Error(`${symbol} checkpoint nonce is invalid`);
  }
  normalizedAddress(record.expectedAddress, `${symbol} expectedAddress`);
  if (record.status === "prepared") {
    const keys = Object.keys(record).sort();
    if (
      !isDeepStrictEqual(keys, ["expectedAddress", "nonce", "origin", "status"])
    ) {
      throw new Error(`${symbol} prepared checkpoint has unexpected fields`);
    }
    return record;
  }
  if (!TRANSACTION_HASH_PATTERN.test(record.transactionHash ?? "")) {
    throw new Error(`${symbol} checkpoint transaction hash is invalid`);
  }
  if (record.status === "broadcast") {
    const keys = Object.keys(record).sort();
    if (
      !isDeepStrictEqual(keys, [
        "expectedAddress",
        "nonce",
        "origin",
        "status",
        "transactionHash",
      ])
    ) {
      throw new Error(`${symbol} broadcast checkpoint has unexpected fields`);
    }
    return record;
  }

  normalizedAddress(record.address, `${symbol} address`);
  if (record.address.toLowerCase() !== record.expectedAddress.toLowerCase()) {
    throw new Error(`${symbol} confirmed address differs from expectedAddress`);
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(record.blockNumber ?? "")) {
    throw new Error(`${symbol} checkpoint block number is invalid`);
  }
  normalizedBlockHash(record.blockHash, `${symbol} checkpoint block hash`);
  normalizedBlockHash(
    record.runtimeBytecodeHash,
    `${symbol} runtime bytecode hash`,
  );
  const keys = Object.keys(record).sort();
  if (
    !isDeepStrictEqual(keys, [
      "address",
      "blockHash",
      "blockNumber",
      "expectedAddress",
      "nonce",
      "origin",
      "runtimeBytecodeHash",
      "status",
      "transactionHash",
    ])
  ) {
    throw new Error(`${symbol} confirmed checkpoint has unexpected fields`);
  }
  return record;
}

function validateVersionOneTokenRecord(record, symbol) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`${symbol} version-1 checkpoint record must be an object`);
  }
  if (!["prepared", "broadcast", "confirmed"].includes(record.status)) {
    throw new Error(`${symbol} version-1 checkpoint status is invalid`);
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(record.nonce ?? "")) {
    throw new Error(`${symbol} version-1 checkpoint nonce is invalid`);
  }
  normalizedAddress(record.expectedAddress, `${symbol} expectedAddress`);
  const expectedKeys =
    record.status === "prepared"
      ? ["expectedAddress", "nonce", "status"]
      : record.status === "broadcast"
        ? ["expectedAddress", "nonce", "status", "transactionHash"]
        : [
            "address",
            "blockHash",
            "blockNumber",
            "expectedAddress",
            "nonce",
            "runtimeBytecodeHash",
            "status",
            "transactionHash",
          ];
  if (!isDeepStrictEqual(Object.keys(record).sort(), expectedKeys)) {
    throw new Error(`${symbol} version-1 checkpoint has unexpected fields`);
  }
  if (record.status !== "prepared") {
    if (!TRANSACTION_HASH_PATTERN.test(record.transactionHash ?? "")) {
      throw new Error(
        `${symbol} version-1 checkpoint transaction hash is invalid`,
      );
    }
  }
  if (record.status === "confirmed") {
    normalizedAddress(record.address, `${symbol} address`);
    if (record.address.toLowerCase() !== record.expectedAddress.toLowerCase()) {
      throw new Error(
        `${symbol} version-1 confirmed address differs from expectedAddress`,
      );
    }
    if (!/^(?:0|[1-9][0-9]*)$/u.test(record.blockNumber ?? "")) {
      throw new Error(`${symbol} version-1 checkpoint block number is invalid`);
    }
    normalizedBlockHash(record.blockHash, `${symbol} checkpoint block hash`);
    normalizedBlockHash(
      record.runtimeBytecodeHash,
      `${symbol} runtime bytecode hash`,
    );
  }
  return record;
}

function versionOneMetadata(metadata) {
  const legacy = { ...metadata };
  delete legacy.configurationDigest;
  delete legacy.existingTokens;
  legacy.version = 1;
  return {
    ...legacy,
    configurationDigest: keccak256(stringToHex(JSON.stringify(legacy))),
  };
}

export function restoreProvisioningCheckpoint(checkpoint, metadata) {
  if (checkpoint?.version !== 1) {
    return {
      checkpoint: validateProvisioningCheckpoint(checkpoint, metadata),
      migrated: false,
    };
  }
  if (Object.values(metadata.existingTokens).some(Boolean)) {
    throw new Error(
      "a version-1 token checkpoint cannot be combined with existing-token adoption; resume it without EXISTING_* inputs or reconcile it manually",
    );
  }
  const { tokens, ...actualMetadata } = checkpoint;
  if (!isDeepStrictEqual(actualMetadata, versionOneMetadata(metadata))) {
    throw new Error(
      "version-1 token checkpoint does not match the reviewed chain, source, provisioner, or artifact",
    );
  }
  if (
    !tokens ||
    typeof tokens !== "object" ||
    Array.isArray(tokens) ||
    !isDeepStrictEqual(Object.keys(tokens).sort(), ["USDC", "USDT"])
  ) {
    throw new Error(
      "version-1 token checkpoint must contain exactly USDC and USDT records",
    );
  }
  const migratedTokens = {};
  for (const symbol of Object.keys(TESTNET_TOKEN_SPECS)) {
    const record = tokens[symbol];
    migratedTokens[symbol] =
      record === null
        ? null
        : {
            ...validateVersionOneTokenRecord(record, symbol),
            origin: "deployed",
          };
  }
  const migratedCheckpoint = {
    ...metadata,
    tokens: migratedTokens,
  };
  validateProvisioningCheckpoint(migratedCheckpoint, metadata);
  return { checkpoint: migratedCheckpoint, migrated: true };
}

export function validateProvisioningCheckpoint(checkpoint, metadata) {
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  ) {
    throw new Error("token provisioning checkpoint must be a JSON object");
  }
  const { tokens, ...actualMetadata } = checkpoint;
  if (!isDeepStrictEqual(actualMetadata, metadata)) {
    throw new Error(
      "token provisioning checkpoint does not match the reviewed chain, source, provisioner, or artifact",
    );
  }
  if (
    !tokens ||
    typeof tokens !== "object" ||
    Array.isArray(tokens) ||
    !isDeepStrictEqual(Object.keys(tokens).sort(), ["USDC", "USDT"])
  ) {
    throw new Error(
      "token provisioning checkpoint must contain exactly USDC and USDT records",
    );
  }
  for (const symbol of Object.keys(TESTNET_TOKEN_SPECS)) {
    if (tokens[symbol] === null) continue;
    const record = validateTokenRecord(tokens[symbol], symbol);
    const configuredExisting = metadata.existingTokens[symbol];
    if (record.origin === "adopted") {
      if (
        !configuredExisting ||
        record.address.toLowerCase() !==
          configuredExisting.address.toLowerCase() ||
        record.name !== configuredExisting.name
      ) {
        throw new Error(
          `${symbol} adopted checkpoint does not match the configured existing token`,
        );
      }
    } else if (configuredExisting) {
      throw new Error(
        `${symbol} checkpoint deploys a replacement even though an existing token was configured`,
      );
    }
  }
  return checkpoint;
}

function confirmedTokenRecord(record, symbol) {
  validateTokenRecord(record, symbol);
  if (record.status !== "confirmed") {
    throw new Error(`${symbol} has not reached confirmed provisioning state`);
  }
  const common = {
    address: getAddress(record.address),
    name:
      record.origin === "adopted"
        ? record.name
        : TESTNET_TOKEN_SPECS[symbol].name,
    symbol,
    decimals: TESTNET_TOKEN_SPECS[symbol].decimals,
    mintPolicy: "permissionless-testnet-only",
  };
  if (record.origin === "adopted") {
    return {
      ...common,
      provenance: {
        type: "adopted-existing-contract",
        verificationBlockNumber: record.blockNumber,
        verificationBlockHash: record.blockHash.toLowerCase(),
        runtimeBytecodeHash: record.runtimeBytecodeHash.toLowerCase(),
      },
    };
  }
  return {
    ...common,
    provenance: {
      type: "deployed-by-ceremony",
      transactionHash: record.transactionHash.toLowerCase(),
      blockNumber: record.blockNumber,
      blockHash: record.blockHash.toLowerCase(),
      runtimeBytecodeHash: record.runtimeBytecodeHash.toLowerCase(),
    },
  };
}

export function assertSecretFreeManifest(manifest) {
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_MANIFEST_KEYS.has(key)) {
        throw new Error(
          `token manifest contains prohibited secret field ${key}`,
        );
      }
      visit(nested);
    }
  };
  visit(manifest);
  const serialized = JSON.stringify(manifest);
  if (/(?:https?|wss?):\/\//iu.test(serialized)) {
    throw new Error("token manifest contains an RPC URL");
  }
  return manifest;
}

export function buildProvisioningManifest(metadata, checkpoint) {
  validateProvisioningCheckpoint(checkpoint, metadata);
  const usdc = confirmedTokenRecord(checkpoint.tokens.USDC, "USDC");
  const usdt = confirmedTokenRecord(checkpoint.tokens.USDT, "USDT");
  if (usdc.address.toLowerCase() === usdt.address.toLowerCase()) {
    throw new Error("USDC and USDT must resolve to different contracts");
  }
  const manifest = {
    ...metadata,
    tokens: {
      USDC: usdc,
      USDT: usdt,
    },
    coreDeploymentEnvironment: {
      SUPPORTED_TOKEN_ADDRESSES: `${usdc.address},${usdt.address}`,
      USDC_TOKEN_ADDRESS: usdc.address,
      USDT_TOKEN_ADDRESS: usdt.address,
    },
  };
  return assertSecretFreeManifest(manifest);
}
