-- ============================================================
-- Ownership redesign — remove silent auto-equalization (the "50/50" bug).
--
-- The previous trigger (20260511_ownership_invariant.sql) SILENTLY rewrote
-- every owner's percentage to an even split whenever the sum exceeded 100
-- (e.g. adding a 2nd owner to a 100%-owned asset made BOTH 50%). Users never
-- chose 50% — the database invented it.
--
-- New model (single source of truth = shared/ownership-model.ts):
--   * Ownership is EXPLICIT. The application writes the full owner set
--     atomically and validates that it totals exactly 100% (validateOwnership).
--   * The database NO LONGER rewrites percentages. It only guards the per-row
--     range [0,100] and rejects a saved state whose sum EXCEEDS 100 (a hard
--     guardrail; the app enforces the exact-100 rule before it ever gets here).
--   * With no explicit owners, the app attributes the asset to the Self
--     profile at 100% — there is nothing to store, so an asset with zero links
--     is perfectly valid.
-- ============================================================

-- 1) Drop the auto-equalizing triggers + functions.
DROP TRIGGER IF EXISTS trg_asset_party_ownership_sum ON asset_party_links;
DROP FUNCTION IF EXISTS enforce_asset_party_ownership_sum();
DROP TRIGGER IF EXISTS trg_liability_party_ownership_sum ON liability_profile_links;
DROP FUNCTION IF EXISTS enforce_liability_party_ownership_sum();

-- 1b) Drop the "ensure has owner" AFTER DELETE triggers. These auto-inserted a
--     Self 100% link whenever the last owner was removed. Under the new model
--     an item with NO links already means "Self owns 100%" (resolved in the
--     app), so materializing a Self link is redundant AND actively harmful: an
--     atomic owner replacement (delete the old owner, then insert the new one)
--     would see Self auto-added between the two steps, producing two 100% owners
--     (200%) that the equalize trigger then split to 50/50. That is exactly how
--     "Test 50%" appeared. Removing these makes ownership fully explicit.
DROP TRIGGER IF EXISTS trg_asset_has_owner ON asset_party_links;
DROP FUNCTION IF EXISTS ensure_asset_has_owner();
DROP TRIGGER IF EXISTS trg_liability_has_owner ON liability_profile_links;
DROP FUNCTION IF EXISTS ensure_liability_has_owner();

-- 2) Guardrail: reject (do NOT rewrite) a state whose sum exceeds 100.
--    A tiny epsilon absorbs float rounding (e.g. 33.33 * 3 = 99.99).
--    The application writes owners by replacing the whole set, so the sum only
--    grows from 0 and a valid 100% set never trips this.
CREATE OR REPLACE FUNCTION guard_asset_party_ownership_sum()
RETURNS TRIGGER AS $$
DECLARE
  v_total numeric;
BEGIN
  SELECT COALESCE(SUM(ownership_percentage), 0) INTO v_total
  FROM asset_party_links
  WHERE asset_profile_id = NEW.asset_profile_id
    AND user_id = NEW.user_id
    AND lower(coalesce(role, 'owner')) IN ('owner', 'co_owner', 'co-owner');
  IF v_total > 100.05 THEN
    RAISE EXCEPTION 'Ownership for asset % would total % percent (must not exceed 100)', NEW.asset_profile_id, v_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_asset_party_ownership_guard ON asset_party_links;
CREATE CONSTRAINT TRIGGER trg_asset_party_ownership_guard
AFTER INSERT OR UPDATE ON asset_party_links
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION guard_asset_party_ownership_sum();

CREATE OR REPLACE FUNCTION guard_liability_party_ownership_sum()
RETURNS TRIGGER AS $$
DECLARE
  v_total numeric;
BEGIN
  SELECT COALESCE(SUM(ownership_percentage), 0) INTO v_total
  FROM liability_profile_links
  WHERE liability_profile_id = NEW.liability_profile_id
    AND user_id = NEW.user_id
    AND lower(coalesce(role, 'owner')) IN ('owner', 'co_owner', 'co-owner');
  IF v_total > 100.05 THEN
    RAISE EXCEPTION 'Ownership for liability % would total % percent (must not exceed 100)', NEW.liability_profile_id, v_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_liability_party_ownership_guard ON liability_profile_links;
CREATE CONSTRAINT TRIGGER trg_liability_party_ownership_guard
AFTER INSERT OR UPDATE ON liability_profile_links
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION guard_liability_party_ownership_sum();

-- NOTE: we intentionally do NOT backfill/rewrite existing percentages. Assets
-- that the old trigger split to 50/50 keep those values until the user
-- re-assigns them in the redesigned ownership editor — the system must never
-- silently change ownership numbers again.
