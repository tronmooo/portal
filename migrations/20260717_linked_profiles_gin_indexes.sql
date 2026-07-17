-- 20260717_linked_profiles_gin_indexes.sql
--
-- PERF: index every `linked_profiles` column so the profile-scope containment
-- queries the app runs on nearly every read (`linked_profiles @> ...`) stop
-- doing sequential scans.
--
-- Background: the per-profile filter (getStats / getDashboardEnhanced /
-- bootstrap and most list endpoints) filters rows by
--   linked_profiles @> jsonb_build_array(<pid>)   -- JSONB columns
--   linked_profiles @> array[<pid>]               -- text[] columns
-- With no GIN index these are seq scans that get linearly slower as a user's
-- data grows — a large contributor to the cold multi-second dashboard loads.
--
-- Column types (see migrations/009_delete_profile_cascade.sql):
--   * JSONB   : expenses, tasks, habits, obligations, events, documents,
--               artifacts, goals, trackers
--   * text[]  : incomes, journal_entries
-- Operator class:
--   * JSONB  → jsonb_path_ops (smallest / fastest index specialized for @>)
--   * text[] → default gin array ops (supports @>)
--
-- This migration is DATA-DRIVEN and fully IDEMPOTENT: it discovers the actual
-- `linked_profiles` columns present in the live schema from information_schema,
-- so it indexes only tables/columns that exist (e.g. `obligations` may have
-- been dropped by 20260701_drop_obligations.sql) and picks the operator class
-- from the column's real data type. Every statement uses CREATE INDEX IF NOT
-- EXISTS, so re-running is a no-op.
--
-- NOTE on CONCURRENTLY: building indexes CONCURRENTLY cannot run inside a
-- transaction block or a PL/pgSQL DO block. These tables are small per-user and
-- the migration runner wraps statements in a transaction, so we build them
-- normally (a brief write lock per table). If applied to a very large live
-- table, consider running the equivalent CREATE INDEX CONCURRENTLY statements
-- by hand instead.

DO $$
DECLARE
  r          record;
  idx_name   text;
  opclass    text;
BEGIN
  FOR r IN
    SELECT c.table_name, c.data_type
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'linked_profiles'
      -- only real base tables, never views
      AND EXISTS (
        SELECT 1 FROM information_schema.tables t
        WHERE t.table_schema = 'public'
          AND t.table_name = c.table_name
          AND t.table_type = 'BASE TABLE'
      )
  LOOP
    idx_name := format('idx_%s_linked_profiles_gin', r.table_name);

    IF r.data_type = 'jsonb' THEN
      opclass := 'linked_profiles jsonb_path_ops';
    ELSE
      -- ARRAY (text[]) or any other gin-capable type → default gin ops
      opclass := 'linked_profiles';
    END IF;

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I USING gin (%s)',
      idx_name, r.table_name, opclass
    );
    RAISE NOTICE 'ensured GIN index % on public.% (%).', idx_name, r.table_name, r.data_type;
  END LOOP;
END $$;
