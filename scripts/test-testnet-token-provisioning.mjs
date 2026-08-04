#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { keccak256, stringToHex } from "viem";

import {
  TESTNET_TOKEN_SPECS,
  TOKEN_PROVISIONING_CONFIRMATION,
  artifactIdentity,
  assertSecretFreeManifest,
  buildProvisioningManifest,
  createProvisioningCheckpoint,
  provisioningMetadata,
  restoreProvisioningCheckpoint,
  validateProvisioningCheckpoint,
  validateProvisioningEnvironment,
} from "./lib/testnet-token-provisioning.mjs";
import {
  TESTNET_HTTP_RPC_ACKNOWLEDGEMENT,
  validatePrivateRpcTransport,
} from "./lib/rpc-transport-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..");
const fixtureEnvironment = {
  CHAIN_ENV: "testnet",
  RPC_URL: "https://private-rpc.example.test",
  AETHELRED_CHAIN_ID: "7332",
  AETHELRED_NETWORK_ANCHOR_BLOCK: "42",
  AETHELRED_NETWORK_ANCHOR_HASH: `0x${"ab".repeat(32)}`,
  NOBLEPAY_SOURCE_COMMIT: "cd".repeat(20),
  TOKEN_PROVISIONER_ADDRESS: "0x1111111111111111111111111111111111111111",
  TOKEN_PROVISIONER_KEY_FILE: "/secure/operator/token-provisioner.key",
  EXISTING_USDC_TOKEN_ADDRESS: "0x2222222222222222222222222222222222222222",
  EXISTING_USDC_TOKEN_NAME: "USD Coin",
  CONFIRM_TESTNET_TOKEN_PROVISIONING: TOKEN_PROVISIONING_CONFIRMATION,
};

const validated = validateProvisioningEnvironment(fixtureEnvironment);
assert.equal(validated.publicConfiguration.chainEnvironment, "testnet");
assert.equal(validated.publicConfiguration.chainId, 7332);
assert.equal(validated.publicConfiguration.networkAnchor.blockNumber, "42");
assert.equal(
  validated.publicConfiguration.provisioner,
  "0x1111111111111111111111111111111111111111",
);
assert.equal(validated.keyFile, fixtureEnvironment.TOKEN_PROVISIONER_KEY_FILE);
assert.deepEqual(validated.publicConfiguration.existingTokens.USDC, {
  address: "0x2222222222222222222222222222222222222222",
  name: "USD Coin",
});
assert.equal(validated.publicConfiguration.existingTokens.USDT, null);

const verificationEnvironment = { ...fixtureEnvironment };
delete verificationEnvironment.TOKEN_PROVISIONER_KEY_FILE;
verificationEnvironment.CONFIRM_TESTNET_TOKEN_PROVISIONING = "false";
const verificationConfiguration = validateProvisioningEnvironment(
  verificationEnvironment,
  { validateOnly: true, requireKeyFile: false },
);
assert.equal(verificationConfiguration.keyFile, null);

assert.throws(
  () =>
    validateProvisioningEnvironment({
      ...fixtureEnvironment,
      CHAIN_ENV: "mainnet",
    }),
  /cannot run on devnet or mainnet/u,
);
assert.throws(
  () =>
    validateProvisioningEnvironment({
      ...fixtureEnvironment,
      RPC_URL: "http://54.165.44.130:8545",
    }),
  /plaintext testnet RPC is evaluation-only/u,
);
const evaluationRpc = validateProvisioningEnvironment({
  ...fixtureEnvironment,
  RPC_URL: "http://54.165.44.130:8545",
  ALLOW_INSECURE_TESTNET_RPC: TESTNET_HTTP_RPC_ACKNOWLEDGEMENT,
});
assert.equal(evaluationRpc.rpcTransportSecurity, "plaintext-evaluation");
assert.throws(
  () =>
    validatePrivateRpcTransport({
      chainEnvironment: "mainnet",
      rpcUrl: "http://54.165.44.130:8545",
      insecureTestnetAcknowledgement: TESTNET_HTTP_RPC_ACKNOWLEDGEMENT,
    }),
  /mainnet deployments require an HTTPS RPC_URL/u,
);
assert.throws(
  () =>
    validatePrivateRpcTransport({
      chainEnvironment: "testnet",
      rpcUrl: "http://user:password@54.165.44.130:8545",
      insecureTestnetAcknowledgement: TESTNET_HTTP_RPC_ACKNOWLEDGEMENT,
    }),
  /must not contain credentials/u,
);
assert.throws(
  () =>
    validateProvisioningEnvironment({
      ...fixtureEnvironment,
      AETHELRED_CHAIN_ID: "0",
    }),
  /outside the supported integer range/u,
);
assert.throws(
  () =>
    validateProvisioningEnvironment({
      ...fixtureEnvironment,
      CONFIRM_TESTNET_TOKEN_PROVISIONING: "true",
    }),
  /deploy-publicly-mintable-test-tokens/u,
);
assert.throws(
  () =>
    validateProvisioningEnvironment({
      ...fixtureEnvironment,
      DEPLOYER_KEY: `0x${"11".repeat(32)}`,
    }),
  /inline private-key variables are prohibited/u,
);
assert.throws(
  () =>
    validateProvisioningEnvironment({
      ...fixtureEnvironment,
      EXISTING_USDC_TOKEN_NAME: "",
    }),
  /must be supplied together/u,
);
assert.throws(
  () =>
    validateProvisioningEnvironment({
      ...fixtureEnvironment,
      EXISTING_USDT_TOKEN_ADDRESS:
        fixtureEnvironment.EXISTING_USDC_TOKEN_ADDRESS,
      EXISTING_USDT_TOKEN_NAME: "Tether USD",
    }),
  /must be different contracts/u,
);
assert.doesNotThrow(() =>
  validateProvisioningEnvironment(
    {
      ...fixtureEnvironment,
      CONFIRM_TESTNET_TOKEN_PROVISIONING: "false",
    },
    { validateOnly: true },
  ),
);
assert.throws(
  () =>
    validateProvisioningEnvironment(fixtureEnvironment, {
      validateOnly: true,
    }),
  /keep CONFIRM_TESTNET_TOKEN_PROVISIONING=false/u,
);

