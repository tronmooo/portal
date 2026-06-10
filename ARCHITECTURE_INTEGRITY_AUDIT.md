# Architectural Integrity Audit — Full Application

**Date:** 2026-06-10
**Scope:** Every major system: Ownership, Relationships, Profile filtering, Assets, Liabilities, Documents, Trackers, Tasks, Events, Habits, Budgets, Dashboard metrics, Linked records, Search, Analytics, AI-generated data.
**Method:** Six parallel code investigations over `client/src`, `server/`, `shared/`, verified against the live code (not the docs). Spot-checks confirmed contested findings (`/api/trackers`, `/api/habits`, `/api/export`, server cache busting). Prior audit (`audit/stabilization-findings.md`, 62 findings) and its contract (`ARCHITECTURE.md`) were used as a baseline to distinguish *fixed*, *never fixed*, and *regressed*.

---

## 0. Executive Summary — Why fixing one bug breaks another

The app has **five root causes**, not dozens of independent bugs. Every symptom you described maps onto one of them:

| # | Root cause | Your symptom |
|---|---|---|
| RC-A | **Ownership is stored in three unsynchronized representations** (JSONB `linked_profiles` arrays, `asset_party_links`, `liability_profile_links`) with 6+ write paths that bypass the single ownership writer | "Ownership changes don't update everywhere", "data appears in the wrong profiles" |
| RC-B | **The profile-filter rule is forked into ~12 inline reimplementations** that disagree on orphan handling, and server endpoints treat `?profileId=` and `?profileIds=` with different semantics | "Filters work on some pages but not others" |
| RC-C | **Multiple write pipelines per entity** (page form, QuickCreate, AI chat, smart-fill, extraction, import) with different validation, normalization, and ownership defaults | "Linked relationships become disconnected", malformed AI records |
| RC-D | **Multi-step mutations are non-transactional** (delete-profile cascade, create-then-link, read-modify-write JSON without versioning) | Silent data loss/corruption under concurrency |
| RC-E | **The architecture contract exists but is enforced only by convention.** `ARCHITECTURE.md` says "inline filters are forbidden" — yet 12 exist today. Nothing (lint, CI, contract test) stops the next one. | "When one thing is fixed, another area breaks later" |

**The good news:** the financial calculation layer (asset value, liability balance, net worth, monthly conversion) was successfully consolidated into `shared/` modules and is now largely a single source of truth. That consolidation is the template — the same treatment has *not* been applied to filtering, ownership writes, or entity creation, which is where today's instability lives.

**The structural fix** is in §4: make the canonical path the *only possible* path (DB constraints, one service layer, lint bans, contract tests), instead of the *recommended* path.

---

## 1. Per-System Findings

Severity key: 🔴 Critical · 🟠 High · 🟡 Medium · ⚪ Low
Each finding lists: where the source of truth is, where duplicates/divergence exist, and the failure mode.

### 1.1 Ownership

**Source of truth — currently THREE, unsynchronized (🔴 OWN-001):**
1. JSONB `linked_profiles` arrays on every entity row (11 entity types per `shared/ownership.ts:59-71`) — unordered IDs, no roles/percentages.
2. `asset_party_links` table — fractional ownership (0–100%) + roles (`shared/schema.ts:1101-1112`).
3. `liability_profile_links` table — same for liabilities.

The dashboard reads ONLY the junction tables for assets/liabilities (`server/supabase-storage.ts:4383-4392`), while entity filtering reads ONLY the JSONB arrays. Nothing keeps them in sync after the one-time backfill in `migrations/005_relationships_module.sql`. An asset can be 60% Alice in `asset_party_links` while its `linked_profiles` says something else entirely — Alice's profile page and the dashboard then disagree.

