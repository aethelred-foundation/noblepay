# NoblePay Security and Production-Readiness Review

**Review date:** 2026-07-22
**Release status:** Conditional code release candidate; not a live-deployment authorization or security certification.

## Executive summary

The supported NoblePay core has been converted from a prototype into a fail-closed, chain-reconciled release candidate. Wallet authentication, business registration, stablecoin payment initiation and lifecycle actions, compliance submission/reconciliation, tenant audit and analytics, payment channels/disputes, JSON regulatory evidence, and production diagnostics now have real implementation paths and automated security regressions.

Seven unfinished roadmap products are deliberately unavailable in production: Treasury, Liquidity, Streaming, AI Compliance, Invoice Financing, FX Hedging, and Cross-chain. Their frontend and backend paths return a generic `404` outside explicit development/test environments. They must not be marketed or deployed as supported functionality.

The code is not ready to process live funds until the operator supplies and verifies the real Aethelred public-testnet configuration, deploys the reviewed contracts, configures audited external compliance infrastructure, installs production secrets/TLS, and completes a multi-user deployment drill. Test success cannot substitute for those operational prerequisites or for an independent smart-contract/application security audit.

## Supported production boundary

The release candidate supports:

- wallet-signed authentication and secure cookie sessions;
- wallet-signed, full-profile-bound business registration with confirmed on-chain receipt, calldata, event, and state reconciliation;
- exact-amount stablecoin payment approval and initiation with confirmed-chain reconciliation;
- payment cancel/refund lifecycle reconciliation;
- external compliance screening with fail-closed health, authenticity, freshness, source, and on-chain result checks;
- tenant-isolated business, payment, audit, analytics, and risk records;
- contract-backed payment channel and dispute workflows;
- canonical JSON regulatory evidence and optional governed delivery;
- contract/network/readiness diagnostics;
- an optional authenticated Go gateway with durable, confirmation-aware event projection and signed webhook ingestion.

The production ports are:

- frontend: `3008`;
- Node API and WebSocket: `4008`;
- optional Go gateway: `4018`.

NoblePay does not use `4003`, because that port is already assigned to the ZeroID backend on the shared host.

## Finding disposition

| ID    | Original risk                                                                                                           | Current disposition                                                                                                                                                                                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NP-01 | Treasury delegate could double-count approvals                                                                          | Resolved. Votes use the canonical underlying signer identity, including delegated actions.                                                                                                                                                                                                                                        |
| NP-02 | JWT authentication could use a repository-known fallback secret                                                         | Resolved. Non-test startup fails closed without production-grade session configuration.                                                                                                                                                                                                                                           |
| NP-03 | Cross-tenant reads/mutations and header-derived privilege                                                               | Resolved for the supported surface. Tenant ownership and permission checks are enforced, and platform-admin authority is revalidated against the configured registry.                                                                                                                                                             |
| NP-04 | Gateway API authentication failed open                                                                                  | Resolved. Production configuration requires authentication and rejects missing/weak values.                                                                                                                                                                                                                                       |
| NP-05 | Compliance threshold approval was not bound to proposed values                                                          | Resolved. Values are persisted and checked exactly; proposal IDs are domain-separated and finalized against replay.                                                                                                                                                                                                               |
| NP-06 | Cross-chain recovery could strand fees                                                                                  | Resolved in contract logic. Full escrow is returned on recovery and snapshotted fee portions are released only on confirmed delivery. Cross-chain UI/API remains roadmap-only and is `404` in production.                                                                                                                         |
| NP-07 | Webhooks lacked authenticity/freshness/replay controls                                                                  | Resolved. The gateway validates HMAC, bounded clock skew, nonce replay protection, canonical payloads, and receipt-derived settlement facts.                                                                                                                                                                                      |
| NP-08 | Rust compliance API was unauthenticated and broadly exposed                                                             | Mitigated by exclusion. The Rust service is local/test reference code, starts only in explicit test mode with `mock-tee`, and is absent from production Compose.                                                                                                                                                                  |
| NP-09 | Mock TEE was a default and hardware verification was not genuine                                                        | Mitigated by exclusion and fail-closed configuration. Mock attestation is test-only; production requires an independently audited external service with genuine hardware attestation.                                                                                                                                             |
| NP-10 | Compliance outcomes/attestations were simulated                                                                         | Resolved for core compliance: production consumes authenticated external results and reconciles them on-chain. The separate AI-compliance mutation API is unavailable; its preview is read-only in development/test and `404` in production.                                                                                      |
| NP-11 | Recurring payments bypassed multisig governance                                                                         | Resolved in contract logic with exact-term threshold approval, standard timelock, domain separation, and one-time authorization consumption. Streaming UI/API remains roadmap-only and is `404` in production.                                                                                                                    |
| NP-12 | Batch channel creation skipped single-channel validation                                                                | Resolved. Single and batch paths share challenge-period, fee, zero-address, self-counterparty, deployed-token, six-decimal, and exact escrow-transfer validation.                                                                                                                                                                 |
| NP-13 | On-chain funding or HTLC balance changes could be followed by replay of a future-nonce state signed before the mutation | Resolved. Every channel funding/top-up and HTLC create, claim, and refund advances a channel state epoch committed into the EIP-712 message; signatures from earlier epochs are invalid even when their nonce is higher.                                                                                                          |
| NP-14 | Flash liquidity transferred tokens without invoking the borrower, making legitimate atomic repayment impossible         | Resolved in the contract. The existing ABI now invokes the ERC-3156 callback, validates its magic return, pulls exactly principal plus fee, verifies the real pre/post token balance, rejects EOAs and reserve/balance divergence, and remains non-reentrant. Liquidity remains outside the supported production UI/API boundary. |

