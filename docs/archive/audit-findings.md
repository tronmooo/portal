# Portol AI Data Flow Audit — Deep Findings

**Date:** 2026-04-07  
**Scope:** ai-engine.ts, supabase-storage.ts, routes.ts  
**Core complaint:** "The extraction works perfectly, the AI tells you exactly what it processed, but the data doesn't display correctly."

---

## Category A: AI Says It Saved Data But Tool Execution Silently Fails

### A-1. `create_expense` dedup compares `e.date` against `Date.now()` — wrong time domain
**File:** `ai-engine.ts`, lines 2606–2612  
**Bug:** The dedup check does:
```js
const twoMinAgoExp = Date.now() - 120000;
const dupExpense = allExpenses.find(e => {
  if (new Date(e.date).getTime() < twoMinAgoExp) return false;
  ...
});
```
But `e.date` is the **expense date** (e.g., `"2026-04-07"` — a calendar date, not a creation timestamp), while `twoMinAgoExp` is based on `Date.now()`. The `new Date("2026-04-07")` parses to midnight UTC, which is always many hours before `Date.now()`. For **future-dated** expenses, the check works by accident. For expenses with today's date in certain timezones, or any past date, `new Date(e.date).getTime() < twoMinAgoExp` is always `true`, so the dedup never fires. For expenses where the date is **today** in UTC, the dedup could **incorrectly skip valid expenses** that happen to share the same amount and similar description, because the date parses close to `Date.now()`.

**Impact:** Low — but the logic is fundamentally broken. It should compare `e.createdAt` (the insertion timestamp), not `e.date` (the user-facing expense date).

**Fix:** Change to:
```js
const dupExpense = allExpenses.find(e => {
  if (new Date(e.createdAt).getTime() < twoMinAgoExp) return false;
  ...
});
```

### A-2. `log_tracker_entry` dedup also uses `e.timestamp` but against tracker entries (correct here)
**File:** `ai-engine.ts`, lines 2506–2518  
**Status:** This one is correct — `e.timestamp` on tracker entries IS the creation time. No bug.

### A-3. `executeTool` returns `{ error: "..." }` objects that AI may misinterpret as success
**File:** `ai-engine.ts`, lines 2283–2288 / 4283–4290  
**Bug:** When tools return `{ error: "Duplicate task detected — skipped" }` (line 2404) or `{ error: "Invalid expense amount..." }` (line 2594), the `processMessage` loop checks `result !== null && result !== undefined` (line 4284). Since `{ error: "..." }` is a truthy non-null object, `isSuccess` is `true`. The AI receives the result as a successful tool call with an `error` field it *might* notice — but it's not guaranteed. The AI can then tell the user "I created your expense" when it was actually skipped.

**Impact:** Medium — The AI may report success for deduplicated/rejected operations. The `summarizeResult` function at line 4288 will serialize the `{ error: "..." }` object and the AI *could* read it, but it's presented as a success, not a failure.

**Fix:** In `processMessage`, check for `result.error`:
```js
const isSuccess = result !== null && result !== undefined && !result.error;
```

### A-4. `processFileUpload` auto-creates expenses from documents without proper error surfacing
**File:** `ai-engine.ts`, lines 752–787  
**Bug:** When a document has a dollar amount, an expense is auto-created (line 763). If `storage.createExpense` throws, the error is caught silently at line 786 (`console.error`) but the user's reply at line 874 may still say "Auto-saved: ..." because `savedItems` could already have entries from other operations (tracker entries, for example). However, the expense-specific `savedItems.push` at line 782 only runs on success, so this specific path is OK.

**Status:** The expense auto-creation path is correctly guarded. No data loss here.

### A-5. `logEntry` in supabase-storage.ts returns `undefined` on dedup — caller doesn't check
**File:** `supabase-storage.ts`, lines 1122–1128  
**Bug:** When the dedup check finds an existing entry, it tries to return the existing row:
```js
const existing = recentEntries.data.find(...);
return existing ? this.rowToTrackerEntry(existing) : undefined;
```
If `this.rowToTrackerEntry` fails or the find doesn't match (race condition where the stringified comparison differs), it returns `undefined`. Back in `ai-engine.ts` line 2519, the caller does `const entry = await storage.logEntry(...)` and returns `entry` to the AI. If `entry` is `undefined`, `processMessage` at line 4284 marks it as a failure (`isSuccess = false`), which is correct behavior. But `autoUpdateGoalProgress` at line 2522 runs unconditionally regardless.

