# Ownership Consolidation Plan — One Source of Truth

**Goal:** Collapse the three competing systems that answer "who owns this entity?" into one. After this lands, the question is answered in one place, read by one function, and written by one function. The class of bug — entity shows under A but not B, dashboard sums disagree with list page — physically cannot recur because there is nothing left to disagree.

---

## The three systems today

Surveyed live (2026-05-28):

1. **JSONB inside each entity row.**
   `expenses.linked_profiles`, `trackers.linked_profiles`, `tasks.linked_profiles`, `events.linked_profiles`, `obligations.linked_profiles`, `habits.linked_profiles`, `goals.linked_profiles`, `artifacts.linked_profiles`, `documents.linked_profiles`, `incomes.linked_profiles`, `journal_entries.linked_profiles`. Plus scalar `tracker_entries.profile_id`.

2. **Per-type junction tables.**
   `profile_expenses`, `profile_trackers`, `profile_events`, `profile_tasks`, `profile_obligations`, `profile_documents`, `profile_artifacts`. (Notably absent: no junction for habits, goals, incomes, journal_entries.)

3. **Relational link tables for finance graph.**
   `asset_party_links`, `liability_profile_links`, `liability_asset_links`, plus the generic `entity_links` graph. These store ownership-with-percentage and role.

**Drift measured on production now:** of 10,308 expenses, 270 are dual-written and agree, 6 dual-written and disagree, 1 in JSONB but missing junction, and the remaining ~10,031 are JSONB-only with no junction row at all. That last group is the silent majority — it's the entire reason filtering and net worth ever disagreed.

---

## Target architecture

**One storage:** the JSONB array `linked_profiles` on the entity row itself, written as canonical UUIDs only. For finance entities (assets/liabilities), the percentage-bearing relational table is the source of truth and `linked_profiles` is a denormalized cache derived from it.

**One reader:** `isInScope` in `shared/scope.ts` (Stage 0, already shipped). Every "is X visible to selection Y?" check goes through this single primitive.

**One writer:** a new `shared/ownership.ts` `setOwners(entityType, id, ownerIds)` function. Every code path that wants to change ownership calls this. It writes the JSONB array, syncs the junction table where one exists, and emits a single audit row. No other code is allowed to write `linked_profiles` or junction tables directly — enforced by a guard test that grep-fails the build if anything outside `shared/ownership.ts` and `server/supabase-storage.ts` touches those columns.

**Junction tables:** become read-only mirrors of JSONB, kept consistent by `setOwners` and a one-time backfill. They stay for now because RLS policies and some indexes depend on them; deleting them is a later, separate decision.

**Relational link tables for finance:** unchanged. They carry semantics JSONB can't (percentage, role, effective dates) and are already the source of truth for net worth. Stage 5 adds a derived sync so `linked_profiles` on the liability/asset row matches the relational table.

---

## Six stages — each small, reversible, test-locked, shippable independently

### Stage 0 — One reader (SHIPPED, commit 25ab1bd)

`shared/scope.ts` created. `profile-filter.ts` and `net-worth.ts` both delegate. 21 unit tests pin behavior including a cross-validation that both callers return the same answer as the primitive. Live-probed on portol.me — no behavior change.

### Stage 1 — One writer (next)

Create `shared/ownership.ts` exporting `setOwners(entityType, entityId, ownerIds, ctx)`. Internally:
1. Validate `ownerIds` is a non-empty `uuid[]` (no names, no slugs, no nulls).
2. Begin atomic update: write `linked_profiles = ownerIds` on the entity row.
3. Sync the matching junction table (delete-then-insert inside the same transaction).
4. Write one row to `audit_log` with `before`/`after` arrays.

Update `server/supabase-storage.ts` createX and updateX methods to call `setOwners` instead of writing the JSONB or junction tables directly. Existing default-to-self fallback (already in 9 of 12 createX) is preserved — it now lives inside `setOwners` instead of being duplicated.

Stage 1 deliverable: every write path goes through one function. Reads still use whatever they used before. **Test-locked by** new contract tests asserting that after create/update/patch, JSONB and junction agree for that row.

### Stage 2 — Backfill the silent majority

One-time migration: for every entity row where `linked_profiles` is non-empty and the matching junction table has no row, insert the missing junction rows. For every row where they disagree, JSONB wins (audit_log records the change for the 6 mismatches and 1 missing). Migration is idempotent and re-runnable.