**Duplicate write logic (🔴 OWN-002):** `server/ownership-writer.ts:113-246` (`setOwners()`) is the declared single writer, but at least six paths bypass it and write `linked_profiles` directly:
- `deleteProfile()` cascade — `supabase-storage.ts:1228, 1241, 1255, 1268, 1281, 1294, 1307, 1320, 1335, 1348`
- `migrateUnlinkedTrackersToSelf()` — `supabase-storage.ts:1735`
- `propagateDocumentToAncestors()` — `supabase-storage.ts:1660`
- `updateTask()` / `updateGoal()` accept `linkedProfiles` in the patch body and write it raw — `supabase-storage.ts:2055, 3746`
- `setAssetOwners()` (`supabase-storage.ts:5533-5581`) touches ONLY junction tables, never JSONB (🔴 OWN-004)

**Duplicate read logic (🟠 OWN-005):** two independent "who owns X" implementations — `shared/ownership-model.ts:59-82` (`resolveOwners`, junction-based) vs `passesProfileFilter()` (JSONB-based). They can return different answers for the same entity.

**Updates fail to propagate (🟠 OWN-006):**
- `ownership_history` table exists, is RLS'd, and is **never written** — `recordOwnershipHistory()` (`supabase-storage.ts:5599-5618`) is defined but has zero callers. Transfer-ownership has no audit trail.
- After an ownership PUT, derived data (dashboard breakdowns, profile-detail embeds) updates only via client cache invalidation convention; there is no server-side dependency.

**Race conditions (🔴 RC-001):** `deleteProfile()` (`supabase-storage.ts:1176-1391`) is a non-transactional read-then-loop-update across ~10 entity types. A concurrent `linkProfileTo()` between the read and the write is silently lost (last-write-wins on the whole array).

**Creation inconsistency (🟡 OWN-003):** trackers/documents write JSONB inline then call `linkProfileTo` (two writes, inconsistent window); tasks/expenses insert empty then `setOwners()`; AI pre-resolves a target profile and passes it raw with no existence validation (`ai-engine.ts:6166-6170`).

### 1.2 Relationships (profile ↔ profile)

**Source of truth:** there is no relationship graph. The only profile-to-profile links are `parentProfileId` (nesting, explicitly *not* ownership per `ownership-model.ts:59-82`) and the directed ownership junctions (🟡 REL-001).
- No spouse/child/member-of schema; if the product behaves as if these exist, they are inferred ad hoc per page.
- All links are directed edges with no enforced bidirectionality (🟡 REL-002); "who links to me" requires a reverse scan.
- `wouldCreateCycle()` exists for profile updates but AI `CREATE_PROFILE` doesn't run it (cycle risk on AI-created hierarchies).

### 1.3 Profile filtering — the worst-forked system

**Source of truth (correct, well-designed):**
- Rule: `shared/profile-filter.ts:64-73` → `shared/scope.ts:64-94` (`isInScope`). Canonical orphan policy: *entities with no `linkedProfiles` belong to the self profile* (`belongs_to_self`); *profiles with no ownership candidates are out of scope*.
- Client filter state: `client/src/lib/profileFilter.ts` — localStorage namespaced per user (v5), CustomEvent broadcast, cleared on logout. This part is solid.

**Duplicate logic — 12 divergent implementations (🔴 FILTER-001…012):**

| Site | Defect |
|---|---|
| `server/routes.ts:3074` `/api/trackers?profileIds=` | inline `.some()` — **drops orphans** |
| `server/routes.ts:3844` `/api/events` | inline `.some()` — drops orphans (birthdays vanish under filter) |
| `server/routes.ts:3589` `/api/expenses?profileIds=` | multi-profile drops orphans; single `?profileId=` (3594-3596) handles them — **same endpoint, two semantics** |
| `server/routes.ts:4149-4151` `/api/habits?profileIds=` | same asymmetry (single-profile branch at 4152-4158 is correct) |
| `server/routes.ts:4248` `/api/obligations?profileIds=` | same asymmetry |
| `client/src/pages/artifacts.tsx:719-723` | inline `.some()` — drops orphans; also no server-side filtering at all for `/api/artifacts` |
| `client/src/pages/tasks.tsx:544-547` | client inline filter drops orphans (server `/api/tasks` at routes.ts:3418-3425 is correct — page and API disagree) |
| `client/src/lib/filter-utils.ts:36-49` `filterByProfile()` | exported helper that **unconditionally hides orphans** — a trap for every future caller |
| `client/src/pages/trackers.tsx:3772-3789` | hand-rolled `isAssetInScope`/`isLiabilityInScope` (parent + co-owner logic reinvented) |
| `client/src/pages/dashboard.tsx:531` | hand-rolled `matchesProfileFilter` — checks `parentProfileId` only, misses grandparents and `asset_party_links` co-owners |
| `client/src/lib/profileFilter.ts:221` legacy `passesFilter()` | conservative, non-canonical; still exported |
| `client/src/pages/habits.tsx:46` | optimistic update via unfiltered query key — checkin can land in the wrong filter's cache (~300 ms window) |