**Impact:** Low — goal progress updates may fire for deduplicated entries.

---

## Category B: Data Is Saved to DB But with Wrong Profile Linking

### B-1. `create_event` double-links: resolves profile before AND after creation
**File:** `ai-engine.ts`, lines 2697–2724  
**Bug:** The event creation flow:
1. Lines 2698–2703: Resolves `eventLinkedProfiles` from `input.forProfile` **before** creating the event
2. Line 2705: Creates event with `linkedProfiles: eventLinkedProfiles`
3. Lines 2722–2724: Calls `resolveForProfile` and `directLinkToProfile` **again** after creation

This means the event is linked twice through different code paths. `directLinkToProfile` (line 2723) calls `updateEntityLinkedProfiles` which does `linkProfileTo` — both of which are also called by `storage.createEvent` internally (line 1366–1368 in supabase-storage.ts). While this is idempotent (upsert), it's 3-4x redundant DB writes.

Worse, the post-creation `resolveForProfile` scans **all text** including the title and description. If the title mentions a **different** profile name than `forProfile`, the event gets linked to the wrong profile. Example: "Create an event 'Meet with Craig' for Mom" → `forProfile` = "Mom", but `resolveForProfile` sees "Craig" in the title and returns "Craig", then `directLinkToProfile` links to Craig.

**Impact:** Medium — Events can get linked to wrong profiles when the title mentions other people's names.

**Fix:** Skip the post-creation `resolveForProfile`/`directLinkToProfile` when `eventLinkedProfiles` was already resolved:
```js
if (eventLinkedProfiles.length === 0) {
  const evtForProfile = await resolveForProfile(input.forProfile, ...);
  const evtLinked = await directLinkToProfile("event", newEvent.id, evtForProfile);
  if (!evtLinked) await autoLinkToProfiles(...);
}
```

### B-2. `create_task` and `create_expense` don't have the same double-link issue (correct)
**File:** `ai-engine.ts`, lines 2406–2431 (task), 2636–2661 (expense)  
Both correctly skip `autoLinkToProfiles` when profiles were already resolved pre-creation:
```js
if (taskLinkedProfiles.length === 0) {
  await autoLinkToProfiles("task", newTask.id, input.title, input.forProfile);
}
```
**Status:** Correct pattern. Event should follow this same pattern.

### B-3. `resolveForProfile` returns the first non-self profile match by scan order, not relevance
**File:** `ai-engine.ts`, lines 3605–3616  
**Bug:** `resolveForProfile` iterates profiles in DB order and returns the **first** match. If you have profiles "Rex" and "Rex Jr.", the text "Rex Jr. needs a checkup" matches "Rex" first (because `text.toLowerCase().includes(p.name.toLowerCase())` — "rex jr. needs a checkup".includes("rex") is true).

**Impact:** Medium — Entities may link to the wrong profile when profile names are substrings of each other.

**Fix:** Sort by name length descending before scanning (longest match first):
```js
const sorted = profiles.filter(p => p.type !== 'self' && p.name.length >= 2)
  .sort((a, b) => b.name.length - a.name.length);
for (const p of sorted) { ... }
```

---

## Category C: Dedup Logic That Incorrectly Skips Valid Operations

### C-1. Task dedup is title-only, ignoring profile — blocks valid same-named tasks for different profiles
**File:** `ai-engine.ts`, lines 2393–2405  
**Bug:** The task dedup checks:
```js
const dupTask = existingTasks.find(t =>
  t.status !== "done" &&
  t.title.toLowerCase().trim() === (input.title || "").toLowerCase().trim()
);
```
This is purely title-based. If you say "Create task 'Vet appointment' for Rex" and there's already an active task "Vet appointment" for Mom, the second task is silently skipped and the existing (wrong) task is returned.

The in-memory dedup at line 2401 has the same issue: `task:${safeLC(input.title)}` doesn't include profile info.

**Impact:** High — Legitimate tasks for different profiles get silently dropped. The AI tells the user "Created task 'Vet appointment' for Rex" but actually returned Mom's task.

