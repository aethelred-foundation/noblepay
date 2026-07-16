#!/usr/bin/env node
/**
 * NoblePay testnet ERC-20 setup — deploy a mock stablecoin, list it as a
 * supported payment token, mint test balance, and grant the allowance.
 *
 * IMPORTANT — NoblePay holds no float and takes no deposits, by design:
 *   - Native AETHEL is escrowed per payment via msg.value on initiatePayment.
 *   - ERC-20 amounts are pulled per payment via transferFrom, which needs an
 *     ALLOWANCE (token.approve(noblepay, …)) from the payer — not a deposit.
 *   - A plain transfer of AETHEL or tokens to the contract address is
 *     unrecoverable and native transfers now revert outright (no receive()).
 *
 * Steps:
 *   1. preflight — chain id must match EXPECT_CHAIN_ID, deployer funded
 *   2. deploy MockERC20(NAME, SYMBOL, DECIMALS) (or reuse TOKEN_ADDRESS)
 *   3. noblepay.setSupportedToken(token, true)   [ADMIN_ROLE]
 *   4. token.mint(MINT_TO, MINT_AMOUNT whole units)
 *   5. if MINT_TO is the deployer: token.approve(noblepay, unlimited);
 *      otherwise print the exact approve() call for the holder's wallet
 *
 * Env: DEPLOYER_KEY (required; the NoblePay ADMIN_ROLE holder),
 *      NOBLEPAY_ADDRESS (required), RPC_URL (default http://127.0.0.1:8545),
 *      EXPECT_CHAIN_ID (default 7332), TOKEN_ADDRESS (reuse), NAME ("USD Coin"),
 *      SYMBOL ("USDC"), DECIMALS ("6"), MINT_TO (default deployer),
 *      MINT_AMOUNT (whole tokens, default "1000000")
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
  maxUint256,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tokenArtifactPath = join(
  __dirname, "..", "contracts", "artifacts", "src", "MockERC20.sol", "MockERC20.json",
);

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const EXPECT_CHAIN_ID = Number(process.env.EXPECT_CHAIN_ID ?? "7332");
const NOBLEPAY_ADDRESS = process.env.NOBLEPAY_ADDRESS;
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS ?? "";
const NAME = process.env.NAME ?? "USD Coin";
const SYMBOL = process.env.SYMBOL ?? "USDC";
const DECIMALS = Number(process.env.DECIMALS ?? "6");
const MINT_AMOUNT = process.env.MINT_AMOUNT ?? "1000000";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n== ${msg}`);

if (!DEPLOYER_KEY) fail("DEPLOYER_KEY is required (the NoblePay ADMIN_ROLE holder)");
if (!NOBLEPAY_ADDRESS?.match(/^0x[0-9a-fA-F]{40}$/)) {
  fail("NOBLEPAY_ADDRESS must be the deployed NoblePay 0x address");
}

const tokenArtifact = JSON.parse(readFileSync(tokenArtifactPath, "utf8"));
const NOBLEPAY_MIN_ABI = [
  { name: "setSupportedToken", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "_token", type: "address" }, { name: "_supported", type: "bool" }], outputs: [] },
  { name: "supportedTokens", type: "function", stateMutability: "view",
    inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
];

const chain = defineChain({
  id: EXPECT_CHAIN_ID,
  name: "Aethelred Testnet",
  nativeCurrency: { name: "AETHEL", symbol: "AETHEL", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const account = privateKeyToAccount(DEPLOYER_KEY);
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

const MINT_TO = process.env.MINT_TO ?? account.address;

const FLOOR_WRITE = 800_000n;
const FLOOR_DEPLOY = 3_000_000n;
const withHeadroom = (estimate, floor) => {
  const doubled = estimate * 2n;
  return doubled > floor ? doubled : floor;
};

// Same node-flake hardening as deploy-testnet.mjs: wait for fresh code to be
// query-visible, retry empty-reason simulation reverts, and let the receipt
// be the final judge.
async function waitForContractCode(label, address) {
  for (let i = 0; i < 30; i++) {
    const code = await publicClient.getCode({ address });
    if (code && code !== "0x") return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`${label} code never became visible at ${address} — node state lag`);
}

function isEmptyReasonRevert(err) {
  let sawRevert = false;
  let sawNamedReason = false;
  for (let e = err; e; e = e.cause) {
    if (e.data?.errorName || e.reason) sawNamedReason = true;
    const msg = String(e.shortMessage ?? e.message ?? "");
    if (/revert/i.test(msg)) sawRevert = true;
    if (/reverted with the following|custom error/i.test(msg)) sawNamedReason = true;
  }
  return sawRevert && !sawNamedReason;
}

async function writeTo(address, abi, functionName, args) {
  let gas = FLOOR_WRITE;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await publicClient.simulateContract({ account, address, abi, functionName, args });
      const estimate = await publicClient.estimateGas({
        account: account.address,
        to: address,
        data: encodeFunctionData({ abi, functionName, args }),
      });
      gas = withHeadroom(estimate, FLOOR_WRITE);
      break;
    } catch (err) {
      if (!isEmptyReasonRevert(err)) throw err;
      if (attempt < 4) {
        console.log(`  ${functionName}: empty-reason revert in simulation (node flake) — retry ${attempt}/3 in 2s`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      console.log(`  ${functionName}: simulation still flaking — sending with floor gas and trusting the receipt`);
    }
  }
  const hash = await walletClient.writeContract({ address, abi, functionName, args, gas });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") fail(`${functionName} reverted (tx ${hash})`);
}

step("preflight");
const chainId = await publicClient.getChainId();
if (chainId !== EXPECT_CHAIN_ID) fail(`chain id ${chainId} != expected ${EXPECT_CHAIN_ID}`);
const balance = await publicClient.getBalance({ address: account.address });
if (balance === 0n) fail(`deployer ${account.address} has zero balance — fund it first`);
console.log(`  chain ${chainId} ✓  admin ${account.address}  balance ${formatEther(balance)} AETHEL`);

let token = TOKEN_ADDRESS;
if (token) {
  const code = await publicClient.getCode({ address: token });
  if (!code || code === "0x") fail(`TOKEN_ADDRESS ${token} has no code on this chain`);
  console.log(`  token ${token} (reused)`);
} else {
  step(`deploy MockERC20 ("${NAME}", ${SYMBOL}, ${DECIMALS})`);
  const hash = await walletClient.deployContract({
    abi: tokenArtifact.abi,
    bytecode: tokenArtifact.bytecode,
    args: [NAME, SYMBOL, DECIMALS],
    gas: FLOOR_DEPLOY,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) fail(`token deployment reverted (tx ${hash})`);
  token = receipt.contractAddress;
  console.log(`  ${SYMBOL.padEnd(18)} ${token}  (block ${receipt.blockNumber})`);
  await waitForContractCode(SYMBOL, token);
}

step("list token as a supported payment token");
await writeTo(NOBLEPAY_ADDRESS, NOBLEPAY_MIN_ABI, "setSupportedToken", [token, true]);
const listed = await publicClient.readContract({
  address: NOBLEPAY_ADDRESS, abi: NOBLEPAY_MIN_ABI, functionName: "supportedTokens", args: [token],
});
if (!listed) fail("supportedTokens readback is false after setSupportedToken");
console.log(`  supportedTokens(${token}) = true ✓`);

step(`mint ${MINT_AMOUNT} ${SYMBOL} to ${MINT_TO}`);
const amount = parseUnits(MINT_AMOUNT, DECIMALS);
await writeTo(token, tokenArtifact.abi, "mint", [MINT_TO, amount]);
const minted = await publicClient.readContract({
  address: token, abi: tokenArtifact.abi, functionName: "balanceOf", args: [MINT_TO],
});
console.log(`  balanceOf(${MINT_TO}) = ${minted} (${DECIMALS}dp units)`);

step("allowance (approve — this is NOT a deposit; funds stay in the holder's wallet)");
if (MINT_TO.toLowerCase() === account.address.toLowerCase()) {
  await writeTo(token, tokenArtifact.abi, "approve", [NOBLEPAY_ADDRESS, maxUint256]);
  console.log(`  approve(${NOBLEPAY_ADDRESS}, unlimited) from ${account.address} ✓`);
} else {
  console.log("  MINT_TO is not the admin key — the HOLDER must approve from their own wallet:");
  console.log(`    token:   ${token}`);
  console.log(`    method:  approve(address spender, uint256 amount)`);
  console.log(`    spender: ${NOBLEPAY_ADDRESS}`);
  console.log(`    or send this calldata to the token from the holder's wallet:`);
  console.log(`    ${encodeFunctionData({ abi: tokenArtifact.abi, functionName: "approve", args: [NOBLEPAY_ADDRESS, maxUint256] })}`);
}

step("paste into .env.local (frontend, then rebuild)");
console.log(`NEXT_PUBLIC_${SYMBOL.toUpperCase()}_TOKEN_ADDRESS=${token}`);
console.log(
  "\nReminder: never transfer AETHEL or tokens directly to the NoblePay address —\n"
  + "escrow travels with each payment (msg.value for AETHEL, transferFrom for\n"
  + "tokens) and direct transfers are unrecoverable.",
);
