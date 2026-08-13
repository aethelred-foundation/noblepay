-- Link AI decisions, overrides and appeals to their AIComplianceModule records.
--
-- Note what these columns do and do not mean. An on-chain decision is an entry
-- an AI_OPERATOR_ROLE holder asserted; recordDecision verifies no attestation
-- and never reads the evidenceHash it stores. The linkage makes the appeal and
-- override lifecycle verifiable and tamper-evident; it does not make the
-- underlying decision provable. See docs/audit/NP-AI-01.
--
-- review_tx_hash and review_started_at exist because the contract requires an
-- appeal to reach UNDER_REVIEW before it can be resolved, and the API had no
-- step for it — appeals would have jumped straight to a final outcome with no
-- record of who took up the review.
ALTER TABLE "ai_decisions"
  ADD COLUMN IF NOT EXISTS "on_chain_decision_id" TEXT,
  ADD COLUMN IF NOT EXISTS "on_chain_override_id" TEXT,
  ADD COLUMN IF NOT EXISTS "override_tx_hash"     TEXT;

ALTER TABLE "ai_appeals"
  ADD COLUMN IF NOT EXISTS "on_chain_appeal_id" TEXT,
  ADD COLUMN IF NOT EXISTS "filed_tx_hash"      TEXT,
  ADD COLUMN IF NOT EXISTS "review_tx_hash"     TEXT,
  ADD COLUMN IF NOT EXISTS "resolved_tx_hash"   TEXT,
  ADD COLUMN IF NOT EXISTS "review_started_at"  TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ai_decisions_on_chain_decision_id_idx"
  ON "ai_decisions" ("on_chain_decision_id");

CREATE INDEX IF NOT EXISTS "ai_appeals_on_chain_appeal_id_idx"
  ON "ai_appeals" ("on_chain_appeal_id");
