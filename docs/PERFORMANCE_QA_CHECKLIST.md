# Portal Performance QA Checklist

Pass/fail audit sheet for app-wide responsiveness. Covers every route, every
mutation, every modal, and every cross-page propagation path — not just page
load. Print one copy per audit run; fill in **Actual**, **Pass/Fail**, and
**Bug notes** for every row.

> **Spreadsheet version:** `docs/PERFORMANCE_QA_CHECKLIST.xlsx` — same rows,
> one tab per route, with auto pass/fail formulas and a Summary tab that rolls
> up live fail counts per tab. Prefer it for actual audit runs; this markdown
> file is the canonical spec for the targets.

- **Audit date:** ____________
- **Auditor:** ____________
- **Build/commit:** ____________
- **Device + viewport:** ____________ (run once at mobile width ≤ 430px, once at desktop width ≥ 1280px)
- **Network profile:** ____________ (run once on fast connection, once throttled)

How to measure: use the browser Performance panel or `performance.now()`
wrappers for exact numbers; for microinteractions a 240fps screen recording
scrubbed frame-by-frame is acceptable. "Actual" is the worst of 3 tries, not
the best.

---

## 1. Global performance standard (hard limits)

These apply on **every** route and interaction in the app. Core Web Vitals
thresholds (LCP ≤ 2.5s, INP < 200ms, CLS < 0.1) are the base layer.

| Area | Target | Fail if |
|---|---|---|
| Initial route load (LCP) | 2.0s ideal, 2.5s max | Main usable content appears after 2.5s |
| Interaction response (INP) | 100ms ideal, 200ms max | Click/tap/keypress feels delayed beyond 200ms |
| Layout stability (CLS) | < 0.1 | UI jumps while loading or after a mutation |
| Visible feedback after mutation | < 100ms | Button press gives no immediate visual feedback |
| Modal/pop-up open | 150ms ideal, 250ms max | Overlay appears sluggish after click |
| Tab switch | 150ms ideal, 250ms max | Tab content swap feels sticky |
| Drawer/side panel open-close | 150ms ideal, 250ms max | Panel animation or render is blocked |
| Search/filter typing | 50ms/keystroke ideal, 100ms max | Typing lags or drops characters |
| Chat send acknowledgment | 100ms ideal, 200ms max | Send click shows no immediate message state |
| Optimistic list update | < 100ms | Add/check/delete doesn't change the list right away |

App-wide invariants (fail = defect, no exceptions):

- [ ] No route requires a manual refresh after create, edit, delete, check-in, or payment.
- [ ] Every route opens with a visible shell immediately; data fills in progressively.
- [ ] Switching profiles, tabs, or filters never shows stale data from another entity.
- [ ] No blank white flash between screens; no spinner-only wait when a cached shell can render.
- [ ] Responsiveness holds under repeated use (5x rapid), not just first load.

---

## 2. Per-route audit sheet

Run this block for **each** route. Routes in scope (from `client/src/App.tsx`):

`/` (Chat) · `/dashboard` · `/trackers` · `/linked` (Assets) · `/liabilities` ·
`/profiles` (Info) · `/profiles/:id` (profile detail) · `/profiles/:id/info` ·
`/calendar` · `/tasks` · `/finance` · `/habits` · `/journal` ·
`/obligations` (+ `/bills`) · `/goals` · `/wellness` (+ `/health`) ·
`/insights` · `/artifacts` (Documents) · `/documents/:id` · `/editor/:id` ·
`/settings`

### Route: ____________

| # | Action | Ideal | Max | Actual | Pass/Fail | Bug notes |
|---|---|---:|---:|---:|---|---|
| R1 | Shell/skeleton visible after nav click | 100ms | 300ms | | | |
| R2 | First usable content (LCP) | 2.0s | 2.5s | | | |
| R3 | Data settled enough to use | 1.0s | 1.5s (heavy screens) | | | |
| R4 | Every sub-tab: content swap | 150ms | 250ms | | | |
| R5 | Every modal/sheet on this route: open | 150ms | 250ms | | | |
| R6 | Every modal/sheet: close (X and Escape) | 100ms | 200ms | | | |
| R7 | Every dropdown/menu/date-picker: open + selection applies | 100ms | 200ms | | | |
| R8 | Search/filter input on this route: per-keystroke | 50ms | 100ms | | | |
| R9 | Navigate away and back: no stale flash, state preserved | — | 0 stale frames | | | |
| R10 | Repeat primary action 5x fast: no jank, no dupes, no races | — | no regressions | | | |
| R11 | CLS during load and after mutations | — | < 0.1 | | | |
| R12 | Mobile-width rerun of R1–R11 | — | same limits | | | |

---

## 3. CRUD diagnostic (per entity)

