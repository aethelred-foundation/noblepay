# NoblePay public-testnet operator runbook

This is the canonical handoff for the US public-testnet operator. It covers a
fresh application setup and the two-phase core-contract ceremony. It does not
authorize a chain reset, validator restart, governance vote, or transaction on
behalf of the operator.

## 1. Release stop conditions

Do not run `--bootstrap` until all of the following have been supplied through
the approved operator channel and independently checked:

- a reviewed 40-character NoblePay Git commit SHA;
- Node.js `24.18.0` with its bundled npm `11.16.0`;
- an activated Aethelred EVM chain ID;
- one immutable block number and 32-byte block hash retained by every private,
  public, and wallet RPC;
- a private HTTPS EVM JSON-RPC endpoint, or the explicitly acknowledged
  evaluation-only HTTP endpoint described below;
- a credential-free public HTTPS EVM JSON-RPC endpoint, or the same bounded
  evaluation-only HTTP exception;
- a credential-free public WSS endpoint and HTTPS explorer;
- a funded temporary deployer EOA and matching private key;
- a deployed final governance multisig;
- distinct treasury manager, fee beneficiary, business verifier, compliance
  officer, and dedicated compliance-operator EOA addresses;
- either chain-operator-confirmed USDC and USDT test contracts or a reviewed
  manifest from the testnet-only provisioning ceremony below, each with six
  decimals;
- approved NoblePay and PaymentChannels fee values and the complete CEAP
  policy;
- a working ISeal precompile at `0x0000000000000000000000000000000000000900`.

HTTPS remains the default. While this public testnet is an evaluation network
without a TLS RPC, the private ceremony endpoint may be
`http://54.165.44.130:8545` only when the operator sets the exact acknowledgement
`ALLOW_INSECURE_TESTNET_RPC=acknowledge-evaluation-only-plaintext-rpc`. The
command still verifies the decimal chain ID and immutable block anchor before
every mutation. Mainnet always rejects HTTP. The same acknowledgement permits
the credential-free public evaluation RPC during finalization because that
client independently verifies the chain ID, anchor, checkpoint evidence, and
release block. Production runtime validation still rejects plaintext RPC.
WebSocket, explorer, site, API, and application WebSocket endpoints remain
HTTPS/WSS-only; the exception does not make the current plaintext application
release publication-ready.

The release remains blocked if the TLS endpoints, immutable block anchor,
governance inputs, or independently verified test-token contracts are
unavailable. Placeholder addresses in an example file are never deployment
evidence.

## 2. Immutable checkout and runtime

Use the SHA supplied with the release handoff, not the moving branch head:

```bash
export RELEASE_SHA=replace-with-reviewed-40-character-commit
export RELEASE_DIR=/opt/noblepay/releases/"$RELEASE_SHA"

printf '%s' "$RELEASE_SHA" | grep -Eq '^[0-9a-f]{40}$'

git clone https://github.com/aethelred-foundation/noblepay.git "$RELEASE_DIR"
cd "$RELEASE_DIR"
git fetch origin "$RELEASE_SHA"
git checkout --detach "$RELEASE_SHA"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain=v1 --untracked-files=no)"
```

Install and select Node `24.18.0` using the operator's approved runtime manager.
When `nvm` is available:

```bash
nvm install 24.18.0
nvm use 24.18.0
test "$(node --version)" = "v24.18.0"
test "$(npm --version)" = "11.16.0"
```

NoblePay uses npm and the three committed `package-lock.json` files. Do not use
pnpm, Yarn, Bun, `npm install`, or `--legacy-peer-deps`.

## 3. Clean install, build, and tests

From the immutable checkout:

```bash
npm ci
npm --prefix backend ci
npm --prefix contracts ci

npm run type-check
npm run lint
npm run test:ci
npm run validate:backend
npm run validate:contracts
```

The complete release gate additionally validates the optional gateway, the
local compliance reference, security tests, browser production build, and
dependency advisories:

```bash
npx playwright install chromium
npm run validate:all
```

Do not continue if a required gate fails. Generated Hardhat output is not
release evidence. Reproduce and verify it immediately before the ceremony:

```bash
cd contracts
npx --no-install hardhat clean
npx --no-install hardhat compile
cd ..
node scripts/deploy-devnet-core.mjs --verify-artifacts
```

