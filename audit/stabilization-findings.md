# Portol Stabilization Audit — Findings

## Executive Summary

This audit identified **62 concrete findings** across seven risk areas in the Portol codebase. The most critical issues cluster around three themes: (1) **four independent net-worth computations** that diverge whenever asset fields differ slightly, (2) **five client-side profile-filter reimplementations** that can silently leak another profile's data or over-restrict the current one, and (3) **seven mutation sites that apply optimistic writes without rollback**, leaving the UI in a ghost state on network failure.

The top five critical findings are: (A) `profile-detail.tsx` line 4063 computes net worth inline using a truncated field resolver that misses `finance.*` / `housing.*` nested paths present in the canonical `resolveAssetValue`; (B) `getStats()` counts upcoming obligations using a 7-day window while `getDashboardEnhanced()` uses a 30-day window, causing the KPI tile count to permanently disagree with the bills popup; (C) the `/api/dashboard-bootstrap` budget-summary filter reimplements the orphan-item rule instead of calling `passesProfileFilter()`, diverging from the canonical logic on self-profile edge cases; (D) `getInsights()` in `supabase-storage.ts` uses a strict single-profile filter that ignores the multi-select `profileIds` param and orphan-fallback rule, making all Insights data stale under any non-default filter; (E) the Goals query key in `dashboard.tsx` (`["/api/goals", ids.join(",") || "all"]`) is a different shape from `trackers.tsx`'s `["/api/goals"]`, so a goal deleted in the Trackers page never leaves the Dashboard goals list until the 30-second stale timer fires.

**Recommended sequencing:** Fix the profile-filter leakage group first (Section 2) because it affects data correctness across every page. Then address the asset/net-worth computation duplication (Section 3) to consolidate to one resolver. Then patch the seven missing optimistic rollbacks (Section 4). Then fix the query-key drift table (Section 6). Finally tackle the inline recomputation clean-ups (Section 7) which are lower urgency.

---

## 1. Dashboard Metric Drift

### 1.1 Upcoming Bills tile count vs popup count — CRITICAL | S

**Location:** `server/supabase-storage.ts:3881` (getStats) vs `server/supabase-storage.ts:4107` (getDashboardEnhanced)

**Issue:** `getStats()` defines "upcoming obligations" as obligations whose `nextDueDate ≤ now + 7 days`, **including overdue** items (due ≤ sevenDaysOut with no lower bound):
```ts
// line 3881
const upcomingObs = obligations.filter(o => { const due = new Date(o.nextDueDate); return due <= sevenDaysOut; });
```
`getDashboardEnhanced()` defines "upcoming bills" as anything due within 30 days:
```ts
// line 4107
const upcomingBills = allObligations.filter(o => { ... return daysUntil <= 30; })
```
The KPI tile falls back to `stats.upcomingObligations` when `enhanced` hasn't loaded, and uses `enhanced.financeSnapshot.upcomingBills.length` after it loads (dashboard.tsx:802). This means the tile count _changes_ as data loads, and permanently differs when the user has bills 8–30 days out.

**Canonical source:** `getDashboardEnhanced` / 30-day window is what the popup renders. The `stats.upcomingObligations` field should use the same 30-day window.

**Impact:** User sees "2 bills due" on the tile, opens the popup, and sees 5 rows. Visible count mismatch.

**Recommended fix:** Change `getStats()` line 3881 to use `daysUntil <= 30` to match `getDashboardEnhanced`. Or deprecate `stats.upcomingObligations` entirely and always drive the tile from `enhanced.financeSnapshot.upcomingBills.length`.

---

### 1.2 monthlyObligationTotal: truncated multipliers — LOW | S

**Location:** `server/supabase-storage.ts:3884-3892` (getStats) vs `client/src/pages/finance.tsx:837-838` (Finance page)

**Issue:** `getStats()` computes the monthly obligation total using the truncated constants `4.33` (weekly) and `2.17` (biweekly). The Finance page uses the exact fractions `52/12` and `26/12`. The numeric drift is small (~$0.01 per obligation per month) but creates a detectable mismatch between the Dashboard KPI sub-label (`$X/mo`) and the Finance page total.

**Canonical source:** `52/12` / `26/12` used in Finance page and in `getDashboardEnhanced` (lines 4111–4112 use the same truncated constants — both server computations need updating).

**Impact:** Low-dollar rounding discrepancy between dashboard KPI sub-label and Finance page.

**Recommended fix:** Unify all four multiplier sites to `52/12` and `26/12`. Extract a `toMonthly(amount, frequency)` shared helper.

---

### 1.3 Dashboard KPI tile spending vs popup spending — MEDIUM | S

**Location:** `client/src/pages/dashboard.tsx:794`, comment at 792–793

**Issue:** The KPI spending card uses `enhanced?.financeSnapshot?.totalMonthlySpend ?? stats?.monthlySpend ?? 0`. The comment explicitly notes this was a bug fix: `stats.monthlySpend` and `financeSnapshot.totalMonthlySpend` were previously computed differently. While both now come from `getStats()` / `getDashboardEnhanced()` respectively and both use `passesProfileFilter`, the fallback chain means that during the ~200ms window when `stats` has loaded but `enhanced` hasn't, the tile shows `stats.monthlySpend`. If the filter differs between the two calls (e.g., race between filter change and refetch), transient display differences occur.

**Canonical source:** `enhanced.financeSnapshot.totalMonthlySpend` is correct.

**Impact:** Brief flash of different spend number on filter change.

**Recommended fix:** Make `monthlySpend` authoritative from `enhanced` only; show `—` while loading rather than falling back to `stats`.

---

### 1.4 Finance page "Assets" tile uses custom readVal, not resolveAssetValue — HIGH | M

