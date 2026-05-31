# Destructive QA Audit — LifeOS Portal (2026-05-31)

> **How this audit was done (and its limits — read first).**
> This container **cannot boot the app**: SQLite was removed (`server/storage.ts:2132`),
> so the server hard-requires `VITE_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`,
> which are not present. There is also no browser automation here. So I could **not**
> physically click buttons in a live UI. Instead this is a **static + unit-test
> audit**: I installed deps, ran the real type-checker and unit suite, and read the
> actual source to confirm every finding with `file:line` evidence.
>
> **Runtime facts established:**
> - `tsc --noEmit` → **0 errors**.
> - `vitest run` → **175 tests pass (12 files)**.
> - BUT the unit tests only cover *pure helper functions* (`net-worth`, `liability-calc`,
>   `profile-filter`, `scope`, `asset-rollup`, `ownership`, `timezone`). **No automated
>   test exercises the route handlers' filtering or the client page filtering** — which
>   is exactly where the worst bugs below live. That is why green tests coexist with
>   real cross-profile leaks.
>
> Findings marked **[VERIFIED]** I confirmed by reading the exact lines. Findings
> marked **[CREDIBLE]** are precise `file:line` reports from deep code-analysis passes
> that I did not independently re-open line-by-line but are internally consistent.

---

## SEVERITY SUMMARY

| # | Severity | Area | One-line |
|---|----------|------|----------|
| C1 | Critical | Isolation | Habits/Tasks/Artifacts/Occurrences each use a different profile-filter rule → your own data shows under the wrong profile or vanishes; page counts disagree |
| C2 | Critical | Isolation | localStorage filter + cached dashboard data are not per-user and load before login → on a shared device User B briefly sees User A's data |
| H1 | High | Money | Negative net worth is shown as **$0** while the breakdown shows the real debt |
| H2 | High | Money | A bank account stored in `fields.balance` counts as BOTH asset and liability → net worth $0 |
| H3 | High | Money | Loan payments may not reduce the displayed balance (writer & reader use different fields) |
| H4 | High | Money | "Upcoming bills" uses 5 different time windows + counts overdue as upcoming → tile count ≠ popup/list |
| H5 | High | Security/Integrity | Link `PATCH` endpoints accept raw body: ownership % can be set negative/>100, references repointed to arbitrary IDs |
| H6 | High | UX | Document **Download** button always produces a corrupt file but says "Download started" |
| H7 | High | UX | Quick-create Task/Bill + habit Enter key have no in-flight guard → double-click makes duplicates |
| H8 | High | Cache | Goals cache is split between Dashboard and Trackers → create/delete on one doesn't show on the other |
| M1 | Medium | Money | Semiannual/daily bills counted as monthly in dashboard cash-flow (6×–30× overcount) |
| M2 | Medium | AI/Chat | A failed AI chat leaves an idempotency "pending" lock → retry blocked with 409 |
| M3 | Medium | Isolation | CalendarView keeps previous profile's events on screen during a profile swap |
| M4 | Medium | Validation | Tracker-entry edit accepts text/Infinity/negatives that create rejects |
| M5 | Medium | Validation | Reschedule via `window.prompt` accepts impossible dates (2026-02-31) |
| M6 | Medium | Validation | Obligation amount accepts `1e999` → `$Infinity` rendered |
| M7 | Medium | Money | Weekly digest mood average uses the wrong 1–5 scale |
| M8 | Medium | Integrity | Ownership % not validated to sum ≤100 across co-owners |
| L1+ | Low | Various | Dead `MemStorage` math bugs, rollup weekly drift, locale parsing, hash-param stripping, etc. |

---

## CRITICAL

### C1 — Profile filtering is implemented 4+ different ways; they disagree  **[VERIFIED]**
**What happens:** The app has ONE canonical rule (`shared/profile-filter.ts` → `shared/scope.ts`):
*an item with no linked profiles ("orphan" = your legacy data) shows only when a **Self**
profile is selected.* Several screens ignore this and roll their own rule.

