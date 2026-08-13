# NP-AI-01 — AI decision "provenance" is a permissioned assertion, not proof

**Severity:** HIGH (claim accuracy / regulatory positioning)
**Component:** `contracts/src/AIComplianceModule.sol`,
`backend/src/services/ai-compliance.ts`
**Status:** Open. The appeal verifiers added alongside this note work within the
limitation; they cannot remove it.

## The claim the code makes

Three of the four gated AI methods refuse with a message that promises a
specific property:

```
"AI appeals are disabled until the underlying decision has
 cryptographically verified provenance"

"AI decision overrides are disabled until decisions have
 cryptographically verified provenance"
```

## What the contract actually does

`recordDecision` is a permissioned write:

```solidity
function recordDecision(
    bytes32 _subjectHash,
    bytes32 _modelId,
    DecisionOutcome _outcome,
    uint8 _confidenceScore,
    bytes32 _evidenceHash,
    bytes32 _reasonHash
) external whenNotPaused onlyRole(AI_OPERATOR_ROLE) returns (bytes32 decisionId)
```

It checks that the confidence score is ≤ 100, that the model exists and is
ACTIVE, and that the caller holds `AI_OPERATOR_ROLE`. Then it stores what it was
given, including `evidenceHash`, which is written once (line 335) and never read
back for validation by any function in the contract.

There is no TEE attestation, no signature over the model output, no proof the
named model produced the recorded outcome, and no check that `evidenceHash`
corresponds to anything at all. `bytes32(0)` is accepted.

So the on-chain record establishes:

- **that an authorised operator asserted this outcome**, at a given time,
  immutably, attributably.

It does not establish:

- that a model ran,
- that the named model ran,
- that the model produced this outcome,
- that any evidence exists behind `evidenceHash`.

Those are the properties "cryptographically verified provenance" would normally
be understood to mean, particularly next to a `teeAttestation` column in the
database and a decision-appeal workflow.

## Why the distinction matters here specifically

This module exists to support contesting an automated decision — the
EU AI Act Article 86 / GDPR Article 22 shape of obligation. In that setting the
integrity question a regulator asks is *"can you show the decision you are
defending is the one the system actually made?"*

An operator assertion answers a narrower question: *"can you show who claimed
this outcome, and that the claim has not been altered since?"* That is genuinely
useful — it makes tampering and back-dating detectable, and it binds an
accountable party — but it is an **audit trail**, not **provenance**. Describing
it as the latter in a message a customer or auditor may read is the kind of
overstatement that is expensive to walk back.

## What was done

The appeal and override lifecycle is now verified against the chain, which is
worth having and is honestly describable:

- `submitAppeal` ← `AppealFiled`
- `startAppealReview` ← `AppealReviewStarted` (**new** — see below)
- `resolveAppeal` ← `AppealResolved`
- `overrideDecision` ← `DecisionOverridden`

Each record is written only if the receipt corroborates it, and each response
carries `decisionProvenance: "OPERATOR_ASSERTED"` so the limitation travels with
the data rather than living only in this document.

`runDecision` remains closed. It is not blocked on a receipt verifier — it is
blocked on there being a model to run. No verifier can close it.

## A second, separate defect: the API skipped a mandatory step

The contract enforces a two-step review:

```solidity
function resolveAppeal(...) {
    if (a.status != AppealStatus.UNDER_REVIEW) revert AppealNotUnderReview();
```

Only `startAppealReview`, restricted to `COMPLIANCE_OFFICER_ROLE`, sets that
status. The backend had no corresponding method — `resolveAppeal` was the only
path, so an appeal record would have jumped `SUBMITTED → UPHELD` with no record
of who took up the review or when.

For an appeals process that is the auditable step: a named compliance officer
accepting the review is precisely what demonstrates the appeal received human
consideration. `startAppealReview` has been added to the service, routes and
schema for that reason.

## Recommended follow-up

1. Reword the gate and any customer-facing copy: "operator-attested" rather than
   "cryptographically verified provenance".
2. If real provenance is wanted, `recordDecision` must verify something —
   a TEE quote, or a signature over `(modelId, subjectHash, outcome)` by a key
   bound to the model deployment. Storing an unread hash does not achieve it.
3. Decide what `evidenceHash` is for. As written it is decorative.

## Evidence

- `contracts/src/AIComplianceModule.sol:306-313` — permissioned entry point
- `contracts/src/AIComplianceModule.sol:335` — `evidenceHash` stored, never read
- `contracts/src/AIComplianceModule.sol:436` — `AppealNotUnderReview` guard
- `backend/src/services/ai-compliance.ts` — gate messages