## Security controls verified in code

### Identity and session controls

- Authentication and registration challenges bind the relying-party origin, domain, chain ID, nonce, issue/expiry time, request ID, and purpose.
- Registration signatures additionally bind the transaction hash and a collision-safe ABI-encoded commitment covering the normalized address, license number, business name, jurisdiction, business type, compliance officer, and contact email.
- Challenges are single-use, short-lived, rate-limited, and atomically consumed.
- Session tokens are delivered in secure, HTTP-only cookies in production; state-changing cookie-authenticated requests require CSRF validation.
- API keys are stored as hashes, scoped to a business, and can be rotated/revoked.

### Chain and payment controls

- Registration and payment services verify the configured RPC chain ID, transaction hash, successful receipt, exact destination contract, sender, native value, calldata, emitted event, confirmations, and historical state before persisting a claim.
- Reconciliation writes use serializable database transactions, idempotency checks, and audit entries.
- Stablecoin allowance changes use zero-reset then exact approval where required; unlimited approvals are not used.
- Gateway indexing uses confirmed heads, bounded log ranges, durable checkpoints, canonical block metadata, reorg rollback, and atomic projection updates.
- Payment-channel state signatures use EIP-712 domain separation over the current chain and PaymentChannels deployment. The signed message binds channel, balances, nonce, current on-chain state epoch, and close/update purpose; funding/top-ups and HTLC mutations advance that epoch, and the frontend validates imported artifacts, the exact on-chain epoch, and recovered parties before submission.
- Payment-channel liveness no longer depends on counterparty cooperation: unfunded `OPEN` escrow has an opener-only, fee-free refund, and `ACTIVE` canonical balances can start the same challenge window without a signature. Deadline equality favors counter-dispute, while finalization begins strictly after expiry. Pause and KYC revocation do not disable exit/remedy calls.
- PaymentChannels fee recovery is isolated behind the enumerable `TREASURY_ROLE`, capped at 500 basis points, and wired through exact deployment membership/renunciation. Governance can rotate a blocklisted fee beneficiary or set the fee to zero before retrying an atomically reverted close. Metadata-only watchtower and routing surfaces were removed rather than advertised as implemented settlement security.
- Payment-channel token admission requires deployed ERC-20 code and exactly six decimals, escrow deposits require exact balance deltas, and cooperative/unilateral finalization is blocked while an HTLC amount remains unresolved.
- Flash liquidity invokes the standard ERC-3156 borrower callback, forwards the caller payload exactly, collects principal plus fee through an explicit allowance, verifies the actual balance increase, and rolls the entire operation back on underpayment, callback failure, invalid return data, or reentry.
- Deployment artifacts are generated by a clean pinned Hardhat compile and are not version-controlled. The deployment command verifies ABI, creation/runtime bytecode, build info, every current source/dependency input, compiler settings, and deployed runtime code before accepting a contract deployment.

### Authorization and data isolation

- Supported business/payment/audit/reporting routes derive tenant and role from authenticated credentials rather than request-supplied identity headers.
- Resource access is ownership-scoped unless a current on-chain platform-administrator role is required and successfully revalidated.
- Production configuration, RPC, compliance, or registry failures fail closed rather than silently weakening authorization.

### Compliance boundary

- Core payment compliance requires the configured external service to be healthy and its response to match the payment, amount, currency, sender/recipient, source policy, timestamp/freshness, and attestation requirements.
- Compliance results are reconciled against the configured chain and contract before authoritative state changes.
- External submissions persist a payment-unique intent before network I/O, reuse the payment UUID as the provider request and idempotency identity, persist independently verified evidence before final state changes, and recover the original result after either evidence-write or final-transaction failure.
- Local mock TEE and fixture sanctions data cannot be enabled by the production Compose path.

