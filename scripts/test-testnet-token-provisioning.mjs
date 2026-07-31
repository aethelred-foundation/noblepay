#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TESTNET_TOKEN_SPECS,
  TOKEN_PROVISIONING_CONFIRMATION,
  artifactIdentity,
  assertSecretFreeManifest,
  buildProvisioningManifest,
  createProvisioningCheckpoint,
  provisioningMetadata,
  validateProvisioningCheckpoint,
  validateProvisioningEnvironment,
} from "./lib/testnet-token-provisioning.mjs";

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
      RPC_URL: "http://127.0.0.1:8545",
    }),
  /requires an HTTPS RPC_URL/u,
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
  status: "prepared",
  nonce: "7",
  expectedAddress: "0x2222222222222222222222222222222222222222",
};
validateProvisioningCheckpoint(checkpoint, metadata);
checkpoint.tokens.USDC = {
  ...checkpoint.tokens.USDC,
  status: "broadcast",
  transactionHash: `0x${"33".repeat(32)}`,
};
validateProvisioningCheckpoint(checkpoint, metadata);
checkpoint.tokens.USDC = {
  ...checkpoint.tokens.USDC,
  status: "confirmed",
  address: "0x2222222222222222222222222222222222222222",
  blockNumber: "100",
  blockHash: `0x${"44".repeat(32)}`,
  runtimeBytecodeHash: identity.runtimeBytecodeHash,
};
checkpoint.tokens.USDT = {
  status: "confirmed",
  nonce: "8",
  expectedAddress: "0x5555555555555555555555555555555555555555",
  transactionHash: `0x${"66".repeat(32)}`,
  address: "0x5555555555555555555555555555555555555555",
  blockNumber: "101",
  blockHash: `0x${"77".repeat(32)}`,
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
assert.match(runbook, /permissionless.*testnet/iu);
assert.match(runbook, /SUPPORTED_TOKEN_ADDRESSES/u);
assert.match(
  runbook,
  /Do not restore or run the removed `scripts\/setup-test-token\.mjs`/u,
);

console.log("Testnet token provisioning policy and manifest tests passed.");