## 3a. Resolve or provision USDC and USDT test tokens

Ask the Aethelred network operator for canonical public-testnet USDC and USDT
addresses first. This repository does not contain canonical addresses:
`0xaaaa...`, `0x6666...`, and similar values in examples or CI are inert
placeholders. If the operator supplies canonical contracts, independently
verify their chain, runtime, `name`, `symbol`, and six-decimal metadata and use
those addresses. Do not deploy duplicates.

If the activated public testnet has no canonical contracts, use the bounded
provisioning ceremony. It can verify and adopt either existing reviewed
`MockERC20` test contract and deploy only the missing symbol. For the current
operator state, configure the existing USDC address and exact on-chain name;
leave the USDT adoption fields empty. The ceremony will verify USDC and deploy
only one new six-decimal USDT. Both are permissionlessly mintable test assets
with no claim on real USD. The command refuses `devnet` and `mainnet`, requires
an exact chain ID and immutable block anchor, defaults to HTTPS, verifies a
clean reviewed commit and fresh Hardhat build information, and never configures
NoblePay, mints a balance, or grants an allowance.

Prepare the secret-free configuration and a separate restricted signer file:

```bash
sudo install -m 0600 \
  deploy/testnet-token-provisioning.env.example \
  /etc/noblepay/testnet-token-provisioning.env
sudo chown "$(id -u):$(id -g)" \
  /etc/noblepay/testnet-token-provisioning.env
sudo install -m 0400 /secure/operator/token-provisioner.key \
  /etc/noblepay/token-provisioner.key
sudo chown "$(id -u):$(id -g)" /etc/noblepay/token-provisioner.key
```

`/etc/noblepay/token-provisioner.key` is a plain-text file containing exactly
one line: `0x` followed by the 64 hexadecimal characters of the funded
provisioner private key. It must contain no variable name, quotes, spaces, or
comments. Do not paste that value into the env file, terminal command, shell
history, transcript, ticket, or repository.

Populate every placeholder in
`/etc/noblepay/testnet-token-provisioning.env`. Before setting the existing
USDC fields, read its exact on-chain name without a signer:

```bash
node --input-type=module -e \
  'import {createPublicClient,http,parseAbi} from "viem";const [rpc,address]=process.argv.slice(1);const client=createPublicClient({transport:http(rpc)});console.log(await client.readContract({address,abi:parseAbi(["function name() view returns (string)"]),functionName:"name"}));' \
  http://54.165.44.130:8545 \
  0xreplace-with-the-existing-usdc-address
```

Then set the address and the exact output:

```dotenv
EXISTING_USDC_TOKEN_ADDRESS=0xreplace-with-the-existing-usdc-address
EXISTING_USDC_TOKEN_NAME=replace-with-the-exact-name-returned-by-name()
EXISTING_USDT_TOKEN_ADDRESS=
EXISTING_USDT_TOKEN_NAME=
```

Use `RPC_URL=https://...` when TLS is available. For the current evaluation
endpoint only, use both of these values:

```dotenv
RPC_URL=http://54.165.44.130:8545
ALLOW_INSECURE_TESTNET_RPC=acknowledge-evaluation-only-plaintext-rpc
AETHELRED_CHAIN_ID=7332
AETHELRED_NETWORK_ANCHOR_BLOCK=450000
AETHELRED_NETWORK_ANCHOR_HASH=0x1057a62d12eed50d8740fcf51be0cd784db9a4f8f98c9312eee8b8bc7e543ddc
```

Keep the transaction confirmation value `false`, and validate local inputs
without an RPC connection or transaction:

```bash
export TOKEN_CHECKPOINT=/etc/noblepay/testnet-token-checkpoint.json
export TOKEN_MANIFEST=/etc/noblepay/testnet-token-manifest."$RELEASE_SHA".json

node --env-file=/etc/noblepay/testnet-token-provisioning.env \
  scripts/provision-testnet-tokens.mjs \
  --validate-only \
  --checkpoint-file "$TOKEN_CHECKPOINT" \
  --manifest-file "$TOKEN_MANIFEST"
```

