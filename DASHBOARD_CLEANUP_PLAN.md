# Dashboard De-duplication + Popup System Plan

**Date:** 2026-07-24
**Scope:** `/dashboard` — the Executive tab, the three other focus-mode tabs, the
`/dashboard/*` sub-pages, and the popup layer that all of them share.
**Goal:** every fact appears **exactly once** on screen, and pressing anything
opens a fast popup instead of a full page navigation.

---

## 1. What's actually there today (measured)

| File | Lines | Role |
|---|---:|---|
| `client/src/pages/dashboard.tsx` | 5,919 | page shell, 20 section renderers, 3 inline `Dialog` popups |
| `client/src/components/dashboard/TaskHabitPopups.tsx` | 1,454 | `TasksPopup`, `HabitsPopup` |
| `client/src/components/dashboard/HeroKPIPopups.tsx` | 1,306 | `NetWorthPopup`, `CashFlowPopup`, `BudgetPopup` |
| `client/src/components/dashboard/BriefingPopups.tsx` | 813 | 8 popups (Bills, Docs, Events, Projects, Notes, Reminders, Attention, Today) |
| `client/src/components/dashboard/ExecutiveBriefing.tsx` | 801 | the Executive tab itself |
| `shared/dashboard-layout.ts` | 92 | `DEFAULT_SECTION_DEFS` (20 sections), `LAYOUT_VERSION = 16` |

**Tabs = focus modes** (`DashMode` in `dashboard.tsx:4877`): `executive`,
`finance`, `health`, `daily`. Each maps to a different ordered set of the same
20 section ids (`MODE_ORDER`, `dashboard.tsx:4890`).

**The Executive tab** renders, in order:
- 6 stat tiles — Attention · Tasks · Events · Bills · Documents · Habits
- 1 full-width "Today" strip
- **17 collapsible sections** in a 3-column masonry (`ExecutiveBriefing.tsx:550–779`):
  AI Executive Brief · Today's Agenda · Overdue · Upcoming Tasks · High Priority ·
  Habits · Reminders · Birthdays & Anniversaries · Appointments · Important Dates ·
  Document Expirations · Bills & Obligations · Calendar Next 14d · Notifications ·
  Open Projects · Recently Added · Quick Notes

That is **24 surfaces fed by 7 queries.** The queries are fine. The 24 surfaces
are the problem.

---

## 2. The redundancy map — this is the whole bug

### 2a. Tasks are rendered up to **4 times**

The four task filters in `ExecutiveBriefing.tsx:243–252` deliberately overlap:

```ts
overdueTasks  = pending.filter(dueDate <  today)
agendaTasks   = pending.filter(dueDate == today)          // → "Today's Agenda"
highPriority  = pending.filter(priority∈{high,urgent} && !overdue)
upcomingTasks = pending.filter(!dueDate || dueDate >= today)   // ⚠ superset
```

`upcomingTasks` has **no upper bound and no exclusion** — it contains every
agenda task and every high-priority task. So one high-priority task due today
appears in **Today's Agenda + Upcoming Tasks + High Priority**, and *also* in the
Tasks stat tile sub-line, and *also* in the Today strip. Five renders of one row.

An overdue task appears in **Overdue + Attention tile + AI Executive Brief**
(`aiBrief` line 1 is literally "N tasks overdue — start with …").

### 2b. Calendar items are rendered up to **3 times**

`timeline` (one 45-day fetch) is sliced four ways and then re-sliced whole:

| Section | Filter | Also appears in |
|---|---|---|
| Today's Agenda | `date == today` | Today strip, Calendar 14d |
| Birthdays & Anniversaries | `BIRTHDAY_RE` match | Calendar 14d |
| Appointments | `APPT_RE` match | Calendar 14d |
| Important Dates | neither regex | Calendar 14d |
| **Calendar · Next 14d** | **everything ≤ 14d** | ← re-renders all four above |

