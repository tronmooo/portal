-- Supabase advisors, 2026-09-18.
--
-- SECURITY (info) `rls_enabled_no_policy`: `response_cache` and
-- `finance_webhook_events` are written and read exclusively through the
-- service role (server/supabase-storage.ts, server/finance-routes.ts — no
-- client code touches either). Both had RLS on with zero policies, which
-- already denies anon/authenticated, but the table still carried the
-- schema-default GRANTs to those roles, so the deny rested on RLS alone.
--
-- Make the intent explicit and add the second lock: an always-false policy
-- plus revoked grants, the same shape migration 20260917 gave the `backups`
-- schema. The service role bypasses both, so server behaviour is unchanged.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['response_cache','finance_webhook_events'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS deny_all ON public.%I', t);
      EXECUTE format('CREATE POLICY deny_all ON public.%I FOR ALL USING (false) WITH CHECK (false)', t);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;
