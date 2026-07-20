# Performance Incident: "Adding mileage takes 30 seconds"

**Date:** 2026-07-20
**Scope (frozen):** one workflow end-to-end — open app → open a profile → add/update
mileage. No features, no redesigns. Just make ordinary CRUD consistently fast.
**Status:** root cause identified with code-level evidence; fixes landed on
`claude/app-performance-audit-352tde` behind test gates.

---

## TL;DR — where the 30 seconds actually went

The write itself was never slow. **Two things bolted onto the CRUD path were:**

1. **AI on the edit path.** Editing a profile field (e.g. a vehicle's mileage)
   auto-invalidated the mounted **AI Summary** query. The server clears its
   summary cache on every `PATCH /api/profiles/:id`, so that invalidation forced
   a **cold Anthropic generation on every single field save**. One LLM round-trip
   is the dominant cost — several seconds on a good day, far worse on a cold
   serverless start. *This is the "AI patching over plumbing" the brief called out.*

2. **A forced global refetch storm.** Every tracker log
   (`POST /api/trackers/:id/entries`) fired
   `invalidateQueries(..., refetchType: "all")` for `/api/stats` **and**
   `/api/dashboard-enhanced`. Those two endpoints each fan out to **~10 Supabase
   queries** and are **not even mounted on the trackers page**. `refetchType:"all"`
   force-refetches *inactive* queries, so every log re-ran **two cold ~10-query
   aggregations** for data the user wasn't looking at. On Vercel each is its own
   cold serverless invocation.

Net: a "basic update" = 1 fast write **+ 1 cold LLM call + 2 cold 10-query
aggregations**, most of it invisible background work. That is the 30 seconds.

---

## The evidence (code-level request waterfall)

### Add-mileage-as-a-tracker-entry
- Client mutation: `client/src/pages/trackers.tsx` — entry add / quick-log / dose.
  Already had **optimistic `onMutate`** (temp entry patched into every cached
  `/api/trackers` slot via `setQueriesData`) → the list/badge updated instantly.
- `onSettled` then fired three `refetchType:"all"` invalidations →
  `/api/trackers` **+ `/api/stats` + `/api/dashboard-enhanced`**.
- Server write: `server/routes.ts` `POST /api/trackers/:id/entries` → validates,
  `storage.logEntry`, `bustCache`. **No AI. Fast.** (verified: no `anthropic` /
  `messages.create` anywhere in `server/supabase-storage.ts` or the write route.)
- Server reads that got force-refetched: `getStats` and `getDashboardEnhanced`
  (`server/supabase-storage.ts`) each `Promise.all` ~10 table fetches.

### Edit-mileage-as-a-profile-field
- Client: `client/src/pages/profile-detail.tsx` inline field `save()` →
  `PATCH /api/profiles/:id`, then invalidated `["...","ai-summary"]` +
  `dashboard-enhanced` + `stats`.
- A `useEffect` keyed on `profileUpdatedAt` **also** invalidated `ai-summary`.
- Server: `GET /api/profiles/:id/ai-summary` → cache cleared by the PATCH →
  **cold `client.messages.create` (Anthropic)** before responding.

---

## Fixes landed

| # | Brief item | Change |
|---|-----------|--------|
| 5 | Remove AI from CRUD | Profile field `save()` no longer invalidates `ai-summary`; the `profileUpdatedAt` effect now sets a **stale flag** instead of regenerating. The summary stays visible with a "profile changed — refresh" affordance; regeneration is user-initiated (or via an explicit AI action like *Look up value*). `client/src/pages/profile-detail.tsx` |
| 6 | Stop global refetches after individual changes | All tracker CRUD mutations dropped `refetchType:"all"` → default **active-only** invalidation. Stats + dashboard-enhanced are marked stale, not force-refetched; they refresh when the dashboard next mounts (server cache was already busted on the write). `client/src/pages/trackers.tsx` |
| 7 | Optimistic UI | Preserved the existing optimistic `onMutate` and now *rely* on it instead of a redundant forced refetch — the entry/badge appears immediately with zero blocking network work. |
| 3 | Server timing around auth / DB / AI / cache | Added `makePerfTimer()` in `server/routes.ts`: per-phase durations on `/api/stats`, `/api/dashboard-enhanced`, and `/api/profiles/:id/ai-summary`. Emits a **`Server-Timing` response header** (rendered inline in browser devtools → Network → Timing) **and** a `[perf]` log line, but only when a request exceeds 800 ms (fast/cache-hit path stays silent). |

### What was already correct (not touched, to avoid churn)
- The tracker **write** endpoint is AI-free and fast.
- `/api/stats` and `/api/dashboard-enhanced` already have a 60 s server cache +
  per-request memo + dedupe. The problem was never the endpoints — it was
  *forcing them to run when nothing on screen needed them*.

---

## Pass/fail targets (from the brief)

| Measurement | Target | How to verify |
|---|---|---|
| App shell visible | < 1 s | browser trace, cold + returning launch |
| Profile usable | < 2 s | `/api/profiles/:id/detail` timing (now no AI on this path) |
| CRUD visible in UI | < 300 ms | optimistic `onMutate` is synchronous — appears next paint |
| DB confirmation | < 1.5 s | `POST /entries` / `PATCH /profiles` round-trip; AI no longer inline |

**CRUD-visible** is now structurally met: the update is painted from the
optimistic cache patch before any network call resolves.

---

## Test gates (brief item 10 — don't merge unless data still persists)

- `tests/tracker-entry-persistence.test.ts` — proves a logged mileage value is
  written to `entry_values` and **survives a re-read** ("refresh"), and that the
  log path completes with **no Anthropic key present** (AI-free).
- `tests/perf-crud-hygiene.test.ts` — structural guards that fail if
  `refetchType:"all"` returns to `trackers.tsx`, or if a profile field edit ever
  re-invalidates `ai-summary` again.
- Full suite: **88 files / 979 tests green**; `tsc --noEmit` clean.

---

## Honest limitation — what still needs a live capture

I could not record a **production browser performance trace against real account
data** from this environment (no access to the deployed app with your profiles).
The diagnosis above is from the code path and the fan-out counts, which is enough
to fix the two structural causes. To confirm the wall-clock numbers against the
targets, capture one trace now that the evidence hooks exist:

1. Open the app in Chrome → DevTools → **Network** panel, "Preserve log" on.
2. Cold-load, open a vehicle profile, and add mileage.
3. For `/api/stats`, `/api/dashboard-enhanced`, `/api/profiles/:id/ai-summary`,
   open the request → **Timing** tab → read the **Server-Timing** rows
   (`cache-hit`, `db-fanout`, `ai-generate`, `cache-write`, `total`).
4. Anything > 800 ms also prints a `[perf] … total=…ms phase=…ms` line in the
   Vercel function logs.

Those numbers are now real evidence, not a guess — which was the whole point.
