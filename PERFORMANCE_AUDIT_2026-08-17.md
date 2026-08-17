# Full-App Performance Audit — 2026-08-17

Complete audit of the running application: what was measured, what was actually
slow and why, what shipped, and what is still slow. Companion to
`PERFORMANCE_AUDIT_2026-07.md` (July pass) and `PERF_PLAN_LAUNCH_2026-07-16.md`.

**Headline:** the app's slowness today is dominated by **request count on
navigation**, not by database size or query plans. Returning to a section the
user had already loaded fired up to **18 API requests** — every one of them for
data the app already had in cache and was about to overwrite with identical
rows. That is now **4**.

---

## How this was measured

Everything below was measured against the live production deployment
(`portol.me`) using the dedicated smoke account, not inferred from reading code.

| Instrument | What it produced |
|---|---|
| Playwright drive of the real UI (login → every tab → revisit → idle → revisit) | API request counts and durations per navigation |
| The same drive against a **locally built client proxied to the production API** | before/after comparison of the client changes |
| `pg_stat_statements` (since 2026-03-20) | per-query call counts, mean and total time |
| `EXPLAIN (ANALYZE, BUFFERS)` on the hot queries | real plans, not guesses |
| Supabase performance advisors + `pg_indexes` | missing/unused indexes, RLS cost |
| `QueryObserver` harness in the test suite | deterministic request counts on remount |
| `npm run test:contracts` (live, against production) | CRUD + cache-invalidation regressions |

**Important scoping note:** the server-side changes in this pass (cache TTLs,
new route caches, the bootstrap payload additions) **could not be measured in
production**, because this branch is not deployed and the measurement harness
runs the new *client* against the *currently deployed* server. Every number
attributed to the server below is labelled as such and is **not measured**.

---

## Bottlenecks found, ranked

### CRITICAL — Returning to a section refetched everything it already had

**Location:** `client/src/lib/bootstrap-seed.ts`, plus per-query `staleTime`
overrides in `ExecutiveBriefing.tsx`, `HubKpiStrip.tsx`, `dashboard.tsx`,
`finance.tsx`, `CashFlowView.tsx`, `BriefingPopups.tsx`, `CalendarView.tsx`.

**Cause:** `/api/dashboard-bootstrap` returns every mount-time dataset in one
response and seeds ~25 query keys from it. Seeding stamps them all fresh *at the
same instant*, so they cross the staleTime boundary **together**. On the next
mount each component independently refetched its own slot — while the bootstrap
refetched too and then overwrote all of them with the same rows. Components that
passed their own short `staleTime` (30–60s) were worse: an explicit `staleTime`
beats the seeded default, so they refetched on almost every visit. The hub KPI
strip was the most expensive instance because it is mounted on *every* hub
route, so its four queries rode along on every tab switch.

**Previous behavior:** 18 requests returning to Executive after an idle period;
5 on an immediate revisit; Finance refetched two datasets on literally every
visit (`refetchOnMount: "always"`).

**Fix:** bootstrap-seeded keys now get a longer `staleTime` than the bootstrap's
own, so the bootstrap goes stale first, refetches once, and re-seeds its
dependents before any of them expire. The per-query overrides on seeded keys
were removed, and Finance's two `refetchOnMount: "always"` queries dropped to
the default. Freshness is untouched: it is invalidation-driven in this app, and
invalidation ignores `staleTime` entirely.

**Measured improvement:** see the table below — **18 → 4** requests on a stale
return to Executive, **5 → 2** on an immediate revisit.

---

### CRITICAL — A cached bootstrap could erase a write the user had just made

**Location:** `client/src/lib/bootstrap-seed.ts`, `server/routes.ts`.

This was **found by testing, not by reading** — the CRUD drive caught it while
validating the fixes above, and it would otherwise have shipped.

**Cause:** the bootstrap response is served from a response cache, so its rows
can be older than the moment it is returned, and landing it overwrites ~25 list
caches. A bootstrap computed just *before* a write and replayed just *after* one
seeds pre-write rows over the list the mutation had already refreshed. Because
`setQueryData` clears the invalidated flag, the correct data never returns on its
own. Symptom: create a task, leave the page, come back — it is gone.

**Previous behavior:** a latent race (the 30s TTL kept the window small).
Raising the TTL made it reproducible: it failed on 2 of 2 attempts.

