-- Record accumulated pause time and on-chain linkage for payment streams.
--
-- total_paused_seconds fixes a balance defect, not just a missing field.
-- StreamingPayments subtracts accumulated pause time from both the elapsed time
-- and the total duration; the API subtracted neither, so a stream that had been
-- paused and resumed reported the whole pause interval as streamed. The API
-- would tell a recipient they had earned money the contract will not pay, and
-- the error compounds with each pause cycle. See docs/audit/NP-STREAM-01.
--
-- Defaulting to 0 is correct for every existing row: the methods that could
-- pause a stream were gated, so no stream has ever accumulated paused time.
ALTER TABLE "payment_streams"
  ADD COLUMN IF NOT EXISTS "total_paused_seconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "on_chain_stream_id"   TEXT,
  ADD COLUMN IF NOT EXISTS "create_tx_hash"       TEXT,
  ADD COLUMN IF NOT EXISTS "last_event_tx_hash"   TEXT;

CREATE INDEX IF NOT EXISTS "payment_streams_on_chain_stream_id_idx"
  ON "payment_streams" ("on_chain_stream_id");