Correct reference implementations that everything should converge to: `routes.ts:4720-4724` (journal), `routes.ts:3418-3425` (tasks), `finance.tsx:594/831/870`, `ObligationsManager.tsx:1003`, `CalendarView.tsx:1070`, `dashboard-bootstrap` (routes.ts:1930).

**Filter ignored entirely:** AI chat (`/api/chat` accepts no profileIds — AI answers from ALL profiles while the user looks at a filtered view), `/api/export` (exports everything; see §1.15), profile-detail page (by design, but undocumented).

**Why this is RC-B:** the orphan rule is the subtle 20% of the filter; every inline copy gets the easy 80% right and the orphan rule wrong, so each page "mostly works" and fails differently.

### 1.4 Assets · 1.5 Liabilities — largely consolidated ✅, two drift seeds

**Source of truth:** `shared/asset-value.ts` (`resolveAssetValue` 48-83, `resolveLiabilityBalance` 88-130, canonical type sets at 139-159), used by server `getDashboardEnhanced` (`supabase-storage.ts:4396/4406`), `dashboard.tsx:7`, `finance.tsx:5`. `shared/liability-calc.ts` (amortization) is cleanly isolated to `liability-detail.tsx`. Asset rollup (`shared/asset-rollup.ts`) is UI-only and does not double-count into net worth (verified `asset-rollup.ts:181-276`).

**Residual duplicates:**
- 🟡 `HeroKPIPopups.tsx:47-103` carries a **hand-copied** fallback of both resolvers. Identical today; will silently diverge the next time `asset-value.ts` adds a field path. (Same class of bug as the original four net-worth implementations.)
- 🟡 `shared/asset-rollup.ts:93-114` uses its own multipliers `4.345` and `30.44` instead of `toMonthlyAmount` (52/12 ≈ 4.3333, 365/12 ≈ 30.4167) — the Financials-tab monthly cost disagrees with every other monthly number by cents.

**Ownership-share gap (feeds RC-A):** net worth is junction-table-share aware; per-page asset lists are JSONB-filtered. After an ownership transfer via `OwnershipEditor`, the dashboard moves the value but the profile pages move nothing (JSONB untouched, OWN-004).

### 1.6 Documents

