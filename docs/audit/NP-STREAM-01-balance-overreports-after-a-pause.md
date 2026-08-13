# NP-STREAM-01 — stream balances over-report once a stream has been paused

**Severity:** HIGH (money owed, reported wrong)
**Component:** `backend/src/services/streaming.ts`,
`backend/prisma/schema.prisma` — `PaymentStream`
**Status:** Fixed here. The bug was latent, and opening the streaming gates is
what would have activated it.

## The defect

`StreamingPayments` subtracts accumulated pause time from both the elapsed time
and the total duration:

```solidity
uint256 elapsed = _effectiveElapsed(s);
uint256 totalDuration = s.endTime - s.startTime - s.totalPausedDuration;
...
uint256 effectivePausedDuration = s.totalPausedDuration;
return rawElapsed > effectivePausedDuration ? rawElapsed - effectivePausedDuration : 0;
```

`calculateBalance` subtracted neither:

```ts
const effective = effectiveTime(stream, now);
const elapsedSeconds = Math.floor(
  (effective.getTime() - stream.startTime.getTime()) / 1000,
);
const streamed = Prisma.Decimal.min(
  stream.totalAmount,
  stream.ratePerSecond.mul(elapsedSeconds),
);
```

`effectiveTime` handles only the case where a stream is paused **right now** —
it returns `pausedAt` while the status is PAUSED. The moment a stream is
resumed, the status returns to ACTIVE and that pause interval disappears from
the calculation entirely. `PaymentStream` had no column to remember it.

## What that means in practice

Stream 100 tokens over 100 seconds, at 1/second. Pause at t=10 for 30 seconds,
resume, and read the balance at t=60:

| | elapsed used | streamed reported |
| --- | --- | --- |
| Contract | 60 − 30 = **30** | **30** |
| API (before this fix) | **60** | **60** |

The API tells the recipient they have earned 60 and can withdraw it. The
contract will pay 30. The error is not a rounding artefact — it is the entire
pause duration, it compounds with every pause cycle, and it always errs in the
direction of promising money that does not exist.

For a payroll or vesting product that is the worst direction to be wrong in.

## Why it had not surfaced

Every method that could pause or resume a stream was behind the
`ONCHAIN_SETTLEMENT_UNAVAILABLE` gate, so in practice no stream ever
accumulated paused time and `totalPausedDuration` was always zero. The bug was
real but unreachable. **Opening the gates is precisely what would have made it
reachable**, which is why it is fixed in the same change rather than filed for
later.

## Fix

- `PaymentStream.totalPausedSeconds` added, accumulated from the
  `pausedDuration` that `StreamResumed` reports, so the API's figure comes from
  the contract's own arithmetic rather than being recomputed from timestamps.
- `calculateBalance` subtracts it from both `elapsedSeconds` and `totalSeconds`,
  matching the contract.
- A test pins the worked example above.

## Two further mismatches found alongside it

### 1. The contract cannot change a stream's rate

The API exposes `adjustRate`. `StreamingPayments` has no rate-adjustment
function — not `adjustRate`, `updateRate`, `setRate`, nor any event for one. A
stream's `ratePerSecond` is immutable once created, which is the correct design:
the recipient's entitlement depends on it, so a sender who could lower it
unilaterally could renege on the agreement after the fact.

`adjustRate` therefore cannot be verified, now or later. It is refused
permanently with `STREAM_RATE_IMMUTABLE` rather than left on a gate that implies
a verifier is coming.

### 2. The two status enums are ordered differently

```
contract StreamStatus:  ACTIVE, PAUSED, CANCELLED, COMPLETED
database StreamStatus:  ACTIVE, PAUSED, COMPLETED, CANCELLED
```

Postgres stores Prisma enums by name, so nothing is currently mis-stored. But
the on-chain values are `uint8` indices, and the two orderings disagree exactly
where it does the most damage: **index 2 is CANCELLED on chain and COMPLETED in
the database, and index 3 is the reverse.** Any code that decodes a chain status
by indexing the database enum would report cancelled streams as completed and
vice versa.

The verifier declares its own `CHAIN_STREAM_STATUS` ordering and a test pins it
against the Solidity source, so the two can never be silently conflated.

## Also noted, not fixed here

`PaymentStream.withdrawn` is never advanced by anything. The contract has a
`withdraw` function and a `Withdrawal` event; the API has no counterpart, so
`withdrawable` (`streamed − withdrawn`) over-reports for any stream that has
been drawn against. A `recordWithdrawal` verifier is included in
`streaming-execution.ts` and wired to `POST /streams/:id/withdrawals` for this
reason — it is the same over-reporting family as the pause bug and would have
been dishonest to leave open while fixing the other.

## Evidence

- `contracts/src/StreamingPayments.sol:520` — `totalDuration` less pauses
- `contracts/src/StreamingPayments.sol:552-560` — `_effectiveElapsed`
- `contracts/src/StreamingPayments.sol:371` — `totalPausedDuration` accumulated
- `contracts/src/StreamingPayments.sol:58-63` — contract enum ordering
- `backend/prisma/schema.prisma:510-515` — database enum ordering
