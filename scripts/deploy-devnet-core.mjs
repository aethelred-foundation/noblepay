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

/**
 * --multisig: deploys MultiSigTreasury.
 *
 * The constructor encodes a governance decision, not a devnet default: who
 * administers the treasury, which addresses may sign, and how many approvals
 * each spend tier needs. Everything is therefore env-configurable, with a
 * documented 3-signer devnet default so the contract can be exercised locally.
 *
 * Approval tiers are amount-based, denominated in 6 decimals (USDC/USDT):
 *   <= 10,000    SMALL    smallThreshold approvals,   standard timelock
 *   <= 100,000   MEDIUM   mediumThreshold approvals,  standard timelock
 *    > 100,000   LARGE    largeThreshold approvals,   48h timelock
 *
 * Constructor invariants (enforced on-chain; pre-validated here so a bad
 * config fails with a readable message instead of an opaque revert):
 *   admin != 0, signers >= 2, every signer != 0,
 *   0 < small <= medium <= large <= signerCount.
 *
 * Env:
 *   MULTISIG_ADMIN                 default: deployer
 *   MULTISIG_SIGNERS               comma-separated; default: 3 devnet accounts
 *   MULTISIG_SMALL_THRESHOLD       default: 1
 *   MULTISIG_MEDIUM_THRESHOLD      default: 2
 *   MULTISIG_LARGE_THRESHOLD       default: 3
 *   MULTISIG_EMERGENCY_THRESHOLD   default: 2
 */
async function deployMultiSigTreasury() {
  const DEFAULT_SIGNERS = [
    account.address,
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  ];

  const admin = process.env.MULTISIG_ADMIN ?? account.address;
  const signers = process.env.MULTISIG_SIGNERS
    ? process.env.MULTISIG_SIGNERS.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_SIGNERS;
  const num = (name, fallback) => BigInt(process.env[name] ?? String(fallback));
  const small = num("MULTISIG_SMALL_THRESHOLD", 1);
  const medium = num("MULTISIG_MEDIUM_THRESHOLD", 2);
  const large = num("MULTISIG_LARGE_THRESHOLD", 3);
  const emergency = num("MULTISIG_EMERGENCY_THRESHOLD", 2);

  const ZERO = "0x0000000000000000000000000000000000000000";
  if (admin === ZERO) throw new Error("MULTISIG_ADMIN must not be the zero address");
  if (signers.length < 2) throw new Error("MultiSigTreasury requires at least 2 signers");
  if (signers.some((s) => s === ZERO)) throw new Error("signer list contains the zero address");
  if (new Set(signers.map((s) => s.toLowerCase())).size !== signers.length) {
    throw new Error("signer list contains duplicates - each signer must be distinct");
  }
  if (!(small > 0n && small <= medium && medium <= large && large <= BigInt(signers.length))) {
    throw new Error(
      `invalid thresholds: need 0 < small(${small}) <= medium(${medium}) <= large(${large}) <= signers(${signers.length})`,
    );
  }

  console.log(`admin:      ${admin}`);
  console.log(`signers:    ${signers.length} - ${signers.join(", ")}`);
  console.log(`thresholds: small=${small} medium=${medium} large=${large} emergency=${emergency}`);

  const treasury = await deploy("MultiSigTreasury", [
    admin,
    signers,
    small,
    medium,
    large,
    emergency,
  ]);

  console.log("\n== NoblePay web .env.local addition");
  console.log(`NEXT_PUBLIC_MULTISIG_TREASURY_ADDRESS=${treasury}`);
  return treasury;
}

/**
 * --liquidity: deploys the LiquidityPool stack — two 6-decimal mock
 * stables minted to the deployer, the pool contract, a canonical
 * USDC/USDT pool, and the LIQUIDITY_PROVIDER_ROLE grant the deployer
 * needs to open a position from the UI.
 */
