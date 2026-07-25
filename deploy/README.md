# NoblePay production deployment

The intended production topology exposes the frontend on host port `3008` and the Node API on host port `4008`, both bound to loopback by default. The unprivileged Nginx edge binds to `8080` by default. The optional Go gateway uses `4018`, so it cannot collide with the required Node API port.

The release images use Node.js `24.18.0`, Go `1.25.12`, Debian `13.6` for the gateway runtime, PostgreSQL `16.14` on Alpine `3.24`, and the unprivileged Nginx `1.30.4` Alpine `3.24` image. CI pins the local/test Rust reference to Rust `1.90.0`; that binary is still excluded from production. Treat every base-image change as a reviewed release change and always rebuild with `--pull`; never silently substitute an older host-installed runtime.

The repository's Rust compliance binary is a local/test reference service only. It is not packaged in production Compose and its `mock-tee` feature must never be deployed. Production requires an independently audited external compliance service; the backend and optional gateway fail closed when its health or screening contract is unavailable.

Production exposes only the supported NoblePay release surface documented in the root README. Roadmap page and API prefixes return a generic `404`; setting unused adapter variables cannot activate them. Preview routes are limited to processes started explicitly with `NODE_ENV=development` or `NODE_ENV=test`.

## Required external dependencies

- An activated Aethelred EVM network with an operator-confirmed chain ID and retained logs from the finalized deployment manifest's `indexer.startBlock` (also emitted as `INDEXER_START_BLOCK`). This is the NoblePay creation block and is the only supported fresh-replay boundary. Set `INDEXER_CONFIRMATIONS` to the operator-approved finality depth (minimum `1`; default `2`). A planned network name or documentation example is not deployment evidence.
- Contract deployment requires an HTTPS `RPC_URL` for `testnet` or `mainnet`; plaintext HTTP is permitted only when `CHAIN_ENV=devnet` for a local development chain.
- `AETHELRED_RPC_URL` is server-only and may contain provider credentials. Never pass it to a `NEXT_PUBLIC_*` build argument. `PUBLIC_AETHELRED_RPC_URL`, `PUBLIC_AETHELRED_WS_URL`, and `PUBLIC_AETHELRED_EXPLORER_URL` are always required, are bundled into browser code, and must be credential-free HTTPS/WSS endpoints confirmed by the US network operator.
- `NOBLEPAY_CHAIN_ID` feeds both the backend and the immutable frontend build. `AETHELRED_NETWORK_ANCHOR_BLOCK` and `AETHELRED_NETWORK_ANCHOR_HASH` identify the exact activated network even when another network reuses that chain ID. Production validation rejects missing, malformed, or divergent frontend values; `7332` appears only in local/CI examples and is not asserted as a live public-network ID.
- A finalized, two-phase governance handoff for bytecode-verified `NoblePay`, `BusinessRegistry`, `SealSettlementGate`, and `PaymentChannels` addresses from `scripts/deploy-devnet-core.mjs`. Before deployment, run a clean Hardhat compile followed immediately by `node scripts/deploy-devnet-core.mjs --verify-artifacts` from the repository root; the gate must confirm the deployable ABI, bytecode, build information, current Solidity sources, and compiler settings. A bootstrap checkpoint or `HANDOFF_PENDING_JSON` is not a deployable manifest.
- Real supported-token contract addresses and a complete `NOBLEPAY_TOKEN_CONFIG` matching their decimals.
- PostgreSQL 16.14 durable storage and separately backed-up Docker volumes. Existing 16.x installations still require a verified backup and restore drill before the container patch upgrade.
- An audited external compliance service at `COMPLIANCE_API_URL`. It must provide unauthenticated `GET /v1/health`, authenticated `POST /v1/screen`, and authenticated `POST /v1/sanctions/update`; enforce genuine hardware attestation; durably replay the original result and transaction for a repeated NoblePay `request_id`/`Idempotency-Key`; and serve current, integrity-checked OFAC, UAE Central Bank, UN, and EU datasets. The HTTPS URL is an external origin only, without credentials, `/v1`, query, or fragment. Localhost, loopback, reserved test domains, and mock/placeholder hostnames are rejected in production.
- A `TRAVEL_RULE_THRESHOLD_USD` agreed with that operator, plus a randomly generated 32-byte AES key in the bounded JSON `TRAVEL_RULE_ENCRYPTION_KEYS` keyring and its `TRAVEL_RULE_ACTIVE_KEY_ID`. Back up every referenced key through the full Travel Rule record-retention period. During rotation, add the new key, switch the active ID, re-encrypt retained records under an audited migration, and remove an old key only after proving no row references it; losing a referenced key deliberately makes screening fail closed.
- `GET /v1/health` must return `status: "healthy"` and non-empty `sanctions_lists` metadata: `total_entries`, all four `last_updated` timestamps, a production `source`, `dataset_generated_at`, and a 64-character SHA3-256 `dataset_digest`. Both backend and gateway reject future or data older than `COMPLIANCE_MAX_DATASET_AGE_HOURS`.
- The external operator must use a dedicated EOA at `TEE_NODE_ADDRESS`. Its managed hardware/service signing key must remain in the audited compliance operator, never on the NoblePay deployment host. The EOA must hold NoblePay `TEE_NODE_ROLE`, submit each result directly on-chain, and return the confirmed transaction hash exactly as specified in [compliance-api-contract.md](compliance-api-contract.md). Safe/module/relay submission is not supported by this release because reconciliation authorizes `transaction.from`; both deployment phases reject bytecode at this address. A successful screening response without independently verifiable on-chain evidence is rejected.
- The optional Go gateway is a single-instance durable projection/indexer. Its file store, replay set, and rate limiter are process-local; do not run multiple replicas against one volume. Set `GATEWAY_TRUSTED_PROXY_CIDRS` only to the exact proxy networks whose forwarding headers should be trusted.
- Gateway-only values (`GATEWAY_API_KEY`, `WEBHOOK_SECRET`, and `INDEXER_START_BLOCK`) may be omitted when the profile is disabled. The gateway validates them and refuses startup when `--profile gateway` is enabled without real values.
- TLS termination, DNS, monitoring, alerting, log shipping, host firewalling, and secret delivery supplied by the VPS/operator. The compose file contains no credential values.

