-- ============================================================================
-- LINKAGE V2 — single source of truth for "entity X is linked to profile Y"
-- Replaces 8 jsonb linked_profiles columns with one FK-enforced table.
-- 
-- Reversible: leaves old jsonb columns in place for one deploy cycle.
-- A follow-up migration (after verification) drops them.
-- ============================================================================

BEGIN;

-- 1. The new canonical link table
CREATE TABLE IF NOT EXISTS entity_links_v2 (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  source_type  text NOT NULL CHECK (source_type IN (
                 'expense','task','obligation','event','document',
                 'habit','goal','artifact','journal','tracker_entry'
               )),
  source_id    uuid NOT NULL,
  target_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_type, source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_el2_user_target ON entity_links_v2 (user_id, target_id);
CREATE INDEX IF NOT EXISTS idx_el2_user_source ON entity_links_v2 (user_id, source_type, source_id);

-- 2. Rules table: which source types can link to which profile types
CREATE TABLE IF NOT EXISTS entity_link_rules (
  source_type         text NOT NULL,
  target_profile_type text NOT NULL,
  PRIMARY KEY (source_type, target_profile_type)
);

-- Seed the legal pairs. Update this table to extend the model.
INSERT INTO entity_link_rules (source_type, target_profile_type) VALUES
  -- Expenses can be tied to people, animals, or physical assets that have running costs
  ('expense','self'), ('expense','person'), ('expense','pet'),
  ('expense','vehicle'), ('expense','electronics'), ('expense','property'),
  ('expense','software'), ('expense','subscription'),
  -- Tasks: about a person/animal/asset
  ('task','self'), ('task','person'), ('task','pet'),
  ('task','vehicle'), ('task','electronics'), ('task','property'),
  -- Obligations (recurring bills): self, people, assets that bill
  ('obligation','self'), ('obligation','person'),
  ('obligation','vehicle'), ('obligation','property'),
  ('obligation','electronics'), ('obligation','software'), ('obligation','subscription'),
  -- Events: anything human-centric
  ('event','self'), ('event','person'), ('event','pet'),
  -- Documents: any asset or person
  ('document','self'), ('document','person'), ('document','pet'),
  ('document','vehicle'), ('document','electronics'), ('document','property'),
  ('document','software'), ('document','subscription'),
  -- Habits: self/person only
  ('habit','self'), ('habit','person'),
  -- Goals: self/person/asset
  ('goal','self'), ('goal','person'), ('goal','vehicle'), ('goal','property'),
  -- Artifacts: chat outputs — link to whatever the chat was about
  ('artifact','self'), ('artifact','person'), ('artifact','pet'),
  ('artifact','vehicle'), ('artifact','electronics'), ('artifact','property'),
  ('artifact','software'), ('artifact','subscription'),
  -- Journal: self/person
  ('journal','self'), ('journal','person'),
  -- Tracker entries: self/person/pet
  ('tracker_entry','self'), ('tracker_entry','person'), ('tracker_entry','pet')
ON CONFLICT DO NOTHING;

-- 3. Validation trigger: every insert into entity_links_v2 must
--    (a) point at a profile owned by the same user, and
--    (b) satisfy entity_link_rules.
CREATE OR REPLACE FUNCTION entity_links_v2_validate() RETURNS trigger AS $$
DECLARE
  target_user uuid;
  target_type text;
  rule_exists boolean;
BEGIN
  SELECT p.user_id, COALESCE(p.type_key, 'unknown')
    INTO target_user, target_type
  FROM profiles p WHERE p.id = NEW.target_id;

  IF target_user IS NULL THEN
    RAISE EXCEPTION 'linkage_v2: target profile % does not exist', NEW.target_id
      USING ERRCODE = '23503';
  END IF;

  IF target_user <> NEW.user_id THEN
    RAISE EXCEPTION 'linkage_v2: cross-user link rejected (link user=% profile owner=%)',
      NEW.user_id, target_user
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM entity_link_rules r
    WHERE r.source_type = NEW.source_type AND r.target_profile_type = target_type
  ) INTO rule_exists;

  IF NOT rule_exists THEN
    RAISE EXCEPTION 'linkage_v2: source_type=% cannot link to profile_type=%',
      NEW.source_type, target_type
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entity_links_v2_validate ON entity_links_v2;
CREATE TRIGGER trg_entity_links_v2_validate
  BEFORE INSERT OR UPDATE ON entity_links_v2
  FOR EACH ROW EXECUTE FUNCTION entity_links_v2_validate();

