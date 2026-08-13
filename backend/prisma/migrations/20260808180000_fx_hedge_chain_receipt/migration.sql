-- Link an FX hedge to the FXHedgingVault position it mirrors, and preserve the
-- two contract values the legacy enums cannot express.
--
-- HedgeType has no OPTION_CALL/OPTION_PUT distinction, and HedgeStatus has no
-- LIQUIDATED or EMERGENCY_UNWOUND. Without these columns a forced liquidation
-- would be stored as an ordinary CLOSED, which is the one thing about a
-- position an auditor is most likely to ask after. See docs/audit/NP-FX-01.
--
-- All columns are nullable and stay NULL for rows predating on-chain linkage:
-- nothing verified those, and backfilling a guess would be worse than a gap.
ALTER TABLE "fx_hedges"
  ADD COLUMN IF NOT EXISTS "on_chain_position_id" TEXT,
  ADD COLUMN IF NOT EXISTS "open_tx_hash"         TEXT,
  ADD COLUMN IF NOT EXISTS "close_tx_hash"        TEXT,
  ADD COLUMN IF NOT EXISTS "on_chain_hedge_type"  TEXT,
  ADD COLUMN IF NOT EXISTS "on_chain_status"      TEXT;

CREATE INDEX IF NOT EXISTS "fx_hedges_on_chain_position_id_idx"
  ON "fx_hedges" ("on_chain_position_id");

CREATE INDEX IF NOT EXISTS "fx_hedges_on_chain_status_idx"
  ON "fx_hedges" ("on_chain_status");
