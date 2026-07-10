-- Migration 20260711: user-created notifications (chat create_notification)
--
-- The bell's notifications are COMPUTED (deterministic ids over documents,
-- tasks, bills, habits, reminders). This table adds PERSISTED user/AI-created
-- rows which buildNotifications merges in under the id namespace
-- 'custom:<uuid>' (never collides with computed ids). read_at / dismissed_at
-- give custom rows real read/dismiss state; computed rows keep using the
-- dismissed_notifications preference.
--
-- IDEMPOTENT: safe to re-run.

CREATE TABLE IF NOT EXISTS user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  title text NOT NULL,
  message text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT 'info',   -- critical | warning | info
  entity_type text,
  entity_id text,

  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  dismissed_at timestamptz
);

CREATE INDEX IF NOT EXISTS user_notifications_user_idx
  ON user_notifications (user_id, created_at DESC);

ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_notifications' AND policyname = 'user_notifications_owner'
  ) THEN
    CREATE POLICY user_notifications_owner ON user_notifications
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
