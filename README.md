# NoblePay

NoblePay is Aethelred’s business-payment application for wallet-authenticated onboarding, on-chain settlement, compliance screening, payment channels, risk visibility, and audit evidence.

NoblePay’s default ports are deliberately unique within the shared dApp host. The repository does not assume that a public Aethelred EVM network or chain ID is live: production builds require the US network operator to supply the activated chain ID, an immutable block-number/hash network anchor, and public browser endpoints.

| Service                           |           Port | Exposure                                           |
| --------------------------------- | -------------: | -------------------------------------------------- |
| Next.js frontend                  |         `3008` | Public through the reverse proxy                   |
| TypeScript API and WebSocket      |         `4008` | Private/loopback through the reverse proxy         |
| Audited compliance submission API | External HTTPS | Operator-managed; not hosted by this Compose stack |
| Optional Go gateway/indexer       |         `4018` | Internal only                                      |
| PostgreSQL                        |         `5432` | Internal only                                      |

`4003` remains available for ZeroID. NoblePay uses `4008`, avoiding the ZeroID/NoblePay collision that existed when both used `3003`.

## Supported production surface

The supported release consists of wallet session authentication, business registration and tier reconciliation, exact stablecoin payments, externally attested compliance submission, payment lifecycle reconciliation, tenant-scoped audit and analytics, payment-channel funding/disputes, JSON regulatory evidence packages, and credential/contract diagnostics. These are the only modules shown in production navigation.

Treasury execution, liquidity pools, streaming payments, AI decision mutations, invoice financing, FX execution, and cross-chain transfer mutation remain roadmap integrations. Their page and API prefixes return `404` in production and are available only in explicit development/test environments. Operator-provided contracts, audited services, and governance policies are required before any of those modules can be activated; none can return simulated success.

## Trust model

- A wallet signs a short-lived challenge before NoblePay creates an HttpOnly browser session. State-changing API calls also require the session’s CSRF token.
- Business registration is accepted only after the API independently verifies the `BusinessRegistry` transaction, sender, calldata, event, chain ID, contract address, and confirmation depth.
- New registrations remain `PENDING` and cannot authenticate until the independently operated `BUSINESS_VERIFIER_ADDRESS` submits `verifyBusiness` on-chain and a platform administrator reconciles that exact confirmed transaction. The administrator UI/API does not submit verification from the admin wallet.
- EOA wallets use EIP-191 signatures and direct contract calls. Safe business wallets use anchored EIP-1271 authentication and are accepted only when the canonical Safe `execTransaction` performs a zero-value `CALL` to the intended contract; relays, modules, value transfers, wrong targets, and delegatecalls are rejected.
- Business suspension, reinstatement, revocation, tier, and admin-role state are read live from `BusinessRegistry`. HTTP sessions, API keys, and authenticated WebSocket delivery fail closed on the next use when that state is inactive or unavailable; irreversible revocation also revokes persisted active API keys during reconciliation.
- Payments are submitted from the connected wallet. The API records them only after independently reconciling the successful `NoblePay` receipt and all client claims.
- Payment-channel close and dispute artifacts are EIP-712 typed data bound to the chain, contract, channel, balances, nonce, purpose, and current on-chain state epoch. Channel funding/top-ups and every HTLC create, claim, or refund invalidate all older artifacts, including one with a future nonce.
- Payment-channel escrow has guaranteed on-chain exits: the opener can cancel and recover an `OPEN` channel that the counterparty never funded, and either party can challenge-close an `ACTIVE` channel from its canonical balances without a prior off-chain signature. These exit/remedy paths remain available after KYC loss and during an emergency pause; settlement becomes valid only strictly after the counter-dispute deadline.
- A NoblePay emergency pause blocks new initiation, screening, and settlement but cannot confiscate escrow: the sender may still cancel `PENDING` funds, authorized refunds retain their exact status/role checks, and the delayed failed-settlement recovery remains available.
- PaymentChannels exposes no metadata-only watchtower or routing completion facade. Conditional HTLC state is real and enforceable within a channel, but the release does not claim atomic multi-channel routing.
- API-key access is tenant-scoped. Only an HMAC-peppered lookup value is stored, and credential-derived database failures are never written to logs. Audit entries are canonical, hash-linked, and tenant-scoped.
- Synchronous audit exports are limited to 93 days, 5,000 entries, and 5 MiB. Full audit-chain verification reads 500 entries at a time; the statistics response marks integrity as not checked instead of implicitly repeating that scan, and the explicit verification endpoint returns the current result.
- Synchronous regulatory evidence generation is limited to 93 days, 2,000 payments, 10 screening records per payment, and 5 MiB of canonical JSON. Report lists are summary-only and paginated at 20 by default (50 maximum), while analytics use database aggregates without loading report content. Larger evidence sets must be split into adjacent periods or processed by a separately governed asynchronous evidence pipeline.
- Sanctions health, screening, TEE evidence, and on-chain result submission come from the independently audited service at `COMPLIANCE_API_URL`. Production never invokes the bundled Rust reference engine or falls back to generated records.
- At or above `TRAVEL_RULE_THRESHOLD_USD`, screening requires the tenant business wallet to sign a five-minute, domain-separated commitment to the exact payment and strict IVMS101 fields. EOA signatures use EIP-191 and contract business wallets use anchored EIP-1271 verification. The API persists only AES-256-GCM ciphertext under the versioned `TRAVEL_RULE_ENCRYPTION_KEYS` keyring; below threshold it sends no Travel Rule payload.
- Features that need a chain, oracle, regulator, model, or hardware TEE adapter fail closed when that dependency is unavailable; they never return simulated success.

