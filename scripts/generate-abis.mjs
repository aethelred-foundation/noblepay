#!/usr/bin/env node
/**
 * Regenerate src/config/abis.ts from the compiled Hardhat artifacts.
 *
 * The frontend previously carried hand-written "minimal ABIs" that had drifted
 * from the contracts (wrong parameter types, wrong mutability, functions that
 * do not exist on-chain). Wrong types change the 4-byte function selector, so
 * every such call reverts or hits the fallback — silently, from the UI's point
 * of view. Generating from artifacts makes the ABI byte-exact with what
 * scripts/deploy-testnet.mjs actually deploys.
 *
 * Usage: node scripts/generate-abis.mjs   (run after `npx hardhat compile`)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CONTRACTS = [
  { name: 'NoblePay', exportName: 'NOBLEPAY_ABI', title: 'NoblePay Core — Payment Router' },
  { name: 'ComplianceOracle', exportName: 'COMPLIANCE_ORACLE_ABI', title: 'Compliance Oracle — TEE-backed screening engine' },
  { name: 'BusinessRegistry', exportName: 'BUSINESS_REGISTRY_ABI', title: 'Business Registry — KYC and identity management' },
  { name: 'TravelRule', exportName: 'TRAVEL_RULE_ABI', title: 'Travel Rule — FATF-compliant originator/beneficiary data' },
];

const header = `/**
 * Contract ABIs for NoblePay protocol interactions.
 *
 * GENERATED FILE — do not edit by hand.
 * Regenerate with: node scripts/generate-abis.mjs (after \`npx hardhat compile\`
 * in contracts/). Generated from the same artifacts scripts/deploy-testnet.mjs
 * deploys, so selectors always match the on-chain bytecode.
 */
`;

let out = header;
for (const { name, exportName, title } of CONTRACTS) {
  const artifactPath = join(root, 'contracts', 'artifacts', 'src', `${name}.sol`, `${name}.json`);
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
    throw new Error(`artifact for ${name} has no ABI: ${artifactPath}`);
  }
  out += `
// ---------------------------------------------------------------------------
// ${title}
// ---------------------------------------------------------------------------

export const ${exportName} = ${JSON.stringify(artifact.abi, null, 2)} as const;
`;
}

const target = join(root, 'src', 'config', 'abis.ts');
writeFileSync(target, out);
console.log(`[abis] wrote ${target} from ${CONTRACTS.length} artifacts`);
