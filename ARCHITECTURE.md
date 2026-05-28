# Portol — Stabilization Architecture & Consistency Framework

**Status:** Authoritative contract for all future changes
**Companion docs:** `REGRESSION_TESTS.md`, `audit/stabilization-findings.md`
**Last updated:** 2026-05-28

This document defines the canonical state model for Portol. Every page, component, server route, and mutation must obey these rules. The regression suite (`tests/smoke/contracts/`) enforces them. Violations are bugs.

---

## 1. Core Principles

1. **One source of truth per concept.** A number rendered in two places must come from one function. A list rendered in two places must come from one query key (or one prefix).
2. **Compute once, render many.** Derived values are computed in a shared selector. UI components never reimplement the math.
3. **Server is authoritative for cross-entity math.** Anything that joins entities (net worth, monthly spend, upcoming bills) is computed server-side and shipped in `/api/dashboard-enhanced`. Client recomputation is only allowed for snappy reactivity and MUST match the server.
4. **Mutations always go through the cache-bus.** Every `useMutation` uses `buildOptimisticListMutation` or `optimisticBust` from `client/src/lib/cache-bus.ts`. Manual `setQueryData` without `onMutate`/rollback is forbidden.
5. **Profile filtering is centralized.** Every filter site — client or server — calls `passesProfileFilter()` from `shared/profile-filter.ts`. Inline `linkedProfiles.some(...)` is forbidden.
6. **Smallest possible diff.** When fixing a violation, extract the shared utility, replace the inline copy, and leave everything else untouched.

---

## 2. Source of Truth Per Entity

| Entity | Server Owner | Client Query Key | Shared Computation Helper |
|---|---|---|---|
| Profiles (all types) | `GET /api/profiles` | `["/api/profiles"]` | — |
| Profile detail (with embeds) | `GET /api/profiles/:id` | `["/api/profiles", id, "detail"]` | — |
| Assets (read) | via `/api/profiles` (type-filtered client-side) | `["/api/profiles"]` | `resolveAssetValue()` ← shared/asset-value.ts (NEW) |
| Asset rollup (nested totals) | — | client-only | `computeAssetRollup()` ← shared/asset-rollup.ts |
| Liability balance | via `/api/profiles` (type=liability) | `["/api/profiles"]` | `resolveLiabilityBalance()` ← shared/asset-value.ts (NEW) |
| Liability amortization | — | client-only | `buildAmortization()`, `summarizeLiability()` ← shared/liability-calc.ts |
| Tasks | `GET /api/tasks?profileIds=` | `["/api/tasks", filterMode, ...filterIds]` | — |
| Habits | `GET /api/habits?profileIds=` | `["/api/habits", filterMode, ...filterIds]` | — |
| Trackers (with entries) | `GET /api/trackers` | `["/api/trackers"]` | — |
| Tracker entry (one) | `GET /api/trackers/:id` | `["/api/trackers", id]` | — |
| Expenses | `GET /api/expenses?profileIds=` | `["/api/expenses", filterMode, ...filterIds]` | — |
| Incomes | `GET /api/incomes?profileIds=` | `["/api/incomes", filterMode, ...filterIds]` | — |
| Obligations | `GET /api/obligations?profileIds=` | `["/api/obligations", filterMode, ...filterIds]` | — |
| Obligation occurrences | `GET /api/obligation-occurrences?start=&end=` | `["/api/obligation-occurrences", start, end, filterMode, ...filterIds]` | `materializeOccurrences()` ← server/obligation-engine.ts |
| Budgets | `GET /api/budgets/summary?month=&profileIds=` | `["/api/budgets/summary", month, filterMode, ...filterIds]` | — |
| Goals | `GET /api/goals?profileIds=` | `["/api/goals", filterMode, ...filterIds]` | — |
| Events | `GET /api/events` | `["/api/events"]` | — |
| Calendar timeline | `GET /api/calendar/timeline` | `["/api/calendar/timeline"]` | — |
| Documents | `GET /api/documents` | `["/api/documents"]` | — |
| Dashboard metrics (everything) | `GET /api/dashboard-enhanced` | `["/api/dashboard-enhanced", filterMode, ...filterIds]` | — |
| Stats (legacy, lighter) | `GET /api/stats` | `["/api/stats", filterMode, ...filterIds]` | — |
| Net Worth (deep popup) | `GET /api/profiles` (client computes) | `["/api/profiles", "net-worth"]` | `buildNetWorth()` ← shared/net-worth.ts (NEW) |
| Toolbar profile filter | client state in `localStorage:portol_profile_filter_v4:<userId>` | broadcast via `FILTER_EVENT` CustomEvent | `getProfileFilter()`, `subscribeProfileFilter()` ← client/src/lib/profileFilter.ts |

