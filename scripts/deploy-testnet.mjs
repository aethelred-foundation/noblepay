#!/usr/bin/env node
/**
 * NoblePay testnet deployment — core payment router + seal-anchored
 * settlement gate, wired.
 *
 * Deploys (or reuses) the two contracts the public-testnet handoff covers and
 * performs the wiring the enforced invariants depend on:
 *
 *   1. preflight — chain id must match EXPECT_CHAIN_ID (default 7332) and the
 *      deployer must be funded
 *   2. deploy NoblePay(admin = deployer, TREASURY, BASE_FEE, PERCENTAGE_FEE)
 *      (or reuse NOBLEPAY_ADDRESS)
 *   3. deploy SealSettlementGate(governance = deployer) from the reviewed
 *      creation bytecode (or reuse GATE_ADDRESS)
 *   4. wire core → gate: noblepay.setSealGate(gate)
 *   5. optional: ENABLE_SEAL_CLEARANCE=true turns settlement enforcement on
 *      (default OFF — enable once the ISeal precompile and PoUW pipeline are
 *      confirmed live, mirroring the handoff checklist)
 *   6. optional: ZEROID_REGISTRY=0x… enables the ZeroID identity layer on the
 *      gate (both corridor parties must hold ACTIVE identities)
 *
 * Prints the frontend (.env.local) and manifest lines to record, in the same
 * shape as the deploy output of the sibling dApps.
 *
 * Env: DEPLOYER_KEY (required; funded, becomes admin + governance),
 *      RPC_URL (default http://127.0.0.1:8545), EXPECT_CHAIN_ID (default 7332),
 *      TREASURY (default deployer), BASE_FEE (default 1000000),
 *      PERCENTAGE_FEE (basis points, default 50 = 0.5%, max 500),
 *      NOBLEPAY_ADDRESS / GATE_ADDRESS (reuse instead of deploying),
 *      ENABLE_SEAL_CLEARANCE=true, ZEROID_REGISTRY=0x…
 *
 * Artifacts: NoblePay from contracts/artifacts (tracked; run
 * `cd contracts && npx hardhat compile` if missing), the gate from
 * scripts/artifacts/SealSettlementGate.{bin,abi} (the reviewed build).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  encodeFunctionData,
  formatEther,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gateArtifactsDir = join(__dirname, "artifacts");
const coreArtifactPath = join(
  __dirname,
  "..",
  "contracts",
  "artifacts",
  "src",
  "NoblePay.sol",
  "NoblePay.json",
);

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const EXPECT_CHAIN_ID = Number(process.env.EXPECT_CHAIN_ID ?? "7332");
const BASE_FEE = BigInt(process.env.BASE_FEE ?? "1000000");
const PERCENTAGE_FEE = BigInt(process.env.PERCENTAGE_FEE ?? "50");
const ENABLE_SEAL_CLEARANCE = process.env.ENABLE_SEAL_CLEARANCE === "true";
const ZEROID_REGISTRY = process.env.ZEROID_REGISTRY ?? "";

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n== ${msg}`);

if (!DEPLOYER_KEY) {
  fail(
    "DEPLOYER_KEY is required (0x-prefixed hex; funded account — becomes NoblePay admin/treasury-role holder and gate governance).",
  );
}
if (PERCENTAGE_FEE > 500n) {
  fail("PERCENTAGE_FEE must be <= 500 basis points (contract MAX_PERCENTAGE_FEE).");
}

const coreArtifact = JSON.parse(readFileSync(coreArtifactPath, "utf8"));
const gateAbi = JSON.parse(
  readFileSync(join(gateArtifactsDir, "SealSettlementGate.abi"), "utf8"),
);
const gateBytecode = `0x${readFileSync(
  join(gateArtifactsDir, "SealSettlementGate.bin"),
  "utf8",
).trim()}`;

const chain = defineChain({
  id: EXPECT_CHAIN_ID,
  name: "Aethelred Testnet",
  nativeCurrency: { name: "AETHEL", symbol: "AETHEL", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const account = privateKeyToAccount(DEPLOYER_KEY);
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const walletClient = createWalletClient({
  account,
  chain,
  transport: http(RPC_URL),
});

const TREASURY = process.env.TREASURY ?? account.address;

// Same gas policy as the corridor playbook: estimation stays on the path
// (a disallowed call throws instead of mining a failed tx) with 2x headroom,
// floored to cover estimates that momentarily lag just-committed state.
const FLOOR_WRITE = 800_000n;
const FLOOR_DEPLOY = 6_000_000n;
const withHeadroom = (estimate, floor) => {
  const doubled = estimate * 2n;
  return doubled > floor ? doubled : floor;
};

// The node's query state can lag a just-committed deploy by a moment: a
// simulate/estimate issued immediately after the receipt then executes
// against pre-deploy state and dies with an empty-reason revert (observed on
// the public testnet: `wire core -> gate` failing right after both deploys,
// while the same call succeeds seconds later). Wait until the code is
// actually visible to queries before touching a fresh contract.
async function waitForContractCode(label, address) {
  for (let i = 0; i < 30; i++) {
    const code = await publicClient.getCode({ address });
    if (code && code !== "0x") return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`${label} code never became visible at ${address} — node state lag`);
}

async function deployContract(label, { abi, bytecode, args }) {
  const data = encodeDeployData({ abi, bytecode, args });
  const estimate = await publicClient.estimateGas({
    account: account.address,
    data,
  });
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args,
    gas: withHeadroom(estimate, FLOOR_DEPLOY),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    fail(`${label} deployment reverted (tx ${hash})`);
  }
  console.log(
    `  ${label.padEnd(18)} ${receipt.contractAddress}  (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`,
  );
  await waitForContractCode(label, receipt.contractAddress);
  return receipt.contractAddress;
}

// A revert that decodes to a named error is a real refusal; a revert with NO
// decodable reason immediately after deploys is the state-lag transient
// described above and is worth a short retry before giving up. viem nests the
// useful fields at varying depths, so walk the cause chain.
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
      await publicClient.simulateContract({
        account,
        address,
        abi,
        functionName,
        args,
      });
      const estimate = await publicClient.estimateGas({
        account: account.address,
        to: address,
        data: encodeFunctionData({ abi, functionName, args }),
      });
      gas = withHeadroom(estimate, FLOOR_WRITE);
      break;
    } catch (err) {
      // A decoded custom error is a real refusal — stop immediately. An
      // empty-reason revert right after deploys is the node's post-deploy
      // simulation flake: retry briefly, then send anyway with the floor gas
      // and let the RECEIPT decide — real execution runs against committed
      // state (verified: the same call succeeds via eth_call moments later),
      // and a genuine refusal still fails loudly via receipt.status below.
      if (!isEmptyReasonRevert(err)) throw err;
      if (attempt < 4) {
        console.log(
          `  ${functionName}: empty-reason revert in simulation (node flake) — retry ${attempt}/3 in 2s`,
        );
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      console.log(
        `  ${functionName}: simulation still flaking — sending with floor gas ${FLOOR_WRITE} and trusting the receipt`,
      );
    }
  }
  const hash = await walletClient.writeContract({
    address,
    abi,
    functionName,
    args,
    gas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    fail(`${functionName} reverted (tx ${hash})`);
  }
}

async function main() {
  step("preflight");
  const chainId = await publicClient.getChainId();
  if (chainId !== EXPECT_CHAIN_ID) {
    fail(
      `connected chain id ${chainId} != expected ${EXPECT_CHAIN_ID} (set EXPECT_CHAIN_ID to override deliberately)`,
    );
  }
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance === 0n) {
    fail(`deployer ${account.address} has zero balance — fund it first`);
  }
  console.log(
    `  chain ${chainId} ✓  deployer ${account.address}  balance ${formatEther(balance)} AETHEL`,
  );

  step(
    `deploy (treasury ${TREASURY}, baseFee ${BASE_FEE}, percentageFee ${PERCENTAGE_FEE} bps)`,
  );
  const noblepay =
    process.env.NOBLEPAY_ADDRESS ??
    (await deployContract("NoblePay", {
      abi: coreArtifact.abi,
      bytecode: coreArtifact.bytecode,
      args: [account.address, TREASURY, BASE_FEE, PERCENTAGE_FEE],
    }));
  if (process.env.NOBLEPAY_ADDRESS) {
    console.log(`  NoblePay           ${noblepay}  (reused)`);
  }

  const gate =
    process.env.GATE_ADDRESS ??
    (await deployContract("SealSettlementGate", {
      abi: gateAbi,
      bytecode: gateBytecode,
      args: [account.address],
    }));
  if (process.env.GATE_ADDRESS) {
    console.log(`  SealSettlementGate ${gate}  (reused)`);
  }

  step("wire core -> gate");
  await writeTo(noblepay, coreArtifact.abi, "setSealGate", [gate]);
  if (ENABLE_SEAL_CLEARANCE) {
    await writeTo(noblepay, coreArtifact.abi, "setSealClearanceRequired", [
      true,
    ]);
    console.log("  seal clearance enforcement ENABLED");
  } else {
    console.log(
      "  seal clearance enforcement left OFF (set ENABLE_SEAL_CLEARANCE=true once the ISeal precompile + PoUW pipeline are confirmed live)",
    );
  }
  if (ZEROID_REGISTRY) {
    await writeTo(gate, gateAbi, "setIdentityRegistry", [
      ZEROID_REGISTRY,
      true,
    ]);
    console.log(`  ZeroID identity layer ENABLED (registry ${ZEROID_REGISTRY})`);
  }

  step("sanity");
  const [wiredGate, clearanceRequired, gateOwner] = await Promise.all([
    publicClient.readContract({
      address: noblepay,
      abi: coreArtifact.abi,
      functionName: "sealGate",
    }),
    publicClient.readContract({
      address: noblepay,
      abi: coreArtifact.abi,
      functionName: "sealClearanceRequired",
    }),
    publicClient.readContract({
      address: gate,
      abi: gateAbi,
      functionName: "owner",
    }),
  ]);
  if (wiredGate.toLowerCase() !== gate.toLowerCase()) {
    fail(`sealGate() reads ${wiredGate}, expected ${gate}`);
  }
  console.log(
    `  wiring ✓  sealClearanceRequired ${clearanceRequired}  gate owner ${gateOwner}`,
  );

  step("paste into .env.local (frontend)");
  console.log(`NEXT_PUBLIC_NOBLEPAY_ADDRESS=${noblepay}`);

  step("deployment manifest (handoff §7)");
  console.log(`gate.address                = ${gate}`);
  console.log(`gate.owner                  = ${gateOwner}`);
  console.log(`core.address                = ${noblepay}`);
  console.log(`core.sealGate               = ${wiredGate}`);
  console.log(`core.sealClearanceRequired  = ${clearanceRequired}`);
  console.log(`chain.eth_chainId           = ${chainId}`);
  console.log(
    `\ngovernance/admin: ${account.address} (deployer)\ntreasury: ${TREASURY}`,
  );
  console.log(
    "\nnext: run the corridor playbook (scripts/devnet-seal-settlement-e2e.mjs) with GATE_ADDRESS to prove no-seal-no-clearance and mint the first corridor seal.",
  );
}

main().catch((error) => {
  fail(error?.shortMessage ?? error?.message ?? String(error));
});