async function deployLiquidityStack() {
  const usdc = await deploy("MockERC20", ["USD Coin (devnet)", "USDC", 6]);
  const usdt = await deploy("MockERC20", ["Tether USD (devnet)", "USDT", 6]);
  const pool = await deploy("LiquidityPool", [account.address, account.address]);

  const erc20 = artifact("MockERC20").abi;
  const lp = artifact("LiquidityPool").abi;
  const write = async (address, abi, functionName, args) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args, gas: GAS });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
    return receipt;
  };

  const million = 1_000_000n * 10n ** 6n;
  await write(usdc, erc20, "mint", [account.address, million]);
  await write(usdt, erc20, "mint", [account.address, million]);

  // 0.30% swap fee, 0.09% flash fee, 50% max imbalance.
  const receipt = await write(pool, lp, "createPool", [usdc, usdt, 30n, 9n, 5000n]);
  const created = receipt.logs.find((l) => l.address.toLowerCase() === pool.toLowerCase());
  const poolId = created?.topics?.[1];
  console.log(`createPool USDC/USDT: poolId ${poolId}`);

  const providerRole = await pub.readContract({
    address: pool,
    abi: lp,
    functionName: "LIQUIDITY_PROVIDER_ROLE",
    args: [],
  });
  await write(pool, lp, "grantRole", [providerRole, account.address]);
  console.log(`LIQUIDITY_PROVIDER_ROLE granted to ${account.address}`);

  console.log("\n== NoblePay web .env.local additions");
  console.log(`NEXT_PUBLIC_LIQUIDITY_POOL_ADDRESS=${pool}`);
  console.log(`NEXT_PUBLIC_USDC_TOKEN_ADDRESS=${usdc}`);
  console.log(`NEXT_PUBLIC_USDT_TOKEN_ADDRESS=${usdt}`);
}

/**
 * --services: deploys the eight feature contracts behind the remaining
 * NoblePay pages.
 *
 * All eight take an admin, and the three that charge a protocol fee also take
 * a treasury and a fee in basis points. The fees below sit well inside each
 * contract's own ceiling rather than at it: FXHedgingVault reverts above 500,
 * InvoiceFinancing above 1000, PaymentChannels above 500. They are devnet
 * defaults — a production deploy must set them deliberately, since these are
 * commercial terms rather than configuration.
 *
 * Admin and treasury both default to the deployer because a devnet has no
 * separate governance. That is precisely the substitution a production deploy
 * must not make; SERVICE_TREASURY_ADDRESS overrides the treasury half.
 */
async function deployServiceContracts() {
  const admin = account.address;
  const treasury = process.env.SERVICE_TREASURY_ADDRESS ?? account.address;

  const FX_SETTLEMENT_FEE_BPS = 25n; // 0.25%, ceiling 500
  const INVOICE_PROTOCOL_FEE_BPS = 50n; // 0.50%, ceiling 1000
  const CHANNEL_PROTOCOL_FEE_BPS = 10n; // 0.10%, ceiling 500

  const complianceOracle = await deploy("ComplianceOracle", [admin]);
  const travelRule = await deploy("TravelRule", [admin]);
  const aiCompliance = await deploy("AIComplianceModule", [admin]);
  const streaming = await deploy("StreamingPayments", [admin]);
  const crossChain = await deploy("CrossChainRouter", [admin, treasury]);
  const fxHedging = await deploy("FXHedgingVault", [
    admin,
    treasury,
    FX_SETTLEMENT_FEE_BPS,
  ]);
  const invoiceFinancing = await deploy("InvoiceFinancing", [
    admin,
    treasury,
    INVOICE_PROTOCOL_FEE_BPS,
  ]);
  const paymentChannels = await deploy("PaymentChannels", [
    admin,
    treasury,
    CHANNEL_PROTOCOL_FEE_BPS,
  ]);

  console.log("\n== NoblePay web .env.local block (service contracts)");
  console.log(`NEXT_PUBLIC_COMPLIANCE_ORACLE_ADDRESS=${complianceOracle}`);
  console.log(`NEXT_PUBLIC_TRAVEL_RULE_ADDRESS=${travelRule}`);
  console.log(`NEXT_PUBLIC_AI_COMPLIANCE_ADDRESS=${aiCompliance}`);
  console.log(`NEXT_PUBLIC_STREAMING_PAYMENTS_ADDRESS=${streaming}`);
  console.log(`NEXT_PUBLIC_CROSS_CHAIN_ROUTER_ADDRESS=${crossChain}`);
  console.log(`NEXT_PUBLIC_FX_HEDGING_VAULT_ADDRESS=${fxHedging}`);
  console.log(`NEXT_PUBLIC_INVOICE_FINANCING_ADDRESS=${invoiceFinancing}`);
  console.log(`NEXT_PUBLIC_PAYMENT_CHANNELS_ADDRESS=${paymentChannels}`);
}

async function main() {
  if (process.argv.includes("--services")) {
    await deployServiceContracts();
    return;
  }
  if (process.argv.includes("--multisig")) {
    await deployMultiSigTreasury();
    return;
  }
  if (process.argv.includes("--liquidity")) {
    await deployLiquidityStack();
    return;
  }
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