**Fix:** two independent guards. The payload now carries `generatedAt`, stamped
when the rows were actually read, and the seeder never seeds over a slot whose
data is newer. Independently, it skips any slot that is invalidated or already
fetching — which also covers the rolling-deploy window where the client has the
fix but the payload comes from a server without the stamp.

**Measured improvement:** correctness, not speed. Full create → edit → delete
cycle against production now passes at every checkpoint (immediately, after
leaving and returning, and after a full reload), with zero console errors.

---

### HIGH — Aggregation caches expired far sooner than the data could change

**Location:** `server/routes.ts` (`AGG_CACHE_TTL_MS`).

**Cause:** `/api/dashboard-bootstrap` (30s), `/api/stats`, `/api/dashboard-enhanced`,
`/api/calendar/timeline` and `/api/notifications` (60s–2min) all carried short
TTLs. But post-write staleness is **not** bounded by the TTL — every cache key
embeds the user's data version, which any write bumps, making stale entries
unaddressable within ~2s across all instances. So the short TTLs bought no
freshness; they only forced the ~15-query aggregation to re-run during ordinary
navigation.

**Fix:** one shared 3-minute TTL, matching the client's staleTime.

**Expected improvement — NOT MEASURED** (server not deployed). The effect is on
the cost of a refetch, not the count.

---

### HIGH — Three Finance endpoints had no cache at all

**Location:** `server/routes.ts` — `/api/accounts`, `/api/loans/schedule`,
`/api/cashflow`.

**Cause:** each ran its full read on every Finance mount. `/api/loans/schedule`
with no `loanId` scans every amortization row.

**Previous behavior (measured):** 0.19–4.9s each, on every visit to Finance.

**Fix:** version-stamped caches with the same pattern the other read routes use;
the unfiltered result is cached once and the profile filter applied per request,
so every scope shares one read.

**Expected improvement — NOT MEASURED** (server not deployed).

---

### MEDIUM — Four round trips on the login critical path that carried no new data

**Location:** `server/routes.ts` bootstrap payload, `client/src/lib/bootstrap-seed-keys.ts`,
`NotificationBell.tsx`, `ExecutiveBriefing.tsx`.

**Cause:** the dismissed-notification preference was fetched separately by the
NotificationBell *and* the Executive Brief (two components, two requests, one
value), the saved dashboard layout was a third, and the AI daily briefing lived
only in one instance's memory — so any request landing on a fresh instance
re-ran a 5–9s Anthropic call for a briefing another instance had already written.

**Previous behavior (measured):** the preference GETs took 0.6–5.2s each on a
cold instance and sat on the path between login and first paint.

**Fix:** both preferences ride along in the bootstrap payload and seed their
cache slots; the bell and the Brief now share one query slot; the briefing joins
the cross-instance cache so a fresh instance serves it from one indexed read.
The bell's 60s notification poll also dropped to 5 minutes — mutations already
invalidate that key, so the poll was pure background load.

---

### LOW — Notification building re-read four tables per request

**Location:** `server/routes.ts` `/api/notifications`.

`buildNotifications` fetches five tables and the profile-filter pass below it
re-reads four of them. The route now enables the request memo (the same pattern
`/api/stats` uses), collapsing each table to one round trip per request.

---

## Performance comparison

**Method:** identical Playwright script, run back to back against a pre-warmed
production instance — "before" drives the currently deployed client, "after"
drives this branch's build. Both hit the same production API. Numbers are **API
requests per navigation**, which is the quantity that actually governs perceived
speed here (each request is its own serverless invocation).

| Navigation | Before | After |
|---|---|---|
| Return to Executive after idle (> staleTime) | 18 | **4** |
| Immediate revisit to Executive | 5 | **2** |
| Return to Finance after idle | 6 | 6 |
| Immediate revisit to Finance | 0 | 0 |
| Return to Calendar (idle and immediate) | 0 | 0 |
| Immediate revisit to Tasks | 0 | 0 |

An earlier, separately-run drive of the same script recorded first-visit
Executive at 15 requests before and 2 after, and stale-return Finance at 8
before and 6 after — but those two runs were **not** paired against a warm
instance, so I trust the table above and not those figures.

