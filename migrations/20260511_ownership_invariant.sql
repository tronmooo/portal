-- ============================================================
-- Ownership invariant: SUM(ownership_percentage) <= 100 per asset/liability
-- Auto-equalize on INSERT / DELETE so two owners can't both be 100%.
--
-- Strategy: AFTER trigger that, if SUM > 100, sets every sibling row
-- to floor(100 / N) with remainder going to the first row so SUM = 100.
-- Manual fractional overrides (e.g. 60/40 entered explicitly by the user)
-- are preserved as long as they SUM to <= 100.
-- ============================================================

-- ---- asset_party_links ----
CREATE OR REPLACE FUNCTION enforce_asset_party_ownership_sum()
RETURNS TRIGGER AS $$
DECLARE
  v_asset_id uuid;
  v_user_id uuid;
  v_total numeric;
  v_count int;
  v_base numeric;
  v_remainder numeric;
  v_first_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_asset_id := OLD.asset_profile_id;
    v_user_id := OLD.user_id;
  ELSE
    v_asset_id := NEW.asset_profile_id;
    v_user_id := NEW.user_id;
  END IF;

  SELECT COALESCE(SUM(ownership_percentage), 0), COUNT(*)
    INTO v_total, v_count
  FROM asset_party_links
  WHERE asset_profile_id = v_asset_id AND user_id = v_user_id;

  IF v_count = 0 THEN RETURN NULL; END IF;

  -- If totals are valid, leave alone (preserves manual splits like 60/40).
  IF v_total <= 100 THEN RETURN NULL; END IF;

  -- Total > 100: equalize. floor(100/N) base, remainder to first row.
  v_base := floor(10000.0 / v_count) / 100.0;
  v_remainder := 100 - (v_base * v_count);

  SELECT id INTO v_first_id
  FROM asset_party_links
  WHERE asset_profile_id = v_asset_id AND user_id = v_user_id
  ORDER BY created_at ASC, id ASC
  LIMIT 1;

  UPDATE asset_party_links
  SET ownership_percentage = CASE WHEN id = v_first_id THEN v_base + v_remainder ELSE v_base END,
      updated_at = NOW()
  WHERE asset_profile_id = v_asset_id AND user_id = v_user_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_asset_party_ownership_sum ON asset_party_links;
CREATE TRIGGER trg_asset_party_ownership_sum
AFTER INSERT OR DELETE ON asset_party_links
FOR EACH ROW EXECUTE FUNCTION enforce_asset_party_ownership_sum();

-- ---- liability_profile_links ----
CREATE OR REPLACE FUNCTION enforce_liability_party_ownership_sum()
RETURNS TRIGGER AS $$
DECLARE
  v_liab_id uuid;
  v_user_id uuid;
  v_total numeric;
  v_count int;
  v_base numeric;
  v_remainder numeric;
  v_first_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_liab_id := OLD.liability_profile_id;
    v_user_id := OLD.user_id;
  ELSE
    v_liab_id := NEW.liability_profile_id;
    v_user_id := NEW.user_id;
  END IF;

  SELECT COALESCE(SUM(ownership_percentage), 0), COUNT(*)
    INTO v_total, v_count
  FROM liability_profile_links
  WHERE liability_profile_id = v_liab_id AND user_id = v_user_id;

  IF v_count = 0 THEN RETURN NULL; END IF;
  IF v_total <= 100 THEN RETURN NULL; END IF;

  v_base := floor(10000.0 / v_count) / 100.0;
  v_remainder := 100 - (v_base * v_count);

  SELECT id INTO v_first_id
  FROM liability_profile_links
  WHERE liability_profile_id = v_liab_id AND user_id = v_user_id
  ORDER BY created_at ASC, id ASC
  LIMIT 1;

  UPDATE liability_profile_links
  SET ownership_percentage = CASE WHEN id = v_first_id THEN v_base + v_remainder ELSE v_base END,
      updated_at = NOW()
  WHERE liability_profile_id = v_liab_id AND user_id = v_user_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_liability_party_ownership_sum ON liability_profile_links;
CREATE TRIGGER trg_liability_party_ownership_sum
AFTER INSERT OR DELETE ON liability_profile_links
FOR EACH ROW EXECUTE FUNCTION enforce_liability_party_ownership_sum();

-- ---- Hard CHECK: per-row pct in [0,100] (already enforced in app, formalize here) ----
DO $$ BEGIN
  ALTER TABLE asset_party_links
    ADD CONSTRAINT asset_party_pct_range CHECK (ownership_percentage >= 0 AND ownership_percentage <= 100) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE liability_profile_links
    ADD CONSTRAINT liability_party_pct_range CHECK (ownership_percentage >= 0 AND ownership_percentage <= 100) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- Backfill: equalize every existing asset where SUM > 100 ----
WITH bad AS (
  SELECT asset_profile_id, user_id, COUNT(*) AS n
  FROM asset_party_links
  GROUP BY asset_profile_id, user_id
  HAVING SUM(ownership_percentage) > 100
),
ranked AS (
  SELECT apl.id, apl.asset_profile_id, apl.user_id,
         ROW_NUMBER() OVER (PARTITION BY apl.asset_profile_id, apl.user_id ORDER BY apl.created_at ASC, apl.id ASC) AS rn,
         bad.n
  FROM asset_party_links apl
  JOIN bad ON bad.asset_profile_id = apl.asset_profile_id AND bad.user_id = apl.user_id
)
UPDATE asset_party_links apl
SET ownership_percentage = CASE
      WHEN r.rn = 1 THEN floor(10000.0 / r.n) / 100.0 + (100 - (floor(10000.0 / r.n) / 100.0) * r.n)
      ELSE floor(10000.0 / r.n) / 100.0
    END,
    updated_at = NOW()
FROM ranked r
WHERE apl.id = r.id;
