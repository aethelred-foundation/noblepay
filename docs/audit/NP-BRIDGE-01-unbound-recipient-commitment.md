# NP-BRIDGE-01 — `CrossChainRouter` never binds `recipientHash` to a recipient

**Severity:** HIGH
**Component:** `contracts/src/CrossChainRouter.sol`
**Status:** Open — contract change required. The backend verifier added alongside
this note works around it but cannot fix it.

## What the contract claims

`initiateTransfer` takes the destination recipient as a hash:

```solidity
/**
 * @param _recipientHash       Keccak256 hash of the recipient address on the destination chain.
 */
function initiateTransfer(
    address _sourceToken,
    uint256 _amount,
    uint256 _destinationChainId,
    bytes32 _recipientHash
)
```

## What the contract does

It stores the parameter and emits it. That is all:

```solidity
recipientHash: _recipientHash,
...
emit TransferInitiated(transferId, msg.sender, _destinationChainId,
                       _sourceToken, _amount, fee, _recipientHash);
```

The NatSpec is a description of what the caller is *expected* to pass. Nothing in
the contract computes, derives, or checks it. Any 32 bytes are accepted, and
`bytes32(0)` is as valid as a real commitment.

## Why that is not merely cosmetic

A hash is not invertible. The relay that delivers funds on the destination chain
cannot read the recipient out of `recipientHash`; it must be told the preimage
through some other channel. So the on-chain record does not determine where the
money goes — it can only be used to *check* a recipient that someone supplies
separately.

That check is worth having, but it only works if everyone agrees on the encoding.
And no one does:

- The contract does not define one; it accepts opaque bytes.
- No production code in this repository computes a `recipientHash` at all.
- Every contract test passes `keccak256(toUtf8Bytes("recipient"))` — the literal
  seven-character string `"recipient"`, not a recipient. The tests would pass
  unchanged under any encoding, or none, so they provide no evidence that the
  commitment scheme works.

The result is a field that looks like a binding commitment in the ABI, in the
event log, and in the NatSpec, while committing to nothing. A reviewer reading
`TransferInitiated` would reasonably conclude the destination was pinned at
initiation. It was not.

## Interaction with the API

`POST /v1/crosschain/transfers` records a `recipient` string. Before this change
there was no link between that string and the chain, so a caller could initiate
on-chain to one commitment and record a different recipient in the database.

The verifier added in `backend/src/services/crosschain-execution.ts` closes the
API-side half of that gap by recomputing the hash and refusing a mismatch. It
must therefore *choose* an encoding, and choosing one in the backend is not the
same as the contract enforcing one:

```ts
export function recipientCommitment(recipient: string): string {
  return keccak256(toUtf8Bytes(recipient.trim().toLowerCase()));
}
```

UTF-8 over the lowercased string, rather than `abi.encodePacked(address)`,
because the destination may be a Cosmos bech32 address or another non-EVM
identifier that does not fit in 20 bytes. A cross-chain router cannot assume its
destinations are EVM.

**This is now the de facto convention, established by the verifier rather than by
the contract.** Any client that calls `initiateTransfer` directly must use the
same encoding or its transfers will fail verification. That is a fragile way to
hold an invariant.

## Recommended fix

Have the contract derive the commitment instead of accepting it:

```solidity
function initiateTransfer(
    address _sourceToken,
    uint256 _amount,
    uint256 _destinationChainId,
    string calldata _recipient
) external {
    bytes32 recipientHash = keccak256(bytes(_recipient));
    ...
}
```

This costs calldata and makes the recipient public, which is the trade-off the
current design was presumably avoiding. If the recipient must stay private, then
the commitment should at minimum be salted and the salt-handling specified, and
the tests should exercise a real preimage rather than the string `"recipient"` —
otherwise the privacy argument protects a field that binds nothing.

## Evidence

- `contracts/src/CrossChainRouter.sol:302-309` — NatSpec claim
- `contracts/src/CrossChainRouter.sol:337` — stored verbatim
- `contracts/src/CrossChainRouter.sol:356` — emitted verbatim
- `contracts/test/CrossChainRouter.test.js:244,254,264,279,295,310` — placeholder
  preimage in every case; also `BranchMax6/7`, `BranchPush`, `BranchCoverage`,
  `SecurityAuditFixes`
