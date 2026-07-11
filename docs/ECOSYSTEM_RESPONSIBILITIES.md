# Canonical Ecosystem Responsibilities — NoblePay Integration

**Status:** adopted 2026-07-11 (product decision). This matrix is the
integration contract: each product owns its row and CONSUMES the others'
surfaces rather than reimplementing them. Code in this repo must not cross
these boundaries.

| Product | Canonical responsibility | NoblePay integration |
| --- | --- | --- |
| **Aethelred protocol** | Consensus, finality, gas, confidential execution, Proof-of-Useful-Work, Digital Seals and protocol-native verification | NoblePay submits settlement and compliance workloads and verifies protocol-native evidence before releasing funds |
| **ZeroID** | DIDs, KYC/KYB credentials, selective disclosure, credential status and revocation | NoblePay consumes narrowly scoped identity presentations rather than operating a parallel identity authority |
| **Aethelred Wallet** | Keys, custody, transaction simulation, signing, enterprise approvals, spend policies and wallet audit evidence | NoblePay constructs payment intents; the wallet decides whether and how they may be signed |
| **NoblePay** | Payment lifecycle, treasury, FX, invoice settlement, transaction screening, Travel Rule, escrow, reconciliation and reporting | Common payment rail for native NoblePay users and other Aethelred dApps |
| **Shiora** | Health records, consent, clinical workflows, AI-health outputs and privacy rights | Sends opaque healthcare invoices or payout instructions to NoblePay; no protected health information enters NoblePay |
| **TerraQura** | Carbon-credit issuance, Proof-of-Physics, provenance, marketplace logic, transferability and retirement | Uses NoblePay for the payment, FX, escrow and treasury legs of carbon transactions |
| **Cruzible** | Explorer, validator/network visibility, AI-job evidence, staking and public read models | Displays transaction, block, Digital Seal and verification references; it is not part of NoblePay's settlement trust path |

## How this repo implements its rows (code, not intent)

- **Aethelred protocol row** — `SealSettlementGate` anchors corridor
  clearances to Digital Seals verified by the ISeal precompile (0x0900): the
  settlement path verifies protocol-native evidence (`isCleared` /
  `requireCleared`, live seal-revocation check) before funds move.
- **ZeroID row** — the gate's identity layer
  (`setIdentityRegistry(registry, required)`) consumes the ZeroID registry
  (`resolveByController` + `isActiveIdentity`) for BOTH corridor parties:
  checked at clearance and re-checked live in `isCleared`, so a suspension in
  ZeroID closes the corridor instantly and reinstatement reopens it. NoblePay
  holds no identity records of its own — ZeroID is the sole status authority.
  Failure of the registry reads as NOT verified (fail closed).
- **Wallet row** — NoblePay transactions decode into explicit intents in the
  Aethelred Wallet's approval sheet (`initiatePayment`, `settlePayment` with
  a fund-release warning, `clearCorridor`); the wallet's policy engine and
  the user decide signing. Undecodable calls surface a prominent
  cannot-decode warning, never a quiet blind-sign.
- **Shiora row (constraint)** — invoice/payout instructions entering NoblePay
  must be opaque references (ids, hashes, amounts, corridors). Fields that
  could carry protected health information are out of contract and must be
  rejected at the API boundary.
- **TerraQura row** — carbon-transaction payment legs ride the same corridor
  clearance + settlement surfaces as any payment; no carbon-specific logic
  belongs in this repo.
