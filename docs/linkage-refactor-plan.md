# Profile Linkage Refactor — kill "wrong items on profile" forever
**Date:** 2026-05-10
**Owner:** Computer (autonomous)
**Trigger:** "Why is a fridge linked to iPhone 15?" / "Solve the problem from ever happening again"

## Evidence
Production DB state at the moment of audit:

| Table | Total linked-profile entries | Dangling (profile doesn't exist) | Cross-user leak |
|---|---:|---:|---:|
| expenses | 287 | 0 | 0 |
| events | 244 | 10 | 0 |
| tasks | 178 | 1 | 0 |
| obligations | 131 | 2 | 0 |
| documents | 76 | 12 | 0 |
| habits | 62 | 3 | 1 |
| artifacts | 23 | 0 | 0 |
| goals | 19 | 0 | 0 |
| **Total** | **1020** | **28** | **1** |

288 read sites in code reference `linkedProfiles`. Only 7 read `entity_links`. The jsonb arrays are the de-facto source of truth and have **zero referential integrity**.

## Root cause
1. `linked_profiles` is `jsonb` on 8+ tables. No FK, no CHECK, no type. Postgres accepts any garbage written into it.
2. No allowlist of which entity types can link to which profile types. The AI engine writes whatever profile id it picked, even if "expense → electronics profile" is nonsensical.
3. The UI does `linkedProfiles.includes(profile.id)` plus an ancestor descent walk, so wrong links propagate up the profile tree.

## Fix (root-cause, not patch)

### 1. DB migration (reversible, behind a flag)
- New table `entity_links_v2(user_id uuid, source_type text, source_id uuid, target_type text, target_id uuid)`
  - FK on `(user_id) → users(id) ON DELETE CASCADE`
  - FK on `(target_id) → profiles(id) ON DELETE CASCADE` (the source FK varies by source_type so we enforce via trigger)
  - CHECK that the source row's `user_id` equals `target_id`'s `user_id` (enforced by trigger)
  - UNIQUE `(user_id, source_type, source_id, target_id)`
- New table `entity_link_rules(source_type text, target_profile_type text, PRIMARY KEY (source_type, target_profile_type))` — only listed pairs are legal. Trigger on insert/update consults this table.
- Seed `entity_link_rules` with the sensible set (expense → self/person/pet/vehicle/electronics/property; task → self/person; habit → self/person; etc.).

### 2. Backfill
- Walk every `linked_profiles` jsonb. Drop:
  - non-UUID strings
  - UUIDs that don't resolve to any profile row (28 dangling rows above)
  - UUIDs whose profile belongs to a different user (1 cross-user leak)
  - links that violate `entity_link_rules`
- Insert the survivors into `entity_links_v2`.
- Print a per-table report of dropped rows.

### 3. One canonical server helper
`server/profile-linkage.ts`:
```ts
getEntitiesForProfile(userId, profileId, types?)        // single read path
setLinks(userId, sourceType, sourceId, profileIds[])    // single write path (validates)
removeAllLinks(userId, sourceType, sourceId)            // for deletes
```
Every read + write across the app routes through these. Anywhere else touching `linked_profiles` becomes a lint error.

### 4. Code-mod
- 18 client files + 4 server files. Replace `.filter(x => x.linkedProfiles?.includes(id))` with `entityIds.has(x.id)` where `entityIds` came from the helper.
- AI engine: every tool that creates an entity stops setting `linkedProfiles` directly and instead calls `setLinks` post-create. If validation fails, the tool returns a structured error the model can reason about.

### 5. Kill parent→descendant rollup
Strict per-profile only. The fridge does not show under iPhone 15 even by accident.

### 6. Invariant CI test
`tests/invariants/no-orphan-links.test.ts`:
- Seeds two users.
- Attempts 12 patterns: cross-user link, dangling UUID, type-rule violation, jsonb injection, etc.
- Each must return 4xx **and** the DB must contain zero rows for the attempt.
- Wired into a GitHub Actions PR workflow.

### 7. Cleanup
Next deploy after the migration is stable: `DROP COLUMN linked_profiles` on all eight tables.

## Sequencing
1. Migration + backfill in a transaction → ship.
2. Helper + code-mod → ship behind `?linkage=v2` query flag.
3. Verify on real account that iPhone-15-class profiles only show their own rows.
4. Flip flag to default on.
5. Drop legacy jsonb columns.
6. CI invariant test in place from step 2 onward.

## What this guarantees
- A wrong-profile row is **physically impossible** to insert (DB trigger + FK).
- A wrong-profile row is **physically impossible** to read (single helper enforces).
- A regression is **physically impossible** to merge (CI invariant fails the build).

That is what "solve forever" looks like.
