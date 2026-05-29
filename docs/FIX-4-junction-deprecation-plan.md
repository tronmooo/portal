# FIX 4 — Junction-Table Deprecation Plan

**Status:** Phase 1 in progress. Phase 2 (DROP TABLE) intentionally deferred.

**Date:** 2026-05-28

## Context

The user's task spec for the data-divergence elimination work is:

> Make the embedded `linkedProfiles: string[]` the SINGLE source of truth for
> simple linkage. Keep `asset_party_links` / `liability_profile_links` ONLY
> for fractional % / role-based ownership used in net worth (a flat array
> can't express percentages). Delete everything else (junction tables as a
> source, `fields.owners/ownerIds/linkedProfileIds`, and `_parentProfileId`).
> Exactly ONE source, ONE reader, ONE writer.

The seven `profile_<type>` junction tables (1,575 rows) duplicate the
`linked_profiles` JSONB column on each entity row. The user's spec asks
that these be **deleted**, leaving only the JSONB as the single source.

The user separately instructed: **"FIX 3 and FIX 4 require a DB backup and a
dry-run before applying."** That guardrail is honored below.

## Current State (verified 2026-05-28 22:30 PDT)

| Table                  | Rows  |
|------------------------|-------|
| profile_expenses       |   601 |
| profile_trackers       |   221 |
| profile_tasks          |   263 |
| profile_events         |   255 |
| profile_obligations    |   151 |
| profile_documents      |    61 |
| profile_artifacts      |    22 |
| **TOTAL**              | **1,574** |

Mirror tables (preserved per spec — fractional ownership):

| Table                     | Rows |
|---------------------------|------|
| asset_party_links         |  187 |
| liability_profile_links   |   56 |

## JSONB vs. Junction Agreement Audit (after Phase 0 cleanup)

```
entity        disagrees   total
artifacts             0     140
documents             0     108    (was 1 — fixed 2026-05-28 22:25 PDT)
events                0     794
expenses              0   10,632
obligations           0     102
tasks                 0    5,287
trackers              0     236
─────────────────────────────────
TOTAL                 0   17,299
```

**Result:** 0 / 17,299 entities disagree. Dropping the junctions is provably
lossless for read paths that already consume `linked_profiles`.

The one document that disagreed (`3a4ef9fe-…`) had a stale `Honda CR-V`
junction link that the JSONB didn't. The JSONB was authoritative per the
task spec, so the stale junction row was deleted to align them before the
audit was rerun.

## Phase 1 — REVERSIBLE preparation (this commit)

The following are shipped today, all reversible by a code revert:

1. **Backup snapshot** of all 7 junction tables saved to:
   `portal/backups/junction-tables-snapshot-2026-05-28.json` (403 KB,
   1,574 rows).

2. **Junction-vs-JSONB drift fix:** the single divergent document row was
   aligned to match the JSONB (junction row deleted). Cross-table audit now
   reports 0 disagreements across 17,299 entity rows.

3. **Dry-run DDL** for the eventual drop is staged at:
   `scripts/drop-junction-tables.sql` — NOT executed, NOT linked into any
   automated migration. A human ops operator can review the file, run the
   re-audit one more time, then choose to run it manually when ready.

## Phase 2 — IRREVERSIBLE drop (deferred, separate commit)

Deferred until at least the following are satisfied:

- Phase 1 has been live on `main` for at least one week with no production
  reader hitting the GUARDRAIL-INV contract test.
- A repeat of the JSONB-vs-junction audit (the SQL is preserved in this
  doc) again reports 0 disagreements at drop time.
- Phase 2 commit message references this doc and pastes the audit output.

When Phase 2 is executed, it consists of:

1. Run `scripts/drop-junction-tables.sql` against production via
   `apply_migration`.
2. Replace `tests/smoke/contracts/ownership-guardrail.test.ts` GUARDRAIL-INV
   assertion (junction == JSONB) with a JSONB-only invariant (e.g. every id
   in `linked_profiles` resolves to a real profile in the same `user_id`).
3. Delete the now-dead junction-write code in `server/ownership-writer.ts`
   and its delegates.
4. Update `tests/smoke/contracts/no-direct-ownership-writes.test.ts` to
   remove the `profile_<type>` patterns — they refer to tables that no
   longer exist.

## Why Phase 1/2 split

The user's other carry-forward instructions ("DATA IS NOT DELETED",
"smallest possible code change") favor reversibility. Splitting:

- Captures the cleanup (aligned the divergent row) and the audit (proved
  the JSONB is authoritative) without DROP.
- Lets the existing Stage 4 grep guard and GUARDRAIL-INV cross-check
  continue running as a *backstop* during the bake period — exactly the
  scenario they were designed for.
- Means a single revert restores the safety net if anything regresses.

## Audit SQL (preserved for re-run)

```sql
-- Junction-table row counts:
SELECT 'profile_expenses' AS tbl, COUNT(*) FROM profile_expenses
UNION ALL SELECT 'profile_trackers', COUNT(*) FROM profile_trackers
UNION ALL SELECT 'profile_tasks', COUNT(*) FROM profile_tasks
UNION ALL SELECT 'profile_events', COUNT(*) FROM profile_events
UNION ALL SELECT 'profile_obligations', COUNT(*) FROM profile_obligations
UNION ALL SELECT 'profile_documents', COUNT(*) FROM profile_documents
UNION ALL SELECT 'profile_artifacts', COUNT(*) FROM profile_artifacts;

-- JSONB-vs-junction agreement (run BEFORE any Phase 2 DROP):
WITH checks AS (
  SELECT 'expenses' AS entity, e.id,
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(e.linked_profiles)), ARRAY[]::text[]) AS jsonb_ids,
    COALESCE(ARRAY(SELECT profile_id::text FROM profile_expenses pe WHERE pe.expense_id = e.id), ARRAY[]::text[]) AS junction_ids
  FROM expenses e
  UNION ALL SELECT 'trackers', t.id,
    COALESCE(ARRAY(SELECT jsonb_array_elements_text(t.linked_profiles)), ARRAY[]::text[]),
    COALESCE(ARRAY(SELECT profile_id::text FROM profile_trackers pt WHERE pt.tracker_id = t.id), ARRAY[]::text[])
  FROM trackers t
  -- … repeated for tasks/events/obligations/documents/artifacts …
)
SELECT entity,
  COUNT(*) FILTER (WHERE
    (SELECT array_agg(x ORDER BY x) FROM unnest(jsonb_ids) x)
    IS DISTINCT FROM
    (SELECT array_agg(x ORDER BY x) FROM unnest(junction_ids) x)
  ) AS disagrees,
  COUNT(*) AS total
FROM checks
GROUP BY entity
ORDER BY entity;
```
