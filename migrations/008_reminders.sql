-- Migration 008: Reminders
-- Adds a first-class reminders table so the assistant can set REAL reminders
-- that a scheduled fire loop (GET /api/cron/fire-due-reminders) marks fired
-- and surfaces as an in-app marker. Additive only — no existing data touched.
--
-- IDEMPOTENT: safe to re-run (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
-- EXISTS / policy guarded by a DO block).

CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  title text NOT NULL,
  fire_at timestamptz NOT NULL,
  fired_at timestamptz,
  channel text NOT NULL DEFAULT 'in_app',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS reminders_user_fire_idx
  ON reminders(user_id, fire_at)
  WHERE fired_at IS NULL AND deleted_at IS NULL;

-- RLS: mirror the existing user_id = auth.uid() pattern used by other tables.
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'reminders' AND policyname = 'reminders_owner'
  ) THEN
    CREATE POLICY reminders_owner ON reminders
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
