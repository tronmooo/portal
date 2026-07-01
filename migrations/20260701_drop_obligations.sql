-- Retire Obligations → Type-Aware Liabilities (Phase 2: drop the tables)
--
-- RUN ONLY AFTER the new application code is deployed. The retired code path no
-- longer queries obligations / obligation_occurrences / obligation_payments —
-- recurring bills are projected from recurring-family liability profiles and
-- their payments live in liability_payments (moved by the Phase 1 backfill).
--
-- Prerequisites verified before running:
--   • Phase 1 backfill reconciled: every active obligation's linked liability is
--     typed, and all obligation_payments rows exist in liability_payments.
--   • No server code references the obligations tables (obligation-engine is an
--     inert stub; storage/routes read liabilities + liability_payments).

-- Drop the external FK'd column first so the table drop doesn't fail.
ALTER TABLE profiles DROP COLUMN IF EXISTS linked_obligation_id;

-- Child tables first (FKs), then the parent.
DROP TABLE IF EXISTS obligation_occurrences;
DROP TABLE IF EXISTS obligation_payments;
DROP TABLE IF EXISTS obligations;