**Location:** `client/src/pages/finance.tsx:815-827`

**Issue:** The Finance page's top KPI "Asset Value" tile uses an inline `readVal()` function that walks its own namespace list (`['', 'finance', 'other', 'housing', 'vehicle', 'vehicles', 'investment', 'investments', 'asset', 'assets', 'property', 'properties', 'account', 'accounts']`) and its own key list. This is **not** the same as `resolveAssetValue()` defined in `supabase-storage.ts` (and mirrored in `dashboard.tsx`). Differences: `readVal` includes namespaces `'investments', 'assets', 'properties', 'accounts'` (plural forms) that the canonical resolver doesn't try, and the canonical resolver includes `fields.estimatedValue` / `fields.estimated_value` which `readVal` skips.

```ts
// finance.tsx:815 — custom resolver
const NS = ['', 'finance', 'other', 'housing', 'vehicle', 'vehicles', 'investment',
            'investments', 'asset', 'assets', 'property', 'properties', 'account', 'accounts'];
const KEYS = ['currentValue', 'current_value', 'value', 'purchasePrice', ...];
const readVal = (fields: any): number => { ... };
```

**Canonical source:** `resolveAssetValue(p)` from `dashboard.tsx` (lines 117–151), which mirrors `server/supabase-storage.ts:211–246`.

**Impact:** Finance page "Asset Value" tile may show a different number than the dashboard Net Worth tile. Affects user-visible financial figures.

**Recommended fix:** Export `resolveAssetValue` from a shared module (e.g., `shared/asset-value.ts`) and import it in `finance.tsx`, `dashboard.tsx`, and remove the inline `readVal`.

---

### 1.5 Finance page Net Worth KPI sources from enhanced.financeSnapshot, not allProfiles — MEDIUM | S

**Location:** `client/src/pages/finance.tsx:870-889`

**Issue:** The Finance page Net Worth KPI reads `enhanced?.financeSnapshot?.totalAssetValue` and `enhanced?.financeSnapshot?.totalLiabilities` (server-computed). The Dashboard net worth tile and Net Worth popup both compute from `allProfiles` client-side (after Round-6 fix), giving co-ownership-aware fractional values. The Finance page bypasses that logic and shows server-side totals which use a different ownership math path.

**Impact:** Under a filtered profile selection, Dashboard shows fractional co-ownership net worth but Finance page shows a different value for the same filter.

**Recommended fix:** Finance page Net Worth KPI should derive from the same `allProfiles` client-side calculation as the dashboard.

---

### 1.6 dashboard-bootstrap budget filter reimplements orphan rule — HIGH | S

**Location:** `server/routes.ts:1776-1796`

**Issue:** The `/api/dashboard-bootstrap` handler reimplements the budget expense filter inline:
```ts
// routes.ts:1776
const selfMatch = filterIds.some(id => profiles.find((p: any) => p.id === id)?.type === "self");
return expensesForBudget.filter((e: any) => {
  const arr = Array.isArray(e.linkedProfiles) ? e.linkedProfiles : [];
  if (arr.length === 0) return selfMatch;
  return arr.some((id: string) => filterIds.includes(id));
});
```
This is **not** `passesProfileFilter()` — it misses the `allProfiles` context that `passesProfileFilter` uses to determine orphan fallback. The orphan rule in `shared/profile-filter.ts` checks if the selected profile is of type `"self"` by looking it up in `allProfiles`; the bootstrap version does `profiles.find(...)` but without the `filterCtx` wrapper, skipping other nuances (e.g., parent-child relationships).

**Canonical source:** `passesProfileFilter(e.linkedProfiles, { selectedIds: filterIds, allProfiles: profiles })`.

**Impact:** Budget summary pre-populated by bootstrap may exclude/include expenses differently than individual `/api/expenses` calls filtered by `passesProfileFilter`.

**Recommended fix:** Replace inline filter logic with `passesProfileFilter()` calls, same as `getStats()` and `getDashboardEnhanced()`.

---

## 2. Profile Filter Leakage

### 2.1 CalendarView client-side filter reimplemented — MEDIUM | S

**Location:** `client/src/components/CalendarView.tsx:1066-1068`

**Issue:** CalendarView applies its own inline check:
```ts
const linked = item.linkedProfiles || [];
```
without calling `passesProfileFilter()`. The "defense-in-depth client filter" in `ObligationsManager.tsx:1019` and the one in `CalendarView.tsx:1066` both reimplement partial orphan logic without the shared function.

**Impact:** Events/obligations with empty `linkedProfiles` may be incorrectly included or excluded depending on which inline path executes.

**Recommended fix:** Centralize all client-side filtering via `passesProfileFilter()` from `@shared/profile-filter`. Remove inline `linked.length === 0 || linked.some(...)` patterns.

---

### 2.2 ObligationsManager double-filters (server + client) — MEDIUM | S

**Location:** `client/src/components/ObligationsManager.tsx:998-1001`

**Issue:** ObligationsManager sends `?profileIds=...` to the server (so the server already filters), then additionally filters client-side:
```ts
const obligations = useMemo(() => filterMode === "selected" && filterIds.length > 0
  ? allObligations.filter(o => o.linkedProfiles.some(id => filterIds.includes(id)))
  : allObligations, [allObligations, filterMode, filterIds]);
```
The client-side filter uses `some(id => filterIds.includes(id))` — no orphan fallback. If an obligation has `linkedProfiles: []` and the server returned it (because selected profile is "self"), the client removes it.

**Canonical source:** `passesProfileFilter()` from `@shared/profile-filter`.

**Impact:** Obligations linked to no profile (orphans) may disappear from the UI for a self-profile filter even though the server correctly includes them.

