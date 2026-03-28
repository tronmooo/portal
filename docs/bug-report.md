# LifeOS Full Codebase Bug Report

Generated: 2026-03-28  
Auditor: Automated full-codebase analysis  
Files audited: server/ai-engine.ts, server/routes.ts, server/supabase-storage.ts, server/storage.ts, server/auth.ts, client/src/lib/auth.tsx, client/src/lib/queryClient.ts, client/src/pages/*.tsx, client/src/components/*.tsx, shared/schema.ts

---

## Bug 1: Auth middleware `next()` called inside async `requestStorageContext.run()` — response may complete before middleware chain
- **Severity**: CRASH
- **File**: server/auth.ts:90–115
- **Description**: `next()` is called inside `requestStorageContext.run(scopedStorage, async () => { ... next(); })`. If an error is thrown after `next()` is called (e.g. from the route handler), the Express error handler won't receive it because it propagates inside the `AsyncLocalStorage.run` callback rather than through Express's normal async chain. Additionally, if `next()` throws synchronously (e.g. another middleware error), that error is swallowed by the async callback and the response hangs. The `return res.status(401)...` guard on line 118 fires too late — the `await` in the storage context means `next()` has already been called in a different microtask.
- **Fix**: Call `next()` synchronously after `requestStorageContext.run()` resolves, or use `asyncHandler` wrapping around the entire auth middleware body. The most robust fix is to `await` the `run` callback and call `next()` outside it: `await new Promise<void>(resolve => requestStorageContext.run(scopedStorage, () => { resolve(); })); next();`

---

## Bug 2: `restoreSession` calls `memoryTokens` (stale closure) after async refresh
- **Severity**: DATA
- **File**: client/src/lib/auth.tsx:171–181
- **Description**: In `restoreSession`, after a successful token refresh (`if (refreshData.session)`), the code calls `setSession(refreshData.session)` but then falls through without `setLoading(false)`. The `setLoading(false)` on line 198 is at the bottom of the try/catch but the `if (tokens.expires_at && tokens.expires_at < now)` branch does not hit `setLoading(false)` on the error path if `refreshData.session` is falsy — the user is stuck in loading state permanently if refresh returns no session.
- **Fix**: Add `setLoading(false)` inside the `if (refreshData.session)` block at line 181, and also add `else { persistTokens(null); setLoading(false); }` for the no-session case.

---

## Bug 3: `getQueryFn` in queryClient.ts does not add auth headers
- **Severity**: SECURITY
- **File**: client/src/lib/queryClient.ts:48
- **Description**: The default `getQueryFn` uses raw `fetch()` (not the auth-intercepted one) for all GET queries: `const res = await fetch(\`${API_BASE}${url}\`)`. The `installAuthInterceptor()` in `auth.tsx` patches `window.fetch`, but `getQueryFn` calls `fetch` directly which resolves to the original fetch at module-load time — before the interceptor is installed. This means all `useQuery` GET requests skip the auth header in environments where the interceptor hasn't been applied to the module-scoped `fetch` reference. This is a race condition: works in most browsers but fails in some environments.
- **Fix**: Either use `apiRequest` (which does carry auth headers via the interceptor pattern) or explicitly reference `window.fetch` (not the module-local `fetch`) inside the queryFn, or explicitly pass the auth header using `getAuthHeader()` from the auth context.

---

## Bug 4: `apiRequest` in queryClient.ts calls `throwIfResNotOk` which CONSUMES the response body
- **Severity**: CRASH
- **File**: client/src/lib/queryClient.ts:30
- **Description**: `throwIfResNotOk` calls `await res.text()` on error, consuming the response body. After `apiRequest` returns the `Response`, callers then call `res.json()` on it. If the response is NOT an error (2xx), this is fine. But if `throwIfResNotOk` were called on a non-error response that has already been partially read, it would fail. More critically: the function consumes the response body via `res.text()` even on error — but since it throws, no further `.json()` call is made. This is actually correct in the error case. However, in `auth.tsx:173`, `restoreSession` calls `apiRequest("POST", "/api/auth/refresh", ...)` and then does `const refreshData = await refreshRes.json()`. If the refresh returns a non-2xx response, `throwIfResNotOk` will throw (with the text body), but the `catch {}` block on line 195 just calls `persistTokens(null)` silently — the user is logged out without any UI feedback.
- **Fix**: For auth flows, catch the specific error from `apiRequest` and show a user-facing message rather than silently clearing the session.

---

## Bug 5: Streak calculation uses `Date.now()` arithmetic instead of timezone-aware dates
- **Severity**: DATA
- **File**: server/storage.ts:362, server/supabase-storage.ts:28–48
- **Description**: `calculateStreak` computes "yesterday" as `new Date(Date.now() - 86400000)`. This is incorrect around DST transitions: on the day clocks "spring forward" or "fall back", this produces the wrong date. For example, `Date.now() - 86400000` on the morning after "spring forward" gives 25 hours earlier, which could land on the same calendar date. Additionally, the streak computation iterates from `i=0` to `dates.length` but the `expected2` check on `i===0` is redundant and confusing — it computes `expected2` as today-1 unconditionally, meaning if the most recent checkin was yesterday, `i=0` increments `current` to 1 (correct), but then `i=1` checks `expected` = yesterday, which IS in the dates list (it's `dates[0]`), incrementing `current` to 2 instead of 1. This double-counts yesterday.
- **Fix**: Use `new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })` for timezone-aware "today". Fix the double-counting by ensuring `expected` and `expected2` don't overlap — the `i===0 && dates.includes(expected2)` branch should only fire when `dates[0] === yesterday`, not when `dates[0] === today`.

---

## Bug 6: BMI hardcodes height at 70 inches for all users
- **Severity**: DATA
- **File**: server/storage.ts:312–313
- **Description**: `computeSecondaryData` computes BMI with a hardcoded height of 70 inches (5'10"): `const heightInches = 70; computed.bmi = Math.round((weight / (heightInches * heightInches)) * 703 * 10) / 10`. This is wrong for anyone who is not exactly 5'10". The computed BMI is silently stored and displayed to users.
- **Fix**: Either remove BMI computation from automatic secondary data (since height isn't available at log time), or accept `height` as an optional tracker field and skip BMI computation if height is unavailable. Alternatively, look up the self profile's height field before computing.

---

## Bug 7: `sync_calendar` tool uses `execSync` — blocks the Node event loop
- **Severity**: PERF
- **File**: server/ai-engine.ts:2351
- **Description**: The `sync_calendar` tool handler calls `execSync(...)` from Node's `child_process` module with a 30-second timeout. `execSync` is synchronous and blocks the entire Node.js event loop for up to 30 seconds, preventing ALL other requests from being served during that time. In a multi-user server, this would cause every other user's requests to hang.
- **Fix**: Replace `execSync` with `execFilePromise` or `spawn` using a Promise wrapper so the call is non-blocking.

---

## Bug 8: `processMessage` context cache uses `userId` but `invalidateContextCache()` called without `userId`
- **Severity**: DATA
- **File**: server/ai-engine.ts:2913
- **Description**: `getCachedContextData(userId)` builds a per-user cache keyed by `userId`. However, in the tool execution loop (line 2913), `invalidateContextCache()` is called without a `userId` argument, which calls `contextCacheMap.clear()` — wiping ALL users' caches. In a multi-user scenario, this means every write by user A invalidates user B's context cache, causing extra DB round-trips but not a correctness issue. However, on line 34, `invalidateContextCache` with no argument also clears any `_global` entries, meaning the fallback anonymous-user cache is cleared on every write by any user.
- **Fix**: Pass `userId` to `invalidateContextCache` in the tool execution loop: `invalidateContextCache(userId)`.

---

## Bug 9: `autoProfileCreated` set in `auth.ts` leaks memory — never cleaned up, grows unboundedly
- **Severity**: PERF
- **File**: server/auth.ts:19
- **Description**: `const autoProfileCreated = new Set<string>()` is a module-level singleton that stores user IDs to skip auto-profile creation on subsequent requests. It is never cleared. Over time (weeks/months of operation), this set will contain every user ID that has ever logged in, growing without bound. For a long-running server with many users, this is a memory leak.
- **Fix**: Use a `WeakSet` (not applicable for strings) or a time-limited LRU cache, or simply move the check to a database preference key (e.g., `setPreference('self_profile_created', 'true')`) so the server restart doesn't re-run it unnecessarily.

---

## Bug 10: `rateLimitMap` in routes.ts grows unboundedly on high traffic before cleanup fires
- **Severity**: PERF
- **File**: server/routes.ts:31–49
- **Description**: The in-memory rate limiter `rateLimitMap` is cleaned up every 5 minutes by an `setInterval`. Between cleanups, on high-traffic servers receiving thousands of distinct IPs, the map can grow to millions of entries. Additionally, the cleanup interval holds a reference that prevents the module from being GC'd, and if the server is running under a process manager that hot-reloads, the interval leaks.
- **Fix**: Cap the map size to 10,000 entries (evict oldest on overflow), or use a proper rate-limiting library like `express-rate-limit`.

---

## Bug 11: `createExpense` in `ai-engine.ts` uses `parseFloat(input.amount)` but `input.amount` is already typed as `number`
- **Severity**: DATA
- **File**: server/ai-engine.ts:1904
- **Description**: The `create_expense` tool handler does `amount: parseFloat(input.amount) || 0`. If the AI passes `amount` as a string (e.g., `"12.50"` instead of `12.50`), `parseFloat` handles it. But if the AI passes `NaN` or `null`, `parseFloat(null) === NaN`, `NaN || 0 === 0`, so a $0 expense is silently logged. The user sees a confirmation message stating an amount was logged, but the stored amount is $0.
- **Fix**: Validate with: `const amount = typeof input.amount === 'number' && isFinite(input.amount) && input.amount > 0 ? input.amount : parseFloat(input.amount); if (!amount || amount <= 0) return { error: 'Invalid amount' };`

---

## Bug 12: `create_obligation` tool defaults `nextDueDate` to today if not provided
- **Severity**: DATA
- **File**: server/ai-engine.ts:1980
- **Description**: `nextDueDate: input.nextDueDate || new Date().toISOString().split("T")[0]` silently defaults the next due date to today if the AI doesn't provide one. This is a bad default — if a user says "I pay rent on the 1st", and the AI doesn't infer the next date, the obligation is created as due today instead of the correct future date. The user's calendar will show a "past due" obligation immediately.
- **Fix**: Make `nextDueDate` required in the tool schema (it already says it is in the description but is not in `required` array), or default to 30 days from today, or prompt the AI to always compute the next occurrence date.

---

## Bug 13: `getProfileDetail` in `supabase-storage.ts` mutates orphaned profiles in-memory
- **Severity**: DATA
- **File**: server/supabase-storage.ts:388
- **Description**: When computing child profiles for a "self" profile, the code does `for (const orphan of orphans) orphan.parentProfileId = id;` — this mutates the profile object that was fetched from the DB. If this object is referenced elsewhere in the same request (e.g., returned in `allProfiles` or `relatedTrackers`), the `parentProfileId` field is now incorrect. This mutation only exists in memory (not written to DB), but if a later part of the request serializes these profile objects, they'll have wrong `parentProfileId` values.
- **Fix**: Use `{ ...orphan, parentProfileId: id }` to create a new object instead of mutating the existing one: `childProfiles = [...childProfiles, ...orphans.map(o => ({ ...o, parentProfileId: id }))];`

---

## Bug 14: `getProfileDetail` in `supabase-storage.ts` makes 6 separate full-table fetches
- **Severity**: PERF
- **File**: server/supabase-storage.ts:368–371
- **Description**: After using junction tables to get the IDs of related entities (lines 349–356), the code then calls `this.getTrackers(), this.getExpenses(), this.getTasks(), this.getEvents(), this.getDocuments(), this.getObligations()` — each of which fetches ALL records for the user. For a user with 1000 expenses, this fetches all 1000 just to find 3 linked ones. This is an N-per-profile problem that makes profile detail pages extremely slow for users with lots of data.
- **Fix**: Use Supabase's `.in()` filter: `this.supabase.from("expenses").select("*").eq("user_id", this.userId).in("id", [...expenseIds])` — only fetch the specific IDs that are linked.

---

## Bug 15: `deleteProfile` in `supabase-storage.ts` uses name-based matching to delete obligations
- **Severity**: DATA
- **File**: server/supabase-storage.ts:540–544
- **Description**: `deleteProfile` matches obligations for deletion using `ob.name.toLowerCase().includes(profileNameLower) || profileNameLower.includes(ob.name.toLowerCase())`. This can delete obligations that merely have a similar name but are not actually linked to the profile. For example, deleting a profile named "Netflix" would also delete any obligation with "Netflix" in the name even if it belongs to a different profile.
- **Fix**: Only delete obligations that are in `ob.linkedProfiles.includes(id)`. Remove the name-based matching entirely.

---

## Bug 16: `deleteProfile` cascade silently ignores errors
- **Severity**: DATA
- **File**: server/supabase-storage.ts:535–607
- **Description**: Every cascade delete step is wrapped in `try { ... } catch (e) { errors.push("tableName"); }`. If the profile is partially deleted (e.g., profile itself succeeds but linked tasks are still linked), the data is left in an inconsistent state. The caller (route handler) gets `true` (success) even though some linked data wasn't cleaned up. Users could see orphaned data for deleted profiles.
- **Fix**: Return the `errors` array in the result or log it prominently. Consider using a Supabase transaction (RPC function with `BEGIN/COMMIT`) for atomic cascade deletion.

---

## Bug 17: `createObligation` in `supabase-storage.ts` creates a duplicate calendar event with wrong title format
- **Severity**: DATA
- **File**: server/supabase-storage.ts:1675–1690
- **Description**: `createObligation` auto-generates a calendar event with title `💳 ${data.name} — $${data.amount}`. However, the AI's system prompt instructs: `create_obligation handles everything: obligation + profile + calendar entries`. The `getCalendarTimeline` also generates obligation entries dynamically (line 1154). This means every obligation gets TWO calendar entries: one stored in the `events` table (from `createObligation`) and one generated dynamically in `getCalendarTimeline`. The dedup logic in `getCalendarTimeline` only removes exact title+date matches — but the stored event uses `💳 ${name} — $${amount}` while the dynamic one uses `${name} — $${amount}` (different emoji), so they don't dedup correctly.
- **Fix**: Either remove the auto-event creation in `createObligation` (since `getCalendarTimeline` generates them dynamically), or ensure the stored events use the same format as the dynamic ones and the dedup correctly matches them.

---

## Bug 18: `search()` in `supabase-storage.ts` has N+1 query problem in entity link enrichment
- **Severity**: PERF
- **File**: server/supabase-storage.ts:2452–2486
- **Description**: The search function first fetches all matching entities, then for each result, calls `getEntityLinks()` (which does a DB query), and then for each link, does individual `getProfile(id)`, `getTask(id)`, `getEvent(id)`, etc. calls. For 20 search results each with 3 links pointing to 3 different entity types, this is 20 + 60 = 80 DB queries just for enrichment. This makes full-text search extremely slow.
- **Fix**: Limit entity link enrichment to at most 10 results, or skip it entirely in the basic search path and only enrich on a specific "related" query.

---

## Bug 19: `mood_scores` in `storage.ts` and `supabase-storage.ts` are inconsistent
- **Severity**: DATA
- **File**: server/storage.ts:547, server/supabase-storage.ts:125
- **Description**: In `storage.ts` (MemStorage), mood scores are: `{ amazing: 5, good: 4, neutral: 3, bad: 2, awful: 1 }` — missing `"great"`, `"okay"`, and `"terrible"` entirely. In `supabase-storage.ts`, scores are `{ amazing: 8, great: 7, good: 6, okay: 5, neutral: 4, bad: 3, awful: 2, terrible: 1 }`. The thresholds also differ: MemStorage triggers "mood low" at `avg <= 2.5` (scale of 5), SupabaseStorage at `avg <= 2.5` (scale of 8) — completely different thresholds for the same semantic concept. Any user with mood "great", "okay", or "terrible" logged in MemStorage gets fallback score of `3` (neutral), causing wrong mood trend calculations.
- **Fix**: Unify mood scores and thresholds into a shared constant in `schema.ts`, use the same scale in both implementations.

---

## Bug 20: `queryClient.ts` `getQueryFn` returns `null` on 401 but callers may not handle `null`
- **Severity**: CRASH
- **File**: client/src/lib/queryClient.ts:50–52
- **Description**: `getQueryFn({ on401: "returnNull" })` returns `null` when a 401 is received. Many components use this data with `data = []` as default (e.g., `const { data: habits = [] } = useQuery(...)`) — safe. But some components use direct property access on the result without null-checking (e.g., in `dashboard.tsx`, `stats.activeTasks` where `stats` could theoretically be `null`). While the default `on401: "returnNull"` is the global default, a 401 on `queryKey: ["/api/stats"]` would cause `stats` to be `null`, and accessing `stats.activeTasks` in `KPISection` would crash with `Cannot read properties of null`.
- **Fix**: Add a null guard: `if (!stats) return null;` at the top of `KPISection`, and similar guards in all components that use query data without `?? {}` defaults.

---

## Bug 21: `handleConfirmExtraction` in `chat.tsx` silently swallows errors
- **Severity**: UX
- **File**: client/src/pages/chat.tsx:874–876
- **Description**: `handleConfirmExtraction` has `catch (err) { console.error("Confirm extraction failed:", err); }` — if the API call fails (network error, 500, etc.), the user sees no feedback. The UI shows the extraction confirmation buttons, the user clicks "Confirm", nothing happens visually, and the button is already set to `confirmed=true` via `setConfirmed(true)` on line 267 (called before `onConfirm`). So the UI shows "Extraction confirmed and saved" even when the server call failed.
- **Fix**: Move `setConfirmed(true)` to inside the `onSuccess` callback (after the API returns `result.success`). Show a toast on failure.

---

## Bug 22: `ExtractionConfirmation` sets `confirmed=true` before the async call completes
- **Severity**: UX
- **File**: client/src/pages/chat.tsx:265–268
- **Description**: The Confirm button's `onClick` calls both `handleConfirm()` (which calls `onConfirm(...)` which fires the async API call) AND `setConfirmed(true)` synchronously in the same click handler. This means the "Extraction confirmed and saved" success UI is shown instantly, regardless of whether the server actually saved the data. If the network is slow or the server fails, the user believes the data was saved when it wasn't.
- **Fix**: Pass a callback to `onConfirm` that calls `setConfirmed(true)` only on success. Or use a loading/success/error state pattern.

---

## Bug 23: `batch upload` progress simulation in `chat.tsx` — fake progress with no real feedback
- **Severity**: UX
- **File**: client/src/pages/chat.tsx:986–1000
- **Description**: The batch upload progress counter uses `setInterval(..., 2000)` to increment `processedCount` by 1 every 2 seconds as a fake progress simulation. However, `setAttachments([])` is called on line 997 BEFORE the mutation settles (success/error). This means if the user opens the batch panel and starts an upload, the attachment list is cleared immediately — so the `isBatch` condition becomes false and the `BatchAttachmentPanel` unmounts mid-upload. The progress display (`processedCount`) is updating state in an unmounted component, causing React warnings.
- **Fix**: Don't clear `attachments` until the mutation's `onSuccess` or `onError` fires. Keep `attachments` visible during upload to show progress.

---

## Bug 24: `insightRoute` in `dashboard.tsx` uses hash routes that don't match the app's router
- **Severity**: UX
- **File**: client/src/pages/dashboard.tsx:97–106
- **Description**: `insightRoute` returns routes like `"#/trackers"`, `"#/dashboard/finance"`, `"#/dashboard/obligations"`. These are then used in `navigate(insightRoute(insight).replace("#", ""))` — the `replace("#", "")` results in `"/trackers"`, `"/dashboard/finance"`, etc. But the actual app routes (in `App.tsx`) are things like `/trackers`, `/dashboard`, `/obligations`, `/journal` — not `/dashboard/finance` or `/dashboard/journal`. Clicking insight cards navigates to non-existent routes, showing a 404.
- **Fix**: Check the actual routes in `App.tsx` and update `insightRoute` to use the correct paths. For example: `finance` → `/finance`, `obligations` → `/obligations`, `journal` → `/journal`, `habits` → `/habits`.

---

## Bug 25: `MemStorage.getStats()` does not support `filterProfileId` parameter
- **Severity**: DATA
- **File**: server/storage.ts:1294
- **Description**: `MemStorage.getStats(filterProfileId?: string)` accepts the `filterProfileId` parameter but completely ignores it — all stats are always returned unfiltered. The `IStorage` interface declares `getStats(filterProfileId?: string)`, and `SupabaseStorage.getStats()` correctly filters. In local dev (MemStorage) mode, all dashboard stats always show global totals regardless of profile filter, making profile-specific views show wrong data.
- **Fix**: Add profile filtering logic to `MemStorage.getStats()` matching the behavior in `SupabaseStorage.getStats()`.

---

## Bug 26: `MemStorage.getDashboardEnhanced()` also ignores `filterProfileId`
- **Severity**: DATA
- **File**: server/storage.ts:1378
- **Description**: `MemStorage.getDashboardEnhanced()` does not accept or use `filterProfileId`, yet the `IStorage` interface declares `getDashboardEnhanced(filterProfileId?: string)`. The route handler passes `profileId` from the query string to this method. In MemStorage mode, the profile filter is silently ignored.
- **Fix**: Add `filterProfileId` parameter and implement the same filtering logic as in `SupabaseStorage.getDashboardEnhanced()`.

---

## Bug 27: `isSupabaseStorage()` always returns `true` — misleads auth middleware
- **Severity**: DATA
- **File**: server/storage.ts:1705–1706
- **Description**: `isSupabaseStorage()` always returns `true` (hardcoded), and is used in `auth.ts:49` to decide whether to enforce authentication. This means auth is ALWAYS required, even if Supabase env vars are missing. If the env vars ARE missing, `getStorage()` will throw on the first request (line 1661: `throw new Error("VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required")`), but `isSupabaseStorage()` returns `true` so `authMiddleware` runs first, creates a 401 response (the token is missing too), and the user sees an auth error rather than a config error.
- **Fix**: Make `isSupabaseStorage()` check the actual env vars: `return !!(process.env.VITE_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);`. Or document that the constant is intentional and remove the local SQLite fallback mentions in comments.

---

## Bug 28: `journal_entry` tool uses `"awful"` but schema mood enum excludes `"okay"` and includes `"terrible"`  
- **Severity**: DATA
- **File**: server/ai-engine.ts:1002
- **Description**: The `journal_entry` tool's mood enum is `["amazing", "great", "good", "neutral", "bad", "awful"]` — it is missing `"okay"` and `"terrible"` from the schema enum (`schema.ts:397`: `["amazing", "great", "good", "okay", "neutral", "bad", "awful", "terrible"]`). If a user says "I'm feeling terrible", the AI maps to the closest valid value — probably `"awful"` — silently dropping the distinction. Conversely, `"okay"` is a valid mood in the schema but cannot be created through the AI tool.
- **Fix**: Update the tool enum to match the schema exactly: `["amazing", "great", "good", "okay", "neutral", "bad", "awful", "terrible"]`.

---

## Bug 29: `autoUpdateGoalProgress` in `ai-engine.ts` caps `current` at `target` but never marks goal complete
- **Severity**: UX
- **File**: server/ai-engine.ts:2582
- **Description**: `await storage.updateGoal(goal.id, { current: Math.min(newCurrent, goal.target) })` caps progress at the target but never changes `status` to `"completed"`. A goal at 100% will stay `"active"` forever, cluttering the goals list. The user has to manually mark it complete.
- **Fix**: If `newCurrent >= goal.target`, also set `status: "completed"` in the same update: `{ current: Math.min(newCurrent, goal.target), ...(newCurrent >= goal.target ? { status: "completed" } : {}) }`.

---

## Bug 30: `settings.tsx` — export creates an AbortController but never passes `signal` to `apiRequest`
- **Severity**: UX
- **File**: client/src/pages/settings.tsx:60–61
- **Description**: `handleExport` creates `const controller = new AbortController()` and `const timeout = setTimeout(() => controller.abort(), 30000)`, but the `apiRequest("GET", "/api/export")` call on line 63 does not pass `{ signal: controller.signal }`. The AbortController is never connected to the fetch, so the timeout never actually cancels the request — it just clears a timer that does nothing.
- **Fix**: `apiRequest` has its own internal timeout (30s default for non-chat routes, line 12–13 of queryClient.ts), so the manual AbortController in settings.tsx is redundant. Either remove it entirely, or use `fetch` directly with the signal.

---

## Bug 31: `handleImport` in `settings.tsx` does no validation before sending raw JSON to `/api/import`
- **Severity**: SECURITY
- **File**: client/src/pages/settings.tsx:93–115
- **Description**: `handleImport` does `const data = JSON.parse(text); await apiRequest("POST", "/api/import", data)`. There is no validation of the JSON structure — a malicious or malformed file could send arbitrary data to the import endpoint. The server's `/api/import` endpoint should validate the schema, but if it doesn't, an attacker could craft a backup file that corrupts the user's data.
- **Fix**: At minimum, validate that the parsed JSON contains known top-level keys before sending, and on the server side, ensure `/api/import` validates each entity against the insertion schemas before writing.

---

## Bug 32: `useQuery` for profiles in `chat.tsx` uses `apiRequest` which throws on error, but `queryFn` should not throw for successful 2xx
- **Severity**: CRASH
- **File**: client/src/pages/chat.tsx:680–684
- **Description**: The profile query uses `queryFn: async () => { const res = await apiRequest("GET", "/api/profiles"); return res.json(); }`. `apiRequest` calls `throwIfResNotOk` internally, which throws if the status is not 2xx. However, if the auth token expires mid-session and `/api/profiles` returns 401, React Query catches the error and puts the query in error state — but the component uses `data: profiles = []` as default, so rendering doesn't crash. BUT: every subsequent refetch (from `invalidateQueries` in `invalidateAll()` which is called after every AI action) will re-throw, causing continuous error toasts in some configurations.
- **Fix**: Use `getQueryFn({ on401: "returnNull" })` for the profiles query, or catch 401 specifically to return an empty array rather than throwing.

---

## Bug 33: Object URL leak in chat.tsx — `previewUrl` created but only conditionally revoked
- **Severity**: PERF
- **File**: client/src/pages/chat.tsx:913, 1046
- **Description**: `URL.createObjectURL(file)` is called when files are staged (line 913). The URL is revoked in `handleRemoveAttachment` and in the single-attachment `onRemove` handler (lines 1046, 1236). However, after a successful batch upload (`onSuccess`, line 769), the attachments array is NOT cleared with URL revocation — `setAttachments([])` is not called in `batchUploadMutation.onSuccess`. Wait, actually line 997 clears attachments before the mutation. The issue is: after `setAttachments([])` on line 997 (before `onSuccess`), the `previewUrl` object URLs are never revoked — they're just dropped from state without calling `URL.revokeObjectURL()`. This leaks memory for each batch upload.
- **Fix**: In `handleBatchSend`, revoke all object URLs before clearing: `attachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); }); setAttachments([]);`

---

## Bug 34: `getCalendarTimeline` generates up to 90 × N recurring event instances in memory
- **Severity**: PERF
- **File**: server/supabase-storage.ts:1122–1138
- **Description**: For each recurring event, the code iterates `for (let i = 1; i <= 90; i++)` and generates 90 potential occurrences, all in memory. For a user with 20 recurring events (common: birthday, rent, subscriptions, etc.) this generates up to 1800 timeline items per call. The calendar view typically only displays 1–2 months, so most of these 90 iterations are wasted.
- **Fix**: Add an early exit when `nextStr > endDate` (already done), but also cap the iteration at `Math.ceil(daysBetween(startDate, endDate) / minFrequencyDays) + 1` to avoid generating far more occurrences than the date range needs.

---

## Bug 35: `cache busting` in routes.ts only busts `profile-detail:` prefix but leaves all other caches stale
- **Severity**: DATA
- **File**: server/routes.ts:118–128
- **Description**: The write-triggered cache bust (lines 118–128) calls `bustCache(\`stats:${uid}\`)` and `bustCache("profile-detail:")` per-request. However, `setCache` keys for `stats` include the profileId: `stats:${userId}:${profileId || 'all'}`. The bust key `stats:${uid}` without the profileId suffix will NOT match `stats:userId:profileId` entries — the bust uses `key.startsWith(prefix)`, so `stats:abc123` would match `stats:abc123:all` and `stats:abc123:profileId` correctly. This is actually fine. But there is no bust for the `profile-detail:${id}` cache when profile-linked data changes (e.g., adding an expense to a profile). The profile detail cache has a 10-second TTL (line 551) so this creates a 10-second stale window for profile detail data.
- **Fix**: Bust profile-detail caches more aggressively — when expenses/tasks/events/etc. are written, also bust `profile-detail:` for any profiles linked to those entities.

---

## Bug 36: `PATCH /api/trackers/:id/entries` route does not exist — entries can only be deleted, not updated
- **Severity**: UX
- **File**: server/routes.ts:899–909
- **Description**: The routes for tracker entries only include POST (create at line 846) and DELETE (at line 899). There is no PATCH route for updating an existing tracker entry. The `IStorage` interface has no `updateTrackerEntry` method. Users cannot correct a mistaken tracker entry value — they must delete and re-create, losing the original timestamp. The UI in `trackers.tsx` has an edit flow for entries but it likely only works via delete+recreate (unverified without reading all of trackers.tsx).
- **Fix**: Add `updateTrackerEntry(trackerId: string, entryId: string, data: Partial<TrackerEntry>)` to `IStorage`, implement it in both storage backends, and add `PATCH /api/trackers/:id/entries/:entryId` route.

---

## Bug 37: `dashboard.tsx` `insightRoute` navigates using `navigate()` from `wouter` but insight click is on a div with no keyboard handler
- **Severity**: UX
- **File**: client/src/pages/dashboard.tsx:246–248
- **Description**: Insight cards use `<div onClick={() => navigate(...)}>` but have no `role="button"`, `tabIndex`, or `onKeyDown` handler. Keyboard-only users cannot activate insight cards. This is a minor accessibility bug.
- **Fix**: Add `role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(...); }}` to the insight card div, same pattern already used correctly in `MiniStat`.

---

## Bug 38: Auth `signup` route in `auth.ts` uses `admin.createUser` then `signInWithPassword` — password is sent twice to Supabase
- **Severity**: SECURITY
- **File**: server/auth.ts:151–168
- **Description**: The signup flow first calls `supabase.auth.admin.createUser({ email, password, email_confirm: true })` using the service role key, then calls `supabase.auth.signInWithPassword({ email, password })` immediately after. While functional, the service role key is used for the first call (which is correct), but the second call `signInWithPassword` using service role is unusual — Supabase's `signInWithPassword` is meant for anon key usage. With the service role key, this call still works but creates an unnecessary Supabase admin API call. More importantly, the `email_confirm: true` comment says "no email verification" — this is a deliberate choice but means any email address can be used without verification (including ones the user doesn't own).
- **Fix**: If using admin key for createUser, Supabase admin can return a session directly. Skip the separate `signInWithPassword` call and use the admin's `createUser` response to generate a session via `supabase.auth.admin.generateLink` or similar.

---

## Bug 39: `MESSAGE_HISTORY` sent to Claude contains full message content — no size limit
- **Severity**: PERF
- **File**: server/ai-engine.ts:2830–2836
- **Description**: The conversation history sent to Claude includes the last 10 messages with their full `content` strings. If prior messages contain large amounts of text (e.g., a long document extraction reply, a detailed financial summary), the total context can easily exceed Claude's token limits or add significant latency/cost. There is no truncation of individual message content in the history.
- **Fix**: Truncate each history message's content to a maximum (e.g., 1000 chars): `content: msg.content.slice(0, 1000)` — or only send the last 4 messages (2 pairs) instead of 10.

---

## Bug 40: `processFileUpload` stores `document.fileData` in the `pendingExtraction.documentPreview.data` field — sends full base64 blob to client
- **Severity**: PERF
- **File**: server/ai-engine.ts:635
- **Description**: `pendingExtraction.documentPreview = { id: document.id, name: document.name, mimeType: document.mimeType, data: document.fileData }` — `document.fileData` can be up to 10MB of base64-encoded data. This is sent as part of the JSON response to the client on every upload. The client stores this in React state (via `setMessages`). For a batch of 5 × 5MB documents, this means 25MB of base64 data in the client's React state, causing significant memory pressure and slow renders.
- **Fix**: For the `pendingExtraction` object, only include the document ID and let the client fetch the file data from `/api/documents/:id/file` when it needs to display it. The `documentPreview` on the outer response (for inline display) is fine, but the pendingExtraction copy is redundant since the document is already stored server-side.

---

## Bug 41: `createScopedStorage` falls through to `getStorage()` (singleton) when env vars are missing
- **Severity**: SECURITY
- **File**: server/storage.ts:1700–1701
- **Description**: `createScopedStorage(userId)` falls back to `getStorage()` when `supabaseUrl || supabaseKey` is falsy (lines 1700–1701 comment: "SQLite fallback — global instance is fine for single-user local dev"). But `isSupabaseStorage()` always returns `true`, so auth IS enforced — yet if env vars are missing, `createScopedStorage` would return the singleton. This is dead code but it's misleading — the comment says SQLite fallback is removed, yet the code has a fallback path.
- **Fix**: Remove the fallback branch and throw an error if env vars are missing: `throw new Error("Supabase env vars required for scoped storage")`.

---

## Bug 42: `routes.ts` — `deleteDocument` returns 404 if Supabase `DELETE` matched 0 rows
- **Severity**: UX
- **File**: server/routes.ts:1065–1068
- **Description**: `app.delete("/api/documents/:id", ...)` calls `storage.deleteDocument(req.params.id)` and returns 404 if it returns `false`. In `supabase-storage.ts:1501`, the comment says "Supabase delete succeeds even if 0 rows matched — that's fine, doc is gone" — but it returns `true` in that case. However, if the user_id check fails (e.g., the document exists but belongs to another user), Supabase still returns no error (0 rows matched) and `deleteDocument` returns `true` — so the route returns 204 even though nothing was deleted. This means a user could attempt to delete another user's document and get a 204 success response (though the data is unaffected).
- **Fix**: Before deleting, check `await storage.getDocument(req.params.id)` to verify ownership (already protected by `user_id` filter in the storage layer), and return 404 if not found rather than relying on `deleteDocument`'s return value.

---

## Summary

| Severity | Count |
|----------|-------|
| CRASH    | 3     |
| DATA     | 14    |
| UX       | 10    |
| PERF     | 10    |
| SECURITY | 5     |
| **Total**| **42**|

### Critical priority fixes (CRASH/SECURITY/DATA):
1. **Bug 1** — Auth middleware `next()` inside async context (CRASH)
2. **Bug 3** — Query client missing auth headers (SECURITY)
3. **Bug 13** — `getProfileDetail` mutates orphaned profiles in-memory (DATA)
4. **Bug 15** — `deleteProfile` name-based obligation matching (DATA)
5. **Bug 17** — Duplicate calendar events for obligations (DATA)
6. **Bug 7** — `sync_calendar` blocks event loop with `execSync` (PERF/CRASH)
7. **Bug 22** — Extraction confirmation marks success before server confirms (UX/DATA)
8. **Bug 38** — Admin key used for `signInWithPassword` (SECURITY)
