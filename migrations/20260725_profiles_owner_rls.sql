-- Portol: explicit owner policy on profiles (UX audit 2026-07-25 follow-up)
--
-- 001_enable_rls.sql turns RLS ON for `profiles` but never adds a policy, so
-- the table is deny-by-default for anon/authenticated — safe, but only by
-- accident: the first person to add ANY permissive policy for a broad role
-- would open the table wide. This states the intent explicitly.
--
-- This changes nothing for the app today. The API connects with the
-- service-role key, which bypasses RLS; owner scoping is enforced in
-- server/supabase-storage.ts (guarded by tests/profile-owner-scope.test.ts).
-- The policies below matter if the anon/authenticated key is ever used to read
-- profiles directly from the client.
--
-- Idempotent: safe to re-run. Run in Supabase Dashboard > SQL Editor.

ALTER TABLE IF EXISTS public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_owner_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_owner_insert" ON public.profiles;
DROP POLICY IF EXISTS "profiles_owner_update" ON public.profiles;
DROP POLICY IF EXISTS "profiles_owner_delete" ON public.profiles;
DROP POLICY IF EXISTS "profiles_service" ON public.profiles;

CREATE POLICY "profiles_owner_select" ON public.profiles
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid())::text = user_id::text);

CREATE POLICY "profiles_owner_insert" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid())::text = user_id::text);

CREATE POLICY "profiles_owner_update" ON public.profiles
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid())::text = user_id::text)
  WITH CHECK ((SELECT auth.uid())::text = user_id::text);

CREATE POLICY "profiles_owner_delete" ON public.profiles
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid())::text = user_id::text);

-- The API's own connection. Explicit so the service path does not depend on
-- the RLS-bypass behaviour of the service-role key alone.
CREATE POLICY "profiles_service" ON public.profiles
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);
