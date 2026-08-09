-- Migration 20260809: reminders become timed tasks
--
-- Portol now models scheduled life with exactly TWO entities: EVENTS (things
-- that happen) and TASKS (things you do). "Reminder" was a third kind that
-- existed only because tasks had no clock time — so anything the user phrased
-- with an hour ("mow the lawn every Tuesday at 9 AM") became a pile of one-shot
-- notification rows that could not be checked off, never appeared in the
-- Recurring list, and reached the calendar only through a mirrored event.
--
-- This migration:
--   1. gives tasks a clock time (`due_time`);
--   2. folds every surviving reminder into a task — collapsing a materialized
--      series ("Mow the lawn" × 52) back into ONE recurring task rather than 52
--      rows, recovering the cadence from the gap between the first two
--      occurrences, which is the only place it survived;
--   3. soft-deletes the mirror events the old chat tool put on the calendar,
--      which the migrated task now supersedes;
--   4. drops the reminders table.
--
-- ORDER MATTERS: the backfill runs before the DROP inside one transaction, so a
-- failure anywhere leaves the reminders intact rather than half-migrated.
--
-- TIMEZONE: `reminders.fire_at` is a timestamptz (an instant); `tasks.due_date`
-- and `due_time` are the user's WALL CLOCK. The app has one configured zone
-- (shared/timezone.ts DEFAULT_TIMEZONE) and no per-user zone column, so the
-- conversion below uses it. If your deployment's users are elsewhere, change
-- the one literal in `app_zone` — it is referenced nowhere else.
--
-- IDEMPOTENT: safe to re-run. Step 2 no-ops once the table is gone, and
-- re-running before the drop will not duplicate tasks (the insert skips any
-- title that already carries a migrated task for the same user).

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Tasks get a clock time
-- ────────────────────────────────────────────────────────────────────────────
-- Wall-clock HH:MM (24h) paired with due_date. NULL = an all-day to-do, which
-- is what every pre-existing task is.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_time TEXT;

COMMENT ON COLUMN tasks.due_time IS
  'Wall-clock HH:MM (24h) in the user timezone, paired with due_date. NULL = all-day. Puts the task on the calendar at that hour and drives its due notification.';

-- Timed tasks are read by due date across a window on every calendar fetch.
CREATE INDEX IF NOT EXISTS tasks_user_due_time_idx
  ON tasks(user_id, due_date)
  WHERE due_time IS NOT NULL AND deleted_at IS NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2 & 3. Fold reminders into tasks, then drop the table
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  app_zone CONSTANT text := 'America/Los_Angeles'; -- shared/timezone.ts DEFAULT_TIMEZONE
  migrated  integer := 0;
  unmirrored integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'reminders'
  ) THEN
    RAISE NOTICE 'reminders table already gone — nothing to migrate';
    RETURN;
  END IF;

  -- A reminder SERIES was stored as N independent rows sharing a title, so its
  -- cadence has to be recovered from the spacing. `gap_days` is the distance
  -- between the first two pending occurrences of each (user, title, profile)
  -- group; a group of one is a one-time task.
  WITH pending AS (
    SELECT
      r.user_id,
      r.title,
      r.profile_id,
      r.fire_at,
      ROW_NUMBER()   OVER (PARTITION BY r.user_id, r.title, r.profile_id ORDER BY r.fire_at) AS rn,
      COUNT(*)       OVER (PARTITION BY r.user_id, r.title, r.profile_id)                    AS occurrences,
      MAX(r.fire_at) OVER (PARTITION BY r.user_id, r.title, r.profile_id)                    AS last_fire_at
    FROM reminders r
    WHERE r.deleted_at IS NULL
      AND r.fired_at IS NULL
  ),
  grouped AS (
    SELECT
      p.user_id, p.title, p.profile_id,
      p.fire_at AS first_fire_at,
      p.occurrences,
      p.last_fire_at,
      (
        SELECT (n.fire_at::date - p.fire_at::date)
        FROM pending n
        WHERE n.user_id = p.user_id
          AND n.title = p.title
          AND n.profile_id IS NOT DISTINCT FROM p.profile_id
          AND n.rn = 2
      ) AS gap_days
    FROM pending p
    WHERE p.rn = 1
  ),
  ruled AS (
    SELECT
      g.*,
      CASE
        WHEN g.occurrences < 2 OR g.gap_days IS NULL THEN NULL
        -- Sub-daily series (the twice/three-times-a-day medication cadences)
        -- collapse to daily: a calendar with one row per day never separated
        -- the extra doses anyway.
        WHEN g.gap_days <= 1                THEN 'daily'
        WHEN g.gap_days = 7                 THEN 'weekly'
        WHEN g.gap_days = 14                THEN 'every-2-weeks'
        WHEN g.gap_days BETWEEN 28 AND 31   THEN 'monthly'
        WHEN g.gap_days BETWEEN 89 AND 92   THEN 'every-13-weeks'
        WHEN g.gap_days BETWEEN 364 AND 366 THEN 'yearly'
        ELSE 'every-' || g.gap_days || '-days'
      END AS freq
    FROM grouped g
  )
  INSERT INTO tasks (id, user_id, title, status, priority, due_date, due_time, linked_profiles, tags, source, created_at)
  SELECT
    gen_random_uuid(),
    r.user_id,
    r.title,
    'todo',
    'medium',
    to_char(r.first_fire_at AT TIME ZONE app_zone, 'YYYY-MM-DD'),
    to_char(r.first_fire_at AT TIME ZONE app_zone, 'HH24:MI'),
    CASE WHEN r.profile_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(r.profile_id::text) END,
    -- Recurrence rides in tags (shared/recurrence.ts). `runtil:` pins the end
    -- of the series to the last occurrence that was actually materialized, so
    -- the migrated task repeats for exactly as long as the reminders would
    -- have — no longer, no shorter.
    CASE
      WHEN r.freq IS NULL THEN jsonb_build_array('migrated:reminder')
      ELSE jsonb_build_array(
             'migrated:reminder',
             'recur:' || r.freq,
             'runtil:' || to_char(r.last_fire_at AT TIME ZONE app_zone, 'YYYY-MM-DD'))
    END,
    'migration',
    now()
  FROM ruled r
  WHERE NOT EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.user_id = r.user_id
      AND t.title = r.title
      AND t.deleted_at IS NULL
      AND t.tags @> '["migrated:reminder"]'::jsonb
  );
  GET DIAGNOSTICS migrated = ROW_COUNT;

  -- The old chat tool mirrored reminders onto the calendar as companion events
  -- tagged "reminder". The migrated task now occupies those dates itself, so
  -- leaving the mirrors would double every occurrence. Only events carrying
  -- that tag AND matching a reminder title are retired — an event the user
  -- typed themselves is never tagged this way.
  UPDATE events e
  SET deleted_at = now()
  WHERE e.deleted_at IS NULL
    AND e.tags @> '["reminder"]'::jsonb
    AND EXISTS (
      SELECT 1 FROM reminders r
      WHERE r.user_id = e.user_id
        AND lower(r.title) = lower(e.title)
    );
  GET DIAGNOSTICS unmirrored = ROW_COUNT;

  RAISE NOTICE 'reminders → tasks: % task(s) created, % mirror event(s) retired', migrated, unmirrored;

  DROP TABLE reminders CASCADE;
END $$;

COMMIT;
