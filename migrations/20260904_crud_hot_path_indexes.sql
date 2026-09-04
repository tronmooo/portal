-- CRUD hot-path indexes
--
-- The client opens lists ordered by date/creation time and scopes every read
-- by user. These partial composite indexes let Postgres satisfy the filter and
-- ordering from one index while excluding soft-deleted rows.

CREATE INDEX IF NOT EXISTS expenses_user_live_date_idx
  ON public.expenses (user_id, date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS tasks_user_live_created_idx
  ON public.tasks (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS events_user_live_date_idx
  ON public.events (user_id, date DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS documents_user_live_created_idx
  ON public.documents (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS habit_checkins_user_date_idx
  ON public.habit_checkins (user_id, date);

-- Foreign-key covering indexes reported by the Supabase performance advisor.
CREATE INDEX IF NOT EXISTS captures_owner_profile_idx
  ON public.captures (owner_profile_id)
  WHERE owner_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS financial_overrides_subscription_profile_idx
  ON public.financial_transaction_overrides (linked_subscription_profile_id)
  WHERE linked_subscription_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS financial_overrides_liability_profile_idx
  ON public.financial_transaction_overrides (linked_liability_profile_id)
  WHERE linked_liability_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS financial_overrides_asset_profile_idx
  ON public.financial_transaction_overrides (linked_asset_profile_id)
  WHERE linked_asset_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS financial_overrides_profile_idx
  ON public.financial_transaction_overrides (linked_profile_id)
  WHERE linked_profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS financial_transfer_links_inflow_idx
  ON public.financial_transfer_links (inflow_transaction_id);
