-- ============================================================
-- 20260729_linked_profiles_ownership_guard.sql
--
-- BLOCKER (production audit 2026-07-29): cross-user profile associations.
--
-- `linked_profiles` is a JSON/text[] column with no database-enforced
-- ownership validation, so a row owned by user A could reference a profile
-- owned by user B. The audit proved two live cases:
--
--   * habits   32394c86-ec39-4a39-b879-ab97513e5cb4 ("Drink 8 glasses of water")
--       owner d2064ce8… → profile e0654d9a… ("Rex") owned by 6f63cf74…
--   * trackers a9c97993-830e-4d4e-8f58-df368a3ed800 ("Medication - Mom")
--       owner 6f63cf74… → profile 1e0b9eef… ("Mom") owned by d2064ce8…
--
-- (a mirrored swap between two accounts). A wider sweep also found dangling
-- references to profiles that no longer exist: 3 in `events`, 4 in `habits`,
-- 4 in `incomes` (counting soft-deleted rows).
--
-- This migration does three things, in order:
--   1. PRUNE every invalid element from every `linked_profiles` column.
--   2. INSTALL a trigger that rejects invalid elements on INSERT/UPDATE.
--   3. VERIFY the table is clean and fail loudly if it is not.
--
-- ── Cleanup policy (deliberate) ─────────────────────────────────────────
-- Invalid references are REMOVED, not re-pointed. Re-pointing would mean
-- inventing an association the user never made. Rows whose only link was
-- invalid end up with an empty `linked_profiles`, which the application
-- already treats as a normal "unlinked / orphan" state (see the orphan
-- adoption path in server/ai-engine.ts log_tracker_entry).
--
-- For the record, so a human can re-point deliberately if they want to:
-- tracker a9c97993… is owned by 6f63cf74…, who has their OWN "Mom" profile
-- (fc3a2470-1a87-4703-8897-8c7ecf68d9bb). Habit 32394c86…'s owner
-- (d2064ce8…) has NO "Rex" profile, so there is no candidate at all.
--
-- ── Validation policy (deliberate) ──────────────────────────────────────
-- The trigger ALWAYS rejects a reference that is missing or cross-user —
-- those are hard corruption and step 1 guarantees none exist.
--
-- The "profile must still be active" rule is enforced only for links that
-- are NEWLY ADDED by the statement. Enforcing it on every element would
-- mean that soft-deleting a profile retroactively bricks every unrelated
-- UPDATE on every row that ever referenced it (renaming a task, checking
-- off a habit) — turning a cleanup into an outage. Adding a link to a
-- soft-deleted profile is still rejected, which is what actually prevents
-- new bad data.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. PRUNE invalid references from every linked_profiles column
-- ------------------------------------------------------------
-- Data-driven: discovers the real columns from information_schema, so it
-- covers both the JSONB tables (artifacts, documents, events, expenses,
-- goals, habits, tasks, trackers) and the text[] tables (incomes,
-- journal_entries) without hardcoding a list that can drift.
--
-- Operates on ALL rows including soft-deleted ones: a soft-deleted row can
-- be restored or updated later, and a stale bad link would trip the trigger
-- at that point.
DO $$
DECLARE
  r        record;
  pruned   bigint;
  total    bigint := 0;
