-- PROPOSED — NOT APPLIED. Needs owner review before it is run on production.
--
-- Security review 2026-11-12, finding 2. The Stripe link tables carry ids the
-- server (service role) follows to Stripe: which customer a connection belongs
-- to, which Stripe account a row is. The 20260805 migration gave `authenticated`
-- INSERT / UPDATE / DELETE-own on them, so the row's owner can rewrite those
-- ids through PostgREST with the public anon key and their own JWT.
--
-- The server now refuses to follow a holder id that does not map to the caller
-- (server/finance-sync.ts), which closes the read path. This migration removes
-- the cause: the app never writes these tables from the browser — every write
-- goes through the Express API with the service role, which bypasses RLS — so
-- client write policies have no legitimate user.
--
-- Reversible: re-run section 9 of 20260805_stripe_financial_connections.sql.
-- Before applying, confirm no client code writes these tables directly
-- (`grep -rn "from(\"financial_\|from(\"stripe_account" client/` is empty today).

DO $$
DECLARE
  t text;
  op text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stripe_account_holders', 'financial_connections', 'financial_accounts'] LOOP
    FOREACH op IN ARRAY ARRAY['insert', 'update', 'delete'] LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_' || op || '_own', t);
    END LOOP;
  END LOOP;
END $$;

-- The same hazard on documents.storage_path is closed in the server
-- (shared/owned-storage-path.ts); a column-level guard would be:
--   REVOKE UPDATE (storage_path) ON public.documents FROM authenticated;
-- left out here because column grants interact with the table-level grant
-- Supabase creates by default and should be tested on a branch first.