## Launch procedure

1. Reproduce and verify the deployment artifacts from reviewed source: `cd contracts && npx hardhat clean && npx hardhat compile && cd .. && node scripts/deploy-devnet-core.mjs --verify-artifacts`. Do not deploy or package artifacts if this gate fails, and do not use previously committed/generated `contracts/artifacts/` or `contracts/cache/` output as release evidence.
2. Obtain the activated chain ID, an independently confirmed immutable block number/hash, plus public RPC, WebSocket, and explorer endpoints from the US network operator. Confirm the private and public RPCs' `eth_chainId` and exact anchor hash, complete the two-phase contract ceremony below, then copy `deploy/production.env.example` outside the repository, populate it only from the finalized deployment manifest, restrict it to mode `0600`, and inject it through your secret manager or Docker Compose `--env-file`.
3. Verify the external compliance service reports a fresh sanctions snapshot and genuine TEE readiness before enabling traffic.
   Confirm its operator address matches `TEE_NODE_ADDRESS` from the deployment manifest, `eth_getCode` returns `0x` through both private and public RPCs, and the address currently holds `TEE_NODE_ROLE`.
4. Validate the populated environment with `node scripts/validate-production-config.mjs --env-file /secure/path/noblepay.env`, then render it with `docker compose --env-file /secure/path/noblepay.env -f compose.production.yml config`.
5. Build immutable local images with `docker compose --env-file /secure/path/noblepay.env -f compose.production.yml build --pull`.
6. Before migrations, verify `SELECT count(*) FROM travel_rule_records` is zero. The former table had no authorized encrypted writer, so this release deliberately refuses to guess, delete, or relabel a legacy row. If any row exists, stop and complete a reviewed retention/re-authorization plan. Then apply database migrations with the one-shot `migrate` service and start the stack. Compose orders the migration before backend startup.
7. Verify `http://127.0.0.1:3008/`, `http://127.0.0.1:4008/readyz`, the proxy container health check on `8080`, and the TLS edge. Enable the optional gateway only when required with `--profile gateway`, then verify its `/readyz` endpoint on `4018` before sending traffic.