**Rule:** Any page reading from a different query key for the same data is a bug. (Reference: finding 6.1 — Goals shape divergence.)

---

## 3. Canonical Computation Modules

### 3.1 `shared/asset-value.ts` (NEW — extract from `server/supabase-storage.ts` and `client/src/pages/dashboard.tsx`)

```ts
export function resolveAssetValue(profile: Profile): number;
export function resolveLiabilityBalance(profile: Profile): number;
```

The full namespace + key resolver. Single canonical implementation used by:
- `server/supabase-storage.ts` (already inlined — replace with import)
- `server/routes.ts` `/api/dashboard-bootstrap` (currently inlined — replace)
- `client/src/pages/dashboard.tsx` HeroKPISection (currently `resolveAssetValue` defined locally — replace with import)
- `client/src/pages/dashboard.tsx` Finance section (same)
- `client/src/pages/finance.tsx` (`readVal` — DELETE, replace with import)
- `client/src/pages/profile-detail.tsx` Financial Overview (truncated inline reducer — REPLACE)

### 3.2 `shared/net-worth.ts` (NEW)

```ts
export type FilterContext = { mode: "everyone" | "selected"; selectedIds: string[]; allProfiles: Profile[] };
export function computeNetWorth(profiles: Profile[], ctx: FilterContext): {
  assets: number;
  liabilities: number;
  netWorth: number;
  assetProfiles: Profile[];
  liabilityProfiles: Profile[];
};
```

Uses `resolveAssetValue`, `resolveLiabilityBalance`, `passesProfileFilter`, and the canonical asset/liability type sets. Replaces:
- `dashboard.tsx HeroKPISection.matchesProfileFilter` + asset reducer (finding 2.4, 3.4)
- `dashboard.tsx FinanceSection` net worth reducer (finding 3.4, 7.4)
- `HeroKPIPopups.tsx NetWorthPopup isInScope` (the canonical filter for co-owned — this is the model to copy)
- `finance.tsx` Net Worth KPI (finding 1.5)
- `profile-detail.tsx` Financial Overview (findings 3.1, 7.1)

### 3.3 `shared/obligation-windows.ts` (NEW)

```ts
export const UPCOMING_BILL_WINDOW_DAYS = 30;
export function isUpcomingBill(o: Obligation, now: Date = new Date()): boolean;
export function toMonthlyAmount(amount: number, frequency: string): number; // exact 52/12, 26/12
```

Used by:
- `getStats()` for upcoming-obligation tile count (currently 7-day window — finding 1.1, change to 30)
- `getDashboardEnhanced()` for `upcomingBills` (currently 30 — no change)
- All four sites using `4.33`/`2.17` (findings 1.2, 1.5) — replace with `toMonthlyAmount`.

### 3.4 `shared/profile-filter.ts` (EXISTING — no changes; enforce usage)

Already canonical. Every inline reimplementation MUST be deleted:
- `client/src/components/CalendarView.tsx:1066` (finding 2.1)
- `client/src/components/ObligationsManager.tsx:998` (finding 2.2)
- `client/src/pages/finance.tsx:874` (finding 2.3)
- `server/routes.ts:1776` `/api/dashboard-bootstrap` (finding 1.6)
- `server/routes.ts:1843` `/api/insights` (finding 2.6)
- `server/supabase-storage.ts:4219` `getInsights()` (finding 2.5)

---

## 4. Query Key Conventions

**Format:** `["/api/<endpoint>", ...discriminators]`.

**Discriminators (in this exact order when present):**
1. `filterMode` — "everyone" | "selected"
2. `...filterIds` — spread, not joined string

**Rules:**
- Never use `ids.join(",")` as a discriminator (finding 6.1 — Goals). Spread the array.
- Never omit filter discriminators when the server reads `profileIds` (finding 6.2 — Habits page).
- Prefix invalidation (e.g., `invalidateQueries({ queryKey: ["/api/goals"] })`) WILL match all filtered variants — this is the preferred broadcast pattern.