**Fix:** Include profile in dedup key:
```js
const dupTask = existingTasks.find(t =>
  t.status !== "done" &&
  t.title.toLowerCase().trim() === (input.title || "").toLowerCase().trim() &&
  (taskLinkedProfiles.length === 0 || t.linkedProfiles.some(p => taskLinkedProfiles.includes(p)))
);
const taskDedupKey = `task:${safeLC(input.title)}:${taskLinkedProfiles.join(",")}`;
```

### C-2. In-memory expense dedup doesn't include profile
**File:** `ai-engine.ts`, lines 2599–2604  
**Bug:** `expDedupKey = expense:${safeLC(input.description)}:${parsedAmount}:${input.date || ""}` — no profile component. If you rapidly log "$50 Dog food" for Rex and then "$50 Dog food" for Luna, the second is blocked.

**Impact:** Medium — Same-named expenses for different profiles within 30s window get dropped.

**Fix:** Include `input.forProfile` in the dedup key.

### C-3. Tracker entry dedup is overly strict with 5-minute window in DB (supabase-storage.ts)
**File:** `supabase-storage.ts`, lines 1109–1128  
**Bug:** The DB-level dedup uses a 5-minute window and compares stringified `entry_values`. This runs **after** value normalization (line 1106). The ai-engine.ts has its own 2-minute dedup (line 2507). These two windows overlap but differ, creating confusing behavior. Within 2–5 minutes, the AI-level dedup passes but the DB-level dedup blocks.

**Impact:** Low — Users who log the same metric twice within 5 minutes (e.g., correcting a value) silently get the old value back.

### C-4. `logEntry` DB dedup compares raw `entry_values` but normalization may reorder keys
**File:** `supabase-storage.ts`, lines 1119–1121  
**Bug:** `JSON.stringify(e.entry_values) === JSON.stringify(values)` — JSON.stringify is key-order-dependent. If the DB stores `{"calories": 500, "_notes": "lunch"}` but the new values object has `{"_notes": "lunch", "calories": 500}`, the stringify comparison fails and the dedup doesn't fire. This means the dedup is unreliable in both directions — it may miss true duplicates and (less likely) flag non-duplicates.

**Impact:** Low — Dedup is inconsistent.

**Fix:** Use a canonical comparison: `JSON.stringify(Object.entries(e.entry_values).sort()) === JSON.stringify(Object.entries(values).sort())`

---

## Category D: Data Is in DB But API Response Doesn't Include It (Serialization Gaps)

### D-1. **CRITICAL:** `getExpenses()`, `getTasks()`, `getEvents()` do NOT enrich `linkedProfiles` from junction tables
**File:** `supabase-storage.ts`, lines 1163–1167 (getTasks), 1226–1230 (getExpenses), 1334–1338 (getEvents)  
**Bug:** `getTrackers()` was fixed (lines 979–1008) to query the `profile_trackers` junction table and merge those profile IDs with the JSONB `linked_profiles` column. **But `getTasks()`, `getExpenses()`, and `getEvents()` still only read from the JSONB column:**

```js
// getTasks - line 1163
async getTasks(): Promise<Task[]> {
  const { data, error } = await this.supabase.from("tasks").select("*").eq("user_id", this.userId)...;
  return (data || []).map(r => this.rowToTask(r));
}

// rowToTask - line 232
private rowToTask(r: any): Task {
  return { ...linkedProfiles: r.linked_profiles || [] ... };
}
```

Meanwhile, `linkProfileTo` writes to **both** the junction table AND the JSONB column (lines 798–826). So if the JSONB write fails (e.g., race condition, concurrent update clobbers it), the junction table has the correct data but the JSONB column doesn't, and `getTasks/getExpenses/getEvents` will return stale/missing `linkedProfiles`.

More importantly, the `getProfileDetail` method (lines 382–457) uses junction tables as source of truth for what items belong to a profile. So the **profile detail page** shows the correct linked items, but the **list views** (tasks list, expenses list, events list) that filter by profile use the JSONB column and may miss items.

**This is THE bug.** The AI correctly links data via both junction table and JSONB, the profile detail page correctly shows it via junction table lookups, but list/summary views read only from JSONB and can be stale.

