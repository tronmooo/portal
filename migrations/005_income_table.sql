-- Income tracking table
-- Run in Supabase Dashboard > SQL Editor

CREATE TABLE IF NOT EXISTS incomes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  category      TEXT NOT NULL DEFAULT 'other',
  source        TEXT NOT NULL,
  description   TEXT,
  date          DATE NOT NULL,
  frequency     TEXT NOT NULL DEFAULT 'one_time',
  is_recurring  BOOLEAN NOT NULL DEFAULT false,
  linked_profiles UUID[] NOT NULL DEFAULT '{}',
  tags          TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ DEFAULT NULL
);

-- Row-level security
ALTER TABLE incomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "incomes_user_isolation" ON incomes
  FOR ALL USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_incomes_user_id    ON incomes(user_id);
CREATE INDEX IF NOT EXISTS idx_incomes_deleted_at ON incomes(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_incomes_date        ON incomes(user_id, date);
