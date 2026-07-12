# NoblePay → Aethelred Testnet Integration Handoff

**Date:** 2026-07-12
**From:** NoblePay app team
**To:** Aethelred testnet team (US)
**Purpose:** hand off the seal-anchored settlement stack for deployment to the Aethelred public testnet (chain 7332), on-chain validation, and independent testing. This document is the integration contract: what to deploy, how to wire it, the enforced invariants, and the test evidence behind them.

**Branch:** `feat/seal-settlement-gate` (pull the latest tip — it now contains the reconciled union of the two prior work streams, see §2)
**Bottom line:** all local suites are green on the reconciled branch — **1,522 contract tests (Hardhat), full frontend jest suite, `tsc --noEmit` clean**. The seal-binding core is additionally proven against the real ISeal precompile in the chain repo (§6). Nothing here runs on the public testnet yet; that is this handoff's purpose.

---

## 1. Canonical protocol identity (single source of truth: aethelred repo `ecosystem/manifest.json` v2.0.0)

- EVM chain id **7332** (testnet; devnet shares it), **7331** reserved for mainnet.
- Native token **AETHEL** (18 EVM decimals), base denom `uaethel`, bech32 prefix `aethel`. (`AET` survives only as an accepted legacy input alias in the UI formatter.)
- ISeal precompile at **`0x0900`** (IVerify `0x0901`, IPoUW `0x0902` reserved).
- Purpose strings are canonical **lowercase hex**.
- **Chain-side prerequisite:** the ISeal precompile exists only on chain builds cut from `release/public-testnet-pqc` (aethelred PR #153). Neither `main` nor `release/testnet-v1.0` contains it as of this date. Build the validator/node binary from that branch (or its merged successor) or every seal-gated call below will fail (fail-closed, by design).
- RPC endpoint: provided by the US team. Note the ecosystem docs currently disagree on hostname convention (`evm-rpc-testnet.aethelred.network` in the TerraQura handoff vs `rpc.testnet.aethelred.io` in the chain validator runbook); neither resolves yet — please pick one and update the manifest.

## 2. Branch reconciliation (context for integrators)

The settlement-gate work previously lived on two diverged branches: `feat/seal-settlement-gate` (the contract integration — ZeroID identity layer, `NoblePay.sol` seal-gating) and `feat/seal-settlement-e2e` (the live-node operator playbook and the AET→AETHEL rename). They were merged on 2026-07-12; `feat/seal-settlement-gate` is now the single canonical branch. The merge kept the gate branch's contract revision (ZeroID layer), its Hardhat v3 toolchain, and its frontend (which already carried the AETHEL rename and the canonical 7332 chain config), adopted the playbook script and the constants-integrity tests from the e2e branch, restored the `AET` legacy input alias the blind rename had dropped, and **regenerated the playbook's deployment bytecode (`scripts/artifacts/SealSettlementGate.bin`) from the merged contract source**. `feat/seal-settlement-e2e` is superseded and should not be used.

## 3. What you are deploying

**`SealSettlementGate`** — consensus-anchored corridor clearance. A cross-border corridor (ordered **payer → payee**) is cleared for settlement only when a Digital Seal minted by the chain's own attested-compute (PoUW) pipeline:

1. **exists** and is **ACTIVE** on-chain,
2. is bound to **this exact ordered pair** via the job purpose `noblepay:0x<payer>:0x<payee>` (the contract's `expectedPurpose(payer, payee)` returns the exact string), and
3. satisfies the governance-set **CEAP compliance policy** (allowed backends/platforms, minimum verification, vendor root, data residency),

all verified in-EVM by the ISeal precompile — the same consensus logic that minted the seal. No allowlist or off-chain screening oracle is trusted anywhere in the path.

**Optional ZeroID identity layer** — when enabled, **both** corridor parties must hold registered, ACTIVE ZeroID identities at every `isCleared` read. An identity suspension (e.g. a sanctions hit surfacing through ZeroID) closes the corridor instantly; unlike seal revocation, identity **reinstatement reopens** it. Fail-closed: a broken/unset registry while required reads as closed.

**`NoblePay` core** — the payment contract. When `sealClearanceRequired` is on, `settlePayment` refuses to settle any payment whose (sender → recipient) corridor is not cleared in the gate.

## 4. Deployment & wiring (integration checklist)

Prereqs: node built from the precompile branch (§1), funded deployer key, `aethelredd` CLI access for PoUW job submission, and — if enabling the identity layer — the ZeroID registry address from the ZeroID deployment (see ZeroID's own handoff).

1. **Deploy** `SealSettlementGate(governance)` — constructor takes the governance address (Ownable2Step; governance must **accept** ownership if it differs from the deployer).
2. **Set the CEAP policy** (governance):
   `setCompliancePolicy(allowedBackends, minVerification, allowedPlatforms, requireVendorRoot, dataResidency)` — e.g. `(["tee"], "attested", [...], true, ["AE"])` per your compliance profile. Read back with `compliancePolicy()`.
3. **(Optional) enable the identity layer** (governance): `setIdentityRegistry(zeroIdRegistry, true)`. Reverts if `required` with a zero registry.
4. **Wire the core** (NoblePay `ADMIN_ROLE`): `setSealGate(gateAddress)`, then `setSealClearanceRequired(true)`. Unsetting the gate auto-disables the requirement (fail-safe, never fail-open).
5. **Run the operator playbook**:
   ```
   RPC_URL=<testnet-evm-rpc> DEPLOYER_KEY=<funded-key> \
   [GATE_ADDRESS=0x…] [PAYER=0x…] [PAYEE=0x…] [JOB_ID=<sealed-job>] \
   node scripts/devnet-seal-settlement-e2e.mjs
   ```
   - No Hardhat network config is needed — the script drives the node directly (viem) and deploys the reviewed creation bytecode (`scripts/artifacts/SealSettlementGate.bin`, built from the merged contract source).
   - Without `JOB_ID` it stops after proving **no-seal-no-clearance** and prints the exact `aethelredd tx pouw register-model` / `submit-job` commands, embedding the contract's own `expectedPurpose()`.
   - Once validators seal the job, re-run with `JOB_ID` — it calls `clear(payer, payee, jobId)` and confirms `isCleared` flips true.
6. **Record enforcement attestations** from live chain reads into the deployment manifest (§7) and report back (§8).

## 5. Enforced invariants you will observe on-chain

| Area | Invariant | Revert / effect |
|---|---|---|
| Clearance | No seal → no clearance (fail-closed); missing/inactive seal cannot clear | revert from `clear` |
| Clearance | Seal purpose must bind **this exact ordered** payer→payee pair — direction-sensitive | revert (purpose mismatch) |
| Clearance | Seal must satisfy the live CEAP policy | `PolicyNotSatisfied(reason)` |
| Clearance | One seal admits exactly one clearance (replay protection) | `sealUsed` guard |
| Permanence | A corridor clearance is permanent once recorded | `AlreadyCleared` |
| Revocation | Governance `revoke(payer, payee)` closes the corridor | `isCleared` → false |
| Live seal check | `isCleared` re-checks the backing seal's ACTIVE status via ISeal — an on-chain seal revocation closes the corridor instantly, no tx needed | — |
| Identity layer | Both parties must be ACTIVE in ZeroID when required; suspension closes, reinstatement reopens; broken registry reads closed | `IdentityNotVerified(party)` |
| Settlement | `settlePayment` refuses uncleared corridors while `sealClearanceRequired` | revert |
| Ops | `pause()` halts clearance anchoring; verification reads stay live | `Pausable` |

## 6. Test evidence (all local/devnet — nothing on the public testnet yet)

- **Seal-binding proof (chain repo):** `internal/evmhost/noblepay_test.go` — the gate's creation bytecode against the **real ISeal precompile + real seal keeper**, covering direction sensitivity, jurisdiction policy, live revocation, and clearance permanence. Landed at chain commit `d9ebe04075` (on `release/public-testnet-pqc`). **Scope note:** that proof covers the pre-identity-layer revision of the contract; the ZeroID identity layer (optional, off by default) is covered by this repo's Hardhat suite against a mock registry, not yet by a chain-repo real-precompile test.
- **Contract suites (this repo):** Hardhat, `npm run validate:contracts` — **1,522 tests green** incl. the gate + ZeroID identity suite; reentrancy/hostile-gate hardening proofs included.
- **Frontend:** full jest suite green, `tsc --noEmit` clean.
- **Full stack:** `npm run validate:all` (frontend / backend / contracts / gateway / compliance / security / ecosystem).
- The devnet playbook (§4.5) has been run end-to-end against a local aethelredd EVM devnet.

## 7. Deployment manifest — enforcement attestations (record from live chain reads)

```
gate.address                      = <deployed SealSettlementGate>
gate.owner                        = governance (Ownable2Step accepted)
gate.compliancePolicy             = compliancePolicy()
gate.identityRegistry             = identityRegistry() / identityRequired()
core.sealGate                     = NoblePay.sealGate()
core.sealClearanceRequired        = NoblePay.sealClearanceRequired()
chain.eth_chainId                 = 7332
chain.isealPrecompileVerified     = playbook §4.5 fail-closed + clear() round-trip
```

## 8. Report back

Deployed addresses, `eth_chainId`, the manifest above, the sealed `JOB_ID` used for the first corridor clearance, and any behavioral deltas vs §5. The app layer (Next.js frontend :3002, Prisma/Postgres backend) is **not** in the US team's scope — corridor-clearance validation is entirely on-chain.
