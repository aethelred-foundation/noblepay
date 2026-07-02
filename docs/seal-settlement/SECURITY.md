# SealSettlementGate — Security Model & Self-Audit

**Contracts:** `contracts/src/SealSettlementGate.sol` + the `NoblePay.sol`
settlement-gate wiring (Apache-2.0, solc 0.8.19, via-ir, paris)
**Status:** implemented, self-audited, test-covered. **Tier-1 external audit
is a mainnet launch gate (not yet done).** Treat this as the pre-audit
security narrative, not an audit report.

Base: OpenZeppelin 4.9.6 `Ownable2Step`, `Pausable`, `ReentrancyGuard`.
Deliberately **non-upgradeable** — the clearance record of record must not be
admin-mutable. The gate uses Ownable2Step (the cross-dApp convention for
Aethelred seal registries) with exactly one governance surface; NoblePay's own
wiring uses its existing `ADMIN_ROLE`.

---

## 1. Assets and actors

| Asset                                                                         | Why it matters                                      |
| ----------------------------------------------------------------------------- | --------------------------------------------------- |
| Clearances `_clearances[payer][payee]`                                        | what the settlement path gates on                   |
| `sealUsed[sealId]`                                                            | one-clearance-per-seal replay guard                 |
| CEAP policy (backends / minVerification / platforms / vendorRoot / residency) | admission rule for every clearance                  |
| Gate ownership + NoblePay `ADMIN_ROLE`                                        | can set policy, pause, revoke, wire/unwire the gate |
| Escrowed payment funds (in NoblePay)                                          | what the whole tier protects                        |

| Actor                         | Capability                                                               |
| ----------------------------- | ------------------------------------------------------------------------ |
| Anyone (payer/relayer/keeper) | `clear` — permissionless; bounded by the seal's corridor binding         |
| Gate governance (owner)       | `setCompliancePolicy`, `revoke`, `pause`/`unpause`, two-step transfer    |
| NoblePay `ADMIN_ROLE`         | `setSealGate`, `setSealClearanceRequired` (fail-closed)                  |
| TEE nodes (`TEE_NODE_ROLE`)   | per-payment PASSED/FLAGGED/BLOCKED — the role tier; cannot mint seals    |
| ISeal precompile (0x0900)     | source of truth for seal existence, activity, purpose, CEAP satisfaction |

**Why permissionless clearing is safe:** the quorum-signed purpose contains
the exact corridor (`noblepay:0x<payer>:0x<payee>`). A caller cannot bind a
seal to any corridor the validators did not screen; caller identity carries
no authority.

---

## 2. Threats and mitigations

