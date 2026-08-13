/**
 * Pins AI_INTERFACE against the compiled AIComplianceModule artifact, and the
 * chain enum orderings against the Solidity source.
 *
 * Hand-written fragments are claims about a contract, not facts. A drifted one
 * does not throw — getDecision returns a ten-field struct and getAppeal a
 * nine-field struct, so a fragment that has slipped decodes into the wrong
 * fields and yields an appeal whose reviewer, status and outcome are shuffled.
 * On an appeals pathway that means confidently reporting the wrong result of a
 * process whose whole purpose is to be contestable.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Fragment, Interface } from "ethers";

import {
  AI_INTERFACE,
  CHAIN_APPEAL_STATUS,
  CHAIN_APPEAL_STATUS_TO_DB,
  CHAIN_DECISION_OUTCOME,
  CHAIN_OUTCOME_TO_DB,
} from "../../services/ai-compliance-execution";

const ARTIFACT = join(
  process.cwd(),
  "..",
  "contracts",
  "artifacts",
  "src",
  "AIComplianceModule.sol",
  "AIComplianceModule.json",
);

if (!existsSync(ARTIFACT)) {
  throw new Error(
    `AIComplianceModule artifact not found at ${ARTIFACT}.\n` +
      `Compile the contracts before running backend tests:\n` +
      `  (cd contracts && npx hardhat compile)`,
  );
}

describe("AI_INTERFACE", () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
    abi: unknown[];
  };
  const compiled = new Interface(artifact.abi as never);

  const declared = AI_INTERFACE.fragments.filter(
    (f): f is Fragment => f.type === "function" || f.type === "event",
  );

  it.each(declared.map((f) => [f.format("sighash"), f] as const))(
    "%s matches the compiled contract",
    (_sig, fragment) => {
      const match = compiled.fragments.find(
        (c) =>
          c.type === fragment.type &&
          c.format("sighash") === fragment.format("sighash"),
      );
      expect(match).toBeDefined();
      // format("full") and not just the sighash: getDecision(bytes32) hashes
      // identically no matter what struct it returns, so a sighash-only check
      // would miss precisely the tuple drift this guard exists to catch.
      expect(match?.format("full")).toBe(fragment.format("full"));
    },
  );

  it("covers every event and call the verifiers use", () => {
    for (const name of [
      "AppealFiled",
      "AppealReviewStarted",
      "AppealResolved",
      "DecisionOverridden",
    ]) {
      expect(() => AI_INTERFACE.getEvent(name)).not.toThrow();
    }
    for (const name of ["getDecision", "getAppeal"]) {
      expect(() => AI_INTERFACE.getFunction(name)).not.toThrow();
    }
  });

  it("does not name the reviewer in AppealResolved", () => {
    // Ownership for a resolution therefore has to come from getAppeal. If the
    // contract ever adds a reviewer field here, that routing should be
    // revisited rather than left in place by default.
    const resolved = AI_INTERFACE.getEvent("AppealResolved");
    expect(resolved?.inputs.some((i) => i.name === "reviewer")).toBe(false);
  });
});

describe("chain enum orderings", () => {
  // Mirrored from AIComplianceModule.sol. These are on-chain uint8 values, so
  // reordering an entry relabels every decision and appeal in the system.
  it("matches AIComplianceModule.DecisionOutcome", () => {
    expect(CHAIN_DECISION_OUTCOME).toEqual([
      "APPROVED",
      "FLAGGED",
      "REJECTED",
      "ESCALATED",
    ]);
  });

  it("matches AIComplianceModule.AppealStatus", () => {
    expect(CHAIN_APPEAL_STATUS).toEqual([
      "PENDING",
      "UNDER_REVIEW",
      "UPHELD",
      "OVERTURNED",
      "DISMISSED",
    ]);
  });

  it("maps every chain outcome onto an API outcome, including the rename", () => {
    for (const outcome of CHAIN_DECISION_OUTCOME) {
      expect(CHAIN_OUTCOME_TO_DB[outcome]).toBeDefined();
    }
    // The one that is not a tense change: a REJECTED decision is BLOCK here.
    expect(CHAIN_OUTCOME_TO_DB.REJECTED).toBe("BLOCK");
    expect(new Set(Object.values(CHAIN_OUTCOME_TO_DB)).size).toBe(
      CHAIN_DECISION_OUTCOME.length,
    );
  });

  it("maps every chain status onto a database status", () => {
    // Unlike the FX statuses this mapping is total and lossless — the only
    // difference is that the database says SUBMITTED where the contract says
    // PENDING. Asserted rather than assumed, because "the names look the same"
    // is exactly how the FX mapping went wrong.
    for (const status of CHAIN_APPEAL_STATUS) {
      expect(CHAIN_APPEAL_STATUS_TO_DB[status]).toBeDefined();
    }
    expect(CHAIN_APPEAL_STATUS_TO_DB.PENDING).toBe("SUBMITTED");
    expect(new Set(Object.values(CHAIN_APPEAL_STATUS_TO_DB)).size).toBe(
      CHAIN_APPEAL_STATUS.length,
    );
  });
});
