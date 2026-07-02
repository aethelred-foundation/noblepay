# Why NoblePay's Settlement Rail Requires Aethelred to Be an L1

**Audience:** regulators, central banks, correspondent-banking and PSP
compliance teams, auditors, and developers evaluating "why not just deploy
this on Ethereum / an L2?"

**Short answer:** NoblePay's highest compliance tier — the
`SealSettlementGate` — makes settlement contingent on a **Digital Seal minted
by the chain's own validator quorum** after the attested sanctions/AML
screening ran under a CEAP confidentiality policy, re-checked live through a
**consensus-native precompile**. Those properties are consensus-layer facts.
An L2 — or a deployment on someone else's L1 — cannot provide them, because it
is not the entity that runs the attested compute, mints the seal, or finalizes
it. NoblePay is the default cross-border rail for sovereign and regulated
clients _because_ it sits on an L1 that treats attested, confidential
computation as a first-class consensus artifact.

This is the payments companion to the chain's ADR-0004 (sovereign L1 thesis)
and its dApp-arc siblings: Cruzible (staking compliance), ZeroID (identity),
TerraQura (physical-world MRV) — all built on the same ISeal primitive.

---

## The reviewer test

For each property, ask: _would this still hold if Aethelred were a rollup
settling to Ethereum?_ If "no," the property is a genuine L1 requirement.

### 1. The compliance root of trust is a consensus-minted attestation, not a key

Every payment rail's compliance story bottoms out in "who can bless a
transfer." In NoblePay's role tier, that is a TEE node key; in every oracle
design, it is an oracle committee's keys. Keys get stolen, coerced, and
subpoenaed. In the seal tier, the blessing is a Digital Seal the **validator
set produced** by verifying the attested screening computation (PoUW) under a
CEAP policy — TEE backend, jurisdiction, vendor-rooted hardware. Stealing a
TEE key gets an attacker a PASSED status; it does not get them a quorum seal,
so it does not get them the money.

> **Rollup test:** a rollup does not run attested compute as consensus; its
> "compliance oracle" is exactly the key-based design this tier exists to
> transcend. **Fails.**

### 2. Sanctions revocation propagates from consensus, in-flight

`isCleared` re-reads `ISeal.verifySeal` on every settlement. When the quorum
revokes a corridor's seal — a sanctions-list update verified by the chain —
every escrowed payment on that corridor is blocked from settling on the very
next read, with no NoblePay transaction, no oracle round-trip, no admin
intervention. Funds already in escrow can still be refunded to the sender:
the corridor closes forward, never strands.

> **Rollup test:** seal state on an L2 is foreign state behind a bridge or a
> duplicated copy that can drift. "The corridor closed the same block the
> chain learned about the designation" is structurally unavailable. **Fails.**

### 3. Verification is bridge-free — the precompile reads consensus-native state

`ISeal` (0x0900) is a precompile: the settlement path calls it and it reads
the seal keeper's state in the same execution. For a payments rail whose
product IS regulatory defensibility, inserting a bridge (the ecosystem's
dominant loss category) between the payment and its compliance proof would be
self-defeating.

> **Rollup test:** an L2 reaching L1 seal state needs a message bridge or
> proof relay — added trust, latency, and attack surface. **Fails.**

### 4. Sovereignty and data residency are enforced where the screening runs

Cross-border compliance (FATF travel rule, UAE CBUAE rules, sanctions
regimes) requires provable jurisdiction of the screening computation and
confidentiality of counterparty PII. CEAP encodes `dataResidency`,
`allowedBackends`, `requireVendorRoot` into the seal; the validator set
enforces them where the computation happens; PII never touches the chain —
only the purpose binding and hashes do. The gate's `setCompliancePolicy` then
makes those the admission rule for corridors (e.g. "AE residency, TEE
backend" for a UAE corridor program).

> **Rollup test:** a rollup inherits the base layer's validator set and
> jurisdiction; it cannot promise a central bank that screening ran under
> validators in its jurisdiction on vendor-rooted hardware. **Fails.**

### 5. Post-quantum finality on records that must survive litigation horizons

A settlement's compliance evidence must remain sound for regulatory
look-back and litigation windows measured in decades. Digital Seals are
quorum-signed with PQC (ML-DSA) via ABCI++ vote extensions — the clearance
minted today is finalized under a signature scheme built for a
store-now-decrypt-later adversary.

> **Rollup test:** a rollup's finality is the base layer's signature scheme;
> you cannot unilaterally give your compliance evidence PQC finality.
> **Fails.**

---

## What this is _not_

It is not "another L1 for its own sake." NoblePay runs a full EVM surface
with standard tooling (Hardhat, OpenZeppelin, wagmi/viem), and its existing
role-based TEE tier keeps working unchanged — the seal tier layers on top and
is opt-in until governance enables it. The L1 requirement is narrow and
load-bearing: the _root of trust for moving regulated money_ is a
consensus-minted, PQC-finalized, confidentially attested seal, checked
bridge-free at the settlement choke point. Everything an L2 can do, Aethelred
also does; the five properties above are what an L2 structurally cannot do —
and they are exactly what a sovereign payments program buys NoblePay for.

## The honest boundary

- The strength of a clearance is the strength of the seal behind it. Consult
  the chain's confidential-execution status ledger for which CEAP backends
  are production-operational vs. maturing; never present a maturing backend
  as fully operational.
- The seal tier gates **corridors** (payer→payee pairs); the TEE tier screens
  **individual payments**. Both are required when enforcement is on — neither
  replaces the other.
- The PoUW screening _model_ (the attested computation the validators verify)
  is program-specific and must be registered and reviewed per deployment; the
  gate proves the screening ran under policy, not that the screening model
  itself is complete. Model governance is a program responsibility.
- The contracts await a Tier-1 external audit before mainnet (launch gate).
  See `SECURITY.md`.
