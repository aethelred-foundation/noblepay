/**
 * Guards src/config/abis.generated.ts against drifting from the compiled
 * artifacts, for all thirteen contracts at once.
 *
 * This is the CI half of the generate-from-artifacts approach. Generating an
 * ABI only helps if somebody regenerates it; a generated file nobody refreshes
 * is just a hand-written file with a misleading header comment. Running the
 * generator in --check mode here means a contract change that is not followed
 * by `node scripts/gen-abis.mjs` fails the build rather than shipping an ABI
 * that disagrees with the deployed bytecode.
 *
 * The file this replaced (src/lib/abis.ts) was not merely stale — it declared
 * createHedge/closeHedge/getExposure on FXHedgingVault, whose real surface is
 * settleForward/exerciseOption/getPortfolio. Nothing caught it because an ABI
 * literal is just data until the moment a call reverts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("generated ABIs", () => {
  it("match the compiled artifacts (scripts/gen-abis.mjs --check)", () => {
    let output = "";
    let failed = false;
    try {
      output = execFileSync("node", ["scripts/gen-abis.mjs", "--check"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string };
      output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    if (failed) {
      throw new Error(
        `Generated ABIs are stale or artifacts are missing.\n` +
          `Run: (cd contracts && npx hardhat compile) && node scripts/gen-abis.mjs\n\n` +
          output,
      );
    }
    expect(output).toContain("OK");
  });

  it("does not reintroduce the hand-written src/lib/abis.ts", () => {
    // That file was fiction: none of its signatures existed on chain. If it
    // comes back, ABIs have two sources of truth again.
    expect(existsSync(join(root, "src/lib/abis.ts"))).toBe(false);
  });

  it("carries the do-not-edit header", () => {
    const source = readFileSync(join(root, "src/config/abis.generated.ts"), "utf8");
    expect(source.startsWith("// GENERATED FILE — DO NOT EDIT.")).toBe(true);
  });
});
