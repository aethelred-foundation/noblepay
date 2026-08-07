#!/usr/bin/env node
/**
 * Seeds the devnet FXHedgingVault with currency pairs, oracle rates and
 * supported collateral.
 *
 * A freshly deployed vault has no currency pairs, so every FX screen correctly
 * renders an empty state. That is honest but untestable: to prove the page
 * reads real state we need real state to exist. Everything written here goes
 * through the contract's own admin and oracle entry points and is then read
 * back from chain — this seeds a chain, it does not fake a UI.
 *
 * Devnet only. The deployer holds ADMIN_ROLE and ORACLE_ROLE because the
 * deployment gave it both; on a real network those are separate parties and
 * the rates come from an actual oracle.
 *
 *   DEPLOYER_KEY=0x… node scripts/seed-devnet-fx.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const GAS = 5_000_000n;

const VAULT = process.env.FX_HEDGING_VAULT_ADDRESS;
const COLLATERAL = process.env.USDC_TOKEN_ADDRESS;

if (!process.env.DEPLOYER_KEY || !VAULT) {
  console.error("FAIL: DEPLOYER_KEY and FX_HEDGING_VAULT_ADDRESS required");
  process.exit(1);
}

const abi = JSON.parse(
  readFileSync(
    join(__dirname, "..", "contracts", "artifacts", "src", "FXHedgingVault.sol", "FXHedgingVault.json"),
    "utf8",
  ),
).abi;

const account = privateKeyToAccount(process.env.DEPLOYER_KEY);
const chain = defineChain({
  id: 7332,
  name: "aethelred-devnet",
  nativeCurrency: { name: "AETHEL", symbol: "AETHEL", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ chain, account, transport: http() });

async function send(functionName, args) {
  const hash = await wallet.writeContract({
    address: VAULT,
    abi,
    functionName,
    args,
    gas: GAS,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`${functionName}(${args.join(", ")}) reverted`);
  }
  return receipt;
}

/** bytes3 ASCII currency code, e.g. "AED" -> 0x414544. */
const code = (s) => toHex(s, { size: 3 });

const RATE_PRECISION = 100_000_000n; // 1e8, read from the contract below

/**
 * Rates are indicative devnet values, not a market feed. AED is pegged at
 * 3.6725 to the dollar; the others are round numbers chosen to be obviously
 * illustrative rather than to imply a real quote.
 */
const PAIRS = [
  { base: "AED", quote: "USD", rate: 0.2723, maxHedgeRatioBps: 10_000n, marginBps: 500n, maintenanceBps: 300n },
  { base: "EUR", quote: "USD", rate: 1.0850, maxHedgeRatioBps: 10_000n, marginBps: 750n, maintenanceBps: 400n },
  { base: "GBP", quote: "USD", rate: 1.2640, maxHedgeRatioBps: 8_000n, marginBps: 750n, maintenanceBps: 400n },
  { base: "SAR", quote: "USD", rate: 0.2666, maxHedgeRatioBps: 10_000n, marginBps: 500n, maintenanceBps: 300n },
];

/**
 * The constructor grants only DEFAULT_ADMIN_ROLE and ADMIN_ROLE. ORACLE_ROLE,
 * RISK_MANAGER_ROLE and LIQUIDATOR_ROLE are never granted, so a freshly
 * deployed vault cannot publish a rate, cannot mark to market and cannot
 * liquidate — every position would sit at a zero rate forever. Granting them
 * is a required post-deploy step, not seeding.
 *
 * On devnet all three go to the deployer. In production they are separate
 * parties: an oracle operator, a risk desk, and whoever runs liquidation.
 */
async function grantOperationalRoles() {
  for (const roleName of ["ORACLE_ROLE", "RISK_MANAGER_ROLE", "LIQUIDATOR_ROLE"]) {
    const role = await pub.readContract({ address: VAULT, abi, functionName: roleName });
    const held = await pub.readContract({
      address: VAULT,
      abi,
      functionName: "hasRole",
      args: [role, account.address],
    });
    if (held) {
      console.log(`${roleName}: already held`);
      continue;
    }
    await send("grantRole", [role, account.address]);
    console.log(`${roleName}: granted to ${account.address}`);
  }
}

async function main() {
  const precision = await pub.readContract({ address: VAULT, abi, functionName: "RATE_PRECISION" });
  if (precision !== RATE_PRECISION) {
    throw new Error(`RATE_PRECISION changed: expected ${RATE_PRECISION}, chain says ${precision}`);
  }

  await grantOperationalRoles();

  if (COLLATERAL) {
    await send("setSupportedCollateral", [COLLATERAL, true]);
    console.log(`collateral enabled: ${COLLATERAL}`);
  } else {
    console.log("USDC_TOKEN_ADDRESS not set — skipping collateral whitelist");
  }

  // Adding pairs is idempotent-by-skip; publishing rates is not, and must run
  // on every invocation. An earlier version returned early here when pairs
  // already existed, which silently left every pair on a zero rate.
  const existing = await pub.readContract({ address: VAULT, abi, functionName: "getActivePairs" });
  if (existing.length > 0) {
    console.log(`${existing.length} pair(s) already present — skipping pair creation`);
  } else {
    for (const p of PAIRS) {
      await send("addCurrencyPair", [
        code(p.base),
        code(p.quote),
        p.maxHedgeRatioBps,
        p.marginBps,
        p.maintenanceBps,
      ]);
      console.log(`pair added: ${p.base}/${p.quote}`);
    }
  }

  // Publish a rate for each pair, in one batch so they share a timestamp.
  const ids = await pub.readContract({ address: VAULT, abi, functionName: "getActivePairs" });
  const rates = [];
  for (const id of ids) {
    const pair = await pub.readContract({ address: VAULT, abi, functionName: "getCurrencyPair", args: [id] });
    const base = Buffer.from(pair.baseCurrency.slice(2), "hex").toString().replace(/\0+$/, "");
    const match = PAIRS.find((p) => p.base === base);
    if (!match) throw new Error(`no seed rate for ${base}`);
    rates.push(BigInt(Math.round(match.rate * Number(RATE_PRECISION))));
  }
  await send("batchSubmitFXRates", [ids, rates]);
  console.log(`rates published for ${ids.length} pair(s)`);

  // Read back, so the script proves the state rather than assuming the sends
  // landed.
  for (let i = 0; i < ids.length; i++) {
    const [rate, updatedAt] = await pub.readContract({
      address: VAULT,
      abi,
      functionName: "getLatestRate",
      args: [ids[i]],
    });
    const pair = await pub.readContract({ address: VAULT, abi, functionName: "getCurrencyPair", args: [ids[i]] });
    const base = Buffer.from(pair.baseCurrency.slice(2), "hex").toString().replace(/\0+$/, "");
    const quote = Buffer.from(pair.quoteCurrency.slice(2), "hex").toString().replace(/\0+$/, "");
    console.log(
      `  ${base}/${quote}  rate=${Number(rate) / Number(RATE_PRECISION)}  at=${new Date(Number(updatedAt) * 1000).toISOString()}`,
    );
  }
}

main().catch((err) => {
  console.error(`FAIL: ${err.shortMessage ?? err.message}`);
  process.exit(1);
});
