# Why NoblePay, When Aethelred Already Has a Wallet?

**Audience:** anyone who asks the reasonable first question — "the network has a
wallet that can already send AETHEL and tokens; why is a separate NoblePay
needed?"

**Short answer:** a wallet and NoblePay operate at different layers and answer
different questions. A wallet is a **custody-and-authorization** tool — it holds
keys and signs transactions ("who am I, and do I approve this?"). NoblePay is a
**regulated settlement protocol** — smart contracts plus services that decide
whether a specific cross-border payment, between specific parties, in specific
jurisdictions, may settle, and enforce that decision in code ("is this payment
permitted, and how does it clear?"). They are complementary, not competing: the
wallet is the interface through which a business _authorizes_ a NoblePay
payment; NoblePay is the rail that _escrows, screens, and settles_ it.

Saying "just use the wallet" for cross-border settlement is like saying "why do
I need a correspondent bank and SWIFT when I have a checkbook?" The checkbook
(wallet) authorizes; the rail (NoblePay) clears under regulation.

---

## The category distinction

|                     | **Aethelred Wallet**                     | **NoblePay**                                          |
| ------------------- | ---------------------------------------- | ----------------------------------------------------- |
| What it is          | Key custody + signer + EIP-1193 provider | A payment protocol (contracts + backend + compliance) |
| Whose tool          | The **user's** agent                     | The **institution's** rail                            |
| Question it answers | "Who am I; do I approve this tx?"        | "Is _this_ payment permitted; how does it settle?"    |
| Scope               | Application-agnostic                     | Cross-border payments, specifically                   |
| Analogy             | A checkbook / signing hand               | A correspondent bank + clearing house                 |

A wallet is deliberately generic: it will sign _any_ transaction its owner
approves, including a NoblePay `initiatePayment`. That generality is exactly why
it cannot _be_ the settlement rail — it has no opinion about, and no machinery
for, whether a given transfer is lawful.

---

## What a bare wallet transfer does NOT have

Send native AETHEL wallet-to-wallet and you get a peer-to-peer transfer with
**none** of the regulatory machinery an institution is legally required to
operate. NoblePay adds all of it, in code:

1. **Sanctions / AML / travel-rule screening.** Every payment is screened
   (NoblePay's TEE tier) and — at the top tier — settlement is gated on a
   **consensus-minted corridor clearance** (the SealSettlementGate). A wallet
   transfer has no screening at all.
2. **Auditable compliance evidence.** NoblePay records purpose hashes,
   travel-rule data, per-payment compliance results, and (top tier) a Digital
   Seal a regulator can verify. A wallet transfer produces a bare value
   transfer — nothing a compliance officer can attest to.
3. **Corridor clearance + business registration.** Payments flow only between
   registered businesses over screened payer→payee corridors. A wallet will
   send to any address.
4. **Escrow-then-clear settlement.** Funds are escrowed on `initiate`, released
   only on `PASSED` compliance (and, when enforced, a live corridor seal), and
   **refunded to the sender** if blocked/flagged. A wallet transfer is
   irreversible the moment it is signed — there is no compliance hold, no
   refund path.
5. **Volume limits, tiered fees, treasury routing.** Per-tier daily/monthly
   caps, a fee engine, and atomic fee/treasury splitting at settlement. A wallet
   has no concept of any of this.
6. **Sovereign revocation.** A quorum-verified sanctions-list update **closes a
   NoblePay corridor live**, blocking in-flight escrow with no transaction. No
   wallet can retroactively stop a payment its owner already authorized.

A bank or PSP cannot use "send from wallet" as its cross-border rail because
none of that machinery exists there — and building it into the wallet would
turn the wallet into NoblePay, badly (every wallet user would carry payment-rail
compliance logic they neither want nor should have).

---

## They work together (the Wallet → dApp relationship)

The wallet is not bypassed by NoblePay — it is _used_ by it. The exact same
Wallet → dApp relationship as the rest of the Aethelred arc (Cruzible, ZeroID,
TerraQura):

```
  Business  ──signs──►  Aethelred Wallet  ──initiatePayment──►  NoblePay
  (the payer)           (custody + auth)                        (escrow, screen,
                                                                 seal-gate, settle)
```

The wallet authorizes; NoblePay decides and clears. Removing NoblePay does not
"simplify to just the wallet" — it removes the entire compliance and settlement
layer, leaving an unregulated peer-to-peer transfer that no regulated
institution can lawfully use for cross-border payments.

---

## Why this is a moat, not overhead

The compliance machinery is not a cost NoblePay pays to look serious — it is the
product. And its top tier is anchored where only an L1 can put it: a corridor
clearance is a **Digital Seal minted by the Aethelred validator quorum**,
verified in-EVM by a consensus-native precompile (see
[`WHY_AETHELRED_L1.md`](./WHY_AETHELRED_L1.md)). A wallet — or a payment app on
someone else's chain — cannot offer settlement contingent on consensus-verified,
confidentially-attested, PQC-finalized screening. That is precisely what makes
NoblePay the default cross-border rail for sovereign and regulated clients, and
precisely what a wallet, by design, is not built to be.