`Calendar · Next 14d` is a strict superset of the other four for its window. It
also pulls `type: "bill"` and `type: "obligation"` rows out of the timeline, so
bills show there **too**.

### 2c. Bills / Docs / Habits each render **3–4 times**

- **Bills:** Bills stat tile → Bills & Obligations section → Calendar 14d
  (timeline carries obligations) → AI Executive Brief bullet → Attention tile.
- **Documents:** Documents tile → Document Expirations section → AI brief bullet
  → Attention tile.
- **Habits:** Habits tile → Habits section → Today strip → AI brief bullet →
  Attention tile.

### 2d. Four surfaces are pure restatements

- **AI Executive Brief** (`aiBrief`, line 445) is derived *entirely* from
  overdue tasks + docs + habits + bills + birthdays — all of which are already
  on screen. It is a text version of the six tiles.
- **Attention tile** (`attention[]`, line 356) is the same union again, as a count.
- **Today strip** is `todayEntries` = agenda tasks + today's events + all habits
  + today's reminders — all already visible.
- **Notifications** section overlaps `alerts`, which is already folded into both
  the AI brief and Attention.

### 2e. Duplicated *code*, not just pixels

`dashboard.tsx` carries three hand-rolled `<Dialog>` blocks that duplicate
components that already exist:

| Inline dialog | Duplicates |
|---|---|
| `dashboard.tsx:1261` Bills Dialog | `BriefingPopups.BillsPopup` |
| `dashboard.tsx:1376` Docs Dialog | `BriefingPopups.DocsPopup` |
| `dashboard.tsx:1118` Spending Dialog | overlaps `HeroKPIPopups.BudgetPopup` |

### 2f. Cross-tab redundancy

`MODE_ORDER.finance = ["hero-briefing","now-queue","hero-kpis","finance","trends","kpis","domain-hubs"]`
shows **`hero-kpis` and `finance` together** — the same net worth / cash flow /
budget numbers in two different card shapes. `kpis` then shows a third copy as
chips. `DASHBOARD_V2_PLAN.md` already flagged this exact pair; it was never fixed.

---

## 3. Target: one fact, one home

### The rule

> **Every datum has exactly one owning surface. Every other mention is a
> *pointer* (a count on a tile), never a *copy* (a row you can read).**

Concretely:
- **Tiles** carry counts and one headline string. They never list rows.
- **Sections** carry rows. Each row type belongs to exactly one section.
- **Popups** carry the full list, filters, and actions. Everything deep goes here.

### Executive tab: 17 sections → 5

| New section | Absorbs | Rule |
|---|---|---|
| **Needs Attention** | Overdue, High Priority, AI Executive Brief, Notifications, fired Reminders | One ranked list, severity-sorted, deduped by entity id. Replaces `aiBrief` entirely. |
| **Today** | Today's Agenda, Today strip, today's habits, today's reminders | Chronological. Only `date == today`. |
| **Next 14 Days** | Calendar 14d, Birthdays, Appointments, Important Dates, upcoming Bills, Document Expirations | One day-grouped timeline with a **type filter chip row** (All · Events · Bills · Docs · Birthdays). The regex-split sections become filter chips, not separate sections. |
| **Open Work** | Upcoming Tasks, Open Projects | Tasks with `dueDate > today+14 \|\| !dueDate`, plus active goals. |
| **Recent** | Recently Added, Quick Notes | Collapsed by default. |

**Deleted outright:** AI Executive Brief, Overdue, High Priority, Today's Agenda,
Birthdays, Appointments, Important Dates, Calendar 14d, Notifications,
Document Expirations, Bills & Obligations, Open Projects, Quick Notes as
*standalone sections* — their rows move into the five above.

### Tiles: 6 → 4

Drop **Attention** (it is a count of the section directly beneath it — pure
restatement) and merge **Bills + Documents** into one **Obligations** tile
(both are "a dated thing that will cost you if ignored").