### Business verification operator flow

1. The business wallet registers itself and receives an on-chain `PENDING` record. For a Safe, the owners execute a standard zero-value Safe `CALL` to `BusinessRegistry.registerBusiness`; the API accepts the Safe signature through EIP-1271.
2. The independently managed `BUSINESS_VERIFIER_ADDRESS` reviews the submitted identity and sends `BusinessRegistry.verifyBusiness(businessWallet)`. This verifier may itself be a Safe, but it must be the exact address configured in the API and hold `VERIFIER_ROLE` at the confirmed block.
3. After confirmation, an authenticated platform-admin wallet submits only that transaction hash to `POST /v1/businesses/:id/verify`. The API proves calldata, signer role, configured verifier identity, event, registry state, immutable network anchor, receipt, transaction, and block again immediately before updating the database.
4. The business can sign in only after the live registry record is `VERIFIED` and unexpired. Suspension or revocation blocks existing browser sessions, API keys, and tenant WebSocket delivery on their next authorization check.

Do not use the platform-admin wallet to submit `verifyBusiness`; verification and reconciliation are intentionally separate duties. Tier upgrades and irreversible revocations require a current `ADMIN_ROLE` transaction, while suspension and reinstatement require the configured verifier.

## Local frontend and API

Prerequisites are Node.js 24.18.0, PostgreSQL 16.14, an Aethelred RPC endpoint, contracts deployed on that same selected chain, and access to the audited external compliance submission API. Gateway validation uses Go 1.25.12, and the local compliance reference is pinned to Rust 1.90.0. The complete local release gate also needs Chromium for Playwright and `cargo-audit` 0.22.0; install them with `npx playwright install chromium` and `cargo install cargo-audit --version 0.22.0 --locked`. The crate under `crates/noblepay-compliance` is explicitly local/test reference code; it starts only in `COMPLIANCE_ENV=test` with the `mock-tee` feature and is not a production prerequisite.

Frontend:

```bash
cp .env.example .env.local
npm ci
npm run dev
```

The development frontend is available at `http://localhost:3008`.

API:

```bash
cd backend
cp .env.example .env
npm ci
npx prisma generate
npx prisma migrate deploy
npm run dev
```

The API is available at `http://localhost:4008`; its WebSocket endpoint is `ws://localhost:4008/ws`.

Do not use zero addresses or development secrets. The frontend and API must use the same chain ID and deployed contract addresses. `backend/.env.example` documents every required receipt-reconciliation and compliance variable.

