# External compliance submission contract

The bundled Rust crate is a test/reference screening engine. It does not sign or
submit Aethelred transactions and is therefore deliberately incompatible with
the production trust boundary. `COMPLIANCE_API_URL` must identify an audited
external operator implementing this contract.

## `POST /v1/screen`

Requests are authenticated with `X-API-Key`. The payment's immutable NoblePay
database UUID is the idempotency identity and is sent identically as
`request_id`, `X-Request-Id`, and `Idempotency-Key`. The amount is a canonical,
positive base-10 string in the
configured 6-decimal stablecoin's smallest unit; it is never a JSON number.
All identifiers and addresses in the examples below are illustrative. In
particular, `7332` is the local/CI chain ID, not a declaration of the public
testnet ID; production must use the US operator-confirmed value end to end.

```json
{
  "request_id": "5e44f06b-962b-49f8-a8f5-b429342934cd",
  "payment": {
    "id": "0x1111111111111111111111111111111111111111111111111111111111111111",
    "sender": "0x1111111111111111111111111111111111111111",
    "recipient": "0x2222222222222222222222222222222222222222",
    "amount": "1000000",
    "currency": "USDC",
    "purpose_hash": "0x3333333333333333333333333333333333333333333333333333333333333333",
    "metadata": {},
    "timestamp": "2026-07-21T12:00:00.000Z"
  },
  "chain_id": "7332",
  "contract_address": "0x4444444444444444444444444444444444444444",
  "travel_rule_data": {
    "originator_name": "Originator Legal Entity",
    "originator_account": "0x1111111111111111111111111111111111111111",
    "originator_address": "Registered address, city, country",
    "beneficiary_name": "Beneficiary Legal Entity",
    "beneficiary_account": "0x2222222222222222222222222222222222222222"
  },
  "travel_rule_required": true,
  "travel_rule_payload_commitment": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "timeout_ms": 30000
}
```

Before answering successfully, the service must:

1. Atomically claim `request_id` before doing any screening or chain work. A
   repeat with the same identity and byte-equivalent request must return the
   original result and `submission_tx_hash`; it must never screen or submit a
   second transaction. A repeat with the same identity but different request
   data must return HTTP `409`. Idempotency records must be durable across
   process restarts and retained for at least as long as NoblePay payment data.
2. Read the pending payment from `contract_address` on `chain_id` and reject any identifier, sender, recipient, token, amount, purpose, or state mismatch.
3. Screen against fresh, integrity-checked OFAC, UAE Central Bank, UN, and EU sources inside a genuinely attested production TEE.
4. Sign and submit `submitComplianceResult(paymentId, sanctionsClear, amlRiskScore, travelRuleOk, investigationHash, attestation)` directly to NoblePay using the configured EOA operator. The managed hardware/service key must produce a top-level transaction whose `from` is exactly `TEE_NODE_ADDRESS`; Safe, module, relayer, and delegated submissions are unsupported and rejected.
5. Wait for the configured confirmation count, verify the transaction succeeded, and verify the expected NoblePay compliance event.

The Node API applies the operator-agreed `TRAVEL_RULE_THRESHOLD_USD` to its
configured six-decimal USD stablecoins. At or above that threshold it refuses
to call the operator until the tenant business wallet has signed a short-lived,
domain-separated EIP-191 challenge committing the exact payment and strict
IVMS101 subset; Safe and other contract business wallets are verified through
EIP-1271 at one anchored canonical block. The canonical payload is stored only as AES-256-GCM ciphertext
and is decrypted only for the TLS request above. Retries use the same encrypted
record, commitment, `request_id`, and request body. Below the threshold,
`travel_rule_required` is `false`, both Travel Rule data and commitment are
`null`, and the operator must not report a missing-data violation.

For an above-threshold request, the operator must reject null Travel Rule data,
must bind its idempotency fingerprint to both the exact data and
`travel_rule_payload_commitment`, and must never return
`travel_rule_compliant: true` if the required fields are absent. A repeat with
the same `request_id` but any changed Travel Rule byte must return HTTP 409.

Immediately before each HTTPS attempt, NoblePay durably records the exact
destination origin, `request_id`, first/last attempt time, and attempt count.
This conservative attempt evidence means the payload might have crossed the
TLS boundary; it does **not** assert that the operator received or accepted it.
The record becomes `shared=true` only when the returned on-chain submission has
been independently verified and that proof is committed atomically with the
screening result. Operators must preserve both kinds of evidence in incident
and disclosure audits rather than treating an outbound attempt as verified
sharing.

Only then may it return HTTP 200:

```json
{
  "success": true,
  "request_id": "5e44f06b-962b-49f8-a8f5-b429342934cd",
  "payment_id": "0x1111111111111111111111111111111111111111111111111111111111111111",
  "chain_id": "7332",
  "contract_address": "0x4444444444444444444444444444444444444444",
  "submission_tx_hash": "0x5555555555555555555555555555555555555555555555555555555555555555",
  "result": {
    "payment_id": "0x1111111111111111111111111111111111111111111111111111111111111111",
    "sanctions_clear": true,
    "aml_risk_score": 10,
    "travel_rule_compliant": true,
    "status": "Passed",
    "investigation_hash": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "attestation": "0x0102"
  }
}
```

The Node API independently fetches the transaction, receipt, calldata, signer
role, confirmation count, and emitted event. Missing, pending, reverted,
mismatched, replayed, or indirectly submitted transactions fail closed.
The finalized deployment manifest binds `teeNodeAccountType` to `eoa`, and the
deployment ceremony checks that `eth_getCode(TEE_NODE_ADDRESS)` has no bytecode
on both the private and browser-facing RPCs. Operator key custody remains the
external compliance service's responsibility; NoblePay never receives that
key.
It stores the verified response in a durable recovery intent before advancing
the local payment, so a database failure after chain success resumes from that
evidence on retry.

## Health and operator readiness

Unauthenticated `GET /v1/health` must return `status: "healthy"`, fresh
`sanctions_lists` metadata (`total_entries`, all four `last_updated` values,
`source`, `dataset_generated_at`, and a 64-hex-character dataset digest). It
should additionally publish the service's chain ID, NoblePay address, operator
address, latest observed block, and whether the operator currently holds
`TEE_NODE_ROLE`. Operators must alert and return an unready status on any
mismatch, stale dataset, insufficient funds, lost role, RPC lag, or TEE
attestation failure.

## Settlement

Compliance approval does not move escrow. An authorized business wallet or
settlement executor must call `settlePayment(paymentId)`, wait for the required
confirmations, and verify `PaymentSettled`. The NoblePay Node API accepts a
lifecycle update only after independently verifying that receipt; local service
state is never settlement authority.