Final row: **Today** · **Tasks** · **Obligations** · **Habits**.

### Dedup must be enforced in code, not by convention

Add one shared derivation module, `client/src/components/dashboard/useBriefingModel.ts`:

```ts
// Single pass over the 7 queries → one normalized BriefingItem[] with a
// stable key, then bucketed ONCE. A given key can land in exactly one bucket.
type BriefingItem = {
  key: string;            // `${kind}:${id}` — the dedup identity
  kind: "task"|"event"|"bill"|"doc"|"habit"|"reminder"|"goal"|"note";
  title: string;
  date: string | null;
  severity: "critical"|"warning"|"info";
  bucket: "attention"|"today"|"next14"|"open"|"recent";  // assigned once
  go: PopupTarget;
};
```

Bucket assignment is a **priority cascade** — first match wins, item is consumed:
`attention` → `today` → `next14` → `open` → `recent`. This makes double-render
structurally impossible rather than a thing to remember.

### Other tabs

| Tab | Fix |
|---|---|
| **Finance** | Drop `hero-kpis` (kept in `finance`) and `kpis`. Order: `finance` → `trends` → `domain-hubs`. |
| **Health** | Already clean; drop `kpis` (generic chips restate `health`). |
| **Daily ops** | Becomes the trimmed Executive briefing minus Trends. Currently near-identical to Executive; make it Executive with `next14`/`open`/`recent` collapsed. |
| **Sub-pages** (`/dashboard/finance`, `/tasks`, `/habits`, …) | These become the *only* place a full list lives outside popups. Section headers get a single "Open full page" link; individual rows open popups instead. |

---

## 4. Popup system — architecture for speed

### 4a. Current problems (all verified)

1. **`dashboard.tsx:1372–1373` mounts `TasksPopup` and `HabitsPopup`
   unconditionally** (`open={popup === "tasks"}`). Both components — 1,454 lines
   of hooks, state, mutations — run on *every* dashboard render even when
   closed. `ExecutiveBriefing.tsx:786` does it correctly
   (`{popup === "tasks" && <TasksPopup …/>}`).
2. **Zero code-splitting.** All 3,573 lines of popup code are statically imported
   into the dashboard chunk and parsed before first paint, for popups the user
   may never open.
3. **`TasksPopup` forces a network round-trip on every open**
   (`TaskHabitPopups.tsx:72`: `invalidateQueries(["/api/tasks"])` inside a
   `useEffect` on `open`). `ExecutiveBriefing` already holds fresh tasks under
   the *identical* query key with `staleTime: 30_000` — the invalidate throws
   that away and guarantees a spinner every single time.
4. **`useOwnerNames` (`BriefingPopups.tsx:77`) fetches `/api/profiles` with no
   `enabled` gate** — it fires for any component that calls it, open or not.
5. **No prefetch on intent.** Tiles have `onClick` only; nothing warms on
   `pointerdown`.
6. **No virtualization.** `TasksPopup` maps the full array; a few hundred tasks
   is a multi-hundred-millisecond mount.
7. **Not route-addressable.** Android/iOS back gesture exits the dashboard
   instead of closing the popup.

### 4b. Target architecture

```
client/src/components/dashboard/popups/
  PopupHost.tsx        ← single mount point, reads ?panel= from the URL
  DetailSheet.tsx      ← the one shell: header, close, scroll, footer actions
  registry.ts          ← id → { loader, prefetch, seedSelector }
  useSeededList.ts     ← "render from cache at frame 1, refine in background"
  panels/
    TasksPanel.tsx  HabitsPanel.tsx  ObligationsPanel.tsx  (bills+docs merged)
    TimelinePanel.tsx (events+birthdays+appts+dates)  AttentionPanel.tsx
    NetWorthPanel.tsx  CashFlowPanel.tsx  BudgetPanel.tsx
    GoalsPanel.tsx  NotesPanel.tsx
```

