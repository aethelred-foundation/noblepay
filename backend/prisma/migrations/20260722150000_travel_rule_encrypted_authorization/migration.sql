-- A Travel Rule record is admitted only after a short-lived EIP-191 EOA or
-- EIP-1271 contract-wallet challenge commits the exact payment-bound IVMS101 payload. The canonical
-- payload is stored only as AES-256-GCM ciphertext; no cleartext PII columns
-- are introduced.

ALTER TABLE "wallet_challenges"
ADD COLUMN "travel_rule_payment_id" UUID,
ADD COLUMN "travel_rule_commitment" TEXT;

CREATE INDEX "wallet_challenges_travel_rule_payment_id_idx"
ON "wallet_challenges"("travel_rule_payment_id");

-- The previous application had no production writer for this table. Refuse
-- to guess how an unexpected legacy row should be encrypted or authorized.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "travel_rule_records" LIMIT 1) THEN
    RAISE EXCEPTION 'travel_rule_records must be empty before encrypted Travel Rule authorization migration';
  END IF;
END $$;

ALTER TABLE "travel_rule_records"
ADD COLUMN "payload_commitment" TEXT NOT NULL,
ADD COLUMN "encrypted_payload" BYTEA NOT NULL,
ADD COLUMN "encryption_iv" BYTEA NOT NULL,
ADD COLUMN "authentication_tag" BYTEA NOT NULL,
ADD COLUMN "encryption_key_id" TEXT NOT NULL,
ADD COLUMN "authorized_by" TEXT NOT NULL,
ADD COLUMN "authorization_signature" TEXT NOT NULL,
ADD COLUMN "challenge_id" UUID NOT NULL,
ADD COLUMN "outbound_request_id" UUID,
ADD COLUMN "outbound_destination" TEXT,
ADD COLUMN "outbound_attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "first_outbound_attempt_at" TIMESTAMP(3),
ADD COLUMN "last_outbound_attempt_at" TIMESTAMP(3),
ADD COLUMN "shared_at" TIMESTAMP(3),
ADD COLUMN "submission_tx_hash" TEXT,
ADD COLUMN "submission_block_number" BIGINT;

CREATE UNIQUE INDEX "travel_rule_records_payload_commitment_key"
ON "travel_rule_records"("payload_commitment");

CREATE UNIQUE INDEX "travel_rule_records_challenge_id_key"
ON "travel_rule_records"("challenge_id");

CREATE UNIQUE INDEX "travel_rule_records_submission_tx_hash_key"
ON "travel_rule_records"("submission_tx_hash");

CREATE INDEX "travel_rule_records_shared_created_at_idx"
ON "travel_rule_records"("shared", "created_at");

ALTER TABLE "travel_rule_records"
ADD CONSTRAINT "travel_rule_records_challenge_id_fkey"
FOREIGN KEY ("challenge_id") REFERENCES "wallet_challenges"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "wallet_challenges"
ADD CONSTRAINT "wallet_challenges_travel_rule_shape_check" CHECK (
  (
    "purpose" = 'TRAVEL_RULE' AND
    "travel_rule_payment_id" IS NOT NULL AND
    "travel_rule_commitment" ~ '^0x[0-9a-f]{64}$' AND
    "transaction_hash" IS NULL
  ) OR (
    "purpose" <> 'TRAVEL_RULE' AND
    "travel_rule_payment_id" IS NULL AND
    "travel_rule_commitment" IS NULL
  )
);

ALTER TABLE "travel_rule_records"
ADD CONSTRAINT "travel_rule_records_encryption_shape_check" CHECK (
  octet_length("encryption_iv") = 12 AND
  octet_length("authentication_tag") = 16 AND
  octet_length("encrypted_payload") > 0 AND
  "payload_commitment" ~ '^0x[0-9a-f]{64}$' AND
  "originator_hash" ~ '^0x[0-9a-f]{64}$' AND
  "beneficiary_hash" ~ '^0x[0-9a-f]{64}$' AND
  "authorized_by" ~ '^0x[0-9A-Fa-f]{40}$' AND
  length("authorization_signature") BETWEEN 4 AND 32770 AND
  "authorization_signature" ~ '^0x([0-9a-f]{2})+$' AND
  length("encryption_key_id") BETWEEN 1 AND 64
);

ALTER TABLE "travel_rule_records"
ADD CONSTRAINT "travel_rule_records_outbound_attempt_check" CHECK (
  (
    "outbound_attempt_count" = 0 AND
    "outbound_request_id" IS NULL AND
    "outbound_destination" IS NULL AND
    "first_outbound_attempt_at" IS NULL AND
    "last_outbound_attempt_at" IS NULL
  ) OR (
    "outbound_attempt_count" > 0 AND
    "outbound_request_id" IS NOT NULL AND
    "outbound_destination" ~ '^https://[^/?#]+$' AND
    "first_outbound_attempt_at" IS NOT NULL AND
    "last_outbound_attempt_at" IS NOT NULL AND
    "first_outbound_attempt_at" <= "last_outbound_attempt_at"
  )
);

ALTER TABLE "travel_rule_records"
ADD CONSTRAINT "travel_rule_records_sharing_evidence_check" CHECK (
  "shared_with" IS NOT NULL AND (
    (
      "shared" = FALSE AND
      "shared_at" IS NULL AND
      "submission_tx_hash" IS NULL AND
      "submission_block_number" IS NULL AND
      cardinality("shared_with") = 0
    ) OR (
      "shared" = TRUE AND
      "outbound_attempt_count" > 0 AND
      "shared_with"[1] = "outbound_destination" AND
      "shared_at" IS NOT NULL AND
      "submission_tx_hash" ~ '^0x[0-9a-f]{64}$' AND
      "submission_block_number" >= 0 AND
      cardinality("shared_with") = 1
    )
  )
);

ALTER TABLE "compliance_submission_intents"
ADD COLUMN "travel_rule_record_id" UUID,
ADD COLUMN "travel_rule_payload_commitment" TEXT;

ALTER TABLE "compliance_submission_intents"
ADD CONSTRAINT "compliance_submission_intents_travel_rule_evidence_check" CHECK (
  (
    "travel_rule_record_id" IS NULL AND
    "travel_rule_payload_commitment" IS NULL
  ) OR (
    "travel_rule_record_id" IS NOT NULL AND
    "travel_rule_payload_commitment" ~ '^0x[0-9a-f]{64}$'
  )
);
