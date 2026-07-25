-- NoblePay never had an authenticated heartbeat/attestation writer for this
-- table. Preserve any historical rows for incident analysis, but quarantine
-- them under an explicitly untrusted legacy name so application code cannot
-- mistake them for live production verifier evidence. External service health
-- and per-submission on-chain evidence are verified directly instead.
ALTER TABLE "tee_nodes" RENAME TO "legacy_tee_nodes_untrusted";
ALTER TYPE "TEENodeStatus" RENAME TO "LegacyTEENodeStatus";
COMMENT ON TABLE "legacy_tee_nodes_untrusted" IS
  'Untrusted historical rows; no authenticated writer existed. Never use as live verifier evidence.';
