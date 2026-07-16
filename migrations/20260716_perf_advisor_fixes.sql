-- PERF Phase 3.4 (PERF_PLAN_LAUNCH_2026-07-16.md): Supabase performance-advisor
-- fixes, checked against the live linter on 2026-07-16.
--
-- 1) auth_rls_initplan: `auth.uid()` in a policy is re-evaluated PER ROW;
--    wrapping it as `(select auth.uid())` makes Postgres evaluate it once per
--    statement (InitPlan). Identical semantics, faster at scale. Applies to
--    every flagged owner policy below.
-- 2) unindexed_foreign_keys: finance_imports.profile_id FK had no covering
--    index.
-- 3) multiple_permissive_policies: extraction_corrections had two identical
--    ALL policies ("Users can manage own corrections" + a later
--    extraction_corrections_user which also carries WITH CHECK); every query
--    evaluated both. Drop the older, weaker one.
--
-- All statements are behavior-preserving: same rows pass, same rows fail.

-- ── 1. InitPlan-wrapped owner policies ───────────────────────────────────────
ALTER POLICY ai_action_log_owner ON public.ai_action_log
  USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));

ALTER POLICY ai_bulk_plans_owner ON public.ai_bulk_plans
  USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));

ALTER POLICY cashflow_projections_user_policy ON public.cashflow_projections
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY chat_artifacts_select ON public.chat_artifacts
  USING ((select auth.uid()) = user_id);
ALTER POLICY chat_artifacts_insert ON public.chat_artifacts
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY chat_artifacts_update ON public.chat_artifacts
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY chat_artifacts_delete ON public.chat_artifacts
  USING ((select auth.uid()) = user_id);

ALTER POLICY extraction_corrections_user ON public.extraction_corrections
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY finance_imports_owner ON public.finance_imports
  USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));

ALTER POLICY loan_amortization_user_policy ON public.loan_amortization
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY snapshots_owner ON public.net_worth_snapshots
  USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));

ALTER POLICY paychecks_user_policy ON public.paychecks
  USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);

ALTER POLICY reminders_owner ON public.reminders
  USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));

ALTER POLICY undo_log_select_own ON public.undo_log
  USING (user_id = (select auth.uid()));
ALTER POLICY undo_log_insert_own ON public.undo_log
  WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY undo_log_update_own ON public.undo_log
  USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));
ALTER POLICY undo_log_delete_own ON public.undo_log
  USING (user_id = (select auth.uid()));

ALTER POLICY user_notifications_owner ON public.user_notifications
  USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));

-- ── 2. Covering index for the finance_imports.profile_id FK ────────────────
CREATE INDEX IF NOT EXISTS idx_finance_imports_profile_id
  ON public.finance_imports (profile_id);

-- ── 3. Drop the duplicate permissive policy ────────────────────────────────
DROP POLICY IF EXISTS "Users can manage own corrections" ON public.extraction_corrections;
