-- Tie a transfer record to the CrossChainRouter transfer id it mirrors.
--
-- source_tx_hash and dest_tx_hash already existed, but nothing linked a row to
-- the bytes32 id the contract uses, so a TransferInitiated or TransferRecovered
-- receipt could not be matched back to a record. That is why bridge execution
-- was disabled.
--
-- The column is written only after the source-chain receipt has been verified
-- canonical against the operator-confirmed Aethelred anchor.
ALTER TABLE "crosschain_transfers"
  ADD COLUMN IF NOT EXISTS "on_chain_transfer_id" TEXT;

CREATE INDEX IF NOT EXISTS "crosschain_transfers_on_chain_transfer_id_idx"
  ON "crosschain_transfers" ("on_chain_transfer_id");
