# Portol — Production Readiness Plan
*Generated: April 2, 2026 | Based on API audit (20/21 passing) + full codebase review*

---

## Reality Check

The app is closer to launch than it has ever been. Auth is solid, data isolation is enforced at both the middleware and Supabase RLS layers, all CRUD works, the AI chat has 53 tools, and 42/42 cross-profile stress tests passed. The remaining gaps are real but bounded.

**Honest assessment**: You can launch to a small closed group (friends/family) right now. For a public launch, P0 items must ship. P1 items should ship within the first two weeks post-launch to avoid embarrassing user-facing bugs.

---

## P0 — Blocking Production (must fix before any public launch)

### P0-1: Dashboard layout saves fail silently — but the 404 is misleading

**Issue**: The API audit reported `GET /api/preferences/dashboard-layout` (hyphen) returns 404. The actual client uses `dashboard_layout` (underscore). The generic preferences route `GET /api/preferences/:key` exists and works, but it returns 404 when no value has been stored yet (first-time users have never saved a layout). The client catches the 404 and falls back to defaults — so the dashboard _loads_ fine. **However**, the save mutation (`PUT /api/preferences/dashboard_layout`) also runs through this same generic key-value route. If the first-ever PUT fails for any reason, the user sees "Failed to save layout" toast with no recovery path.

**Real risk**: Medium. The route technically works. The problem is the GET returning 404 vs a proper empty-state response confuses monitoring tools and may cause 404s to appear in your logs at a high rate — one per new user session until they save a layout.

**What needs to change**:
- `server/routes.ts` line ~2727: Change the GET handler so that if `value === null`, return `res.json({ value: null })` instead of `res.status(404)`. A missing preference is not a 404 — it's a valid "not set yet" state.
- `client/src/pages/dashboard.tsx` line ~1615: Update the query function to handle `{ value: null }` explicitly as a signal to use defaults, instead of relying on catch.

**Complexity**: Small (2 files, ~10 lines total)

---

### P0-2: Tracker `forProfile` null — entries are invisible to profile filtering in detail view

**Issue**: All 74 existing tracker entries have `forProfile = null`. The per-entry profile filter in the tracker detail view (the new `profileIdsInEntries` logic at line 2283 in `trackers.tsx`) only shows profile chips for entries where `forProfile` is set. For all existing data, the UI correctly shows entries (no false-positive hiding), but the display implies the feature doesn't work because no profile chips appear, and selecting a specific profile in the tracker detail view won't filter existing entries — only future ones.

**Real risk**: If you add the profile filter UI to tracker detail entries and release it, users with existing data see a broken experience. The data exists — it just has no `forProfile` attribution.

**What needs to change**:
- `server/routes.ts`: Create a one-time backfill route `POST /api/cleanup/backfill-tracker-entry-profiles` that, for each tracker entry, looks up the parent tracker's `linkedProfiles`, and if there's exactly one profile linked, stamps that profile ID into `for_profile` on every entry that currently has `for_profile = null`.
- `server/supabase-storage.ts`: Add the corresponding `backfillTrackerEntryProfiles()` method.
- Call this once after deploy. For trackers with multiple linked profiles, leave `for_profile` null (ambiguous) — don't guess.
- This is a one-time data operation, not ongoing code.

**Complexity**: Small (30–40 lines server-side, one-time migration call)

---

### P0-3: Habits streak shows "0d streak" when yesterday's `targetPerDay > 1` check-in was partial

**Issue**: `calculateStreak()` in `supabase-storage.ts` correctly requires `count >= targetPerDay` for a day to count. The bug is in how it determines "today." It hardcodes `America/Los_Angeles` timezone at line 55:
```ts
const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
```
This means users in other timezones see incorrect streak behavior. More critically, if a user did `targetPerDay = 2` check-ins yesterday but hasn't done any today, the current logic correctly shows the streak alive (yesterday counts). But there's a display issue: `habits.tsx` line 129 renders `habit.currentStreak` directly as `{habit.currentStreak}d streak`. If the streak is 1 (meaning "only yesterday"), it shows "1d streak" correctly. If it's 0, it shows "0d streak" — which is confusing, not a bug per se, but creates the impression the check-in didn't register.

