#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  getContractAddress,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  assertNewSecureArtifactPath,
  cliPathOption,
  readSecureJSONFile,
  writeSecureJSONFile,
} from "./lib/operator-artifacts.mjs";
import {
  TESTNET_TOKEN_SPECS,
  artifactIdentity,
  buildProvisioningManifest,
  createProvisioningCheckpoint,
  provisioningMetadata,
  restoreProvisioningCheckpoint,
  validateProvisioningEnvironment,
} from "./lib/testnet-token-provisioning.mjs";
import { plaintextRpcWarning } from "./lib/rpc-transport-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = realpathSync(join(here, ".."));
const contractsRoot = join(repositoryRoot, "contracts");
const artifactPath = join(
  contractsRoot,
  "artifacts",
  "src",
  "MockERC20.sol",
  "MockERC20.json",
);
const sourcePath = join(contractsRoot, "src", "MockERC20.sol");
const buildInfoDirectory = join(contractsRoot, "artifacts", "build-info");

function booleanFlag(argv, name) {
  const count = argv.slice(2).filter((argument) => argument === name).length;
  if (count > 1) throw new Error(`${name} must be provided at most once`);
  return count === 1;
}

function assertKnownArguments(argv) {
  const valueOptions = new Set(["--checkpoint-file", "--manifest-file"]);
  const flags = new Set(["--validate-only", "--verify-only"]);
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flags.has(argument)) continue;
    if (valueOptions.has(argument)) {
      index += 1;
      continue;
    }
    if ([...valueOptions].some((option) => argument.startsWith(`${option}=`))) {
      continue;
    }
    throw new Error(`unsupported argument: ${argument}`);
  }
}

function readProvisionerKey(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      "TOKEN_PROVISIONER_KEY_FILE must be a regular file, not a symlink",
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      "TOKEN_PROVISIONER_KEY_FILE must not grant group or other permissions",
    );
  }
  if (stat.size > 256) {
    throw new Error("TOKEN_PROVISIONER_KEY_FILE is unexpectedly large");
  }
  const value = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(
      "TOKEN_PROVISIONER_KEY_FILE must contain one 0x-prefixed private key",
    );
  }
  return value;
}

function loadProvisionerAccount(configuration) {
  const provisionerKey = readProvisionerKey(configuration.keyFile);
  const account = privateKeyToAccount(provisionerKey);
  if (
    !sameAddress(account.address, configuration.publicConfiguration.provisioner)
  ) {
    throw new Error(
      "TOKEN_PROVISIONER_KEY_FILE does not match TOKEN_PROVISIONER_ADDRESS",
    );
  }
  return account;
}

function assertImmutableSource(expectedCommit) {
  const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .trim()
    .toLowerCase();
  if (currentCommit !== expectedCommit) {
    throw new Error(
      `immutable source mismatch: expected ${expectedCommit}, checked out ${currentCommit}`,
    );
  }
  const changes = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  ).trim();
  if (changes) {
    throw new Error(
      "source checkout contains modified or untracked files; token provisioning is blocked",
    );
  }
}

