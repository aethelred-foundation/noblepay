#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ZERO_ADDRESS,
  CORE_CONTRACT_KEYS,
  TEE_NODE_ACCOUNT_TYPE,
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
  FINALIZED_ENVIRONMENT_KEYS,
  applyFinalizedEnvironment,
  applyFinalizedEnvironmentFile,
  assertNewSecureArtifactPath,
  cliPathOption,
  loadCheckpointArtifact,
  readSecureJSONFile,
  validateFinalizedEnvironment,
  writeSecureJSONFile,
} from "./lib/operator-artifacts.mjs";
import {
  TESTNET_HTTP_RPC_ACKNOWLEDGEMENT,
  validatePrivateRpcTransport,
} from "./lib/rpc-transport-policy.mjs";

const ANCHOR_HASH = `0x${"ab".repeat(32)}`;

const here = dirname(fileURLToPath(import.meta.url));
const deploymentSource = readFileSync(
  join(here, "deploy-devnet-core.mjs"),
  "utf8",
);
const governanceSource = readFileSync(
  join(here, "lib", "deployment-governance.mjs"),
  "utf8",
);
const coreRoleSources = [
  "BusinessRegistry.sol",
  "NoblePay.sol",
  "PaymentChannels.sol",
].map((name) =>
  readFileSync(join(here, "..", "contracts", "src", name), "utf8"),
);

const addresses = {
  deployer: "0x1111111111111111111111111111111111111111",
  governance: "0x2222222222222222222222222222222222222222",
  treasuryManager: "0x3333333333333333333333333333333333333333",
  treasuryBeneficiary: "0x4444444444444444444444444444444444444444",
  businessVerifier: "0x5555555555555555555555555555555555555555",
  teeNode: "0x6666666666666666666666666666666666666666",
  complianceOfficer: "0x7777777777777777777777777777777777777777",
};

