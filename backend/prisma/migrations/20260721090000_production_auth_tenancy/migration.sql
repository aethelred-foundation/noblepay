-- Persist wallet-signature challenges, payment idempotency, and tenant-scoped
-- tamper-evident audit chains.

ALTER TABLE "payments"
ADD COLUMN "idempotency_key" TEXT;

ALTER TABLE "businesses"
ADD COLUMN "registration_tx_hash" TEXT,
ADD COLUMN "registration_block_number" BIGINT;

CREATE UNIQUE INDEX "businesses_registration_tx_hash_key"
ON "businesses"("registration_tx_hash");

CREATE UNIQUE INDEX "payments_business_id_idempotency_key_key"
ON "payments"("business_id", "idempotency_key");

CREATE INDEX "payments_tx_hash_idx" ON "payments"("tx_hash");

ALTER TABLE "audit_logs"
ADD COLUMN "business_id" TEXT,
ADD COLUMN "entry_hash" TEXT;

-- Preserve deployed audit rows while moving to the explicit entry hash. New
-- writes compute a canonical content hash in the application.
UPDATE "audit_logs"
SET "entry_hash" = "event_id"
WHERE "entry_hash" IS NULL;

ALTER TABLE "audit_logs"
ALTER COLUMN "entry_hash" SET NOT NULL;

CREATE UNIQUE INDEX "audit_logs_entry_hash_key" ON "audit_logs"("entry_hash");
CREATE INDEX "audit_logs_business_id_created_at_idx" ON "audit_logs"("business_id", "created_at");

ALTER TABLE "audit_logs"
ADD CONSTRAINT "audit_logs_business_id_fkey"
FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TYPE "WalletChallengePurpose" AS ENUM ('AUTHENTICATION', 'REGISTRATION');

CREATE TABLE "wallet_challenges" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "purpose" "WalletChallengePurpose" NOT NULL DEFAULT 'AUTHENTICATION',
    "transaction_hash" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_challenges_nonce_key" ON "wallet_challenges"("nonce");
CREATE INDEX "wallet_challenges_address_created_at_idx" ON "wallet_challenges"("address", "created_at");
CREATE INDEX "wallet_challenges_expires_at_idx" ON "wallet_challenges"("expires_at");
CREATE INDEX "wallet_challenges_transaction_hash_idx" ON "wallet_challenges"("transaction_hash");
