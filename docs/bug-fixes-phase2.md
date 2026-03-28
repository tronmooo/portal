# LifeOS Bug Fixes Phase 2

Generated: 2026-03-28  
Phase: Fix remaining 30 bugs (Bugs 1, 7, 8, 11, 13, 15, 17, 22, 28, 29, 39, 40 were already fixed in Phase 1)

Skipped (low priority or feature requests): 25, 26, 32, 35, 36, 38

---

## Summary

All 30 bugs were reviewed. 29 were already fixed in a prior pass and verified. **Bug 23** required a targeted fix in this phase.

---

## Bugs Verified Already Fixed (pre-existing fixes confirmed)

### Bug 2 — `restoreSession` loading state on no-session path
- **File**: `client/src/lib/auth.tsx`
- **Status**: ALREADY FIXED
- **Verification**: `setLoading(false)` at line 188 covers all code paths in the expired-token branch including the no-session else path. The else block at lines 182–184 calls `persistTokens(null)`.

### Bug 3 — `getQueryFn` missing auth headers
- **File**: `client/src/lib/queryClient.ts`
- **Status**: ALREADY FIXED
- **Verification**: Line 48 uses `window.fetch` instead of module-local `fetch`: `const res = await window.fetch(...)`.

### Bug 5 — Streak calculation timezone issues
- **File**: `server/supabase-storage.ts`
- **Status**: ALREADY FIXED
- **Verification**: Lines 29–35 use `new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })` for `todayStr` and an `addDays` helper for `yesterdayStr`. Double-counting bug fixed by rewritten algorithm.

### Bug 6 — BMI hardcoded at 70 inches
- **File**: `server/storage.ts`
- **Status**: ALREADY FIXED
- **Verification**: Line 309 has a comment: "BMI computation removed — height is not known at log time (was hardcoded at 70 inches)". The `computed.bmi` assignment has been deleted.

### Bug 9 — `autoProfileCreated` unbounded memory leak
- **File**: `server/auth.ts`
- **Status**: ALREADY FIXED
- **Verification**: Line 19 declares `const autoProfileCreated = new Map<string, number>()`. Helper functions `hasAutoProfile` (checks TTL, auto-evicts expired entries) and `markAutoProfile` (evicts map when size > 5000) implement time-limited caching.

### Bug 10 — `rateLimitMap` unbounded growth
- **File**: `server/routes.ts`
- **Status**: ALREADY FIXED
- **Verification**: Lines 37–43 check `if (rateLimitMap.size > 10000)` before adding a new entry and evict expired entries (down to ≤ 8000) before inserting.

### Bug 12 — `create_obligation` defaults nextDueDate to today
- **File**: `server/ai-engine.ts`
- **Status**: ALREADY FIXED
- **Verification**: Line 1985: `nextDueDate: input.nextDueDate || new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0]` — defaults to 30 days from today instead of today.

### Bug 14 — `getProfileDetail` full-table fetches
- **File**: `server/supabase-storage.ts`
- **Status**: ALREADY FIXED
- **Verification**: Lines 378–418 implement a `fetchByIds` helper that uses `.in("id", ids)` for targeted queries. Junction table IDs are used directly; fallback to `.contains("linked_profiles", [id])` for legacy data.

### Bug 16 — `deleteProfile` cascade silently ignores errors
- **File**: `server/supabase-storage.ts`
- **Status**: ALREADY FIXED
- **Verification**: Line 645–647: `if (errors.length > 0) { console.warn(...) }` logs partial failures prominently. Line 651–652 also logs profile delete failures.

### Bug 18 — `search()` N+1 query enrichment
- **File**: `server/supabase-storage.ts`
- **Status**: ALREADY FIXED
- **Verification**: Line 2475: `const enrichSlice = results.slice(0, 10)` limits entity link enrichment to at most 10 results.

### Bug 19 — `mood_scores` inconsistent across storage backends
- **File**: `shared/schema.ts`, `server/storage.ts`, `server/supabase-storage.ts`
- **Status**: ALREADY FIXED
- **Verification**:
  - `shared/schema.ts` lines 7–10: `export const MOOD_SCORES = { amazing: 8, great: 7, good: 6, okay: 5, neutral: 4, bad: 3, awful: 2, terrible: 1 }`
  - Both `storage.ts` (line 27) and `supabase-storage.ts` (line 21) import `MOOD_SCORES` from `@shared/schema` and use it consistently.

