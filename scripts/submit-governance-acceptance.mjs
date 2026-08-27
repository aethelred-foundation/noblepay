#!/usr/bin/env node
/**
 * Broadcasts the governance ownership acceptance prepared by
 * scripts/prepare-governance-acceptance.mjs.
 *
 * That script deliberately does not broadcast — it emits the exact target,
 * value and calldata for governance to submit however governance signs. This
 * completes the loop for the case where governance is an externally owned
 * account.
 *
 * WHY AN EOA AND NOT THE TREASURY MULTISIG. MultiSigTreasury cannot make this
 * call. Its Proposal struct carries no calldata field, and executeProposal
 * moves value only:
 *
 *     (bool ok, ) = p.recipient.call{value: p.amount}("");   // empty calldata
 *     IERC20(p.token).safeTransfer(p.recipient, p.amount);
 *
 * SealSettlementGate is Ownable2Step, so transferOwnership only nominates a
 * pending owner; the nominee must call acceptOwnership itself. Naming the
 * treasury as governance therefore leaves the transfer permanently incomplete.
 * It fails safe — the previous owner keeps control, nothing is bricked — but
 * the handover never completes. This script refuses to run against a contract
 * governance address rather than letting that be discovered later.
 *
 * SAFETY. Dry run is the default. Nothing is broadcast without --broadcast.
 * Every precondition is checked before sending, so a doomed transaction is
 * reported as a clear error rather than as a wasted revert on chain.
 *
 * Usage:
 *   GOVERNANCE_KEY=0x…                 private key of the governance EOA
 *   AETHELRED_RPC_URL=https://…
 *   node scripts/submit-governance-acceptance.mjs \
 *     --payload-file /etc/noblepay/governance-acceptance.json    # dry run
 *
 *   …same command… --broadcast                                    # sends it
 *
 * The payload file is the GOVERNANCE_ACCEPTANCE_JSON value emitted by
 * prepare-governance-acceptance.mjs, written verbatim to a file.
 *
 * It is read through readSecureJSONFile, which enforces the same operator
 * artifact rules as the rest of this directory: an absolute path, a regular
 * file (not a symlink), mode 0600, and a parent directory that grants no group
 * or other permissions. /tmp will therefore be rejected — put the payload
 * beside the other deployment artifacts, for example:
 *
 *   install -d -m 700 /etc/noblepay
 *   node scripts/prepare-governance-acceptance.mjs --checkpoint-file … \
 *     | sed -n 's/^GOVERNANCE_ACCEPTANCE_JSON=//p' \
 *     > /etc/noblepay/governance-acceptance.json
 *   chmod 600 /etc/noblepay/governance-acceptance.json
 */

import { readFileSync } from "node:fs";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  assertExternallyOwnedAccountCode,
  assertNetworkAnchorBlock,
  normalizeBlockHash,
} from "./lib/deployment-governance.mjs";
import { cliPathOption, readSecureJSONFile } from "./lib/operator-artifacts.mjs";

// Aethelred under-reports eth_estimateGas for state-changing calls (GAS-01), so
// every write in this repository carries an explicit limit.
const WRITE_GAS = 3_000_000n;

const OWNABLE2STEP_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "pendingOwner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "acceptOwnership",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const broadcast = process.argv.includes("--broadcast");