For Travel Rule disclosure audits, `outbound_attempt_count` and its destination
and timestamps are conservative evidence that cleartext might have crossed the
TLS boundary. They do not prove delivery. Only `shared=true` with the retained,
independently verified submission transaction/block proves final sharing; that
state is committed atomically with the local screening result.

## Two-phase contract governance ceremony

Copy `deploy/core-deployment.env.example` to a host-only, mode-`0600` file and replace every placeholder. `DEPLOYER_ADDRESS` is a temporary funded signer. `ADMIN_ADDRESS` is the final governance account and must be a deployed multisig contract on testnet or mainnet, `TREASURY_MANAGER_ADDRESS` holds `TREASURY_ROLE` on both NoblePay and PaymentChannels, and `TREASURY_ADDRESS` only receives fees. `TEE_NODE_ADDRESS` is deliberately EOA-only for direct compliance submissions. The script rejects reuse of the deployer for a final role, rejects a treasury manager that is also the fee beneficiary, and rejects any deployed bytecode at the TEE operator address before mutations, checkpoint acceptance, and final manifest publication.

1. Inject the secure deployment environment and run `node scripts/deploy-devnet-core.mjs --bootstrap` with `BOOTSTRAP_CHECKPOINT_JSON` empty only on the first invocation. Before any mutation, the command verifies the chain ID, exact `AETHELRED_NETWORK_ANCHOR_BLOCK` hash, and EOA-only TEE operator, then verifies token decimals and the ISeal precompile. After each confirmed contract creation it emits an updated `BOOTSTRAP_CHECKPOINT_JSON` containing the address, creation transaction, block number, block hash, `teeNodeAccountType: "eoa"`, and a digest binding every governance actor, account type, token, fee, and CEAP policy input. Immediately persist each complete single-line value in the secure environment before allowing the ceremony to continue.
2. If bootstrap stops, rerun `--bootstrap` with the newest persisted checkpoint and the identical inputs. The script rejects gaps, duplicates, network/deployer/configuration-digest mismatches, non-canonical blocks, wrong creation transactions or constructor arguments, and runtime bytecode that differs from the reviewed artifacts. It resumes at the first missing deployment, then idempotently verifies or completes policy, links, fees, PaymentChannels' one-time live BusinessRegistry configuration, final roles, and the exact enabled-token set reconstructed from each contract's event history. Once configured, it initiates `SealSettlementGate.transferOwnership(ADMIN_ADDRESS)` and emits `HANDOFF_PENDING_JSON` containing the complete checkpoint and anchor.
3. From the final governance wallet or multisig, submit `acceptOwnership()` to the checkpoint's `gate.address`. This transaction must be executed by `ADMIN_ADDRESS`, independently of the temporary deployer. Confirm on-chain that `owner() == ADMIN_ADDRESS` and `pendingOwner() == 0x0000000000000000000000000000000000000000`.
4. With the same reviewed inputs, immutable network anchor, and complete `BOOTSTRAP_CHECKPOINT_JSON`, run `node scripts/deploy-devnet-core.mjs --finalize`. It first re-verifies every checkpoint receipt, exact creation transaction and constructor input, canonical deployment block, runtime bytecode, private RPC anchor, browser-facing `PUBLIC_AETHELRED_RPC_URL` anchor, gate ownership, final role, and configuration value. It then has the deployer renounce operational roles, contract admin roles, and finally each `DEFAULT_ADMIN_ROLE`. A rerun skips roles already renounced. After the final mutation, the command pins one canonical release block and reads every runtime, role membership, configuration value, TEE EOA assertion, and enabled-token event history at that exact block through both the private and browser-facing RPCs. Both RPCs must also reproduce all four checkpoint receipts, creation transactions, deployment blocks, and reviewed runtimes. The exact release block hash is rechecked through both RPCs as the final asynchronous publication boundary. Only then does the command emit `DEPLOYMENT_MANIFEST_JSON`, including `releaseBlock`, plus matching backend/frontend anchor values.
5. Archive the bootstrap/finalize transaction receipts, governance acceptance receipt, final manifest, and role-query evidence together. Never treat bootstrap console addresses, a pending ownership transfer, or a partially completed finalize run as application configuration.