Evidence:
- `server/routes.ts:4018-4020` (habits, multi-select): orphan rule **dropped** — orphans never pass.
- `server/routes.ts:4026` (habits, single-select): orphan rule **present** (`isSelf && lp.length===0`).
  → Same selection returns different habits depending on single vs multi select.
- `client/src/pages/habits.tsx:404-409`: client shows orphans for **every** selected profile (leak).
- `client/src/pages/tasks.tsx:543-547`: client **omits** the orphan rule; `server/routes.ts:3293-3296`
  **includes** it → server returns your orphan tasks, client filters them back out.
- `client/src/pages/artifacts.tsx:718-724` + `server/routes.ts:4381-4383`: orphans always hidden.
- `client/src/components/ObligationsManager.tsx:578-582,1037-1041`: occurrences re-filtered with a
  no-orphan rule while the obligation list in the same component uses the canonical rule → a bill
  shows in one panel and is missing from the "due soon" counts.

**Expected:** every surface calls `passesProfileFilter`. **Actual:** habits, tasks, artifacts,
occurrences each hand-roll a divergent rule; client and server disagree per entity.
**Root cause:** the `shared/profile-filter.ts` consolidation was adopted by ~half the screens; the rest
still inline ad-hoc `lp.some(...)` / `lp.length===0` checks.
**Fix:** delete every inline filter and call `passesProfileFilter` (client) / the same helper (server)
in all listed spots. Add a contract test that feeds an orphan item + a non-self selection through
each route and asserts identical results.

### C2 — Per-user data is not isolated in the browser  **[CREDIBLE]**
**What happens:** On a shared device, after User A logs out by closing the tab / session expiry
(not the explicit Sign-Out button), User B can briefly see User A's numbers.

Evidence:
- `client/src/lib/queryClient.ts:241-253`: the persisted React-Query cache key is a single global
  `"portol-query-cache-v1"` — **not namespaced by user id** — and is hydrated at boot
  (`client/src/main.tsx:18`) before auth resolves. Comment assumes keys "segment by filter/profile"
  but they do **not** segment by user.
- `client/src/lib/profileFilter.ts:32-41`: filter state initializes from whatever `USER_ID_KEY`
  was last written, falling back to a global un-namespaced slot. It's cleared only on the explicit
  sign-out path (`auth.tsx:357`); the token-expiry path (`queryClient.ts:91-101`) does not call
  `clearProfileFilterForUser`.

**Expected:** cache + filter resolve to the authenticated user before first render.
**Actual:** they load before login and persist across non-explicit exits.
**Root cause:** isolation wired only to the explicit Sign-Out button; boot/expiry/cross-tab paths skip it.
**Fix:** namespace `STORAGE_KEY` and the filter key by user id; skip hydrate until the active user is
confirmed; wire the `portol:auth-cleared` event to clear filter + cache.

---

## HIGH

### H1 — Negative net worth shows as $0  **[VERIFIED]**
`client/src/pages/dashboard.tsx:572` → `useCountUp(Math.max(0, Math.round(netWorth)))`.
If debts > assets, the headline reads **$0** while the line under it (`:601-603`) correctly shows
`Assets $X / Liab $Y`. The popup (`:3285`) handles negatives correctly — only the hero tile is wrong.
**Fix:** animate `Math.round(netWorth)` and let the formatter print the minus sign.

### H2 — A bank account counts as both an asset and a liability  **[CREDIBLE]**
`shared/asset-value.ts`: `fields.balance` is a candidate in **both** `resolveAssetValue` (`:72`) and
`resolveLiabilityBalance` (`:106`); and `account`/`investment`/`asset` are in **both** type sets
(`:139,:152`). `server/supabase-storage.ts:4168` (assets) and `:4212` (liabilities) both iterate the
same profile. So an `account` with `fields.balance=5000` → +5000 asset and −5000 liability = **$0** net.
**Fix:** only treat asset-typed profiles as liabilities when a dedicated debt field
(`remainingBalance`/`currentBalance`/`loanBalance`) is present; drop the bare `fields.balance`
fallback from the liability resolver.