Then perform the read-only network, anchor, runtime-bytecode, name, symbol, and
decimals check. This uses `TOKEN_PROVISIONER_ADDRESS` for the balance check,
does not open `TOKEN_PROVISIONER_KEY_FILE`, writes neither artifact, and
broadcasts no transaction. The signer file may be absent on the verification
host:

```bash
node --env-file=/etc/noblepay/testnet-token-provisioning.env \
  scripts/provision-testnet-tokens.mjs \
  --verify-only \
  --checkpoint-file "$TOKEN_CHECKPOINT" \
  --manifest-file "$TOKEN_MANIFEST"
```

After independent review, change only
`CONFIRM_TESTNET_TOKEN_PROVISIONING` to the exact value
`deploy-publicly-mintable-test-tokens` and run:

```bash
node --env-file=/etc/noblepay/testnet-token-provisioning.env \
  scripts/provision-testnet-tokens.mjs \
  --checkpoint-file "$TOKEN_CHECKPOINT" \
  --manifest-file "$TOKEN_MANIFEST"
```

Return the confirmation to `false` immediately. The command adopts the verified
USDC, then prepares and deploys only USDT. The mode-`0600` checkpoint records
adoption evidence, prepared nonces, expected addresses, transaction hashes,
canonical blocks, and reviewed runtime hashes so an interrupted run can
reconcile or resume without silently deploying duplicates. A legacy version-1
checkpoint containing only ceremony-deployed tokens is verified and upgraded
in place before resume; it cannot be combined with new `EXISTING_*` inputs.
The final mode-`0600` manifest contains public evidence and exactly these
core-ceremony inputs:

```bash
node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const k of ["SUPPORTED_TOKEN_ADDRESSES","USDC_TOKEN_ADDRESS","USDT_TOKEN_ADDRESS"])console.log(`${k}=${m.coreDeploymentEnvironment[k]}`)' \
  "$TOKEN_MANIFEST"
```

Copy those three values exactly into `/etc/noblepay/core.env`. The core
ceremony, not this provisioning command, enables the tokens in NoblePay and
PaymentChannels. Test wallets may call each token's permissionless
`mint(recipient, amountInSmallestUnits)` through an approved wallet or
explorer; one whole token is `1000000` smallest units. Wallets approve
NoblePay only when initiating their own ERC-20 payment.

Do not restore or run the removed `scripts/setup-test-token.mjs` helper. It
combined token deployment, protocol administration, minting, and one wallet's
unlimited allowance without producing the chain-bound evidence required by
this handoff.

## 4. Core ceremony environment

Create host-only files and keep them outside the checkout:

```bash
sudo install -d -m 0700 /etc/noblepay
sudo chown "$(id -u):$(id -g)" /etc/noblepay
sudo install -m 0600 deploy/core-deployment.env.example /etc/noblepay/core.env
sudo chown "$(id -u):$(id -g)" /etc/noblepay/core.env
```

Populate every value in `/etc/noblepay/core.env`. The complete governed input
set is:

| Input                                 | Required meaning                                                            |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `CHAIN_ENV`                           | `testnet` for this handoff                                                  |
| `RPC_URL`                             | private HTTPS EVM JSON-RPC, or acknowledged evaluation-only testnet HTTP    |
| `ALLOW_INSECURE_TESTNET_RPC`          | `false` for HTTPS; exact documented acknowledgement for evaluation HTTP     |
| `AETHELRED_CHAIN_ID`                  | operator-confirmed decimal EVM chain ID                                     |
| `AETHELRED_NETWORK_ANCHOR_BLOCK/HASH` | independently confirmed immutable block identity                            |
| `DEPLOYER_KEY/ADDRESS`                | temporary funded EOA; key and address must match                            |
| `ADMIN_ADDRESS`                       | deployed final governance multisig                                          |
| `TREASURY_MANAGER_ADDRESS`            | holder of both treasury-management roles                                    |
| `TREASURY_ADDRESS`                    | fee beneficiary only; different from treasury manager                       |
| `BUSINESS_VERIFIER_ADDRESS`           | final BusinessRegistry verifier                                             |
| `TEE_NODE_ADDRESS`                    | dedicated external compliance-operator EOA with no bytecode                 |
| `COMPLIANCE_OFFICER_ADDRESS`          | final NoblePay compliance officer                                           |
| token address variables               | exactly the reviewed six-decimal public-testnet USDC and USDT contracts     |
| NoblePay and channel fee variables    | approved integer fee values                                                 |
| CEAP variables                        | approved backend, verification, platform, vendor-root, and residency policy |
| `SEAL_PROBE_ID`                       | operator-confirmed probe identifier for the ISeal read                      |
| public RPC variable                   | credential-free HTTPS, or the bounded evaluation-only HTTP exception        |
| public WSS/explorer variables         | credential-free WSS/HTTPS endpoints used by the browser                     |
| frontend URL/version variables        | final HTTPS/WSS application endpoints and release identifier                |