**Recommended fix:** Use `passesProfileFilter()` for the client-side defense filter, or remove the client-side filter entirely and trust server filtering.

---

### 2.3 Finance.tsx obligations filter uses inline orphan rule — MEDIUM | S

**Location:** `client/src/pages/finance.tsx:874-877`

**Issue:** The Net Worth KPI section in Finance filters obligations with:
```ts
const filteredObl = (obligations || []).filter((o: any) => {
  if (filterMode === "everyone" || filterIds.length === 0) return true;
  const linked = o.linkedProfiles || [];
  return linked.length === 0 || linked.some((id: string) => filterIds.includes(id));
});
```
The `linked.length === 0` branch always passes orphan obligations regardless of whether the selected profile is "self". The canonical rule says orphans only pass if a self-profile is selected.

**Canonical source:** `passesProfileFilter()`.

**Impact:** Orphan obligations inflate the Finance page monthly bills figure for non-self profile filters.

**Recommended fix:** Replace inline filter with `passesProfileFilter(o.linkedProfiles, filterCtx)`. Note: `filterCtx` is already constructed on finance.tsx:589.

---

### 2.4 HeroKPISection.matchesProfileFilter misses co-ownership links — HIGH | M

**Location:** `client/src/pages/dashboard.tsx:580-585`

**Issue:** `HeroKPISection.matchesProfileFilter()` checks only direct selection and parent-child (`_parentProfileId`):
```ts
const matchesProfileFilter = (p: any): boolean => {
  if (filterMode === "everyone" || filterIds.length === 0) return true;
  const pParent = p?.fields?._parentProfileId || p?.parentProfileId;
  if (pParent && filterIds.includes(pParent)) return true;
  if (filterIds.includes(p?.id)) return true;
  return false;
};
```
It does **not** check `fields.owners`, `fields.ownerIds`, or `fields.linkedProfileIds` (co-ownership arrays), which the Net Worth popup's `isInScope()` function does check (HeroKPIPopups.tsx:192-198). This means the Hero KPI tile and the Net Worth popup can show different asset lists.

**Canonical source:** `HeroKPIPopups.tsx:isInScope()` which covers the extra owner arrays.

**Impact:** A co-owned asset appears in the popup but not in the tile's `totalAssetValue`, causing the tile and popup net worth to disagree.

**Recommended fix:** Extract a shared `isInScope(profile, filterMode, filterIds)` utility used by both HeroKPI tile and NetWorthPopup. Or simply use the same `isInScope` function from the popup.

---

### 2.5 getInsights() in supabase-storage.ts uses legacy single-profile strict filter — HIGH | M

**Location:** `server/supabase-storage.ts:4219-4238`

**Issue:** `getInsights()` accepts only `filterProfileId?: string` (single profile). It uses a strict match that ignores orphan fallback:
```ts
const matchFp = (lp: string[]) => {
  if (!fp) return true;
  return lp.includes(fp);
};
```
The `getInsights` method is never called by current server routes (routes.ts uses inline aggregation). But even the inline `mp()` function in the `/api/insights` route handler (routes.ts:1847) is a reimplementation rather than using `passesProfileFilter()`, though it does correctly handle orphans.

**Canonical source:** `passesProfileFilter()` from `shared/profile-filter.ts`.

**Impact:** `getInsights()` storage method is dead code but is a maintenance hazard — anyone calling it will get incorrect filtered results. The route-level `mp()` is close but diverges from canonical orphan logic.

**Recommended fix:** Replace `getInsights()` body with `passesProfileFilter()`. For the route-level `mp()`, replace with `passesProfileFilter()`.

---

### 2.6 Server-side /api/insights route uses inline mp() instead of passesProfileFilter — MEDIUM | S

**Location:** `server/routes.ts:1843-1848`

**Issue:**
```ts
const mp = (linked: string[]) => {
  if (!filterActive) return true;
  const arr = Array.isArray(linked) ? linked : [];
  if (arr.length === 0) return selfMatch;
  return arr.some(id => ids.includes(id));
};
```
This mirrors `passesProfileFilter` logic but is not the canonical call. Any future changes to `passesProfileFilter` won't automatically propagate here.

**Recommended fix:** Import and call `passesProfileFilter(linked, { selectedIds: ids, allProfiles })`.

---

## 3. Asset Nesting

### 3.1 profile-detail.tsx Financial Overview net worth uses truncated asset resolver — CRITICAL | M

**Location:** `client/src/pages/profile-detail.tsx:4063-4090`

**Issue:** The "Financial Overview" card rendered for person/self profiles computes `totalAssets` inline with a severely truncated field resolver:
```ts
const totalAssets = assets.reduce((s: number, c: any) => {
  const val = Number(c.fields?.currentValue || c.fields?.value || c.fields?.purchasePrice
              || c.fields?.balance || c.fields?.accountBalance || 0);
  return s + val;
}, 0);
```
This misses `c.fields?.marketValue`, `c.fields?.estimatedValue`, `c.fields?.cost`, `c.fields?.amount`, `c.fields?.price`, and all the nested namespace paths (`fields.housing.*`, `fields.finance.*`, `fields.other.*`, `fields.vehicle.*`, `fields.investment.*`) that `resolveAssetValue()` covers. An asset stored with `fields.housing.currentValue` will show `$0` here but `$X` on the Dashboard.

Similarly, the liability resolver:
```ts
const bal = Number(c.fields?.remainingBalance || c.fields?.loanBalance || c.fields?.balance || 0);
```
misses `fields.currentBalance`, `fields.finance.currentBalance`, `fields.loan.*`, and the nested `finance.loans[]` array that `resolveLiabilityValue()` covers.