function loadReviewedMockArtifact() {
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch {
    throw new Error(
      "MockERC20 artifact is unavailable; run the documented clean Hardhat compile",
    );
  }
  const identity = artifactIdentity(artifact);
  const source = readFileSync(sourcePath, "utf8");
  let compilerVersion = null;

  for (const entry of readdirSync(buildInfoDirectory)) {
    if (!entry.endsWith(".json")) continue;
    let buildInfo;
    try {
      buildInfo = JSON.parse(
        readFileSync(join(buildInfoDirectory, entry), "utf8"),
      );
    } catch {
      continue;
    }
    const compiled =
      buildInfo.output?.contracts?.["src/MockERC20.sol"]?.MockERC20;
    const compiledSource = buildInfo.input?.sources?.["src/MockERC20.sol"];
    const settings = buildInfo.input?.settings;
    if (
      !compiled ||
      compiledSource?.content !== source ||
      buildInfo.solcVersion !== "0.8.19" ||
      settings?.optimizer?.enabled !== true ||
      settings?.optimizer?.runs !== 200 ||
      settings?.viaIR !== true
    ) {
      continue;
    }
    const compiledBytecode = `0x${compiled.evm?.bytecode?.object ?? ""}`;
    const compiledRuntime = `0x${compiled.evm?.deployedBytecode?.object ?? ""}`;
    if (
      artifact.bytecode !== compiledBytecode ||
      artifact.deployedBytecode !== compiledRuntime ||
      !isDeepStrictEqual(artifact.abi, compiled.abi)
    ) {
      continue;
    }
    compilerVersion =
      buildInfo.solcLongVersion ?? buildInfo.solcVersion ?? null;
    break;
  }

  if (!compilerVersion) {
    throw new Error(
      "MockERC20 artifact does not match reviewed source and Hardhat build information; run a clean compile",
    );
  }
  return {
    artifact,
    identity: {
      ...identity,
      compilerVersion,
    },
  };
}

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function normalizeHash(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value ?? "")) {
    throw new Error(`${label} is not a 32-byte transaction or block hash`);
  }
  return value.toLowerCase();
}

assertKnownArguments(process.argv);
const validateOnly = booleanFlag(process.argv, "--validate-only");
const verifyOnly = booleanFlag(process.argv, "--verify-only");
if (validateOnly && verifyOnly) {
  throw new Error("select at most one of --validate-only and --verify-only");
}
const checkpointFile = cliPathOption(process.argv, "--checkpoint-file", {
  required: true,
});
const manifestFile = cliPathOption(process.argv, "--manifest-file", {
  required: true,
});
if (checkpointFile === manifestFile) {
  throw new Error("--checkpoint-file and --manifest-file must be different");
}
const configuration = validateProvisioningEnvironment(process.env, {
  validateOnly: validateOnly || verifyOnly,
  requireKeyFile: !verifyOnly,
});
if (configuration.rpcTransportSecurity === "plaintext-evaluation") {
  console.warn(plaintextRpcWarning());
}
assertImmutableSource(configuration.publicConfiguration.sourceCommit);
if (process.versions.node !== "24.18.0") {
  throw new Error(
    `Node 24.18.0 is required for token provisioning; found ${process.version}`,
  );
}

const { artifact, identity } = loadReviewedMockArtifact();
const metadata = provisioningMetadata(
  configuration.publicConfiguration,
  identity,
);
const restoredCheckpoint = readSecureJSONFile(
  checkpointFile,
  "token provisioning checkpoint",
  { allowMissing: true },
);
const restored = restoredCheckpoint
  ? restoreProvisioningCheckpoint(restoredCheckpoint, metadata)
  : null;
const checkpoint =
  restored?.checkpoint ?? createProvisioningCheckpoint(metadata);
assertNewSecureArtifactPath(manifestFile, "testnet token manifest");

if (validateOnly) {
  loadProvisionerAccount(configuration);
  console.log(
    "Token-provisioning validation passed without connecting to RPC.",
  );
  console.log(`  chain environment: ${metadata.chainEnvironment}`);
  console.log(`  expected chain ID: ${metadata.chainId}`);
  console.log(
    `  network anchor: ${metadata.networkAnchor.blockNumber} / ${metadata.networkAnchor.blockHash}`,
  );
  console.log(`  source commit: ${metadata.sourceCommit}`);
  console.log(
    `  checkpoint state: USDC=${checkpoint.tokens.USDC?.status ?? "absent"}, USDT=${checkpoint.tokens.USDT?.status ?? "absent"}`,
  );
  console.log(
    "No transaction was broadcast and no private key or RPC URL was written to an artifact.",
  );
  process.exit(0);
}

