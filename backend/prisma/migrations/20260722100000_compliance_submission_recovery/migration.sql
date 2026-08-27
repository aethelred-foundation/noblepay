-- Persist a payment-scoped compliance submission intent before the external
-- operator is called. Verified chain evidence lives here independently of the
-- final payment/screening transaction so a crash can resume without submitting
-- a second compliance transaction.

CREATE TYPE "ComplianceSubmissionState" AS ENUM (
  'PENDING',
  'VERIFIED',
  'COMPLETED'
);

CREATE TABLE "compliance_submission_intents" (
    "payment_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "state" "ComplianceSubmissionState" NOT NULL DEFAULT 'PENDING',
    "sanctions_clear" BOOLEAN,
    "aml_risk_score" INTEGER,
    "travel_rule_compliant" BOOLEAN,
    "disposition" "ComplianceStatus",
    "flag_reason" TEXT,
    "investigation_hash" TEXT,
    "attestation" TEXT,
    "submission_tx_hash" TEXT,
    "submission_block_number" BIGINT,
    "screened_by" TEXT,
    "confirmations" INTEGER,
    "screening_duration" INTEGER,
    "verified_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compliance_submission_intents_pkey" PRIMARY KEY ("payment_id"),
    CONSTRAINT "compliance_submission_intents_request_identity_check" CHECK (
      "request_id" = "payment_id"
    ),
    CONSTRAINT "compliance_submission_intents_verified_evidence_check" CHECK (
      "state" = 'PENDING' OR (
        "sanctions_clear" IS NOT NULL AND
        "aml_risk_score" BETWEEN 0 AND 100 AND
        "travel_rule_compliant" IS NOT NULL AND
        "disposition" IS NOT NULL AND
        "investigation_hash" IS NOT NULL AND
        "attestation" IS NOT NULL AND
        "submission_tx_hash" IS NOT NULL AND
        "submission_block_number" IS NOT NULL AND
        "screened_by" IS NOT NULL AND
        "confirmations" IS NOT NULL AND
        "screening_duration" IS NOT NULL AND
        "verified_at" IS NOT NULL
      )
    ),
    CONSTRAINT "compliance_submission_intents_completed_at_check" CHECK (
      "state" <> 'COMPLETED' OR "completed_at" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "compliance_submission_intents_request_id_key"
ON "compliance_submission_intents"("request_id");

CREATE UNIQUE INDEX "compliance_submission_intents_submission_tx_hash_key"
ON "compliance_submission_intents"("submission_tx_hash");

CREATE INDEX "compliance_submission_intents_state_updated_at_idx"
ON "compliance_submission_intents"("state", "updated_at");

ALTER TABLE "compliance_submission_intents"
ADD CONSTRAINT "compliance_submission_intents_payment_id_fkey"
FOREIGN KEY ("payment_id") REFERENCES "payments"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
