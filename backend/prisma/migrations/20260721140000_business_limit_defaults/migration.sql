-- Keep database-level defaults aligned with the STANDARD tier enforced by
-- BusinessRegistry and the Prisma model. Explicit per-tier reconciliation can
-- still replace these values after a confirmed on-chain tier change.
ALTER TABLE "businesses"
  ALTER COLUMN "daily_limit" SET DEFAULT 50000,
  ALTER COLUMN "monthly_limit" SET DEFAULT 500000;