BEGIN
  FOR r IN
    SELECT c.table_name, c.data_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'linked_profiles'
      AND EXISTS (
        SELECT 1 FROM information_schema.tables t
        WHERE t.table_schema = 'public'
          AND t.table_name = c.table_name
          AND t.table_type = 'BASE TABLE'
      )
      -- A table that carries linked_profiles but NO user_id is not an owned
      -- entity: production grew `trackers_name_backup_20260824`, a snapshot
      -- copy, after this migration was written, and every loop below reads
      -- x.user_id, so discovery has to require that column (D289).
      AND EXISTS (
        SELECT 1 FROM information_schema.columns u
        WHERE u.table_schema = 'public'
          AND u.table_name = c.table_name
          AND u.column_name = 'user_id'
      )
    ORDER BY c.table_name
  LOOP
    IF r.data_type = 'jsonb' THEN
      -- Keep only elements naming a live profile owned by the SAME user.
      EXECUTE format($q$
        UPDATE public.%1$I x
        SET linked_profiles = COALESCE((
              SELECT jsonb_agg(e.val)
              FROM jsonb_array_elements(x.linked_profiles) e(val)
              WHERE EXISTS (
                SELECT 1 FROM public.profiles p
                WHERE p.id::text = (e.val #>> '{}')
                  AND p.user_id  = x.user_id
                  AND p.deleted_at IS NULL
              )
            ), '[]'::jsonb)
        WHERE jsonb_typeof(x.linked_profiles) = 'array'
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements(x.linked_profiles) e2(val)
            WHERE NOT EXISTS (
              SELECT 1 FROM public.profiles p2
              WHERE p2.id::text = (e2.val #>> '{}')
                AND p2.user_id  = x.user_id
                AND p2.deleted_at IS NULL
            )
          )
      $q$, r.table_name);
    ELSE
      -- text[] variant (incomes, journal_entries).
      EXECUTE format($q$
        UPDATE public.%1$I x
        SET linked_profiles = COALESCE((
              SELECT array_agg(e.val)
              FROM unnest(x.linked_profiles) e(val)
              WHERE EXISTS (
                SELECT 1 FROM public.profiles p
                WHERE p.id::text = e.val
                  AND p.user_id  = x.user_id
                  AND p.deleted_at IS NULL
              )
            ), ARRAY[]::text[])
        WHERE x.linked_profiles IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM unnest(x.linked_profiles) e2(val)
            WHERE NOT EXISTS (
              SELECT 1 FROM public.profiles p2
              WHERE p2.id::text = e2.val
                AND p2.user_id  = x.user_id
                AND p2.deleted_at IS NULL
            )
          )
      $q$, r.table_name);
    END IF;

    GET DIAGNOSTICS pruned = ROW_COUNT;
    total := total + pruned;
    IF pruned > 0 THEN
      RAISE NOTICE 'linked_profiles: pruned invalid references on % row(s) of public.%', pruned, r.table_name;
    END IF;
  END LOOP;

  RAISE NOTICE 'linked_profiles cleanup complete: % row(s) repaired in total.', total;
END $$;

-- ------------------------------------------------------------
-- 2. TRIGGER: reject invalid linked_profiles on write
-- ------------------------------------------------------------
-- One generic function serves every table: the column name is identical
-- everywhere, so `to_jsonb(NEW) -> 'linked_profiles'` reads both the JSONB
-- and the text[] shape as a JSON array.
--
-- SECURITY DEFINER so the lookup can see `profiles` rows regardless of RLS.
-- Without it the ownership check would run under the caller's RLS policy,
-- where another user's profile is simply invisible — the write would still
-- be rejected, but with a misleading "does not exist" reason. EXECUTE is
-- revoked from the client roles below; trigger functions do not require the
-- invoking user to hold EXECUTE, so this preserves the audit's "security
-- definer functions are not client-executable" safeguard.
CREATE OR REPLACE FUNCTION public.enforce_linked_profiles_ownership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  new_links  jsonb;
  old_links  jsonb;
  elem       jsonb;
  pid_text   text;
  pid        uuid;
  row_owner  uuid;
  prof_owner uuid;
  prof_gone  timestamptz;
  is_new     boolean;
BEGIN
  new_links := to_jsonb(NEW) -> 'linked_profiles';

  -- Nothing to validate: NULL, non-array, or empty.
  IF new_links IS NULL
     OR jsonb_typeof(new_links) <> 'array'
     OR jsonb_array_length(new_links) = 0 THEN
    RETURN NEW;
  END IF;

  row_owner := NULLIF(to_jsonb(NEW) ->> 'user_id', '')::uuid;
  IF row_owner IS NULL THEN
    RAISE EXCEPTION
      'linked_profiles on %.% requires a non-null user_id',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_links := to_jsonb(OLD) -> 'linked_profiles';
    IF old_links IS NULL OR jsonb_typeof(old_links) <> 'array' THEN
      old_links := '[]'::jsonb;
    END IF;
    -- Unchanged set → nothing new to police; skip the per-element work so
    -- ordinary updates stay cheap.
    IF new_links = old_links THEN
      RETURN NEW;
    END IF;
  ELSE
    old_links := '[]'::jsonb;
  END IF;

  FOR elem IN SELECT * FROM jsonb_array_elements(new_links)
  LOOP
    pid_text := elem #>> '{}';
    CONTINUE WHEN pid_text IS NULL OR btrim(pid_text) = '';

    BEGIN
      pid := pid_text::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION
        'linked_profiles on %.% contains a non-UUID profile reference %',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, pid_text
        USING ERRCODE = 'check_violation';
    END;

    -- Is this link being introduced by THIS statement?
    is_new := NOT (old_links @> jsonb_build_array(to_jsonb(pid_text)));

    SELECT p.user_id, p.deleted_at
      INTO prof_owner, prof_gone
      FROM public.profiles p
     WHERE p.id = pid;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'linked_profiles on %.% references profile % which does not exist',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, pid
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF prof_owner IS DISTINCT FROM row_owner THEN
      RAISE EXCEPTION
        'cross-user profile association rejected on %.%: profile % belongs to another user',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, pid
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- "Must be active" applies only to links this statement introduces —
    -- see the header note on why grandfathered links are tolerated.
    IF is_new AND prof_gone IS NOT NULL THEN
      RAISE EXCEPTION
        'linked_profiles on %.% references profile % which is deleted',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, pid
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_linked_profiles_ownership() FROM PUBLIC;
-- `anon` / `authenticated` are Supabase-managed roles; guard so the migration
-- also runs on a plain Postgres (local test cluster, CI) where they don't exist.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION public.enforce_linked_profiles_ownership() FROM %I',
        role_name);
    END IF;
  END LOOP;
