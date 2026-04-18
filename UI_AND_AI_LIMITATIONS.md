# Portal — What Doesn't Work (UI + AI Chat) and How to Fix It

Plain-English checklist. Copy/paste ready. Based on the existing audit docs
(`PRODUCTION_AUDIT.md`, `QA_AUDIT_REPORT.md`, `REMEDIATION_AUDIT.md`,
`audit-findings.md`, `AUDIT_FIXES.md`) plus a fresh pass over the code.

---

## PART 1 — FRONT-END UI: BUTTONS / FORMS THAT DON'T WORK PROPERLY

These are places the UI *looks* like it works but silently fails, eats bad
input, or gives no feedback.

### Dashboard (`client/src/pages/dashboard.tsx`)
- [ ] **Weight entry** accepts negative numbers and absurd values. No toast, no
      error. Fix: add Zod schema + toast; block values < 0 or > 2000 lbs.
- [ ] **Add Expense** accepts negative amounts silently. Fix: client-side
      validation, min=0.01, currency format check, show toast on error.
- [ ] **Goal progress update** accepts zero/negative targets and lets progress
      exceed the target. Fix: enforce `target > 0`, cap progress at target, show
      "Goal reached" state.
- [ ] **Add Task** submits with an empty title and does nothing visible. Fix:
      disable submit until title is non-empty, red outline + toast on submit.
- [ ] **Journal entry** saves with empty body / no mood. Fix: require content
      OR mood, show inline error.
- [ ] **Notification badge dismissals** reset on reload (session-only). Fix:
      persist dismissed IDs server-side or in localStorage with a TTL.

### Trackers (`client/src/pages/trackers.tsx`)
- [ ] **Create Tracker** lets you submit with an empty name; server rejects but
      UI shows no reason. Fix: client validation + toast.

### Habits (`client/src/pages/habits.tsx` ~L424)
- [ ] **Create Habit** does not validate name is non-empty before POST.
- [ ] **"Custom" frequency option** appears in UI but isn't implemented in the
      backend — selecting it silently falls back. Fix: either implement custom
      cron-style cadence or hide the option.
- [ ] **Habits have no profile linking** at all (column exists, unused). Fix:
      add junction table entries on create/update and surface in profile detail.

### Profiles (`client/src/pages/profiles.tsx`)
- [ ] **Email field** accepts anything (no format check).
- [ ] **Phone field** accepts letters/symbols.
- [ ] **Date-of-birth** accepts impossible dates (e.g. Feb 30).
- [ ] **Blood type** is a free text field that accepts garbage.
- Fix: swap to Zod + react-hook-form with proper input masks.

### Settings (`client/src/pages/settings.tsx`)
- [ ] **Dark-mode toggle** (~L59) is async but has no spinner and no error
      handling — if the save fails the UI shows the new state anyway.
- [ ] **Export / Import** buttons (~L596–617) are gated by `exporting` /
      `importing` flags that don't reliably reset on error → button stuck
      disabled after a failed export. Fix: wrap in try/finally and add toasts.

### Finance / Expenses
- [ ] Same validation gaps as dashboard (negative amounts, empty vendor,
      wrong date formats).

### Misc routes
- [ ] `POST /api/trackers/migrate-to-self` (`server/routes.ts:1385`) is an
      internal migration hook exposed without proper gating / error surfacing.
- [ ] `DELETE /api/tracker-entries/:entryId` vs
      `DELETE /api/trackers/:id/entries/:entryId` (`routes.ts:1358–1376`) are
      duplicate endpoints — pick one and remove the other.

---

## PART 2 — WHAT THE AI CHAT CAN'T DO (ACTING LIKE AN MCP SERVER)

You're right: the chat talks about doing things and returns a plan, but
several tools either don't execute, execute partially, or are short-circuited
before the AI even sees the request. Details below.

### A. Tools that are declared but don't fully execute
| Tool | Promises | Reality | File |
|---|---|---|---|
| `upload_document` | "Upload a document" | Returns a text hint telling the user to click the attachment button. Does nothing. | `server/ai-engine.ts` |
| `navigate` | "Go to page X" | Returns `{ navigateTo: page }`; the frontend has to handle it, and not every page is wired. | `server/ai-engine.ts` |
| `sync_calendar` | "Pull from Google Calendar" | Calls an `external-tool` CLI that is not guaranteed to exist → fails silently. | `server/ai-engine.ts:4398` |
| `create_domain` | "Create a custom tracking domain" | Inserts a row; schema fields not validated, UI doesn't refresh. | `server/ai-engine.ts` |
| `generate_chart` | "REAL VISUAL CHART" | Returns a spec only; frontend renderer is partial. | `server/ai-engine.ts` |
| `generate_report` | "Comprehensive report" | Returns a spec; PDF/export pipeline incomplete. | `server/ai-engine.ts` |
| `recall_actions` | "Last N actions" | Works, but the action log is a module-level in-memory cache → wiped on deploy/restart. | `server/ai-engine.ts` |
| `revalue_asset` | "Re-estimate value" | Uses `webSearch()` which returns `""` on failure; estimate becomes garbage. | `server/ai-engine.ts` |

### B. Fast-path regex hijacks commands that need the AI
`server/ai-engine.ts:5546–5700` pre-matches messages and skips Claude entirely.
That's why the chat feels like an "MCP server that only pattern-matches."
- `"$40 on gas"` → instant expense, **AI never runs** → no category inference,
  no profile linking.
