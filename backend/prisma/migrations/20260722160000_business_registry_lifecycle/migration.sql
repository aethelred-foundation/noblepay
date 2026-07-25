-- Preserve the exact irreversible BusinessRegistry lifecycle in the database
-- mirror instead of collapsing on-chain revocation into a reversible status.
ALTER TYPE "KYCStatus" ADD VALUE IF NOT EXISTS 'REVOKED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'BUSINESS_REINSTATED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'BUSINESS_REVOKED';
