# Performance Audit — July 2026

Full-app speed audit: root causes, fixes shipped in this pass, and the
prioritized follow-up plan. Focus area per request: **asset & liability
profile open speed**, plus startup, login/session, profile switching, chat
command saves, dashboard, calendar, popups, and DB/query hygiene.

---

## How the app's request path works (context for every finding)

- Every `/api/*` hit on Vercel is its own serverless invocation. Each one pays
  cold-start + auth middleware + Supabase client init before any query runs.
  **The single most effective optimization in this codebase is therefore
  "fewer HTTP requests per user action", ahead of making any one query faster.**
- The server keeps an in-memory response cache (`server/routes.ts`
  `getCached`/`setCache`) that is cleared synchronously on ANY mutation
  (`cacheBustMiddleware`), so short TTLs (30–60s) are safe: staleness is
  bounded by the next write, not the TTL.
- Storage is request-scoped (`createScopedStorage` per request via
  AsyncLocalStorage). It has an opt-in per-request memo
  (`enableRequestMemo`) that dedupes repeated table fetches *within one
  request* — previously only enabled for `/api/stats`, `/api/dashboard-enhanced`
  and `/api/dashboard-bootstrap`.
- The client (React Query) persists its cache to localStorage, hydrates it
  before mount, uses `staleTime: 30s`, `refetchOnMount: true`, and a
  provisional-user fast path in `client/src/lib/auth.tsx` so returning users
  render instantly from cache.

---

## Root causes found and FIXED in this pass

### 1. Opening an asset/liability profile ran the heaviest server aggregation TWICE, plus 3 redundant table scans  ← headline fix

**Symptom:** pressing an asset or liability profile takes seconds to load.

**Root cause** (`client/src/pages/profile-detail.tsx`): on every mount the page
fired, all in parallel:

1. `GET /api/profile-bootstrap/:id` (fire-and-forget `useEffect` that seeded caches)
2. `GET /api/profiles/:id/detail` (the page's main `useQuery` — cache was still
   empty when it mounted, so it always raced the bootstrap)
3. `GET /api/profiles` (page-level all-profiles query)
4. `GET /api/profiles/:id/tree`

Both (1) and (2) execute `getProfileDetail()` server-side — ~12 Supabase
queries each (profile + 7 JSONB-containment scans + tracker entries + habit
checkins + ownership links + all-expenses for cost-of-ownership). (3) and (4)
each scan the full `profiles` table again (`select *` including heavy JSONB
columns). Net: **one tap ≈ 2× the heavy aggregation + 3 extra full profile
scans, across 4 serverless invocations.**

**Fix:** the page's detail `useQuery` (key unchanged:
`["/api/profiles", id, "detail"]`, so all ~60 existing invalidation sites keep
working) now fetches `/api/profile-bootstrap/:id` as its `queryFn`, seeds the
tree / profiles / ownership-link cache keys from the payload, and returns the
flattened detail. The fire-and-forget effect was deleted. The page-level
`/api/profiles` and tree queries are gated on the detail having resolved, so
they read the seeded cache instead of racing the bootstrap over the network.
Falls back to the legacy `/detail` endpoint if bootstrap fails (except 404,
which surfaces the "Profile not found" state).

**Result:** one profile tap = **one** HTTP round-trip (plus per-section lazy
queries on the liability page), served from a 30s server cache on re-open.

### 2. `getProfileDetail` fetched the ownership link tables up to 4× per call

**Root cause** (`server/supabase-storage.ts:getProfileDetail`): for person-like
profiles it queried `asset_party_links` and `liability_profile_links` twice
each — once filtered "ForParty" for co-owned children, then again unfiltered
for ownership-share annotation. The bootstrap route fetched both tables a
third time for its own payload.

**Fix:** each link table is fetched once (via the request-memoized unfiltered
variant) and reused for both the co-owner derivation and the share annotation;
the bootstrap route's own fetch now shares the same memoized round-trip.

### 3. Per-request memo was OFF for the profile endpoints

**Root cause:** `enableRequestMemo()` (which makes repeated `getProfiles()` /
link-table calls within one request share a single Supabase fetch) was only
enabled on the stats/dashboard routes. `/api/profiles/:id/detail` and
`/api/profile-bootstrap/:id` ran their internal fanouts unmemoized — e.g.
bootstrap ran `getProfiles()` twice (once inside `getProfileDetail`, once for
its own payload).