const chain = defineChain({
  id: metadata.chainId,
  name: "Aethelred public testnet",
  nativeCurrency: {
    name: "AETHEL",
    symbol: "AETHEL",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [configuration.rpcUrl],
    },
  },
  testnet: true,
});
const transport = http(configuration.rpcUrl, {
  retryCount: 2,
  timeout: 30_000,
});
const publicClient = createPublicClient({ chain, transport });

async function assertNetworkIdentity() {
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== metadata.chainId) {
    throw new Error(
      `RPC chain ID ${actualChainId} does not match AETHELRED_CHAIN_ID ${metadata.chainId}`,
    );
  }
  const anchor = await publicClient.getBlock({
    blockNumber: BigInt(metadata.networkAnchor.blockNumber),
  });
  if (
    !anchor.hash ||
    normalizeHash(anchor.hash, "network anchor hash") !==
      metadata.networkAnchor.blockHash
  ) {
    throw new Error(
      "RPC network anchor does not match AETHELRED_NETWORK_ANCHOR_BLOCK/HASH",
    );
  }
  if (
    (await publicClient.getBalance({
      address: metadata.provisioner,
    })) === 0n
  ) {
    throw new Error("TOKEN_PROVISIONER_ADDRESS has no native balance");
  }
}

async function verifyConfirmedToken(symbol, record) {
  const spec = TESTNET_TOKEN_SPECS[symbol];
  if (record.origin === "adopted") {
    const configured = metadata.existingTokens[symbol];
    if (
      !configured ||
      !sameAddress(configured.address, record.address) ||
      configured.name !== record.name
    ) {
      throw new Error(
        `${symbol} adopted checkpoint does not match the configured existing token`,
      );
    }
    const verificationBlock = await publicClient.getBlock({
      blockNumber: BigInt(record.blockNumber),
    });
    if (
      !verificationBlock.hash ||
      normalizeHash(verificationBlock.hash, `${symbol} adoption block hash`) !==
        record.blockHash
    ) {
      throw new Error(`${symbol} adoption block is no longer canonical`);
    }
    const runtime = await publicClient.getBytecode({
      address: getAddress(record.address),
    });
    if (
      !runtime ||
      runtime.toLowerCase() !== artifact.deployedBytecode.toLowerCase() ||
      keccak256(runtime).toLowerCase() !== record.runtimeBytecodeHash
    ) {
      throw new Error(`${symbol} runtime does not match reviewed MockERC20`);
    }
    const [name, tokenSymbol, decimals] = await Promise.all([
      publicClient.readContract({
        address: getAddress(record.address),
        abi: artifact.abi,
        functionName: "name",
      }),
      publicClient.readContract({
        address: getAddress(record.address),
        abi: artifact.abi,
        functionName: "symbol",
      }),
      publicClient.readContract({
        address: getAddress(record.address),
        abi: artifact.abi,
        functionName: "decimals",
      }),
    ]);
    if (
      name !== configured.name ||
      tokenSymbol !== spec.symbol ||
      Number(decimals) !== spec.decimals
    ) {
      throw new Error(
        `${symbol} adopted contract metadata does not match the configured name, symbol, and decimals`,
      );
    }
    return record;
  }

  const transaction = await publicClient.getTransaction({
    hash: record.transactionHash,
  });
  if (
    !sameAddress(transaction.from, metadata.provisioner) ||
    transaction.to !== null ||
    BigInt(transaction.nonce) !== BigInt(record.nonce)
  ) {
    throw new Error(
      `${symbol} deployment transaction evidence is inconsistent`,
    );
  }
  const receipt = await publicClient.getTransactionReceipt({
    hash: record.transactionHash,
  });
  if (
    receipt.status !== "success" ||
    !receipt.contractAddress ||
    !sameAddress(receipt.contractAddress, record.expectedAddress) ||
    receipt.blockNumber.toString() !== record.blockNumber ||
    normalizeHash(receipt.blockHash, `${symbol} receipt block hash`) !==
      record.blockHash
  ) {
    throw new Error(`${symbol} deployment receipt evidence is inconsistent`);
  }
  const block = await publicClient.getBlock({
    blockNumber: receipt.blockNumber,
  });
  if (
    !block.hash ||
    normalizeHash(block.hash, `${symbol} canonical block hash`) !==
      record.blockHash
  ) {
    throw new Error(`${symbol} deployment block is no longer canonical`);
  }
  const runtime = await publicClient.getBytecode({
    address: getAddress(record.address),
  });
  if (
    !runtime ||
    runtime.toLowerCase() !== artifact.deployedBytecode.toLowerCase() ||
    keccak256(runtime).toLowerCase() !== record.runtimeBytecodeHash
  ) {
    throw new Error(`${symbol} runtime does not match reviewed MockERC20`);
  }
  const [name, tokenSymbol, decimals] = await Promise.all([
    publicClient.readContract({
      address: getAddress(record.address),
      abi: artifact.abi,
      functionName: "name",
    }),
    publicClient.readContract({
      address: getAddress(record.address),
      abi: artifact.abi,
      functionName: "symbol",
    }),
    publicClient.readContract({
      address: getAddress(record.address),
      abi: artifact.abi,
      functionName: "decimals",
    }),
  ]);
  if (
    name !== spec.name ||
    tokenSymbol !== spec.symbol ||
    Number(decimals) !== spec.decimals
  ) {
    throw new Error(
      `${symbol} on-chain metadata does not match the token policy`,
    );
  }
  return record;
}