### H3 — Loan payments don't reduce the displayed balance  **[CREDIBLE]**
`server/obligation-engine.ts:323-326` reads `fields.remainingBalance ?? fields.balance` but writes back
**only** `fields.remainingBalance`. The reader `resolveLiabilityBalance` checks `fields.balance`
(`asset-value.ts:106`) **before** `remainingBalance` (`:107`). So a loan whose value lived in
`fields.balance` keeps showing the old number after a payment. Also the balance is a raw float (no cents
rounding) → drift over many payments.
**Fix:** round to cents and write back to the same field that was read (or clear the stale alias).

### H4 — "Upcoming bills" count never matches the popup  **[VERIFIED windows exist]**
Five different windows for the same concept:
- `shared/obligation-windows.ts:28` `<= 30` (no lower bound → counts overdue)
- `server/supabase-storage.ts:3919-3922`, `:4145` `<= 30` (no lower bound)
- `server/routes.ts:1091` AI-summary `-1..7`
- `server/routes.ts:5567` weekly-digest `today..+14`
- `server/insights-engine.ts:496-500` `now..+7`
Same data → counts of 2 / 6 / 2 on different surfaces, and a bill due a year ago still counts as
"upcoming" (`daysUntil <= 30` with no `>= 0` floor).
**Fix:** every surface uses `isUpcomingBill` / `UPCOMING_BILL_WINDOW_DAYS`; add a `>= 0` floor and a
separate "Overdue" bucket.

### H5 — Link PATCH endpoints accept anything  **[VERIFIED]**
`server/routes.ts:6658-6661` (also `:6750`, `:6775`, `:6854`) pass `req.body` straight to storage with
**no zod parse and no ownership check**, unlike the `POST` sibling at `:6654` which verifies both ends
are owned. Storage is user-scoped so it's not a cross-user breach, but you can:
- set `ownershipPercentage` to `-50` or `99999` (the `.min(0).max(100)` guard is only on *insert*
  schemas — `shared/schema.ts:1077,1087,1115`), skewing every net-worth rollup that multiplies by it;
- repoint `assetProfileId`/`partyProfileId` to an arbitrary/garbage UUID, orphaning the graph.
**Fix:** `insertXSchema.partial().safeParse(req.body)` + re-verify referenced profile ownership on update.

### H6 — Document Download button is broken (silently)  **[VERIFIED]**
`client/src/pages/document-detail.tsx:365` builds `data:${doc.mimeType};base64,${doc.fileData}`, but the
team's own comment at `:199-208` ("BUG-D02") says the server **strips `fileData`** from
`/api/documents/:id`. They fixed `previewUrl` (`:207`) but missed `downloadFile`. Result: a corrupt file
containing `...;base64,undefined`, while the toast still says "Download started".
**Fix:** point `link.href` at `/api/documents/${doc.id}/file` (mirror `previewUrl`).

### H7 — Double-click creates duplicates  **[VERIFIED]**
- `client/src/components/QuickCreateFab.tsx:266` (Task) and `:378` (Bill): Create button `disabled` only
  checks empty input, **not** `m.isPending`. The Tracker dialog at `:449` does it right
  (`|| m.isPending`).
- `client/src/pages/habits.tsx:411-421` `handleCreate`: not guarded by `isPending`; the Enter-key path
  bypasses the (correctly disabled) button. The duplicate-name check reads the *cached* list, which
  hasn't refetched, so both submissions pass.
**Fix:** add `|| m.isPending` to the buttons and `if (mutation.isPending) return;` at the top of
`handleCreate`.

### H8 — Goals don't sync between Dashboard and Trackers  **[VERIFIED]**
`shared/query-keys.ts:23-29` `goalsQueryKey`. `client/src/pages/dashboard.tsx:2283` calls it with the
active ids → `["/api/goals","selected",id]`; `client/src/pages/trackers.tsx:3316` calls it with `[]` →
always `["/api/goals","all"]`. Two cache slots → optimistic create/delete/complete on one screen never
updates the other. Compounded by: `profileFilteredKey` (`query-keys.ts:32`) is defined but **never used**
(every inline key spreads `...filterIds` unsorted, so `[a,b]` and `[b,a]` are different slots), and the
`"all"` vs `"everyone"` vocabulary split between `query-keys.ts:19` and `profileFilter.ts`.
**Fix:** pass the active ids into `goalsQueryKey` in trackers; route all filterable keys through
`profileFilteredKey`; pick one vocabulary.