**13 popups → 10 panels.** `BillsPopup` + `DocsPopup` merge into
`ObligationsPanel` (two tabs, one shell); `EventsPopup` absorbs the birthday /
appointment / important-date splits as filter chips; `TodayOverviewPopup` is
deleted — the Today *section* is now authoritative and its rows open the
relevant panel directly.

### 4c. The five speed rules

**Rule 1 — Seed, then refine. Never spinner.**

```ts
// useSeededList.ts
export function useSeededList<T>(key: QueryKey, fetcher: () => Promise<T[]>, open: boolean) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: key,
    queryFn: fetcher,
    enabled: open,
    // The briefing already fetched this under the same key. Render it NOW.
    initialData: () => qc.getQueryData<T[]>(key),
    initialDataUpdatedAt: () => qc.getQueryState(key)?.dataUpdatedAt,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}
```

Because the panel's query key is byte-identical to the briefing's
(`["/api/tasks", mode, ...ids]`), the popup opens with **real content on the
first frame**. The background refetch swaps rows in silently.

> **Delete `TaskHabitPopups.tsx:72`'s `invalidateQueries` on open.** It is the
> single biggest cause of perceived popup slowness. Correctness is preserved by
> the existing `invalidateDomain()` cache bus, which already fires after AI-chat
> and in-app mutations.

**Rule 2 — Lazy chunk + prefetch on intent.**

```ts
// registry.ts
export const PANELS = {
  tasks: {
    load: () => import("./panels/TasksPanel"),
    prefetch: (qc, scope) => qc.prefetchQuery({ queryKey: ["/api/tasks", ...scope], … }),
  },
  …
} satisfies Record<PanelId, PanelDef>;
```

Every tile and row gets `onPointerDown` / `onTouchStart` →
`PANELS[id].load(); PANELS[id].prefetch(...)`. On a touch device, pointerdown
fires ~80–120 ms before the click resolves; the chunk and the query are usually
in flight before the finger lifts. Target: **chunk arrives before the open
animation ends**, so lazy costs nothing perceptually.

Also add an `requestIdleCallback` warm-up after the dashboard is interactive that
preloads the two most-used panels (tasks, obligations).

**Rule 3 — Mount only when open.**

`PopupHost` renders `{activeId && <Suspense fallback={<SheetSkeleton/>}><Panel/></Suspense>}`.
Fix `dashboard.tsx:1372–1373` to match. No panel component exists in the tree
while closed — no hooks, no queries, no reconciliation cost on dashboard renders.

**Rule 4 — Virtualize past 50 rows.**

`DetailSheet` exposes a `<VirtualList>` using the windowing already in the repo
(same approach as the trackers list). Under 50 rows, render plainly — the
virtualizer's own setup cost dominates below that.

**Rule 5 — Route-addressable, one state atom.**

`?panel=tasks&sub=overdue` in the URL. `PopupHost` is the sole reader.
Consequences: back button/gesture closes the panel; deep links work; the AI chat
can hand the user a link straight into a panel; and the ~12 scattered
`useState<PopupKind>` hooks collapse into one.

### 4d. Interaction contract — "when I press it should pop up"

| Pressed | Opens |
|---|---|
| Stat tile | its panel, unfiltered |
| Section header count | that section's panel |
| Any **row** | that panel, **scrolled to and highlighting that row** (`?panel=tasks&focus=<id>`) |
| Row's inline action (✓ / Pay / Snooze) | nothing — optimistic mutation in place, no popup |
| "Open full page" link in a section header | the `/dashboard/*` route (the only navigation left) |

Rows currently `navigate()` in several places (`goNotif`,
`dashboard.tsx:1323`, `1411`) — those become panel opens.

### 4e. Performance budget