**Real risk**: The `0d streak` display is cosmetically bad. A user checks in, meets partial threshold, and still sees "0d streak" because today's partial count doesn't yet meet `targetPerDay`. The streak logic is correct — the display lie is that the habit card doesn't show the partial progress state.

**What needs to change**:
- `client/src/pages/habits.tsx` line 129: Only render the streak badge if `habit.currentStreak > 0`. When streak is 0 and the user has checked in today, show partial progress instead ("2/3 today").
- Consider: Remove the hardcoded `America/Los_Angeles` from `calculateStreak` in `supabase-storage.ts`. This should use the user's timezone preference from their profile (or default to UTC). A server-side timezone hardcode is a ticking time bomb.

**Complexity**: Small (habits.tsx ~5 lines; timezone fix is medium — requires plumbing timezone through to `calculateStreak`)

---

### P0-4: Goals filtering not wired to profile filter on Goals page

**Issue**: The `GET /api/goals` endpoint correctly filters by `?profileId=` when that query param is provided (lines 2594–2613 in `routes.ts`). But the standalone Goals page (`trackers.tsx` line 2466) fetches `/api/goals` with no `profileId` parameter — it gets everything. The API is ready; the client isn't using it.

**Real risk**: A user with multiple profiles (e.g., personal + spouse) who looks at Goals sees goals from all profiles mixed together. This is a trust/isolation failure, not a cosmetic issue.

**What needs to change**:
- `client/src/pages/trackers.tsx` line ~2466: Pass the active `profileId` to the goals query: `queryKey: ["/api/goals", filterIds]` and `queryFn` should append `?profileId=` when a filter is active.
- Also verify `client/src/pages/profile-detail.tsx` goals tab does the same.

**Complexity**: Small (1 file, ~5 lines)

---

### P0-5: Manifest says "LifeOS" — brand name is wrong

**Issue**: `public/manifest.json` has `"name": "LifeOS"` and `"short_name": "LifeOS"`. The app is named Portol. Users who install the PWA from the browser prompt will see "LifeOS" on their home screen. This is a shipping-stopper.

**What needs to change**:
- `public/manifest.json`: Change `name` and `short_name` to "Portol".

**Complexity**: Trivial (1 file, 2 lines)

---

## P1 — Important (should fix within first 2 weeks post-launch)

### P1-1: Trackers page does not filter the tracker list by profile

**Issue**: The Trackers page (`trackers.tsx`) has `filterIds`/`filterMode` state and applies it to documents and subscriptions. It does apply filtering to the tracker list via `filteredTrackers` at line 2941 (using `linkedProfiles` on the tracker object). However, the per-entry filter is only for entries within a tracker detail view — and only works on new entries with `forProfile` set. The main grid shows the right trackers (filtering by `linkedProfiles` on the tracker) but entries inside always show everything. After P0-2 is done (backfill), this will start working for historical data too.

**What needs to change**:
- This is largely handled by P0-2. After backfill, entries in detail view with `forProfile` will filter correctly.
- Confirm: `trackers.tsx` detail entry filter already checks `(e as any).forProfile` — after backfill this just works.
- One gap: The entry filter UI (profile chips in detail) should be visible even when all entries have the same profile. Currently it's hidden when `hasMultipleProfiles` is false. This is correct behavior but document it.

**Complexity**: Small (mostly a P0-2 dependency)

---

### P1-2: Journal has no `linkedProfiles` support — silently treats all journal as "self"

**Issue**: The journal endpoint returns entries for non-self profiles as an empty array (routes.ts line 1421: `if (!isSelf) { items = []; }`). This is the right behavior — journal is personal. But there's no `linkedProfiles` column on journal entries, and journal entries can't be linked to non-self profiles. The AI chat creates journal entries without any profile context. In the future, if someone wanted to track a care recipient's journal separately, there's no schema support.

