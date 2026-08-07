/**
 * Guards MULTISIG_TREASURY_ABI against drifting from the compiled contract.
 *
 * Motivation: a positional ABI that disagrees with the deployed struct does
 * not fail loudly — it decodes to the wrong fields. TerraQura shipped a
 * getMetadata tuple that was three fields short of CreditMetadata and every
 * read failed deep inside viem with "Bytes value 97 is not a valid boolean".
 * This test makes the equivalent mistake impossible here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// jest.setup.js mocks @/config/abis globally so page tests need no real ABIs.
// This test is specifically about the real, generated ABI, so bypass the mock.
const { MULTISIG_TREASURY_ABI } = jest.requireActual<
  typeof import("@/config/abis")
>("@/config/abis");

type AbiEntry = {
  name?: string;
  type: string;
  inputs?: { name: string; type: string }[];
  outputs?: { name: string; type: string }[];
};

const artifact = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      "contracts/artifacts/src/MultiSigTreasury.sol/MultiSigTreasury.json",
    ),
    "utf8",
  ),
) as { abi: AbiEntry[] };

const shape = (e: AbiEntry) => ({
  name: e.name,
  type: e.type,
  inputs: (e.inputs ?? []).map((i) => `${i.type} ${i.name}`),
  outputs: (e.outputs ?? []).map((o) => `${o.type} ${o.name}`),
});

describe("MULTISIG_TREASURY_ABI", () => {
  const frontend = MULTISIG_TREASURY_ABI as unknown as AbiEntry[];

  it("is not empty", () => {
    expect(frontend.length).toBeGreaterThan(0);
  });

  it.each(
    (MULTISIG_TREASURY_ABI as unknown as AbiEntry[]).map((e) => [
      `${e.type} ${e.name}`,
      e,
    ]),
  )("%s matches the compiled contract exactly", (_label, entry) => {
    const onChain = artifact.abi.filter(
      (a) => a.name === (entry as AbiEntry).name && a.type === (entry as AbiEntry).type,
    );
    expect(onChain.length).toBeGreaterThan(0);
    // Overloads are allowed; at least one must match the declared shape.
    expect(onChain.map(shape)).toContainEqual(shape(entry as AbiEntry));
  });

  it("declares the write surface the treasury UI depends on", () => {
    for (const fn of [
      "createProposal",
      "approveProposal",
      "executeProposal",
      "cancelProposal",
    ]) {
      expect(frontend.some((e) => e.type === "function" && e.name === fn)).toBe(true);
    }
  });
});
