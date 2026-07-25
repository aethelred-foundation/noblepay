export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const TEE_NODE_ACCOUNT_TYPE = "eoa";
export const CORE_CONTRACT_KEYS = [
  "registry",
  "gate",
  "noblePay",
  "paymentChannels",
];

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/u;
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/u;

const BLOCK_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;

export function normalizeBlockHash(value, label = "block hash") {
  if (typeof value !== "string" || !BLOCK_HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a 32-byte 0x-prefixed hash`);
  }
  return value.toLowerCase();
}

export function assertNetworkAnchorBlock({
  expectedBlockNumber,
  expectedBlockHash,
  block,
}) {
  const actualNumber = block?.number;
  const actualHash = block?.hash;
  if (
    actualNumber === null ||
    actualNumber === undefined ||
    BigInt(actualNumber) !== BigInt(expectedBlockNumber) ||
    typeof actualHash !== "string" ||
    normalizeBlockHash(actualHash, "RPC anchor block hash") !==
      normalizeBlockHash(expectedBlockHash, "AETHELRED_NETWORK_ANCHOR_HASH")
  ) {
    throw new Error(
      "RPC does not match the operator-confirmed immutable Aethelred network anchor",
    );
  }
}

export function assertExternallyOwnedAccountCode(
  code,
  label = "configured account",
) {
  if (code !== undefined && code !== "0x") {
    throw new Error(
      `${label} must be an EOA with no deployed bytecode; contract wallets are unsupported for direct compliance submissions`,
    );
  }
}

function equalAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

export function deploymentMode(argv) {
  const bootstrap = argv.includes("--bootstrap");
  const finalize = argv.includes("--finalize");
  if (bootstrap === finalize) {
    throw new Error(
      "select exactly one deployment phase: --bootstrap or --finalize",
    );
  }
  return bootstrap ? "bootstrap" : "finalize";
}

export function validateGovernanceSeparation({
  deployer,
  governance,
  treasuryManager,
  treasuryBeneficiary,
  businessVerifier,
  teeNode,
  complianceOfficer,
}) {
  const finalActors = [
    ["ADMIN_ADDRESS", governance],
    ["TREASURY_MANAGER_ADDRESS", treasuryManager],
    ["BUSINESS_VERIFIER_ADDRESS", businessVerifier],
    ["TEE_NODE_ADDRESS", teeNode],
    ["COMPLIANCE_OFFICER_ADDRESS", complianceOfficer],
  ];
  for (const [name, address] of finalActors) {
    if (equalAddress(address, deployer)) {
      throw new Error(`${name} must not equal DEPLOYER_ADDRESS`);
    }
  }
  if (equalAddress(treasuryManager, treasuryBeneficiary)) {
    throw new Error(
      "TREASURY_MANAGER_ADDRESS must be separate from fee-beneficiary TREASURY_ADDRESS",
    );
  }
}

export function validateDeploymentCheckpoint(
  checkpoint,
  {
    chainId,
    chainEnvironment,
    networkAnchorBlock,
    networkAnchorHash,
    configurationDigest,
    deployer,
    teeNodeAccountType,
    requireComplete = false,
  },
) {
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  ) {
    throw new Error("BOOTSTRAP_CHECKPOINT_JSON must be a JSON object");
  }
  if (checkpoint.version !== 1) {
    throw new Error("BOOTSTRAP_CHECKPOINT_JSON version must be 1");
  }
  const checkpointKeys = Object.keys(checkpoint);
  const expectedCheckpointKeys = [
    "version",
    "chainId",
    "chainEnvironment",
    "networkAnchorBlock",
    "networkAnchorHash",
    "configurationDigest",
    "deployer",
    "teeNodeAccountType",
    "contracts",
  ];
  if (
    checkpointKeys.length !== expectedCheckpointKeys.length ||
    checkpointKeys.some((key) => !expectedCheckpointKeys.includes(key))
  ) {
    throw new Error(
      "BOOTSTRAP_CHECKPOINT_JSON must contain exactly the documented checkpoint fields",
    );
  }
  if (
    checkpoint.chainId !== chainId ||
    checkpoint.chainEnvironment !== chainEnvironment ||
    checkpoint.networkAnchorBlock !== networkAnchorBlock ||
    checkpoint.networkAnchorHash?.toLowerCase() !==
      networkAnchorHash.toLowerCase() ||
    checkpoint.configurationDigest?.toLowerCase() !==
      configurationDigest.toLowerCase() ||
    !ADDRESS_PATTERN.test(checkpoint.deployer ?? "") ||
    !equalAddress(checkpoint.deployer, deployer) ||
    teeNodeAccountType !== TEE_NODE_ACCOUNT_TYPE ||
    checkpoint.teeNodeAccountType !== TEE_NODE_ACCOUNT_TYPE
  ) {
    throw new Error(
      "BOOTSTRAP_CHECKPOINT_JSON does not match the selected network anchor, deployer, or ceremony configuration",
    );
  }
  if (
    !checkpoint.contracts ||
    typeof checkpoint.contracts !== "object" ||
    Array.isArray(checkpoint.contracts)
  ) {
    throw new Error("BOOTSTRAP_CHECKPOINT_JSON contracts must be an object");
  }

  const contractKeys = Object.keys(checkpoint.contracts);
  if (
    contractKeys.length !== CORE_CONTRACT_KEYS.length ||
    contractKeys.some((key) => !CORE_CONTRACT_KEYS.includes(key))
  ) {
    throw new Error(
      "BOOTSTRAP_CHECKPOINT_JSON contracts must contain exactly the four core contract keys",
    );
  }

  const seenAddresses = new Set();
  const seenTransactions = new Set();
  let present = 0;
  let missingDeploymentSeen = false;
  for (const key of CORE_CONTRACT_KEYS) {
    const record = checkpoint.contracts[key];
    if (record === null) {
      missingDeploymentSeen = true;
      continue;
    }
    if (missingDeploymentSeen) {
      throw new Error(
        "BOOTSTRAP_CHECKPOINT_JSON core deployments must form a contiguous prefix",
      );
    }
    present += 1;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`BOOTSTRAP_CHECKPOINT_JSON ${key} record is invalid`);
    }
    if (
      !ADDRESS_PATTERN.test(record.address ?? "") ||
      !HASH_PATTERN.test(record.transactionHash ?? "") ||
      !HASH_PATTERN.test(record.blockHash ?? "") ||
      typeof record.blockNumber !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(record.blockNumber)
    ) {
      throw new Error(
        `BOOTSTRAP_CHECKPOINT_JSON ${key} deployment evidence is invalid`,
      );
    }
    const address = record.address.toLowerCase();
    const transactionHash = record.transactionHash.toLowerCase();
    if (seenAddresses.has(address) || seenTransactions.has(transactionHash)) {
      throw new Error(
        "BOOTSTRAP_CHECKPOINT_JSON contains duplicate deployment evidence",
      );
    }
    seenAddresses.add(address);
    seenTransactions.add(transactionHash);
  }
  if (requireComplete && present !== CORE_CONTRACT_KEYS.length) {
    throw new Error(
      "BOOTSTRAP_CHECKPOINT_JSON must contain all four core deployments for finalization",
    );
  }
  return checkpoint;
}

export function assertCheckpointDeploymentEvidence({
  key,
  record,
  expectedAddress,
  expectedDeployer,
  expectedInput,
  receipt,
  transaction,
  canonicalBlock,
  source = "RPC",
}) {
  const transactionHash = record.transactionHash.toLowerCase();
  const expectedBlockNumber = BigInt(record.blockNumber);
  const expectedBlockHash = normalizeBlockHash(
    record.blockHash,
    `${key} checkpoint block hash`,
  );
  if (
    !receipt ||
    receipt.status !== "success" ||
    !receipt.contractAddress ||
    receipt.to !== null ||
    !equalAddress(receipt.contractAddress, expectedAddress) ||
    receipt.transactionHash?.toLowerCase() !== transactionHash ||
    receipt.blockNumber !== expectedBlockNumber ||
    !receipt.blockHash ||
    normalizeBlockHash(receipt.blockHash, `${key} receipt block hash`) !==
      expectedBlockHash ||
    !receipt.from ||
    !equalAddress(receipt.from, expectedDeployer)
  ) {
    throw new Error(
      `${source} BOOTSTRAP_CHECKPOINT_JSON ${key} receipt does not prove the reviewed deployment`,
    );
  }
  if (
    !transaction ||
    transaction.hash?.toLowerCase() !== transactionHash ||
    transaction.to !== null ||
    !transaction.from ||
    !equalAddress(transaction.from, expectedDeployer) ||
    transaction.blockNumber !== expectedBlockNumber ||
    !transaction.blockHash ||
    normalizeBlockHash(
      transaction.blockHash,
      `${key} transaction block hash`,
    ) !== expectedBlockHash ||
    typeof transaction.input !== "string" ||
    transaction.input.toLowerCase() !== expectedInput.toLowerCase()
  ) {
    throw new Error(
      `${source} BOOTSTRAP_CHECKPOINT_JSON ${key} transaction does not match the reviewed creation bytecode and constructor arguments`,
    );
  }
  if (
    !canonicalBlock ||
    canonicalBlock.number !== expectedBlockNumber ||
    !canonicalBlock.hash ||
    normalizeBlockHash(canonicalBlock.hash, `${key} canonical block hash`) !==
      expectedBlockHash
  ) {
    throw new Error(
      `${source} BOOTSTRAP_CHECKPOINT_JSON ${key} deployment block is no longer canonical`,
    );
  }
}

export function assertCanonicalReleaseBlock({
  expectedBlockNumber,
  expectedBlockHash,
  block,
  source = "RPC",
}) {
  if (
    !block ||
    block.number === null ||
    block.number === undefined ||
    BigInt(block.number) !== BigInt(expectedBlockNumber) ||
    !block.hash ||
    normalizeBlockHash(block.hash, `${source} release block hash`) !==
      normalizeBlockHash(expectedBlockHash, "pinned release block hash")
  ) {
    throw new Error(
      `${source} release block is no longer canonical; refusing publication`,
    );
  }
}

export function assertGateOwnershipAccepted({
  owner,
  pendingOwner,
  governance,
}) {
  if (
    !equalAddress(owner, governance) ||
    !equalAddress(pendingOwner, ZERO_ADDRESS)
  ) {
    throw new Error(
      "SealSettlementGate governance has not accepted ownership; ADMIN_ADDRESS must call acceptOwnership before --finalize",
    );
  }
}

export function assertPublicationReady({
  gateOwnershipAccepted,
  finalRolesPresent,
  deployerRolesRemoved,
  configurationVerified,
  runtimeBytecodeVerified,
  publicCheckpointVerified,
  releaseSnapshotVerified,
}) {
  if (
    !gateOwnershipAccepted ||
    !finalRolesPresent ||
    !deployerRolesRemoved ||
    !configurationVerified ||
    !runtimeBytecodeVerified ||
    !publicCheckpointVerified ||
    !releaseSnapshotVerified
  ) {
    throw new Error(
      "deployment handoff is incomplete; refusing to publish a manifest or frontend environment",
    );
  }
}
