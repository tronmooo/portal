-- Supabase advisors, 2026-09-17.
--
-- SECURITY (error): two one-off repair snapshots — trackers_name_backup_20260824
-- and rename_backup_bob_20260825 — were left in `public` with no RLS, which
-- is a PostgREST-exposed table any authenticated key can read. A third
-- (height_repair_backup_20260825) had RLS but no policy. Move all three into
-- the `backups` schema with the deny_all policy the July snapshots carry.
-- Nothing in the code reads them (migration 20260729 only mentions the name).
CREATE SCHEMA IF NOT EXISTS backups;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trackers_name_backup_20260824','rename_backup_bob_20260825','height_repair_backup_20260825'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA backups', t);
    END IF;
    IF to_regclass('backups.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE backups.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS deny_all ON backups.%I', t);
      EXECUTE format('CREATE POLICY deny_all ON backups.%I FOR ALL USING (false) WITH CHECK (false)', t);
      EXECUTE format('REVOKE ALL ON backups.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;

-- SECURITY (warn): trigger functions with a role-mutable search_path.
ALTER FUNCTION public.finance_touch_updated_at() SET search_path = public;
ALTER FUNCTION public.captures_set_updated_at() SET search_path = public;

-- PERFORMANCE (warn): 29 policies re-evaluate auth.uid() per row. The
-- `(select auth.uid())` form is evaluated once per statement — the same fix
-- migration 20260411 applied to the older tables.
ALTER POLICY captures_owner ON public.captures USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY finance_sync_runs_select_own ON public.finance_sync_runs USING (user_id = (select auth.uid()));
ALTER POLICY finance_sync_runs_delete_own ON public.finance_sync_runs USING (user_id = (select auth.uid()));
ALTER POLICY finance_sync_runs_insert_own ON public.finance_sync_runs WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY finance_sync_runs_update_own ON public.finance_sync_runs USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY financial_accounts_select_own ON public.financial_accounts USING (user_id = (select auth.uid()));
ALTER POLICY financial_accounts_delete_own ON public.financial_accounts USING (user_id = (select auth.uid()));
ALTER POLICY financial_accounts_insert_own ON public.financial_accounts WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY financial_accounts_update_own ON public.financial_accounts USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY financial_connections_select_own ON public.financial_connections USING (user_id = (select auth.uid()));
ALTER POLICY financial_connections_delete_own ON public.financial_connections USING (user_id = (select auth.uid()));
ALTER POLICY financial_connections_insert_own ON public.financial_connections WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY financial_connections_update_own ON public.financial_connections USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY financial_transaction_overrides_select_own ON public.financial_transaction_overrides USING (user_id = (select auth.uid()));
ALTER POLICY financial_transaction_overrides_delete_own ON public.financial_transaction_overrides USING (user_id = (select auth.uid()));
ALTER POLICY financial_transaction_overrides_insert_own ON public.financial_transaction_overrides WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY financial_transaction_overrides_update_own ON public.financial_transaction_overrides USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY financial_transactions_select_own ON public.financial_transactions USING (user_id = (select auth.uid()));
ALTER POLICY financial_transactions_delete_own ON public.financial_transactions USING (user_id = (select auth.uid()));
ALTER POLICY financial_transactions_insert_own ON public.financial_transactions WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY financial_transactions_update_own ON public.financial_transactions USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY financial_transfer_links_select_own ON public.financial_transfer_links USING (user_id = (select auth.uid()));
ALTER POLICY financial_transfer_links_delete_own ON public.financial_transfer_links USING (user_id = (select auth.uid()));
ALTER POLICY financial_transfer_links_insert_own ON public.financial_transfer_links WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY financial_transfer_links_update_own ON public.financial_transfer_links USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY stripe_account_holders_select_own ON public.stripe_account_holders USING (user_id = (select auth.uid()));
ALTER POLICY stripe_account_holders_delete_own ON public.stripe_account_holders USING (user_id = (select auth.uid()));
ALTER POLICY stripe_account_holders_insert_own ON public.stripe_account_holders WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY stripe_account_holders_update_own ON public.stripe_account_holders USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