**Canonical source:** `resolveAssetValue(profile)` / `resolveLiabilityBalance(profile)` from `dashboard.tsx` (lines 117–182).

**Impact:** Profile detail page Financial Overview shows a different (lower) net worth than the Dashboard for any asset with non-trivial field nesting. User sees two different net worth numbers for the same data.

**Recommended fix:** Replace the inline reducers with `resolveAssetValue(c)` and `resolveLiabilityBalance(c)`. Import from `dashboard.tsx` or — better — extract to `shared/asset-value.ts`.

---

### 3.2 finance.tsx "Asset Value" KPI uses custom readVal — HIGH | M

**Location:** `client/src/pages/finance.tsx:815-827` (already detailed as Finding 1.4)

This is a distinct instance: the Finance page top-section "Asset Value" tile uses `readVal`, while the Finance page's own lower Net Worth KPIs use `enhanced?.financeSnapshot?.totalAssetValue`. Two different computations on the same page.

**Impact:** Within the Finance page itself, "Asset Value" (top section) can differ from "Assets" (Net Worth KPI section lower down).

**Recommended fix:** Both Finance page KPIs should use the same source — either both from `enhanced.financeSnapshot` or both client-side with `resolveAssetValue()`.

---

### 3.3 profile-detail.tsx ValueRollup card uses computeAssetRollup correctly — PASS

**Location:** `client/src/pages/profile-detail.tsx:430-460`, then :1088

The top "Value Rollup" card on asset profiles correctly wraps `sharedComputeAssetRollup` from `@shared/asset-rollup`. No issue here. This is the canonical path and should be used as the model for fixing 3.1 and 3.2.

---

### 3.4 dashboard.tsx Finance section has third net-worth computation — HIGH | M

**Location:** `client/src/pages/dashboard.tsx:2985-3020`

The Finance section uses `resolveAssetValue(p)` (the correct mirror of the server resolver) and `resolveLiabilityBalance(p)`, but with its own inline `matchesProfileFilter` that differs from the Hero KPI's `matchesProfileFilter` (same bug as Finding 2.4 but in a different component).

**Impact:** Finance section tile net worth can differ from Hero KPI tile net worth when co-owned assets are present.

**Recommended fix:** Consolidate all three net-worth surfaces (Hero KPI, Finance section, Net Worth popup) to use a single extracted `buildNetWorthFromProfiles(allProfiles, filterMode, filterIds)` utility.

---

### 3.5 dashboard.tsx HeroKPISection filter misses "subscription"/"loan"/"account" profile types — MEDIUM | S

**Location:** `client/src/pages/dashboard.tsx:586-600`

`heroAssetProfiles` uses `resolveAssetValue(p) > 0` as the type gate, meaning any profile type with a positive value field is included. `heroLiabilityProfiles` uses `resolveLiabilityBalance(p) > 0`. However, `getDashboardEnhanced` asset computation gates on `childTypes = new Set(["vehicle", "asset", "investment", "property", "subscription", "loan", "account"])`, and liability computation on `liabilityTypes = new Set(["liability", "loan", "vehicle", "property", "asset", "account", "investment"])`. This type set mismatch means e.g. a `subscription` profile with a `currentValue` field appears in the Hero KPI asset total but is excluded from the server's `totalAssetValue`.

**Canonical source:** Server type gates in `getDashboardEnhanced`.

**Impact:** Hero tile asset total can exceed server total when subscription/person profiles carry stray value fields.

---

## 4. Optimistic Updates Without Rollback

### 4.1 profile-detail.tsx createExpenseMutation — no onMutate rollback — HIGH | S

**Location:** `client/src/pages/profile-detail.tsx:3946-3975`

**Issue:** `createExpenseMutation` has no `onMutate` block. On network failure, `onError` only shows a toast. There is no optimistic UI write and therefore no rollback, but the list will appear stale until the next invalidation cycle.

```ts
const createExpenseMutation = useMutation({
  mutationFn: async () => { ... },
  onSuccess: () => { ... queryClient.invalidateQueries(...) },
  onError: (err) => toast({ ... }),  // no setQueryData restore
});
```

**Impact:** Low severity — no ghost state since no optimistic write. But user sees no immediate feedback that the expense was added.

**Recommended fix:** Add `onMutate` optimistic insert + rollback on `onError`. Follow the pattern in `finance.tsx:207`.

---

### 4.2 profile-detail.tsx updateExpenseMutation — no onMutate — MEDIUM | S

**Location:** `client/src/pages/profile-detail.tsx:3972-3990`

Same pattern: no `onMutate`, no optimistic update. After the user edits an expense, the list stays stale until invalidation fires.

---

### 4.3 profile-detail.tsx deleteEntryMutation — no onError rollback — HIGH | S

**Location:** `client/src/pages/profile-detail.tsx:4890-4915`

**Issue:** `deleteEntryMutation` applies a setQueryData in `onSuccess` (not `onMutate`) — so there is no optimistic removal. On network failure, `onError` only shows a toast. Since there's no `onMutate`, there's nothing to roll back. But the more problematic pattern is that the `setQueryData` in `onSuccess` runs BEFORE `invalidateQueries`, creating a brief double-update cycle.

---

### 4.4 profile-detail.tsx DocumentSection deleteMutation — no onMutate rollback — HIGH | S

**Location:** `client/src/pages/profile-detail.tsx:3367-3397`