**Real risk**: Low for now since this is intentional. But it means the profile detail page's activity feed won't include journal entries for non-self profiles even if a future feature adds that.

**What needs to change**:
- No immediate code change needed. But **add a comment** to the journal route explaining the intentional "self-only" design.
- If multi-profile journal support is ever desired, it requires a DB migration to add `linked_profiles` to `journal_entries`.

**Complexity**: Trivial (comment) or Large (schema + migration if feature is desired)

---

### P1-3: Error boundaries missing — any unhandled exception crashes the whole app

**Issue**: There's no React Error Boundary wrapping the main page tree or individual widgets. If the dashboard's Finance widget or AI Summary throws an unhandled exception (e.g., null pointer on unexpected API shape), the entire page goes white. Users see a blank screen with no feedback.

**What needs to change**:
- `client/src/App.tsx`: Wrap the page router in an `<ErrorBoundary>` component that renders a "Something went wrong, refresh the page" fallback.
- `client/src/pages/dashboard.tsx`: Wrap individual widget cards in their own error boundaries so one broken widget doesn't crash the whole dashboard.

**Complexity**: Small (create one ErrorBoundary component, wrap in 3–4 places)

---

### P1-4: Service worker version number is hardcoded — cache busting requires a manual bump

**Issue**: `public/sw.js` has `CACHE_NAME = 'portol-v5'` and `STATIC_CACHE = 'portol-static-v5'` hardcoded. The fetch strategy is already network-first (good), so stale cached HTML is not a risk for live navigations. However, if a user has the app installed as a PWA, the old service worker with old cache names will continue to serve the cached offline fallback pages until they manually clear the cache or until the browser eventually updates the SW.

**The real issue**: The `sw.js` file itself has no cache-busting. If you push a new `sw.js`, browsers will update it, but only after the existing SW has "activated" and the user navigates. If the new SW has the same cache name, stale assets may be served from the old cache until the cleanup runs.

**What needs to change**:
- `public/sw.js`: Update `CACHE_NAME` to `portol-v6` (or ideally inject the build hash via a build step) on each deploy that changes cached files.
- Better long-term: Add a `vite-plugin-pwa` to the vite config so the SW is auto-generated with the correct asset manifest hash, eliminating this manual step. This is medium effort but worth it.

**Complexity**: Small for manual bump now; Medium for `vite-plugin-pwa` integration

---

### P1-5: Raw `err.message` exposed in some toasts

**Issue**: Several `onError` handlers in `habits.tsx`, `tasks.tsx`, and other pages pass `err.message` directly to toast description. For Supabase errors, `err.message` can contain internal details like table names, column names, or constraint names. Example: "duplicate key value violates unique constraint 'habits_user_id_name_key'" — this is confusing to users and leaks schema info.

**What needs to change**:
- `client/src/pages/habits.tsx`, `tasks.tsx`, `trackers.tsx`, `finance.tsx`, `obligations.tsx`: Audit each `onError` handler. Replace raw `err.message` with human-readable strings in destructive toasts. Create a `formatApiError(err)` utility that maps common error patterns to friendly messages.

**Complexity**: Small (utility function + find/replace across ~8 files)

---

### P1-6: No error monitoring in production

**Issue**: There is no Sentry, LogRocket, or equivalent. When production users hit errors, you have no visibility. The only signal you'll get is if a user complains.

