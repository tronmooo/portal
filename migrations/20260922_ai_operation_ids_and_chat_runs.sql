-- Migration 20260922: AI operation identity + durable chat run state
--
-- Rule 2 — every AI turn gets a request_id, every write inside it an
-- operation_id, and those ids are stored with the ledger row for the record
-- they created. A retried request (lost response, reconnect, navigation)
-- derives the same operation ids and finds these rows instead of writing
-- again. The unique index is what makes the write idempotent even under a
-- concurrent replay: the second insert fails, the first result is returned.
--
-- Rule 22 — a chat turn's execution state lives server-side (queued /
-- running / completed / failed / cancelled) keyed by the client's request id,
-- so the UI can leave and come back and subscribe to the same run instead of
-- re-running it.
--
-- IDEMPOTENT: safe to re-run.

ALTER TABLE ai_action_log ADD COLUMN IF NOT EXISTS turn_id text;
ALTER TABLE ai_action_log ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE ai_action_log ADD COLUMN IF NOT EXISTS operation_id text;

CREATE UNIQUE INDEX IF NOT EXISTS ai_action_log_operation_uidx
  ON ai_action_log (user_id, operation_id)
  WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_action_log_request_idx
  ON ai_action_log (user_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_chat_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  turn_id text,
  message text,
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, request_id)
);

CREATE INDEX IF NOT EXISTS ai_chat_runs_user_updated_idx
  ON ai_chat_runs (user_id, updated_at DESC);

ALTER TABLE ai_chat_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ai_chat_runs' AND policyname = 'ai_chat_runs_owner'
  ) THEN
    CREATE POLICY ai_chat_runs_owner ON ai_chat_runs
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