Entity types in scope (from `shared/schema.ts`): **tasks, habits (+ check-ins),
expenses, income, obligations (bills / subscriptions / payments), liabilities,
calendar events, goals, journal entries, documents, artifacts
(notes / checklists / sheets), trackers (+ tracker entries), profiles
(person / pet / vehicle / property / account / medical / loan / investment /
asset), memories**, and every chat-created record of the above.

Timing standard for every CRUD flow:

| CRUD action | Ideal | Max |
|---|---:|---:|
| Open create modal/form | 150ms | 250ms |
| Save create — button feedback | < 100ms | 100ms |
| Save create — visible result in list | optimistic < 100ms | 500ms server-confirmed |
| Open edit form | 150ms | 250ms |
| Save edit — field updates | < 100ms | 500ms fully persisted |
| Delete confirm modal | 150ms | 250ms |
| Delete — visual removal | < 100ms | 500ms backend-confirmed |
| Cross-page propagation | < 1s | 2s hard max |

Functional sheet — run per entity:

### Entity: ____________

| # | Check | Actual (ms) | Pass/Fail | Bug notes |
|---|---|---:|---|---|
| C1 | Create from native UI | | | |
| C2 | Create from chat (where AI parity matrix says "covered"/"added") | | | |
| C3 | Edit title/name | | | |
| C4 | Edit metadata: amount, date, category, linked profile, notes | | | |
| C5 | Delete from detail view | | | |
| C6 | Delete from list/card row action | | | |
| C7 | Open item from dashboard/widget | | | |
| C8 | Open item from profile page | | | |
| C9 | Open item from linked/related page | | | |
| C10 | Item appears in search/filter results | | | |
| C11 | Item disappears **everywhere** after delete (lists, widgets, search, calendar) | | | |
| C12 | Counts, totals, badges, timeline widgets update immediately | | | |
| C13 | Edit persists after navigating away and back | | | |

Chat-vs-UI parity: `shared/ai-parity-matrix.ts` is the source of truth for
which entities support C2. A "covered"/"added" row that fails in chat is a
**P1**, same as a broken button.

---

## 4. Chat diagnostic

Chat is the primary surface (`/`), so it gets stricter limits than an admin
panel.

| # | Chat action | Ideal | Max | Actual | Pass/Fail | Bug notes |
|---|---|---:|---:|---:|---|---|
| CH1 | Focus composer | 50ms | 100ms | | | |
| CH2 | Typing latency | 16ms/frame | 100ms | | | |
| CH3 | Suggested prompt chip inserts text | 50ms | 100ms | | | |
| CH4 | Attachment picker opens | 150ms | 250ms | | | |
| CH5 | Send button reacts | 50ms | 100ms | | | |
| CH6 | User bubble appears (before server completes) | 50ms | 100ms | | | |
| CH7 | Assistant "thinking" state visible | 100ms | 200ms | | | |
| CH8 | Tool-result cards / extracted records render progressively | — | no blocking | | | |
| CH9 | Chat thread open | 300ms | 700ms | | | |
| CH10 | Chat-created item appears in its module without refresh | 500ms | 1s | | | |
| CH11 | Returning to chat restores thread from cache (no full reload) | 300ms | 700ms | | | |
| CH12 | Bulk "here's my day" multi-action message: all records land, UI stays responsive | — | no dropped actions | | | |

---

## 5. Navigation diagnostic

Test **everywhere** — every route transition, tab switch, sheet, and
back-navigation has its own SLA. Stale hydration and refetch waterfalls are the
known risk areas.

| # | Navigation action | Ideal | Max | Actual | Pass/Fail | Bug notes |
|---|---|---:|---:|---:|---|---|
| N1 | Main nav (sidebar/hub tab) click — visual response | 50ms | 100ms | | | |
| N2 | Route shell visible | 150ms | 300ms | | | |
| N3 | Route data settled (normal screen) | 700ms | 1s | | | |
| N4 | Route data settled (heavy: dashboard, finance, insights) | 1s | 1.5s | | | |
| N5 | Sub-tab switch inside a page (incl. query-param tabs, e.g. `/linked?tab=assets`) | 150ms | 250ms | | | |
| N6 | Profile-to-profile switch — no data from previous profile visible | 150ms | 250ms | | | |
| N7 | Open linked entity from a card | 150ms | 300ms | | | |
| N8 | Back from detail page — list state + scroll preserved | 100ms | 250ms | | | |
| N9 | Open settings / notifications / avatar menu | 100ms | 250ms | | | |
| N10 | Open + close drawers, overlays, full-screen dialogs (animation complete) | 150ms | 250ms | | | |
| N11 | Legacy alias routes resolve without 404 or double-render (`/bills`, `/health`, `/profile/:id`, `/dashboard/*` aliases) | — | no 404 | | | |
| N12 | Deep links with query strings match (`/tasks?new=1`, `/finance?new=expense`) | — | no 404 | | | |

---

## 6. Dashboard and sync diagnostic