**What needs to change**:
- Add Sentry (or Vercel's built-in error tracking) to both the server (`server/index.ts` or `vercel-entry.ts`) and the client (`client/src/main.tsx`).
- Add a global `window.onerror` + React ErrorBoundary reporter.

**Complexity**: Small (Sentry integration is ~20 lines + 1 env var)

---

### P1-7: Notification dismissals reset on page refresh

**Issue**: Notification badge dismissals are stored in component `useState`. Refreshing the page brings all dismissed notifications back. For users checking in daily, this creates notification fatigue — the same "streak at risk" notifications keep reappearing.

**What needs to change**:
- `client/src/pages/dashboard.tsx` (notification bell component): Persist dismissed notification IDs to `localStorage` keyed by user. Read them back on mount. Clear old entries after 7 days.

**Complexity**: Small (localStorage read/write, ~20 lines)

---

### P1-8: Expenses/obligations accept invalid input without client-side validation

**Issue**: The API validates input (Zod schemas), but the client forms don't validate before submit. Users can:
- Submit a negative expense amount
- Submit a goal with a target of 0 or negative
- Submit empty tracker entry values

This causes confusing server-side 400 errors that surface as generic toasts.

**What needs to change**:
- `client/src/pages/finance.tsx`: Add min-value validation on expense amount (> 0).
- `client/src/pages/trackers.tsx` (CreateTrackerDialog): Validate that required numeric fields aren't empty on submission.
- `client/src/pages/goals section`: Validate target > 0.

**Complexity**: Small per form; Medium to do all forms comprehensively

---

### P1-9: Dashboard cache serves stale data in multi-tab scenarios

**Issue**: The profile detail API has a 10-second in-memory cache per user+profile combo (`cacheKey = profile-detail:${userId}:${req.params.id}`). If a user has two tabs open and edits data in tab A, tab B will serve cached (stale) data for up to 10 seconds. This was noted in the previous audit (M-1).

**Real risk**: Low for single users. If you have shared household accounts, this matters more.

**What needs to change**:
- `server/routes.ts` cache logic: Either reduce TTL to 2–3 seconds, or invalidate the cache key on any write operation for that user+profile. The write path needs to call `cacheStore.delete(key)`.

**Complexity**: Small (4–5 lines in the cache invalidation path)

---

## P2 — Nice to Have (post-launch)

### P2-1: No pagination on list endpoints

**Issue**: `/api/trackers`, `/api/tasks`, `/api/expenses` return up to 500 records in one shot. At scale (1000+ records), this will become noticeably slow. The `limit` query param is only partially wired on journal.

**What needs to change**: 
- `server/routes.ts`: Add `?limit=&offset=` pagination to all list endpoints.
- `server/supabase-storage.ts`: Pass range parameters to Supabase queries (`.range(offset, offset + limit - 1)`).
- Client: Implement infinite scroll or "Load more" on tasks, expenses, and events pages.

**Files**: `server/routes.ts`, `server/supabase-storage.ts`, all list pages
**Complexity**: Large

---

### P2-2: Documents stored as base64 in JSONB — will degrade at scale

**Issue**: Document `file_data` is stored as a base64 string in a JSONB column. A 5MB PDF becomes ~7MB of base64 in the database. With 19 documents today, this is fine. At 100 documents with large files, queries that fetch all documents (`SELECT *`) will become slow.

**What needs to change**:
- Migrate to Supabase Storage buckets. Store a `storage_path` instead of `file_data`.
- The endpoint `POST /api/cleanup/migrate-documents-to-storage` already exists in routes.ts — this is half-built.
- Complete the `migrateDocumentsToStorage()` method in `supabase-storage.ts`.

**Files**: `server/supabase-storage.ts`, `server/routes.ts`
**Complexity**: Medium

---

### P2-3: Chat history not persisted across page refreshes

**Issue**: The AI chat uses a module-level `_chatCache` in `ai-engine.ts`. Chat history is lost on page refresh, server restart, or new device.

**What needs to change**:
- Add a `chat_sessions` table to Supabase.
- Persist messages to the DB after each exchange.
- Load last N messages on mount.

**Files**: `server/ai-engine.ts`, `server/supabase-storage.ts`, `server/routes.ts`, `client/src/pages/chat.tsx`
**Complexity**: Medium

---

### P2-4: No undo for destructive deletes

**Issue**: Deleting a profile, tracker, habit, or document is immediate and permanent. There's no soft delete, trash, or undo window.

**What needs to change**:
- Add a brief (5-second) "Undo" snackbar after any delete operation.
- On the server: Add a `deleted_at` soft-delete column to critical tables; enforce filtering in all queries; add a cleanup job.
- Alternatively: Just the 5-second client-side undo that cancels the API call (simpler, less robust).

**Files**: All page components + storage layer for full soft-delete
**Complexity**: Small for client-side cancel pattern; Large for proper soft-delete

---

### P2-5: Mobile UX — some sheets and dialogs don't scroll on small screens

**Issue**: Several `DialogContent` elements have `max-h-[90vh] overflow-y-auto` but on iOS Safari, `-webkit-overflow-scrolling: touch` is required for smooth momentum scrolling. The Create Tracker dialog (`trackers.tsx` line 1303) and some habit/expense forms may not scroll on 375px iPhone screens if content overflows.

**What needs to change**:
- `client/src/pages/trackers.tsx`, `dashboard.tsx`: Audit all `DialogContent` and `SheetContent` components. Ensure all have `overflow-y-auto` AND `style={{ WebkitOverflowScrolling: 'touch' }}`.
- Test specifically: Create Tracker dialog, Add Expense sheet, Obligation detail sheet on iPhone SE viewport.

**Files**: `trackers.tsx`, `finance.tsx`, `obligations.tsx`, `dashboard.tsx`
**Complexity**: Small per fix; ~1 hour of testing

---

### P2-6: Calendar page is monthly-only with no week/day view

**Issue**: The calendar shows monthly view only. Long event titles are truncated to 1–2 characters on mobile. There's no way to see a day's full agenda.

**What needs to change**:
- Add a week view and a list/agenda view to `client/src/pages/calendar-page.tsx`.
- The data is already available (218 calendar items, all fetched).

**Files**: `client/src/pages/calendar-page.tsx`
**Complexity**: Large

---

### P2-7: Rate limiting falls back to IP for unauthenticated requests

**Issue**: If auth middleware fails (expired token, network error), rate limits use `req.ip || 'anonymous'`. On shared infrastructure (Vercel edge), multiple users may share an IP. This means one user's bad requests could trigger rate limits for another user.

**What needs to change**:
- `server/routes.ts` line ~134: If `userId` is undefined and this is Supabase mode, reject rather than falling back to IP-based limiting. In local dev (SQLite mode), IP fallback is fine.

**Files**: `server/routes.ts`
**Complexity**: Small (5 lines)

---

### P2-8: `unsafe-inline` in CSP weakens XSS protection

**Issue**: `security-headers.ts` has `script-src 'self' 'unsafe-inline'` to allow Vite's inline scripts. In production with a built bundle, `unsafe-inline` should not be necessary. A proper production CSP should use `nonce-` or `hash-` for any inline scripts.

**What needs to change**:
- `server/security-headers.ts`: Remove `unsafe-inline` from `script-src` for production builds. Add a build-time CSP nonce injection if needed.
- Verify the built output doesn't use inline scripts (the Vite build output uses hashed filenames and no inline scripts by default).

**Files**: `server/security-headers.ts`, potentially `server/vercel-entry.ts`
**Complexity**: Small (test + 1-line change)

---

### P2-9: Unused registry code (~5000 lines) should be cleaned up or completed

**Issue**: `DynamicProfileDetail`, `ProfileTypeSelector`, `DynamicProfileForm`, and engine components were built but are not rendered anywhere in the current UI. The `profile_type_definitions` table has 80 types, none of which are user-selectable. This dead code:
- Inflates the bundle size (though tree-shaking should eliminate most of it)
- Creates confusion for anyone reading the codebase
- May be imported somewhere via a side effect that keeps it in the bundle

**What needs to change**:
- Either wire these components into the profile creation flow (making them real features), or delete them before the codebase grows further.
- Run `vite bundle analyze` to verify they're not in the production bundle.

**Files**: Any file in `client/src/components/` containing "Dynamic" or "Engine"
**Complexity**: Large to integrate; Small to delete

---

### P2-10: No automated tests

**Issue**: The test suite in `/tests/` exists but the extent of coverage is unclear from the file structure. There are no E2E tests (Playwright/Cypress) for critical user flows: sign up → create habit → check in → see streak; add expense → view in finance; upload document → see extracted data.

**What needs to change**:
- Add Playwright tests for at minimum: auth flow, creating each entity type, profile filtering, and dashboard loading.
- Add unit tests for `calculateStreak()` and expense totaling logic.

**Files**: `/tests/`
**Complexity**: Large

---

## Summary Table

| ID | Issue | Files | Complexity | Priority |
|---|---|---|---|---|
| P0-1 | Preferences 404 → return null value properly | routes.ts, dashboard.tsx | Small | **P0** |
| P0-2 | Tracker entry forProfile backfill | routes.ts, supabase-storage.ts | Small | **P0** |
| P0-3 | Streak "0d" display for partial targetPerDay | habits.tsx, supabase-storage.ts | Small | **P0** |
| P0-4 | Goals not filtered by profile on frontend | trackers.tsx | Small | **P0** |
| P0-5 | Manifest says "LifeOS" not "Portol" | manifest.json | Trivial | **P0** |
| P1-1 | Trackers entry filter blocked by P0-2 | trackers.tsx | Small | **P1** |
| P1-2 | Journal has no linkedProfiles schema | (comment only for now) | Trivial | **P1** |
| P1-3 | No React error boundaries | App.tsx, dashboard.tsx | Small | **P1** |
| P1-4 | SW cache version hardcoded | sw.js | Small | **P1** |
| P1-5 | Raw err.message in user-facing toasts | habits/tasks/trackers etc | Small | **P1** |
| P1-6 | No error monitoring (Sentry) | main.tsx, vercel-entry.ts | Small | **P1** |
| P1-7 | Notification dismissals reset on refresh | dashboard.tsx | Small | **P1** |
| P1-8 | No client-side form validation | finance/trackers/goals pages | Medium | **P1** |
| P1-9 | Dashboard cache stale in multi-tab | routes.ts | Small | **P1** |
| P2-1 | No pagination on list endpoints | routes.ts, storage, all pages | Large | P2 |
| P2-2 | Documents as base64 in DB | supabase-storage.ts | Medium | P2 |
| P2-3 | Chat history not persisted | ai-engine.ts, storage | Medium | P2 |
| P2-4 | No undo on destructive deletes | all pages | Small–Large | P2 |
| P2-5 | Mobile sheet scroll on iOS | trackers/finance/obligations | Small | P2 |
| P2-6 | Calendar month-only view | calendar-page.tsx | Large | P2 |
| P2-7 | Rate limit IP fallback | routes.ts | Small | P2 |
| P2-8 | unsafe-inline in CSP | security-headers.ts | Small | P2 |
| P2-9 | ~5000 lines unused registry code | various components | Large | P2 |
| P2-10 | No automated tests | /tests/ | Large | P2 |

---

## Launch Sequence Recommendation

**Day 1** (before any users): P0-1, P0-5 (trivial fixes, no risk)

**Day 2**: P0-2 (backfill script), P0-3 (streak display), P0-4 (goals filter)

**Day 3**: P1-3 (error boundaries), P1-6 (Sentry), P1-5 (clean up err.message toasts)

**Week 1 post-launch**: P1-7 (notification persistence), P1-8 (form validation), P1-4 (SW version)

**Week 2 post-launch**: P1-9 (cache invalidation), P2-5 (mobile scroll), P2-7 (rate limiting), P2-8 (CSP)

**Post-stabilization**: P2-1 through P2-10 as prioritized by usage patterns

---

*End of production readiness plan. Total P0 fixes: 5 items, all Small or Trivial complexity. Total estimated P0 fix time: 2–4 hours of focused work.*
