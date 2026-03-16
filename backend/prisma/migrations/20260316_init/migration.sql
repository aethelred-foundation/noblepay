-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SCREENING', 'APPROVED', 'SETTLED', 'CANCELLED', 'REFUNDED', 'FLAGGED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED', 'UNDER_REVIEW', 'ESCALATED');

-- CreateEnum
CREATE TYPE "KYCStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "BusinessTier" AS ENUM ('STARTER', 'STANDARD', 'ENTERPRISE', 'INSTITUTIONAL');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('PAYMENT_CREATED', 'PAYMENT_SCREENED', 'PAYMENT_APPROVED', 'PAYMENT_SETTLED', 'PAYMENT_CANCELLED', 'PAYMENT_REFUNDED', 'PAYMENT_FLAGGED', 'COMPLIANCE_SCREENING', 'COMPLIANCE_PASSED', 'COMPLIANCE_FAILED', 'COMPLIANCE_ESCALATED', 'BUSINESS_REGISTERED', 'BUSINESS_VERIFIED', 'BUSINESS_SUSPENDED', 'BUSINESS_UPGRADED', 'SANCTIONS_UPDATED', 'TEE_ATTESTATION', 'API_KEY_CREATED', 'API_KEY_REVOKED', 'SYSTEM_EVENT');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TEENodeStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DEREGISTERED', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "APIKeyStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'EXECUTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProposalType" AS ENUM ('TRANSFER', 'POLICY_CHANGE', 'YIELD_ALLOCATION', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "StreamStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HedgeType" AS ENUM ('FORWARD', 'OPTION', 'SWAP');

