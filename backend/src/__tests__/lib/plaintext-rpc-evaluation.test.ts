/**
 * Plaintext (http) chain RPC as acknowledged evaluation mode.
 *
 * The property under test is that the HTTPS requirement is never simply
 * dropped: plaintext is reachable only through the exact acknowledgement, only
 * on the public testnet, and only for a URL that carries nothing worth
 * intercepting. The chain-id and network-anchor checks are untouched by this
 * gate, so a plaintext transport can never change WHICH network the backend
 * accepts — only whether the hop to it is encrypted.
 */

import {
  PLAINTEXT_RPC_ACKNOWLEDGEMENT,
  plaintextTestnetRpcAcknowledged,
} from "../../lib/production-config";
import { collectProductionEnvErrors } from "../../lib/env-validation";

const ACK = PLAINTEXT_RPC_ACKNOWLEDGEMENT;

function rpcEnv(
  over: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ALLOW_INSECURE_TESTNET_RPC: ACK,
    NOBLEPAY_CHAIN_ID: "7332",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

describe("plaintextTestnetRpcAcknowledged", () => {
  it("accepts the exact acknowledgement on the public testnet", () => {
    expect(plaintextTestnetRpcAcknowledged(rpcEnv())).toBe(true);
  });

  it("shares its literal with the deploy-script policy", () => {
    // scripts/lib/rpc-transport-policy.mjs owns this string; the backend
    // adopts it. The production validator pins the two files against each
    // other, and this test pins the runtime value.
    expect(ACK).toBe("acknowledge-evaluation-only-plaintext-rpc");
  });

  it("refuses a merely truthy value", () => {
    for (const value of ["true", "1", "yes", "acknowledge", ""]) {
      expect(
        plaintextTestnetRpcAcknowledged(
          rpcEnv({ ALLOW_INSECURE_TESTNET_RPC: value }),
        ),
      ).toBe(false);
    }
  });

  it("cannot be reached on any chain but the public testnet", () => {
    for (const chainId of ["1", "7331", "73320", "0", "", " "]) {
      expect(
        plaintextTestnetRpcAcknowledged(rpcEnv({ NOBLEPAY_CHAIN_ID: chainId })),
      ).toBe(false);
    }
    expect(
      plaintextTestnetRpcAcknowledged(rpcEnv({ NOBLEPAY_CHAIN_ID: undefined })),
    ).toBe(false);
  });

  it("is off when nothing is set", () => {
    expect(plaintextTestnetRpcAcknowledged({})).toBe(false);
  });
});

describe("boot validation of a plaintext chain RPC", () => {
  /*
   * Complete enough for loadNoblePayChainConfiguration to succeed. That is
   * load-bearing: with an incomplete base env the loader throws before the
   * protocol check runs, no AETHELRED_RPC_URL error is produced on EITHER
   * side of the gate, and every assertion here passes vacuously. The
   * base-env sanity test below exists to catch exactly that.
   */
  const base = {
    JWT_SECRET: "a".repeat(32),
    API_KEY_HASH_SECRET: "b".repeat(32),
    DATABASE_URL: "postgresql://u:p@postgres:5432/db",
    NOBLEPAY_CHAIN_ID: "7332",
    AETHELRED_RPC_URL: "http://54.165.44.130:8545",
    AETHELRED_NETWORK_ANCHOR_BLOCK: "385329",
    AETHELRED_NETWORK_ANCHOR_HASH: `0x${"ab".repeat(32)}`,
    NOBLEPAY_CONTRACT_ADDRESS: "0x1111111111111111111111111111111111111111",
    BUSINESS_REGISTRY_CONTRACT_ADDRESS:
      "0x2222222222222222222222222222222222222222",
    NOBLEPAY_TOKEN_CONFIG: JSON.stringify({
      "0x3333333333333333333333333333333333333333": {
        currency: "USDC",
        currencyCode: "USD",
        decimals: 6,
      },
    }),
    BUSINESS_VERIFIER_ADDRESS: "0x4444444444444444444444444444444444444444",
    TRAVEL_RULE_ACTIVE_KEY_ID: "test-key",
    TRAVEL_RULE_ENCRYPTION_KEYS: JSON.stringify({
      "test-key": `${"A".repeat(43)}=`,
    }),
    PUBLIC_ORIGIN: "https://noblepay.example.com",
    CORS_ORIGIN: "https://noblepay.example.com",
  };

  const allErrors = (env: Record<string, string | undefined>) =>
    collectProductionEnvErrors({ ...base, ...env } as NodeJS.ProcessEnv);

  const rpcErrors = (env: Record<string, string | undefined>) =>
    allErrors(env)
      .filter((e) => e.includes("AETHELRED_RPC_URL"))
      .join("\n");

  it("has a base env the chain-config loader accepts", () => {
    // Guards the guards: if the loader rejects the base env, its error hides
    // every RPC assertion in this block behind a vacuous pass.
    const unrelated = allErrors({
      AETHELRED_RPC_URL: "https://rpc.operator.example.com",
    }).filter((e) => !e.includes("COMPLIANCE"));
    expect(unrelated).toEqual([]);
  });

  it("still demands HTTPS without the acknowledgement", () => {
    expect(rpcErrors({})).toMatch(/must use HTTPS/u);
    // The error must teach the operator the exact remedy, not just refuse.
    expect(rpcErrors({})).toContain(ACK);
  });

  it("accepts an acknowledged plaintext URL on the public testnet", () => {
    expect(rpcErrors({ ALLOW_INSECURE_TESTNET_RPC: ACK })).toBe("");
  });

  it("still demands HTTPS when acknowledged on the wrong chain", () => {
    expect(
      rpcErrors({ ALLOW_INSECURE_TESTNET_RPC: ACK, NOBLEPAY_CHAIN_ID: "1" }),
    ).toMatch(/must use HTTPS/u);
  });

  it("refuses a truthy-but-wrong acknowledgement", () => {
    expect(rpcErrors({ ALLOW_INSECURE_TESTNET_RPC: "true" })).toMatch(
      /must use HTTPS/u,
    );
  });

  it("refuses plaintext URLs that carry credentials or queries", () => {
    // Anything embedded in a plaintext URL crosses the wire unencrypted, so
    // an acknowledged transport does not extend to a URL with secrets in it.
    // Embedded credentials are refused by the config loader itself for any
    // URL; queries and fragments reach the plaintext-specific branch. Both
    // paths must refuse — which message does so is an implementation detail.
    for (const url of [
      "http://user:pass@54.165.44.130:8545",
      "http://54.165.44.130:8545/?apikey=x",
      "http://54.165.44.130:8545/#frag",
    ]) {
      expect(
        rpcErrors({
          ALLOW_INSECURE_TESTNET_RPC: ACK,
          AETHELRED_RPC_URL: url,
        }),
      ).toMatch(/credentials|query|fragment/u);
    }
  });

  it("does not weaken an HTTPS deployment that also sets the acknowledgement", () => {
    expect(
      rpcErrors({
        ALLOW_INSECURE_TESTNET_RPC: ACK,
        AETHELRED_RPC_URL: "https://rpc.operator.example.com",
      }),
    ).toBe("");
  });
});
