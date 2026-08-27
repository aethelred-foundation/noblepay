-- Align the persisted enum with BusinessRegistry.BusinessTier.
-- Legacy values are mapped by their configured limits, preserving entitlement:
-- STARTER/STANDARD -> STANDARD, ENTERPRISE -> PREMIUM, INSTITUTIONAL -> ENTERPRISE.
CREATE TYPE "BusinessTier_contract" AS ENUM ('STANDARD', 'PREMIUM', 'ENTERPRISE');

ALTER TABLE "businesses" ALTER COLUMN "tier" DROP DEFAULT;
ALTER TABLE "businesses"
  ALTER COLUMN "tier" TYPE "BusinessTier_contract"
  USING (
    CASE "tier"::text
      WHEN 'STARTER' THEN 'STANDARD'
      WHEN 'STANDARD' THEN 'STANDARD'
      WHEN 'ENTERPRISE' THEN 'PREMIUM'
      WHEN 'INSTITUTIONAL' THEN 'ENTERPRISE'
    END
  )::"BusinessTier_contract";

DROP TYPE "BusinessTier";
ALTER TYPE "BusinessTier_contract" RENAME TO "BusinessTier";
ALTER TABLE "businesses" ALTER COLUMN "tier" SET DEFAULT 'STANDARD';

UPDATE "businesses"
SET
  "daily_limit" = CASE "tier"
    WHEN 'STANDARD' THEN 50000
    WHEN 'PREMIUM' THEN 500000
    WHEN 'ENTERPRISE' THEN 5000000
  END,
  "monthly_limit" = CASE "tier"
    WHEN 'STANDARD' THEN 500000
    WHEN 'PREMIUM' THEN 5000000
    WHEN 'ENTERPRISE' THEN 50000000
  END;