Deterministic confirmation, independent of network variance
(`tests/bootstrap-seed-staletime.test.ts`, real `QueryObserver`s with counting
query functions): eight bootstrap-seeded sections mounted on the same remount
fire **8 requests under the old per-query staleTime and 0 under the seeded
default**, with a genuinely stale seed still refetching exactly once.

### What was NOT measured

- **Every server-side change.** The TTL changes, the three new route caches, the
  bootstrap payload additions and the notification request-memo all need this
  branch deployed. Their effect is on the *duration* of a request, not the count,
  so none of the numbers above include them.
- **Wall-clock page-load times.** Production instance warmth varies by more than
  the effect size (individual requests ranged from 0.1s to 23s across runs, on
  identical code), so per-navigation timings would not have been honest. Request
  counts are stable and are what the fixes change.
- **Lighthouse / LCP / TTI / bundle-size deltas.** No client bundle was made
  smaller in this pass; the mega-page splits remain open (see below).
- **Memory leaks and React render counts.** Not profiled. No evidence of either
  surfaced while driving the app, but absence of evidence here is weak.

---

## Database audit

The database is **not** the current bottleneck, and this is worth stating
plainly because it is where a performance audit is normally expected to land.

- Real accounts are small: the largest genuine user has 21 expenses, 16 tasks,
  15 profiles. The 10,002-expense account is `scale-test@portol.me`, a synthetic
  fixture last used in April.
- Hot queries are index-backed. `EXPLAIN (ANALYZE, BUFFERS)` on the heaviest
  expense read shows `Index Scan Backward using idx_expenses_user_date`, not a
  sequential scan.
- Supabase advisors report no missing index on any hot path. The findings are
  four unindexed foreign keys on `financial_transaction_overrides` (a table with
  negligible traffic), ~30 `auth_rls_initplan` warnings on tables the server
  reaches with the service role (RLS bypassed, so no runtime cost today), and
  several unused indexes.
- **No indexes were added.** The query patterns do not justify any right now,
  which is the answer the brief asked for rather than a reflex.

**One real scale finding, recorded but not fixed:** `getExpenses()` is unbounded
and returns `select *`. On the scale-test account that is 10,002 rows and
**924ms measured**, on a hot path that only needs the current month for the
dashboard number. It is invisible today and will not stay that way. The fix is
not a one-liner because ~30 call sites — most of them AI tools answering
questions like "what did I spend last year" — depend on the full history, so
narrowing it needs a separate, per-caller pass rather than a change to the
shared accessor.

---

## Regression verification

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 172 files, 2718 tests, all passing |
| `npm run test:contracts` (live, against production) | 16 files, 101 tests, all passing |
| `npx tsx scripts/post-deploy-smoke.ts` | 9/9 probes passing, all latency budgets met |
| CRUD drive against production (create → edit → delete) | every checkpoint green, 0 console errors |
| Pre-push hook (tsc + contracts) | passing |

The CRUD drive is the one that matters most here, because this pass lengthened
cache lifetimes: each of create, edit and delete is verified immediately, after
navigating away and returning, and after a full page reload.

---

## What is still slow

1. **Cold serverless starts dominate everything that remains.** A first request
   to a cold instance was measured between 2s and 23s across runs, on unchanged
   code. No amount of client caching addresses this; it is the single largest
   remaining source of "the app is slow". The existing mitigations (KeepAlive
   ping, the cross-instance response cache) help a warm fleet, not a cold one.
2. **Returning to Finance still costs 6 requests.** `accounts`, `loans/schedule`,
   `cashflow`, `paychecks`, `budgets` and `finance/connections` are not in the
   bootstrap payload. They are now server-cached (so each should be cheap once
   deployed), but the round trips remain. Folding them into the bootstrap — or a
   Finance-specific bootstrap — is the obvious next step.
3. **A full page reload still fires ~17 requests.** The persisted cache paints
   instantly, but the Finance-specific queries above are not part of it.
4. **The mega-pages are still one chunk each.** `profile-detail.tsx` (14k lines),
   `trackers.tsx` (7.9k), `dashboard.tsx` (6k). Carried over from the July plan;
   affects download and parse on low-end phones, and re-render cost while editing.
5. **`getExpenses()` is unbounded** — see the database section above.
6. **`attention_prefs` is still a separate request.** Deliberately: seeding it
   would pull the attention module graph into the pre-mount entry chunk, which
   would cost more than the request saves. It already has a 5-minute staleTime.
