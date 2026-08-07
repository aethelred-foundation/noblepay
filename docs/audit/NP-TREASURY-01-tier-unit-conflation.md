# NP-TREASURY-01 — MultiSigTreasury tiers a proposal by raw token units, not value

**Status:** open — needs a product/governance decision, not a mechanical fix
**Component:** `contracts/src/MultiSigTreasury.sol`
**Severity:** high (the approval threshold is the contract's primary control)
**Found:** while wiring the treasury console to the deployed contract, 2026-08-07

## Summary

`createProposal` decides how many signatures a transfer needs by comparing the
caller-supplied `_amount` against two constants:

```solidity
uint256 public constant SMALL_TX_THRESHOLD = 10_000 * 1e6;   // "$10K in 6 decimals"
uint256 public constant LARGE_TX_THRESHOLD = 100_000 * 1e6;  // "$100K in 6 decimals"

} else if (_amount <= SMALL_TX_THRESHOLD) {
    tier = TxTier.SMALL;
    requiredApprovals = signerConfig.smallThreshold;
```

The very same `_amount` is later used as the transfer quantity:

```solidity
(bool ok, ) = p.recipient.call{value: p.amount}("");        // native
IERC20(p.token).safeTransfer(p.recipient, p.amount);        // ERC20
```

So one number carries two incompatible units. The thresholds are written as US
dollars at six decimal places; the transfer needs the amount in the token's own
base units. The two coincide only for a six-decimal token trading at $1 — USDC
or USDT. For every other asset the tier is computed from a quantity that has
nothing to do with the value being moved.

## Impact

The approval threshold is the whole point of a multi-sig treasury, and it is
wrong in both directions depending on the token's decimals.

**Under-approval (the dangerous direction).** A token with fewer than six
decimals tiers far too low. WBTC has eight decimals, so 1 WBTC is `1e8` base
units. `1e8 <= 10_000 * 1e6` holds, so the proposal is tiered `SMALL` and needs
only `signerConfig.smallThreshold` approvals — one signature on the current
devnet configuration. On mainnet pricing that is a single signer moving roughly
six figures of value through a control designed to require three.

The boundary is `1e10` base units. Any asset where `1e10` base units is worth
more than $10,000 — that is, any asset with 8 or fewer decimals and a non-trivial
unit price — is mis-tiered downwards.

**Over-approval (merely obstructive).** An 18-decimal asset tiers far too high.
`0.0000001 AETHEL` is `1e11` wei, already past `LARGE_TX_THRESHOLD`, so
essentially every native transfer demands the `LARGE` threshold and the 48-hour
timelock regardless of value. The live devnet proposal demonstrates this from
the other side: 50,000,000,000 wei — 0.00000005 AETHEL, economically nothing —
is tiered `MEDIUM` and required 2 of 3 signatures.

## Reproduction

On the running devnet, proposal
`0xb0e5549ef29f19213987c37c736b4955892f71e833ef1379f5306e02a77ebe6e`:

- `token` = `address(0)` (native, 18 decimals)
- `amount` = `50000000000` (0.00000005 AETHEL)
- `tier` = `1` (MEDIUM), `requiredApprovals` = 2

The contract classified a dust transfer as a mid-size treasury movement, because
it read `5e10` as "$50,000".

## Why this is not fixed here

Making the tier track value requires information the contract does not have. The
plausible remedies each carry a governance decision that is not mine to take:

1. **Normalise by decimals.** Read `IERC20Metadata.decimals()` and scale into the
   six-decimal reference unit. This fixes the unit mismatch but still assumes
   every token is worth $1, so it corrects WBTC's decimals without correcting its
   price. Cheap, no new trust assumptions, partial.
2. **Price the asset.** Introduce a per-token price feed and tier on the USD
   value. Correct, but adds an oracle to a contract that currently has none —
   a new trust assumption and a new failure mode for a sovereign-tier deployment.
3. **Per-token thresholds.** Let an admin set explicit SMALL/LARGE bounds per
   supported token, denominated in that token's units. No oracle, fully explicit,
   but the correctness burden moves to whoever configures each token.

Option 3 is the most defensible for a regulated treasury: it is auditable, has no
external dependency, and makes the policy visible rather than inferred. It is
still a decision for the treasury owner.

Any change alters the security semantics of a contract that is already deployed,
so it needs a redeploy and a migration plan for in-flight proposals.

## What was done in the meantime

The console no longer presents the tier as though it were a dollar band:

- The approval matrix column is labelled "Amount bound", not "Range (USD)", and
  carries an explicit note that the bounds only read as dollars for a
  six-decimal, dollar-pegged token.
- A proposal whose asset is not six-decimal is marked "derived from raw units,
  not value" next to its tier.
- A non-zero amount that rounds away at six decimal places renders as
  `<0.000001` rather than `0`, so dust is never displayed as nothing.

These are honesty measures for the operator reading the screen. They do not
change what the contract enforces.