END $$;

-- Attach to every table that actually has the column.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'linked_profiles'
      AND EXISTS (
        SELECT 1 FROM information_schema.tables t
        WHERE t.table_schema = 'public'
          AND t.table_name = c.table_name
          AND t.table_type = 'BASE TABLE'
      )
      -- A table that carries linked_profiles but NO user_id is not an owned
      -- entity: production grew `trackers_name_backup_20260824`, a snapshot
      -- copy, after this migration was written, and every loop below reads
      -- x.user_id, so discovery has to require that column (D289).
      AND EXISTS (
        SELECT 1 FROM information_schema.columns u
        WHERE u.table_schema = 'public'
          AND u.table_name = c.table_name
          AND u.column_name = 'user_id'
      )
    ORDER BY c.table_name
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_linked_profiles_ownership ON public.%I',
      r.table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_linked_profiles_ownership
         BEFORE INSERT OR UPDATE OF linked_profiles ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.enforce_linked_profiles_ownership()',
      r.table_name);
    RAISE NOTICE 'linked_profiles ownership trigger installed on public.%', r.table_name;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3. VERIFY — fail the migration if anything invalid survived
-- ------------------------------------------------------------
DO $$
DECLARE
  r       record;
  bad     bigint;
  bad_all bigint := 0;
BEGIN
  FOR r IN
    SELECT c.table_name, c.data_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'linked_profiles'
      AND EXISTS (
        SELECT 1 FROM information_schema.tables t
        WHERE t.table_schema = 'public'
          AND t.table_name = c.table_name
          AND t.table_type = 'BASE TABLE'
      )
      -- A table that carries linked_profiles but NO user_id is not an owned
      -- entity: production grew `trackers_name_backup_20260824`, a snapshot
      -- copy, after this migration was written, and every loop below reads
      -- x.user_id, so discovery has to require that column (D289).
      AND EXISTS (
        SELECT 1 FROM information_schema.columns u
        WHERE u.table_schema = 'public'
          AND u.table_name = c.table_name
          AND u.column_name = 'user_id'
      )
  LOOP
    IF r.data_type = 'jsonb' THEN
      EXECUTE format($q$
        SELECT COUNT(*) FROM public.%1$I x, LATERAL jsonb_array_elements(x.linked_profiles) e(val)
        WHERE jsonb_typeof(x.linked_profiles) = 'array'
          AND NOT EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id::text = (e.val #>> '{}')
              AND p.user_id = x.user_id AND p.deleted_at IS NULL)
      $q$, r.table_name) INTO bad;
    ELSE
      EXECUTE format($q$
        SELECT COUNT(*) FROM public.%1$I x, LATERAL unnest(x.linked_profiles) e(val)
        WHERE x.linked_profiles IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id::text = e.val
              AND p.user_id = x.user_id AND p.deleted_at IS NULL)
      $q$, r.table_name) INTO bad;
    END IF;

    IF bad > 0 THEN
      RAISE WARNING 'linked_profiles: % invalid reference(s) remain on public.%', bad, r.table_name;
      bad_all := bad_all + bad;
    END IF;
  END LOOP;

  IF bad_all > 0 THEN
    RAISE EXCEPTION 'linked_profiles cleanup incomplete: % invalid reference(s) remain', bad_all;
  END IF;

  RAISE NOTICE 'linked_profiles verification passed: no invalid references remain.';
END $$;