const operatorArtifactDirectory = mkdtempSync(
  join(tmpdir(), "noblepay-operator-artifacts-"),
);
try {
  const checkpointPath = join(operatorArtifactDirectory, "checkpoint.json");
  const manifestPath = join(operatorArtifactDirectory, "manifest.json");
  const environmentPath = join(operatorArtifactDirectory, "production.env");
  const checkpointFixture = {
    version: 1,
    chainId: 7332,
    contracts: {},
  };

  assert.equal(
    cliPathOption(
      ["node", "script", "--checkpoint-file", checkpointPath],
      "--checkpoint-file",
      { required: true },
    ),
    checkpointPath,
  );
  assert.equal(
    cliPathOption(
      ["node", "script", `--manifest-file=${manifestPath}`],
      "--manifest-file",
      { required: true },
    ),
    manifestPath,
  );
  assert.throws(
    () =>
      cliPathOption(
        ["node", "script", "--checkpoint-file", "relative.json"],
        "--checkpoint-file",
      ),
    /absolute path/u,
  );
  assert.throws(
    () =>
      cliPathOption(
        [
          "node",
          "script",
          "--checkpoint-file",
          checkpointPath,
          `--checkpoint-file=${checkpointPath}`,
        ],
        "--checkpoint-file",
      ),
    /at most once/u,
  );

  assertNewSecureArtifactPath(checkpointPath, "checkpoint file");
  writeSecureJSONFile(checkpointPath, checkpointFixture, "checkpoint file");
  assert.equal(lstatSync(checkpointPath).mode & 0o077, 0);
  assert.deepEqual(
    readSecureJSONFile(checkpointPath, "checkpoint file"),
    checkpointFixture,
  );
  assert.deepEqual(
    loadCheckpointArtifact({
      checkpointFile: checkpointPath,
      environmentValue: JSON.stringify(checkpointFixture),
    }),
    checkpointFixture,
  );
  assert.throws(
    () =>
      loadCheckpointArtifact({
        checkpointFile: checkpointPath,
        environmentValue: JSON.stringify({
          ...checkpointFixture,
          chainId: 7333,
        }),
      }),
    /different ceremony state/u,
  );
  assert.throws(
    () => assertNewSecureArtifactPath(checkpointPath, "checkpoint file"),
    /already exists/u,
  );
  const insecureDirectory = join(operatorArtifactDirectory, "insecure");
  mkdirSync(insecureDirectory, { mode: 0o777 });
  chmodSync(insecureDirectory, 0o777);
  assert.throws(
    () =>
      writeSecureJSONFile(
        join(insecureDirectory, "checkpoint.json"),
        checkpointFixture,
        "checkpoint file",
      ),
    /parent must not grant group or other permissions/u,
  );

  const releaseEnvironment = Object.fromEntries(
    FINALIZED_ENVIRONMENT_KEYS.map((key) => [key, `value-for-${key}`]),
  );
  validateFinalizedEnvironment(releaseEnvironment);
  assert.throws(
    () =>
      validateFinalizedEnvironment({
        ...releaseEnvironment,
        UNREVIEWED_VALUE: "true",
      }),
    /exact release-derived keys/u,
  );
  for (const unsafeValue of [
    "value\nINJECTED=true",
    "value # hidden",
    "${UNREVIEWED_VALUE}",
    " leading-space",
    '"quoted-value"',
  ]) {
    assert.throws(
      () =>
        validateFinalizedEnvironment({
          ...releaseEnvironment,
          PUBLIC_ORIGIN: unsafeValue,
        }),
      /safe unquoted environment value/u,
    );
  }
  const environmentTemplate = `${FINALIZED_ENVIRONMENT_KEYS.map(
    (key) => `${key}=replace-me`,
  ).join("\n")}\nSECRET_VALUE=preserve-me\n`;
  const applied = applyFinalizedEnvironment(
    environmentTemplate,
    releaseEnvironment,
  );
  assert.match(applied, /PUBLIC_ORIGIN=value-for-PUBLIC_ORIGIN/u);
  assert.match(applied, /SECRET_VALUE=preserve-me/u);

  writeFileSync(environmentPath, environmentTemplate, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(environmentPath, 0o600);
  applyFinalizedEnvironmentFile(environmentPath, releaseEnvironment);
  assert.equal(lstatSync(environmentPath).mode & 0o077, 0);
  assert.match(
    readFileSync(environmentPath, "utf8"),
    /INDEXER_START_BLOCK=value-for-INDEXER_START_BLOCK/u,
  );
} finally {
  rmSync(operatorArtifactDirectory, { recursive: true, force: true });
}

assert.equal(deploymentMode(["node", "script", "--bootstrap"]), "bootstrap");
assert.equal(deploymentMode(["node", "script", "--finalize"]), "finalize");
assert.throws(() => deploymentMode(["node", "script"]), /exactly one/u);
assert.throws(
  () => deploymentMode(["node", "script", "--bootstrap", "--finalize"]),
  /exactly one/u,
);

assert.equal(
  validatePrivateRpcTransport({
    chainEnvironment: "testnet",
    rpcUrl: "https://private-rpc.example.test",
  }).transportSecurity,
  "tls",
);
assert.throws(
  () =>
    validatePrivateRpcTransport({
      chainEnvironment: "testnet",
      rpcUrl: "http://54.165.44.130:8545",
    }),
  /plaintext testnet RPC is evaluation-only/u,
);
assert.equal(
  validatePrivateRpcTransport({
    chainEnvironment: "testnet",
    rpcUrl: "http://54.165.44.130:8545",
    insecureTestnetAcknowledgement: TESTNET_HTTP_RPC_ACKNOWLEDGEMENT,
  }).transportSecurity,
  "plaintext-evaluation",
);
assert.throws(
  () =>
    validatePrivateRpcTransport({
      chainEnvironment: "mainnet",
      rpcUrl: "http://54.165.44.130:8545",
      insecureTestnetAcknowledgement: TESTNET_HTTP_RPC_ACKNOWLEDGEMENT,
    }),
  /mainnet deployments require an HTTPS RPC_URL/u,
);

const checkpointMetadata = {
  chainId: 7332,
  chainEnvironment: "testnet",
  networkAnchorBlock: "1",
  networkAnchorHash: `0x${"ab".repeat(32)}`,
  configurationDigest: `0x${"ef".repeat(32)}`,
  deployer: addresses.deployer,
  teeNodeAccountType: TEE_NODE_ACCOUNT_TYPE,
};
const deploymentRecord = (index) => ({
  address: `0x${index.toString(16).padStart(40, "0")}`,
  transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
  blockNumber: String(index),
  blockHash: `0x${(index + 10).toString(16).padStart(64, "0")}`,
});
const partialCheckpoint = {
  version: 1,
  ...checkpointMetadata,
  contracts: {
    registry: deploymentRecord(1),
    gate: null,
    noblePay: null,
    paymentChannels: null,
  },
};
assert.equal(
  validateDeploymentCheckpoint(partialCheckpoint, checkpointMetadata),
  partialCheckpoint,
);
assert.throws(
  () =>
    validateDeploymentCheckpoint(partialCheckpoint, {
      ...checkpointMetadata,
      requireComplete: true,
    }),
  /all four core deployments/u,
);
const completeCheckpoint = {
  ...partialCheckpoint,
  contracts: Object.fromEntries(
    CORE_CONTRACT_KEYS.map((key, index) => [key, deploymentRecord(index + 1)]),
  ),
};
assert.equal(
  validateDeploymentCheckpoint(completeCheckpoint, {
    ...checkpointMetadata,
    requireComplete: true,
  }),
  completeCheckpoint,
);
for (const mismatch of [
  { chainId: 7331 },
  { networkAnchorHash: `0x${"cd".repeat(32)}` },
  { configurationDigest: `0x${"de".repeat(32)}` },
  { deployer: addresses.governance },
  { teeNodeAccountType: "contract" },
]) {
  assert.throws(
    () =>
      validateDeploymentCheckpoint(completeCheckpoint, {
        ...checkpointMetadata,
        ...mismatch,
      }),
    /does not match/u,
  );
}
assert.throws(
  () =>
    validateDeploymentCheckpoint(
      {
        ...completeCheckpoint,
        contracts: {
          ...completeCheckpoint.contracts,
          gate: completeCheckpoint.contracts.registry,
        },
      },
      checkpointMetadata,
    ),
  /duplicate deployment evidence/u,
);
assert.throws(
  () =>
    validateDeploymentCheckpoint(
      { ...completeCheckpoint, unreviewed: true },
      checkpointMetadata,
    ),
  /exactly the documented checkpoint fields/u,
);
assert.throws(
  () =>
    validateDeploymentCheckpoint(
      {
        ...partialCheckpoint,
        contracts: {
          registry: null,
          gate: deploymentRecord(2),
          noblePay: null,
          paymentChannels: null,
        },
      },
      checkpointMetadata,
    ),
  /contiguous prefix/u,
);
assert.throws(
  () =>
    validateDeploymentCheckpoint(
      {
        ...partialCheckpoint,
        contracts: {
          ...partialCheckpoint.contracts,
          unexpected: null,
        },
      },
      checkpointMetadata,
    ),
  /exactly the four core contract keys/u,
);

const reviewedRecord = deploymentRecord(1);
const reviewedCreationInput = "0x6001600055";
const reviewedReceipt = {
  status: "success",
  contractAddress: reviewedRecord.address,
  to: null,
  transactionHash: reviewedRecord.transactionHash,
  blockNumber: BigInt(reviewedRecord.blockNumber),
  blockHash: reviewedRecord.blockHash,
  from: addresses.deployer,
};
const reviewedTransaction = {
  hash: reviewedRecord.transactionHash,
  to: null,
  from: addresses.deployer,
  blockNumber: BigInt(reviewedRecord.blockNumber),
  blockHash: reviewedRecord.blockHash,
  input: reviewedCreationInput,
};
const reviewedCanonicalBlock = {
  number: BigInt(reviewedRecord.blockNumber),
  hash: reviewedRecord.blockHash,
};
const checkpointEvidence = {
  key: "registry",
  record: reviewedRecord,
  expectedAddress: reviewedRecord.address,
  expectedDeployer: addresses.deployer,
  expectedInput: reviewedCreationInput,
  receipt: reviewedReceipt,
  transaction: reviewedTransaction,
  canonicalBlock: reviewedCanonicalBlock,
  source: "public frontend RPC",
};
assert.doesNotThrow(() =>
  assertCheckpointDeploymentEvidence(checkpointEvidence),
);
assert.throws(
  () =>
    assertCheckpointDeploymentEvidence({
      ...checkpointEvidence,
      receipt: undefined,
    }),
  /public frontend RPC.*receipt does not prove/u,
  "a public RPC that cannot return the deployment receipt cannot authorize publication",
);
assert.throws(
  () =>
    assertCheckpointDeploymentEvidence({
      ...checkpointEvidence,
      transaction: {
        ...reviewedTransaction,
        input: "0x6002600055",
      },
    }),
  /public frontend RPC.*creation bytecode/u,
  "a public RPC that reports a different deployment cannot authorize publication",
);
assert.throws(
  () =>
    assertCheckpointDeploymentEvidence({
      ...checkpointEvidence,
      canonicalBlock: {
        ...reviewedCanonicalBlock,
        hash: `0x${"cd".repeat(32)}`,
      },
    }),
  /public frontend RPC.*no longer canonical/u,
);

assert.equal(
  normalizeBlockHash(ANCHOR_HASH.toUpperCase().replace("0X", "0x")),
  ANCHOR_HASH,
);
assert.throws(() => normalizeBlockHash("0x1234"), /32-byte/u);
assert.doesNotThrow(() =>
  assertExternallyOwnedAccountCode(undefined, "TEE_NODE_ADDRESS"),
);
assert.doesNotThrow(() =>
  assertExternallyOwnedAccountCode("0x", "TEE_NODE_ADDRESS"),
);
assert.throws(
  () => assertExternallyOwnedAccountCode("0x6000", "TEE_NODE_ADDRESS"),
  /must be an EOA/u,
);
assertNetworkAnchorBlock({
  expectedBlockNumber: 42n,
  expectedBlockHash: ANCHOR_HASH,
  block: { number: 42n, hash: ANCHOR_HASH.toUpperCase().replace("0X", "0x") },
});
assert.throws(
  () =>
    assertNetworkAnchorBlock({
      expectedBlockNumber: 42n,
      expectedBlockHash: ANCHOR_HASH,
      block: { number: 42n, hash: `0x${"cd".repeat(32)}` },
    }),
  /operator-confirmed immutable/u,
);
assertCanonicalReleaseBlock({
  expectedBlockNumber: 84n,
  expectedBlockHash: ANCHOR_HASH,
  block: { number: 84n, hash: ANCHOR_HASH },
  source: "public frontend RPC",
});
assert.throws(
  () =>
    assertCanonicalReleaseBlock({
      expectedBlockNumber: 84n,
      expectedBlockHash: ANCHOR_HASH,
      block: { number: 84n, hash: `0x${"cd".repeat(32)}` },
      source: "public frontend RPC",
    }),
  /release block is no longer canonical; refusing publication/u,
  "a late release-block reorg must prevent publication",
);
assert.throws(
  () =>
    assertNetworkAnchorBlock({
      expectedBlockNumber: 42n,
      expectedBlockHash: ANCHOR_HASH,
      block: null,
    }),
  /operator-confirmed immutable/u,
);

validateGovernanceSeparation(addresses);
for (const actor of [
  "governance",
  "treasuryManager",
  "businessVerifier",
  "teeNode",
  "complianceOfficer",
]) {
  assert.throws(
    () =>
      validateGovernanceSeparation({
        ...addresses,
        [actor]: addresses.deployer,
      }),
    /must not equal DEPLOYER_ADDRESS/u,
  );
}
assert.throws(
  () =>
    validateGovernanceSeparation({
      ...addresses,
      treasuryManager: addresses.treasuryBeneficiary,
    }),
  /separate from fee-beneficiary/u,
);

assertGateOwnershipAccepted({
  owner: addresses.governance,
  pendingOwner: ZERO_ADDRESS,
  governance: addresses.governance,
});
assert.throws(
  () =>
    assertGateOwnershipAccepted({
      owner: addresses.deployer,
      pendingOwner: addresses.governance,
      governance: addresses.governance,
    }),
  /acceptOwnership/u,
);
assert.throws(
  () =>
    assertGateOwnershipAccepted({
      owner: addresses.governance,
      pendingOwner: addresses.teeNode,
      governance: addresses.governance,
    }),
  /acceptOwnership/u,
);

const releaseChecks = {
  gateOwnershipAccepted: true,
  finalRolesPresent: true,
  deployerRolesRemoved: true,
  configurationVerified: true,
  runtimeBytecodeVerified: true,
  publicCheckpointVerified: true,
  releaseSnapshotVerified: true,
};
assertPublicationReady(releaseChecks);
for (const check of Object.keys(releaseChecks)) {
  assert.throws(
    () => assertPublicationReady({ ...releaseChecks, [check]: false }),
    /refusing to publish/u,
  );
}

assert.match(deploymentSource, /configureBusinessRegistry/u);
assert.ok(
  deploymentSource.indexOf('process.argv.includes("--verify-artifacts")') <
    deploymentSource.indexOf('await import("viem")'),
  "artifact-only verification must exit before loading deployment dependencies",
);
for (const source of coreRoleSources) {
  assert.match(
    source,
    /AccessControlEnumerable/u,
    "core role-bearing contracts must expose enumerable membership",
  );
}
assert.match(deploymentSource, /getRoleMemberCount/u);
assert.match(deploymentSource, /getRoleMember/u);
assert.match(deploymentSource, /AETHELRED_NETWORK_ANCHOR_BLOCK/u);
assert.match(deploymentSource, /AETHELRED_NETWORK_ANCHOR_HASH/u);
assert.match(deploymentSource, /BOOTSTRAP_CHECKPOINT_JSON/u);
assert.match(deploymentSource, /CONFIGURATION_DIGEST/u);
assert.match(deploymentSource, /teeNodeAccountType: TEE_NODE_ACCOUNT_TYPE/u);
assert.match(deploymentSource, /assertTeeNodeAccountType/u);
assert.match(
  deploymentSource,
  /getBytecode\(\{\s*address: TEE_NODE,\s*blockNumber/u,
);
assert.match(
  deploymentSource,
  /startBlock: DEPLOYMENT_CHECKPOINT[.]contracts[.]noblePay[.]blockNumber/u,
);
assert.match(deploymentSource, /INDEXER_START_BLOCK:/u);
assert.match(deploymentSource, /applicationEnvironment/u);
assert.match(deploymentSource, /writeSecureJSONFile/u);
assert.match(deploymentSource, /persistDeploymentCheckpoint/u);
assert.match(
  deploymentSource,
  /testnet and mainnet ceremonies require --checkpoint-file/u,
);
assert.match(
  deploymentSource,
  /testnet and mainnet finalization requires --manifest-file/u,
);
assert.match(deploymentSource, /ALLOW_INSECURE_TESTNET_RPC/u);
assert.match(deploymentSource, /plaintextRpcWarning/u);
assert.match(
  deploymentSource,
  /publicRpcURL\("PUBLIC_AETHELRED_RPC_URL", CHAIN_ENV\)/u,
  "finalization must apply the bounded testnet RPC policy to the public RPC",
);
assert.match(
  deploymentSource,
  /publicURL\("PUBLIC_AETHELRED_WS_URL", "wss:"\)/u,
  "finalization must not invent a plaintext EVM WebSocket endpoint",
);
assert.match(
  deploymentSource,
  /WALLETCONNECT_PROJECT_ID must be a 32-character hexadecimal project id/u,
);
assert.match(
  deploymentSource,
  /FRONTEND_APP_VERSION has an invalid release identifier/u,
);
assert.match(deploymentSource, /getTransactionReceipt/u);
assert.match(deploymentSource, /getTransaction/u);
assert.match(deploymentSource, /encodeDeployData/u);
assert.match(governanceSource, /transaction[.]input[.]toLowerCase/u);
assert.match(deploymentSource, /getContractEvents/u);
assert.match(deploymentSource, /enabled-token event history/u);
const checkpointVerifier = deploymentSource.slice(
  deploymentSource.indexOf("async function verifyCheckpointRecord("),
  deploymentSource.indexOf("async function verifyCheckpointRecords("),
);
for (const clientBoundProof of [
  /client[.]getTransactionReceipt/u,
  /client[.]getTransaction/u,
  /client[.]getBlock/u,
  /assertReviewedRuntime\(client,/u,
]) {
  assert.match(
    checkpointVerifier,
    clientBoundProof,
    "checkpoint evidence must be verified against the client being attested",
  );
}
assert.doesNotMatch(deploymentSource, /HANDOFF_BUSINESS_REGISTRY_ADDRESS/u);
assert.match(
  deploymentSource,
  /const anchorBlock = await client[.]getBlock\(\{\s*blockNumber: NETWORK_ANCHOR_BLOCK/u,
);
assert.match(
  deploymentSource,
  /frontendPublicClient[.]getBlock\(\{\s*blockNumber: NETWORK_ANCHOR_BLOCK/u,
  "finalization must verify the browser-facing public RPC anchor",
);
const deployMutation = deploymentSource.slice(
  deploymentSource.indexOf("async function deploy("),
  deploymentSource.indexOf("async function write("),
);
assert.ok(
  deployMutation.indexOf("verifyPrivateNetworkIdentity()") <
    deployMutation.indexOf("walletClient.deployContract"),
  "contract creation must recheck the private RPC identity immediately before mutation",
);
const writeMutation = deploymentSource.slice(
  deploymentSource.indexOf("async function write("),
  deploymentSource.indexOf("async function assertCode("),
);
assert.ok(
  writeMutation.indexOf("verifyPrivateNetworkIdentity()") <
    writeMutation.indexOf("walletClient.writeContract"),
  "configuration and role writes must recheck the private RPC identity immediately before mutation",
);
const receiptVerification = deploymentSource.slice(
  deploymentSource.indexOf("async function receipt("),
  deploymentSource.indexOf("async function deploy("),
);
assert.match(
  receiptVerification,
  /verifyPrivateNetworkIdentity/u,
  "every confirmed mutation must recheck the private RPC identity",
);
assert.ok(
  deploymentSource.indexOf("assertNetworkAnchorBlock({") <
    deploymentSource.indexOf("await verifyExternalDependencies()"),
  "network anchor must be verified before either deployment phase mutates or publishes",
);
assert.match(
  deploymentSource,
  /assertCode\(ADMIN, "final governance multisig"\)/u,
  "testnet/mainnet governance must be a deployed contract",
);
assert.match(
  deploymentSource,
  /core deployment is paused; refusing release publication/u,
  "final publication must reject a paused core contract",
);
assert.doesNotMatch(
  deploymentSource,
  /(?:batchSetKYCStatus|PAYMENT_CHANNEL_KYC_ADDRESSES)/u,
);
for (const role of [
  "BusinessRegistry DEFAULT_ADMIN_ROLE",
  "BusinessRegistry ADMIN_ROLE",
  "BusinessRegistry VERIFIER_ROLE",
  "NoblePay DEFAULT_ADMIN_ROLE",
  "NoblePay ADMIN_ROLE",
  "NoblePay TREASURY_ROLE",
  "NoblePay TEE_NODE_ROLE",
  "NoblePay COMPLIANCE_OFFICER_ROLE",
  "PaymentChannels DEFAULT_ADMIN_ROLE",
  "PaymentChannels ADMIN_ROLE",
  "PaymentChannels TREASURY_ROLE",
]) {
  assert.ok(
    deploymentSource.includes(role),
    `missing final role check: ${role}`,
  );
}
assert.equal(
  (deploymentSource.match(/DEPLOYMENT_MANIFEST_JSON=/gu) ?? []).length,
  1,
);
assert.ok(
  deploymentSource.indexOf("assertPublicationReady({") <
    deploymentSource.indexOf("DEPLOYMENT_MANIFEST_JSON="),
);
const publicationSection = deploymentSource.slice(
  deploymentSource.indexOf("const releaseBlock = await"),
  deploymentSource.indexOf("DEPLOYMENT_MANIFEST_JSON="),
);
assert.match(
  publicationSection,
  /verifyCheckpointRecords\(\s*frontendPublicClient,\s*"public frontend RPC",\s*DEPLOYMENT_CHECKPOINT,\s*releaseBlock[.]number/u,
  "the browser-facing RPC must prove every checkpoint deployment at the release snapshot",
);
assert.match(
  publicationSection,
  /client: frontendPublicClient,\s*source: "public frontend RPC",\s*releaseBlock/u,
  "the browser-facing RPC must prove final roles, configuration, runtime, and token history at the release snapshot",
);
assert.ok(
  publicationSection.indexOf("assertPublicationReady({") <
    publicationSection.indexOf("await verifyReleasePublicationBoundary"),
  "publication readiness must be established before the final release-hash boundary",
);
assert.ok(
  publicationSection.indexOf("await verifyReleasePublicationBoundary") <
    publicationSection.indexOf("const manifest ="),
  "both RPCs must recheck the pinned release hash immediately before manifest construction",
);
assert.match(publicationSection, /releaseBlock: \{/u);
assert.match(deploymentSource, /toBlock: blockNumber/u);
assert.match(deploymentSource, /blockNumber: snapshot[.]number/u);
const releaseStateVerifier = deploymentSource.slice(
  deploymentSource.indexOf("async function verifyDeploymentState("),
  deploymentSource.indexOf("async function bootstrap("),
);
assert.doesNotMatch(
  releaseStateVerifier,
  /publicClient[.](?:readContract|getContractEvents|getBytecode)/u,
  "release state verification must never escape its parameterized RPC client",
);
assert.match(
  releaseStateVerifier,
  /assertReleaseBlockOnClient\(client, source, snapshot\)/u,
  "the pinned release hash must be rechecked after all snapshot reads",
);

const removalPlan = deploymentSource.slice(
  deploymentSource.indexOf("function deployerRoleAssignments"),
  deploymentSource.indexOf("async function hasRole"),
);
const verifierRemoval = removalPlan.indexOf(
  'label: "deployer BusinessRegistry VERIFIER_ROLE"',
);
const treasuryRemoval = removalPlan.indexOf(
  'label: "deployer NoblePay TREASURY_ROLE"',
);
const channelsTreasuryRemoval = removalPlan.indexOf(
  'label: "deployer PaymentChannels TREASURY_ROLE"',
);
const adminRemoval = removalPlan.indexOf(
  'label: "deployer BusinessRegistry ADMIN_ROLE"',
);
for (const privilegedRole of [
  "deployer NoblePay TEE_NODE_ROLE",
  "deployer NoblePay COMPLIANCE_OFFICER_ROLE",
]) {
  assert.ok(
    removalPlan.includes(`label: "${privilegedRole}"`),
    `deployer role-removal plan omits ${privilegedRole}`,
  );
}
const defaultAdminRemoval = removalPlan.indexOf(
  'label: "deployer BusinessRegistry DEFAULT_ADMIN_ROLE"',
);
assert.ok(
  verifierRemoval >= 0 &&
    verifierRemoval < treasuryRemoval &&
    treasuryRemoval < channelsTreasuryRemoval &&
    channelsTreasuryRemoval < adminRemoval &&
    adminRemoval < defaultAdminRemoval,
  "deployer role-removal plan must put operational/admin roles before default admin",
);
assert.doesNotMatch(
  deploymentSource,
  /(?:PAYMENT_CHANNEL_ROUTER|ROUTER_ROLE)/u,
  "removed metadata-only channel routing must not be provisioned",
);

console.log("Deployment governance handoff invariants verified.");