## Production build commands

Frontend on port `3008`:

```bash
npm ci
npm run build
NODE_ENV=production PORT=3008 npm run start
```

API on port `4008`:

```bash
cd backend
npm ci
npx prisma generate
npx prisma migrate deploy
npm run build
NODE_ENV=production PORT=4008 npm run start
```

The API refuses production startup when required database, chain, contract, compliance, JWT, or CORS configuration is absent or invalid.

For the exact US public-testnet checkout, two-phase deployment, resume,
governance acceptance, manifest propagation, Compose startup, smoke, and
rollback commands, follow
[deploy/PUBLIC_TESTNET_OPERATOR_RUNBOOK.md](deploy/PUBLIC_TESTNET_OPERATOR_RUNBOOK.md).
For the wider container topology, secret-file requirements, reverse-proxy
routing, sanctions dataset checks, and TEE prerequisite, follow
[deploy/README.md](deploy/README.md). Render the Compose configuration before
building:

```bash
docker compose \
  --env-file /secure/path/noblepay.env \
  -f compose.production.yml \
  config --quiet
```

## Contract deployment

Compile contracts first:

```bash
cd contracts
npm ci
npx hardhat clean
npx hardhat compile
node ../scripts/deploy-devnet-core.mjs --verify-artifacts
cd ..
```

The `--verify-artifacts` gate must pass immediately after every clean compile. It rejects stale or substituted deployment artifacts by matching the deployable ABI and bytecode to Hardhat build information, the current Solidity sources, and the configured compiler settings. Generated `contracts/artifacts/` and `contracts/cache/` outputs are intentionally ignored; reproduce them from the reviewed source instead of committing them.