The configuration digest in the checkpoint binds all governance, custody,
fee, token, and CEAP values. Changing any of them makes resume/finalize fail.

For the current evaluation testnet without a private TLS RPC, the core env must
use this exact network block together; do not mix it with another chain ID or
anchor:

```dotenv
CHAIN_ENV=testnet
RPC_URL=http://54.165.44.130:8545
ALLOW_INSECURE_TESTNET_RPC=acknowledge-evaluation-only-plaintext-rpc
AETHELRED_CHAIN_ID=7332
AETHELRED_NETWORK_ANCHOR_BLOCK=450000
AETHELRED_NETWORK_ANCHOR_HASH=0x1057a62d12eed50d8740fcf51be0cd784db9a4f8f98c9312eee8b8bc7e543ddc
```

This permits the private bootstrap/finalize transport and may also be applied
to `PUBLIC_AETHELRED_RPC_URL=http://54.165.44.130:8545` for evaluation evidence.
It does not relax `PUBLIC_AETHELRED_WS_URL`, explorer, or frontend URL
requirements. No Ethereum JSON-RPC WebSocket was reachable at the expected
`54.165.44.130:8546` endpoint during the 2026-08-04 operator check, so do not
substitute the CometBFT `/websocket` endpoint: it is a different protocol.
Finalization remains blocked until the network operator supplies a working,
credential-free WSS Ethereum JSON-RPC endpoint and the remaining TLS endpoints.
Token provisioning and core bootstrap can proceed now; core finalize cannot.

The network operator's next action is:

1. On the RPC or sentry host, check whether the Ethereum JSON-RPC WebSocket
   listener is already bound to loopback or a private interface. Prove it with
   Ethereum `eth_chainId` and `eth_getBlockByNumber` requests; a successful
   CometBFT status/subscription response is not sufficient.
2. If that EVM listener already exists, expose it through a credential-free TLS
   reverse proxy or sentry as WSS. This does not require a validator restart.
3. Verify chain ID `7332` and block `450000` hash
   `0x1057a62d12eed50d8740fcf51be0cd784db9a4f8f98c9312eee8b8bc7e543ddc`
   through the new WSS endpoint, set `PUBLIC_AETHELRED_WS_URL`, and rerun
   `--finalize --validate-only` before finalize.

If no EVM WebSocket listener exists, stop and return that finding for a separate
network-operations change. Do not restart validators or fabricate a WSS URL as
part of this application deployment.

Use Node's env-file parser; do not shell-source this file because it contains
JSON values:

```bash
set -o pipefail
node --env-file=/etc/noblepay/core.env \
  scripts/deploy-devnet-core.mjs \
  --bootstrap \
  --validate-only \
  --checkpoint-file /etc/noblepay/bootstrap-checkpoint.json
```

`--validate-only` parses the complete input and private key, checks governance
separation and any existing checkpoint, and exits without connecting to an RPC
or broadcasting.

## 5. Bootstrap and safe resume

The following command broadcasts the reviewed bootstrap transactions:

```bash
set -o pipefail
node --env-file=/etc/noblepay/core.env \
  scripts/deploy-devnet-core.mjs \
  --bootstrap \
  --checkpoint-file /etc/noblepay/bootstrap-checkpoint.json \
  2>&1 | tee -a /etc/noblepay/bootstrap-transcript.log
```

The script:

1. verifies the private RPC chain ID and exact immutable block hash;
2. verifies the final governance multisig, both token contracts/decimals,
   compliance-operator EOA, and ISeal read;
3. deploys the four core contracts in a fixed order;
4. atomically writes a mode-`0600` checkpoint after every confirmed creation;
5. verifies prior checkpoint receipts, constructor input, canonical blocks,
   runtime bytecode, and configuration before resuming;
