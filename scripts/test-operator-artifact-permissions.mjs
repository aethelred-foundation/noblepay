#!/usr/bin/env node
/**
 * Regression for the operator-artifact permission guard.
 *
 * The guard originally required mode 0600 and a 0700 parent for EVERY operator
 * artifact, including the governance acceptance payload — which holds a chain
 * id, a block anchor, a target address and calldata, all public the moment the
 * transaction is broadcast. A payload sitting at the conventional 0644 under a
 * 0755 /etc directory was rejected with "must not grant group or other
 * permissions", a message that named neither the file, the mode, nor the fix.
 *
 * The guard now distinguishes the two threat models it was conflating:
 * disclosure for secrets, tampering for inputs. These cases pin both, because
 * relaxing the wrong one would be a real regression.
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSecureJSONFile } from "./lib/operator-artifacts.mjs";

const root = join(tmpdir(), `operator-artifact-guard-${process.pid}`);
const dir = join(root, "noblepay");
const payload = join(dir, "governance-acceptance.json");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error.message.split("\n")[0]}`);
  }
}

function expectThrows(fn, needle) {
  let message = null;
  try {
    fn();
  } catch (error) {
    message = error.message;
  }
  if (message === null) throw new Error("expected a rejection, got success");
  if (!message.includes(needle)) {
    throw new Error(`expected message to mention "${needle}", got: ${message}`);
  }
  return message;
}

try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    payload,
    JSON.stringify({
      chainId: 7332,
      requiredExecutor: "0x5FAeB13eb8Ffee24024bFCDB6471400fB2193D6e",
      target: "0x98aEE12F52cE2197A45e6E290edf1ca832A8A1bA",
      value: "0",
      calldata: "0x79ba5097",
      method: "acceptOwnership()",
    }),
  );

  console.log("operator artifact permissions");

  check("accepts a governance payload at the conventional 0644 under 0755", () => {
    chmodSync(dir, 0o755);
    chmodSync(payload, 0o644);
    const value = readSecureJSONFile(payload, "governance acceptance payload", {
      sensitivity: "integrity",
    });
    if (value.calldata !== "0x79ba5097") throw new Error("payload not loaded");
  });

  check("refuses a group-WRITABLE governance payload", () => {
    chmodSync(dir, 0o755);
    chmodSync(payload, 0o664);
    expectThrows(
      () =>
        readSecureJSONFile(payload, "governance acceptance payload", {
          sensitivity: "integrity",
        }),
      "WRITE",
    );
  });

  check("refuses a world-WRITABLE parent directory", () => {
    chmodSync(dir, 0o777);
    chmodSync(payload, 0o644);
    expectThrows(
      () =>
        readSecureJSONFile(payload, "governance acceptance payload", {
          sensitivity: "integrity",
        }),
      "WRITE",
    );
  });

  check("names the file, the mode and the chmod to run", () => {
    chmodSync(dir, 0o755);
    chmodSync(payload, 0o666);
    const message = expectThrows(
      () =>
        readSecureJSONFile(payload, "governance acceptance payload", {
          sensitivity: "integrity",
        }),
      "chmod",
    );
    // The original message had none of these, which is why the failure was a
    // dead end for whoever hit it.
    for (const needle of [payload, "0666", "chmod 644"]) {
      if (!message.includes(needle)) {
        throw new Error(`message is missing "${needle}"`);
      }
    }
  });

  check("still refuses a group-READABLE secret, by default", () => {
    // The relaxation must not leak into key files: disclosure is the whole
    // risk there, and the default sensitivity is what every key call site uses.
    chmodSync(dir, 0o700);
    chmodSync(payload, 0o640);
    expectThrows(
      () => readSecureJSONFile(payload, "TOKEN_PROVISIONER_KEY_FILE"),
      "any group or other access",
    );
  });

  check("accepts a secret at 0600 under 0700", () => {
    chmodSync(dir, 0o700);
    chmodSync(payload, 0o600);
    readSecureJSONFile(payload, "TOKEN_PROVISIONER_KEY_FILE");
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall operator artifact permission checks passed");