- `"remind me to call Mom Friday"` → instant task, **date extraction skipped**.
- `"$60 per month for gym"` → created as one-time expense, not a recurring
  obligation.
- `"$25 dinner + schedule event for 7pm"` → only the expense is created; the
  event request is dropped.
- **Fix:** either remove the fast-path or make it a pre-pass that augments
  (not replaces) the AI call.

### C. Profile linking is inconsistent across entity types
Root cause (from `audit-findings.md` D-1): `getTasks`, `getExpenses`,
`getEvents` do **not** read the junction tables — they only read the JSONB
`linked_profiles` column. `getTrackers` was fixed but the others weren't.
Result:
- AI says "added expense for Mom" — junction row written correctly.
- Mom's profile page reads from junction → shows it. ✅
- The global expenses list reads JSONB → sometimes missing. ❌
- `get_summary` tool reads the list view → returns the wrong count. ❌
- **Fix:** copy the `getTrackers` enrichment pattern into `getTasks`,
  `getExpenses`, `getEvents` in `server/supabase-storage.ts:1163–1338`.

### D. Deduplication logic is too aggressive
- Task dedup is title-only (`ai-engine.ts:2393`). "Vet appointment for Mom"
  and "Vet appointment for Rex" → 2nd one silently rejected.
- In-memory expense dedup (`ai-engine.ts:2599`) ignores profile.
- Tracker-entry dedup uses a 5-min DB window vs 2-min AI window → overlapping
  logic produces unpredictable drops.
- **Fix:** include profile id (and amount for expenses) in the dedup key.

### E. Event linking lands on the wrong profile
`ai-engine.ts:2697–2724` links the event before creation, then `resolveForProfile`
runs again on the title string. If the title contains another profile's name,
the event gets attached to that person.
- "Create event 'Meet Craig' for Mom" → lands on Craig. ❌
- **Fix:** skip post-creation re-linking when a profile was explicitly passed.

### F. Expense dedup timezone bug
`ai-engine.ts:2606–2612` compares `expense.date` (user-facing date string) to
`Date.now()` (UTC ms). Same-day expenses sometimes get wrongly flagged or
missed depending on timezone. **Fix:** normalize both sides to the same
timezone-aware date.

### G. Other known AI-chat limits
- No undo for destructive tools (delete profile / delete tracker is final).
- No streaming partial results to the UI for long tool chains.
- No pagination on `/api/trackers`, `/api/tasks`, `/api/expenses` — the AI
  summary tool loads everything into memory and will OOM around ~1000 rows.
- Documents are stored as base64 inside a JSONB column (~13 MB per 10 MB
  file). No Supabase Storage migration. The `upload_document` tool has no
  safe path to hand off large files.
- Rate limiter falls back to IP if auth header is missing → users on the same
  network share limits.

### H. What the AI chat *does* do well (not broken)
- Tool-calling loop with the Anthropic SDK works end-to-end.
- 50+ tool schemas wired up.
- Multi-step tool chains (5+ calls per message) execute.
- Document OCR / vision two-pass extraction works.
- Auto-create tracker on first entry works.
- Query tools (`search`, `get_profile_data`, `query_calendar`,
  `query_expenses`) work.
- Per-request scoped storage (AsyncLocalStorage) keeps tenants isolated.
- TanStack Query invalidation refreshes the UI after tool calls.

---

## PART 3 — SOLUTIONS, PRIORITIZED

### CRITICAL (ship-blocking) — ~11 hours
1. **Junction-table reads for tasks/expenses/events** — `supabase-storage.ts:1163–1338`. ~3h.
2. **Remove / redesign fast-path regex** so the AI sees the message. `ai-engine.ts:5546`. ~6h.
3. **Profile-aware dedup** for tasks + expenses. `ai-engine.ts:2393, 2599`. ~2h.

### HIGH — ~18 hours
4. **Client-side validation** on all forms (Zod + react-hook-form + toasts). ~8h.
5. **Pagination** on `/api/trackers`, `/api/tasks`, `/api/expenses`. ~8h.
6. **Event double-linking fix** — skip re-link when profile was passed. ~1h.
7. **Expense dedup timezone fix.** ~1h.

### MEDIUM — ~15 hours
8. **Persist notification dismissals.** ~2h.
9. **Habit → profile linking** (migration + create/update hooks). ~4h.
10. **Delete 5000 lines of unused registry code** (or actually wire it). ~4h.
11. **Wire `generate_chart` / `generate_report` renderers** in the frontend. ~5h.

### LOW — ~12 hours
12. **Real `upload_document` tool** via Supabase Storage. ~6h.
13. **Undo for destructive actions** (soft-delete + 30-day trash). ~4h.
14. **Persist `recall_actions` log** to the DB. ~2h.

---

## PART 4 — HOW FAR FROM PRODUCTION

Current score per `PRODUCTION_AUDIT.md`: **4 / 10**.

- **To "launchable" (7/10):** fix the CRITICAL + HIGH list above. **≈ 32 hours
  of focused work** (roughly 4 working days for one engineer).
- **To "production-hardened" (9/10):** add the MEDIUM + LOW items plus tests,
  error monitoring (Sentry), load testing, and a backup strategy. **≈ 80
  hours** (2 weeks for one engineer).
- **Biggest single unlock:** fixing the fast-path + junction-table reads.
  Those two alone move the AI from "acts like an MCP server that only
  pattern-matches" to "actually reasons and writes consistent data."
