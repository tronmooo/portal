-- Portol: Zero-trust RLS hardening (Wave 1B audit follow-up)
-- Closes RLS gaps identified in /home/user/workspace/portol_security_audit.md
-- Idempotent: safe to re-run.
-- Project: uvaniovwrezzzlzmizyg

-- ============================================================
-- 1. audit_log: enforce append-only (deny UPDATE + DELETE)
-- ============================================================
DROP POLICY IF EXISTS "audit_log_no_update" ON public.audit_log;
DROP POLICY IF EXISTS "audit_log_no_delete" ON public.audit_log;

CREATE POLICY "audit_log_no_update" ON public.audit_log
  FOR UPDATE TO public
  USING (false) WITH CHECK (false);

CREATE POLICY "audit_log_no_delete" ON public.audit_log
  FOR DELETE TO public
  USING (false);

-- ============================================================
-- 2. profile_type_definitions: deny all writes (read-only enum)
-- ============================================================
DROP POLICY IF EXISTS "ptd_no_insert" ON public.profile_type_definitions;
DROP POLICY IF EXISTS "ptd_no_update" ON public.profile_type_definitions;
DROP POLICY IF EXISTS "ptd_no_delete" ON public.profile_type_definitions;

CREATE POLICY "ptd_no_insert" ON public.profile_type_definitions
  FOR INSERT TO public
  WITH CHECK (false);

CREATE POLICY "ptd_no_update" ON public.profile_type_definitions
  FOR UPDATE TO public
  USING (false) WITH CHECK (false);

CREATE POLICY "ptd_no_delete" ON public.profile_type_definitions
  FOR DELETE TO public
  USING (false);

-- ============================================================
-- 3. cashflow_projections: scope service policy to service_role only
-- ============================================================
DROP POLICY IF EXISTS "cashflow_projections_service" ON public.cashflow_projections;

CREATE POLICY "cashflow_projections_service" ON public.cashflow_projections
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================================
-- 4. loan_amortization: scope service policy to service_role only
-- ============================================================
DROP POLICY IF EXISTS "loan_amortization_service" ON public.loan_amortization;

CREATE POLICY "loan_amortization_service" ON public.loan_amortization
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================================
-- 5. paychecks: scope service policy to service_role only
-- ============================================================
DROP POLICY IF EXISTS "paychecks_service" ON public.paychecks;

CREATE POLICY "paychecks_service" ON public.paychecks
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================================
-- 6. extraction_corrections: add explicit WITH CHECK for INSERT path
-- ============================================================
DROP POLICY IF EXISTS "extraction_corrections_user" ON public.extraction_corrections;

CREATE POLICY "extraction_corrections_user" ON public.extraction_corrections
  FOR ALL TO public
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- 7. chat_artifacts: ensure RLS + per-user CRUD policies (idempotent)
-- ============================================================
ALTER TABLE public.chat_artifacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chat_artifacts_select" ON public.chat_artifacts;
DROP POLICY IF EXISTS "chat_artifacts_insert" ON public.chat_artifacts;
DROP POLICY IF EXISTS "chat_artifacts_update" ON public.chat_artifacts;
DROP POLICY IF EXISTS "chat_artifacts_delete" ON public.chat_artifacts;

CREATE POLICY "chat_artifacts_select" ON public.chat_artifacts
  FOR SELECT TO public
  USING (auth.uid() = user_id);

CREATE POLICY "chat_artifacts_insert" ON public.chat_artifacts
  FOR INSERT TO public
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "chat_artifacts_update" ON public.chat_artifacts
  FOR UPDATE TO public
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "chat_artifacts_delete" ON public.chat_artifacts
  FOR DELETE TO public
  USING (auth.uid() = user_id);

-- ============================================================
-- 8. storage.objects (documents bucket): drop duplicate {public} policies
-- and add a {authenticated} DELETE policy.
-- ============================================================
DROP POLICY IF EXISTS "Users can upload own documents" ON storage.objects;
DROP POLICY IF EXISTS "Users can view own documents" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own documents" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own documents (authenticated)" ON storage.objects;

CREATE POLICY "Users can delete own documents (authenticated)" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'documents'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- ============================================================
-- 9. documents table: backfill missing columns referenced by code
-- ============================================================
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_documents_deleted_at
  ON public.documents(user_id, deleted_at)
  WHERE deleted_at IS NULL;