assert.deepEqual(Object.keys(TESTNET_TOKEN_SPECS), ["USDC", "USDT"]);
for (const [symbol, spec] of Object.entries(TESTNET_TOKEN_SPECS)) {
  assert.equal(spec.symbol, symbol);
  assert.equal(spec.decimals, 6);
  assert.match(spec.name, /Public Testnet/u);
}

const artifact = {
  contractName: "MockERC20",
  sourceName: "src/MockERC20.sol",
  abi: [
    {
      type: "constructor",
      inputs: [{ type: "string" }, { type: "string" }, { type: "uint8" }],
    },
    {
      type: "function",
      name: "mint",
      inputs: [{ type: "address" }, { type: "uint256" }],
      outputs: [],
    },
    {
      type: "function",
      name: "name",
      inputs: [],
      outputs: [{ type: "string" }],
    },
    {
      type: "function",
      name: "symbol",
      inputs: [],
      outputs: [{ type: "string" }],
    },
    {
      type: "function",
      name: "decimals",
      inputs: [],
      outputs: [{ type: "uint8" }],
    },
  ],
  bytecode: "0x6000",
  deployedBytecode: "0x6001",
  linkReferences: {},
  deployedLinkReferences: {},
};
const identity = artifactIdentity(artifact);
assert.match(identity.creationBytecodeHash, /^0x[0-9a-f]{64}$/u);
assert.match(identity.runtimeBytecodeHash, /^0x[0-9a-f]{64}$/u);
assert.throws(
  () => artifactIdentity({ ...artifact, sourceName: "src/Other.sol" }),
  /missing, linked, or malformed/u,
);

const metadata = provisioningMetadata(validated.publicConfiguration, identity);
const checkpoint = createProvisioningCheckpoint(metadata);
validateProvisioningCheckpoint(checkpoint, metadata);
checkpoint.tokens.USDC = {
  origin: "adopted",
  status: "confirmed",
  address: "0x2222222222222222222222222222222222222222",
  name: "USD Coin",
  blockNumber: "99",
  blockHash: `0x${"33".repeat(32)}`,
  runtimeBytecodeHash: identity.runtimeBytecodeHash,
};
validateProvisioningCheckpoint(checkpoint, metadata);
checkpoint.tokens.USDT = {
  origin: "deployed",
  status: "prepared",
  nonce: "7",
  expectedAddress: "0x5555555555555555555555555555555555555555",
};
validateProvisioningCheckpoint(checkpoint, metadata);
checkpoint.tokens.USDT = {
  ...checkpoint.tokens.USDT,
  status: "broadcast",
  transactionHash: `0x${"44".repeat(32)}`,
};
validateProvisioningCheckpoint(checkpoint, metadata);
checkpoint.tokens.USDT = {
  ...checkpoint.tokens.USDT,
  status: "confirmed",
  address: "0x5555555555555555555555555555555555555555",
  blockNumber: "100",
  blockHash: `0x${"66".repeat(32)}`,
  runtimeBytecodeHash: identity.runtimeBytecodeHash,
};
validateProvisioningCheckpoint(checkpoint, metadata);
assert.throws(
  () =>
    validateProvisioningCheckpoint(checkpoint, {
      ...metadata,
      chainId: 7333,
    }),
  /does not match the reviewed chain/u,
);