-- CreateEnum
CREATE TYPE "HedgeStatus" AS ENUM ('OPEN', 'CLOSED', 'EXPIRED', 'EXERCISED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'FINANCED', 'SETTLED', 'OVERDUE', 'DISPUTED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('INITIATED', 'RELAYING', 'CONFIRMING', 'COMPLETED', 'FAILED', 'STUCK', 'RECOVERED');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('DRAFT', 'GENERATED', 'SUBMITTED', 'ACKNOWLEDGED', 'REJECTED_BY_REGULATOR');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

-- CreateTable
CREATE TABLE "businesses" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "license_number" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "business_type" TEXT NOT NULL,
    "kyc_status" "KYCStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "tier" "BusinessTier" NOT NULL DEFAULT 'STARTER',
    "compliance_officer" TEXT,
    "contact_email" TEXT NOT NULL,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_verified" TIMESTAMP(3),
    "daily_limit" DECIMAL(36,18) NOT NULL DEFAULT 10000,
    "monthly_limit" DECIMAL(36,18) NOT NULL DEFAULT 100000,

    CONSTRAINT "businesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "currency" TEXT NOT NULL,
    "purpose_hash" TEXT,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "risk_score" INTEGER,
    "tee_attestation" TEXT,
    "initiated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "screened_at" TIMESTAMP(3),
    "settled_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "block_number" BIGINT,
    "tx_hash" TEXT,
    "business_id" TEXT NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_screenings" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "sanctions_clear" BOOLEAN NOT NULL,
    "aml_risk_score" INTEGER NOT NULL,
    "travel_rule_compliant" BOOLEAN NOT NULL,
    "status" "ComplianceStatus" NOT NULL DEFAULT 'PENDING',
    "flag_reason" TEXT,
    "investigation_hash" TEXT,
    "screened_by" TEXT NOT NULL,
    "screening_duration" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_screenings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" "EventType" NOT NULL,
    "actor" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "Severity" NOT NULL DEFAULT 'INFO',
    "block_number" BIGINT,
    "tx_hash" TEXT,
    "previous_hash" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_rule_records" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "originator_hash" TEXT NOT NULL,
    "beneficiary_hash" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "currency" TEXT NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "shared_with" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "travel_rule_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tee_nodes" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "status" "TEENodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_heartbeat" TIMESTAMP(3),
    "attestation_valid" BOOLEAN NOT NULL DEFAULT false,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tee_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "last_used" TIMESTAMP(3),
    "status" "APIKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_proposals" (
    "id" TEXT NOT NULL,
    "type" "ProposalType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(36,18),
    "currency" TEXT,
    "recipient" TEXT,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING',
    "required_sigs" INTEGER NOT NULL,
    "current_sigs" INTEGER NOT NULL DEFAULT 0,
    "signers" TEXT[],
    "approved_by" TEXT[],
    "timelock_until" TIMESTAMP(3),
    "executed_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "treasury_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spending_policies" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "daily_limit" DECIMAL(36,18) NOT NULL,
    "monthly_limit" DECIMAL(36,18) NOT NULL,
    "requires_multi_sig" BOOLEAN NOT NULL DEFAULT false,
    "approval_threshold" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spending_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "yield_strategies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "apy" DECIMAL(10,4) NOT NULL,
    "allocated_amount" DECIMAL(36,18) NOT NULL,
    "currency" TEXT NOT NULL,
    "risk_level" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_harvest_at" TIMESTAMP(3),
    "total_yield_earned" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "yield_strategies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidity_pools" (
    "id" TEXT NOT NULL,
    "token_a" TEXT NOT NULL,
    "token_b" TEXT NOT NULL,
    "reserve_a" DECIMAL(36,18) NOT NULL,
    "reserve_b" DECIMAL(36,18) NOT NULL,
    "total_liquidity" DECIMAL(36,18) NOT NULL,
    "fee_rate" DECIMAL(10,6) NOT NULL,
    "volume_24h" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "fees_collected" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "liquidity_pools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lp_positions" (
    "id" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "liquidity" DECIMAL(36,18) NOT NULL,
    "lower_tick" INTEGER NOT NULL,
    "upper_tick" INTEGER NOT NULL,
    "fees_earned" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lp_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_streams" (
    "id" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "total_amount" DECIMAL(36,18) NOT NULL,
    "rate_per_second" DECIMAL(36,18) NOT NULL,
    "currency" TEXT NOT NULL,
    "start_time" TIMESTAMP(3) NOT NULL,
    "end_time" TIMESTAMP(3) NOT NULL,
    "cliff_end" TIMESTAMP(3),
    "withdrawn" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "status" "StreamStatus" NOT NULL DEFAULT 'ACTIVE',
    "purpose" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paused_at" TIMESTAMP(3),

    CONSTRAINT "payment_streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_hedges" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "type" "HedgeType" NOT NULL,
    "base_currency" TEXT NOT NULL,
    "quote_currency" TEXT NOT NULL,
    "notional" DECIMAL(36,18) NOT NULL,
    "strike_rate" DECIMAL(18,8) NOT NULL,
    "spot_rate" DECIMAL(18,8) NOT NULL,
    "premium" DECIMAL(36,18),
    "maturity_date" TIMESTAMP(3) NOT NULL,
    "status" "HedgeStatus" NOT NULL DEFAULT 'OPEN',
    "pnl" DECIMAL(36,18),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "fx_hedges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "debtor" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "currency" TEXT NOT NULL,
    "issue_date" TIMESTAMP(3) NOT NULL,
    "due_date" TIMESTAMP(3) NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "financed_amount" DECIMAL(36,18),
    "discount_rate" DECIMAL(10,4),
    "credit_score" TEXT,
    "settled_at" TIMESTAMP(3),
    "dispute_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_scores" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "grade" TEXT NOT NULL,
    "payment_history" DECIMAL(5,2) NOT NULL,
    "avg_days_late" DECIMAL(10,2) NOT NULL,
    "default_rate" DECIMAL(5,4) NOT NULL,
    "total_invoices" INTEGER NOT NULL,
    "last_updated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crosschain_transfers" (
    "id" TEXT NOT NULL,
    "source_chain" TEXT NOT NULL,
    "dest_chain" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'INITIATED',
    "source_tx_hash" TEXT,
    "dest_tx_hash" TEXT,
    "relay_node" TEXT,
    "bridge_fee" DECIMAL(36,18),
    "estimated_time_secs" INTEGER,
    "initiated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "crosschain_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relay_nodes" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chains" TEXT[],
    "stake" DECIMAL(36,18) NOT NULL,
    "success_rate" DECIMAL(5,4) NOT NULL,
    "avg_latency_ms" INTEGER NOT NULL,
    "total_relayed" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relay_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_reports" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "report_type" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'DRAFT',
    "content_hash" TEXT,
    "submitted_at" TIMESTAMP(3),
    "submitted_by" TEXT,
    "regulator_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "regulatory_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_decisions" (
    "id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "model_version" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "risk_score" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "overridden_by" TEXT,
    "override_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_model_registry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "accuracy" DECIMAL(5,4) NOT NULL,
    "precision" DECIMAL(5,4) NOT NULL,
    "recall" DECIMAL(5,4) NOT NULL,
    "f1_score" DECIMAL(5,4) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_trained" TIMESTAMP(3) NOT NULL,
    "total_decisions" INTEGER NOT NULL DEFAULT 0,
    "deployed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_model_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "AlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "entity_id" TEXT,
    "acknowledged_by" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "businesses_address_key" ON "businesses"("address");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_license_number_key" ON "businesses"("license_number");

-- CreateIndex
CREATE UNIQUE INDEX "payments_payment_id_key" ON "payments"("payment_id");

-- CreateIndex
CREATE INDEX "payments_sender_idx" ON "payments"("sender");

-- CreateIndex
CREATE INDEX "payments_recipient_idx" ON "payments"("recipient");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX "payments_initiated_at_idx" ON "payments"("initiated_at");

-- CreateIndex
CREATE INDEX "payments_business_id_idx" ON "payments"("business_id");

-- CreateIndex
CREATE INDEX "compliance_screenings_payment_id_idx" ON "compliance_screenings"("payment_id");

-- CreateIndex
CREATE INDEX "compliance_screenings_status_idx" ON "compliance_screenings"("status");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_event_id_key" ON "audit_logs"("event_id");

-- CreateIndex
CREATE INDEX "audit_logs_event_type_idx" ON "audit_logs"("event_type");

-- CreateIndex
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs"("actor");

-- CreateIndex
CREATE INDEX "audit_logs_severity_idx" ON "audit_logs"("severity");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "travel_rule_records_payment_id_key" ON "travel_rule_records"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "tee_nodes_address_key" ON "tee_nodes"("address");

-- CreateIndex
CREATE INDEX "tee_nodes_status_idx" ON "tee_nodes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_business_id_idx" ON "api_keys"("business_id");

-- CreateIndex
CREATE INDEX "treasury_proposals_status_idx" ON "treasury_proposals"("status");

-- CreateIndex
CREATE INDEX "treasury_proposals_created_by_idx" ON "treasury_proposals"("created_by");

-- CreateIndex
CREATE INDEX "treasury_proposals_business_id_idx" ON "treasury_proposals"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX "liquidity_pools_token_a_token_b_key" ON "liquidity_pools"("token_a", "token_b");

-- CreateIndex
CREATE INDEX "lp_positions_pool_id_idx" ON "lp_positions"("pool_id");

-- CreateIndex
CREATE INDEX "lp_positions_provider_idx" ON "lp_positions"("provider");

-- CreateIndex
CREATE INDEX "payment_streams_sender_idx" ON "payment_streams"("sender");

-- CreateIndex
CREATE INDEX "payment_streams_recipient_idx" ON "payment_streams"("recipient");

-- CreateIndex
CREATE INDEX "payment_streams_status_idx" ON "payment_streams"("status");

-- CreateIndex
CREATE INDEX "fx_hedges_business_id_idx" ON "fx_hedges"("business_id");

-- CreateIndex
CREATE INDEX "fx_hedges_status_idx" ON "fx_hedges"("status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_number_key" ON "invoices"("invoice_number");

-- CreateIndex
CREATE INDEX "invoices_issuer_idx" ON "invoices"("issuer");

-- CreateIndex
CREATE INDEX "invoices_debtor_idx" ON "invoices"("debtor");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "invoices_due_date_idx" ON "invoices"("due_date");

-- CreateIndex
CREATE UNIQUE INDEX "credit_scores_business_id_key" ON "credit_scores"("business_id");

-- CreateIndex
CREATE INDEX "crosschain_transfers_source_chain_dest_chain_idx" ON "crosschain_transfers"("source_chain", "dest_chain");

-- CreateIndex
CREATE INDEX "crosschain_transfers_sender_idx" ON "crosschain_transfers"("sender");

-- CreateIndex
CREATE INDEX "crosschain_transfers_status_idx" ON "crosschain_transfers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "relay_nodes_address_key" ON "relay_nodes"("address");

-- CreateIndex
CREATE INDEX "regulatory_reports_business_id_idx" ON "regulatory_reports"("business_id");

-- CreateIndex
CREATE INDEX "regulatory_reports_jurisdiction_idx" ON "regulatory_reports"("jurisdiction");

-- CreateIndex
CREATE INDEX "regulatory_reports_status_idx" ON "regulatory_reports"("status");

-- CreateIndex
CREATE INDEX "ai_decisions_model_id_idx" ON "ai_decisions"("model_id");

-- CreateIndex
CREATE INDEX "ai_decisions_payment_id_idx" ON "ai_decisions"("payment_id");

-- CreateIndex
CREATE INDEX "ai_decisions_escalated_idx" ON "ai_decisions"("escalated");

-- CreateIndex
CREATE UNIQUE INDEX "ai_model_registry_name_key" ON "ai_model_registry"("name");

-- CreateIndex
CREATE INDEX "alerts_severity_idx" ON "alerts"("severity");

-- CreateIndex
CREATE INDEX "alerts_status_idx" ON "alerts"("status");

-- CreateIndex
CREATE INDEX "alerts_type_idx" ON "alerts"("type");

-- CreateIndex
CREATE INDEX "alerts_created_at_idx" ON "alerts"("created_at");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_screenings" ADD CONSTRAINT "compliance_screenings_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("payment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_rule_records" ADD CONSTRAINT "travel_rule_records_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("payment_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lp_positions" ADD CONSTRAINT "lp_positions_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "liquidity_pools"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