- Storage is dual: Supabase Storage bucket + legacy `file_data` base64 column with a migration path (`supabase-storage.ts:2973-3004`) — acceptable, but reads must keep handling both forever.
- Delete is soft and propagates well (clears `linked_profiles`, removes from owner profiles' `documents` arrays, best-effort bucket delete — `supabase-storage.ts:2923-2957`). ✅
- 🟡 `propagateDocumentToAncestors()` (`supabase-storage.ts:1633-1666`) writes `linked_profiles` directly (ownership-writer bypass) — a document's ownership can disagree with what `setOwners` would produce.
- Document links live in BOTH `linked_profiles` and `profiles.documents` arrays — two-sided array maintenance done by hand at each write site (RC-D pattern).

### 1.7 Trackers

- 🔴 Server filter drops orphan trackers (`routes.ts:3074`, §1.3).
- 🟡 Entry normalization (`server/tracker-normalize.ts`) is applied on `POST /api/trackers/:id/entries` (routes.ts:3156) and AI `log_tracker_entry`, but the smart-entry/extraction path (`routes.ts:3339-3439`) is not verified to normalize — unnormalized entries poison aggregates.
- 🟡 Three creation paths (UI, AI, smart-entry) with different linked-profile defaults (RC-C).
- Server response cache: `trackers:{uid}` 5-min TTL (routes.ts:3064-3066), busted on every write via middleware (routes.ts:546-573) — but **per instance only**; see §1.16.

### 1.8 Tasks

- Single server creation path with schema validation ✅; server filter handles orphans correctly (routes.ts:3418-3425) ✅.
- 🟠 Client page re-filters with the broken inline rule (`tasks.tsx:544-547`) — the page hides orphan tasks that the API correctly returned.
- Soft delete + restore endpoint ✅.

### 1.9 Events / Calendar

- 🟠 Two recurrence engines: obligations use `obligation-engine.ts:63-135` (730-day horizon, persisted occurrences, 500 cap); events use an inline loop capped at **45 occurrences** inside `getCalendarTimeline` (`supabase-storage.ts:2376-2394`). Long-recurring events fall off the calendar where bills don't.
- 🟠 `/api/events` server filter drops orphan events (routes.ts:3844).
- 🟡 Events are the only entity with **hard delete** (no `deleted_at` — `supabase-storage.ts:2337`); no undo, and pre-materialized timeline rows for cancelled obligations can linger.
- Timeline merge (events + occurrences + virtual fallback + tasks-with-due-dates, habits excluded) lives in ONE place (`supabase-storage.ts:2345-2510`) ✅, with fingerprint dedupe — keep it that way.

### 1.10 Habits

- 🟠 **Four streak implementations**: server `calculateStreak()` (`storage.ts:464-512`, timezone-aware via `getUserToday`), client optimistic bump (`habits.tsx:57/104`), client `today = new Date().toLocaleDateString('en-CA')` (`habits.tsx:28-29`, **browser timezone, not user timezone**), and a third independent `getStreak()` in `profile-detail.tsx:5688-5701`. Users see different streaks on different pages, and wrong streaks when browser ≠ configured timezone.
- 🟠 `/api/habits?profileIds=` drops orphans (routes.ts:4149-4151).
- 🟡 `linkedProfiles` isn't in `insertHabitSchema`; routes.ts:4179 patches it post-create (two-step create, RC-D window).

### 1.11 Budgets

- Budgets stored as JSON in the preferences table (`supabase-storage.ts:4705-4785`); "spent" computed server-side in `getDashboardEnhanced` (`supabase-storage.ts:4347-4350`) and consumed by the popup without client recomputation ✅.
- 🟠 **Hardcoded timezone**: `HeroKPIPopups.tsx:614` computes the current month with `timeZone: 'America/Los_Angeles'` while the server uses the user's configured timezone (`supabase-storage.ts:4233`). For any user not in Pacific time, the budget popup can be examining a different month than the server near month boundaries.
- Note: prior fix `BUG-20260528-budget-keep-previous-leak` (placeholderData) is in place ✅.

### 1.12 Dashboard metrics

- `/api/stats`, `/api/dashboard-enhanced`, `/api/dashboard-bootstrap` now share window constants (`UPCOMING_BILL_WINDOW_DAYS = 30`), `toMonthlyAmount`, and `passesProfileFilter` ✅ (the old 7-vs-30-day and 4.33-vs-52/12 bugs are genuinely fixed).
- 🟡 Tile-then-popup fallback chains (`enhanced ?? stats ?? 0`) still allow transient disagreement while the two endpoints load at different speeds.
- 🟡 `dashboard.tsx:531` hand-rolled scope check (§1.3) makes the HeroKPI section the one dashboard area that can disagree with the server snapshot.
- Dashboard recomputes everything from scratch per request — no rollup tables; correctness is fine, cost is O(all entities) per load (P5).

### 1.13 Linked records (entity ↔ entity)

- 🟠 LINK-001: `entity_links` are **unidirectional** rows; `cleanupEntityLinks()` (`supabase-storage.ts:3955-3963`) deletes where the deleted entity is source OR target, but there's no reverse index and `entity_links_v2` (`migrations/20260511_linkage_v2.sql:20-22`) permits duplicate A→B / B→A pairs that can half-die.
- 🟠 Editor mentions are **plain text**, not entity links (`client/src/lib/editor-mentions.ts:34-52`). Rename a profile → every mention is stale; delete a profile (routes.ts:2581-2594 does not touch documents) → dead mentions. The `entity_links` table exists but is not populated from mentions.

### 1.14 Search

- One dedicated `/api/search` endpoint (routes.ts:5184-5228) that applies the profile filter AND is co-ownership aware (`itemVisibleForSelection`, line 5217) ✅. `CommandSearch.tsx:226-230` passes the live filter ✅.
- 🟡 Search's ownership logic (junction-aware) is *more correct* than most list endpoints (JSONB-only) — search can find an item that the page list then refuses to show. Consistency, not search, is the bug.

### 1.15 Analytics / Insights / Export / AI-generated data

- 🟠 **Three spending-analysis implementations**: `insights-engine.ts:70-116`, `weekly-review.ts:43-197` (independent baseline/category/anomaly math, 90-day window), and the dashboard snapshot. Insights and weekly review can report different anomalies for the same data.
- 🟠 **AI write paths bypass the pipeline (RC-C):**
  - `ai-engine.ts:4145-4152` create_profile → no `setOwners`, no zod validation, no cycle check;
  - `ai-engine.ts:1111-1130, 5820-5838` create-then-link in two steps (orphan window, no rollback);
  - `extraction-normalize.ts` applied on document-confirm (routes.ts:1478-1492) but not on most AI ingest paths;
  - `ai-engine.ts:6209-6228` persists unvalidated `fields` shapes.
- 🟠 **AI chat ignores the profile filter** (request-scoped to user, but sees all profiles regardless of UI filter) — answers can reference filtered-out data, which reads as "data in the wrong profile".
- 🟡 Sanitization (`ai-summary-sanitizer.ts`) applied on `/api/profiles/:id/ai-summary` (routes.ts:2793) but NOT on chat context, extraction, or smart-fill — inconsistent PII exposure to the model.
- 🟠 `/api/export` (routes.ts:5305-5341) exports **all** data unfiltered, with no indication that the active filter is ignored.
- Share links (routes.ts:4649-4701) correctly strip `linked_profiles` and gate on token ✅. Goals have a single computation path ✅.
- 🟡 Insights/AI-digest react-query caches are only invalidated via the `dashboard` domain, which no mutation triggers (`cache-bus.ts:162-165`) — stale advice after data changes.

### 1.16 Caching & state (cross-cutting)

Healthy: query-key discipline ~85-90% via `shared/query-keys.ts`; `cache-bus.ts` domain map is comprehensive; optimistic mutations use cancel/rollback (`cache-bus.ts:274-296`); per-user cache isolation on login/logout is excellent (`cache-isolation.ts:60-89`, `queryClient.ts:314-328`, `auth.tsx:115-134`) — **no cross-user leak found**.

Gaps:
- 🟠 **Server in-memory response cache is per-instance.** Write middleware busts every prefix (routes.ts:546-573) but only on the instance that served the write. On Vercel with >1 warm instance, reads from another instance serve up to 5-min-stale trackers/habits/profiles (TTLs at routes.ts:3066, 4146, 530-532). Same for the token cache and auto-profile seed guard (`auth.ts:24-126`).
- 🟡 Child-asset edits don't invalidate the parent's rollup view (mutation doesn't know the parent id).
- 🟡 localStorage cache snapshot silently skips persistence over 2.5 MB (`queryClient.ts:296`) — power users get cold caches with no signal.
- 🟡 Two legacy traps still exported: `profileFilter.ts:221 passesFilter`, `profileFilter.ts:239-252 getDashboardProfileFilter` — future callers will use them and reintroduce bugs.

---

## 2. End-to-End Workflow Verification

| Workflow | Status | Weakest link |
|---|---|---|
| **Create** | ⚠️ | 1–3 paths per entity; AI/extraction paths skip validation, normalization, ownership-writer (RC-C) |
| **Update** | ⚠️ | Read-modify-write with no version check (RC-002); `linkedProfiles` writable via generic PATCH, bypassing writer |
| **Delete** | 🔴 | Non-transactional cascade with lost-update race (RC-001); events hard-delete; mentions/entity-links half-cleaned |
| **Transfer ownership** | 🔴 | Updates junction tables only; JSONB, history table, and profile pages never learn (OWN-004/006) |
| **Filter** | 🔴 | 12 divergent implementations; orphan rule wrong on 5 server endpoints + 3 client pages (RC-B) |
| **Dashboard** | ✅/⚠️ | Server snapshot is canonical and correct; HeroKPI local scope check + popup fallback copies are the drift seeds |
| **Analytics** | ⚠️ | Three spending baselines; insights cache never invalidated by mutations |
| **Linked records** | ⚠️ | Unidirectional links, no reverse index; mentions are text-only |
| **Search** | ✅ | Correct — and *more* correct than list pages (inconsistency surfaces there) |
| **AI chat** | 🔴 | Ignores profile filter; writes bypass pipeline; partial sanitization |
| **Export** | ⚠️ | Ignores filter entirely, silently |
| **Refresh** | ⚠️ | Per-instance server cache → cross-instance staleness up to 5 min |
| **Logout/Login** | ✅ | Cache isolation is genuinely solid (uid-stamped snapshots, namespaced filter, full clear) |

---

## 3. Remediation Plan (ordered by impact)

Effort: S < ½ day · M ≈ 1–2 days · L ≈ 3–5 days · XL ≈ 1–2 weeks

### P0 — Data corruption risks
| ID | Fix | Effort |
|---|---|---|
| P0.1 | Move the `deleteProfile` cascade into a single Postgres function (RPC) so it is atomic; stop the read-then-loop-update in app code (RC-001) | L |
| P0.2 | Add optimistic concurrency to all `updateX` read-modify-write paths (compare `updated_at`, reject on mismatch) (RC-002) | M |
| P0.3 | Make AI/extraction writes use the same pipeline as UI writes: zod-validate against `insert*Schema`, run `extraction-normalize` + `tracker-normalize`, set ownership atomically in the insert (no create-then-link), validate target profile exists, run `wouldCreateCycle` on AI profile creation | L |
| P0.4 | Fix `entity_links` lifecycle: dedupe A→B/B→A, add `(target_type, target_id)` index, make `cleanupEntityLinks` run for every entity delete | M |
| P0.5 | Background consistency repair: extend `getOwnershipConsistency()` (supabase-storage.ts:1402) into a scheduled job that strips dangling profile IDs from `linked_profiles` | S |

### P1 — Incorrect financial calculations
| ID | Fix | Effort |
|---|---|---|
| P1.1 | `HeroKPIPopups.tsx:614` — replace hardcoded `America/Los_Angeles` with the user's timezone (month-boundary budget errors for every non-Pacific user) | S |
| P1.2 | Delete the hand-copied resolvers in `HeroKPIPopups.tsx:47-103`; import from `shared/asset-value.ts` | S |
| P1.3 | `shared/asset-rollup.ts:93-114` — replace 4.345/30.44 with `toMonthlyAmount` | S |
| P1.4 | Extract one spending-baseline module used by `insights-engine.ts` and `weekly-review.ts` | M |
| P1.5 | Guarantee tracker smart-entry/extraction paths run `normalizeTrackerEntry` | S |

### P2 — Ownership inconsistencies (RC-A)
| ID | Fix | Effort |
|---|---|---|
| P2.1 | **Decide the single ownership store.** Recommended: junction tables are truth; `linked_profiles` becomes a denormalized read model maintained by a DB trigger on the junction tables (so every reader — filters, dashboards, search — converges automatically) | XL |
| P2.2 | Until P2.1 lands: make `setOwners()`/`setAssetOwners()` the only writers — remove `linkedProfiles` from generic PATCH bodies (tasks/goals/etc.), route `propagateDocumentToAncestors` and `migrateUnlinkedTrackersToSelf` through the writer | M |
| P2.3 | Write `ownership_history` from both writers; surface it on transfer | S |
| P2.4 | Unify the orphan-filter rule (RC-B): replace the 8 broken server/client inline filters (routes.ts:3074, 3589, 3844, 4151, 4248; artifacts.tsx:722; tasks.tsx:547; filter-utils.ts:45) with `passesProfileFilter`; kill the single-vs-multi-param asymmetry by funneling both through one helper | M |
| P2.5 | Delete the legacy traps: `filterByProfile()`, `passesFilter()`, `getDashboardProfileFilter()` | S |

### P3 — Relationship inconsistencies
| ID | Fix | Effort |
|---|---|---|
| P3.1 | Replace text mentions with `entity_links`-backed references (store ID, render current name); clean links on entity delete | L |
| P3.2 | If profile relationships (spouse/child/member) are a product concept, add an explicit `profile_relationships` table with enforced inverse rows — stop inferring | L |
| P3.3 | Server-side filtering for `/api/artifacts` (currently client-only) | S |

### P4 — Dashboard inaccuracies
| ID | Fix | Effort |
|---|---|---|
| P4.1 | Replace `dashboard.tsx:531` and `trackers.tsx:3772-3789` hand-rolled scope checks with `isInScope`/server snapshot | M |
| P4.2 | One streak implementation: server computes (timezone-aware), client only displays + optimistic ±1; delete `profile-detail.tsx:5688-5701` copy; fix `habits.tsx:28` browser-timezone "today" | M |
| P4.3 | Unify recurrence: expand events through `obligation-engine`-style materialization or at least the same horizon (45-cap → windowed expansion) | M |
| P4.4 | Add insights/ai-digest to mutation invalidation domains (`cache-bus.ts`) so analytics refresh after writes | S |
| P4.5 | Pass the active profile filter to `/api/chat` and scope AI read context with `passesProfileFilter`; apply sanitizer on all AI read paths | M |

### P5 — Performance / staleness
| ID | Fix | Effort |
|---|---|---|
| P5.1 | Fix cross-instance server-cache staleness: per-user version counter (DB or KV) checked on cache read, or drop the in-memory response cache for entity lists and rely on client cache | M |
| P5.2 | Invalidate parent profile detail when a child asset changes (server returns `parentProfileId` in mutation response; client busts it) | S |
| P5.3 | Log/telemetry when the 2.5 MB localStorage snapshot cap is hit | S |
| P5.4 | (Later) rollup table for dashboard aggregates if O(all-entities)-per-load becomes measurable | XL |

### P6 — UI consistency
| ID | Fix | Effort |
|---|---|---|
| P6.1 | Remove `stats` fallbacks on dashboard tiles once `dashboard-enhanced` is the sole driver (no transient count flips) | S |
| P6.2 | Export: apply the active filter or show an explicit "exports everything" notice | S |
| P6.3 | Soft-delete for events (parity with every other entity, enables undo) | M |

---

## 4. Redesign: making this class of bugs impossible (RC-E)

The previous remediation round proved the pattern works — financial math stopped regressing the moment it was extracted to `shared/` and consumed everywhere. The failure mode is that *nothing enforces* the pattern. Four enforcement layers, cheapest first:

1. **Lint gates (1 day, highest leverage).** ESLint `no-restricted-syntax`/`no-restricted-imports` rules that fail CI on:
   - `.some(` over `linkedProfiles`/`linked_profiles` outside `shared/profile-filter.ts` and `shared/scope.ts`;
   - writing `linked_profiles` outside `ownership-writer.ts` (grep-gate on the string in `server/` except the writer);
   - importing the deleted legacy helpers;
   - literal frequency multipliers (`4.33`, `4.345`, `2.17`, `30.44`) outside `obligation-windows.ts`.

2. **Contract tests (`tests/smoke/contracts/`).** Property tests that pin the semantics, not the implementation:
   - same fixture entity set → every list endpoint and every page-level filter returns the identical ID set for (everyone / single / multi / orphan-included) selections;
   - `resolveAssetValue` fixtures asserted equal across server snapshot and any client recomputation;
   - after `setOwners`, junction tables, JSONB read model, and `ownership_history` all reflect the change;
   - one streak fixture asserted across habit page, profile tab, and server.

3. **One write pipeline.** A single `entityService.create/update/delete(type, payload, ctx)` on the server that does: zod validation → normalization → ownership write (via writer) → entity links → cache bust. UI routes, AI engine, smart-fill, extraction, and import all call it. AI gets *zero* direct `storage.*` write access.

4. **Database-enforced invariants.** Truth lives where it can't be bypassed:
   - trigger syncs `linked_profiles` from junction tables (or vice versa during migration);
   - `deleteProfile` as one RPC;
   - `updated_at` concurrency check in a generic update RPC;
   - FK + index on `entity_links(target_type, target_id)`.

Order of operations: lint gates and contract tests **first** (they freeze the current behavior and stop new forks while you fix the rest), then P0, then P2.1's storage unification — everything else becomes mechanical once reads and writes each have exactly one path.

---

## Execution status (2026-06-10, same day)

The plan was executed and merged. Verified: `tsc` clean, 242/242 unit tests, 47/47 static guardrail contracts, production build green, `delete_profile_cascade` applied to the live database and sanity-tested.

**Done:** P0.1 (atomic cascade RPC + fallback), P0.2 (optimistic concurrency on all 9 updateX — live `updated_at` triggers verified on every table), P0.3 (AI writes zod-validated, atomic ownership, existence/cycle checks, normalize applied), P0.5 (ownership repair method + endpoint), P1.1–P1.5, P2.2 (all updateX + propagate/migrate paths through setOwners; income/journal/artifact included), P2.4 (7 server endpoints + client pages canonicalized, single/multi param unified — documents endpoint had the same bug and was fixed too), P2.5, P3.3, P4.1–P4.5, P5.1 (TTL cap variant), P5.2 (covered by profiles-domain predicate — verified), P5.3, P6.1 (audited: fallbacks proven value-identical, kept), P6.2, P6.3, plus the full enforcement layer (5 new guardrail suites with ratchet budgets).

**Corrections to this audit found during execution:** `ownership_history` IS written (320 rows/30d — OWN-006 was wrong about the never-called claim; the real gap was unguarded awaits, now fire-and-forget); `entity_links` already had target indexes + a unique-pair constraint and zero duplicates (P0.4 moot); every entity table has `updated_at` with BEFORE UPDATE triggers (repo's `supabase-migration.sql` is stale); the live `events` table has had `deleted_at` all along (the "no column" comment was wrong); editor mentions are live-resolved, so rename/delete degrades gracefully rather than corrupting.

**Deferred (deliberate):** P2.1 full junction-as-truth restructure (the writer chokepoint + ratchet budgets deliver the invariant incrementally; remaining raw writes are budget-pinned at 24 and may only decrease); P3.1 ID-backed mention pills (product-behavior change; current live-resolution cannot point at wrong data); P3.2 relationship schema (product decision); P5.4 rollup tables (no measured need); per-user cache version counter (TTL capped at 60s instead — bounded staleness without touching every request path). Ratchet inventories of remaining legacy violations (28 inline filters, 22 literal multipliers, 41 hardcoded timezones — mostly cosmetic defaults inside ai-engine) live in `tests/smoke/contracts/` with file:line lists.

---

## Appendix: prior-audit reconciliation

- **Fixed and holding:** 7-vs-30-day window, 4.33/2.17 multipliers in stats/enhanced, net-worth four-way fork, goals query-key drift, budget keepPreviousData leak, per-user cache isolation, `dashboard-bootstrap`/`insights` filter leakage.
- **Never fixed:** inline filters on trackers/events/expenses/habits/obligations multi-param endpoints; HeroKPIPopups inline resolvers (was flagged as "fallback only"); streak duplication.
- **New since last audit:** `filter-utils.ts:filterByProfile` (a *new* divergent helper, post-dating the "inline filters forbidden" rule — direct evidence that convention without enforcement does not hold).