**Fix** (`server/routes.ts`): both routes now enable request memo around their
storage work, same pattern as `/api/stats`.

### 4. Every chat command triggered a client-wide refetch storm  ← "chat saves are slow"

**Root cause** (`client/src/pages/chat.tsx:invalidateAll`): after each chat
write, `invalidateQueries({ refetchType: "all" })` re-fired **every cached
query slot, including inactive ones** — dozens of dashboard/calendar/profile/
tracker variants accumulated over a session. Each refetch is a serverless
invocation (auth + Supabase), so a single "log my weight" saturated the
backend and made both the chat confirmation and the next page feel slow.

**Fix:** invalidation now refetches only the queries **on screen**
(`refetchType: "active"`, the default) and marks everything else stale. The
global `refetchOnMount: true` already refreshes stale queries in the
background the moment their page is opened, so freshness is preserved with a
fraction of the traffic. The 1.2s settle pass (guarding the server's
cache-version race) is unchanged.

### 5. Liability "Activity" tab could wipe the profile cache with the wrong shape (correctness + wasted renders)

**Root cause** (`client/src/pages/liability-detail.tsx:ActivityTimelineCard`):
the card used the shared cache key `["/api/profiles", id, "detail"]` but its
`queryFn` fetched the **plain** profile (`/api/profiles/:id`) — no
`related*` arrays, no field flattening. Any stale refetch triggered through
this observer overwrote the rich detail object for the whole page: the
timeline blanked, linked data disappeared, and the page re-rendered with
degraded data until the next full refetch.

**Fix:** the card now fetches `/api/profiles/:id/detail` and applies the same
`flattenProfile` transform as the page-level query. `flattenProfile` /
`flattenProfileFields` moved from profile-detail.tsx into a shared module
(`client/src/lib/flattenProfile.ts`) so both writers of that cache key produce
an identical shape.

### 6. Calendar timeline had no caching or request memo

**Root cause** (`server/routes.ts /api/calendar/timeline`): every calendar
render fanned out to 4 full-table fetches (events, tasks, obligations,
profiles) with no response cache, no in-flight dedupe, and no request memo —
so month scrolling and every profile-filter change re-ran all four scans.

**Fix:** 30s response cache (busted on any write), in-flight dedupe, and
request memo — the same proven pattern as `/api/stats`.

---

## Already-good things (verified, no action needed)

- **Login/session:** server caches JWT→user for 60s (`server/auth.ts`), so the
  burst of parallel API calls per navigation costs one GoTrue round-trip per
  minute. The client hydrates a provisional user from the stored JWT before
  any network I/O (`provisionalUserFromStorage`), so "logged in but still
  loading" is bounded by the background `/api/auth/me` validation, which no
  longer blocks rendering. `KeepAlive` pings `/api/warmup` every 90s to dodge
  cold starts, and re-warms on tab return.
- **Startup:** routes are lazy-loaded; main-tab chunks preload only after
  auth, inside `requestIdleCallback`. `DataPrefetch` fires ONE
  `/api/dashboard-bootstrap` call scoped to the saved profile filter and seeds
  every dashboard mount-time key (`lib/bootstrap-seed.ts`).
- **Query client:** localStorage persistence (with per-user stamping), 30s
  staleTime, mutation defaults that mark stale without refetch storms,
  placeholderData leak fix.
- **Dashboard:** `/api/dashboard-bootstrap` aggregates stats + enhanced +
  profiles + incomes + budget in one invocation with request memo and a
  per-endpoint cache reuse.

---

## Remaining plan (prioritized, not yet done)

### P1 — biggest wins still on the table

1. **Bound `tracker_entries` in `getProfileDetail`**
   (`server/supabase-storage.ts` ~line 886): fetches ALL entries for every
   linked tracker with `select *`. For a dense tracker (daily weight for 3
   years ≈ 1,100 rows) this dominates the payload and the timeline build.
   Plan: `limit(500)` newest-first per profile-detail call + a dedicated
   paginated `/api/trackers/:id/entries` for the full-history chart view.
   Deferred here because it changes data semantics (charts/timeline depth)
   and deserves its own verification pass.
