-- Migration 20260922: trackers.linked_habit_id — the mirror relationship
--
-- A habit that measures something mirrors its check-ins into a tracker
-- (habits.linked_tracker_id → trackers.id). When no compatible tracker exists
-- one is auto-created and NAMED AFTER THE HABIT (server/habit-completion.ts).
-- Until now the only way to tell that auto-created mirror apart from a
-- tracker the user made and linked was to compare its name to the habit's —
-- which broke the moment the habit was renamed ("Read for 15 minutes" →
-- "Read for 12 minutes"): the tracker kept the old name, and the mirror test
-- no longer recognised it.
--
-- linked_habit_id is the reverse edge, stamped only at mirror creation. The
-- rename cascade (server/habit-rename-cascade.ts) and the mirror test read
-- THIS, not the name (Rules 19/20: linked data propagates via relationships,
-- not copies).
--
-- IDEMPOTENT: safe to re-run. Nullable, no backfill: legacy mirrors are still
-- recognised by the name-equality fallback until they are re-created.

ALTER TABLE trackers ADD COLUMN IF NOT EXISTS linked_habit_id uuid;

CREATE INDEX IF NOT EXISTS trackers_linked_habit_idx
  ON trackers (user_id, linked_habit_id)
  WHERE linked_habit_id IS NOT NULL;