**Impact:** CRITICAL — This is the root cause of "data doesn't display correctly." When filtering by profile, `getTasks().filter(t => t.linkedProfiles.includes(profileId))` may return incomplete results because `linkedProfiles` is sourced from the potentially-stale JSONB column.

**Fix:** Apply the same junction table enrichment pattern from `getTrackers()` to `getTasks()`, `getExpenses()`, and `getEvents()`:

```typescript
async getTasks(): Promise<Task[]> {
  const [tasksResult, junctionResult] = await Promise.all([
    this.supabase.from("tasks").select("*").eq("user_id", this.userId).is("deleted_at", null).order("created_at", { ascending: false }),
    this.supabase.from("profile_tasks").select("task_id, profile_id").eq("user_id", this.userId),
  ]);
  if (tasksResult.error) throw tasksResult.error;
  const profilesByTask = new Map<string, string[]>();
  for (const j of junctionResult.data || []) {
    const arr = profilesByTask.get(j.task_id) || [];
    arr.push(j.profile_id);
    profilesByTask.set(j.task_id, arr);
  }
  return (tasksResult.data || []).map(r => {
    const junctionProfiles = profilesByTask.get(r.id) || [];
    const jsonbProfiles: string[] = r.linked_profiles || [];
    const mergedProfiles = [...new Set([...junctionProfiles, ...jsonbProfiles])];
    return this.rowToTask({ ...r, linked_profiles: mergedProfiles });
  });
}
// Same pattern for getExpenses() and getEvents()
```

### D-2. `getTracker()` (singular) does NOT enrich from junction table
**File:** `supabase-storage.ts`, lines 1011–1016  
**Bug:** `getTracker(id)` reads directly from the `trackers` table without querying `profile_trackers`. So it may return stale `linkedProfiles` compared to `getTrackers()` (plural) which enriches correctly. `getTracker` is called by:
- `logEntry` (line 1068) — to find the tracker
- `updateTracker` (line 1055) — to get current state
- `updateEntityLinkedProfiles` → tracker case (line 3841) — to check current links

**Impact:** Medium — `updateEntityLinkedProfiles` reads via `getTracker()` and may not see junction-table-only profiles, leading to redundant or missed JSONB updates.

**Fix:** Add junction table query to `getTracker()`:
```typescript
async getTracker(id: string): Promise<Tracker | undefined> {
  const [dataResult, entriesResult, junctionResult] = await Promise.all([
    this.supabase.from("trackers").select("*").eq("id", id).eq("user_id", this.userId).single(),
    this.supabase.from("tracker_entries").select("*").eq("tracker_id", id).eq("user_id", this.userId).order("timestamp", { ascending: true }),
    this.supabase.from("profile_trackers").select("profile_id").eq("tracker_id", id).eq("user_id", this.userId),
  ]);
  if (dataResult.error || !dataResult.data) return undefined;
  const junctionProfiles = (junctionResult.data || []).map(j => j.profile_id);
  const jsonbProfiles = dataResult.data.linked_profiles || [];
  const merged = [...new Set([...junctionProfiles, ...jsonbProfiles])];
  return this.rowToTracker({ ...dataResult.data, linked_profiles: merged }, (entriesResult.data || []).map(e => this.rowToTrackerEntry(e)));
}
```

### D-3. `get_summary` tool in AI reads from `getExpenses()`, `getTasks()`, `getEvents()` — all stale
**File:** `ai-engine.ts`, lines 2172–2188  
**Bug:** The `get_summary` tool calls `storage.getTasks()`, `storage.getExpenses()`, `storage.getEvents()` and then filters by `filterProfileId`. Since these methods don't enrich from junction tables (Bug D-1), the summary will under-report items for a given profile.

**Impact:** High — AI gives incorrect counts and lists when asked "show me Rex's expenses" or "what tasks does Mom have."

---

## Category E: Junction Table vs JSONB Sync Issues

### E-1. `linkProfileTo` does junction+JSONB write but NOT atomically
**File:** `supabase-storage.ts`, lines 798–826  
**Bug:** `linkProfileTo` writes to the junction table first (line 801), then reads the entity's JSONB (line 817–818), then updates JSONB (line 822). These are 3 separate DB calls. If the process crashes between the junction write and the JSONB update, or if two concurrent `linkProfileTo` calls race:

