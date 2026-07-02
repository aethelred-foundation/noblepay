import { network } from "hardhat";

const { ethers } = await network.connect();

/**
 * NoblePay seal-gated settlement E2E — the consensus-anchored corridor, live.
 *
 * Proves the settlement flow no oracle-key payment rail can offer: funds exit
 * escrow only when a Digital Seal minted by the chain's own attested-compute
 * (PoUW) pipeline exists for the exact payer→payee corridor, is ACTIVE, and
 * satisfies the CEAP policy — all checked by consensus logic via the ISeal
 * precompile (0x0900). A role-held TEE key alone cannot move funds:
 *
 *   1. deploy SealSettlementGate(governance) (or reuse GATE_ADDRESS)
 *   2. governance sets the CEAP policy (tee backend, AE residency)
 *   3. isCleared(payer, payee) === false — corridor closed
 *   4. a PoUW screening job runs on-chain with purpose
 *      `noblepay:0x<payer>:0x<payee>` → validators verify → quorum mints the
 *      Digital Seal (driven by the operator via the aethelredd CLI; this
 *      script prints the exact command, using the contract's own
 *      expectedPurpose())
 *   5. clear(payer, payee, JOB_ID) verifies the seal via ISeal and opens the
 *      corridor; isCleared flips true
 *
 * This is an operator playbook: it automates every EVM-side step and, when the
 * PoUW seal is ready, pass its JOB_ID to complete clearing. Without JOB_ID it
 * stops after proving corridor-closed and printing the mint command.
 *
 * The definitive seal-binding proof (real ISeal precompile + real seal keeper +
 * this exact bytecode, incl. live revocation + clearance permanence) lives in
 * the aethelred repo at internal/evmhost/noblepay_test.go — this script is the
 * live-node counterpart.
 *
 * Run (local aethelredd devnet):
 *   PAYER=0x… PAYEE=0x… [GATE_ADDRESS=0x…] [JOB_ID=<sealed-job>] \
 *   npx hardhat run scripts/devnet-seal-settlement-e2e.js
 *   (point the hardhat network config, or HARDHAT_NETWORK env, at
 *    http://127.0.0.1:8545 — chain id 7332)
 */

const GATE_ADDRESS = process.env.GATE_ADDRESS ?? "";
const JOB_ID = process.env.JOB_ID ?? "";

function step(msg) {
  console.log(`\n== ${msg}`);
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  step("chain identity");
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== 7332n)
    fail(`chain id ${chainId}, want 7332 (local aethelredd devnet)`);
  const [governance] = await ethers.getSigners();

  const PAYER = (process.env.PAYER ?? governance.address).toLowerCase();
  const PAYEE = (process.env.PAYEE ?? "").toLowerCase();
  if (!PAYEE) fail("PAYEE is required (the corridor beneficiary address)");

  console.log(`eth_chainId: ${chainId}`);
  console.log(`governance:  ${governance.address}`);
  console.log(`corridor:    ${PAYER} → ${PAYEE}`);

  const Gate = await ethers.getContractFactory("SealSettlementGate");
  let gate;
  if (GATE_ADDRESS) {
    gate = Gate.attach(GATE_ADDRESS);
    console.log(`\nusing GATE_ADDRESS ${GATE_ADDRESS}`);
  } else {
    step("deploy SealSettlementGate(governance)");
    gate = await Gate.deploy(governance.address);
    await gate.waitForDeployment();
    console.log(`deployed at ${gate.target}`);
  }

  step("governance: set CEAP policy (tee backend, AE residency)");
  await (await gate.setCompliancePolicy(["tee"], "", [], false, ["AE"])).wait();
  const policy = await gate.compliancePolicy();
  console.log(
    `policy read-back: backends=${JSON.stringify([...policy[0]])} residency=${JSON.stringify([...policy[4]])}`,
  );

  step("no seal yet: isCleared must be false");
  if (await gate.isCleared(PAYER, PAYEE)) {
    fail("corridor open before any seal — gate is not closed");
  }
  console.log("isCleared = false (corridor closed) ✓");

  // The contract itself is the source of truth for the required purpose.
  const expected = await gate.expectedPurpose(PAYER, PAYEE);

  if (!JOB_ID) {
    step("mint the backing seal (operator step)");
    console.log(
      "Run a PoUW screening job whose purpose binds this exact corridor,",
    );
    console.log("then re-run with JOB_ID set:\n");
    console.log(
      `  aethelredd tx pouw register-model --model noblepay-screening-v1 --model-id noblepay-screening \\\n` +
        `    --from validator --chain-id <id> --keyring-backend test --yes`,
    );
    console.log(
      `  aethelredd tx pouw submit-job --model noblepay-screening-v1 --input corridor-${PAYER.slice(2, 10)} \\\n` +
        `    --proof-type tee --purpose "${expected}" \\\n` +
        `    --conf-backends tee --conf-residency AE \\\n` +
        `    --from validator --chain-id <id> --keyring-backend test --yes`,
    );
    console.log(
      `\nWait for the quorum-minted seal, then:\n  JOB_ID=<job-id> GATE_ADDRESS=${gate.target} PAYER=${PAYER} PAYEE=${PAYEE} \\\n` +
        `    npx hardhat run scripts/devnet-seal-settlement-e2e.js`,
    );
    console.log(
      "\nCORRIDOR PROVEN CLOSED. Provide JOB_ID to complete consensus-anchored clearing.",
    );
    return;
  }

  step(
    `clear(payer, payee, ${JOB_ID}) — verify seal via ISeal + open corridor`,
  );
  await (await gate.clear(PAYER, PAYEE, JOB_ID)).wait();
  if (!(await gate.isCleared(PAYER, PAYEE)))
    fail("corridor not open after clear()");
  console.log("isCleared = true (anchored to Digital Seal) ✓");

  step("requireCleared must not revert for the open corridor");
  await gate.requireCleared(PAYER, PAYEE);
  console.log("requireCleared passed ✓");

  console.log(
    "\nCONSENSUS-ANCHORED SETTLEMENT LIVE: no seal → corridor closed; " +
      "quorum-minted, corridor-bound, policy-satisfying seal → corridor open. " +
      "Revoke the seal on-chain and isCleared flips false with no NoblePay tx — " +
      "wire the gate into NoblePay.setSealGate + setSealClearanceRequired(true) " +
      "to enforce it at settlement.",
  );
}

main().catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
});
