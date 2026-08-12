/**
 * Pins FX_INTERFACE against the compiled FXHedgingVault artifact, and pins the
 * chain enum orderings against the Solidity source.
 *
 * getPosition returns a sixteen-field struct. A fragment that has drifted from
 * it does not throw — it decodes into the wrong fields and produces a position
 * whose notional, rate and collateral are silently shuffled. The enum checks
 * matter for the same reason: the values are on-chain uint8s, so reordering an
 * entry relabels every position in the system.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Fragment, Interface } from "ethers";

import {
  CHAIN_HEDGE_TYPE,
  CHAIN_POSITION_STATUS,
  FX_INTERFACE,
  decodeCurrency,
} from "../../services/fx-chain";

const ARTIFACT = join(
  process.cwd(),
  "..",
  "contracts",
  "artifacts",
  "src",
  "FXHedgingVault.sol",
  "FXHedgingVault.json",
);

if (!existsSync(ARTIFACT)) {
  throw new Error(
    `FXHedgingVault artifact not found at ${ARTIFACT}.\n` +
      `Compile the contracts before running backend tests:\n` +
      `  (cd contracts && npx hardhat compile)`,
  );
}

describe("FX_INTERFACE", () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
    abi: unknown[];
  };
  const compiled = new Interface(artifact.abi as never);

  const declared = FX_INTERFACE.fragments.filter(
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
      expect(match?.format("full")).toBe(fragment.format("full"));
    },
  );

  it("covers every call the service issues", () => {
    for (const name of [
      "getActivePairs",
      "getCurrencyPair",
      "getLatestRate",
      "getBusinessPositions",
      "getPosition",
      "getPortfolio",
      "isUnderMargined",
      "RATE_PRECISION",
      "settlementFeeBps",
    ]) {
      expect(() => FX_INTERFACE.getFunction(name)).not.toThrow();
    }
  });
});

describe("chain enum orderings", () => {
  // Mirrored from FXHedgingVault.sol. The contract has no SWAP type; the
  // database model does, and conflating the two would invent a hedge the vault
  // cannot hold.
  it("matches FXHedgingVault.HedgeType", () => {
    expect(CHAIN_HEDGE_TYPE).toEqual(["FORWARD", "OPTION_CALL", "OPTION_PUT"]);
  });

  it("matches FXHedgingVault.PositionStatus", () => {
    expect(CHAIN_POSITION_STATUS).toEqual([
      "ACTIVE",
      "MATURED",
      "SETTLED",
      "EXERCISED",
      "EXPIRED",
      "LIQUIDATED",
      "EMERGENCY_UNWOUND",
    ]);
  });

  it("keeps statuses the database cannot express", () => {
    // services/fx.ts models status as OPEN | CLOSED | EXPIRED | EXERCISED.
    // Mapping the chain onto that set would report a liquidated position as
    // "CLOSED" — the one outcome an operator most needs to distinguish.
    expect(CHAIN_POSITION_STATUS).toContain("LIQUIDATED");
    expect(CHAIN_POSITION_STATUS).toContain("EMERGENCY_UNWOUND");
  });
});

describe("decodeCurrency", () => {
  it("decodes a bytes3 ASCII code", () => {
    expect(decodeCurrency("0x414544")).toBe("AED");
    expect(decodeCurrency("0x555344")).toBe("USD");
  });

  it("stops at padding rather than emitting NUL characters", () => {
    expect(decodeCurrency("0x555300")).toBe("US");
  });

  it("tolerates a missing 0x prefix", () => {
    expect(decodeCurrency("474250")).toBe("GBP");
  });
});
