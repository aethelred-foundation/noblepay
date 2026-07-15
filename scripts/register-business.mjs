#!/usr/bin/env node
/**
 * Register (sync) a business into NoblePay so it can initiate payments.
 *
 * initiatePayment is gated by onlyRegistered — an unregistered sender reverts
 * NotRegisteredBusiness(). This is NOT an ERC-20 "approval": native AETHEL
 * needs no approval, and the contract needs no pre-funded balance (escrow
 * travels as msg.value with the payment itself).
 *
 * NoblePay keeps its own registeredBusinesses mapping, written by
 * syncBusiness(business, tier, registered) under ADMIN_ROLE (the deployer).
 * The full governance journey (BusinessRegistry.registerBusiness →
 * verifyBusiness → sync) still applies for the product flow; this script is
 * the admin-side sync that opens the payment gate for testnet accounts.
 *
 * Usage:
 *   RPC_URL=http://54.165.44.130:8545 \
 *   DEPLOYER_KEY=0x<admin private key> \
 *   NOBLEPAY_ADDRESS=0x<deployed NoblePay> \
 *   BUSINESS_ADDRESS=0x<account that will pay> \
 *   TIER=2 \
 *   node scripts/register-business.mjs
 *
 * TIER: 0 = STANDARD (50k units/day), 1 = PREMIUM (500k), 2 = ENTERPRISE (5M).
 * Limit units are 6-decimal: 1 AETHEL (native) counts as 1e6 units, i.e.
 * STANDARD allows 50,000 AETHEL-equivalents per day.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const NOBLEPAY_ADDRESS = process.env.NOBLEPAY_ADDRESS;
const BUSINESS_ADDRESS = process.env.BUSINESS_ADDRESS;
const TIER = Number(process.env.TIER ?? "0");

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

if (!DEPLOYER_KEY) fail("DEPLOYER_KEY is required (the NoblePay admin key)");
if (!NOBLEPAY_ADDRESS?.match(/^0x[0-9a-fA-F]{40}$/)) fail("NOBLEPAY_ADDRESS must be a 0x address");
if (!BUSINESS_ADDRESS?.match(/^0x[0-9a-fA-F]{40}$/)) fail("BUSINESS_ADDRESS must be a 0x address");
if (![0, 1, 2].includes(TIER)) fail("TIER must be 0 (STANDARD), 1 (PREMIUM) or 2 (ENTERPRISE)");

const abi = [
  { name: "syncBusiness", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "_business", type: "address" },
      { name: "_tier", type: "uint8" },
      { name: "_registered", type: "bool" },
    ], outputs: [] },
  { name: "registeredBusinesses", type: "function", stateMutability: "view",
    inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { name: "businessTiers", type: "function", stateMutability: "view",
    inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint8" }] },
];

const account = privateKeyToAccount(DEPLOYER_KEY);
const transport = http(RPC_URL);
const publicClient = createPublicClient({ transport });
const chainId = await publicClient.getChainId();
const chain = { id: chainId, name: `aethelred-${chainId}`, nativeCurrency: { name: "AETHEL", symbol: "AETHEL", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
const walletClient = createWalletClient({ account, chain, transport });

console.log(`chain id: ${chainId}`);
console.log(`admin:    ${account.address}`);
console.log(`business: ${BUSINESS_ADDRESS} -> tier ${TIER}, registered=true`);

const already = await publicClient.readContract({
  address: NOBLEPAY_ADDRESS, abi, functionName: "registeredBusinesses", args: [BUSINESS_ADDRESS],
});
if (already) console.log("note: business is already registered — re-syncing tier");

// Explicit gas: this chain's eth_estimateGas has underestimated real usage
// (observed 22,750 for a tx needing ~70k — the tx dies out-of-gas at exactly
// gasUsed == gasLimit). 300k is ~4x the true cost; unused gas is refunded.
const hash = await walletClient.writeContract({
  address: NOBLEPAY_ADDRESS, abi, functionName: "syncBusiness",
  args: [BUSINESS_ADDRESS, TIER, true],
  gas: 300_000n,
});
console.log(`syncBusiness tx: ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") fail(`transaction reverted (status ${receipt.status}) — is DEPLOYER_KEY the ADMIN_ROLE holder?`);

const registered = await publicClient.readContract({
  address: NOBLEPAY_ADDRESS, abi, functionName: "registeredBusinesses", args: [BUSINESS_ADDRESS],
});
const tier = await publicClient.readContract({
  address: NOBLEPAY_ADDRESS, abi, functionName: "businessTiers", args: [BUSINESS_ADDRESS],
});
if (!registered) fail("post-check: registeredBusinesses is still false");
console.log(`OK: registeredBusinesses=${registered}, tier=${tier} — the account can now initiate payments.`);
