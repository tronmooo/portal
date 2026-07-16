# Launch Performance Plan — Full-App Speed Audit (2026-07-16)

**User-reported symptoms this plan targets:**
1. "When I open the app right away it takes forever to load — it's always in the
   skeleton or it just says loading."
2. "When I switch to People it's slow."
3. "I want to deploy it live so people can actually use my app."

This document is the audit result (what is actually slow and why, with file
references) plus a prioritized execution plan. It builds on
`PERFORMANCE_AUDIT_2026-07.md` — everything already fixed there is NOT repeated
here; this is what's still broken or missing for a public launch.

---

## Part 1 — Root-cause audit

### How one "app open" actually plays out today (cold, fresh launch)

```
t=0     index.html + entry JS download (entry includes the 3.7k-line chat page
        — it's a static import in App.tsx)
t≈0     /api/warmup fired from main.tsx (good — starts the cold start early)
t≈0     hydrateQueryCache() runs… and PURGES the persisted cache (see A2)
mount   AuthProvider: no provisional user (see A1) → full-page
        "Loading Portol..." spinner
        → GET /api/auth/config        (cold serverless: 2–6 s)
        → GET /api/auth/me            (sequential, another round trip)
login   resolves → DataPrefetch fires /api/dashboard-bootstrap
        (cold aggregation measured 4.6 s; warm repeats 1.6–3.5 s before the
        response-cache fix, ~300 ms after)
paint   dashboard renders from bootstrap seed
```

Every stage is sequential. On a cold Vercel function + fresh launch the user
stares at a spinner/skeleton for the SUM of: cold start + config + me +
bootstrap. That is the "takes forever when I open the app" report, mechanically.

### A. App-open blockers

**A1 — Auth tokens live in `sessionStorage`, so every fresh launch is a
"cold" auth restore.** (`client/src/lib/auth.tsx` `persistTokens` /
`provisionalUserFromStorage`)
`sessionStorage` dies with the tab: new tab, browser restart, iOS PWA/Capacitor
relaunch, "open from home screen" — all start with NO session. The provisional
user fast path (which renders the shell instantly) only works within the same
tab session. On every real "app open" the user hits the full-page spinner and
waits for `/api/auth/config` → `/api/auth/me` on a possibly-cold function.

**A2 — The persisted React Query cache is DELETED on every fresh launch,
because of A1.** (`client/src/lib/queryClient.ts` `hydrateQueryCache` →
`currentSessionUserId()` reads `sessionStorage`)
The localStorage query-cache snapshot (built precisely so the dashboard renders
instantly on return) is stamped with the session user id. On a fresh launch the
session isn't in sessionStorage yet → `selectHydratableEntries` returns
`purge: true` → **the snapshot is removed**. Net effect: the instant-render
cache only ever survives an F5 in the same tab — the one case that was never
the complaint. Every actual app open re-fetches everything → skeletons.

**A3 — First paint blocks on `/api/auth/config`, which returns static
values.** (`client/src/lib/auth.tsx` `checkAuthConfig`)
`authRequired`, `supabaseUrl`, `supabaseAnonKey` do not change per user or per
session. Paying a cold serverless round trip before showing ANYTHING is pure
waste. These can be baked into the bundle at build time (Vite env) or cached in
localStorage after first fetch with background revalidate.

**A4 — Sequential auth chain.** `config` → then `me`/`refresh` → then
bootstrap. Even warm, that's 3 round trips end-to-end before data flows;
cold it's 3 chances to eat a cold start. `/api/auth/me` + config + bootstrap
could be one endpoint (or at least fired in parallel).

**A5 — Entry bundle carries the whole chat page.** `App.tsx` imports
`ChatPage` statically ("/" route) and `auth.tsx` imports `clearChatCache` from
it, so chat (3.7k lines + its component tree) is in the critical-path JS for
every user, even those who land on /dashboard. Also `theme-init.js` is a
blocking classic script in `<head>` (correct for anti-flash, but must stay
tiny), and two variable font families + JetBrains Mono load up front.

### B. "Switching to People is slow"