const noAdoptionEnvironment = validateProvisioningEnvironment({
  ...fixtureEnvironment,
  EXISTING_USDC_TOKEN_ADDRESS: "",
  EXISTING_USDC_TOKEN_NAME: "",
});
const versionTwoMetadata = provisioningMetadata(
  noAdoptionEnvironment.publicConfiguration,
  identity,
);
const versionOneBase = { ...versionTwoMetadata };
delete versionOneBase.configurationDigest;
delete versionOneBase.existingTokens;
versionOneBase.version = 1;
const versionOneCheckpoint = {
  ...versionOneBase,
  configurationDigest: keccak256(stringToHex(JSON.stringify(versionOneBase))),
  tokens: {
    USDC: {
      status: "confirmed",
      nonce: "7",
      expectedAddress: "0x8888888888888888888888888888888888888888",
      transactionHash: `0x${"88".repeat(32)}`,
      address: "0x8888888888888888888888888888888888888888",
      blockNumber: "102",
      blockHash: `0x${"99".repeat(32)}`,
      runtimeBytecodeHash: identity.runtimeBytecodeHash,
    },
    USDT: null,
  },
};
const upgraded = restoreProvisioningCheckpoint(
  versionOneCheckpoint,
  versionTwoMetadata,
);
assert.equal(upgraded.migrated, true);
assert.equal(upgraded.checkpoint.version, 2);
assert.equal(upgraded.checkpoint.tokens.USDC.origin, "deployed");
assert.equal(upgraded.checkpoint.tokens.USDT, null);
assert.throws(
  () => restoreProvisioningCheckpoint(versionOneCheckpoint, metadata),
  /cannot be combined with existing-token adoption/u,
);

const manifest = buildProvisioningManifest(metadata, checkpoint);
assert.equal(
  manifest.coreDeploymentEnvironment.SUPPORTED_TOKEN_ADDRESSES,
  "0x2222222222222222222222222222222222222222,0x5555555555555555555555555555555555555555",
);
assert.equal(
  manifest.coreDeploymentEnvironment.USDC_TOKEN_ADDRESS,
  manifest.tokens.USDC.address,
);
assert.equal(
  manifest.coreDeploymentEnvironment.USDT_TOKEN_ADDRESS,
  manifest.tokens.USDT.address,
);
assert.equal(manifest.tokens.USDC.mintPolicy, "permissionless-testnet-only");
assert.equal(manifest.tokens.USDC.name, "USD Coin");
assert.equal(manifest.tokens.USDC.provenance.type, "adopted-existing-contract");
assert.equal(manifest.tokens.USDT.provenance.type, "deployed-by-ceremony");
const serializedManifest = JSON.stringify(manifest);
assert.doesNotMatch(serializedManifest, /private-rpc/u);
assert.doesNotMatch(serializedManifest, /token-provisioner\.key/u);
assert.doesNotMatch(serializedManifest, /DEPLOYER_KEY|PRIVATE_KEY|RPC_URL/u);
assert.throws(
  () => assertSecretFreeManifest({ ...manifest, RPC_URL: "https://secret" }),
  /prohibited secret field/u,
);

const commandSource = readFileSync(
  join(repositoryRoot, "scripts", "provision-testnet-tokens.mjs"),
  "utf8",
);
for (const prohibitedMutation of [
  "setSupportedToken",
  "NOBLEPAY_ADDRESS",
  "approve(address",
  'functionName: "mint"',
]) {
  assert.equal(commandSource.includes(prohibitedMutation), false);
}
const tokenProvisioningMutation = commandSource.slice(
  commandSource.indexOf("async function provisionToken("),
  commandSource.indexOf("const lockFile ="),
);
assert.ok(
  tokenProvisioningMutation.indexOf("assertDistinctTokenAddress") <
    tokenProvisioningMutation.indexOf("walletClient.deployContract"),
  "symbol-address collisions must be rejected before a deployment is broadcast",
);
const verifyOnlyPath = commandSource.slice(
  commandSource.indexOf("if (verifyOnly)"),
  commandSource.indexOf(
    "const account = loadProvisionerAccount(configuration)",
  ),
);
assert.doesNotMatch(verifyOnlyPath, /deployContract|writeSecureJSONFile/u);
assert.doesNotMatch(verifyOnlyPath, /readProvisionerKey|privateKeyToAccount/u);
const networkIdentityPath = commandSource.slice(
  commandSource.indexOf("async function assertNetworkIdentity()"),
  commandSource.indexOf("async function verifyConfirmedToken("),
);
assert.match(networkIdentityPath, /address: metadata\.provisioner/u);
assert.doesNotMatch(networkIdentityPath, /account\.address/u);
const mockSource = readFileSync(
  join(repositoryRoot, "contracts", "src", "MockERC20.sol"),
  "utf8",
);
assert.match(
  mockSource,
  /function mint\(address to, uint256 amount\) external/u,
);

const runbook = readFileSync(
  join(repositoryRoot, "deploy", "PUBLIC_TESTNET_OPERATOR_RUNBOOK.md"),
  "utf8",
);
assert.match(runbook, /provision-testnet-tokens\.mjs/u);
assert.match(runbook, /permissionless(?:ly)?[\s\S]{0,80}test/iu);
assert.match(runbook, /SUPPORTED_TOKEN_ADDRESSES/u);
assert.match(
  runbook,
  /Do not restore or run the removed `scripts\/setup-test-token\.mjs`/u,
);

console.log("Testnet token provisioning policy and manifest tests passed.");