Testnet and mainnet fail closed unless `RPC_URL` is HTTPS and every deployment/role/policy address is explicit. If any phase stops, preserve the newest complete checkpoint and rerun the same phase; do not deploy a second set merely to bypass a failed verification.

There is no deployment-time payment-channel KYC allowlist. Before a wallet can open, join, or add balance to a channel, it must register through the normal `BusinessRegistry` flow and a current `BUSINESS_VERIFIER_ADDRESS` must mark it `VERIFIED`. `PaymentChannels.kycVerified(address)` resolves `BusinessRegistry.isBusinessActive(address)` live on every protected operation, so suspended, revoked, unregistered, or overdue records fail closed immediately. Do not attempt to replace this onboarding with deployment-script state.

Existing escrow is not held hostage by later KYC state. An opener may call `cancelOpenChannel` while paused when the counterparty never funded; either party may call `initiateCurrentStateClose` for an active channel and then use the normal challenge flow. Counter-disputes, HTLC claim/refund remedies, and `finalizeClose` remain available while paused. Finalization is valid only after (not at) `expiresAt`.

The NoblePay core pause likewise blocks new payments, compliance writes, and recipient settlement without trapping existing escrow. Sender-only cancellation of `PENDING` payments, the state/role-restricted refund paths, and the two-step failed-settlement recovery remain executable while paused. Do not describe the pause as a custody freeze or use it as a substitute for incident-specific token/role controls.

`TREASURY_MANAGER_ADDRESS` can rotate `PaymentChannels.protocolTreasury` or reduce the bounded protocol fee to zero before retrying settlement if a supported stablecoin blocklists the current fee beneficiary. The role cannot set a fee above 500 basis points, and the failed token transfer reverts the complete settlement atomically, leaving the channel closing and retryable. Archive every emergency rotation/fee transaction with the incident record. The release deliberately provisions no channel router or watchtower role: there is no production claim of atomic multi-channel routing or automated third-party dispute execution.

## Platform administrator bootstrap

The platform administrator wallet must both hold `BusinessRegistry.ADMIN_ROLE`
and have a registered NoblePay business profile. Register that wallet through
the normal on-chain registration flow before attempting an administrator
sign-in; a chain administrator without a matching profile is intentionally
rejected by the authentication challenge endpoint.

Wallet authentication reads `ADMIN_ROLE` from the configured registry on the
configured chain before issuing a `SUPER_ADMIN` session. Cross-tenant reads and
non-receipt platform operations recheck that role on every request, so an
on-chain revocation takes effect immediately. RPC or registry-read failures
fail closed. API keys always remain tenant-scoped `ADMIN` credentials and can
never acquire platform-administrator authority.

Never use the bundled Rust reference binary, fixture sanctions/model records, a development RPC, or in-memory/fileless service state in production. A missing or stale sanctions dataset, unavailable RPC, failed migration, absent durable gateway path, invalid API key, or unavailable real TEE must keep the dependent service unready.

NoblePay core is intentionally limited to governance-approved USDC and USDT
contracts with exactly 6 decimals. Native AETHEL and wrapped AETHEL are not
accepted by this release. The flat fee and all volume limits therefore share a
single smallest-unit scale, and the deployment script verifies token bytecode
and decimals before enabling either token.
