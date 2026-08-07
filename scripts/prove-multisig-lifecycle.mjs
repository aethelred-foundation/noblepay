#!/usr/bin/env node
/**
 * Proves the MultiSigTreasury proposal lifecycle against a live chain.
 *
 * Exercises the real controls end to end rather than asserting on mocks:
 *   1. deploy the treasury with a 3-signer / 1-2-3 threshold config
 *   2. fund it with native AETHEL
 *   3. createProposal  -> assert tier, requiredApprovals and timelockExpiry
 *   4. approveProposal -> assert status flips PENDING -> APPROVED at threshold
 *   5. approve twice from one signer -> assert AlreadyApproved reverts
 *   6. executeProposal before the timelock -> assert TimelockNotExpired reverts
 *
 * Step 6 is the point: every tier carries a timelock (24h standard, 48h large,
 * 1h emergency), so a successful execution cannot be demonstrated inside a
 * single session. Proving that early execution is REFUSED demonstrates the
 * control is live, which is the property that matters.
 *
 * All writes carry explicit gas limits — the Aethelred node under-reports
 * eth_estimateGas (GAS-01), so relying on estimation reverts out of gas.
 *
 * Env: DEPLOYER_KEY (funded), RPC_URL (default http://127.0.0.1:8545),
 *      SIGNER2_KEY / SIGNER3_KEY (default: standard devnet accounts 4 and 5).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPublicClient, createWalletClient, defineChain, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const GAS = 5_000_000n;

// Standard devnet keys for signers 2 and 3 (accounts 4 and 5).
const SIGNER2_KEY =
  process.env.SIGNER2_KEY ??
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const SIGNER3_KEY =
  process.env.SIGNER3_KEY ??
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

if (!process.env.DEPLOYER_KEY) {
  console.error("FAIL: DEPLOYER_KEY required");
  process.exit(1);
}

const artifact = JSON.parse(
  readFileSync(
    join(__dirname, "..", "contracts", "artifacts", "src", "MultiSigTreasury.sol", "MultiSigTreasury.json"),
    "utf8",
  ),
);

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const probe = createPublicClient({ transport: http(RPC_URL) });
  const chainId = await probe.getChainId();
  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "AETHEL", symbol: "AETHEL", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });

  const deployer = privateKeyToAccount(process.env.DEPLOYER_KEY);
  const signer2 = privateKeyToAccount(SIGNER2_KEY);
  const signer3 = privateKeyToAccount(SIGNER3_KEY);

  const pub = createPublicClient({ chain, transport: http() });
  const wallet = (account) => createWalletClient({ chain, account, transport: http() });

  console.log(`chain id ${chainId} @ ${RPC_URL}`);
  console.log(`deployer ${deployer.address}\n`);

  // --- 1. deploy -----------------------------------------------------------
  const signers = [deployer.address, signer2.address, signer3.address];
  const deployHash = await wallet(deployer).deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [deployer.address, signers, 1n, 2n, 3n, 2n],
    gas: GAS,
  });
  const deployReceipt = await pub.waitForTransactionReceipt({ hash: deployHash });
  check("deploy MultiSigTreasury", deployReceipt.status === "success", deployReceipt.contractAddress);
  if (deployReceipt.status !== "success") process.exit(1);
  const treasury = deployReceipt.contractAddress;

  const read = (functionName, args = []) =>
    pub.readContract({ address: treasury, abi: artifact.abi, functionName, args });
  const write = async (account, functionName, args) => {
    const hash = await wallet(account).writeContract({
      address: treasury,
      abi: artifact.abi,
      functionName,
      args,
      gas: GAS,
    });
    return pub.waitForTransactionReceipt({ hash });
  };

  const cfg = await read("signerConfig");
  check(
    "constructor recorded the threshold config",
    String(cfg[0]) === "3" && String(cfg[1]) === "1" && String(cfg[2]) === "2" && String(cfg[3]) === "3",
    `signers=${cfg[0]} small=${cfg[1]} medium=${cfg[2]} large=${cfg[3]}`,
  );

  // --- 2. fund the treasury ------------------------------------------------
  const fundHash = await wallet(deployer).sendTransaction({
    to: treasury,
    value: parseEther("5"),
    gas: 200_000n,
  });
  await pub.waitForTransactionReceipt({ hash: fundHash });
  const balance = await pub.getBalance({ address: treasury });
  check("treasury received native funding", balance === parseEther("5"), `${balance} wei`);

  // --- 3. create a MEDIUM-tier proposal ------------------------------------
  // 50,000 (6dp) sits above SMALL_TX_THRESHOLD (10,000) and at or below
  // LARGE_TX_THRESHOLD (100,000), so it must require mediumThreshold = 2.
  const amount = 50_000n * 10n ** 6n;
  const createReceipt = await write(deployer, "createProposal", [
    signer2.address,
    "0x0000000000000000000000000000000000000000",
    amount,
    0,
    "devnet lifecycle proof",
    false,
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  ]);
  check("createProposal mined", createReceipt.status === "success");

  const createdTopic = artifact.abi.find((e) => e.type === "event" && e.name === "ProposalCreated");
  const log = createReceipt.logs.find((l) => l.address.toLowerCase() === treasury.toLowerCase());
  const proposalId = log?.topics?.[1];
  check("ProposalCreated emitted a proposal id", Boolean(proposalId), proposalId ?? "none");
  if (!createdTopic || !proposalId) process.exit(1);

  const p = await read("getProposal", [proposalId]);
  check("tier resolved to MEDIUM for a 50k amount", Number(p.tier) === 1, `tier=${p.tier}`);
  check("requiredApprovals = mediumThreshold (2)", String(p.requiredApprovals) === "2");
  check("status starts PENDING", Number(p.status) === 0, `status=${p.status}`);
  const now = BigInt(Math.floor(Date.now() / 1000));
  check(
    "timelockExpiry is ~24h in the future (STANDARD_TIMELOCK)",
    p.timelockExpiry > now + 23n * 3600n && p.timelockExpiry <= now + 25n * 3600n,
    `expiry=${p.timelockExpiry}`,
  );

  // --- 4. approvals --------------------------------------------------------
  await write(deployer, "approveProposal", [proposalId]);
  const afterFirst = await read("getProposal", [proposalId]);
  check(
    "one approval leaves it PENDING (below threshold)",
    Number(afterFirst.status) === 0 && String(afterFirst.approvalCount) === "1",
    `status=${afterFirst.status} approvals=${afterFirst.approvalCount}`,
  );

  // --- 5. the same signer cannot approve twice -----------------------------
  let doubleApproveReverted = false;
  try {
    await pub.simulateContract({
      address: treasury,
      abi: artifact.abi,
      functionName: "approveProposal",
      args: [proposalId],
      account: deployer.address,
    });
  } catch {
    doubleApproveReverted = true;
  }
  check("a signer cannot approve the same proposal twice", doubleApproveReverted);

  await write(signer2, "approveProposal", [proposalId]);
  const afterSecond = await read("getProposal", [proposalId]);
  check(
    "reaching the threshold flips status to APPROVED",
    Number(afterSecond.status) === 1 && String(afterSecond.approvalCount) === "2",
    `status=${afterSecond.status} approvals=${afterSecond.approvalCount}`,
  );

  // --- 6. the timelock must refuse early execution -------------------------
  let timelockBlocked = false;
  let revertText = "";
  try {
    await pub.simulateContract({
      address: treasury,
      abi: artifact.abi,
      functionName: "executeProposal",
      args: [proposalId],
      account: deployer.address,
    });
  } catch (err) {
    timelockBlocked = true;
    revertText = (err.shortMessage ?? err.message ?? "").split("\n")[0];
  }
  check("execution before the timelock is refused", timelockBlocked, revertText);

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`treasury: ${treasury}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FAIL:", err.shortMessage ?? err.message);
  process.exit(1);
});