6. idempotently completes policy, links, token enablement, fees, and roles;
7. starts the gate ownership transfer and emits `HANDOFF_PENDING_JSON`.

If the process stops, do not clear the checkpoint and do not start a second
ceremony. Rerun the identical command with the same immutable checkout,
`core.env`, and checkpoint path. It resumes at the first absent contract and
will not redeploy any checkpointed contract.

If a deployment receipt appears in the transcript but the checkpoint file is
missing or does not contain it, stop. Do not rerun until the transaction,
constructor input, contract address, canonical block, and runtime have been
reconciled and the checkpoint restored from the secured host backup. Deleting
or manually reconstructing evidence is not a recovery procedure.

After bootstrap, archive a copy without changing the active checkpoint:

```bash
sudo install -m 0600 \
  /etc/noblepay/bootstrap-checkpoint.json \
  /etc/noblepay/bootstrap-checkpoint."$RELEASE_SHA".json
```

## 6. Governance multisig acceptance

First prove that the complete checkpoint still matches every finalized input.
Reserve the absent manifest path now; this command neither creates it nor
connects to an RPC:

```bash
export MANIFEST_FILE=/etc/noblepay/finalized-manifest."$RELEASE_SHA".json

node --env-file=/etc/noblepay/core.env \
  scripts/deploy-devnet-core.mjs \
  --finalize \
  --validate-only \
  --checkpoint-file /etc/noblepay/bootstrap-checkpoint.json \
  --manifest-file "$MANIFEST_FILE"
```

Generate the exact non-broadcasting multisig payload:

```bash
node --env-file=/etc/noblepay/core.env \
  scripts/prepare-governance-acceptance.mjs \
  --checkpoint-file /etc/noblepay/bootstrap-checkpoint.json
```

The governance team must submit the emitted `target`, zero `value`, and
`calldata` from exactly `ADMIN_ADDRESS`. The decoded method must be
`acceptOwnership()` on the checkpointed `SealSettlementGate`. Record the
multisig proposal ID, approvals, execution transaction, receipt, and block.

After execution, rerun the bootstrap command. It must verify
`owner() == ADMIN_ADDRESS`, `pendingOwner() == 0x000...000`, and emit
`phase: "finalization-required"` without deploying another contract.

## 7. Finalize and propagate the manifest

After governance acceptance, repeat the validation to detect any intervening
input or checkpoint change:

```bash
node --env-file=/etc/noblepay/core.env \
  scripts/deploy-devnet-core.mjs \
  --finalize \
  --validate-only \
  --checkpoint-file /etc/noblepay/bootstrap-checkpoint.json \
  --manifest-file "$MANIFEST_FILE"
```

If it passes, run the same command without `--validate-only`:

```bash
node --env-file=/etc/noblepay/core.env \
  scripts/deploy-devnet-core.mjs \
  --finalize \
  --checkpoint-file /etc/noblepay/bootstrap-checkpoint.json \
  --manifest-file "$MANIFEST_FILE" \
  2>&1 | tee -a /etc/noblepay/finalize-transcript.log
```

Finalize uses the same input digest and checkpoint, verifies governance
acceptance, removes the temporary deployer's roles, and pins one release block
through both private and public RPCs. The manifest is written atomically with
mode `0600` only after all publication checks pass.

Create the production environment, populate its non-release secrets, and apply
only the allowlisted manifest-derived values:

```bash
sudo install -m 0600 deploy/production.env.example /etc/noblepay/production.env
sudo chown "$(id -u):$(id -g)" /etc/noblepay/production.env

node scripts/apply-finalized-manifest.mjs \
  --manifest-file "$MANIFEST_FILE" \
  --env-file /etc/noblepay/production.env
```

The applier updates chain identity, contract/token addresses, public endpoints,
frontend settings, and `INDEXER_START_BLOCK`. It deliberately cannot alter the
database, private RPC, compliance service, Travel Rule keys, application
secrets, finality depth, gateway secrets, or bind addresses. Populate and
review those remaining fields separately.

Never use bootstrap addresses or `HANDOFF_PENDING_JSON` as application
configuration. Only the finalized manifest is authoritative.

## 8. Production environment and ports

The expected host bindings are:

