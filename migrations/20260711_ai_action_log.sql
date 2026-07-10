-- Migration 20260711: AI action ledger (undo + audit for chat mutations)
--
-- Every successful AI-chat write is recorded here with enough context to
-- reverse it: the tool, the entity it touched, a before/after snapshot, and
-- a machine-readable reverse_plan. Powers the undo_last_action and
-- get_entity_history chat tools, and replaces the volatile in-memory
-- actionLogMap (20 entries, lost on every cold start) behind recall_actions
-- and GET /api/activity.
--
-- NOTE: a legacy `undo_log` table exists in some environments but was never
-- written by application code — it stays untouched.
--
-- IDEMPOTENT: safe to re-run.

CREATE TABLE IF NOT EXISTS ai_action_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  tool text NOT NULL,                 -- e.g. create_task, delete_expense
  action_type text NOT NULL,          -- ParsedAction type (create_task, delete_entity, ...)
  entity_type text,                   -- task | expense | profile | ...
  entity_id text,
  entity_name text,

  input jsonb,                        -- tool input (sans __userMessage)
  before jsonb,                       -- pre-write snapshot when available
  after jsonb,                        -- envelope entity / trimmed result

  reversible boolean NOT NULL DEFAULT false,
  reverse_plan jsonb,                 -- {op:'delete'|'restore'|'reapply_before'|'recreate'|'restore_set', ...}

  source text NOT NULL DEFAULT 'chat',  -- chat | bulk | undo
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by_log_id uuid
);

CREATE INDEX IF NOT EXISTS ai_action_log_user_created_idx
  ON ai_action_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_action_log_entity_idx
  ON ai_action_log (user_id, entity_type, entity_id);

-- RLS: owner-only, mirroring the captures/user tables pattern.
ALTER TABLE ai_action_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_action_log' AND policyname = 'ai_action_log_owner'
  ) THEN
    CREATE POLICY ai_action_log_owner ON ai_action_log
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
