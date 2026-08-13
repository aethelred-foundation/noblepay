# NP-FX-01 — `FXHedge` cannot represent what `FXHedgingVault` does

**Severity:** MEDIUM (data fidelity, regulatory reporting)
**Component:** `backend/prisma/schema.prisma` — `HedgeType`, `HedgeStatus`, `FXHedge`
**Status:** Partially remediated. Columns added to preserve the chain's own
values; the legacy enums are left in place and still lossy.

## The mismatch

Two enums that look like counterparts and are not.

### Type

| Database `HedgeType` | Contract `HedgeType` |
| --- | --- |
| `FORWARD` | `FORWARD` |
| `OPTION` | `OPTION_CALL` |
| `SWAP` | `OPTION_PUT` |

- `OPTION` cannot express **call versus put**. Those are opposite positions: a
  call profits when the base currency rises, a put when it falls. A record that
  says only `OPTION` does not say which way the business is exposed.
- `SWAP` has **no on-chain counterpart**. `FXHedgingVault` creates forwards and
  options; it cannot create a swap. A `SWAP` hedge can never have a chain
  receipt, so it can never be verified.

### Status

| Database `HedgeStatus` | Contract `PositionStatus` |
| --- | --- |
| `OPEN` | `ACTIVE` |
| `CLOSED` | `MATURED` |
| `EXPIRED` | `SETTLED` |
| `EXERCISED` | `EXERCISED` |
| | `EXPIRED` |
| | **`LIQUIDATED`** |
| | **`EMERGENCY_UNWOUND`** |

The two missing states are the adverse ones. A position that was **liquidated**
— collateral seized after a margin breach — and one that was closed in an
**emergency unwind** both have to land on `CLOSED` if the legacy enum is all
there is. That records a forced liquidation as an orderly close.

For a regulated FX customer this is not cosmetic. "Which of our positions were
liquidated?" becomes unanswerable from the `fx_hedges` table, and a liquidation
is exactly the event an auditor, a risk committee, or a counterparty asks about.

`FXHedge` also has no `metadata` column, so there was nowhere to keep the true
value out of band either.

## Why the obvious workaround is wrong

Mapping `LIQUIDATED` and `EMERGENCY_UNWOUND` onto `CLOSED` and moving on would
have made the verifier pass and the gate open. It would also have meant the
system quietly destroys the most important fact about a position at the moment
it records it. A verifier that confirms a receipt and then discards what the
receipt said is not verification.

## What was done

Rather than widen the legacy enums (a migration touching existing rows and
every consumer of `status`), the chain's own values are stored alongside them:

```prisma
onChainPositionId String?  @map("on_chain_position_id")
openTxHash        String?  @map("open_tx_hash")
closeTxHash       String?  @map("close_tx_hash")
onChainHedgeType  String?  @map("on_chain_hedge_type")   // FORWARD|OPTION_CALL|OPTION_PUT
onChainStatus     String?  @map("on_chain_status")       // the full 7-value contract status
```

These are real columns rather than a JSON blob precisely because they are
queryable facts someone will filter on. Burying `LIQUIDATED` inside JSON is the
same erasure in a different wrapper.

`type` and `status` keep their existing meaning for existing readers.
`onChainHedgeType` and `onChainStatus` carry the unabridged truth, and are
`NULL` for rows that predate on-chain linkage — which is honest, since nothing
verified those.

`SWAP` is refused outright by the verifier (`FX_UNSUPPORTED_HEDGE_TYPE`) rather
than being mapped to something the vault could plausibly have emitted.

## Recommended follow-up

1. Widen `HedgeStatus` to the contract's seven values and backfill from
   `onChainStatus`, then drop the mapping.
2. Split `HedgeType.OPTION` into `OPTION_CALL` / `OPTION_PUT`.
3. Decide what `SWAP` means. Either the vault grows swap support, or the enum
   value is removed so the API cannot accept a hedge it can never verify.

## Evidence

- `backend/prisma/schema.prisma:541-552` — the legacy enums
- `contracts/src/FXHedgingVault.sol:64-79` — the contract enums
- `contracts/src/FXHedgingVault.sol:262-268` — `PositionLiquidated`
- `contracts/src/FXHedgingVault.sol:293-297` — `EmergencyUnwind`
