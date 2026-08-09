-- Habits: multiple completions per day.
--
-- Habits were effectively binary — one check-in row per habit per day, and
-- checkinHabit() refused to write past target_per_day. "Drink water 8x", "take
-- medication twice", "walk the dog 3x" had nowhere to live.
--
-- Each completion is now its own habit_checkins row with its own timestamp.
-- This migration makes that legal and traceable:
--
--  1. DROP the UNIQUE (habit_id, date) constraint. supabase-phase1-migration.sql
--     added it deliberately ("prevents duplicate check-ins per day") — that is
--     exactly the behavior being removed. It is not present on the live
--     database, but the drop is here so a fresh environment that ran phase 1
--     still ends up multi-completion capable.
--  2. `source` on each completion: manual | ai_chat | automation | import.
--  3. `created_at` so an edited/backdated completion still records when it was
--     actually entered (`timestamp` is WHEN THE USER DID IT, which may be
--     earlier — "I brushed my teeth at 8am").
--  4. `unit_label` on habits for count-based habits ("glasses", "walks").
--
-- Additive and idempotent. Existing habits keep target_per_day = 1 and behave
-- exactly as before; existing check-ins are untouched and read back as
-- source = 'manual'.

-- 1. Multiple completions per day are the point — the uniqueness constraint goes.
ALTER TABLE habit_checkins DROP CONSTRAINT IF EXISTS habit_checkins_unique_day;

-- 2/3. Provenance and entry time for each individual completion.
ALTER TABLE habit_checkins
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';

ALTER TABLE habit_checkins
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'habit_checkins_source_check') THEN
    ALTER TABLE habit_checkins ADD CONSTRAINT habit_checkins_source_check
      CHECK (source IS NULL OR source IN ('manual','ai_chat','automation','import'));
  END IF;
END $$;

-- Backfill: every pre-existing completion was entered by hand, and its entry
-- time is the only timestamp we have.
UPDATE habit_checkins SET source = 'manual' WHERE source IS NULL;
UPDATE habit_checkins SET created_at = "timestamp" WHERE created_at IS NULL;

-- 4. Optional unit for count-based habits ("8 glasses", "3 walks").
ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS unit_label TEXT;

-- Backward compatibility: any habit without an explicit daily target is a
-- once-a-day habit, which is how every existing habit already behaves.
UPDATE habits SET target_per_day = 1 WHERE target_per_day IS NULL OR target_per_day < 1;

-- Today's-progress lookups scan (habit_id, date); the existing index covers
-- them. Ordering completions within a day needs the timestamp too.
CREATE INDEX IF NOT EXISTS idx_habit_checkins_habit_date_ts
  ON habit_checkins (habit_id, date, "timestamp");
