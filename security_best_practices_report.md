# Noble Pay Security Review

Date: 2026-03-15

## Executive Summary

Noble Pay is not production-ready in its current form for a real-time cross-border payment and compliance product. The most serious issues are not cosmetic hardening gaps; they are control-plane failures that break core trust assumptions:

- the treasury multisig can be bypassed through delegate double-counting,
- backend and gateway authorization fail open or allow cross-tenant actions,
- compliance and TEE attestations are largely mock or non-verified despite being presented as security controls.

From an auditor's perspective, this repository currently looks closer to a feature-rich prototype than a hardened payment stack. Several components have good test coverage, but the existing test suites do not meaningfully enforce the security invariants that matter for custody, tenant isolation, settlement finality, or compliance integrity.

## Ratings

| Area | Rating | Assessment |
|---|---:|---|
| Smart contracts | 4/10 | Good coverage, but governance and recovery logic flaws materially weaken safety. |
| Backend API | 2/10 | Tenant isolation and privilege enforcement are inadequate for a financial platform. |
| Gateway service | 2/10 | Authentication can fail open and webhook trust is not established. |
| Compliance / TEE | 1/10 | Mock defaults and stubbed attestation verification invalidate the claimed trust model. |
| Frontend | 7/10 | No major frontend-exclusive issues were identified in this pass; primary risk sits behind the UI. |
| Overall production readiness | 2/10 | High to critical risk. Not suitable for production custody, compliance, or settlement flows. |

## Scope and Method

This review covered:

- Solidity contracts under `contracts/src`
- Express/TypeScript backend under `backend/src`
- Go gateway under `services/gateway`
- Rust compliance engine under `crates/noblepay-compliance`
- High-level frontend test posture in the Next.js app

Validation performed:

- `npm test -- --runInBand` at repository root: 35/35 suites passed, 988/988 tests passed
- `npm test -- --runInBand` in `backend`: 28/28 suites passed, 651/651 tests passed
- `npm test` in `contracts`: 1348 tests passed
- `go test ./...` in `services/gateway`: passed
- `cargo test` in `crates/noblepay-compliance`: 309 tests passed, 1 doc-test passed

Passing tests do not reduce the severity of the findings below because the affected trust boundaries are either untested or the current tests do not assert the intended security properties.

## Critical Findings

### NP-01: Delegate accounts can double-count approvals and break treasury multisig guarantees

Impact: A single signer can effectively obtain multiple approvals and push treasury actions through below the intended threshold.

**Severity:** Critical

**Location:**

- `contracts/src/MultiSigTreasury.sol:407-418`
- `contracts/src/MultiSigTreasury.sol:490-560`
- `contracts/src/MultiSigTreasury.sol:569-585`

**Details:**

`onlySignerOrDelegate` authorizes a delegate address to act directly. `createProposal()` records the proposer approval under `msg.sender`, and `approveProposal()` also tracks approvals by `msg.sender`. Because the approval identity is the delegate address rather than the delegator signer, the same signer can create a delegate-controlled approval and then add a second approval from the signer account.

This defeats the intended N-of-M approval model and materially weakens the treasury's security assumptions.

**Recommendation:**

Normalize approval identity to the underlying signer, not `msg.sender`. Delegates should act strictly on behalf of a signer, and each signer must be limited to one vote per proposal regardless of delegation.

### NP-02: Backend JWT authentication falls back to a hard-coded secret

Impact: Any deployment missing `JWT_SECRET` becomes trivially forgeable.

**Severity:** Critical

**Location:**

- `backend/src/middleware/auth.ts:9`
- `backend/src/middleware/auth.ts:59-67`

**Details:**

The backend uses `process.env.JWT_SECRET || "noblepay-dev-secret-change-in-production"`. If the environment variable is absent in staging or production, an attacker can mint valid JWTs using the repository-visible fallback secret and impersonate arbitrary businesses.

**Recommendation:**

Fail closed at startup when `JWT_SECRET` is unset in non-test environments. Separate local development secrets from runtime defaults.

### NP-03: Backend authorization does not enforce tenant ownership or privileged roles

Impact: Any authenticated tenant can read or mutate other tenants' business and payment records, including administrative state changes.

**Severity:** Critical