| Service                 | Host port | Default bind |
| ----------------------- | --------: | ------------ |
| Frontend                |    `3008` | `127.0.0.1`  |
| Node API and WebSocket  |    `4008` | `127.0.0.1`  |
| Optional Go gateway     |    `4018` | `127.0.0.1`  |
| Unprivileged Nginx edge |    `8080` | `0.0.0.0`    |

The production environment still requires independent high-entropy
`POSTGRES_PASSWORD`, `JWT_SECRET`, `API_KEY_HASH_SECRET`,
`COMPLIANCE_API_KEY`, Travel Rule keyring, real external compliance origin,
operator-approved `NOBLEPAY_MIN_CONFIRMATIONS`, and any enabled gateway
credentials. The external compliance service and genuine TEE must be ready
before application traffic is enabled.

Validate without exposing the rendered secret-bearing Compose output:

```bash
node scripts/validate-production-config.mjs \
  --env-file /etc/noblepay/production.env

docker compose \
  --env-file /etc/noblepay/production.env \
  -f compose.production.yml \
  config --quiet

docker compose \
  --profile gateway \
  --env-file /etc/noblepay/production.env \
  -f compose.production.yml \
  config --quiet
```

## 9. Build and start

Back up PostgreSQL and, when enabled, the gateway volume before changing the
stack. Verify the Travel Rule migration precondition in `deploy/README.md`.

Build reviewed images and start the base stack:

```bash
docker compose \
  --env-file /etc/noblepay/production.env \
  -f compose.production.yml \
  build --pull

docker compose \
  --env-file /etc/noblepay/production.env \
  -f compose.production.yml \
  up -d --wait postgres migrate backend frontend proxy
```

Enable the optional single-instance gateway only after its credentials,
durable volume, `INDEXER_START_BLOCK`, and confirmations have been reviewed:

```bash
docker compose \
  --profile gateway \
  --env-file /etc/noblepay/production.env \
  -f compose.production.yml \
  up -d --wait gateway
```

## 10. Health and controlled smoke checks

These checks are read-only and must pass before the TLS load balancer admits
user traffic:

```bash
curl -fsS http://127.0.0.1:3008/ >/dev/null
curl -fsS http://127.0.0.1:4008/healthz
curl -fsS http://127.0.0.1:4008/readyz
curl -fsS http://127.0.0.1:8080/ >/dev/null
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/readyz)" = "404"

docker compose \
  --env-file /etc/noblepay/production.env \
  -f compose.production.yml \
  ps
```

When the gateway is enabled:

```bash
curl -fsS http://127.0.0.1:4018/readyz
```

Also verify the external TLS site, `/api/` routing, security headers, browser
network identity, compliance dataset freshness, and monitoring alerts. Do not
create a payment or channel merely as a health check. Any controlled
transaction smoke must use a separately approved low-value test account and
change ticket after all read-only checks pass.

## 11. Partial failure and rollback

- **Interrupted bootstrap:** preserve the checkpoint and transcripts, then
  rerun the identical bootstrap command. Never empty the checkpoint to bypass
  verification.
- **Governance has not accepted:** application configuration remains blocked.
  The deployed contracts cannot be erased. If the ceremony is abandoned,
  record them as abandoned and ensure no funds or application traffic use them.
- **Interrupted finalize:** preserve the checkpoint and use a new, absent
  manifest path when rerunning. Role removal is idempotent.
- **Application rollback:** stop ingress, keep database/gateway volumes, restore
  the last reviewed production env and image digests, rerun `config --quiet`,
  and start the prior stack. Never run `docker compose down -v`.
- **Database migration problem:** keep traffic disabled and restore the matched
  database backup plus prior application images. Do not improvise a reverse
  Prisma migration.
- **On-chain incident after use:** container rollback does not reverse chain
  state. Follow the governed pause/role/token incident procedure, reconcile
  funds and events, and retain the finalized manifest and receipts.

Example base-stack stop without deleting durable volumes:

```bash
docker compose \
  --env-file /etc/noblepay/production.env \
  -f compose.production.yml \
  stop proxy frontend backend gateway
```

No step in this runbook makes the release deployable while the external TLS,
governance, immutable anchor, real token, compliance, TEE, or secret inputs are
unavailable.