History shows app-wide freshness/invalidation is the recurring bug class —
one action updating multiple downstream surfaces. Treat sync as a first-class
performance requirement.

After **any** mutation, verify every applicable row:

| # | Sync surface | Target | Actual | Pass/Fail | Bug notes |
|---|---|---|---:|---|---|
| S1 | Same-screen optimistic update | < 100ms | | | |
| S2 | Same-screen server-confirmed state | < 500ms | | | |
| S3 | Related widgets on same route | < 700ms | | | |
| S4 | Other cached routes invalidated/refreshed | < 1s | | | |
| S5 | Dashboard aggregate recompute visible (counts, totals, net worth) | < 1s | | | |
| S6 | Full system consistency after mutation | 2s hard max | | | |

Functional checks after each mutation:

- [ ] Dashboard counts update.
- [ ] Progress rings/bars update (habits, goals, budgets).
- [ ] Profile counters update.
- [ ] Calendar shows/removes the item if it is date-based (events, tasks, obligations, habit check-ins).
- [ ] Money totals update if the mutation affects finance (expenses, income, obligations, liabilities, net worth).
- [ ] Linked assets/relationships refresh correctly.
- [ ] Search results reflect the latest state.
- [ ] Filters do not show ghost records.
- [ ] Deleted records do not remain in any cached list.
- [ ] Returning to the same route does not flash stale old values first.
- [ ] Mutation is scoped to the correct profile — never leaks into another profile's views.

---

## 7. Pop-ups and microinteractions

Every bubble, opening, pop-up, click, and close action. Rubric (INP-aligned):

- **< 100ms** = excellent
- **100–200ms** = acceptable
- **200–300ms** = noticeable lag (P2)
- **> 300ms** = fail

| # | Microinteraction | Actual (ms) | Rating | Bug notes |
|---|---|---:|---|---|
| M1 | Tooltip opens | | | |
| M2 | Dropdown opens | | | |
| M3 | Dropdown selection applies | | | |
| M4 | Context menu opens | | | |
| M5 | Avatar menu opens | | | |
| M6 | Confirmation modal opens | | | |
| M7 | Sheet/drawer opens | | | |
| M8 | Date picker opens | | | |
| M9 | Quick-create FAB menu opens | | | |
| M10 | Chat suggestion bubble inserts text | | | |
| M11 | Toast appears after save/delete | | | |
| M12 | Close icon works instantly | | | |
| M13 | Escape key closes overlays instantly | | | |

---

## 8. QA pass/fail script (per screen)

The literal audit procedure for every screen. Real UI testing — layout checks,
API verification where needed, and recorded proof for fixes.

1. Open the route; measure shell render, first usable content, full data readiness (sheet §2).
2. Click every top-level nav item and time route response (sheet §5).
3. Open every tab and sub-tab and time the content swap.
4. Open every modal, pop-up, menu, drawer, and tooltip; time open **and** close (sheet §7).
5. Perform full CRUD for each entity shown on that route (sheet §3).
6. Verify immediate same-screen update (sheet §6, S1–S2).
7. Verify dashboard/profile/calendar/linked-view propagation where relevant (sheet §6, S3–S6).
8. Navigate away and back; confirm persistence and no stale-cache flash.
9. Repeat actions quickly 3–5 times to catch jank, duplicate records, and race conditions.
10. Rerun at mobile width and desktop width — responsiveness problems hide in one breakpoint.

---

## 9. Severity rules

Anything that slows trust, hides updates, or forces a manual refresh is a real
defect.

| Severity | Definition | Examples |
|---|---|---|
| **P0** | Data integrity broken | Data saved wrong, cross-profile leakage, delete fails, duplicate creation, wrong dashboard totals, wrong calendar writes |
| **P1** | Mutation succeeds but the user can't see it | UI doesn't update immediately, route shows stale data, chat-created item lands in the wrong place, modal hangs > 500ms |
| **P2** | Noticeable but non-blocking lag | Animation hitch, delayed badge count, dropdown sluggish > 200ms |
| **P3** | Cosmetic micro-jank | No data or usability impact |

**Release gate:** zero open P0/P1; P2 count trending down between runs; every
fail row in this document has a filed bug with a repro.

---

## 10. Run summary

| Route/module | Rows run | Fails | Worst offender | P0/P1 filed |
|---|---:|---:|---|---|
| Chat (`/`) | | | | |
| Dashboard | | | | |
| Trackers | | | | |
| Assets (`/linked`) | | | | |
| Liabilities | | | | |
| Info / Profiles | | | | |
| Profile detail | | | | |
| Calendar | | | | |
| Tasks | | | | |
| Finance | | | | |
| Habits | | | | |
| Journal | | | | |
| Obligations / Bills | | | | |
| Goals | | | | |
| Wellness | | | | |
| Insights | | | | |
| Artifacts / Documents | | | | |
| Editor | | | | |
| Settings | | | | |

**Overall verdict:** PASS / FAIL — ____________
