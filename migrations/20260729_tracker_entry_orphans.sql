-- ============================================================
-- 20260729_tracker_entry_orphans.sql
--
-- Production audit 2026-07-29 (High): "Three active tracker entries
-- reference soft-deleted trackers."
--
-- Soft-deleting a tracker did not carry its entries with it, so entries
-- stayed `deleted_at IS NULL` while their parent tracker was retired. Those
-- rows are invisible in the UI (every read joins through the tracker) but
-- still counted by aggregate/stat queries that read tracker_entries directly
-- — the classic "the number on the dashboard doesn't match the list" bug.
--
-- Two parts:
--   1. Back-fill: retire entries whose tracker is already soft-deleted.
--   2. Trigger: soft-deleting a tracker now cascades to its entries, and
--      un-deleting one restores them, so the two can never drift again.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Preconditions — this migration only applies where both
--    tables carry a deleted_at column.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tracker_entries' AND column_name='deleted_at'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='trackers' AND column_name='deleted_at'
  ) THEN
    RAISE EXCEPTION 'tracker_entry_orphans: expected deleted_at on both trackers and tracker_entries';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Back-fill the orphans
-- ------------------------------------------------------------
DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE public.tracker_entries te
  SET deleted_at = t.deleted_at
  FROM public.trackers t
  WHERE t.id = te.tracker_id
    AND t.deleted_at IS NOT NULL
    AND te.deleted_at IS NULL;

  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'tracker_entry_orphans: retired % entry row(s) whose tracker was already soft-deleted.', n;
END $$;

-- ------------------------------------------------------------
-- 2. Keep them in lockstep from now on
-- ------------------------------------------------------------
-- Mirrors the tracker's deleted_at onto its entries whenever it changes.
-- Only touches entries that are actually out of step, so a no-op update on
-- a tracker costs one cheap indexed check and writes nothing.
CREATE OR REPLACE FUNCTION public.cascade_tracker_soft_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    IF NEW.deleted_at IS NOT NULL THEN
      -- Tracker retired → retire its live entries.
      UPDATE public.tracker_entries
         SET deleted_at = NEW.deleted_at
       WHERE tracker_id = NEW.id
         AND deleted_at IS NULL;
    ELSE
      -- Tracker restored → restore exactly the entries that went down WITH
      -- it (matching timestamp), never entries deleted individually before.
      UPDATE public.tracker_entries
         SET deleted_at = NULL
       WHERE tracker_id = NEW.id
         AND deleted_at = OLD.deleted_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.cascade_tracker_soft_delete() FROM PUBLIC;
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.cascade_tracker_soft_delete() FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS trg_cascade_tracker_soft_delete ON public.trackers;
CREATE TRIGGER trg_cascade_tracker_soft_delete
AFTER UPDATE OF deleted_at ON public.trackers
FOR EACH ROW EXECUTE FUNCTION public.cascade_tracker_soft_delete();

-- ------------------------------------------------------------
-- 3. Verify
-- ------------------------------------------------------------
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT COUNT(*) INTO n
  FROM public.tracker_entries te
  JOIN public.trackers t ON t.id = te.tracker_id
  WHERE te.deleted_at IS NULL AND t.deleted_at IS NOT NULL;

  IF n > 0 THEN
    RAISE EXCEPTION 'tracker_entry_orphans: % live entry row(s) still reference a soft-deleted tracker', n;
  END IF;
  RAISE NOTICE 'tracker_entry_orphans verification passed: no live entries on soft-deleted trackers.';
END $$;
