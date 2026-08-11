#!/usr/bin/env node
/**
 * Generates src/config/abis.generated.ts from the compiled Hardhat artifacts.
 *
 * Every ABI the frontend uses is derived from the artifact of the contract it
 * talks to. Hand-maintained ABIs are the problem this replaces: they are plain
 * TypeScript literals, so nothing type-checks them against the contract, and a
 * wrong entry does not fail at build time. It fails at runtime, either as an
 * unexplained revert or — worse, because it looks like data — as a positional
 * tuple that decodes into the wrong fields.
 *
 * The file this replaced (src/lib/abis.ts) had drifted past staleness into
 * fiction: it declared createHedge/closeHedge/getExposure on FXHedgingVault,
 * a contract whose actual surface is settleForward/exerciseOption/getPortfolio.
 * Not one of those signatures existed on chain.
 *
 * Run after any contract change:
 *   (cd contracts && npx hardhat compile) && node scripts/gen-abis.mjs
 *
 * Exits non-zero when the checked-in file is stale, so CI can gate on it:
 *   node scripts/gen-abis.mjs --check
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ARTIFACT_DIR = "contracts/artifacts/src";
const TARGET = "src/config/abis.generated.ts";

/**
 * Contract name -> exported constant. Full ABIs are emitted rather than a
 * curated subset: a subset needs a hand-maintained allowlist, which is the
 * same failure mode one level up. Each ABI is a separate named export so a
 * page that imports one does not pull in the other thirteen.
 */
const CONTRACTS = {
  NoblePay: "NOBLEPAY_ABI",
  BusinessRegistry: "BUSINESS_REGISTRY_ABI",
  ComplianceOracle: "COMPLIANCE_ORACLE_ABI",
  TravelRule: "TRAVEL_RULE_ABI",
  LiquidityPool: "LIQUIDITY_POOL_ABI",
  MultiSigTreasury: "MULTISIG_TREASURY_ABI",
  FXHedgingVault: "FX_HEDGING_VAULT_ABI",
  InvoiceFinancing: "INVOICE_FINANCING_ABI",
  PaymentChannels: "PAYMENT_CHANNELS_ABI",
  StreamingPayments: "STREAMING_PAYMENTS_ABI",
  CrossChainRouter: "CROSS_CHAIN_ROUTER_ABI",
  AIComplianceModule: "AI_COMPLIANCE_MODULE_ABI",
  SealSettlementGate: "SEAL_SETTLEMENT_GATE_ABI",
};

const header = `// GENERATED FILE — DO NOT EDIT.
//
// Produced by scripts/gen-abis.mjs from contracts/artifacts. Edit the Solidity
// source and recompile instead; a hand-edit here is silently overwritten and,
// until it is, silently wrong.
//
// Regenerate:  (cd contracts && npx hardhat compile) && node scripts/gen-abis.mjs
// Verify:      node scripts/gen-abis.mjs --check

`;

const missing = [];
const blocks = [];

for (const [contract, exportName] of Object.entries(CONTRACTS)) {
  const path = `${ARTIFACT_DIR}/${contract}.sol/${contract}.json`;
  if (!existsSync(path)) {
    missing.push(`${contract} (no artifact at ${path})`);
    continue;
  }
  const { abi } = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(abi) || abi.length === 0) {
    missing.push(`${contract} (artifact has an empty abi)`);
    continue;
  }
  blocks.push(
    `/** ${contract} — ${abi.length} members, from ${contract}.sol */\n` +
      `export const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`,
  );
}

if (missing.length) {
  console.error("FAIL: compile the contracts first — missing artifacts:");
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}

const rendered = header + blocks.join("\n");

if (process.argv.includes("--check")) {
  const current = existsSync(TARGET) ? readFileSync(TARGET, "utf8") : "";
  if (current !== rendered) {
    console.error(
      `FAIL: ${TARGET} is stale — run node scripts/gen-abis.mjs and commit the result`,
    );
    process.exit(1);
  }
  console.log(`OK: ${TARGET} matches the artifacts (${blocks.length} contracts)`);
  process.exit(0);
}

writeFileSync(TARGET, rendered);
console.log(`Generated ${TARGET} — ${blocks.length} contracts`);