1. Call A reads JSONB: `[profileA]`
2. Call B reads JSONB: `[profileA]`
3. Call A writes JSONB: `[profileA, profileB]`
4. Call B writes JSONB: `[profileA, profileC]` ← profileB is lost!

The junction table uses `upsert` so it's safe from races. But the JSONB column is vulnerable to lost updates.

**Impact:** Medium — Concurrent profile linking can lose JSONB entries. Since junction tables are the source of truth (for trackers, and should be for everything else per D-1 fix), this becomes less critical once D-1 is fixed. But currently, with tasks/expenses/events reading only from JSONB, this is a real data loss path.

**Fix:** Use a Postgres atomic update:
```sql
UPDATE tasks SET linked_profiles = linked_profiles || '["newProfileId"]'::jsonb
WHERE id = :id AND user_id = :userId
AND NOT linked_profiles @> '["newProfileId"]'::jsonb
```
Or better: deprecate JSONB reads entirely (fix D-1) and treat junction table as sole source of truth.

### E-2. `updateEntityLinkedProfiles` duplicates `linkProfileTo` work
**File:** `ai-engine.ts`, lines 3825–3904  
**Bug:** `updateEntityLinkedProfiles` reads the entity via `getTasks/getExpenses/getEvents`, pushes the profile ID, and calls `updateTask/updateExpense/updateEvent` — which writes the full JSONB. Meanwhile, the caller also calls `linkProfileTo` which writes to both junction table AND JSONB. This is double-writing the JSONB column. With concurrent calls, the race condition from E-1 is amplified.

At line 3836–3837, `updateEntityLinkedProfiles` also calls `linkProfileTo` itself:
```js
try { await storage.linkProfileTo(profileId, entityType, entityId); } catch (e: any) { /* dup OK */ }
```
So the call chain is often: caller → `linkProfileTo` + `updateEntityLinkedProfiles` → which also calls `linkProfileTo`. Triple-write.

