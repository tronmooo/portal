-- Migration 007 — Unify mood enum across tracker_entries and journal_entries.
--
-- Background: code (server/ai-engine.ts, shared/schema.ts) treats mood as the
-- 8-level set ('amazing','great','good','okay','neutral','bad','awful','terrible').
-- The original supabase-migration.sql had two narrower CHECK constraints that
-- disagreed with the code AND with each other:
--   tracker_entries:  ('great','good','okay','bad','terrible')           -- 5 values
--   journal_entries:  ('amazing','good','neutral','bad','awful')         -- 5 values
-- Inserts of valid in-code moods (e.g. 'amazing' on a tracker) caused 500s.
--
-- This migration is idempotent — drops the old constraints if present and
-- recreates them with the unified 8-level set. Safe to run on any environment.

-- tracker_entries: drop any existing mood CHECK and recreate with the canonical set.
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT con.conname INTO c_name
    FROM pg_constraint con
    JOIN pg_class tbl ON tbl.oid = con.conrelid
   WHERE tbl.relname = 'tracker_entries'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%mood%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.tracker_entries DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

ALTER TABLE public.tracker_entries
  ADD CONSTRAINT tracker_entries_mood_check
  CHECK (mood IS NULL OR mood IN
    ('amazing','great','good','okay','neutral','bad','awful','terrible'));

-- journal_entries: same pattern. Production already had the 8-level enum, so
-- this is a no-op there; it brings older / dev databases into line.
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT con.conname INTO c_name
    FROM pg_constraint con
    JOIN pg_class tbl ON tbl.oid = con.conrelid
   WHERE tbl.relname = 'journal_entries'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%mood%'
     AND pg_get_constraintdef(con.oid) NOT ILIKE '%terrible%'; -- already-unified constraint stays
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.journal_entries DROP CONSTRAINT %I', c_name);
    ALTER TABLE public.journal_entries
      ADD CONSTRAINT journal_entries_mood_check
      CHECK (mood IN ('amazing','great','good','okay','neutral','bad','awful','terrible'));
  END IF;
END $$;