async function inspectExistingToken(symbol, configured) {
  const spec = TESTNET_TOKEN_SPECS[symbol];
  const address = getAddress(configured.address);
  const verificationBlock = await publicClient.getBlock({ blockTag: "latest" });
  if (
    verificationBlock.number === null ||
    verificationBlock.number === undefined ||
    !verificationBlock.hash
  ) {
    throw new Error(
      `${symbol} existing-token verification block is unavailable`,
    );
  }
  const [runtime, name, tokenSymbol, decimals] = await Promise.all([
    publicClient.getBytecode({
      address,
      blockNumber: verificationBlock.number,
    }),
    publicClient.readContract({
      address,
      abi: artifact.abi,
      functionName: "name",
      blockNumber: verificationBlock.number,
    }),
    publicClient.readContract({
      address,
      abi: artifact.abi,
      functionName: "symbol",
      blockNumber: verificationBlock.number,
    }),
    publicClient.readContract({
      address,
      abi: artifact.abi,
      functionName: "decimals",
      blockNumber: verificationBlock.number,
    }),
  ]);
  if (
    !runtime ||
    runtime.toLowerCase() !== artifact.deployedBytecode.toLowerCase()
  ) {
    throw new Error(
      `${symbol} existing contract runtime does not match reviewed MockERC20`,
    );
  }
  if (
    name !== configured.name ||
    tokenSymbol !== spec.symbol ||
    Number(decimals) !== spec.decimals
  ) {
    throw new Error(
      `${symbol} existing contract metadata does not match the configured name, symbol, and decimals`,
    );
  }
  const canonicalBlock = await publicClient.getBlock({
    blockNumber: verificationBlock.number,
  });
  const blockHash = normalizeHash(
    verificationBlock.hash,
    `${symbol} verification block hash`,
  );
  if (
    !canonicalBlock.hash ||
    normalizeHash(canonicalBlock.hash, `${symbol} canonical block hash`) !==
      blockHash
  ) {
    throw new Error(`${symbol} verification block changed during adoption`);
  }
  const confirmed = {
    origin: "adopted",
    status: "confirmed",
    address,
    name: configured.name,
    blockNumber: verificationBlock.number.toString(),
    blockHash,
    runtimeBytecodeHash: keccak256(runtime).toLowerCase(),
  };
  return confirmed;
}