### Live-event controls

- Non-system WebSocket broadcasts require an explicit tenant target at both the type and runtime boundaries.
- WebSocket payloads are capped at 16 KiB, compression is disabled, expired sessions are closed during messages, heartbeats, and broadcasts, and the reverse proxy caps concurrent `/ws` connections per source IP.
- Payment and compliance events are emitted only after the durable result is persisted. Delivery is best-effort and cannot roll back a committed HTTP operation.

## Release evidence

The final release gate covers:

- frontend TypeScript, ESLint, unit/integration coverage, production Next.js build, production configuration checks, and browser smoke tests;
- backend TypeScript, ESLint, Prisma validation/migrations/drift, full Jest coverage, and per-module coverage enforcement for security-critical middleware, services, and routes;
- Solidity compile, full Hardhat suite, security regressions, and deployment-script syntax;
- Go vet plus full tests with the race detector;
- Rust formatting, all-target/all-feature Clippy with warnings denied, default tests, and explicit test-only `mock-tee` tests;
- production Compose rendering, deployment configuration validation, dependency audits, skipped/focused-test checks, and diff hygiene.

The release toolchain is pinned to Node.js `24.18.0`, Go `1.25.12`, Rust `1.90.0`, PostgreSQL `16.14`, and an unprivileged Nginx `1.30.4` image. GitHub Actions are pinned to immutable commit identities rather than moving tags.

Exact final counts and commit identity belong in the release handoff generated after the gate completes; this document intentionally does not claim that automated tests prove absence of defects.

## Required deployment inputs and acceptance gates

Deployment remains blocked until the operator provides and validates all of the following:

1. the activated public-testnet numeric chain ID and authoritative HTTPS/WSS RPC and explorer URLs;
2. a funded deployment wallet and reviewed deployment transaction policy;
3. the deployed contract manifest for the same chain, including the newly compiled epoch-aware `PaymentChannels` deployment, bytecode verification, and all role/policy assignments; artifacts and signatures made for the previous PaymentChannels bytecode are incompatible; if Liquidity is separately activated later, its deployment must use the newly compiled callback-enabled `LiquidityPool` bytecode because the prior implementation cannot complete a legitimate flash loan;
4. supported stablecoin addresses/decimals and treasury, registry, compliance, travel-rule, payment-channel, and settlement-gate configuration;
5. an independently audited external compliance API with genuine TEE attestation and current integrity-checked OFAC, UAE Central Bank, UN, and EU sanctions sources;
6. production JWT/API/webhook/database secrets delivered through the host secret manager, not committed environment files;
7. DNS, TLS certificates, reverse-proxy routing, CORS/public origin, WalletConnect project ID, monitoring, backups, and restore procedures;
8. successful database migration/drift check, contract deployment verification, readiness checks, and a signed smoke-test record;
9. a multi-user US/UAE test covering registration, login, payment initiation, compliance, lifecycle actions, gateway restart/reorg recovery, tenant isolation, and failure modes;
10. an independent security review before handling real funds or regulated production data.

The repository’s illustrative local/CI chain values and example domains are not evidence of an active Aethelred public testnet and must never be copied into a live environment.

## Residual risks

- Smart contracts and the integrated application still require independent audit and operational approval.
- The Hardhat 2 development-only dependency graph retains one unfixed low-severity `elliptic` advisory fanned out across 21 audit entries. Production dependencies have zero findings; no vulnerable Hardhat dependency is included in a runtime image. A separately qualified Hardhat 3 migration is required to remove the legacy development chain safely.
- The external compliance provider is a material trust dependency; NoblePay correctly fails closed, but cannot independently prove provider governance or dataset freshness beyond its signed API contract.
- The optional gateway’s file-backed store is appropriate only for a controlled single-instance deployment with persistent storage, exclusive writer ownership, backups, and tested restore. Horizontal operation requires a shared transactional store.
- Public-testnet stability, finality behavior, fee policy, contract addresses, and explorer behavior cannot be certified before authoritative endpoints are active.
- Key custody, incident response, sanctions-policy sign-off, privacy/data-retention controls, monitoring, and disaster recovery are operational responsibilities outside this repository.

## Conclusion

NoblePay is a conditional code release candidate for its explicitly supported core, with roadmap-only features excluded from production and the identified NP-01 through NP-14 issues resolved or isolated. It must remain undeployed for live-value use until the listed network, contract, compliance, secret-management, infrastructure, audit, and multi-user acceptance gates are satisfied.
