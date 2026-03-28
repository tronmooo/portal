-- ============================================================
-- Phase 2 Migration — Production-Grade Schema Hardening
-- Addresses audit findings: column renames, constraints,
-- indexes, triggers, and missing relationships.
-- Run in Supabase SQL Editor (idempotent — safe to re-run).
-- ============================================================

-- ============================================================
-- 1. RENAME domain_entries."values" → entry_values
--    (mirrors tracker_entries.entry_values; avoids SQL reserved-word collision)
-- ============================================================
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'domain_entries' AND column_name = 'values'
  ) THEN
    ALTER TABLE domain_entries RENAME COLUMN "values" TO entry_values;
  END IF;
END $$;

-- ============================================================
-- 2. UNIQUE CONSTRAINT — entity_links
--    Prevents duplicate relationship records accumulating silently.
--    The storage layer already tries to handle this in code; enforce at DB level.
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entity_links_unique_relationship'
  ) THEN
    -- Remove exact duplicates first (keep the oldest)
    DELETE FROM entity_links a USING entity_links b
    WHERE a.user_id = b.user_id
      AND a.source_type = b.source_type AND a.source_id = b.source_id
      AND a.target_type = b.target_type AND a.target_id = b.target_id
      AND a.created_at > b.created_at;

    ALTER TABLE entity_links
      ADD CONSTRAINT entity_links_unique_relationship
      UNIQUE (user_id, source_type, source_id, target_type, target_id);
  END IF;
END $$;

-- ============================================================
-- 3. UNIQUE CONSTRAINT — domains slug per user
--    Prevents two domains with the same slug for the same user.
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'domains_unique_user_slug'
  ) THEN
    -- Resolve any existing conflicts by appending the id suffix
    UPDATE domains d1
    SET slug = d1.slug || '-' || LEFT(d1.id::text, 8)
    WHERE EXISTS (
      SELECT 1 FROM domains d2
      WHERE d2.user_id = d1.user_id AND d2.slug = d1.slug AND d2.id < d1.id
    );

    ALTER TABLE domains
      ADD CONSTRAINT domains_unique_user_slug UNIQUE (user_id, slug);
  END IF;
END $$;

-- ============================================================
-- 4. UNIQUE CONSTRAINT — journal_entries one per day per user
--    Prevents duplicate journal entries for the same date.
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'journal_entries_unique_user_date'
  ) THEN
    -- Remove duplicate dates (keep the most recently created)
    DELETE FROM journal_entries a USING journal_entries b
    WHERE a.user_id = b.user_id AND a.date = b.date AND a.created_at < b.created_at;

    ALTER TABLE journal_entries
      ADD CONSTRAINT journal_entries_unique_user_date UNIQUE (user_id, date);
  END IF;
END $$;

-- ============================================================
-- 5. GIN INDEXES — JSONB link arrays
--    Enables O(1) containment queries (@>) on linked_profiles arrays
--    instead of full sequential scans.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_trackers_linked_profiles
  ON trackers USING gin(linked_profiles);

CREATE INDEX IF NOT EXISTS idx_tasks_linked_profiles
  ON tasks USING gin(linked_profiles);

CREATE INDEX IF NOT EXISTS idx_expenses_linked_profiles
  ON expenses USING gin(linked_profiles);

CREATE INDEX IF NOT EXISTS idx_events_linked_profiles
  ON events USING gin(linked_profiles);

CREATE INDEX IF NOT EXISTS idx_obligations_linked_profiles
  ON obligations USING gin(linked_profiles);

CREATE INDEX IF NOT EXISTS idx_artifacts_linked_profiles
  ON artifacts USING gin(linked_profiles);

CREATE INDEX IF NOT EXISTS idx_documents_linked_profiles
  ON documents USING gin(linked_profiles);

-- Indexes on the profiles JSONB link arrays (for reverse lookups)
CREATE INDEX IF NOT EXISTS idx_profiles_linked_trackers
  ON profiles USING gin(linked_trackers);

CREATE INDEX IF NOT EXISTS idx_profiles_linked_expenses
  ON profiles USING gin(linked_expenses);

CREATE INDEX IF NOT EXISTS idx_profiles_linked_tasks
  ON profiles USING gin(linked_tasks);

CREATE INDEX IF NOT EXISTS idx_profiles_linked_events
  ON profiles USING gin(linked_events);

CREATE INDEX IF NOT EXISTS idx_profiles_documents
  ON profiles USING gin(documents);

-- ============================================================
-- 6. FULL-TEXT SEARCH INDEXES — missing tables
--    expenses, obligations, and trackers weren't in the original set.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_expenses_description_search
  ON expenses USING gin(to_tsvector('english', description || ' ' || COALESCE(vendor, '') || ' ' || COALESCE(category, '')));

CREATE INDEX IF NOT EXISTS idx_obligations_name_search
  ON obligations USING gin(to_tsvector('english', name || ' ' || COALESCE(category, '') || ' ' || COALESCE(notes, '')));

CREATE INDEX IF NOT EXISTS idx_trackers_name_search
  ON trackers USING gin(to_tsvector('english', name || ' ' || COALESCE(category, '')));

CREATE INDEX IF NOT EXISTS idx_goals_title_search
  ON goals USING gin(to_tsvector('english', title || ' ' || COALESCE(category, '')));