**B1 — A profile switch re-keys every scoped query with no seeded data.**
The hub switcher (`components/hub/HubProfileSwitcher.tsx`) writes the filter
store; every query keyed `[endpoint, mode, ...ids]` across HubKpiStrip (4
queries: stats/enhanced/incomes/trackers) and dashboard.tsx (45 `useQuery`
hooks in the page + ~30 more in dashboard components) instantly has a NEW cache
key → nothing cached → skeletons + a parallel fan-out of serverless requests.
Measured (commit df6f0ec): `/api/profiles` 6.4 s, bootstrap 4.6 s cold. The
hover-prefetch added in df6f0ec landed in `MultiProfileFilter.tsx` only — the
hub switcher, which is what's actually on screen, has NO prefetch.

**B2 — The People/Info tab does a redundant heavy hop.**
`/profiles` (`pages/profile-info.tsx` `InfoSelfRedirect`) fetches the FULL
`/api/profiles` (measured 6.4 s — `select *` including heavy JSONB
fields/documents columns) **just to find the Self profile's id**, then
navigates to `/profiles/:id/info`, which runs the profile-bootstrap aggregation
(~12 Supabase queries). `/api/profiles/lite` exists and is already used by
`profile-route-dispatch.tsx` — the redirect should use it (or bootstrap-seeded
cache) instead.

**B3 — Server does full-table scans per request and filters in Node.**
(`server/supabase-storage.ts`) `getStats`/`getDashboardEnhanced`/bootstrap all
fetch entire tables (`select *`, unbounded) and compute in the function. With
one user's data this is 1–5 s; with real users' data volumes it degrades
linearly and per-invocation. The in-memory response cache (60 s, per instance)
hides this only for repeat hits on the SAME warm instance — every new instance,
cold start, or filter combination pays full price.

### C. Launch blockers (works-for-me → works-for-users)

**C1 — The response cache is per-instance memory.** Under real traffic Vercel
runs N instances; each one has its own cold cache and re-runs the aggregations.
The KeepAlive 90-second ping warms exactly one instance.

**C2 — No performance telemetry from real clients.** Server has
`[slow-request]` logs (>1 s), but nothing measures what users feel:
time-to-first-paint, auth-restore duration, bootstrap latency, profile-switch
latency. Can't verify fixes or catch regressions without it.

**C3 — Single 300 s / 1 GB function for everything** — chat/AI requests share
the same function as `GET /api/stats`. A burst of heavy AI calls can saturate
concurrency and queue the cheap dashboard reads behind them.

**C4 — Supabase advisors (checked live 2026-07-16):** DB is `us-west-2`, same
region as the Vercel function (`pdx1`) — good, no cross-region latency. Minor
findings only: ~20 `auth_rls_initplan` warnings (wrap `auth.uid()` in
`(select ...)`), unindexed FK on `finance_imports.profile_id`, duplicate
permissive policies on `extraction_corrections`. Low priority: server uses
service role, RLS mostly bypassed.

---

## Part 2 — Execution plan

Ordered by (user-visible impact ÷ risk). Each phase is shippable alone.

> **Status (2026-07-16, same-day execution pass):** Phases 0, 1, 2 shipped in
> full. Phase 3: advisor migration applied to the live DB + per-table
> slow-query logging shipped; the 3.2 aggregation RPC is deliberately deferred
> — live measurement showed today's data volumes are small (profiles 517 rows
> / 184 kB; the 47 MB documents table already excludes blobs on list paths),
> so cold starts + fan-out, not scans, dominate — the RPC becomes the priority
> as real users add data. Phase 4: entry trimmed 185→155 kB gzip (chat chunk
> extracted); the mega-page tab-splits remain follow-up. Phase 5: perf budgets
> in post-deploy smoke + the AI/read function split shipped.

### Phase 0 — Measure first (half a day)
0.1 Add `performance.mark`/`measure` around: bundle-eval → auth-restored →
    first-data-paint → bootstrap-landed → profile-switch → switch-painted.
    Report to the existing `/api/client-errors`-style endpoint (sampled), log
    to console in dev.
0.2 Run Lighthouse (mobile, cold) against production; record LCP/TTI/bundle
    sizes as the baseline scoreboard.
0.3 Keep the `[slow-request]` server log; add the same 1 s threshold to
    Supabase query wrappers in `supabase-storage.ts` (log table + ms) so slow
    tables are attributable.

