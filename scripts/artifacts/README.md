# SealSettlementGate — vendored reviewed artifact

`SealSettlementGate.bin` / `SealSettlementGate.abi` are the reviewed creation
bytecode and ABI of NoblePay's consensus-anchored corridor clearance gate,
compiled with solc 0.8.19 (via-ir, optimizer runs 200, paris).

`scripts/devnet-seal-settlement-e2e.mjs` deploys this exact bytecode to a live
aethelredd EVM node (chain-id 7332) and drives the seal-gated corridor flow.

## Source of truth

The definitive seal-binding proof runs this same artifact against the **real**
ISeal precompile (0x0900) and a real seal keeper in the chain repository:

    aethelred/internal/evmhost/noblepay_test.go
    aethelred/internal/evmhost/testdata/noblepay/SealSettlementGate.{bin,abi}

That test asserts the full behaviour a live E2E cannot exhaustively cover on a
single run: corridor-direction sensitivity (payer→payee ≠ payee→payer),
jurisdiction policy enforcement (an AE policy rejects a US-jurisdiction seal),
live revocation (a chain-side seal revoke closes the corridor with no NoblePay
tx), and clearance permanence (a revoked corridor cannot be re-opened even with
a fresh, policy-satisfying seal — `AlreadyCleared`).

The vendored `.bin` here is byte-identical (SHA-256) to the chain repo's copy;
keep them in lockstep when the contract is recompiled.

## Editable source

`../../contracts/src/SealSettlementGate.sol` is a faithful reconstruction of
this artifact: its **ABI is byte-for-byte identical** to `SealSettlementGate.abi`
(verified), and its behaviour is covered by
`../../contracts/test/SealSettlementGate.test.js` (15 cases mirroring the chain
repo's real-precompile assertions — direction sensitivity, CEAP policy, live
revocation, clearance permanence). Recompiling that source produces functionally
equivalent but **not** byte-identical bytecode (different compiler
provenance/metadata), so the `.bin` vendored here — the reviewed artifact — stays
the deploy artifact of record. If the on-chain contract must change, edit the
source, recompile, and re-vendor both this `.bin` and the chain repo's testdata
copy together.