async function adoptExistingToken(symbol, configured) {
  assertDistinctTokenAddress(symbol, configured.address);
  const confirmed = await inspectExistingToken(symbol, configured);
  checkpoint.tokens[symbol] = confirmed;
  writeSecureJSONFile(
    checkpointFile,
    checkpoint,
    "token provisioning checkpoint",
  );
  await verifyConfirmedToken(symbol, confirmed);
  console.log(
    `${symbol}: adopted and verified existing contract ${confirmed.address}`,
  );
  return confirmed;
}

function assertDistinctTokenAddress(symbol, candidate) {
  const otherSymbol = symbol === "USDC" ? "USDT" : "USDC";
  const otherAddress =
    checkpoint.tokens[otherSymbol]?.address ??
    metadata.existingTokens[otherSymbol]?.address;
  if (otherAddress && sameAddress(candidate, otherAddress)) {
    throw new Error(
      `${symbol} candidate address is already assigned to ${otherSymbol}`,
    );
  }
}

async function confirmBroadcast(symbol, record) {
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: record.transactionHash,
    confirmations: 1,
    timeout: 120_000,
  });
  if (
    receipt.status !== "success" ||
    !receipt.contractAddress ||
    !sameAddress(receipt.contractAddress, record.expectedAddress)
  ) {
    throw new Error(
      `${symbol} deployment failed or produced an unexpected contract address`,
    );
  }
  const runtime = await publicClient.getBytecode({
    address: getAddress(record.expectedAddress),
  });
  if (
    !runtime ||
    runtime.toLowerCase() !== artifact.deployedBytecode.toLowerCase()
  ) {
    throw new Error(`${symbol} runtime does not match reviewed MockERC20`);
  }
  const confirmed = {
    ...record,
    status: "confirmed",
    address: getAddress(record.expectedAddress),
    blockNumber: receipt.blockNumber.toString(),
    blockHash: normalizeHash(receipt.blockHash, `${symbol} block hash`),
    runtimeBytecodeHash: keccak256(runtime).toLowerCase(),
  };
  checkpoint.tokens[symbol] = confirmed;
  writeSecureJSONFile(
    checkpointFile,
    checkpoint,
    "token provisioning checkpoint",
  );
  await verifyConfirmedToken(symbol, confirmed);
  return confirmed;
}

async function provisionToken(symbol) {
  let record = checkpoint.tokens[symbol];
  if (record?.status === "confirmed") {
    await verifyConfirmedToken(symbol, record);
    console.log(`${symbol}: verified existing deployment ${record.address}`);
    return record;
  }
  if (record?.status === "broadcast") {
    console.log(`${symbol}: reconciling transaction ${record.transactionHash}`);
    return confirmBroadcast(symbol, record);
  }

  if (!record) {
    const configuredExisting = metadata.existingTokens[symbol];
    if (configuredExisting) {
      return adoptExistingToken(symbol, configuredExisting);
    }
    const pendingNonce = BigInt(
      await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      }),
    );
    record = {
      origin: "deployed",
      status: "prepared",
      nonce: pendingNonce.toString(),
      expectedAddress: getContractAddress({
        from: account.address,
        nonce: pendingNonce,
      }),
    };
    assertDistinctTokenAddress(symbol, record.expectedAddress);
    checkpoint.tokens[symbol] = record;
    writeSecureJSONFile(
      checkpointFile,
      checkpoint,
      "token provisioning checkpoint",
    );
  }

  const expectedCode = await publicClient.getBytecode({
    address: getAddress(record.expectedAddress),
  });
  if (expectedCode && expectedCode !== "0x") {
    throw new Error(
      `${symbol} expected address already has code without recorded transaction evidence; stop for manual reconciliation`,
    );
  }
  const currentPendingNonce = BigInt(
    await publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    }),
  );
  const preparedNonce = BigInt(record.nonce);
  if (currentPendingNonce !== preparedNonce) {
    throw new Error(
      `${symbol} prepared nonce ${preparedNonce} no longer matches provisioner pending nonce ${currentPendingNonce}; stop for manual reconciliation`,
    );
  }

  const spec = TESTNET_TOKEN_SPECS[symbol];
  console.log(
    `${symbol}: deploying publicly mintable test token at expected address ${record.expectedAddress}`,
  );
  const transactionHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [spec.name, spec.symbol, spec.decimals],
    nonce: Number(preparedNonce),
  });
  record = {
    ...record,
    status: "broadcast",
    transactionHash: normalizeHash(
      transactionHash,
      `${symbol} transaction hash`,
    ),
  };
  checkpoint.tokens[symbol] = record;
  writeSecureJSONFile(
    checkpointFile,
    checkpoint,
    "token provisioning checkpoint",
  );
  return confirmBroadcast(symbol, record);
}

