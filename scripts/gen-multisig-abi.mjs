#!/usr/bin/env node
/**
 * Regenerates MULTISIG_TREASURY_ABI in src/config/abis.ts from the compiled
 * MultiSigTreasury artifact.
 *
 * A hand-maintained ABI that drifts from the deployed contract does not fail
 * loudly — a positional tuple decodes to the wrong fields and the UI shows
 * nonsense or throws deep inside viem. Generating from the artifact makes that
 * class of bug impossible.
 *
 * Run after any change to contracts/src/MultiSigTreasury.sol:
 *   (cd contracts && npx hardhat compile) && node scripts/gen-multisig-abi.mjs
 *
 * Exits non-zero when the checked-in ABI is stale, so CI can gate on it:
 *   node scripts/gen-multisig-abi.mjs --check
 */
import { readFileSync, writeFileSync } from "node:fs";

const ARTIFACT = "contracts/artifacts/src/MultiSigTreasury.sol/MultiSigTreasury.json";
const TARGET = "src/config/abis.ts";
const MARKER = "export const MULTISIG_TREASURY_ABI = ";

/** The surface the treasury UI needs — extend as the UI grows. */
const WANTED = new Set([
  "createProposal", "approveProposal", "rejectProposal", "executeProposal", "cancelProposal",
  "getProposal", "signerConfig", "signers", "hasRole",
  "SMALL_TX_THRESHOLD", "LARGE_TX_THRESHOLD", "SIGNER_ROLE", "ADMIN_ROLE",
  "ProposalCreated", "ProposalApproved", "ProposalExecuted",
]);

const abi = JSON.parse(readFileSync(ARTIFACT, "utf8")).abi.filter(
  (e) => e.name && WANTED.has(e.name),
);

const missing = [...WANTED].filter((n) => !abi.some((e) => e.name === n));
if (missing.length) {
  console.error(`FAIL: artifact is missing expected members: ${missing.join(", ")}`);
  process.exit(1);
}

const rendered = `${MARKER}${JSON.stringify(abi, null, 2)} as const;\n`;
const source = readFileSync(TARGET, "utf8");
const start = source.indexOf(MARKER);
if (start === -1) {
  console.error(`FAIL: ${TARGET} has no ${MARKER.trim()} block to replace`);
  process.exit(1);
}
const updated = source.slice(0, start) + rendered;

if (process.argv.includes("--check")) {
  if (source.slice(start) !== rendered) {
    console.error("FAIL: MULTISIG_TREASURY_ABI is stale — run node scripts/gen-multisig-abi.mjs");
    process.exit(1);
  }
  console.log(`OK: MULTISIG_TREASURY_ABI matches the artifact (${abi.length} members)`);
  process.exit(0);
}

writeFileSync(TARGET, updated);
console.log(`Regenerated MULTISIG_TREASURY_ABI (${abi.length} members) in ${TARGET}`);
