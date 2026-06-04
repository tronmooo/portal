-- W4-5: daily net-worth snapshots so the AI can answer "why did my net worth
-- change today" by diffing two days. Additive only — no existing table touched.
CREATE TABLE IF NOT EXISTS net_worth_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL, -- null = aggregate "everyone"
  snapshot_date date NOT NULL,
  assets_total numeric NOT NULL DEFAULT 0,
  liabilities_total numeric NOT NULL DEFAULT 0,
  net_worth numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (user, profile-or-aggregate, day). COALESCE collapses the NULL
-- aggregate profile_id onto a sentinel so the unique index can cover it.
CREATE UNIQUE INDEX IF NOT EXISTS net_worth_snapshots_unique
  ON net_worth_snapshots(user_id, COALESCE(profile_id, '00000000-0000-0000-0000-000000000000'::uuid), snapshot_date);

CREATE INDEX IF NOT EXISTS net_worth_snapshots_user_date
  ON net_worth_snapshots(user_id, snapshot_date DESC);

ALTER TABLE net_worth_snapshots ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='net_worth_snapshots' AND policyname='snapshots_owner') THEN
    CREATE POLICY snapshots_owner ON net_worth_snapshots USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