| Metric | Now | Target |
|---|---|---|
| Dashboard JS parsed before first paint | includes 3,573 popup lines | popup code = 0 (lazy) |
| Tap → panel visible | 300–800 ms (invalidate + fetch) | **< 100 ms** (seeded from cache) |
| Tap → fresh data settled | 300–800 ms | < 400 ms, invisible (background swap) |
| Panel components mounted while closed | 2 | 0 |
| Redundant `/api/profiles` fetches | 4+ per dashboard | 1 shared |

---

## 5. Execution phases

Each phase is independently shippable and independently revertable.

### Phase 0 — Guardrails (0.5 d)
- Extend `tests/dashboard-card-consistency.test.ts` with a **no-duplicate-render
  assertion**: render the Executive tab with a fixture where one task is
  overdue+high-priority+due-today, assert its title appears **once** in the DOM.
- Snapshot current bundle size for `dashboard` chunk as the baseline.

### Phase 1 — The dedup model (2 d)
- Add `useBriefingModel.ts` with the priority-cascade bucketing.
- Rewrite `ExecutiveBriefing.tsx` to render 5 sections + 4 tiles off that model.
- Delete `aiBrief`, `attention` tile, `todayEntries` duplication.
- Bump `LAYOUT_VERSION` to 17 in `shared/dashboard-layout.ts` (required — the
  client discards layouts below it) and prune dead ids from
  `DEFAULT_SECTION_DEFS`.
- **Expected:** `ExecutiveBriefing.tsx` 801 → ~450 lines.

### Phase 2 — Popup consolidation (3 d)
- Create `popups/` with `DetailSheet`, `registry`, `PopupHost`, `useSeededList`.
- Port the 13 popups to 10 panels; merge Bills+Docs, fold Events variants.
- Delete the 3 inline `<Dialog>` blocks in `dashboard.tsx` (lines 1118, 1261, 1376).
- Fix `useOwnerNames` gating.
- **Expected:** `dashboard.tsx` 5,919 → ~5,300 lines; popup total 3,573 → ~2,600.

### Phase 3 — Speed (1.5 d)
- Remove the on-open `invalidateQueries`.
- Wire lazy loading + `onPointerDown` prefetch + idle warm-up.
- Fix always-mounted popups at `dashboard.tsx:1372`.
- Add virtualization to `DetailSheet`.
- Add `?panel=` routing.

### Phase 4 — Other tabs (1 d)
- Rewrite `MODE_ORDER` per §3; drop `hero-kpis`/`kpis` from Finance, `kpis` from Health.
- Reduce `SWIMLANE_GROUPS` to match the surviving section set.
- Sub-page headers get the single "Open full page" link; rows open panels.

### Phase 5 — Verify (0.5 d)
- Run `tests/dashboard-*.test.ts`, `tests/smoke/contracts/dashboard.test.ts`,
  `scripts/verify-dashboard-commands.ts`.
- Update `docs/dashboard-scope-contract.md` and `shared/dashboard-layout.ts`
  comments; the layout-guard test enforces the shared source of truth.
- Re-measure the Phase 0 baselines against the §4e budget.

**Total: ~8.5 days.**

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| `LAYOUT_VERSION` bump silently resets every user's customized layout | That is the existing designed behavior (`parseLayoutValue` returns `null` below version). Phase 1 must ship the bump *with* the section removal in one commit — a partial bump resets layouts for no benefit. |
| AI `configure_dashboard_sections` tool references removed section ids | `findSection()` fuzzy-matches; add aliases mapping old ids → new (`overdue`→`attention`, `birthdays`→`next14`). |
| Merging Bills+Docs into one panel hides one behind a tab | Deep-link `?panel=obligations&sub=docs`; the Documents count keeps its own tile sub-line. |
| Losing the AI Executive Brief removes the narrative | The ranked Needs Attention list carries the same facts with the same `go` targets — the narrative was derived from it, not the reverse. |

---

# Implementation record — 2026-07-24

Shipped. What changed relative to the plan above, and why.

## Delivered