-- 4. RLS so each user only sees their own links
ALTER TABLE entity_links_v2 ENABLE ROW LEVEL SECURITY;

CREATE POLICY entity_links_v2_user_policy ON entity_links_v2
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- 5. Backfill from existing jsonb columns
-- A staging table catches the rows we had to drop, so we can audit afterwards.
CREATE TABLE IF NOT EXISTS entity_links_v2_backfill_rejects (
  source_type text, source_id text, raw_target text,
  reason text, user_id_source uuid, recorded_at timestamptz DEFAULT now()
);

-- One CTE per source table; rejects flow to the staging table.
DO $$
DECLARE
  src record;
  sql text;
  rejected int;
  inserted int;
BEGIN
  FOR src IN
    SELECT * FROM (VALUES
      ('expense','expenses'),
      ('task','tasks'),
      ('obligation','obligations'),
      ('event','events'),
      ('document','documents'),
      ('habit','habits'),
      ('goal','goals'),
      ('artifact','artifacts')
    ) AS t(stype, tbl)
  LOOP
    sql := format($f$
      WITH unnested AS (
        SELECT s.user_id, s.id AS source_id, elem AS raw_target
        FROM %I s, jsonb_array_elements_text(s.linked_profiles) elem
        WHERE jsonb_typeof(s.linked_profiles) = 'array'
      ),
      typed AS (
        SELECT u.user_id, u.source_id, u.raw_target,
               CASE WHEN u.raw_target ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN u.raw_target::uuid ELSE NULL END AS target_uuid
        FROM unnested u
      ),
      classified AS (
        SELECT t.user_id, t.source_id, t.raw_target, t.target_uuid, p.user_id AS target_owner,
               COALESCE(p.type_key,'unknown') AS target_type
        FROM typed t LEFT JOIN profiles p ON p.id = t.target_uuid
      ),
      rejected_rows AS (
        INSERT INTO entity_links_v2_backfill_rejects (source_type, source_id, raw_target, reason, user_id_source)
        SELECT %L, c.source_id::text, c.raw_target,
               CASE
                 WHEN c.target_uuid IS NULL THEN 'not_uuid'
                 WHEN c.target_owner IS NULL THEN 'dangling'
                 WHEN c.target_owner <> c.user_id THEN 'cross_user'
                 WHEN NOT EXISTS (SELECT 1 FROM entity_link_rules r
                                  WHERE r.source_type = %L AND r.target_profile_type = c.target_type)
                      THEN 'type_rule_violation:' || c.target_type
                 ELSE NULL
               END,
               c.user_id
        FROM classified c
        WHERE c.target_uuid IS NULL
           OR c.target_owner IS NULL
           OR c.target_owner <> c.user_id
           OR NOT EXISTS (SELECT 1 FROM entity_link_rules r
                          WHERE r.source_type = %L AND r.target_profile_type = c.target_type)
        RETURNING 1
      ),
      inserted_rows AS (
        INSERT INTO entity_links_v2 (user_id, source_type, source_id, target_id)
        SELECT c.user_id, %L, c.source_id, c.target_uuid
        FROM classified c
        WHERE c.target_uuid IS NOT NULL
          AND c.target_owner = c.user_id
          AND EXISTS (SELECT 1 FROM entity_link_rules r
                      WHERE r.source_type = %L AND r.target_profile_type = c.target_type)
        ON CONFLICT (user_id, source_type, source_id, target_id) DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM rejected_rows), (SELECT count(*) FROM inserted_rows)
    $f$, src.tbl, src.stype, src.stype, src.stype, src.stype, src.stype);

    EXECUTE sql INTO rejected, inserted;
    RAISE NOTICE 'linkage_v2 backfill: % — inserted %, rejected %', src.stype, inserted, rejected;
  END LOOP;
END $$;

-- 6. Summary view of the cleanup, for the deploy log
CREATE OR REPLACE VIEW entity_links_v2_backfill_summary AS
  SELECT source_type, reason, count(*) AS n
  FROM entity_links_v2_backfill_rejects
  GROUP BY source_type, reason
  ORDER BY source_type, n DESC;

COMMIT;

-- After this commit:
--   SELECT * FROM entity_links_v2_backfill_summary;
-- gives the audit of what was dropped.