### Phase 1 — Fix app-open (the biggest complaint) (1–2 days)
1.1 **Move auth tokens to `localStorage`** (keep sessionStorage read as legacy
    fallback for one release). Provisional-user fast path then works on every
    launch; full-page spinner disappears for returning users. Cross-tab logout
    broadcast already exists (`LOGOUT_BROADCAST_KEY`), and the persisted-cache
    user-stamp check (`cache-isolation.ts`) keeps cross-account safety.
    Capacitor iOS: localStorage persists across app kills — this single change
    fixes "open the app → forever loading" on the phone.
1.2 **Stop purging the query cache on fresh launch** — follows from 1.1
    (`currentSessionUserId` finds the uid again). Verify: fresh tab → dashboard
    paints from cache with zero skeletons, background refetch updates numbers.
1.3 **Kill the `/api/auth/config` round trip** — inject `authRequired` +
    Supabase URL/anon key at build time (`import.meta.env`), with runtime fetch
    only as fallback. First paint then depends on zero network calls.
1.4 **Parallelize, don't serialize:** fire `/api/auth/me` validation and
    `/api/dashboard-bootstrap` prefetch concurrently with first render (both
    are background-safe already); never gate render on them.
1.5 **Trim the entry bundle:** make ChatPage lazy like every other route
    (move `clearChatCache` into a small shared module to break the
    auth.tsx → chat.tsx static edge), confirm with the build report that no
    heavy chunk (recharts/tiptap/univer) is reachable from the entry.
    Target: entry JS < 300 KB gzip.

### Phase 2 — Fix People switching (1–2 days)
2.1 **Prefetch on the hub switcher** — port the df6f0ec hover/touch prefetch
    from `MultiProfileFilter` into `HubProfileSwitcher` (dropdown open =
    prefetch bootstrap for each person row; also on hover/touchstart).
2.2 **Seed on switch:** when the filter changes, immediately
    `prefetchQuery` the scoped `/api/dashboard-bootstrap` and run
    `seedDashboardCaches` for the new scope — one round trip instead of a
    45-query fan-out. Keep the old scope's data on screen (opt into
    `placeholderData: keepPreviousData` ONLY for scope-keyed summary tiles,
    with a "switching…" affordance) so the switch never blanks to skeletons.
2.3 **`/profiles` Info redirect uses `/api/profiles/lite`** (or the already
    seeded bootstrap `profiles` payload) to resolve the Self id — kills the
    6.4 s `select *` hop. Audit remaining full-`/api/profiles` consumers and
    migrate the id/name/type-only ones to lite (P1 item from the July audit,
    still open).
2.4 **Cap the dashboard's own fan-out:** the 45 page-level hooks should read
    from bootstrap-seeded keys; any query NOT covered by the bootstrap payload
    either gets added to the bootstrap response or becomes lazy
    (below-the-fold / on-expand). Budget: ≤ 3 network requests for a warm
    dashboard mount, ≤ 3 for a profile switch.

### Phase 3 — Server: stop scanning tables per request (2–4 days, biggest structural win)
3.1 **Scope queries in SQL, not Node.** `getStats`/`getDashboardEnhanced`/
    bootstrap fetch whole tables then filter by profile in JS. Add
    `user_id`-scoped + column-projected selects (drop unused JSONB columns from
    hot paths) and date-window filters (current month for expenses, upcoming
    for events/obligations, cap list lengths).
3.2 **One aggregation RPC:** move the stats + enhanced roll-ups into a single
    Postgres function (or a few SQL views) returning the numbers the dashboard
    actually renders. One round trip to the DB instead of 10–20; the function
    is where the data lives. This is what makes p95 bootstrap < 500 ms cold
    achievable, and it's what scales to multiple users.
3.3 **Shared cache across instances:** once 3.2 lands the need shrinks, but if
    aggregation stays app-side, back `getCached`/`setCache` with Vercel KV or
    Upstash Redis (keyed by the existing version-stamped keys) so instance #2
    doesn't recompute what instance #1 just did.
