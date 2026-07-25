-- PostgreSQL does not permit a newly added enum value to be referenced until
-- the transaction that adds it commits. Keep this value in its own Prisma
-- migration so the following Travel Rule constraints can safely use it even
-- when a deployment runner wraps each migration in a transaction.
ALTER TYPE "WalletChallengePurpose" ADD VALUE IF NOT EXISTS 'TRAVEL_RULE';
