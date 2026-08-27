-- Record which on-chain proposal a treasury record settled, and the
-- transaction that settled it.
--
-- Treasury execution was previously unavailable because a database proposal and
-- a MultiSigTreasury proposal are separate objects with nothing linking them:
-- there was no column in which to state that this record corresponds to that
-- on-chain proposal, and no way to evidence the claim. Both columns are written
-- only after the execution transaction has been verified canonical — mined, not
-- reverted, past the configured confirmation depth, and still canonical on a
-- second read — so a non-null value means the settlement was checked rather
-- than asserted.
--
-- Nullable and additive: every existing row keeps its current meaning, and a
-- proposal that has not been executed on chain simply has no receipt.
ALTER TABLE "treasury_proposals"
  ADD COLUMN IF NOT EXISTS "on_chain_proposal_id" TEXT,
  ADD COLUMN IF NOT EXISTS "execution_tx_hash" TEXT;

-- Indexed to match the txHash precedent elsewhere in the schema: the lookup
-- that matters operationally is "which proposal did this transaction settle?",
-- asked when reconciling a chain event back to a record.
CREATE INDEX IF NOT EXISTS "treasury_proposals_execution_tx_hash_idx"
  ON "treasury_proposals" ("execution_tx_hash");