---

## MEDIUM

- **M1 — Semiannual/daily bills mis-summed** `client/src/pages/dashboard.tsx:3225-3234` re-implements
  monthly conversion inline and lacks `semiannual`/`daily` cases → a $1,200 semiannual bill shows
  **$1,200/mo** instead of $200 (finance.tsx uses the canonical `toMonthlyAmount`, so the two pages
  disagree). **Fix:** import `toMonthlyAmount`. **[CREDIBLE]**
- **M2 — Chat idempotency lock on failure** `server/routes.ts:624,637-655`: a failed AI call leaves
  status `pending`; retry with the same `Idempotency-Key` returns **409** until TTL. **Fix:** clear the
  pending entry in the catch block. **[CREDIBLE]**
- **M3 — Calendar shows the previous profile's events on swap** `client/src/components/CalendarView.tsx:1048-1057`
  uses `placeholderData: keepPreviousData` on a filter-keyed query — the exact thing the global default
  (`queryClient.ts:178-191`) was changed to avoid. **Fix:** drop `keepPreviousData` when only the filter
  changed. **[CREDIBLE]**
- **M4 — Tracker-entry edit weaker than create** `server/routes.ts:3137-3140` (PATCH) only rejects literal
  `NaN`; POST (`:3050-3068`) coerces/bounds. Text, `Infinity`, negatives pass on edit. **Fix:** share the
  POST coercion helper. **[CREDIBLE]**
- **M5 — Reschedule accepts impossible dates** `client/src/components/ObligationsManager.tsx:222-225`
  uses `window.prompt` + a shape-only regex → `2026-02-31` passes. **Fix:** use a date `<Input>`. **[CREDIBLE]**
- **M6 — Obligation amount accepts Infinity** `client/src/components/ObligationsManager.tsx:338-360`:
  `1e999` → `Infinity` passes the `<= 0` guard, renders `$Infinity`. **Fix:** `Number.isFinite && < 1e12`. **[CREDIBLE]**
- **M7 — Weekly digest mood scale wrong** `server/routes.ts:5560-5562` uses a private 1–5 map; the rest of
  the app uses `MOOD_SCORES` (1–8, includes great/okay/terrible). Moods like `great` fall to the neutral
  default. **Fix:** import `MOOD_SCORES`. **[CREDIBLE]**
- **M8 — Co-owner % can exceed 100** `server/supabase-storage.ts:5038-5063` validates each link 0–100 but
  never checks the set sums to ≤100 → three owners at 100% each. **Fix:** sum existing links on write. **[CREDIBLE]**
- **M9 — `unlink` endpoint unvalidated** `server/routes.ts:2506-2512` skips the presence/type/ownership
  checks its `/link` sibling has and always returns `{ok:true}`. **[VERIFIED pattern]**
- **M10 — Memo cache keys omit userId** `server/supabase-storage.ts:5022,4828` key by profile id only;
  safe only while instances are strictly per-user. Defense-in-depth: add `this.userId`. **[CREDIBLE]**
- **M11 — Artifact checklist toggle has no in-flight guard** `client/src/pages/artifacts.tsx:185-195`:
  rapid clicks race against a non-idempotent toggle endpoint → visual state desyncs. **[CREDIBLE]**
- **M12 — Onboarding stores untrimmed name** `client/src/components/OnboardingWizard.tsx:166` sends raw
  `name` (gate trims for validation only) → `"  Bob  "` persisted. **[CREDIBLE]**

---

## LOW

