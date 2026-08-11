/**
 * Pins TREASURY_INTERFACE against the compiled MultiSigTreasury artifact.
 *
 * The fragments in treasury-chain.ts are written by hand, matching the
 * COMPLIANCE_INTERFACE idiom. That is fine for a handful of calls, but a
 * hand-written fragment is a claim about the contract that nothing verifies:
 * TypeScript sees a string, and ethers only discovers the mismatch when a call
 * decodes. For a struct-returning view like getProposal the failure is silent
 * rather than loud — a tuple whose fields have drifted decodes into the wrong
 * positions and yields plausible nonsense.
 *
 * The frontend hit exactly this in TerraQura: a getMetadata tuple three fields
 * short of the real struct, surfacing as "Bytes value 97 is not a valid
 * boolean" from deep inside the decoder. This test makes that class of drift a
 * build failure here.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Fragment, Interface } from "ethers";

import { TREASURY_INTERFACE } from "../../services/treasury-chain";

const ARTIFACT = join(
  process.cwd(),
  "..",
  "contracts",
  "artifacts",
  "src",
  "MultiSigTreasury.sol",
  "MultiSigTreasury.json",
);

// Artifacts are built, not committed. Fail with the command to run rather than
// skipping: a drift guard that quietly skips when its input is missing is not a
// guard, and "0 tests run" reads the same as "all tests passed" in CI output.
if (!existsSync(ARTIFACT)) {
  throw new Error(
    `MultiSigTreasury artifact not found at ${ARTIFACT}.\n` +
      `Compile the contracts before running backend tests:\n` +
      `  (cd contracts && npx hardhat compile)`,
  );
}

describe("TREASURY_INTERFACE", () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
    abi: unknown[];
  };
  const compiled = new Interface(artifact.abi as never);

  const declared = TREASURY_INTERFACE.fragments.filter(
    (f): f is Fragment => f.type === "function" || f.type === "event",
  );

  it("declares at least the calls the service makes", () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it.each(declared.map((f) => [f.format("sighash"), f] as const))(
    "%s matches the compiled contract",
    (_sig, fragment) => {
      // format("full") normalises names and types, so a mismatch in field
      // order, arity or type shows up as unequal strings rather than as a
      // runtime decode error later.
      const match = compiled.fragments.find(
        (c) =>
          c.type === fragment.type &&
          c.format("sighash") === fragment.format("sighash"),
      );
      expect(match).toBeDefined();
      expect(match?.format("full")).toBe(fragment.format("full"));
    },
  );

  it("covers every call the service issues", () => {
    // Guards the reverse direction: a call added to the service without a
    // fragment would throw at runtime on the first request.
    const required = [
      "getSignerConfig",
      "getSigners",
      "getActiveBudgets",
      "getProposal",
      "getBudget",
      "SMALL_TX_THRESHOLD",
      "LARGE_TX_THRESHOLD",
      "STANDARD_TIMELOCK",
      "LARGE_TIMELOCK",
      "EMERGENCY_TIMELOCK",
    ];
    for (const name of required) {
      expect(() => TREASURY_INTERFACE.getFunction(name)).not.toThrow();
    }
    expect(() => TREASURY_INTERFACE.getEvent("ProposalCreated")).not.toThrow();
  });
});
