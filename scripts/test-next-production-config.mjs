#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loadConfig = [
  "const config = require('./next.config.js');",
  "config.headers().then((entries) => {",
  "  const csp = entries[0].headers.find((header) => header.key === 'Content-Security-Policy').value;",
  "  process.stdout.write(csp);",
  "});",
].join("\n");

const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith("NEXT_PUBLIC_"),
  ),
);
Object.assign(baseEnv, {
  NODE_ENV: "production",
  AETHELRED_RPC_URL: "https://private-rpc.example.com/project-secret",
  NEXT_PUBLIC_CHAIN_ENV: "testnet",
  NEXT_PUBLIC_AETHELRED_CHAIN_ID: "7332",
  NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_BLOCK: "1",
  NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_HASH: `0x${"ab".repeat(32)}`,
  NEXT_PUBLIC_AETHELRED_RPC_URL: "https://public-rpc.operator.example.com",
  NEXT_PUBLIC_AETHELRED_WS_URL: "wss://public-ws.operator.example.com",
  NEXT_PUBLIC_AETHELRED_EXPLORER_URL: "https://explorer.operator.example.com",
  NEXT_PUBLIC_NOBLEPAY_ADDRESS: "0x1111111111111111111111111111111111111111",
  NEXT_PUBLIC_BUSINESS_REGISTRY_ADDRESS:
    "0x2222222222222222222222222222222222222222",
  NEXT_PUBLIC_PAYMENT_CHANNELS_ADDRESS:
    "0x5555555555555555555555555555555555555555",
  NEXT_PUBLIC_USDC_TOKEN_ADDRESS: "0x6666666666666666666666666666666666666666",
  NEXT_PUBLIC_USDT_TOKEN_ADDRESS: "0x7777777777777777777777777777777777777777",
  NEXT_PUBLIC_SITE_URL: "https://noblepay-ci.example.com",
  NEXT_PUBLIC_API_URL: "https://noblepay-ci.example.com/api",
  NEXT_PUBLIC_WS_URL: "wss://noblepay-ci.example.com/ws",
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "0123456789abcdef0123456789abcdef",
  NEXT_PUBLIC_APP_VERSION: "1.0.0-ci",
  NEXT_PUBLIC_SENTRY_DSN: "https://public@example.ingest.sentry.io/123",
});

function run(overrides = {}, removed = []) {
  const env = { ...baseEnv, ...overrides };
  for (const name of removed) delete env[name];
  return spawnSync(process.execPath, ["-e", loadConfig], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

const valid = run();
assert.equal(valid.status, 0, valid.stderr);
const connectDirective = valid.stdout
  .split("; ")
  .find((directive) => directive.startsWith("connect-src "));
assert.ok(connectDirective, "CSP must include connect-src");
assert.ok(connectDirective.includes("https://noblepay-ci.example.com"));
assert.ok(connectDirective.includes("wss://noblepay-ci.example.com"));
assert.ok(connectDirective.includes("https://public-rpc.operator.example.com"));
assert.ok(connectDirective.includes("wss://public-ws.operator.example.com"));
assert.ok(
  !connectDirective.includes("private-rpc.example.com"),
  "server-only RPC must not enter the browser CSP",
);
assert.ok(connectDirective.includes("wss://relay.walletconnect.org"));
assert.ok(connectDirective.includes("https://api.web3modal.org"));
assert.ok(connectDirective.includes("https://example.ingest.sentry.io"));
assert.ok(
  !connectDirective.split(/\s+/u).includes("http:"),
  "production CSP must not allow every HTTP endpoint",
);
assert.ok(
  !connectDirective.split(/\s+/u).includes("https:"),
  "production CSP must not allow every HTTPS endpoint",
);
assert.ok(
  !connectDirective.split(/\s+/u).includes("ws:"),
  "production CSP must not allow every WS endpoint",
);
assert.ok(
  !connectDirective.split(/\s+/u).includes("wss:"),
  "production CSP must not allow every WSS endpoint",
);

for (const [name, result] of [
  ["missing API URL", run({}, ["NEXT_PUBLIC_API_URL"])],
  [
    "insecure API URL",
    run({ NEXT_PUBLIC_API_URL: "http://noblepay-ci.example.com/api" }),
  ],
  ["missing public site origin", run({}, ["NEXT_PUBLIC_SITE_URL"])],
  [
    "insecure public site origin",
    run({ NEXT_PUBLIC_SITE_URL: "http://noblepay-ci.example.com" }),
  ],
  [
    "public site origin with path",
    run({ NEXT_PUBLIC_SITE_URL: "https://noblepay-ci.example.com/subpath" }),
  ],
  ["missing chain id", run({}, ["NEXT_PUBLIC_AETHELRED_CHAIN_ID"])],
  ["invalid chain id", run({ NEXT_PUBLIC_AETHELRED_CHAIN_ID: "0" })],
  [
    "missing network anchor block",
    run({}, ["NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_BLOCK"]),
  ],
  [
    "invalid network anchor block",
    run({ NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_BLOCK: "-1" }),
  ],
  [
    "missing network anchor hash",
    run({}, ["NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_HASH"]),
  ],
  [
    "invalid network anchor hash",
    run({ NEXT_PUBLIC_AETHELRED_NETWORK_ANCHOR_HASH: "0x1234" }),
  ],
  ["missing public RPC", run({}, ["NEXT_PUBLIC_AETHELRED_RPC_URL"])],
  [
    "insecure public RPC",
    run({
      NEXT_PUBLIC_AETHELRED_RPC_URL: "http://public-rpc.operator.example.com",
    }),
  ],
  [
    "credentialed public RPC",
    run({
      NEXT_PUBLIC_AETHELRED_RPC_URL:
        "https://user:secret@public-rpc.operator.example.com",
    }),
  ],
  ["missing public chain WebSocket", run({}, ["NEXT_PUBLIC_AETHELRED_WS_URL"])],
  [
    "insecure public chain WebSocket",
    run({
      NEXT_PUBLIC_AETHELRED_WS_URL: "ws://public-ws.operator.example.com",
    }),
  ],
  ["missing explorer", run({}, ["NEXT_PUBLIC_AETHELRED_EXPLORER_URL"])],
  [
    "insecure explorer",
    run({
      NEXT_PUBLIC_AETHELRED_EXPLORER_URL:
        "http://explorer.operator.example.com",
    }),
  ],
  [
    "zero contract address",
    run({ NEXT_PUBLIC_NOBLEPAY_ADDRESS: `0x${"0".repeat(40)}` }),
  ],
  [
    "invalid WalletConnect project",
    run({ NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "placeholder" }),
  ],
]) {
  assert.notEqual(
    result.status,
    0,
    `${name} must fail a production config load`,
  );
}

const validDevnet = run({
  NEXT_PUBLIC_CHAIN_ENV: "devnet",
});
assert.equal(validDevnet.status, 0, validDevnet.stderr);
assert.ok(
  validDevnet.stdout.includes("https://public-rpc.operator.example.com"),
);

console.log("Next.js production environment and CSP assertions passed");
