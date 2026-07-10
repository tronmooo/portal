-- Migration 20260711: AI bulk-action plans (preview → confirm → execute)
--
-- Destructive bulk chat operations are two-phase: preview_bulk_action stores
-- a plan row (criteria + hash over the affected ids + human preview), the
-- user confirms in the next turn, and execute_bulk_action re-derives the set
-- server-side — if the data drifted (hash mismatch) the plan expires and a
-- fresh preview is returned. Plans are PERSISTED because the app runs on
-- serverless (in-memory plans die between invocations).
--
-- IDEMPOTENT: safe to re-run.

CREATE TABLE IF NOT EXISTS ai_bulk_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  operation text NOT NULL,            -- 'delete' | 'merge_profiles'
  criteria jsonb NOT NULL,            -- normalized, re-derivable filter
  plan_hash text NOT NULL,            -- sha256 over the sorted affected ids
  preview jsonb NOT NULL,             -- { counts: {tasks: 3, ...}, samples: [...] }

  status text NOT NULL DEFAULT 'pending',  -- pending | executed | expired | cancelled
  affected jsonb,                     -- ids per entity type actually acted on

  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  executed_at timestamptz
);

CREATE INDEX IF NOT EXISTS ai_bulk_plans_user_idx
  ON ai_bulk_plans (user_id, created_at DESC);

ALTER TABLE ai_bulk_plans ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_bulk_plans' AND policyname = 'ai_bulk_plans_owner'
  ) THEN
    CREATE POLICY ai_bulk_plans_owner ON ai_bulk_plans
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
