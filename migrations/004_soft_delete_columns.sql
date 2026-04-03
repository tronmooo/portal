-- Add deleted_at to all tables not yet soft-deleted
-- Run in Supabase Dashboard > SQL Editor

ALTER TABLE events      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE habits      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE artifacts   ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE goals       ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE memories    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Index each for fast filtering (only non-deleted rows are queried)
CREATE INDEX IF NOT EXISTS idx_events_deleted_at       ON events(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_habits_deleted_at       ON habits(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_obligations_deleted_at  ON obligations(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_journal_deleted_at      ON journal_entries(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_deleted_at    ON artifacts(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_goals_deleted_at        ON goals(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_memories_deleted_at     ON memories(user_id, deleted_at);
