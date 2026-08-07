/**
 * Guards .env.example against falling behind the code that reads it.
 *
 * chains.ts resolves every contract address with
 * `process.env.NEXT_PUBLIC_X_ADDRESS || ""`, so a key that exists in code but
 * not in .env.example fails silently: someone provisioning an environment
 * copies the example, fills in everything listed, deploys, and the page reads
 * the zero-length string. No error is thrown — the feature simply shows
 * nothing, which looks like an empty treasury rather than a misconfiguration.
 *
 * This was not hypothetical: LIQUIDITY_POOL and MULTISIG_TREASURY were both
 * read by chains.ts and absent from .env.example.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const KEY = /NEXT_PUBLIC_[A-Z0-9_]*ADDRESS/g;

const unique = (s: string) => [...new Set(s.match(KEY) ?? [])].sort();

describe(".env.example", () => {
  const codeKeys = unique(readFileSync(join(root, "src/config/chains.ts"), "utf8"));
  const exampleKeys = unique(readFileSync(join(root, ".env.example"), "utf8"));

  it("reads at least one address key from chains.ts", () => {
    expect(codeKeys.length).toBeGreaterThan(0);
  });

  it("documents every contract address chains.ts reads", () => {
    const missing = codeKeys.filter((k) => !exampleKeys.includes(k));
    expect(missing).toEqual([]);
  });

  it("does not document keys the code never reads", () => {
    // A stale key is a slower failure than a missing one, but still sends
    // whoever provisions the environment looking for a deployment that has no
    // consumer.
    const orphaned = exampleKeys.filter((k) => !codeKeys.includes(k));
    expect(orphaned).toEqual([]);
  });
});
