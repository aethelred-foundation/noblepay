#!/usr/bin/env node
/**
 * Minimal devnet deployer for the NoblePay CORE payment flow.
 *
 * Deploys NoblePay + BusinessRegistry from the reviewed hardhat artifacts and
 * prints the env block for the web app. The two USER actions — registering a
 * business and initiating a payment — are deliberately NOT performed here:
 * they are what the browser proof drives through the real UI.
 *
 * The one admin step this script performs after the user registers is exposed
 * as a flag: `--sync <business>` calls NoblePay.syncBusiness(business, tier=1,
 * true), mirroring the operator approval that links a BusinessRegistry entry
 * to the payment contract's onlyRegistered gate.
 *
 * All writes carry explicit gas limits (GAS-01: the devnet under-reports
 * estimates for state-changing calls).
 *
 * Env: DEPLOYER_KEY (funded; admin+treasury), RPC_URL (default
 *      http://127.0.0.1:8545). Existing deployment reused when
 *      NOBLEPAY_ADDRESS + BUSINESS_REGISTRY_ADDRESS are set (for --sync runs).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const GAS = 5_000_000n;

if (!process.env.DEPLOYER_KEY) {
  console.error("FAIL: DEPLOYER_KEY required");
  process.exit(1);
}

const artifact = (name) =>
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "contracts", "artifacts", "src", `${name}.sol`, `${name}.json`),
      "utf8",
    ),
  );

const account = privateKeyToAccount(process.env.DEPLOYER_KEY);
const chain = defineChain({
  id: 7332,
  name: "aethelred-devnet",
  nativeCurrency: { name: "AETHEL", symbol: "AETHEL", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ chain, account, transport: http() });

async function deploy(name, args) {
  const { abi, bytecode } = artifact(name);
  const hash = await wallet.deployContract({ abi, bytecode, args, gas: GAS });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${name} deploy reverted`);
  console.log(`${name}: ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

async function main() {
  const syncIdx = process.argv.indexOf("--sync");
  const syncBusiness = syncIdx > -1 ? process.argv[syncIdx + 1] : null;

  let noblePay = process.env.NOBLEPAY_ADDRESS;
  let registry = process.env.BUSINESS_REGISTRY_ADDRESS;

  if (!noblePay || !registry) {
    // NoblePay(admin, treasury, baseFee, percentageFee): flat 0.001 AETHEL +
    // 0.25% (25 bps, well under MAX_PERCENTAGE_FEE=500).
    noblePay = await deploy("NoblePay", [
      account.address,
      account.address,
      1_000_000_000_000_000n,
      25n,
    ]);
    registry = await deploy("BusinessRegistry", [account.address]);

    console.log("\n== NoblePay web .env.local block");
    console.log("NEXT_PUBLIC_CHAIN_ENV=devnet");
    console.log(`NEXT_PUBLIC_AETHELRED_DEVNET_RPC_URL=${RPC_URL}`);
    console.log(`NEXT_PUBLIC_NOBLEPAY_ADDRESS=${noblePay}`);
    console.log(`NEXT_PUBLIC_BUSINESS_REGISTRY_ADDRESS=${registry}`);
  }

  if (syncBusiness) {
    const { abi } = artifact("NoblePay");
    const hash = await wallet.writeContract({
      address: noblePay,
      abi,
      functionName: "syncBusiness",
      args: [syncBusiness, 1, true],
      gas: GAS,
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(`syncBusiness(${syncBusiness}, tier=1, true): ${receipt.status}`);
  }
}

main().catch((err) => {
  console.error("FAIL:", err.shortMessage ?? err.message);
  process.exit(1);
});
