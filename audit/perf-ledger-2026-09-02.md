# Performance + CRUD stress ledger — 2026-09-02

Method: the production bundle (`vite build`) served by the real Express app
against an in-memory storage double, driven with Playwright. Every `/api`
call is recorded with timing; long tasks (>50ms main-thread blocks), paint
marks and CPU profiles (sourcemapped) are captured per step; the React Query
cache is inspected live through a debug hook. Unless noted, numbers are with a
simulated 120ms server round trip and a 3× fixture (900 expenses, 120 tasks,
10 trackers / 540 entries, 92 events, 60 journal entries, 6 habits, 6 bills).

Supabase Postgres was unreachable for most of the session (the incident in
`audit/bug-ledger-2026-09-02.md`): Auth timed out, `select 1` timed out
through the management API, and it answered only intermittently late in the
day. Everything below that needed the live database (query plans, advisors,
AI chat latency, the contract suite) is marked as such. Local harness:
`.probe/local-dev.ts` (not committed).

Status key: FIXED · DOCUMENTED (measured, left as follow-up) · BLOCKED (needs live DB)

## Findings

| # | Screen / workflow | Problem | Before | Root cause | Fix | After | Accuracy check | Status |
|---|---|---|---|---|---|---|---|---|
| P1 | Trackers → any write; profile switch | **Cross-profile cache pollution.** After one tracker log, the cache slot for Bob's scope (`["/api/trackers","selected",bob]`) held Alex's ten trackers and was "fresh" for 3 min; switching to Bob would render them | Reproduced (probe p08) | The dashboard seeds one slot per profile scope with no query function. `invalidateQueries({queryKey:["/api/trackers"], refetchType:"all"})` (trackers.tsx ×3, chat.tsx) refetched those slots through the default query function, which fetched `key[0]` verbatim — the bare endpoint = whole household — and stored it under Bob's key | Default query function derives the URL from the key (`[endpoint,"selected",...ids]` → `?profileIds=`); removed every `refetchType:"all"` | Bob's slot unchanged after writes (p08: "bob scope intact") | Unit: `tests/query-url-from-key.test.ts`; live probe | FIXED |
| P2 | Tracker log (dialog + quick log) | 26 requests per entry; 130 for five rapid entries; the same URL fetched up to 45× | 26 / 130 | Three multipliers: `refetchType:"all"` (12 seeded slots), the bus issuing one invalidation per key AND one per nested predicate (cancel+restart on every query both matched), and the response's write manifest invalidating the same domains the mutation's `onSettled` invalidated ~10ms later | Bus invalidates once with a combined predicate; explicit invalidation within 150ms of a manifest's for the same domain is dropped; no inactive refetches | 7 / 35 (no cancellations) | 5 rapid entries → 5 server rows, latest value correct in dialog and dashboard tile; `tests/cache-bus-single-refetch.test.ts` | FIXED |
| P3 | Task create / edit / complete / delete | 7 requests per write, task list fetched 4× | 7 | as P2 | as P2 | 2 (POST + one list refetch) | Counts: 120 → 121 → 120; dashboard KPI follows without reload; double-submit → 1 row | FIXED |
| P4 | Habit check-in | 9 requests, habits list ×4, profiles ×4 | 9 | as P2 | as P2 | 3 | Streak/count updates optimistic (4ms), dashboard ring follows | FIXED |
| P5 | Tasks page (and events, journal, habits, goals, obligations, artifacts, documents) | **Lists shrink after a write.** With 121 open tasks the page counted 121 (seeded from bootstrap), then 100 after adding a task, and the new task was not among the 100 | Reproduced (probe p04) | `paginate()` caps list routes at 100 by default while `/api/dashboard-bootstrap` seeds the same query keys with the full list — two sizes for one list | `paginateFull` (full by default, `?limit=` still pages) for every list the bootstrap seeds whole; documents route same | 121 → 122 after create, new card persists | `tests/list-routes-full-by-default.test.ts`; live probe | FIXED |
| P6 | Finance page open | Main thread blocked 1.35s across 5 long tasks | 1,345ms | `formatListDate`/`formatMoney` built an `Intl` formatter per call (313ms + 131ms per render of 900 rows); all 900 rows rendered at once | Cached `Intl` formatters (byte-identical output); expense list paged 60 + "Show more" (totals/chart still use the full set) | 437ms | `tests/format-cached-formatters.test.ts` pins output against `toLocale*` | FIXED |
| P7 | Finance → add expense | 10 long tasks, 3.08s blocked after one add (whole list re-rendered several times) | 3,084ms | as P6 | as P6 | 539ms | Cash flow KPI updates on finance and dashboard without reload | FIXED |
| P8 | Tasks page open | 130–160ms long task; 4,596 DOM nodes / 432 SVGs for 120 tasks | 150ms | Every task card rendered at once | Lists paged 60 + "Show more" | 108ms | Counts read the full lists | FIXED |
| P9 | Trackers page open | 22 requests on every visit (trackers ×4, profiles ×4, …) | 22 | Mount-time `POST /trackers/migrate-to-self` followed by an unconditional invalidation of trackers+profiles, even when nothing migrated | Invalidate only when `migrated > 0` | 1 (when nothing to migrate) | Migration still runs once when needed | FIXED |
| P10 | Artifacts page open | 345ms long task on every open, diagram or not; the page chunk was 659KB | 345ms / 659KB | CDP trace: the whole task is `v8.evaluateModule` of the artifacts chunk — 582KB of it is every Prism grammar (`refractor/lang`), pulled in by `import { Prism } from "react-syntax-highlighter"`; the idle-time mermaid prefetch was a red herring (made conditional anyway) | `PrismAsyncLight` (no grammars shipped; a code artifact fetches the one it needs) | 0 long tasks / 92KB; code artifact still highlights (probe p19) | — | FIXED |
| P11 | Tracker entry edit | Save form stayed open for the whole round trip although the cache was already patched | 331ms to see the value | `onClose()` in `onSuccess` | Close in `onMutate`; rollback + toast on error | 13ms | Server row verified after save and after delete | FIXED |
| P12 | Dashboard cold load | 226ms long task inside the first React commit | 226ms | CDP trace: 114ms Layout + script in the first commit — first layout of the page (fonts + first style resolution); DOM is only 882 nodes; `useOverflowX` forced it synchronously | `useOverflowX` reads once per frame (the first layout still happens before first paint, as it must) | 200ms (inherent first-paint work) | — | DOCUMENTED |
| P13 | Dashboard first visit (no stored filter) | Every dashboard query fires unscoped, then again scoped to Self once profiles arrive: 2 bootstraps (605KB + 552KB at 3×), 2 aggregate passes | +~500KB, +1 aggregate pass | Default scope (Self) is derived from the profiles response that lands with the first wave | — (first visit / new device only) | — | — | DOCUMENTED |
| P14 | Dashboard cold load | Bootstrap for 3 other profiles prefetched (137–158KB each) after the main load | +430KB | Scope prefetch so profile switching is instant (switch to Bob: 2 requests, label in 25ms) | Deliberate trade-off; server-side these are cached 60s | — | — | DOCUMENTED |
| P15 | Settings / dashboard | 7 individual preference reads (14B each) on Settings, 3 on the dashboard, one fetched twice | 10 requests | One route per key | — (parallel, one round trip of settle time) | — | — | DOCUMENTED |
| P16 | `/api/dashboard-bootstrap` | 605KB at 3× volume: calendar timeline 97KB (246 habit occurrences), expenses 200KB, trackers 150KB (120 days of entries) | 605KB raw | Bootstrap ships every list whole | — (gzip on Vercel; server cost is the real question — BLOCKED on live DB) | — | — | BLOCKED |
| P17 | Journal save | Journal list fetched twice per save | 2× | Four sites called `queryClient.invalidateQueries` directly (journal, stats, enhanced), bypassing the bus and its manifest coalescing | Route through `invalidateDomain("journal")` | 1× (2 requests per save: POST + list) | Entry visible optimistically (15ms) | FIXED |
| P18 | Expense writes (server) | Expense INSERT averages 72ms, UPDATE 34–44ms in production | 72ms | `pg_stat_user_indexes`: `idx_expenses_desc_search` (GIN over `to_tsvector(description‖vendor)`) has **0 scans** and is the table's largest index (2.9MB) — `/api/search` uses ILIKE, nothing issues a text search; four legacy `idx_profiles_linked_{expenses,trackers,tasks,events}_gin` also have 0 scans; `expenses` carries two identical BEFORE UPDATE triggers (`set_updated_at`, `trg_expenses_updated_at`, both `NEW.updated_at = now()`) | Recommended migration (not applied — schema change during an incident, and the session's permission gate declined to write it): `DROP INDEX IF EXISTS idx_expenses_desc_search; DROP INDEX IF EXISTS idx_profiles_linked_expenses_gin; DROP INDEX IF EXISTS idx_profiles_linked_trackers_gin; DROP INDEX IF EXISTS idx_profiles_linked_tasks_gin; DROP INDEX IF EXISTS idx_profiles_linked_events_gin; DROP TRIGGER IF EXISTS trg_expenses_updated_at ON expenses;` | — | Re-check `idx_scan` is still 0 right before applying | DOCUMENTED |