| Phase | Status | Notes |
|---|---|---|
| 0 — Guardrails | ✅ | `tests/dashboard-dedup.test.ts` (11 cases) + a DOM one-row-per-datum assertion in `tests/executive-sections.test.tsx`. |
| 1 — Dedup model | ✅ | `useBriefingModel.ts`; Executive tab 17 sections → 5, 6 tiles → 4. |
| 2 — Popup consolidation | ✅ | 13 popups → 11 panels; Bills+Docs merged; `TodayOverviewPopup` deleted; 192 lines of duplicate `<Dialog>` markup removed from `dashboard.tsx`. |
| 3 — Speed | ✅ | Lazy chunks + pointerdown prefetch + idle warm-up, mount-on-open, seeded reads, both on-open invalidates removed, bounded first render. |
| 4 — Other tabs | ✅ (partial) | Finance and Health de-duplicated. Daily ops left alone — see below. |
| 5 — Verify | ✅ | 1252 tests pass; `docs/dashboard-scope-contract.md` extended with the render contract. |

## Where the plan was wrong

Four claims in the plan above did not survive contact with the code. Recording
them so the plan is not read as an accurate description of what exists.

1. **`LAYOUT_VERSION` was NOT bumped, and `DEFAULT_SECTION_DEFS` was not
   pruned.** The plan called for both. It was wrong: the 17 sections being
   removed were *internal* to `ExecutiveBriefing.tsx` and never appeared in
   `DEFAULT_SECTION_DEFS`, which holds dashboard-level sections. Bumping the
   version would have reset every user's saved layout to defaults for no
   benefit at all. The §6 risk about layout resets is therefore moot.

2. **"13 popups → 10 panels" is 11, not 10.** Bills+Docs merged (−1) and
   `TodayOverviewPopup` was deleted (−1), from 13.

3. **"Zero code-splitting … 3,573 lines in the dashboard chunk" was partly
   wrong.** Rollup already split `TaskHabitPopups` and `HeroKPIPopups` into
   separate chunks. They were still *static* imports, so the browser fetched
   them on every dashboard load — the cost was real, but it was eager fetching,
   not a fat single chunk. Only `BriefingPopups` was literally inside the
   dashboard chunk.

4. **"Virtualize using the windowing already in the repo (same approach as the
   trackers list)" — there is no such windowing, and no virtualization
   dependency.** Rather than add one for variable-height expandable cards,
   `popups/Windowed.tsx` renders a bounded first page (50 rows) and reveals the
   rest on demand. Same mount-cost win, no new dependency, every row stays a
   real DOM node.

Two smaller deviations:

- **Daily ops was left untouched.** The plan wanted it collapsed to a trimmed
  Executive. It carries no duplicate pair, and collapsing it would have made it
  indistinguishable from Executive — the opposite of what modes exist for.
- **The Spending donut dialog stays in `dashboard.tsx`.** The plan listed it as
  overlapping `BudgetPopup`. They share a data source but the donut is the only
  visual category breakdown; deleting it would lose a capability, not a copy.

## Measured

Dashboard-chunk JS on the critical path, production build, before → after:

| | Before | After |
|---|---:|---:|
| `dashboard` chunk | 238,028 B | 203,591 B |
| `TaskHabitPopups` (static → lazy) | 58,071 B | 0 B on load |
| `HeroKPIPopups` (static → lazy) | 46,217 B | 0 B on load |
| `BriefingPopups` (in-chunk → lazy) | (inside dashboard) | 0 B on load |
| **Total before first paint** | **342,316 B** | **203,591 B** |

**−138,725 B (−40.5%)** of JavaScript fetched and parsed before the dashboard
can paint. 125,058 B of panel code now loads on demand, prefetched on press.
Verified with `grep` against the built chunk: no popup module remains a static
import.

Not measured: wall-clock tap→visible latency. It needs a device profile against
a real backend, which this environment cannot run. The mechanism is in place and
guarded by tests; the number in §4e remains a target, not a result.