After Stage 2: `count(*) where jsonb != junction` is **0**, asserted by a new contract test `INV-OWNERSHIP-CONSISTENCY` that runs against live data on every deploy.

### Stage 3 — One reader for filtering (cut the junction-table reads out)

Today, list endpoints in `server/routes.ts` filter via two paths depending on entity type. Some use JSONB (`linked_profiles ? :profileId`), some use the junction table (`exists (select 1 from profile_expenses ...)`). Stage 3 rewrites all list endpoints to use exactly one query shape, going through `isInScope` server-side (or a SQL function `is_in_scope(linked_profiles, selected, self_ids)` that mirrors the TS primitive).

After Stage 3: no application code reads junction tables for filtering. They exist only as a denormalized cache for legacy queries (mostly RLS).

### Stage 4 — Lock the writers

Add a build-time check: `npm run test:contracts` runs a grep that fails the build if any file outside `shared/ownership.ts` and a small allow-list contains a direct `update ... set linked_profiles =` or `insert into profile_<type>`. The pre-push hook already runs contracts, so any future refactor that tries to bring back direct writes loudly fails before reaching CI.

After Stage 4: physically impossible to write ownership outside `setOwners` without removing the guard. Removing the guard requires a deliberate PR.

### Stage 5 — Finance ownership: percentage table as source of truth

For assets (profiles with `type='asset'`) and liabilities (`type='liability'`):

- `asset_party_links` / `liability_profile_links` remain the source of truth (they carry percentage and role; JSONB can't).
- `setOwners` for asset/liability rows is a thin wrapper that updates the relational table, then projects `array_agg(party_profile_id)` back into `linked_profiles` so the read path stays uniform.
- Net worth uses the relational table directly for percentage-weighted math; `isInScope` uses the projected JSONB array for "is this asset visible in selection Y?".

After Stage 5: net worth and visibility never disagree because they read the same set of party IDs, just one with weights and one without.

### Stage 6 — The guardrail test

A single end-to-end contract test, `INV-OWNERSHIP-GUARDRAIL`, that physically recreates the original bug shape and makes it un-bornable:

```
given:
  - selfProfile S, otherProfile A
  - expense E created with linked_profiles=[A.id] only (not S)
  - asset Asset_A with asset_party_links row (A.id, 100%)
when:
  - GET /api/expenses?profileIds=A.id     -> must include E
  - GET /api/expenses?profileIds=S.id     -> must NOT include E
  - GET /api/dashboard-enhanced?profileIds=A.id -> totalAssetValue must equal Asset_A.value
  - GET /api/dashboard-enhanced?profileIds=S.id -> totalAssetValue must NOT include Asset_A
  - INV-OWNERSHIP-CONSISTENCY across the whole DB returns 0 disagreements
then:
  - rewrite E.linked_profiles via setOwners([S.id])
  - GET /api/expenses?profileIds=A.id     -> must NOT include E
  - GET /api/expenses?profileIds=S.id     -> must include E
  - junction table for E must have S.id only, no A.id
```

This test runs on every push via the existing pre-push contracts gate. If any future refactor introduces a divergence, the push fails before deploy. After Stage 6, the bug pattern from this thread cannot return without something loudly failing first.

---

## Ordering and reversibility

| Stage | Touches | Reversible by | Behavior change |
|-------|---------|---------------|-----------------|
| 0 | shared/profile-filter.ts, shared/net-worth.ts, shared/scope.ts | revert 1 commit | none (refactor) |
| 1 | shared/ownership.ts, server/supabase-storage.ts | revert 1 commit | none (write path consolidates) |
| 2 | one-time SQL migration | re-run reverse migration | data only (fixes drift) |
| 3 | server/routes.ts list endpoints | revert 1 commit | none (query shape unifies) |
| 4 | tests/contracts/no-direct-writes.test.ts, ESLint rule | delete the guard | build gate only |
| 5 | shared/ownership.ts (finance branch), shared/net-worth.ts | revert 1 commit | none (projects existing data) |
| 6 | tests/contracts/ownership-guardrail.test.ts | delete the test | none (pure invariant check) |

Every stage ships independently. Every stage has a regression test. After Stage 6 the system is locked.

---

## Status

- Stage 0: shipped, commit `25ab1bd`, live on portol.me, tests green.
- Stage 1: starting now.
- Stages 2-6: queued.

Each stage gets its own commit, its own deploy, its own live verification, before the next one starts.