## Verified working (no bug)

- Optimistic UI: task create (26ms to card), edit (44ms), complete (checked immediately), delete (3ms); tracker entry add (9ms); expense add (9ms); calendar event create (10ms); artifact delete (15ms); habit check-in (4ms). Every one was on screen before the server replied.
- Cross-screen sync without reload: dashboard KPI/widgets after task create/complete/delete; dashboard cash flow after expense add; dashboard schedule after event create; tracker tile after entry add.
- Rapid actions: double-click Save on New Task → the second click is blocked (button disabled), one row; five rapid tracker entries → five rows, correct latest value.
- Profile switch: Self → Bob 2 requests, Bob → Self 0 (cached), Everyone 12 (cold), back 0. Bob's dashboard does not show Alex's tasks.
- Rapid switching Self → Bob → Casey → Biscuit → Self with ~30ms between clicks: 6 requests total, final scope Self, cache for Self (121 tasks) and Bob (0) both match the server — no older response overwrote a newer scope.
- Warm navigation between screens is nearly network-free (0–1 requests) thanks to bootstrap seeding; back navigation 0 requests.
- Idle: no background CPU burn on dashboard, trackers (with and without the detail dialog), finance, calendar, chat (0 long tasks over 15s each).
- Search (⌘K): result in ~470ms (server 130ms + debounce).