**Location:**

- `backend/src/routes/businesses.ts:158-197`
- `backend/src/routes/businesses.ts:202-237`
- `backend/src/routes/businesses.ts:241-300`
- `backend/src/routes/businesses.ts:305-369`
- `backend/src/routes/businesses.ts:374-420`
- `backend/src/routes/payments.ts:67-87`
- `backend/src/routes/payments.ts:106-131`
- `backend/src/services/payment.ts:113-126`
- `backend/src/services/payment.ts:131-180`
- `backend/src/services/payment.ts:186-260`
- `backend/src/middleware/rbac.ts:272-284`
- `backend/src/index.ts:199-212`

**Details:**

The application authenticates API callers but usually does not authorize them against resource ownership or role. Examples:

- `GET /v1/businesses/:id` returns arbitrary business data and API key metadata.
- `PATCH /v1/businesses/:id` updates arbitrary business records.
- `POST /v1/businesses/:id/verify`, `/suspend`, and `/upgrade` require only authentication, not admin/compliance authority.
- payment listing and retrieval are not scoped to `req.businessId`.
- cancel and refund flows accept an `actor` string but do not verify the actor owns or administers the payment.
- the RBAC layer trusts `X-User-Role` and `X-User-Id` headers rather than deriving authority from an authenticated principal.

This is a systemic access-control failure, not a single route bug.

**Recommendation:**

Bind every request to an authenticated principal and tenant, derive roles from the authenticated credential, and enforce ownership or explicit administrative permissions on every read/write path.

### NP-04: Gateway API authentication fails open when `GATEWAY_API_KEY` is unset

Impact: A single configuration miss exposes the entire gateway API without authentication.

**Severity:** Critical

**Location:**

- `services/gateway/internal/config/config.go:21-28`
- `services/gateway/internal/handlers/middleware.go:39-45`

**Details:**

The gateway defaults `GATEWAY_API_KEY` to an empty string. The middleware then explicitly skips auth when the configured key is empty.

This means a misconfigured environment turns authentication off rather than refusing to start.

**Recommendation:**

Require the API key at boot for non-test environments and treat empty configuration as a fatal startup error.

## High Findings

### NP-05: Threshold-change approvals in `ComplianceOracle` are not bound to the proposed values

**Severity:** High

**Location:**

- `contracts/src/ComplianceOracle.sol:392-408`
- `contracts/src/ComplianceOracle.sol:417-438`
- `contracts/src/ComplianceOracle.sol:534-543`

**Details:**

`proposeThresholdUpdate()` stores only an approval counter keyed by a proposal hash. `approveThresholdUpdate()` accepts caller-supplied `_lowMax` and `_mediumMax`, computes `expectedId`, but never compares it to `_proposalId`. Once the approval threshold is reached, `_applyThresholds()` applies the caller-supplied values.

The last approver can therefore execute different thresholds than the ones originally proposed.

**Recommendation:**

Persist the proposed threshold values on-chain and verify that each approval refers to those exact values before applying them.

### NP-06: Cross-chain transfer recovery refunds only principal after status mutation

**Severity:** High

**Location:**

- `contracts/src/CrossChainRouter.sol:319-330`
- `contracts/src/CrossChainRouter.sol:463-485`

**Details:**

The router collects principal plus fee up front and immediately transfers the protocol fee to the treasury. In `recoverTransfer()`, the transfer status is changed to `RECOVERED` before refund logic checks whether the transfer was still `INITIATED`. As written, the branch that should refund the full fee on never-relayed transfers is unreachable.

Users therefore recover principal only, while part of the fee remains transferred or stranded.

**Recommendation:**

Capture the original status before mutating it and compute refunds from that value. Consider escrow separation for protocol vs relay fee accounting.

### NP-07: Gateway webhook ingestion does not verify authenticity or replay safety

**Severity:** High

**Location:**

- `services/gateway/internal/server/server.go:52-62`
- `services/gateway/internal/handlers/webhooks.go:29-63`

**Details:**

The webhook endpoint accepts arbitrary JSON, performs only minimal field checks, indexes the event, and triggers settlement reconciliation when `PaymentID` is present. There is no HMAC, signature verification, nonce, timestamp validation, or replay protection.

