/**
 * Pins STREAM_INTERFACE against the compiled StreamingPayments artifact, and
 * the chain status ordering against the Solidity source.
 *
 * The ordering check is the important one here. The contract and the Prisma
 * enum disagree at indices 2 and 3 — CANCELLED and COMPLETED are swapped — so
 * decoding an on-chain uint8 through the database ordering would report a
 * cancelled stream as completed. See docs/audit/NP-STREAM-01.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Fragment, Interface } from "ethers";

import {
  CHAIN_STREAM_STATUS,
  STREAM_EVENTS,
  STREAM_INTERFACE,
} from "../../services/streaming-execution";

const ARTIFACT = join(
  process.cwd(),
  "..",
  "contracts",
  "artifacts",
  "src",
  "StreamingPayments.sol",
  "StreamingPayments.json",
);

if (!existsSync(ARTIFACT)) {
  throw new Error(
    `StreamingPayments artifact not found at ${ARTIFACT}.\n` +
      `Compile the contracts before running backend tests:\n` +
      `  (cd contracts && npx hardhat compile)`,
  );
}

describe("STREAM_INTERFACE", () => {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
    abi: unknown[];
  };
  const compiled = new Interface(artifact.abi as never);

  const declared = STREAM_INTERFACE.fragments.filter(
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
      // Full signature, not just the sighash: getStream(bytes32) hashes the
      // same whatever thirteen-field struct it returns, and a drifted tuple
      // decodes silently into the wrong fields.
      expect(match?.format("full")).toBe(fragment.format("full"));
    },
  );

  it("declares an event for every transition the verifier handles", () => {
    for (const name of [
      "StreamCreated",
      "StreamPaused",
      "StreamResumed",
      "StreamCancelled",
      "StreamCompleted",
      "Withdrawal",
    ]) {
      expect(() => STREAM_INTERFACE.getEvent(name)).not.toThrow();
    }
    expect(STREAM_EVENTS).toHaveLength(4);
  });

  it("keeps pausedDuration on StreamResumed", () => {
    // This field is the entire fix for NP-STREAM-01. Without it the API has no
    // way to learn how long a stream was paused, and its balance drifts above
    // what the contract will pay.
    const resumed = STREAM_INTERFACE.getEvent("StreamResumed");
    expect(resumed?.inputs.some((i) => i.name === "pausedDuration")).toBe(true);
  });

  it("has no rate-adjustment function to verify", () => {
    // The API exposes adjustRate; the contract has no counterpart, by design —
    // a sender who could lower the rate could renege after the fact. Pinned so
    // that if the contract ever grows one, this test fails and prompts the API
    // to be reconsidered rather than left permanently refusing.
    const names = compiled.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.format("sighash").toLowerCase());
    expect(names.some((n) => /rate/.test(n))).toBe(false);
  });
});

describe("CHAIN_STREAM_STATUS", () => {
  it("matches StreamingPayments.StreamStatus", () => {
    expect(CHAIN_STREAM_STATUS).toEqual([
      "ACTIVE",
      "PAUSED",
      "CANCELLED",
      "COMPLETED",
    ]);
  });

  it("differs from the Prisma enum exactly where it is dangerous", () => {
    // Prisma: ACTIVE, PAUSED, COMPLETED, CANCELLED. Indices 2 and 3 are
    // swapped, so a chain status decoded through the database ordering turns a
    // cancelled stream into a completed one.
    const prismaOrdering = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"];
    expect(CHAIN_STREAM_STATUS[2]).toBe("CANCELLED");
    expect(prismaOrdering[2]).toBe("COMPLETED");
    expect(CHAIN_STREAM_STATUS[3]).toBe("COMPLETED");
    expect(prismaOrdering[3]).toBe("CANCELLED");
  });
});