**Goal key consolidation (FIX):** Standardize on `["/api/goals", filterMode, ...filterIds]`. Update `trackers.tsx` (currently `["/api/goals"]` bare) and `dashboard.tsx` (currently `["/api/goals", ids.join(",") || "all"]`).

---

## 5. Mutation Strategy

### 5.1 Required pattern (all mutations)

```ts
import { buildOptimisticListMutation, optimisticBust } from "@/lib/cache-bus";

const m = useMutation(buildOptimisticListMutation({
  queryKey: ["/api/expenses"],          // or whatever
  domains: ["expenses", "dashboard"],    // cache-bus domains to invalidate on settle
  mutationFn: async (payload) => apiRequest("POST", "/api/expenses", payload),
  applyOptimistic: (prev, payload) => [...prev, { ...payload, id: tempId() }],
}));
```

For non-list mutations (e.g., field patches), use `optimisticBust(domains)` with manual `onMutate`/`onError`.

### 5.2 Forbidden patterns

- `useMutation({ mutationFn, onSuccess: () => invalidateQueries() })` with no `onMutate`.
- `setQueryData` inside `onSuccess` (causes double-update flash).
- `setQueryData` inside `onMutate` without storing the snapshot for rollback in `onError`.

### 5.3 Sites to fix (8 total, from finding section 4)

| Site | File:line | Fix |
|---|---|---|
| createExpenseMutation | profile-detail.tsx:3946 | Use `buildOptimisticListMutation` |
| updateExpenseMutation | profile-detail.tsx:3972 | Use optimistic patch + rollback |
| deleteExpenseMutation | profile-detail.tsx:~3990 | Move setQueryData to onMutate + add rollback |
| DocumentSection.deleteMutation | profile-detail.tsx:3367 | Add onMutate + rollback |
| statusMutation | profile-detail.tsx:2298 | Add optimistic field patch |
| logEntryMutation | profile-detail.tsx:5182 | Use `buildOptimisticListMutation` |
| createTaskMutation | profile-detail.tsx:6018 | Use `buildOptimisticListMutation` |
| createHabitMutation | dashboard.tsx:1285 | Use `buildOptimisticListMutation` |

---

## 6. Cache-Bust Matrix

Every entity has a **cache-bus domain**. Mutations must invalidate the right set.

| Mutation effect | Domains to invalidate |
|---|---|
| Create/update/delete expense | `expenses`, `budgets`, `dashboard` |
| Create/update/delete income | `incomes`, `dashboard` |
| Create/update/delete obligation | `obligations`, `events`, `dashboard` (server must also call `materializeOccurrences`) |
| Mark obligation occurrence | `obligations`, `events`, `dashboard` |
| Create/update/delete task | `tasks`, `dashboard` |
| Habit check-in / create | `habits`, `dashboard` |
| Create/update/delete tracker entry | `trackers`, `dashboard` |
| Create/update/delete asset/liability profile | `profiles`, `assets`, `liabilities`, `dashboard` |
| Edit profile fields (value, balance) | `profiles`, `dashboard`, plus the linked profile's detail key |
| Document create/delete | `documents`, `profiles` (detail) |
| Goal create/update/delete | `goals`, `dashboard` |
| Calendar event | `events`, `dashboard` |

The `dashboard` domain in `cache-bus.ts` maps to: `/api/stats`, `/api/dashboard-enhanced`, `/api/dashboard-bootstrap`. **Never** invalidate only one of these three.

---

## 7. Profile Isolation Rules

1. **Filter state lives in localStorage**, namespaced per-user: `portol_profile_filter_v4:<userId>`.
2. **Reading the filter**: every component uses `getProfileFilter()` + `subscribeProfileFilter(cb)`. Do not directly read localStorage.
3. **Filtering data**: every site uses `passesProfileFilter(linkedProfiles, { selectedIds, allProfiles })`. No exceptions.
4. **Orphan rule**: items with empty `linkedProfiles` pass only when at least one selected profile has `type === "self"`. This is the rule in `shared/profile-filter.ts` and the only acceptable behavior.
5. **Co-ownership**: `fields.owners`, `fields.ownerIds`, `fields.linkedProfileIds` arrays are profile links. `passesProfileFilter` must consider them (the canonical implementation in `shared/profile-filter.ts` already does — see finding 2.4 for which client surfaces miss this).
6. **Server endpoints accepting `?profileIds=`** must filter using `passesProfileFilter`. The route handler builds the `filterCtx` from `req.query.profileIds` and `req.query.filterMode` and passes it to the storage layer.