| #   | Threat                                                                                                                                                                                                       | Mitigation                                                                                                                                                          | Test                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| T1  | **Compromised TEE node key** posts fraudulent PASSED and settles                                                                                                                                             | seal tier: settlement also requires a quorum-minted corridor seal the key cannot forge                                                                              | `a TEE-PASSED payment cannot settle without a corridor seal`                              |
| T2  | **Replay** — one seal clearing many corridors                                                                                                                                                                | `sealUsed[sealId]` monotonic guard                                                                                                                                  | `rejects seal replay across corridors`                                                    |
| T3  | **Corridor re-scoping / direction abuse** — seal for A→B used for A→C or B→A                                                                                                                                 | purpose binds payer AND payee, ordered                                                                                                                              | `rejects a seal bound to a different corridor`, `rejects a reversed-direction seal`       |
| T4  | **Policy bypass** — seal violating jurisdiction/backend admitted                                                                                                                                             | `requireConfidentiality` delegates to the precompile's consensus-parity `Satisfies()`                                                                               | `rejects a seal that fails the CEAP compliance policy`                                    |
| T5  | **Stale clearance** — seal revoked (sanctions update) but corridor still open                                                                                                                                | `isCleared` re-checks `verifySeal` live on every call                                                                                                               | `consensus seal revocation closes the corridor mid-flight`                                |
| T6  | **Revocation resurrection** — governance revokes a clearance; attacker re-clears with a second bound seal                                                                                                    | `AlreadyCleared` one-clearance-per-corridor guard (baked in from day one — the bug class found in the TerraQura self-audit)                                         | `SECURITY: a governance revocation cannot be undone…`                                     |
| T7  | **Live-clearance overwrite** — rewrite sealId/clearedAt of an open corridor                                                                                                                                  | same `AlreadyCleared` guard                                                                                                                                         | `one corridor, one clearance…`                                                            |
| T8  | **Inactive/forged seal**                                                                                                                                                                                     | `verifySeal` must be true; `getSealIdByJob` reverts for unsealed jobs                                                                                               | `rejects an inactive (revoked/expired) seal`                                              |
| T9  | **Unauthorized revocation / policy change / pause**                                                                                                                                                          | `onlyOwner` on all three                                                                                                                                            | `non-owner cannot revoke`, `only owner can set the compliance policy`, pause test         |
| T10 | **Required-without-gate state** (settlement bricked by misconfig)                                                                                                                                            | fail-closed wiring: cannot enable without a gate; clearing the gate auto-disables                                                                                   | `cannot enable enforcement without a gate`, `clearing the gate auto-disables enforcement` |
| T11 | **Stranded escrow** — corridor closes with funds locked                                                                                                                                                      | refunds to sender are deliberately NOT seal-gated                                                                                                                   | `refunds remain possible while the corridor is closed`                                    |
| T12 | **Tier confusion** — cleared corridor used to bypass per-payment screening                                                                                                                                   | settlement still requires TEE-tier PASSED                                                                                                                           | `still enforces the TEE tier on top of the seal`                                          |
| T13 | **Ownership takeover / fat-finger**                                                                                                                                                                          | `Ownable2Step`; non-pending acceptor rejected                                                                                                                       | two-step test                                                                             |
| T14 | **Reentrancy** during clear                                                                                                                                                                                  | `nonReentrant`; precompile calls are `view`; state written after checks                                                                                             | (guard present; no external value transfer in the gate)                                   |
| T15 | **Zero corridor endpoints**                                                                                                                                                                                  | `ZeroCorridor` on either zero address                                                                                                                               | zero-endpoint test                                                                        |
| T16 | **Escrow fund-lock** — a payment whose amount can't cover its fee escrows, passes TEE, then `settlePayment` underflows (`amount - fee`) forever; a PASSED payment can't be refunded/cancelled → funds locked | `AmountBelowFee` guard rejects `amount <= fee` at `initiatePayment` and per batch item; settle-side cap `fee = min(fee, amount)` defends a post-initiation fee hike | `fund-lock fix` + `settle-side fee cap` tests                                             |
| T17 | **Settlement reentrancy** — malicious native recipient re-enters settle/refund/cancel mid-transfer                                                                                                           | `nonReentrant` on all three + CEI (status set before the external call)                                                                                             | `reentrancy (real attack fixtures)` — MaliciousNativeReceiver, asserts no double-settle   |
| T18 | **Hostile seal gate** — a governance-wired gate re-enters settlement from `isCleared`                                                                                                                        | `ISealSettlementGate.isCleared` is `view` → NoblePay invokes it via STATICCALL, so a state-changing re-entry reverts at the EVM level                               | `hostile seal gate cannot reenter settlement` — ReentrantSealGate                         |

**Self-audit finding (fixed this pass):** T16 was a real permanent-fund-lock
bug in the pre-existing settlement path (not introduced by the seal tier). A
payment with `amount <= _calculateFee(amount)` — e.g. any amount below `baseFee`
— escrowed and passed TEE screening, but `settlePayment` computes
`netAmount = amount - fee` and underflow-reverts on every call; because a PASSED
payment is neither refundable (BLOCKED/FLAGGED only) nor cancellable (PENDING
only), the escrow was locked forever. Fixed with a fail-fast `AmountBelowFee`
guard at both initiation paths plus a `fee = min(fee, amount)` cap at settlement
for governance fee changes. Also removed a dead `onlyComplianceOfficer` modifier
(unused; `refundPayment` uses an inline `hasRole` check).

**Suites:**

- `contracts/test/SealSettlementGate.test.js` — **21 tests** (gate unit, incl.
  the revocation-permanence regression).
- `contracts/test/NoblePaySealGate.test.js` — **13 integration tests** over the
  REAL NoblePay + gate stack (only the precompile boundary is mocked, via
  setCode at 0x0900, state set after install).
- `contracts/test/NoblePayHardening.test.js` — **13 tests**: constructor guards,
  the AmountBelowFee fund-lock fix (single + batch + settle-side cap), and real
  reentrancy/hostile-gate attack fixtures with post-revert state assertions.
- Full contracts suite **1516 passing** with the tier + hardening added.
- Measured coverage (`hardhat test --coverage`):
  **SealSettlementGate.sol AND NoblePay.sol both 100.00% lines / 100.00%
  statements, zero uncovered lines.**

---

## 3. Invariants

1. **One clearance per seal.** `sealUsed` is never cleared.
2. **One clearance record per corridor, forever.** `AlreadyCleared` — local
   revocation is permanent at this tier; re-opening a remediated corridor is
   a governance decision outside the permissionless path.
3. **Open corridor ⇒ live seal at read time.** Consensus revocation always
   wins over local state.
4. **Clearance ⇒ corridor-bound seal**, direction-ordered, evaluated against
   the quorum-signed purpose.
