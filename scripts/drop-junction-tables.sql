-- FIX 4 — Phase 2 drop migration.  DO NOT RUN until you have:
--
--   1. Read docs/FIX-4-junction-deprecation-plan.md in full.
--   2. Re-run the JSONB-vs-junction audit and confirmed disagrees = 0 for
--      every entity table.  The audit SQL is preserved in that doc.
--   3. Confirmed that portal/backups/junction-tables-snapshot-2026-05-28.json
--      (or a more recent snapshot) exists in the repo.
--   4. Run portal/scripts/migrate-ownership.ts and confirmed STATUS: clean.
--
-- THIS DDL IS IRREVERSIBLE WITHOUT RESTORING FROM THE BACKUP.
--
-- The seven junction tables below are replaced by the `linked_profiles`
-- JSONB column on each parent entity (per the user's spec: "exactly ONE
-- source, ONE reader, ONE writer").  asset_party_links and
-- liability_profile_links remain — they encode fractional / role-based
-- ownership that a flat array cannot express.

BEGIN;

-- Final pre-drop sanity check.  Run this manually first, then comment out
-- before issuing the DROP.  Each line should return 0.
--
-- SELECT COUNT(*)
--   FROM expenses e
--   WHERE (SELECT array_agg(x ORDER BY x) FROM unnest(COALESCE(ARRAY(SELECT jsonb_array_elements_text(e.linked_profiles)), ARRAY[]::text[])) x)
--        IS DISTINCT FROM
--        (SELECT array_agg(x ORDER BY x) FROM unnest(COALESCE(ARRAY(SELECT profile_id::text FROM profile_expenses pe WHERE pe.expense_id = e.id), ARRAY[]::text[])) x);
-- (repeat for trackers / tasks / events / obligations / documents / artifacts)

DROP TABLE IF EXISTS profile_expenses    CASCADE;
DROP TABLE IF EXISTS profile_trackers    CASCADE;
DROP TABLE IF EXISTS profile_tasks       CASCADE;
DROP TABLE IF EXISTS profile_events      CASCADE;
DROP TABLE IF EXISTS profile_obligations CASCADE;
DROP TABLE IF EXISTS profile_documents   CASCADE;
DROP TABLE IF EXISTS profile_artifacts   CASCADE;

COMMIT;