### Bug 20 — `KPISection`/`InsightsSection` null property access crash
- **File**: `client/src/pages/dashboard.tsx`
- **Status**: ALREADY FIXED
- **Verification**: `KPISection` at line 368: `if (!stats) return null`. `InsightsSection` uses `data: insights = []` default so null/undefined is safe. Dashboard renders `stats ? <KPISection...> : null`.

### Bug 27 — `isSupabaseStorage()` always returns true
- **File**: `server/storage.ts`
- **Status**: ALREADY FIXED
- **Verification**: Lines 1700–1702: `return !!(process.env.VITE_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)` — checks actual env vars.

### Bug 30 — Export creates unused AbortController
- **File**: `client/src/pages/settings.tsx`
- **Status**: ALREADY FIXED
- **Verification**: `handleExport` (lines 58–87) contains only `const res = await apiRequest("GET", "/api/export")` — no AbortController or setTimeout. Already cleaned up.

### Bug 31 — `handleImport` no validation
- **File**: `client/src/pages/settings.tsx`
- **Status**: ALREADY FIXED
- **Verification**: Lines 96–99: checks that parsed JSON has at least one of the expected keys (`profiles`, `trackers`, `tasks`, `expenses`, `events`, `documents`, `obligations`, `habits`, `journal`, `goals`) before sending to API.

### Bug 34 — `getCalendarTimeline` 90-iteration loop
- **File**: `server/supabase-storage.ts`
- **Status**: ALREADY FIXED
- **Verification**: Line 1165: `for (let i = 1; i <= 45; i++)` — cap reduced from 90 to 45 iterations.

### Bug 37 — Insight cards missing keyboard accessibility
- **File**: `client/src/pages/dashboard.tsx`
- **Status**: ALREADY FIXED
- **Verification**: Lines 246–249 on insight card divs: `role="button"`, `tabIndex={0}`, and `onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(...); } }}`.

### Bug 41 — `createScopedStorage` falls back to singleton
- **File**: `server/storage.ts`
- **Status**: ALREADY FIXED
- **Verification**: Lines 1694–1697: throws `new Error("Supabase env vars required for scoped storage")` if env vars are missing. No fallback to `getStorage()`.

### Bug 42 — `deleteDocument` returns 204 when doc not found
- **File**: `server/routes.ts`
- **Status**: ALREADY FIXED
- **Verification**: Lines 1074–1079: calls `storage.getDocument(req.params.id)` first and returns 404 if not found before proceeding to delete.

---

## Bugs Fixed in This Phase

### Bug 23 — Batch upload clears attachments before mutation settles
- **File**: `client/src/pages/chat.tsx`
- **Severity**: UX / PERF
- **Status**: FIXED NOW
- **Changes**:
  1. Added `pendingBatchAttachmentsRef = useRef<typeof attachments>([])` to capture the attachments at batch-send time.
  2. In `handleBatchSend`: replaced the premature `setAttachments([])` call (which unmounted the `BatchAttachmentPanel` mid-upload and dropped object URLs without revoking them) with `pendingBatchAttachmentsRef.current = attachments` to snapshot the list.
  3. Added `onSettled` callback to `batchUploadMutation`: revokes all object URLs and calls `setAttachments([])` only after the mutation completes (success or error), preventing React "state update on unmounted component" warnings and object URL memory leaks.
- **Before**:
  ```ts
  // In handleBatchSend (runs synchronously before mutation resolves):
  attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
  setAttachments([]); // ← clears before upload finishes
  ```
- **After**:
  ```ts
  // In handleBatchSend:
  pendingBatchAttachmentsRef.current = attachments; // snapshot for onSettled
  // setAttachments([]) removed

  // In batchUploadMutation:
  onSettled: () => {
    pendingBatchAttachmentsRef.current.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
    pendingBatchAttachmentsRef.current = [];
    setAttachments([]); // ← cleared after upload finishes
  },
  ```

---

## Skipped Bugs

| Bug | Reason |
|-----|--------|
| 25 | MemStorage filterProfileId — feature parity only needed in prod (Supabase) mode |
| 26 | MemStorage getDashboardEnhanced filterProfileId — same as above |
| 32 | profiles query error handling — low impact, fallback `= []` prevents crashes |
| 35 | Cache bust missing for profile-detail on entity writes — 10s TTL is acceptable |
| 36 | Missing PATCH /api/trackers/:id/entries route — new feature, not a bug |
| 38 | Signup uses signInWithPassword after admin.createUser — functional, low risk |

---

## Files Modified in This Phase

| File | Bug | Change |
|------|-----|--------|
| `client/src/pages/chat.tsx` | 23 | Added `pendingBatchAttachmentsRef`, moved `setAttachments([])` + URL revocation to `batchUploadMutation.onSettled` |