If the gateway API key is absent this is internet-exposed; even when present, any authenticated caller can forge settlement-driving events.

**Recommendation:**

Require signed webhook envelopes, verify freshness and replay uniqueness, and separate webhook trust from general API authentication.

### NP-08: Rust compliance API is fully unauthenticated and permits any origin

**Severity:** High

**Location:**

- `crates/noblepay-compliance/src/server.rs:51-71`

**Details:**

The server enables wildcard CORS for all origins, methods, and headers and exposes mutation-capable endpoints without any authentication or network access control in the application layer. Endpoints include sanctions refresh, profile construction, graph mutation, and screening.

This is unsafe for any service that influences payment disposition or compliance state.

**Recommendation:**

Add strong service-to-service authentication, restrict CORS to trusted origins only if a browser use case exists, and protect mutation endpoints separately.

### NP-09: TEE attestation trust is effectively disabled

**Severity:** High

**Location:**

- `crates/noblepay-compliance/Cargo.toml:29-33`
- `crates/noblepay-compliance/src/attestation.rs:142-171`

**Details:**

The crate defaults to `mock-tee`. In addition, `verify_attestation()` returns `Ok(true)` for both Nitro and SGX branches rather than verifying certificates, measurements, PCRs, or quote contents.

As a result, the advertised attestation boundary is not actually enforced.

**Recommendation:**

Do not ship with `mock-tee` as a default feature. Implement real platform verification or disable the feature claims until they exist.

### NP-10: Backend compliance decisions and attestations are simulated with randomness

**Severity:** High

**Location:**

- `backend/src/services/compliance.ts:112-120`
- `backend/src/services/compliance.ts:378-385`
- `backend/src/services/compliance.ts:398-432`

**Details:**

The backend writes random attestation bytes, uses a fallback fake TEE address, and derives risk outcomes from `Math.random()`. For a stated real-time cross-border payment and compliance platform, this means payment approvals and rejections can be arbitrary and are not backed by a verifiable compliance engine.

If this code is reachable in a real environment, compliance enforcement is not trustworthy.

**Recommendation:**

Replace this flow with signed responses from a verified compliance service, and hard-fail if no valid TEE/compliance node is available.

## Medium Findings

### NP-11: Recurring treasury payments bypass the normal proposal and approval workflow

**Severity:** Medium

**Location:**

- `contracts/src/MultiSigTreasury.sol:744-781`
- `contracts/src/MultiSigTreasury.sol:788-817`

**Details:**

A single signer or delegate can create a recurring payment directly, and any caller can later execute it once due. This bypasses the normal proposal lifecycle and its threshold approval mechanics.

Depending on intended governance, this may provide an alternate path to drain treasury funds over time without multisig approval on each authorization.

**Recommendation:**

Require recurring payment creation to flow through the same proposal/approval model as one-time transfers, or explicitly scope recurring authorizations to a separate approved policy object.

### NP-12: `batchOpenChannels()` omits validation enforced by `openChannel()`

**Severity:** Medium

**Location:**

- `contracts/src/PaymentChannels.sol:433-446`
- `contracts/src/PaymentChannels.sol:948-1002`

**Details:**

Single-channel creation validates the challenge period and routing fee bounds. The batch path does not validate either `_challengePeriod` or `_routingFeeBps`, yet stores both in newly created channels.

This can create channels with invalid dispute windows or fee settings that the single-entry flow would reject.

**Recommendation:**

Apply the same input validation in the batch path as in the single-channel path, ideally by reusing a shared internal validator.

## Positive Notes

- Test coverage is strong across the UI, contracts, backend, and Rust crate.
- Several contracts use custom errors and structured state machines, which is a good foundation.
- The codebase is modular enough that most issues appear fixable without a total rewrite.

## Conclusion

Noble Pay currently has multiple broken security invariants across custody, authorization, settlement, and compliance trust boundaries. The main blockers to a production launch are:

1. repairing treasury and governance integrity,
2. implementing real tenant-aware authorization across backend and gateway services,
3. replacing mock compliance and attestation paths with verifiable production logic.

No production deployment handling real funds or regulated payment flows should proceed until the Critical findings are fixed and the High findings are either fixed or explicitly accepted as non-production/demo-only behavior.