`scripts/deploy-devnet-core.mjs` uses an explicit two-phase governance handoff. `--bootstrap` deploys `BusinessRegistry`, `SealSettlementGate`, `NoblePay`, and `PaymentChannels` with the temporary deployer. After every confirmed creation it prints an updated `BOOTSTRAP_CHECKPOINT_JSON` with the exact transaction and canonical block evidence plus a digest binding the ceremony inputs. Persist each complete line in the secure operator environment. A rerun verifies that evidence, resumes at the first missing deployment, configures and verifies the contracts (including the channel contract's immutable-after-configuration live BusinessRegistry dependency), grants the final governance/operator roles, initiates `SealSettlementGate`'s `Ownable2Step` transfer, and prints `HANDOFF_PENDING_JSON`; application configuration remains withheld.

After `ADMIN_ADDRESS` accepts gate ownership, rerun the command with `--finalize` and the complete `BOOTSTRAP_CHECKPOINT_JSON`. Finalization re-verifies every creation receipt, transaction input, canonical deployment block, runtime bytecode, exact enabled-token set, configuration, final role membership, and accepted gate ownership; renounces the deployer's verifier, treasury-manager, admin, and default-admin roles; and verifies their absence. The final checks are pinned to one canonical release block through both private and browser-facing RPCs, including the complete checkpoint evidence and reviewed runtimes, and both RPCs must reproduce that exact block hash immediately before publication. Only then does the command print `DEPLOYMENT_MANIFEST_JSON` (including `releaseBlock`) and frontend environment values. The deployer, final governance, treasury manager, business verifier, TEE node, and compliance officer must be separate from the temporary deployer. `TREASURY_MANAGER_ADDRESS` is also deliberately separate from the fee-beneficiary `TREASURY_ADDRESS`.

Start from [deploy/core-deployment.env.example](deploy/core-deployment.env.example) and follow the two-phase ceremony in [deploy/README.md](deploy/README.md). The script intentionally has no defaults for private keys, policy, roles, tokens, or fees. Inject populated values through the operator's secret manager; never commit them. `RPC_URL` must use HTTPS for testnet or mainnet deployment; plaintext HTTP is accepted only for an explicitly selected local `devnet`.

The public-testnet repository contains no canonical USDC or USDT address. Use
chain-operator-confirmed contracts when they exist; otherwise follow the
testnet-only, chain-ID-gated provisioning ceremony in
[deploy/PUBLIC_TESTNET_OPERATOR_RUNBOOK.md](deploy/PUBLIC_TESTNET_OPERATOR_RUNBOOK.md).
Its manifest supplies the three token variables consumed by the core ceremony
without containing a key or RPC URL.

## Validation

Run the complete release gate:

```bash
npm run validate:all
```

Individual gates are also available:

```bash
npm run validate:frontend
npm run validate:backend
npm run validate:contracts
npm run validate:gateway
npm run validate:compliance
npm run validate:security
node scripts/validate-production-config.mjs --env-file /secure/path/noblepay.env
```

Dependency audits (including development and build tooling at moderate severity or higher):

```bash
npm run validate:dependencies
(cd crates/noblepay-compliance && cargo audit --deny warnings)
(cd services/gateway && GOTOOLCHAIN=go1.25.12 go run golang.org/x/vuln/cmd/govulncheck@v1.6.0 ./...)
```

The tooling audit has one advisory-specific, expiring exception for
`GHSA-mh99-v99m-4gvg` through legacy `brace-expansion` 1.x/2.x consumers.
Those paths are development/test-only, no compatible patched 1.x/2.x release
exists, and forcing 5.x into them changes the CommonJS API and breaks the test
toolchain. The exception expires on 2026-08-01; production graphs remain hard
gates with no exception.

Runtime-only Node dependency audits remain available separately:

```bash
npm audit --omit=dev --audit-level=moderate
(cd backend && npm audit --omit=dev --audit-level=moderate)
(cd contracts && npm audit --omit=dev --audit-level=moderate)
```

## Health checks

- Frontend: `GET /`
- API liveness: `GET /healthz`
- API readiness: `GET /readyz`
- API metrics: `GET /metrics`
- External compliance health: `GET ${COMPLIANCE_API_URL}/v1/health` (operator/internal monitoring; not proxied publicly)
- Optional gateway readiness: `GET /readyz` on port `4018`

The edge proxy exposes API routes below `/api/` and strips that prefix before forwarding to Express `/v1/*`. WebSocket traffic is exposed at `/ws`.

## Repository layout

```text
src/                         Next.js application, hooks, session UI, and tests
backend/                     Express API, Prisma schema/migrations, and tests
contracts/                   Solidity contracts and Hardhat tests
crates/noblepay-compliance/  Local/test compliance API reference (never production)
services/gateway/            Optional Go gateway and durable indexer
scripts/                     Verified deployment and conformance commands
deploy/                      Production images, Nginx config, and runbook
```

## Operational requirements

- Terminate TLS at the edge and keep the NoblePay API, database, and optional gateway off the public interface. Reach the audited external compliance API only over its authenticated HTTPS origin.
- Back up PostgreSQL and gateway volumes; test restoration before accepting transactions.
- Rebuild with `--pull` for each release and review every pinned Node, Go, PostgreSQL, and unprivileged Nginx patch update before rollout.
- Use distinct high-entropy JWT, compliance, gateway, and webhook secrets.
- Pin the backend and immutable frontend build to the same operator-confirmed chain ID and `AETHELRED_NETWORK_ANCHOR_BLOCK`/`AETHELRED_NETWORK_ANCHOR_HASH`. Both deployment phases and backend security-sensitive receipt/authorization paths query that exact block. Finalization also verifies the browser-facing public RPC. Before every contract write, the frontend verifies both its configured public RPC and, as the final asynchronous preflight, the connected wallet's EIP-1193 provider. This distinguishes networks that reuse a chain ID; a matching public dApp RPC alone is not sufficient. The anchor block must remain available from every private, public, and wallet RPC. The local/test example value `7332` is not a production network declaration.
- Use verified contract addresses and exact ERC-20 decimals. A token is not accepted merely because the browser supplies its symbol.
- Keep a current sanctions dataset and digest from the approved ingestion pipeline.
- Alert on readiness failure, receipt-reconciliation failure, sanctions staleness, WebSocket disconnects, and audit-chain verification failure.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules.