---

## 8. Asset Nesting Rules

1. **Nested totals**: `computeAssetRollup(profile, allProfiles)` is the only function that walks children. It is cycle-safe (max depth 50) and returns `{ baseValue, nestedValue, totalValue, baseLoans, nestedLoans, totalLoans, netValue, breakdown }`.
2. **Single asset value**: `resolveAssetValue(profile)` returns the value of one profile, walking all known namespace+key combinations. Used inside `computeAssetRollup` and as the standalone resolver.
3. **Net worth from a profile set**: `computeNetWorth(profiles, filterCtx)` is the only function that sums multiple profiles' asset/liability values. It applies `passesProfileFilter` first, then `resolveAssetValue`/`resolveLiabilityBalance`.

**Forbidden:**
- Inline reducer summing `profile.fields.currentValue || profile.fields.value || ...` (the truncated pattern in finding 3.1).
- Component-specific `matchesProfileFilter` that doesn't read co-ownership arrays (finding 2.4).
- Computing net worth without memoizing (finding 7.1).

---

## 9. Recurrence & Calendar Sync

1. **Obligation engine** (`server/obligation-engine.ts`) is the source of truth for recurrence math.
2. **PATCH /api/obligations/:id** MUST call `materializeOccurrences(obligationId)` after updating. Currently doesn't (finding 5.4). The fix is to add the call at the end of the PATCH handler.
3. **Calendar query window**: on any long-lived component, the window MUST recompute when the date crosses midnight. The current `useMemo([], [])` (finding 5.3) is replaced with a daily-tick state:

```ts
const [todayMs, setTodayMs] = useState(() => startOfDay(Date.now()));
useEffect(() => {
  const interval = setInterval(() => {
    const next = startOfDay(Date.now());
    if (next !== todayMs) setTodayMs(next);
  }, 60_000);
  return () => clearInterval(interval);
}, [todayMs]);
const occStartIso = useMemo(() => isoDate(todayMs - 60 * 86400000), [todayMs]);
const occEndIso = useMemo(() => isoDate(todayMs + 30 * 86400000), [todayMs]);
```

4. **Cross-view invariant**: an obligation edit must update the calendar within the same React Query refetch cycle. The cache-bus `obligations` domain MUST also invalidate `events` and `calendar/timeline`.

---

## 10. Dashboard Metric Contract

Every metric tile must satisfy:
1. The tile count equals the popup row count for the same metric (e.g., "5 bills due" tile → popup lists exactly 5 rows).
2. The source data is a SINGLE endpoint (`/api/dashboard-enhanced`). The legacy `/api/stats` is a fallback ONLY for the first ~200ms before enhanced loads; the fallback must use the same window definitions.
3. Drilldown clicks navigate to the page that uses the same filter — e.g., "Upcoming Bills" tile → Calendar/Obligations page with the dashboard's profile filter already applied.

**Specific fixes (from findings 1.1, 1.2, 1.3):**
- `getStats().upcomingObligations` window: 7 → 30 days.
- Monthly multipliers: `4.33`/`2.17` → `52/12`/`26/12` everywhere.
- `enhanced.financeSnapshot.totalMonthlySpend` is authoritative; show `—` during the loading window instead of falling back to `stats.monthlySpend`.

---

## 11. Memoization Rules

1. **Top-level body computations** in a React component MUST be wrapped in `useMemo` if they iterate or filter arrays of length > 5.
2. **Render-time IIFEs** in JSX are forbidden when they compute aggregates. Extract to a `useMemo` above the JSX.
3. **Synthetic/fabricated data** displayed as real (finding 7.7 — 6-month net worth sparkline) is forbidden. Replace with stored snapshots, real time series, or remove.

---

## 12. Enforcement (Regression Contracts)

The following test files in `tests/smoke/contracts/` enforce this architecture:

| Test file | What it enforces |
|---|---|
| `invariants.test.ts` | Single source of truth checks: dashboard tile count == popup row count |
| `cache.test.ts` | Cache-bus matrix: every domain invalidation hits the right keys |
| `isolation.test.ts` | Profile filter never leaks across users |
| `crud.test.ts` | Each CRUD operation refreshes all consumer views |
| `dashboard.test.ts` | Metric contracts: 30-day window, monthly multipliers, source endpoints |
| `regressions.test.ts` | Append-only bug ledger; each fix adds `it("BUG-YYYYMMDD-...")` |
| `cross-view.test.ts` (NEW) | Same entity in two views shows same data after mutation |
| `optimistic-rollback.test.ts` (NEW) | Each mutation site simulates failure and asserts UI rolls back |
| `calendar-recurrence.test.ts` (NEW) | Obligation PATCH triggers materializeOccurrences; calendar reflects edit |
| `profile-filter-canonical.test.ts` (NEW) | Every code path calling profile-filter uses passesProfileFilter() |

**Pre-push hook** (`.githooks/pre-push`) runs `npx tsc --noEmit && npm run test:contracts`. No merges without green.

---

## 13. Implementation Order (Phase 3)

Execute in this order. Each phase is a single commit gated by the test suite.

**Phase A — Canonical modules (additive, no behavior change):**
1. Create `shared/asset-value.ts` with `resolveAssetValue` / `resolveLiabilityBalance` (lift from dashboard.tsx).
2. Create `shared/net-worth.ts` with `computeNetWorth`.
3. Create `shared/obligation-windows.ts` with `UPCOMING_BILL_WINDOW_DAYS`, `isUpcomingBill`, `toMonthlyAmount`.

**Phase B — Replace inline copies (high-impact, small diffs):**
4. Replace inline asset resolvers with `resolveAssetValue` in: profile-detail.tsx Finance Overview, finance.tsx readVal, dashboard.tsx (already uses one — re-export instead).
5. Replace inline `matchesProfileFilter` in dashboard.tsx HeroKPISection + FinanceSection with shared net worth.
6. Replace 5 client-side filter sites with `passesProfileFilter()` (CalendarView, ObligationsManager, finance.tsx, plus 2 server sites in routes.ts and supabase-storage.ts).
7. Change `getStats()` window 7 → 30 days; unify monthly multipliers to exact fractions.

**Phase C — Mutation hygiene:**
8. Add `onMutate` + rollback to 8 mutation sites listed in Section 5.3.
9. Standardize Goals query key shape across dashboard.tsx + trackers.tsx; add `filterMode` discriminator to habits.tsx key.

**Phase D — Recurrence + calendar window:**
10. Add `materializeOccurrences()` call to PATCH /api/obligations/:id handler.
11. Replace ObligationsManager hardcoded date window with daily-tick state.

**Phase E — Misleading data:**
12. Remove or properly label the fabricated 6-month net worth sparkline.

**Phase F — Regression contracts:**
13. Add 4 new test files (cross-view, optimistic-rollback, calendar-recurrence, profile-filter-canonical).
14. Add bug ledger entries `BUG-20260528-*` for each fix above.

**Phase G — Verify + deploy:**
15. Run `npm run test:contracts` (must be 33+N passing).
16. Push to main → auto-deploy.
17. Run `npm run smoke:post-deploy` against production.
18. Share evidence (test output + screenshot or curl proof).

---

## 14. Anti-Goals (CRITICAL — do NOT do)

- Do NOT redesign UI. This is a behind-the-glass stabilization.
- Do NOT add new features. If something doesn't exist yet, it's out of scope.
- Do NOT refactor unrelated files. Each commit touches only the files needed for the listed change.
- Do NOT break existing endpoint shapes. Add fields if needed; never remove.
- Do NOT bypass the test suite without `SKIP_TESTS=1` and a written justification in the commit message.
- Do NOT mark a fix complete without an accompanying `it("BUG-...")` in `regressions.test.ts`.

---

## 15. Acceptance for "Stabilization Complete"

All of the following must be true:
- [ ] All 5 CRITICAL findings from the audit have shipped fixes.
- [ ] All 14 HIGH findings have shipped fixes OR a documented deferral.
- [ ] 4 new regression test files exist and pass.
- [ ] Bug ledger has 8+ new `BUG-20260528-*` entries.
- [ ] Pre-push hook still green on every commit.
- [ ] `npm run smoke:post-deploy` is green against production.
- [ ] This document is committed to main and referenced from `REGRESSION_TESTS.md`.
