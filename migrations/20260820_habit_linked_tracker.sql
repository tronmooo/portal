-- Migration 20260820: habits get an optional link to the tracker that MEASURES them
--
-- The habit ↔ tracker separation (user directive 2026-08-20):
--
--   · A habit records CONSISTENCY — was today's target met, what's the streak.
--   · A tracker records the MEASUREMENT — ounces, miles, duration, intensity,
--     and any other rich fields. Tracker data is richer than the habit needs.
--   · A measurable habit ("drink 64 oz water daily", "run 3 miles 3x/week")
--     links to the tracker that measures it. Logging a tracker entry then
--     advances the habit's progress for that day (server/habit-tracker-sync.ts)
--     — one activity record updates both.
--   · A completion-only habit ("make my bed every morning") links to nothing;
--     there is no useful measurement beyond the check-in itself.
--   · Tracking something does NOT make it a habit: trackers exist freely
--     (weight, mood, expenses) with no habit pointing at them.
--
-- Deliberately NOT here: any calendar coupling. A habit's schedule (frequency,
-- target days, window) is internal habit recurrence logic and must never
-- become calendar events or recurring calendar rules. The calendar timeline
-- already excludes habits by design (see shared/habit-schedule.ts header).
--
-- No FK constraint: trackers are soft-deleted and merged by application code,
-- and a dangling link degrades harmlessly (the sync helper simply finds no
-- tracker). NULL = unlinked, which is what every existing habit is — additive,
-- no current row changes behaviour.
--
-- IDEMPOTENT: safe to re-run.

ALTER TABLE habits ADD COLUMN IF NOT EXISTS linked_tracker_id uuid;

COMMENT ON COLUMN habits.linked_tracker_id IS
  'Optional tracker that MEASURES this habit. Logging an entry to that tracker advances the habit''s daily progress. NULL for completion-only habits. Never implies any calendar entry.';

-- Every tracker-entry write asks "which habits point at this tracker?".
CREATE INDEX IF NOT EXISTS habits_user_linked_tracker_idx
  ON habits(user_id, linked_tracker_id)
  WHERE linked_tracker_id IS NOT NULL AND deleted_at IS NULL;
