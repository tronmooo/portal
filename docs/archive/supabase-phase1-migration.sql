-- ============================================================
-- Phase 1 Migration — Fix Active Runtime Failures
-- Run against Supabase SQL Editor
-- ============================================================

-- 1. Fix journal mood CHECK constraint (data loss bug — 3 of 8 mood values rejected)
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_mood_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_mood_check 
  CHECK (mood IN ('amazing','great','good','okay','neutral','bad','awful','terrible'));

-- 2. Add parent_profile_id column (enables nested profile rendering)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='parent_profile_id') THEN
    ALTER TABLE profiles ADD COLUMN parent_profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_profiles_parent ON profiles(parent_profile_id) WHERE parent_profile_id IS NOT NULL;

-- Migrate existing _parentProfileId from JSONB fields to the real column
UPDATE profiles 
SET parent_profile_id = (fields->>'_parentProfileId')::UUID
WHERE fields->>'_parentProfileId' IS NOT NULL 
  AND parent_profile_id IS NULL
  AND (fields->>'_parentProfileId')::UUID IN (SELECT id FROM profiles);

-- 3. Add obligations.status column (enables pause/cancel without deleting)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='obligations' AND column_name='status') THEN
    ALTER TABLE obligations ADD COLUMN status TEXT DEFAULT 'active' CHECK (status IN ('active','paused','cancelled'));
  END IF;
END $$;

-- 4. Add UNIQUE constraint on habit_checkins (prevents duplicate check-ins per day)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'habit_checkins_unique_day') THEN
    -- Remove exact duplicates first (keep the earliest)
    DELETE FROM habit_checkins a USING habit_checkins b
    WHERE a.habit_id = b.habit_id AND a.date = b.date AND a.id > b.id;
    ALTER TABLE habit_checkins ADD CONSTRAINT habit_checkins_unique_day UNIQUE (habit_id, date);
  END IF;
END $$;

-- 5. Add UNIQUE constraint on memories (prevents duplicate keys per user)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_unique_key') THEN
    -- Remove exact duplicates first (keep the latest)
    DELETE FROM memories a USING memories b
    WHERE a.user_id = b.user_id AND a.key = b.key AND a.updated_at < b.updated_at;
    ALTER TABLE memories ADD CONSTRAINT memories_unique_key UNIQUE (user_id, key);
  END IF;
END $$;

-- 6. Add missing indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date);
CREATE INDEX IF NOT EXISTS idx_obligations_user_due ON obligations(user_id, next_due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_user_due ON tasks(user_id, due_date);
CREATE INDEX IF NOT EXISTS idx_habit_checkins_habit_date ON habit_checkins(habit_id, date);
CREATE INDEX IF NOT EXISTS idx_tracker_entries_tracker_time ON tracker_entries(tracker_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_goals_user_status ON goals(user_id, status);

-- 7. Add updated_at to tables that are missing it
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trackers' AND column_name='updated_at') THEN
    ALTER TABLE trackers ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='updated_at') THEN
    ALTER TABLE tasks ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='expenses' AND column_name='updated_at') THEN
    ALTER TABLE expenses ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='events' AND column_name='updated_at') THEN
    ALTER TABLE events ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='habits' AND column_name='updated_at') THEN
    ALTER TABLE habits ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='obligations' AND column_name='updated_at') THEN
    ALTER TABLE obligations ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='documents' AND column_name='updated_at') THEN
    ALTER TABLE documents ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $$;

-- 8. Add created_at to obligation_payments
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='obligation_payments' AND column_name='created_at') THEN
    ALTER TABLE obligation_payments ADD COLUMN created_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $$;
