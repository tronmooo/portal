-- Migration 20260626: Finance imports ("Import from ChatGPT")
--
-- Backs the import history + undo for the "Import from ChatGPT" feature. One row
-- per committed import batch. We do NOT store the raw payload here (it can be
-- large and may contain sensitive figures the user only wanted transformed into
-- typed rows); we store the summary and the ids of the rows the batch created so
-- the import can be undone cleanly.
--
-- IDEMPOTENT: safe to re-run.

CREATE TABLE IF NOT EXISTS finance_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The single profile this batch was scoped to (product decision: imports go
  -- to one selected profile; nothing is cross-assigned).
  profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,

  -- committed | undone
  status text NOT NULL DEFAULT 'committed'
    CHECK (status IN ('committed', 'undone')),

  -- { created, duplicates, updated, skipped, warnings, bySection } — the review
  -- screen / history list render from this.
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Number of rows actually written by this batch.
  record_count integer NOT NULL DEFAULT 0,

  -- Ids of every row the batch created, by kind, so undo can reverse it:
  -- { "expenses":[...], "obligations":[...], "incomes":[...], "profiles":[...],
  --   "budgets":[{ "month":"YYYY-MM", "id":"..." }] }
  created_records jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);

-- History view: most recent first, scoped to user.
CREATE INDEX IF NOT EXISTS finance_imports_user_created_idx
  ON finance_imports(user_id, created_at DESC);

-- RLS: mirror the user_id = auth.uid() pattern used by every other table so an
-- import batch can never leak across users.
ALTER TABLE finance_imports ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'finance_imports' AND policyname = 'finance_imports_owner'
  ) THEN
    CREATE POLICY finance_imports_owner ON finance_imports
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