## Live database observations (pg_stat_statements + advisors, read during a window when Postgres answered)

Statement stats since the last reset, ordered by total time (application statements only):

| Statement | Calls | Mean | Max | Note |
|---|---|---|---|---|
| `delete_profile_cascade(p_user_id, p_profile_id)` | 8,167 | 202ms | 7.9s | Almost certainly the contract suite's fixture reset; rare for users |
| `SELECT expenses.* …` (two shapes) | 32k + 43k | 51ms / 30ms | 7.3s | The most expensive list read; `EXPLAIN` still to run (DB kept timing out) — the 7s max is the incident, the 30–50ms mean is worth a plan check |
| `SELECT tracker_entries.* …` | 52k | 27ms | 3.0s | 120-day window per tracker |
| `bump_user_data_version` | 122k | 10.7ms | 6.0s | One per write, by design |
| `SELECT documents.* …` | 3,454 | 240ms | 7.6s | The binary read (`/documents/:id/file`); list reads already use the metadata-only column set (10.6ms mean, 56k calls) |
| `INSERT response_cache` | 24k | 25ms | 5.3s | Shared cross-instance cache write; bootstrap payloads are hundreds of KB |
| `INSERT audit_log` (three shapes) | 49k | 24–34ms | 6.4s | Fire-and-forget per write; not on the request path but ~1.2M ms of DB time |
| `INSERT expenses` | 7,775 | 72ms | 5.7s | Slow for a single-row insert; trigger/index check still to run |
| GoTrue session/user lookups | 152k / 139k | 3.6ms / 3.5ms | 2.5s | Token verification hits Postgres for ~6% of API calls (per-instance 60s cache misses) |