- **L1 — Dead `MemStorage` contains real bugs** `server/storage.ts:703` `class MemStorage` is **never
  instantiated** (`getStorage()` only ever returns `SupabaseStorage`). Its `getStats` uses the truncated
  `4.33`/`2.17` multipliers (`:1836-1837`) AND drops unknown frequencies (`:1841 default: return s`). Not
  executed in prod, but it's a trap and proves the canonical helper isn't enforced. **Fix:** delete the class. **[VERIFIED]**
- **L2 — `ai-engine.ts:8269`** weekly→monthly uses `4.33` instead of `52/12`. **[CREDIBLE]**
- **L3 — `shared/asset-rollup.ts:109-110`** weekly `4.345` / daily `30.44` disagree with `toMonthlyAmount`
  (`4.3333` / `30.4167`) → ~$1/mo drift per weekly item. **[CREDIBLE]**
- **L4 — Spending-pace day-1 projection** `server/insights-engine.ts:106` `(monthTotal/dayOfMonth)*daysInMonth`
  projects $15,000 from one $500 expense on the 1st. **Fix:** require `dayOfMonth >= 3`. **[CREDIBLE]**
- **L5 — DrillDown locale parse** `client/src/components/DrillDownDialog.tsx:73` mis-parses EU-formatted
  totals → phantom "Discrepancy" banner. **Fix:** pass numbers, not formatted strings. **[CREDIBLE]**
- **L6 — Hash query stripping** `client/src/pages/tasks.tsx:503-512` (and habits/journal) discards the whole
  hash query when removing `?new=1`. **[CREDIBLE]**
- **L7 — `Dismiss all` notifications** `client/src/components/NotificationBell.tsx:175-182` uses the raw
  fetched set, not the visible (filtered) set. **[CREDIBLE]**
- **L8 — SmartFill has no Cancel during analyzing/filling** `client/src/components/SmartFillDialog.tsx:446-452`. **[CREDIBLE]**

---

## THE ROOT CAUSES (and the root fixes)

Almost everything above collapses into **four root causes**:

1. **Half-finished consolidations.** Canonical helpers exist (`profile-filter.ts`, `scope.ts`,
   `obligation-windows.ts`, `asset-value.ts`, `query-keys.ts`) but only *some* call sites use them; the
   rest still inline old logic that has since drifted. → **C1, H4, H8, M1, M7, L1, L2, L3.**
   **Root fix:** finish the migration — delete every inline copy, make the helper the only path, and add
   a lint/grep guard in CI that fails the build if a banned inline pattern (`4.33`, `lp.length === 0`,
   `* 52`, raw `["/api/...", ...filterIds]`) reappears.

2. **Write paths aren't validated like create paths.** `POST` handlers zod-parse and check ownership;
   the matching `PATCH`/`unlink` handlers don't. → **H5, M4, M8, M9.**
   **Root fix:** one shared `validateAndAuthorize(body, schema)` middleware used by every mutating route;
   `PATCH` uses `schema.partial()`.

3. **Browser state isn't keyed by user, and is read before login.** Cache + filter persist globally and
   hydrate at boot. → **C2** (and it's the underlying reason the git history is full of "leak" fixes).
   **Root fix:** namespace every persisted key by user id; block hydrate until the authenticated user is
   known and matches the snapshot; clear on *every* exit path, not just the Sign-Out button.

4. **One field means two things.** `fields.balance` is read as both an asset value and a debt; the loan
   writer and reader pick different fields. → **H2, H3.**
   **Root fix:** give assets and liabilities **distinct, canonical** value fields, write and read the same
   one, and never let a single ambiguous key feed both resolvers.

> **Why the test suite didn't catch any of this:** the 175 passing tests only exercise the *pure helper
> functions in isolation*. There is no test that runs an item through a *route handler* or a *page filter*,
> and the integration ("smoke contract") tests need a live Supabase server that doesn't run in CI without
> credentials. The bugs all live in the glue between helpers and call sites — the one layer nothing tests.
> **Root fix:** add handler-level contract tests (in-memory request → assert filtered output) for the
> isolation + money paths; they run without a database and would have failed on C1/H4/H8 today.
