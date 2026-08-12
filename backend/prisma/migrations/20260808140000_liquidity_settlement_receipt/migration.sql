-- Record which on-chain position an LP record mirrors, and the transaction
-- that settled it.
--
-- Liquidity mutations were disabled because a database position and a
-- LiquidityPool position are separate objects: on-chain position ids are
-- hash-derived and bear no relation to this table's uuid primary key, so there
-- was no column in which to state the correspondence and no way to evidence it.
-- Both are written only after the settlement transaction has been verified
-- canonical, so a non-null value means the settlement was checked rather than
-- asserted.
--
-- Nullable and additive: existing rows keep their current meaning, and a
-- position with no on-chain settlement simply has no receipt.
ALTER TABLE "lp_positions"
  ADD COLUMN IF NOT EXISTS "on_chain_position_id" TEXT,
  ADD COLUMN IF NOT EXISTS "settlement_tx_hash" TEXT;

CREATE INDEX IF NOT EXISTS "lp_positions_settlement_tx_hash_idx"
  ON "lp_positions" ("settlement_tx_hash");