5. **Clearance ⇒ policy-satisfying seal at issuance**, evaluated by the
   precompile (consensus parity), never re-derived in Solidity.
6. **Enforcement ⇒ gate set.** NoblePay can never be in the
   required-without-gate state.
7. **Refunds never seal-gated.** A closed corridor returns funds to the
   sender; it never strands escrow.

---

## 4. Consensus-parity proof (chain repo)

Contract tests prove the contracts; they cannot prove the _precompile binding
is real_. That is proven in the aethelred repo by
`internal/evmhost/noblepay_test.go`
(`TestNoblePay_SealSettlementGate_RealPrecompile`), which deploys the
**vendored, reviewed bytecode** into a real EVM host wired to the **real
`ISeal` precompile and a real seal keeper**, and asserts clearance-on-valid
seal, reverse-corridor closure, policy rejection (US seal vs AE policy) by the
precompile, live revocation, and clearance permanence. See
`PROTOCOL_SYNC.md` §6.

---

## 5. Trust assumptions (be explicit)

- **Precompile integrity.** `0x0900` is the real Aethelred precompile only on
  Aethelred (chain id 7332 / production successor). Do not deploy elsewhere.
- **Seal strength = backend strength.** Consult the chain's
  confidential-execution status ledger; never present maturing backends as
  fully operational.
- **Screening model governance.** The seal proves the registered screening
  computation ran under policy on attested infrastructure; it does not prove
  the screening model is complete. Model registration/review is a program
  control.
- **Supported-token allowlist excludes fee-on-transfer / rebasing tokens.**
  NoblePay records `amount` on escrow and settles `amount - fee`; a
  fee-on-transfer or rebasing token would leave the contract holding less than
  recorded and could let one payment's settlement draw on another's escrow.
  Only `ADMIN_ROLE`-allowlisted, standard-behaviour stablecoins (USDC/USDT
  class) must be added — this is an admin responsibility, not enforced in code.
- **A hostile seal gate can DoS settlement, not steal.** `setSealGate` is
  `ADMIN_ROLE`; a malicious/buggy gate whose `isCleared` reverts would block
  settlement while enforcement is on (griefing), but cannot reenter or move
  funds (T18). Production should hold `ADMIN_ROLE` behind a multisig/timelock.
- **Bad treasury bricks native settlement.** Native settlement transfers the
  fee to `treasury` with a `require`-checked call; a treasury contract that
  rejects value would revert settlement atomically. `treasury` is
  `TREASURY_ROLE`-set — an admin responsibility.
- **Governance is trusted** to set a sane CEAP policy; production should place
  the gate's `owner` and NoblePay's `ADMIN_ROLE` behind the platform's
  multisig/timelock.

---

## 6. Known limitations / honest ledger

- [ ] **Tier-1 external audit** (Trail of Bits / OpenZeppelin class) — required
      before mainnet. Not done.
- [ ] **Corridor lifecycle for remediation** — a revoked corridor is
      permanently closed at this tier by design; a governed re-listing flow
      (new gate deployment or an explicit governance re-open with fresh
      screening) is a product decision to take before enforcement is enabled
      in production.
- [ ] **Owner/role hardening** — gate `owner` and NoblePay `ADMIN_ROLE` behind
      multisig + timelock; not enforced by the contracts.
- [ ] **Live-node E2E** — `contracts/scripts/devnet-seal-settlement-e2e.js` is
      runnable but was not executed against a live aethelredd node in this
      pass; the definitive binding proof is the chain-repo Go test.
- [ ] **Batch settlement** — only `settlePayment` exists today; if a batch
      settle is added later it MUST route through the same corridor check.
- [ ] **Backend/services integration** — the Node backend and Rust compliance
      crate do not yet surface corridor-clearance status; a follow-up mirrors
      the TerraQura SDK/indexer integration.

---

## 7. Deployment checklist

1. Deploy to Aethelred (chain id **7332** / production successor) only —
   confirm `eth_chainId` = `0x1ca4` and `ISeal` at `0x0900`.
2. Deploy `SealSettlementGate(governance)` with governance = the platform
   multisig (timelocked), not an EOA.
3. `setCompliancePolicy` with the program's jurisdiction/backend/vendor-root
   policy (empty arrays = "any" — almost never right for a regulated rail).
4. `NoblePay.setSealGate(gate)`; keep `setSealClearanceRequired(false)` until
   the PoUW screening pipeline is live for the program's corridors.
5. Clear the initial corridors from quorum-minted seals; verify with
   `isCleared`; then `setSealClearanceRequired(true)`.
6. Re-vendor bytecode into the aethelred repo and confirm
   `TestNoblePay_SealSettlementGate_RealPrecompile` is green there.