-- ============================================================
-- 7. PERFORMANCE INDEXES — commonly filtered columns
-- ============================================================

-- expenses by category (for spending_limit goals and monthly summaries)
CREATE INDEX IF NOT EXISTS idx_expenses_user_category
  ON expenses(user_id, category);

-- obligations by status (filter out paused/cancelled quickly)
CREATE INDEX IF NOT EXISTS idx_obligations_user_status
  ON obligations(user_id, status);

-- habits by frequency (for completion rate calculations)
CREATE INDEX IF NOT EXISTS idx_habits_user_frequency
  ON habits(user_id, frequency);

-- entity_links by both directions for quick graph traversal
CREATE INDEX IF NOT EXISTS idx_entity_links_source_target
  ON entity_links(user_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_entity_links_target_source
  ON entity_links(user_id, target_type, target_id);

-- domain_entries for per-domain listing
CREATE INDEX IF NOT EXISTS idx_domain_entries_user
  ON domain_entries(user_id);

-- ============================================================
-- 8. UPDATED_AT AUTO-UPDATE TRIGGERS
--    Ensures updated_at is always current without relying on
--    application code to set it manually on every write path.
-- ============================================================

-- Trigger function (reusable across all tables)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to every table that has updated_at
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'profiles', 'trackers', 'tasks', 'expenses', 'events', 'habits',
    'obligations', 'artifacts', 'memories', 'goals', 'documents'
  ]) LOOP
    -- Drop if exists (idempotent), then recreate
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON %1$s', tbl);
    EXECUTE format('
      CREATE TRIGGER trg_%1$s_updated_at
        BEFORE UPDATE ON %1$s
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    ', tbl);
  END LOOP;
END $$;

-- ============================================================
-- 9. JUNCTION TABLE RLS — verify all 8 junction tables have policies
--    (Phase 3 created the tables; this ensures RLS is enabled and
--    any tables created without policies get them now)
-- ============================================================
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'profile_trackers', 'profile_tasks', 'profile_expenses',
    'profile_events', 'profile_documents', 'profile_obligations',
    'profile_artifacts', 'event_documents'
  ]) LOOP
    -- Only act if table exists (guards against fresh installs that haven't run Phase 3)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = tbl AND table_schema = 'public') THEN
      EXECUTE format('ALTER TABLE %1$s ENABLE ROW LEVEL SECURITY', tbl);
      -- Create policies only if they don't already exist
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = tbl AND policyname = 'Users can view own ' || tbl
      ) THEN
        EXECUTE format('
          CREATE POLICY "Users can view own %1$s" ON %1$s
            FOR SELECT USING (auth.uid() = user_id);
          CREATE POLICY "Users can insert own %1$s" ON %1$s
            FOR INSERT WITH CHECK (auth.uid() = user_id);
          CREATE POLICY "Users can update own %1$s" ON %1$s
            FOR UPDATE USING (auth.uid() = user_id);
          CREATE POLICY "Users can delete own %1$s" ON %1$s
            FOR DELETE USING (auth.uid() = user_id);
        ', tbl);
      END IF;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- 10. INDEXES ON JUNCTION TABLES
-- ============================================================
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'profile_trackers', 'profile_tasks', 'profile_expenses',
    'profile_events', 'profile_documents', 'profile_obligations',
    'profile_artifacts'
  ]) LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = tbl AND table_schema = 'public') THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%1$s_profile ON %1$s(profile_id)', tbl);
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%1$s_user ON %1$s(user_id)', tbl);
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- 11. NORMALIZE obligation_payments.date to DATE type
--     Current rows may have full ISO timestamps; extract date part.
-- ============================================================
DO $$ BEGIN
  -- Update any existing full-timestamp values to YYYY-MM-DD
  UPDATE obligation_payments
  SET date = LEFT(date, 10)
  WHERE date ~ '^\d{4}-\d{2}-\d{2}T';
END $$;

-- ============================================================
-- 12. BACKFILL parent_profile_id from fields JSON (cleanup)
--     Ensures the real column is always populated from legacy JSONB storage.
-- ============================================================
UPDATE profiles
SET parent_profile_id = (fields->>'_parentProfileId')::UUID
WHERE fields->>'_parentProfileId' IS NOT NULL
  AND parent_profile_id IS NULL
  AND (fields->>'_parentProfileId') ~ '^[0-9a-f-]{36}$'
  AND (fields->>'_parentProfileId')::UUID IN (SELECT id FROM profiles);

-- ============================================================
-- 13. VERIFY — quick schema validation queries
--    These SELECT statements validate the migration completed correctly.
--    They return 0 rows if everything is clean.
-- ============================================================

-- Check for any remaining 'values' column on domain_entries (should return 0 rows)
-- SELECT COUNT(*) as remaining_values_columns
-- FROM information_schema.columns
-- WHERE table_name = 'domain_entries' AND column_name = 'values';

-- Check for duplicate entity_links (should return 0 rows after constraint)
-- SELECT user_id, source_type, source_id, target_type, target_id, COUNT(*) as cnt
-- FROM entity_links
-- GROUP BY user_id, source_type, source_id, target_type, target_id
-- HAVING COUNT(*) > 1;

-- Check for duplicate journal entries per day (should return 0 rows)
-- SELECT user_id, date, COUNT(*) as cnt
-- FROM journal_entries
-- GROUP BY user_id, date
-- HAVING COUNT(*) > 1;