Index usage (`pg_stat_user_indexes`, hot tables): reads are served by the `(user_id, date)`, `deleted_at` and `linked_profiles` GIN indexes on expenses/tasks/events/documents and the `user`/`tracker`/`tracker_time` indexes on tracker_entries — no missing-index signal on the hot paths. See P18 for the unused ones.

Advisors: 28 WARN `auth_rls_initplan` — all on the Stripe/financial_* tables, whose policies re-evaluate `auth.uid()` per row (the server reaches them with the service role, so app reads are unaffected; fix is `(select auth.uid())`); 19 INFO unused indexes; 5 INFO unindexed foreign keys on `financial_transaction_overrides`; 6 INFO tables without a primary key. No advisor finding touches the hot read paths above.

## Blocked on the live database (to run when Supabase answers)

- Production endpoint latencies (`.probe/live-probe2.sh` waits until `/api/profiles/lite` answers, then times 18 endpoints × 3). A token was minted at 19:37 UTC (attempt 29) but every API read then timed out at 60s: the API's own Postgres calls were still failing.
- AI chat: time to first frame, time to final, action accuracy for single/multi-person/multi-action/correction/delete commands (`.probe/live-chat.ts`).
- `EXPLAIN (analyze)` on the expenses and tracker_entries list reads and the expenses insert path (triggers/indexes); the bootstrap's 18 parallel reads end to end.
- `npm run test:contracts` (pre-push stage): the push in this session used the hook's documented `SKIP_TESTS=1` bypass because Auth could not mint the smoke token; unit suite (4228) and typecheck were green.

## Coverage

| Feature | CRUD | Buttons | AI | Perf | Cross-screen | Errors found | Optimized | Verified |
|---|---|---|---|---|---|---|---|---|
| Dashboard | read | KPI strip, tabs, widgets | — | cold/warm/profile switch | — | P12–P14 | partial | yes |
| Tasks | C/R/U/D + complete + rapid | new/edit/checkbox/delete/confirm/tabs | blocked | yes | dashboard | P3, P5, P8 | yes | yes |
| Trackers + entries | C/R/U/D + rapid | card/detail/tabs/add/edit/delete | blocked | yes | dashboard | P1, P2, P9, P11 | yes | yes |
| Habits | check-in | segment | blocked | yes | dashboard | P4 | yes | yes |
| Expenses / Finance | C/R | add/save/sort/show-more | blocked | yes | dashboard | P6, P7 | yes | yes |
| Calendar / events | C/R | add/save | blocked | yes | dashboard | — | — | yes |
| Journal | R (create probe pending mode fix) | new/mode | blocked | yes | — | — | — | partial |
| Artifacts | R/D | delete/confirm | blocked | yes | — | P10 | yes | yes |
| Profiles (list/detail/switch) | R + switch | switcher/cards/tabs | blocked | yes | dashboard | P1 | yes | yes |
| Search | R | palette | — | yes | — | — | — | yes |
| Settings | R | — | — | yes | — | P15 | — | yes |
| Documents / upload | — | — | blocked (extraction needs AI) | — | — | — | — | no |
| Goals / obligations / wellness / insights | R (seeded via API) | — | blocked | open timing only | — | — | — | partial |