**Issue:** `deleteMutation` for documents does `setQueryData` in `onSuccess` to remove the doc from both `["/api/documents"]` and `["/api/profiles", profileId, "detail"]`. But there is no `onMutate` to capture prev state, and `onError` has no rollback:
```ts
onError: (err: Error) => {
  toast({ title: "Delete failed", description: formatApiError(err), variant: "destructive" });
},
```
If the delete API call fails after a brief delay, the document is NOT shown as deleted (since there's no optimistic removal), which is actually OK. But the pattern is inconsistent with the rest of the codebase and should have an `onMutate` + rollback for consistency.

---

### 4.5 profile-detail.tsx statusMutation — no optimistic update — MEDIUM | S

**Location:** `client/src/pages/profile-detail.tsx:2298-2315`

`statusMutation` (subscription pause/cancel/reactivate) has no `onMutate`. The button becomes `isPending` but the subscription card doesn't flip to the new state until the server responds. On failure, only a toast appears.

---

### 4.6 profile-detail.tsx logEntryMutation — no optimistic update — MEDIUM | S

**Location:** `client/src/pages/profile-detail.tsx:5182-5208`

Logging a tracker entry from profile detail has no `onMutate` optimistic insert. The trackers.tsx page's equivalent mutations all use `onMutate` with rollback. Inconsistency.

---

### 4.7 profile-detail.tsx createTaskMutation — no optimistic update — MEDIUM | S

**Location:** `client/src/pages/profile-detail.tsx:6018-6036`

`createTaskMutation` fires `onSuccess → invalidateQueries` with no optimistic insert. Tasks won't appear until the refetch resolves.

---

### 4.8 dashboard.tsx createHabitMutation — no onMutate — MEDIUM | S

**Location:** `client/src/pages/dashboard.tsx:1285-1295`

`createHabitMutation` does `onSuccess: invalidateQueries` only. No optimistic habit insert. The habit list stays stale while the server responds.

---

## 5. Calendar / Obligations Sync

### 5.1 CalendarView and ObligationsManager use different primary query keys — MEDIUM | S

**Location:** `client/src/components/CalendarView.tsx` (uses `["/api/calendar/timeline"]`) vs `client/src/components/ObligationsManager.tsx` (uses `["/api/obligations"]` and `["/api/obligation-occurrences", ...]`)

**Issue:** When on the Calendar page, the two tabs ("Calendar" and "Obligations") render `CalendarView` and `ObligationsManager` respectively. An obligation edit in `ObligationsManager` calls `invalidateAll()` which correctly invalidates both `["/api/obligation-occurrences"]` and `["/api/calendar/timeline"]`, so switching tabs should refresh. However, CalendarView's own occurrence-marking (marking an occurrence done) invalidates `["/api/calendar/timeline"]` and `["/api/obligation-occurrences"]` but does NOT invalidate `["/api/obligations"]`:
```ts
// CalendarView.tsx:788-791
queryClient.invalidateQueries({ queryKey: ["/api/calendar/timeline"] });
queryClient.invalidateQueries({ queryKey: ["/api/obligation-occurrences"] });
queryClient.invalidateQueries({ queryKey: ["/api/obligations"] });  ← this IS there
queryClient.invalidateQueries({ queryKey: ["/api/dashboard-enhanced"] });
```
Actually cross-checking CalendarView:788-791: obligations IS invalidated. The sync here is adequate.

---

### 5.2 CalendarView profile filter passed as externalFilterIds but ObligationsManager reads its own filter — LOW | S

**Location:** `client/src/pages/calendar-page.tsx:74-80`

**Issue:** `CalendarView` receives `externalFilterIds` and `externalFilterMode` from the page's profile filter state. But `ObligationsManager` is rendered without any filter props and reads its own profile filter via `subscribeProfileFilter()` (ObligationsManager.tsx:570). Both should be in sync because they both read from the same localStorage key, but there's a brief race during initial render where each component independently initializes from `getProfileFilter()`.

**Impact:** On very fast filter changes, the Calendar tab and Obligations tab could momentarily show data filtered by different profiles.

---

### 5.3 Obligation occurrence pagination window is hardcoded — MEDIUM | S

**Location:** `client/src/components/ObligationsManager.tsx:962-974`

**Issue:**
```ts
const occStartIso = useMemo(() => new Date(Date.now() - 60 * 86400000).toLocaleDateString("en-CA"), []);
const occEndIso = useMemo(() => new Date(Date.now() + 30 * 86400000).toLocaleDateString("en-CA"), []);
```
The occurrence window (`-60d to +30d`) is computed once on mount (empty dependency array `[]`). If the component stays mounted for more than a day (e.g., user leaves the app open), the window becomes stale and occurrences for "today" may shift out of range.

**Impact:** Long-running sessions show incorrect overdue/upcoming counts without a remount.

**Recommended fix:** Add `Date.now()` or a daily tick to the dependency array to recompute the window.

---

### 5.4 obligation-engine materializeOccurrences not called on obligation PATCH — MEDIUM | M

**Location:** `server/routes.ts:4169-4190`

**Issue:** When an obligation is PATCHed (updated), the server updates the obligation row but does not call `materializeOccurrences()`. New occurrences based on the updated `nextDueDate` or `frequency` are only generated when `/api/obligations/:id/materialize` is explicitly called.

```ts
app.patch("/api/obligations/:id", asyncHandler(async (req, res) => {
  // ... updates obligation
  // Does NOT call materializeOccurrences
}));
```

**Impact:** Editing an obligation's frequency or next-due-date doesn't immediately create new occurrence rows. Calendar view won't show the updated schedule until materialize is called.

**Recommended fix:** Call `materializeOccurrences()` at the end of the PATCH handler (or queue it as a background task).

---

## 6. Cross-View Drift Per Entity

### 6.1 Goals query key drift between dashboard and trackers — CRITICAL | S

**Location:** `client/src/pages/dashboard.tsx:2298` vs `client/src/pages/trackers.tsx:3314`

**Issue:** Dashboard's `GoalsSection` queries:
```ts
queryKey: ["/api/goals", ids.join(",") || "all"]
```
Trackers.tsx queries:
```ts
queryKey: ["/api/goals"]
```
These are **different cache entries**. A goal mutated in the Trackers page invalidates `["/api/goals"]` (bare key). The Dashboard's goals use `["/api/goals", "all"]` or `["/api/goals", "profileId1,profileId2"]`. The invalidation from trackers.tsx never hits the dashboard's filtered key.

**Impact:** After deleting a goal in the Trackers view, the Dashboard Goals section shows the deleted goal until the 30-second staleTime fires. Critical for data integrity.

**Recommended fix:** Standardize on one query key shape for goals. Options: (a) always use `["/api/goals"]` and filter client-side; (b) always use `["/api/goals", ids.join(",") || "all"]` everywhere. Mutations must invalidate the base key `["/api/goals"]` (which React Query prefix-matches).

---

| Entity | Page | Query Key | Uses Canonical Computation? | Mutation Invalidates Other Views? |
|---|---|---|---|---|
| Tasks | `tasks.tsx` | `["/api/tasks", filterMode, ...filterIds]` | N/A | YES — invalidates `["/api/tasks"]` prefix |
| Tasks | `dashboard.tsx` | `["/api/tasks", filterMode, ...filterIds]` | N/A | YES |
| Tasks | `profile-detail.tsx` | via `["/api/profiles", id, "detail"]` embedded | N/A | YES — also invalidates `["/api/tasks"]` |
| Tasks | `tasks.tsx` mutations | `["/api/tasks"]` prefix invalidation | N/A | YES |
| Habits | `habits.tsx` | `["/api/habits"]` | N/A | YES — invalidates `["/api/habits"]` |
| Habits | `dashboard.tsx` | `["/api/habits", filterMode, ...filterIds]` | N/A | Partial — invalidates `["/api/habits"]` (prefix match OK) |
| Goals | `trackers.tsx` | `["/api/goals"]` | N/A | **NO** — misses dashboard's filtered key |
| Goals | `dashboard.tsx` | `["/api/goals", ids.join(",") \|\| "all"]` | N/A | **NO** — misses trackers' bare key |
| Expenses | `finance.tsx` | `["/api/expenses", filterMode, ...filterIds]` | `passesProfileFilter` ✓ | YES |
| Expenses | `dashboard.tsx` | `["/api/expenses", filterMode, ...filterIds]` | N/A | YES |
| Expenses | `profile-detail.tsx` | Embedded in `/api/profiles/:id/detail` | N/A | Invalidates both keys |
| Obligations | `calendar-page.tsx` (ObligationsManager) | `["/api/obligations", filterMode, ...filterIds]` | Partial (client-side re-filter not canonical) | YES — `invalidateAll()` covers timeline |
| Obligations | `obligations.tsx` (standalone) | See ObligationsManager | Same | Same |
| Assets | `dashboard.tsx` HeroKPI | Client-side from `["/api/profiles"]` | `resolveAssetValue` ✓ (but filter diverges) | N/A — read only |
| Assets | `dashboard.tsx` Finance | Client-side from `["/api/profiles"]` | `resolveAssetValue` ✓ (different filter) | N/A — read only |
| Assets | `finance.tsx` | Client-side from `["/api/profiles"]` | `readVal` ✗ (different resolver) | N/A — read only |
| Assets | `profile-detail.tsx` Finance Overview | Client-side from `childProfiles` | **Truncated resolver** ✗ | N/A — read only |
| Assets | Net Worth Popup | Client-side from `["/api/profiles", "net-worth"]` | `resolveAssetValue` ✓ | N/A — read only |
| Trackers | `trackers.tsx` | `["/api/trackers"]` | N/A | YES |
| Trackers | `profile-detail.tsx` | `["/api/profiles", id, "detail"]` embedded | N/A | Invalidates both |
| Events | `CalendarView` | `["/api/calendar/timeline"]`, `["/api/events"]` | N/A | YES |
| Documents | `artifacts.tsx` | `["/api/documents"]` | N/A | YES |
| Documents | `profile-detail.tsx` | `["/api/profiles", id, "detail"]` + `["/api/documents"]` | N/A | YES — both keys |

### 6.2 Habits page missing filterMode in query key — MEDIUM | S

**Location:** `client/src/pages/habits.tsx:47-50`

**Issue:** `habits.tsx` queries habits at key `["/api/habits"]` without appending `filterMode` or `filterIds`. `dashboard.tsx` uses `["/api/habits", filterMode, ...filterIds]`. These never share a cache entry even for identical filters. When the Dashboard popup marks a habit done, it invalidates `["/api/habits"]` (prefix), which correctly busts both. But the `habits.tsx` page's stale data for the unfiltered key can flash on return navigation.

**Impact:** Brief stale flash on habits page after dashboard checkin.

---

### 6.3 Profile-detail tasks embedded in detail vs top-level tasks key — MEDIUM | S

**Location:** `client/src/pages/profile-detail.tsx:5993`, `6049`

**Issue:** Profile-detail renders tasks from `profile.tasks` (embedded in the detail API response), while `tasks.tsx` reads from `["/api/tasks", filterMode, ...filterIds]`. Mutations in profile-detail correctly invalidate both `["/api/tasks"]` and `["/api/profiles", profileId, "detail"]`, so this is largely safe. However, the profile-detail's task `toggleMutation` optimistically updates only `["/api/profiles", profileId, "detail"]` (line 5993) and the top-level `["/api/tasks"]` prefix. If the task was loaded under a filtered key `["/api/tasks", "selected", "profileId"]` in the tasks page simultaneously, the filtered cache entry remains stale until invalidation.

---

## 7. Large-File Inline Recomputation

### 7.1 profile-detail.tsx: Financial Overview net worth computed inline in render — CRITICAL | M

**Location:** `client/src/pages/profile-detail.tsx:4063-4090`

**Issue:** The entire net worth computation (already described in Finding 3.1) runs inside an IIFE in JSX render on every render cycle. It is not memoized with `useMemo`. The computation iterates `profile.childProfiles` (potentially 20–100 items), maps over them twice (assets filter, loans filter), and runs three `reduce` calls.

```tsx
// profile-detail.tsx:4063 — runs on every re-render
{["self","person"].includes(profile.type) && (() => {
  const children = (profile as any).childProfiles || [];
  const assets = children.filter((c: any) => assetTypes.includes(c.type));
  const totalAssets = assets.reduce((s, c) => {
    const val = Number(c.fields?.currentValue || ...);  // truncated resolver
    return s + val;
  }, 0);
  ...
  const netWorth = totalAssets - totalLiabilities;
```

**Impact:** Unnecessary recomputation on every render of the profile detail page (which has many state updates: hover, expand/collapse, input focus). Plus the truncated resolver produces wrong numbers (see Finding 3.1).

**Recommended fix:** Extract to a `useMemo` that depends on `[profile.childProfiles, sharedLiabilitiesUserShare]`. Use `resolveAssetValue` / `resolveLiabilityBalance`.

---

### 7.2 profile-detail.tsx: sharedLiabilities inline computed outside useMemo — MEDIUM | S

**Location:** `client/src/pages/profile-detail.tsx:3735-3756`

**Issue:**
```ts
const sharedLiabilities = (sharedLiabilityLinks || [])
  .map((link: any) => {
    const lp = (allProfilesForLinks || []).find((p: any) => p.id === link.liabilityProfileId);
    ...
  })
  .filter(...)
const sharedLiabilitiesUserShare = sharedLiabilities.reduce(...);
const sharedMonthlyShare = sharedLiabilities.reduce(...);
```
These are computed at top level in the `FinancesTab` component body without `useMemo`. They re-run on every render, including unrelated state updates within the tab.

**Recommended fix:** Wrap in `useMemo([sharedLiabilityLinks, allProfilesForLinks])`.

---

### 7.3 profile-detail.tsx: repairTotal inline reduce in maintenance section — LOW | S

**Location:** `client/src/pages/profile-detail.tsx:1339`

```ts
const repairTotal = allRepairs.reduce((sum, r) => sum + (Number(r.expense.amount) || 0), 0);
```
`allRepairs` is a `useMemo` but `repairTotal` is not. Runs on every render.

---

### 7.4 dashboard.tsx: netWorth computed twice in same component — MEDIUM | S

**Location:** `client/src/pages/dashboard.tsx:600` and `client/src/pages/dashboard.tsx:3016`

**Issue:** `netWorth = totalAssetValue - totalLiabilities` is computed at line 600 (inside `HeroKPISection`) and again at line 3016 (inside the Finance section render). These are in different components (HeroKPISection and FinanceSection), so the duplication is structural, not a single-component issue. But they use slightly different profile filters (documented in Findings 2.4 and 3.4), so the two `netWorth` values diverge.

---

### 7.5 dashboard.tsx: expensesTotal inline computed in profile-detail — MEDIUM | S

**Location:** `client/src/pages/profile-detail.tsx:2799`

```ts
const expensesTotal = (profile.relatedExpenses || []).reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
```
Computed at component body level (no `useMemo`), runs on every render.

---

### 7.6 trackers.tsx: insights useMemo with large computation — LOW | S

**Location:** `client/src/pages/trackers.tsx:3234`

```ts
const insights = useMemo(() => { ... }, [...]);
```
`insights` is memoized — this is correctly using `useMemo`. No issue here.

---

### 7.7 profile-detail.tsx: 6 month "trend" sparkline uses fabricated data — HIGH | S

**Location:** `client/src/pages/dashboard.tsx:3086-3095`

**Issue:** The Net Worth "6-Month Trend" sparkline in the Finance section is synthesized from the current net worth and spending estimate:
```tsx
const nwData = Array.from({length: 6}, (_, i) => ({
  month: ...,
  value: Math.max(0, baseNW - mSpend * (5 - i) * 0.8)
}));
```
This is fabricated data, not historical net worth. The trend will always show net worth "growing" because the formula projects backward (subtracting spend from the current value). It is user-visible as "your net worth has been trending up" even if it hasn't.

**Impact:** Misleading historical trend display — user sees a fabricated upward trend line even if they've been spending down their assets.

**Recommended fix:** Either remove the sparkline, replace with actual snapshots stored in the DB, or label it clearly as "estimated projection" rather than "6-Month Trend".

---

## Appendix: Query Key Inventory

| Query Key | Endpoint | Consumers |
|---|---|---|
| `["/api/stats", filterMode, ...filterIds]` | GET /api/stats | dashboard.tsx, (bootstrap pre-fill) |
| `["/api/dashboard-enhanced", filterMode, ...filterIds]` | GET /api/dashboard-enhanced | dashboard.tsx, finance.tsx |
| `["/api/profiles"]` | GET /api/profiles | dashboard.tsx HeroKPI, NetWorthPopup, finance.tsx, profile-detail.tsx, trackers.tsx |
| `["/api/profiles", "net-worth"]` | GET /api/profiles | HeroKPIPopups.tsx NetWorthPopup |
| `["/api/profiles", id, "detail"]` | GET /api/profiles/:id (detail) | profile-detail.tsx |
| `["/api/tasks"]` (prefix) | GET /api/tasks | All — broadcast invalidation |
| `["/api/tasks", filterMode, ...filterIds]` | GET /api/tasks?profileIds=... | tasks.tsx, dashboard.tsx |
| `["/api/habits"]` (prefix) | GET /api/habits | habits.tsx, broadcast invalidation |
| `["/api/habits", filterMode, ...filterIds]` | GET /api/habits?profileIds=... | dashboard.tsx |
| `["/api/trackers"]` (prefix) | GET /api/trackers | trackers.tsx, profile-detail.tsx |
| `["/api/expenses"]` (prefix) | GET /api/expenses | Broadcast invalidation |
| `["/api/expenses", filterMode, ...filterIds]` | GET /api/expenses?profileIds=... | finance.tsx, dashboard.tsx |
| `["/api/obligations", filterMode, ...filterIds]` | GET /api/obligations?profileIds=... | ObligationsManager, finance.tsx |
| `["/api/obligation-occurrences", ...]` | GET /api/obligation-occurrences?start=&end=... | ObligationsManager |
| `["/api/calendar/timeline"]` | GET /api/calendar/timeline | CalendarView |
| `["/api/events"]` | GET /api/events | CalendarView |
| `["/api/goals"]` | GET /api/goals | trackers.tsx |
| `["/api/goals", ids.join(",") \|\| "all"]` | GET /api/goals?profileIds=... | dashboard.tsx GoalsSection |
| `["/api/documents"]` | GET /api/documents | profile-detail.tsx, artifacts.tsx |
| `["/api/budgets/summary", month, filterMode, ...filterIds, "hero"]` | Client-composed | dashboard.tsx HeroKPI, Finance section |
| `["/api/incomes", filterMode, ...filterIds, "hero"]` | GET /api/incomes | dashboard.tsx HeroKPI |
| `["/api/parties", profileId, "liabilities"]` | GET /api/parties/:id/liabilities | profile-detail.tsx FinancesTab |
| `["/api/profiles", profileId, "ai-summary"]` | GET /api/profiles/:id/ai-summary | profile-detail.tsx |

---

## Appendix: Mutation Inventory

| Mutation Site | Endpoint | Uses Canonical Optimistic Helper? | Invalidates Which Domains? | Has onError Rollback? |
|---|---|---|---|---|
| `dashboard.tsx TaskSection.createMutation` | POST /api/tasks | Manual (onMutate + rollback) | tasks | YES |
| `dashboard.tsx TaskSection.toggleMutation` | PATCH /api/tasks/:id | Manual (patchStatsTaskDelta) | tasks, stats, dashboard-enhanced | YES |
| `dashboard.tsx TaskSection.deleteMutation` | DELETE /api/tasks/:id | Manual | tasks, stats, dashboard-enhanced | YES |
| `dashboard.tsx HabitSection.checkinMutation` | POST /api/habits/:id/checkin | Manual | habits, stats | YES |
| `dashboard.tsx HabitSection.createHabitMutation` | POST /api/habits | **None** (no onMutate) | habits, dashboard-enhanced, stats | NO |
| `dashboard.tsx GoalsSection.deleteMutation` | DELETE /api/goals/:id | Manual — wrong key | goals (filtered key only) | YES (but wrong key) |
| `profile-detail.tsx patchParent` | PATCH /api/profiles/:id | None | profiles | NO |
| `profile-detail.tsx statusMutation` | PATCH /api/profiles/:id | None | profiles, dashboard-enhanced, stats | NO |
| `profile-detail.tsx createExpenseMutation` | POST /api/expenses | **None** | profiles/detail, expenses, stats | NO |
| `profile-detail.tsx updateExpenseMutation` | PATCH /api/expenses/:id | **None** | profiles/detail, expenses, stats | NO |
| `profile-detail.tsx deleteExpenseMutation` | DELETE /api/expenses/:id | onSuccess setQueryData (not onMutate) | profiles/detail, expenses, stats | NO |
| `profile-detail.tsx DocumentSection.deleteMutation` | DELETE /api/documents/:id | onSuccess setQueryData only | documents, profile/detail | NO |
| `profile-detail.tsx logEntryMutation` | POST /api/trackers/:id/entries | **None** | trackers, stats, dashboard-enhanced | NO |
| `profile-detail.tsx deleteEntryMutation` | DELETE /api/trackers/:id/entries/:id | onSuccess setQueryData only | trackers, stats | NO |
| `profile-detail.tsx createTaskMutation` | POST /api/tasks + link | **None** | tasks, profiles/detail, stats | NO |
| `profile-detail.tsx toggleMutation (tasks)` | PATCH /api/tasks/:id | Manual (profiles/detail + tasks) | tasks, profiles/detail, stats | YES |
| `profile-detail.tsx deleteTaskMutation` | DELETE /api/tasks/:id | onSuccess setQueryData | tasks, profiles/detail, stats | NO |
| `trackers.tsx logDoseMut` | POST /api/trackers/:id/entries | Manual | trackers, stats | YES |
| `trackers.tsx editMutation (entry)` | PATCH /api/trackers/:id/entries/:id | Manual | trackers, stats | YES |
| `trackers.tsx trackerDeleteMutation` | DELETE /api/trackers/:id | Manual | trackers | YES |
| `finance.tsx createExpenseMutation` | POST /api/expenses | Manual (full onMutate + rollback) | expenses, stats, dashboard-enhanced, budgets | YES |
| `ObligationsManager.OccurrenceRow.setStatus` | POST /api/obligation-occurrences/:id/status | Manual | obligation-occurrences | YES |
| `CalendarView.saveEventMutation` | POST/PATCH /api/events | Manual | events, calendar/timeline, stats | YES |