async function main() {
  // Parsed inside main so a missing or malformed argument surfaces through the
  // same FAIL: line as every other error, rather than as an unhandled throw
  // with a stack trace. An operator running a deployment step should not have
  // to read a Node traceback to learn they omitted a flag.
  const payloadFile = cliPathOption(process.argv, "--payload-file", {
    required: true,
  });
  // "integrity", not "secret": the payload is a chain id, a block anchor, a
  // target address and calldata — all public once broadcast. What must not
  // happen is someone else rewriting the target or calldata this script is
  // about to submit, so group/other WRITE is refused and read is allowed.
  const payload = readSecureJSONFile(
    payloadFile,
    "governance acceptance payload",
    { sensitivity: "integrity" },
  );

  for (const field of ["chainId", "requiredExecutor", "target", "calldata", "value"]) {
    if (payload[field] === undefined || payload[field] === null) {
      fail(`payload is missing ${field}; regenerate it with prepare-governance-acceptance.mjs`);
    }
  }
  if (!isAddress(payload.target) || !isAddress(payload.requiredExecutor)) {
    fail("payload target and requiredExecutor must be EVM addresses");
  }
  if (BigInt(payload.value) !== 0n) {
    fail("acceptOwnership carries no value; refusing a payload with a non-zero value");
  }

  const rpcUrl = required("AETHELRED_RPC_URL");
  const account = privateKeyToAccount(required("GOVERNANCE_KEY"));

  const probe = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probe.getChainId();
  if (BigInt(chainId) !== BigInt(payload.chainId)) {
    fail(
      `chain mismatch: payload was prepared for chain ${payload.chainId}, ` +
        `AETHELRED_RPC_URL is chain ${chainId}`,
    );
  }

  const chain = defineChain({
    id: chainId,
    name: `aethelred-${chainId}`,
    nativeCurrency: { name: "AETHEL", symbol: "AETHEL", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });

  // The anchor pins this RPC to the network the payload was prepared against,
  // so a correct payload cannot be replayed onto a fork or a look-alike chain
  // that happens to share a chain id.
  if (payload.networkAnchor?.blockNumber !== undefined) {
    const anchorBlock = await publicClient.getBlock({
      blockNumber: BigInt(payload.networkAnchor.blockNumber),
    });
    assertNetworkAnchorBlock({
      expectedBlockNumber: payload.networkAnchor.blockNumber,
      expectedBlockHash: normalizeBlockHash(
        payload.networkAnchor.blockHash,
        "payload anchor hash",
      ),
      block: anchorBlock,
    });
  }

  const governance = getAddress(payload.requiredExecutor);
  const target = getAddress(payload.target);

  if (getAddress(account.address) !== governance) {
    fail(
      `GOVERNANCE_KEY controls ${account.address}, but the payload requires ` +
        `${governance} to execute. Use the governance account's key.`,
    );
  }

  // Governance must be an EOA. A contract here is the multisig trap described
  // at the top of this file: Ownable2Step would nominate an owner that can
  // never accept.
  const governanceCode = await publicClient.getBytecode({ address: governance });
  try {
    assertExternallyOwnedAccountCode(governanceCode, "governance account");
  } catch (error) {
    fail(
      `${error.message}\n` +
        `  A contract cannot complete an Ownable2Step handover unless it can make\n` +
        `  arbitrary calls. MultiSigTreasury cannot: it transfers value only.`,
    );
  }

  const [owner, pendingOwner] = await Promise.all([
    publicClient.readContract({ address: target, abi: OWNABLE2STEP_ABI, functionName: "owner" }),
    publicClient.readContract({
      address: target,
      abi: OWNABLE2STEP_ABI,
      functionName: "pendingOwner",
    }),
  ]);

  console.log(`chain            ${chainId} @ ${rpcUrl}`);
  console.log(`target           ${target}`);
  console.log(`current owner    ${owner}`);
  console.log(`pending owner    ${pendingOwner}`);
  console.log(`governance (you) ${governance}`);
  console.log("");

  if (getAddress(owner) === governance) {
    console.log("Ownership is already held by governance; nothing to do.");
    return;
  }

  if (getAddress(pendingOwner) !== governance) {
    fail(
      `the target's pending owner is ${pendingOwner}, not ${governance}.\n` +
        `  acceptOwnership would revert. The current owner (${owner}) must first run\n` +
        `  transferOwnership(${governance}) — for example via the bootstrap phase of\n` +
        `  deploy-devnet-core.mjs with ADMIN_ADDRESS set to the governance EOA.\n` +
        `  If ownership was previously nominated to a multisig, that nomination is\n` +
        `  simply superseded; nothing needs undoing.`,
    );
  }

  if (!broadcast) {
    console.log("DRY RUN — preconditions satisfied, acceptOwnership would succeed.");
    console.log(`  from     ${governance}`);
    console.log(`  to       ${target}`);
    console.log(`  value    0`);
    console.log(`  calldata ${payload.calldata}`);
    console.log("");
    console.log("Re-run with --broadcast to submit.");
    return;
  }

  // Simulate first: a revert here costs nothing, whereas a reverted broadcast
  // costs gas and leaves a failed transaction in the deployment record.
  await publicClient.simulateContract({
    address: target,
    abi: OWNABLE2STEP_ABI,
    functionName: "acceptOwnership",
    account,
  });

  const hash = await walletClient.writeContract({
    address: target,
    abi: OWNABLE2STEP_ABI,
    functionName: "acceptOwnership",
    gas: WRITE_GAS,
  });
  console.log(`submitted ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    fail(`acceptOwnership reverted in ${hash}`);
  }

  // Confirm from chain rather than trusting the receipt: a successful receipt
  // means the call did not revert, not that ownership is where we expect.
  const confirmedOwner = await publicClient.readContract({
    address: target,
    abi: OWNABLE2STEP_ABI,
    functionName: "owner",
  });
  if (getAddress(confirmedOwner) !== governance) {
    fail(
      `transaction succeeded but owner is ${confirmedOwner}, expected ${governance}`,
    );
  }

  console.log(`confirmed in block ${receipt.blockNumber}`);
  console.log(`owner is now ${confirmedOwner}`);
  console.log("");
  console.log("Governance acceptance complete. The finalize phase can now run.");
}

main().catch((error) => {
  fail(error.shortMessage ?? error.message);
});