const lockFile = `${checkpointFile}.lock`;
if (verifyOnly) {
  await assertNetworkIdentity();
  for (const symbol of Object.keys(TESTNET_TOKEN_SPECS)) {
    const record = checkpoint.tokens[symbol];
    const configured = metadata.existingTokens[symbol];
    if (record?.status === "confirmed") {
      await verifyConfirmedToken(symbol, record);
      console.log(
        `${symbol}: verified checkpointed ${record.origin} contract ${record.address}`,
      );
    } else if (record) {
      console.log(
        `${symbol}: checkpoint is ${record.status}; transaction-bearing resume is pending`,
      );
    } else if (configured) {
      const verified = await inspectExistingToken(symbol, configured);
      console.log(
        `${symbol}: verified existing contract ${verified.address} at block ${verified.blockNumber}`,
      );
    } else {
      console.log(
        `${symbol}: no existing contract configured; deployment is pending`,
      );
    }
  }
  console.log(
    "Existing-token verification passed. No checkpoint or manifest was written and no transaction was broadcast.",
  );
  process.exit(0);
}

const account = loadProvisionerAccount(configuration);
const walletClient = createWalletClient({ account, chain, transport });

let lockDescriptor;
try {
  lockDescriptor = openSync(
    lockFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
} catch (error) {
  if (error?.code === "EEXIST") {
    throw new Error(
      `token provisioning lock already exists at ${lockFile}; verify no ceremony is running and reconcile it manually`,
    );
  }
  throw error;
}

try {
  await assertNetworkIdentity();
  if (!restoredCheckpoint || restored?.migrated) {
    writeSecureJSONFile(
      checkpointFile,
      checkpoint,
      "token provisioning checkpoint",
    );
    if (restored?.migrated) {
      console.log(
        "Token checkpoint upgraded from version 1 to version 2 before resume.",
      );
    }
  }
  await provisionToken("USDC");
  await provisionToken("USDT");

  if (
    sameAddress(checkpoint.tokens.USDC.address, checkpoint.tokens.USDT.address)
  ) {
    throw new Error("USDC and USDT resolved to the same contract address");
  }

  const manifest = buildProvisioningManifest(metadata, checkpoint);
  assertNewSecureArtifactPath(manifestFile, "testnet token manifest");
  writeSecureJSONFile(manifestFile, manifest, "testnet token manifest");

  console.log(`Testnet token manifest written to ${manifestFile}`);
  console.log(
    `SUPPORTED_TOKEN_ADDRESSES=${manifest.coreDeploymentEnvironment.SUPPORTED_TOKEN_ADDRESSES}`,
  );
  console.log(
    `USDC_TOKEN_ADDRESS=${manifest.coreDeploymentEnvironment.USDC_TOKEN_ADDRESS}`,
  );
  console.log(
    `USDT_TOKEN_ADDRESS=${manifest.coreDeploymentEnvironment.USDT_TOKEN_ADDRESS}`,
  );
  console.log(
    "The manifest contains public chain evidence only; it contains no private key, key-file path, or RPC URL.",
  );
} finally {
  closeSync(lockDescriptor);
  unlinkSync(lockFile);
}
