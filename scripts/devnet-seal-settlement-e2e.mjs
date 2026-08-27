#!/usr/bin/env node
/**
 * NoblePay seal-anchored corridor clearance E2E — the consensus-anchored
 * settlement gate, live.
 *
 * Proves the settlement control no allowlist or off-chain screening oracle can
 * offer: a cross-border corridor (payer → payee) is cleared for settlement only
 * when a Digital Seal minted by the chain's own attested-compute (PoUW) pipeline
 * exists, is ACTIVE, is bound to THIS exact payer → payee pair, and satisfies
 * the CEAP policy — all checked by consensus logic via the ISeal precompile
 * (0x0900):
 *
 *   1. deploy SealSettlementGate(governance) (or reuse GATE_ADDRESS)
 *   2. governance sets the CEAP policy (tee backend, AE residency)
 *   3. isCleared(payer, payee) === false — no seal yet, corridor closed
 *   4. a PoUW screening job runs on-chain with purpose
 *      `noblepay:0x<payer>:0x<payee>` → validators verify → quorum mints the
 *      Digital Seal (driven by the operator via the aethelredd CLI; this script
 *      prints the exact command, including the contract's own expectedPurpose())
 *   5. clear(payer, payee, JOB_ID) verifies the seal via ISeal (ACTIVE +
 *      corridor-bound + CEAP policy satisfied) and records the clearance;
 *      isCleared flips true
 *
 * This is an operator playbook: it automates every EVM-side step and, when the
 * PoUW seal is ready, pass its JOB_ID to complete the corridor clearance.
 * Without JOB_ID it stops after proving no-seal-no-clearance and printing the
 * mint command.
 *
 * Contract provenance: this deploys the exact reviewed creation bytecode
 * (scripts/artifacts/SealSettlementGate.bin) — the same artifact the chain repo
 * runs against the REAL ISeal precompile + a real seal keeper in
 * internal/evmhost/noblepay_test.go (the definitive seal-binding proof, incl.
 * direction sensitivity, jurisdiction policy, live revocation and clearance
 * permanence). This script is the live-node counterpart.
 *
 * Env: DEPLOYER_KEY (funded; also governance), RPC_URL (default
 *      http://127.0.0.1:8545), GATE_ADDRESS (optional; deploys if unset),
 *      PAYER (optional; default = deployer), PAYEE (the corridor counterparty;
 *      default = deployer for a self-corridor smoke test — set a distinct payee
 *      for a realistic corridor), JOB_ID (completed PoUW screening job).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const artifactsDir = join(__dirname, "artifacts");

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const JOB_ID = process.env.JOB_ID ?? "";

if (!DEPLOYER_KEY) {
  console.error(
    "DEPLOYER_KEY is required (funded account; also used as governance).",
  );
  process.exit(2);
}

const abi = JSON.parse(
  readFileSync(join(artifactsDir, "SealSettlementGate.abi"), "utf8"),
);
const bytecode = `0x${readFileSync(
  join(artifactsDir, "SealSettlementGate.bin"),
  "utf8",
).trim()}`;
if (bytecode.length < 4) {
  console.error(
    "No creation bytecode in scripts/artifacts/SealSettlementGate.bin",
  );
  process.exit(2);
}

const chain = defineChain({
  id: 7332,
  name: "Aethelred Devnet",
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

const PAYER = (process.env.PAYER ?? account.address).toLowerCase();
const PAYEE = (process.env.PAYEE ?? account.address).toLowerCase();

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n== ${msg}`);

let GATE_ADDRESS = process.env.GATE_ADDRESS;

// Aethelred's cosmos/evm EVM charges max(actualGas, gasLimit/2) — a refund of
// more than half the gas limit is capped — so an over-large fixed limit
// overpays (e.g. a 3M limit is billed 1.5M even for a ~130k call). Its
// eth_estimateGas is accurate for settled state, so the limit is 2x the estimate
// (the fee stays at the true cost, with 100% headroom), floored for safety.
// Keeping estimation on the path makes a disallowed call throw here rather than
// mine a failed tx; the floor covers the window where the estimate momentarily
// lags just-committed state (e.g. right after a deploy) and would under-shoot.
// WRITE_GAS/DEPLOY_GAS override the estimate entirely if ever needed.
const WRITE_GAS = process.env.WRITE_GAS ? BigInt(process.env.WRITE_GAS) : null;
const DEPLOY_GAS = process.env.DEPLOY_GAS
  ? BigInt(process.env.DEPLOY_GAS)
  : null;
const FLOOR_WRITE = 800_000n;
const FLOOR_DEPLOY = 6_000_000n;
const withHeadroom = (estimate, floor) => {
  const doubled = estimate * 2n;
  return doubled > floor ? doubled : floor;
};

async function write(functionName, args = []) {
  const gas =
    WRITE_GAS ??
    withHeadroom(
      await publicClient.estimateContractGas({
        address: GATE_ADDRESS,
        abi,
        functionName,
        args,
        account,
      }),
      FLOOR_WRITE,
    );
  const hash = await walletClient.writeContract({
    address: GATE_ADDRESS,
    abi,
    functionName,
    args,
    gas,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 60_000,
  });
  if (receipt.status !== "success") fail(`${functionName} reverted on-chain`);
  return receipt;
}

const read = (functionName, args = []) =>
  publicClient.readContract({
    address: GATE_ADDRESS,
    abi,
    functionName,
    args,
  });

async function main() {
  step("chain identity");
  const chainId = await publicClient.getChainId();
  if (chainId !== 7332) fail(`chain id ${chainId}, want 7332`);
  console.log(`eth_chainId: ${chainId}`);
  console.log(`payer: ${PAYER}`);
  console.log(`payee: ${PAYEE}`);

  if (!GATE_ADDRESS) {
    step("deploy SealSettlementGate(governance = deployer)");
    const deployGas =
      DEPLOY_GAS ??
      withHeadroom(
        await publicClient.estimateGas({
          account,
          data: encodeDeployData({ abi, bytecode, args: [account.address] }),
        }),
        FLOOR_DEPLOY,
      );
    const hash = await walletClient.deployContract({
      abi,
      bytecode,
      args: [account.address],
      gas: deployGas,
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: 60_000,
    });
    if (receipt.status !== "success" || !receipt.contractAddress) {
      fail("deployment reverted");
    }
    GATE_ADDRESS = receipt.contractAddress;
    console.log(`deployed at ${GATE_ADDRESS}`);
  } else {
    console.log(`\nusing GATE_ADDRESS ${GATE_ADDRESS}`);
  }

  step("governance: set CEAP policy (tee backend, AE residency)");
  await write("setCompliancePolicy", [["tee"], "", [], false, ["AE"]]);
  const policy = await read("compliancePolicy");
  console.log(
    `policy read-back: backends=${JSON.stringify(policy[0])} residency=${JSON.stringify(policy[4])}`,
  );

  step("no seal yet: isCleared must be false");
  const before = await read("isCleared", [PAYER, PAYEE]);
  if (before) fail("corridor cleared before any seal — gate is not closed");
  console.log("isCleared = false (no consensus anchor) ✓");

  // The contract itself is the source of truth for the required purpose string.
  const expected = await read("expectedPurpose", [PAYER, PAYEE]);

  if (!JOB_ID) {
    step("mint the backing seal (operator step)");
    console.log(
      "Run a PoUW screening job whose purpose binds this payer → payee corridor,",
    );
    console.log("then re-run with JOB_ID set:\n");
    console.log(
      `  aethelredd tx pouw register-model --model noblepay-screen-v1 --model-id noblepay-screen \\\n` +
        `    --from validator --chain-id <id> --keyring-backend test --yes`,
    );
    console.log(
      `  aethelredd tx pouw submit-job --model noblepay-screen-v1 --input corridor-${PAYER}-${PAYEE} \\\n` +
        `    --proof-type tee --purpose "${expected}" \\\n` +
        `    --conf-backends tee --conf-residency AE \\\n` +
        `    --from validator --chain-id <id> --keyring-backend test --yes`,
    );
    console.log(
      `\nWait for the quorum-minted seal, then:\n  JOB_ID=<job-id> GATE_ADDRESS=${GATE_ADDRESS} \\\n` +
        `    PAYER=${PAYER} PAYEE=${PAYEE} DEPLOYER_KEY=<key> \\\n` +
        `    node scripts/devnet-seal-settlement-e2e.mjs`,
    );
    console.log(
      "\nGATE PROVEN CLOSED. Provide JOB_ID to complete consensus-anchored clearance.",
    );
    return;
  }

  step(
    `clear(payer, payee, ${JOB_ID}) — verify seal via ISeal + record clearance`,
  );
  await write("clear", [PAYER, PAYEE, JOB_ID]);
  const after = await read("isCleared", [PAYER, PAYEE]);
  if (!after) fail("corridor not cleared after clear()");
  console.log("isCleared = true (anchored to Digital Seal) ✓");

  step("requireCleared must not revert for the anchored corridor");
  await read("requireCleared", [PAYER, PAYEE]);
  console.log("requireCleared passed ✓");

  console.log(
    "\nCONSENSUS-ANCHORED SETTLEMENT LIVE: no seal → no clearance; " +
      "quorum-minted, corridor-bound, policy-satisfying seal → clearance. " +
      "Revoke the seal on-chain and isCleared flips false with no NoblePay tx.",
  );
}

main().catch((e) => fail(e.shortMessage ?? e.message ?? String(e)));
