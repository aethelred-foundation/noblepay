-- Durable, tenant-scoped storage for request throttling and the advanced
-- reporting, invoice-financing, and AI-compliance services.

CREATE TABLE "rate_limit_windows" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_windows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rate_limit_windows_business_id_scope_window_start_key"
ON "rate_limit_windows"("business_id", "scope", "window_start");

CREATE INDEX "rate_limit_windows_expires_at_idx"
ON "rate_limit_windows"("expires_at");

ALTER TABLE "rate_limit_windows"
ADD CONSTRAINT "rate_limit_windows_business_id_fkey"
FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "public_rate_limit_windows" (
    "id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_rate_limit_windows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "public_rate_limit_windows_key_hash_scope_window_start_key"
ON "public_rate_limit_windows"("key_hash", "scope", "window_start");

CREATE INDEX "public_rate_limit_windows_expires_at_idx"
ON "public_rate_limit_windows"("expires_at");

ALTER TABLE "invoices"
ADD COLUMN "business_id" TEXT,
ADD COLUMN "debtor_name" TEXT NOT NULL DEFAULT '',
ADD COLUMN "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN "purchase_order_ref" TEXT,
ADD COLUMN "grace_period_days" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN "late_penalty_rate" DECIMAL(10,6) NOT NULL DEFAULT 0.015,
ADD COLUMN "settlement_reference" TEXT;

UPDATE "invoices"
SET "financed_amount" = 0
WHERE "financed_amount" IS NULL;

ALTER TABLE "invoices"
ALTER COLUMN "financed_amount" SET DEFAULT 0,
ALTER COLUMN "financed_amount" SET NOT NULL;

CREATE UNIQUE INDEX "invoices_settlement_reference_key"
ON "invoices"("settlement_reference");

CREATE INDEX "invoices_business_id_created_at_idx"
ON "invoices"("business_id", "created_at");

ALTER TABLE "invoices"
ADD CONSTRAINT "invoices_business_id_fkey"
FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "InvoiceFinancingStatus" AS ENUM (
  'PENDING', 'APPROVED', 'FUNDED', 'REPAID', 'DEFAULTED', 'REJECTED'
);

CREATE TYPE "InvoiceDisputeStatus" AS ENUM (
  'OPEN', 'UNDER_REVIEW', 'RESOLVED', 'ESCALATED'
);

CREATE TABLE "invoice_financing_requests" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "discount_rate" DECIMAL(10,6),
    "net_proceeds" DECIMAL(36,18),
    "factor" TEXT,
    "term_days" INTEGER NOT NULL,
    "status" "InvoiceFinancingStatus" NOT NULL DEFAULT 'PENDING',
    "external_reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_financing_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoice_financing_requests_external_reference_key"
ON "invoice_financing_requests"("external_reference");

CREATE UNIQUE INDEX "invoice_financing_requests_business_id_idempotency_key_key"
ON "invoice_financing_requests"("business_id", "idempotency_key");

CREATE INDEX "invoice_financing_requests_invoice_id_created_at_idx"
ON "invoice_financing_requests"("invoice_id", "created_at");

CREATE INDEX "invoice_financing_requests_business_id_status_idx"
ON "invoice_financing_requests"("business_id", "status");

ALTER TABLE "invoice_financing_requests"
ADD CONSTRAINT "invoice_financing_requests_invoice_id_fkey"
FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_financing_requests"
ADD CONSTRAINT "invoice_financing_requests_business_id_fkey"
FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "invoice_disputes" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "InvoiceDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "raised_by" TEXT NOT NULL,
    "reviewer" TEXT,
    "resolution" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "invoice_disputes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoice_disputes_invoice_id_created_at_idx"
ON "invoice_disputes"("invoice_id", "created_at");

CREATE INDEX "invoice_disputes_business_id_status_idx"
ON "invoice_disputes"("business_id", "status");

ALTER TABLE "invoice_disputes"
ADD CONSTRAINT "invoice_disputes_invoice_id_fkey"
FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice_disputes"
ADD CONSTRAINT "invoice_disputes_business_id_fkey"
FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "regulatory_reports"
ADD COLUMN "report_data" JSONB,
ADD COLUMN "summary" JSONB,
ADD COLUMN "generated_by" TEXT,
ADD COLUMN "notes" TEXT,
ADD COLUMN "file_size_bytes" INTEGER,
ADD COLUMN "generation_duration_ms" INTEGER,
ADD COLUMN "acknowledged_at" TIMESTAMP(3);

ALTER TABLE "ai_decisions"
ADD COLUMN "business_id" TEXT,
ADD COLUMN "engine_decision_id" TEXT,
ADD COLUMN "idempotency_key" TEXT,
ADD COLUMN "original_decision" TEXT,
ADD COLUMN "processing_time_ms" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "tee_attestation" TEXT,
ADD COLUMN "jurisdiction" TEXT,
ADD COLUMN "overridden_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "ai_decisions_engine_decision_id_key"
ON "ai_decisions"("engine_decision_id");

CREATE UNIQUE INDEX "ai_decisions_business_id_idempotency_key_key"
ON "ai_decisions"("business_id", "idempotency_key");

CREATE INDEX "ai_decisions_business_id_created_at_idx"
ON "ai_decisions"("business_id", "created_at");

ALTER TABLE "ai_decisions"
ADD CONSTRAINT "ai_decisions_business_id_fkey"
FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_model_registry"
ADD COLUMN "false_positive_rate" DECIMAL(5,4),
ADD COLUMN "false_negative_rate" DECIMAL(5,4),
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "tee_attested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "attestation_hash" TEXT,
ADD COLUMN "training_data_hash" TEXT,
ADD COLUMN "last_evaluated" TIMESTAMP(3),
ADD COLUMN "metadata" JSONB;

CREATE TYPE "AIAppealStatus" AS ENUM (
  'SUBMITTED', 'UNDER_REVIEW', 'UPHELD', 'OVERTURNED', 'DISMISSED'
);

CREATE TABLE "ai_appeals" (
    "id" TEXT NOT NULL,
    "decision_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "submitted_by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AIAppealStatus" NOT NULL DEFAULT 'SUBMITTED',
    "external_reference" TEXT NOT NULL,
    "reviewer" TEXT,
    "review_notes" TEXT,
    "original_outcome" TEXT NOT NULL,
    "final_outcome" TEXT,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "ai_appeals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_appeals_external_reference_key"
ON "ai_appeals"("external_reference");

CREATE UNIQUE INDEX "ai_appeals_business_id_decision_id_key"
ON "ai_appeals"("business_id", "decision_id");

CREATE INDEX "ai_appeals_business_id_status_submitted_at_idx"
ON "ai_appeals"("business_id", "status", "submitted_at");

ALTER TABLE "ai_appeals"
ADD CONSTRAINT "ai_appeals_business_id_fkey"
FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ai_appeals"
ADD CONSTRAINT "ai_appeals_decision_id_fkey"
FOREIGN KEY ("decision_id") REFERENCES "ai_decisions"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "compliance_screenings"
ADD COLUMN "attestation" TEXT,
ADD COLUMN "engine_request_id" TEXT,
ADD COLUMN "submission_tx_hash" TEXT,
ADD COLUMN "submission_block_number" BIGINT;

CREATE UNIQUE INDEX "compliance_screenings_submission_tx_hash_key"
ON "compliance_screenings"("submission_tx_hash");

CREATE INDEX "compliance_screenings_engine_request_id_idx"
ON "compliance_screenings"("engine_request_id");
