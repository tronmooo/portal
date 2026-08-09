-- Migration 20260809: habits get a scheduling window
--
-- A habit could say how OFTEN ("2× per day", target_per_day) but never for HOW
-- LONG, so three different commitments collapsed into one row shape:
--
--   "2x per day"             two completions each day, forever
--   "daily for 2 days"       one completion on each of two days
--   "2x per day for 7 days"  fourteen occurrences, two available per day
--
-- Only the first was representable. The other two were stored as open-ended
-- habits that nagged forever, because there was nowhere to put the end.
--
-- start_date / end_date are INCLUSIVE calendar days in the user's timezone,
-- both nullable — an absent bound is open in that direction, which is what
-- every existing habit is, so this is additive and changes no current row's
-- behaviour (shared/habit-schedule.ts isHabitDueOn skips an absent bound).
--
-- IDEMPOTENT: safe to re-run.

ALTER TABLE habits ADD COLUMN IF NOT EXISTS start_date TEXT;
ALTER TABLE habits ADD COLUMN IF NOT EXISTS end_date   TEXT;

COMMENT ON COLUMN habits.start_date IS
  'Inclusive YYYY-MM-DD first scheduled day. NULL = scheduled from creation.';
COMMENT ON COLUMN habits.end_date IS
  'Inclusive YYYY-MM-DD last scheduled day. NULL = open-ended. With target_per_day this is what makes "2x per day for 7 days" a 14-occurrence commitment rather than an endless one.';

-- "Which habits are still running?" is asked on every dashboard and briefing
-- load; a bounded habit that has ended should cost nothing to skip.
CREATE INDEX IF NOT EXISTS habits_user_end_date_idx
  ON habits(user_id, end_date)
  WHERE end_date IS NOT NULL AND deleted_at IS NULL;
