-- Migration 20260905: connected accounts are Asset Profiles
--
-- Every connected financial account is reconciled to (or given) an account
-- PROFILE after each sync — see server/financial-asset-sync.ts. When the user
-- deletes that profile, the FK on matched_profile_id goes to NULL and the next
-- sync would recreate it. This column remembers the deliberate unlink so the
-- sync leaves the account without a profile until the user links one again.
--
-- IDEMPOTENT: safe to re-run.

ALTER TABLE financial_accounts
  ADD COLUMN IF NOT EXISTS profile_unlinked_at timestamptz;

COMMENT ON COLUMN financial_accounts.profile_unlinked_at IS
  'Set when the user deleted or unlinked the account''s profile; the sync must not auto-create another while set.';