**Impact:** Low (since it's idempotent in the happy path) but increases race window for E-1.

**Fix:** Remove `updateEntityLinkedProfiles` entirely once D-1 fix is in place. `linkProfileTo` handles both junction and JSONB. Or make `updateEntityLinkedProfiles` only call `linkProfileTo` without its own JSONB manipulation.

### E-3. `createTask`/`createExpense`/`createEvent` in supabase-storage.ts write JSONB on insert, then `linkProfileTo` in a loop
**File:** `supabase-storage.ts`, lines 1184–1194 (createTask), 1247–1258 (createExpense), 1355–1368 (createEvent)  
**Bug:** The pattern is:
1. Insert row with `linked_profiles: linkedProfiles` (JSONB)
2. Loop: `await this.linkProfileTo(pId, "task", id)` — which writes to junction table AND re-reads/re-writes JSONB

Step 2 is redundant for JSONB since step 1 already set it. But it's necessary for the junction table. This is correct but wasteful. More importantly, the ai-engine.ts `create_task` tool (line 2426) does **another** `linkProfileTo` loop after `storage.createTask` returns — meaning each profile gets `linkProfileTo` called twice.

**Impact:** Low — Performance waste (2x junction + JSONB writes per profile per creation).

---

## Category F: Extraction Confirmation Flow Gaps

### F-1. `confirm-extraction` creates trackers via `updateTracker` for linking — bypasses junction table
**File:** `routes.ts`, lines 554–558  
**Bug:** When creating trackers from extraction confirmation:
```js
await storage.updateTracker(tracker.id, { linkedProfiles: [resolvedProfileId] } as Partial<Tracker>);
```
This updates the JSONB `linked_profiles` on the tracker row. But it does NOT write to the `profile_trackers` junction table. Since `getTrackers()` merges from both sources, this works for now. But if JSONB is ever deprecated in favor of junction-only reads, these tracker links will be lost.

The `processFileUpload` function has the same issue at line 814:
```js
await storage.updateTracker(tracker.id, { linkedProfiles: [existingProfileId] } as any);
```

**Impact:** Medium — Extraction-created trackers rely on JSONB for profile linking, not junction table. If a sync operation cleans JSONB, these links are lost.

**Fix:** After `updateTracker`, also call `storage.linkProfileTo(resolvedProfileId, "tracker", tracker.id)`.

### F-2. `confirm-extraction` tracker entries don't pass `forProfile`
**File:** `routes.ts`, lines 564–568  
**Bug:** When logging tracker entries from extraction confirmation:
```js
await storage.logEntry({
  trackerId: tracker.id,
  values: entryValues,
  notes: `From document extraction`,
});
```
Notice: no `forProfile` field. In `logEntry` (supabase-storage.ts line 1138), `for_profile` defaults to `null`. This means tracker entries from document extraction aren't tagged with the profile they belong to. If a tracker is shared or the `for_profile` column is ever used for filtering, these entries will be orphaned.

**Impact:** Low currently, but creates a data hygiene issue.

**Fix:** Pass `forProfile: resolvedProfileId` in the logEntry call.

### F-3. `confirm-extraction` calendar events are created via `storage.createEvent` — which auto-links to self
**File:** `routes.ts`, lines 504–520  
**Status:** Calendar events from extraction correctly pass `linkedProfiles: resolvedProfileId ? [resolvedProfileId] : []` and `storage.createEvent` auto-links to self if empty. This is correct.

### F-4. `processFileUpload` creates trackers/entries immediately but profile fields wait for confirmation
**File:** `ai-engine.ts`, lines 736–738 (profile fields deferred), lines 794–824 (trackers immediate)  
**Bug:** There's an asymmetry: extracted **profile fields** (name, address, license number) are deferred to confirmation flow (correct, per M-4 fix comment at line 736). But **tracker entries** from lab results and **expenses** from dollar amounts are auto-saved immediately without user confirmation.

If the AI misreads a lab value (e.g., reads glucose as 500 instead of 50), a tracker entry with the wrong value is immediately persisted. The user sees the pending extraction UI with field checkboxes, but the tracker entries are already saved — there's no way to reject them.

**Impact:** Medium — Incorrectly extracted lab values and expense amounts are auto-persisted without user review. The user may not realize the tracker data is wrong.

**Fix:** Defer tracker entry creation to the `confirm-extraction` endpoint, same as profile fields. The extraction review UI should show tracker entries as confirmable items.

---

## Priority-Ordered Fix Plan

### P0 — Critical (Fix immediately)
1. **D-1:** Add junction table enrichment to `getTasks()`, `getExpenses()`, `getEvents()` — same pattern as `getTrackers()`. This is the root cause of "data doesn't display correctly."

### P1 — High (Fix this week)
2. **C-1:** Add profile-awareness to task dedup logic
3. **B-1:** Fix event double-linking — skip post-creation resolveForProfile when pre-creation already resolved
4. **A-3:** Check for `result.error` in processMessage to mark failed tools correctly
5. **D-2:** Add junction table enrichment to `getTracker()` (singular)

### P2 — Medium (Fix soon)
6. **B-3:** Sort profiles by name length in `resolveForProfile` to prefer longest match
7. **E-1:** Use atomic Postgres JSONB append in `linkProfileTo` or deprecate JSONB reads
8. **F-1:** Add `linkProfileTo` calls in confirm-extraction tracker creation
9. **C-2:** Add profile to expense in-memory dedup key
10. **F-4:** Defer auto-created tracker entries to confirmation flow

### P3 — Low (Cleanup)
11. **A-1:** Fix expense dedup to compare `createdAt` not `date`
12. **C-4:** Fix JSON.stringify key-order sensitivity in tracker entry dedup
13. **E-2:** Remove redundant `updateEntityLinkedProfiles` calls once junction tables are source of truth
14. **E-3:** Remove redundant double-`linkProfileTo` in create flows
15. **F-2:** Pass `forProfile` in confirm-extraction logEntry calls

---

## Summary

The **single most impactful bug** is **D-1**: `getTasks()`, `getExpenses()`, and `getEvents()` don't enrich `linkedProfiles` from junction tables like `getTrackers()` was fixed to do. This means:

- The AI correctly writes profile links to both junction table and JSONB
- Profile detail pages use junction tables (correct data)
- List views, summaries, and profile-filtered queries use JSONB only (potentially stale data)
- The AI reports correct results (it reads the just-created data), but the frontend list views show incomplete data

This perfectly explains the user's complaint: "The AI tells you exactly what it processed, but the data doesn't display correctly."
