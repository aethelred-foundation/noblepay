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
- a private HTTPS EVM JSON-RPC endpoint;
- a credential-free public HTTPS EVM JSON-RPC endpoint;
- a credential-free public WSS endpoint and HTTPS explorer;
- a funded temporary deployer EOA and matching private key;
- a deployed final governance multisig;
- distinct treasury manager, fee beneficiary, business verifier, compliance
  officer, and dedicated compliance-operator EOA addresses;
- the real USDC and USDT contracts on that chain, each with six decimals;
- approved NoblePay and PaymentChannels fee values and the complete CEAP
  policy;
- a working ISeal precompile at `0x0000000000000000000000000000000000000900`.

`http://54.165.44.130:8545` and every other plaintext HTTP RPC are prohibited
for public-testnet release mode. The validator/RPC host at `54.165.44.130` may
be useful for internal chain diagnostics, but it is not a supported NoblePay
release endpoint. Both deployment phases and production validation reject
plaintext testnet RPCs.

The release remains blocked if the TLS endpoints, immutable block anchor,
governance inputs, or real token contracts are unavailable.

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
| `RPC_URL`                             | private HTTPS EVM JSON-RPC; never the plaintext `54.165.44.130` endpoint    |
| `AETHELRED_CHAIN_ID`                  | operator-confirmed decimal EVM chain ID                                     |
| `AETHELRED_NETWORK_ANCHOR_BLOCK/HASH` | independently confirmed immutable block identity                            |
| `DEPLOYER_KEY/ADDRESS`                | temporary funded EOA; key and address must match                            |
| `ADMIN_ADDRESS`                       | deployed final governance multisig                                          |
| `TREASURY_MANAGER_ADDRESS`            | holder of both treasury-management roles                                    |
| `TREASURY_ADDRESS`                    | fee beneficiary only; different from treasury manager                       |
| `BUSINESS_VERIFIER_ADDRESS`           | final BusinessRegistry verifier                                             |
| `TEE_NODE_ADDRESS`                    | dedicated external compliance-operator EOA with no bytecode                 |
| `COMPLIANCE_OFFICER_ADDRESS`          | final NoblePay compliance officer                                           |
| token address variables               | exactly the real six-decimal USDC and USDT contracts                        |
| NoblePay and channel fee variables    | approved integer fee values                                                 |
| CEAP variables                        | approved backend, verification, platform, vendor-root, and residency policy |
| `SEAL_PROBE_ID`                       | operator-confirmed probe identifier for the ISeal read                      |
| public RPC/WSS/explorer variables     | credential-free TLS endpoints used by the browser                           |
| frontend URL/version variables        | final HTTPS/WSS application endpoints and release identifier                |

The configuration digest in the checkpoint binds all governance, custody,
fee, token, and CEAP values. Changing any of them makes resume/finalize fail.

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