3.4 Apply the cheap advisor fixes: index `finance_imports.profile_id`, wrap
    `auth.uid()` as `(select auth.uid())` in the ~20 flagged policies, drop the
    duplicate `extraction_corrections` policy.

### Phase 4 — Bundle & render hygiene (1–2 days, parallelizable)
4.1 Split the mega-pages by tab/section with `lazy()`:
    `profile-detail.tsx` (13.7k lines), `trackers.tsx` (7.7k),
    `dashboard.tsx` (5.9k). Besides download size, one keystroke of edit state
    currently re-renders thousands of lines of siblings — memoize sections.
4.2 Verify with the Vite build report (numbers in Appendix) that the entry +
    dashboard route ≤ ~450 KB gzip combined; fonts subset to used weights.
4.3 React Profiler pass on dashboard + Info tab: no component > 16 ms commit
    on switch; fix with `memo`/`useMemo` on section props (props are currently
    rebuilt inline in the 5.9k-line module scope).

### Phase 5 — Launch readiness (1 day)
5.1 **Perf smoke gate:** extend `npm run smoke:post-deploy` to assert budgets
    against production: bootstrap p95 < 800 ms warm, auth/me < 300 ms warm,
    profiles/lite < 400 ms; fail the deploy on 2× regression.
5.2 **Function split:** move `/api/chat` + AI routes into their own Vercel
    function (own `maxDuration`), keep the read API on a small fast function —
    AI traffic can no longer queue dashboard reads.
5.3 Re-run Lighthouse + the Phase 0 client marks; publish before/after in this
    file.
5.4 Keep `subscribe_pr_activity`/regression contract suite green; ship phases
    as separate PRs so any regression bisects cleanly.

---

## Success criteria (definition of "fast enough to launch")

| Metric | Today (measured/observed) | Target |
|---|---|---|
| Cold app open → usable dashboard | 5–15 s (spinner→skeleton chain) | < 2.5 s cold, < 1 s warm (paint from persisted cache instantly) |
| Returning-user open (phone/PWA) | full spinner + refetch everything | instant shell + cached data, silent refresh |
| Profile/People switch | multi-second skeletons | < 300 ms perceived (old data stays, ≤ 3 requests) |
| `/api/dashboard-bootstrap` | 4.6 s cold / 0.3–3.5 s warm | < 800 ms p95 (RPC + shared cache) |
| `/api/profiles` (full) | 6.4 s | hot paths use `lite` < 400 ms |
| Entry JS | 185 KB gzip (includes chat page) | **155 KB shipped** (chat extracted; < 130 KB after mega-page splits) |

## Appendix — build measurements (vite build on this branch, 2026-07-16)

Critical path on cold load (what index.html actually pulls before first render):

| Asset | Raw | Gzip |
|---|---|---|
| `index-*.js` (entry: shell + router + auth + **chat page**) | 597.7 kB | **184.9 kB** |
| `index-*.css` (all Tailwind + component styles, single file) | 205.2 kB | 44.9 kB |
| `theme-init.js` (blocking classic script — keep tiny) | — | — |
| fonts | 18 woff2 subsets; browser fetches 2–3 | ~60–90 kB |

So ~230 kB gzip JS+CSS before paint — acceptable, which confirms the app-open
problem is dominated by the **auth/config network waterfall + serverless cold
start** (Part 1.A), not raw download size. Extraction of the chat page from
the entry (Phase 1.5) is still worth ~50–60 kB gzip and cuts parse time on
low-end phones.

Largest lazy chunks (correctly NOT on the critical path — verify they stay
that way after any router/build change):

| Chunk | Gzip |
|---|---|
| exceljs (editor only) | 270.7 kB |
| artifacts page | 268.0 kB |
| profile-detail page (13.7k-line module) | 116.9 kB |
| editor page | 138.2 kB |
| mermaid + diagram renderers (many chunks) | ~130 kB + per-diagram |
| shared vendor chunks (2× `index-*.js`) | 100.4 + 100.5 kB |
| dashboard page | 64.7 kB |
| trackers page | 59.8 kB |

Total `dist/public/assets`: 22 MB — fine, since the service worker precaches
only the shell and heavy chunks load on demand (verified in `vite.config.ts`
`stripEditorChunkPreloads` + PWA `globPatterns`).