2. **`getProfiles()` returns `select *`** including heavy JSONB (`fields`,
   `documents`, `linked_*`) everywhere. Most consumers (tree build, breadcrumb,
   owner pickers, filter chips) need only
   `id/type/name/avatar/parent_profile_id/fields->currentValue-ish numbers`.
   `getProfilesLite()` already exists — migrate the tree endpoint, bootstrap
   `profiles` payload, and picker queries to it (needs a field-usage audit of
   `profiles.fields` readers first).
3. **DB indexes** (verify in Supabase, add via migration if missing):
   - GIN index on `linked_profiles` for `trackers`, `expenses`, `tasks`,
     `events`, `documents`, `habits` (JSONB `@>` containment is a full scan
     without it — this is the hot path for every profile open).
   - GIN on `journal_entries.linked_profiles` (text[]).
   - B-tree on `(user_id, tracker_id, timestamp desc)` for `tracker_entries`;
     `(user_id, parent_profile_id)` and `(user_id, deleted_at)` for `profiles`;
     `(user_id, party_profile_id)` + `(user_id, asset_profile_id)` on the two
     link tables.
   Run `EXPLAIN ANALYZE` on the containment queries before/after.
4. **Liability profile sub-queries → fold into bootstrap:** the liability page
   still fires parties/payments/schedule/assets/graph/documents as separate
   invocations after the detail lands. Extend `/api/profile-bootstrap/:id` to
   include `liabilityExtras` when the profile type is liability/loan
   (payments + schedule + parties + linked assets), seeded the same way.

### P2 — frontend render hygiene

5. **Split the mega-pages.** `profile-detail.tsx` (13.7k lines),
   `trackers.tsx` (7.8k), `dashboard.tsx` (7k) each compile to one chunk and
   define dozens of components in one module scope. Split by tab/section
   (Overview/Financials/Documents/Timeline) with `lazy()` so editing state in
   one section doesn't re-render the whole tree, and memoize section props.
6. **Popup audit:** dashboard popups already read from seeded caches; verify
   with React Profiler that none fetch-on-open more than one lazy detail
   query, and add `placeholderData: keepPreviousData` only where pagination
   wants it (global default already fixed).
7. **Mutation invalidation fan-out in profile-detail:** most mutations
   invalidate detail + profiles + dashboard-enhanced + stats (4+ refetches per
   edit, though now only when active). Consider optimistic cache writes plus
   marking dashboards stale-only (they refetch on next visit) — halves
   post-edit chatter.

### P3 — measurement & regression protection

8. **Server timing:** add a tiny middleware that logs
   `route → totalMs, dbCalls` (the storage memo layer can count fetches per
   request) and a `Server-Timing` response header, so slow endpoints show up
   in the browser DevTools waterfall in production.
9. **Client marks:** `performance.mark` around auth-restore, first dashboard
   paint, and profile-open → detail-rendered; report to `/api/client-errors`
   style endpoint (or console in dev).
10. **Perf smoke test:** extend `tests/smoke` with a scripted pass that hits
    `dashboard-bootstrap`, `profile-bootstrap/:id`, `calendar/timeline` and
    asserts response-time budgets against the live deployment
    (`npm run smoke:post-deploy`).

---

## Verification of this pass

- `npx tsc --noEmit` — clean.
- `npm test` — 48 files, 548 tests, all passing.
- Request-count accounting (the thing this pass optimizes) by code path:
  - Profile open: 4 heavy invocations → **1** (plus per-section queries on
    liability pages).
  - Server work per profile-bootstrap: `getProfiles` 2× → 1×; link tables
    up to 4× → 1× each; detail aggregation 2× → 1×.
  - Chat command: refetch of *every* cached query slot → refetch of visible
    queries only (typically 2–5), rest marked stale.
  - Calendar: 4 table scans per scroll → cached 30s, deduped, memoized.
- Behavior-preserving by construction: cache keys unchanged (all existing
  invalidations still hit), bootstrap payload identical to what the removed
  fire-and-forget effect seeded, link-table dedupe returns the same rows the
  ForParty queries returned (same filter applied in memory), calendar cache is
  write-busted like every other cached endpoint.
