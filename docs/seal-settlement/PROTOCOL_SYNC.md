# NoblePay ↔ Aethelred Protocol Sync — Seal-Gated Settlement

**Contracts:** `contracts/src/SealSettlementGate.sol` + the `NoblePay.sol` settlement gate (Apache-2.0, solc 0.8.19, via-ir, paris)
**Chain:** Aethelred L1 — EVM EIP-155 chain id **7332** (`eth_chainId` → `0x1ca4`); mainnet reserved **7331**
**Precompile:** `ISeal` at `0x0000000000000000000000000000000000000900`

This document is the contract-of-record for how NoblePay's highest compliance
assurance tier binds to Aethelred consensus. It exists so an auditor, a central
bank, or an enterprise integrator can confirm — without reading the whole
repo — that a NoblePay settlement can be made contingent on the chain's own
Proof-of-Useful-Work (PoUW) pipeline, not on a role-held oracle key.

---

## 1. Trust model in one paragraph

NoblePay's role-based tier (TEE nodes with `TEE_NODE_ROLE`, attestations
verified by `ComplianceOracle`) decides PASSED/FLAGGED/BLOCKED per payment.
The seal tier adds a second, **consensus-anchored** factor at the settlement
choke point: when enforcement is on, `settlePayment` also requires a live
_corridor clearance_ in `SealSettlementGate` — a record backed by a **Digital
Seal** minted by the Aethelred validator quorum when a PoUW screening job (the
attested sanctions/AML/travel-rule computation for the exact payer→payee pair,
run under a CEAP confidentiality policy) completed. Every check — seal
resolution, ACTIVE status, corridor binding, CEAP policy — is evaluated
**inside the EVM by the `ISeal` precompile**. A compromised TEE key can mark a
payment PASSED; it cannot mint a quorum seal, so it cannot move funds. When
the chain revokes the seal (e.g. a quorum-verified sanctions-list update), the
corridor closes on the next `isCleared` read — no NoblePay transaction.

---

## 2. The four ISeal touchpoints

The gate uses exactly these precompile methods (aethelred repo
`precompiles/seal/ISeal.sol`, vendored at `contracts/src/interfaces/ISeal.sol`):

| Call                                                                                                     | Used for                                      | Failure semantics                |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------- |
| `getSealIdByJob(jobId)`                                                                                  | resolve the seal minted for a PoUW job        | reverts if the job is unsealed   |
| `verifySeal(sealId)`                                                                                     | is the seal `ACTIVE` right now                | `false` → not active / revoked   |
| `getSeal(sealId)`                                                                                        | read the `purpose` field for corridor binding | —                                |
| `requireConfidentiality(sealId, backends, minVerification, platforms, requireVendorRoot, dataResidency)` | CEAP policy check with **consensus parity**   | `(false, reason)` → policy unmet |

`requireConfidentiality` runs the **same `Satisfies()` logic** the chain used
when it decided the job could be sealed; the Solidity side never re-implements
policy evaluation, so on-chain and in-EVM answers cannot diverge.

---

## 3. The purpose binding (anti-replay, direction-sensitive)

A seal only backs a clearance if its `purpose` string equals, byte-for-byte:

```
noblepay:0x<payer-address-hex-40>:0x<payee-address-hex-40>
```

Both addresses lowercase, unchecksummed. Because the corridor is inside the
purpose the quorum signed:

- **Clearing is permissionless** — any relayer/keeper may call `clear`; the
  caller identity carries no authority.
- **Direction matters** — a payer→payee seal does not clear payee→payer.
- **No replay** — each seal admits exactly one clearance (`sealUsed`), and each
  corridor admits exactly one clearance record for its lifetime
  (`AlreadyCleared`), so a governance revocation cannot be undone by a second
  bound seal through the permissionless path (clearance permanence).

`expectedPurpose(payer, payee)` returns the exact string for operators
constructing the PoUW job.

---

## 4. Lifecycle

```
  ┌── screening / PoUW ────────────────────┐        ┌── EVM (chain id 7332) ──────────────┐
  │ 1. sanctions/AML/travel-rule screening  │        │ 3. anyone → clear(payer, payee,     │
  │    for payer→payee runs as a PoUW job   │        │    jobId)                           │
  │    with purpose                         │        │      ISeal.getSealIdByJob           │
  │    noblepay:0x<payer>:0x<payee> and a   │  seal  │      ISeal.verifySeal (ACTIVE)      │
  │    CEAP policy (jurisdiction/backend)   │ ─────► │      ISeal.getSeal → purpose match  │
  │ 2. validator quorum verifies →          │        │      ISeal.requireConfidentiality   │
  │    mints Digital Seal (PQC-signed)      │        │    → corridor open                  │
  └─────────────────────────────────────────┘        │ 4. NoblePay.settlePayment           │
                                                      │      TEE tier: status == PASSED     │
                                                      │      seal tier: gate.isCleared      │
                                                      │      (live revocation) → funds move │
                                                      └─────────────────────────────────────┘
```

The tiers complement each other: a BLOCKED payment cannot settle even on a
cleared corridor (per-payment TEE screening), and a PASSED payment cannot
settle on an uncleared corridor (consensus corridor screening). Refunds back
to the sender are deliberately NOT seal-gated — a closed corridor returns
funds, it never strands them.

---

## 5. NoblePay wiring (fail-closed)

- `NoblePay.setSealGate(address)` (ADMIN_ROLE) — set/clear the gate; clearing
  it auto-disables enforcement (the contract can never be in the
  required-without-gate state).
- `NoblePay.setSealClearanceRequired(bool)` (ADMIN_ROLE) — enabling requires a
  gate to be set. Deploy default: gate unset, enforcement OFF (tier opt-in
  until the seal pipeline is live).
- Chain wiring: `src/config/chains.ts` — mainnet **7331** (reserved),
  testnet/devnet **both 7332** (same chain, different endpoints; devnet RPC
  env-overridable via `NEXT_PUBLIC_AETHELRED_DEVNET_RPC_URL`, default
  `http://127.0.0.1:8545`). `src/config/wagmi.ts` dedupes the shared 7332 id
  with `activeChain` priority. The prior `7001` (cross-chain mock data) and
  `7333` (devnet) ids were never-deployed placeholders, reconciled to 7332.
  Native currency is **AETHEL** (user-visible AET/AETH labels renamed).

---

## 6. How this stays in sync with the chain (drift protection)

1. **Vendored bytecode** — aethelred repo
   `internal/evmhost/testdata/noblepay/SealSettlementGate.{abi,bin}` is the
   exact reviewed contract, compiled with `npx hardhat compile` and copied
   over. If the Solidity changes, re-vendor.
2. **Real-precompile proof** — aethelred repo
   `internal/evmhost/noblepay_test.go`
   (`TestNoblePay_SealSettlementGate_RealPrecompile`) deploys that bytecode
   into a real EVM host wired to the **real `ISeal` precompile and a real seal
   keeper**, then proves: corridor-bound seal clears; the reverse corridor
   stays closed; a US-jurisdiction seal is rejected under an AE-only policy
   _by the precompile_; seal revocation closes the corridor live; and a
   revoked corridor cannot be re-opened with a fresh seal (clearance
   permanence).

If the ABI or the purpose format changes without updating both sides, this Go
test fails in the chain repo's CI. The contract-side behaviour is
independently locked by `contracts/test/SealSettlementGate.test.js` (21 tests)
and `contracts/test/NoblePaySealGate.test.js` (13 integration tests over the
real NoblePay + gate stack); `SealSettlementGate.sol` measures **100% line /
100% statement coverage** under `hardhat test --coverage`.
