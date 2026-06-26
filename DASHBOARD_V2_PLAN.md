# Portol Dashboard v2 — Unified Decision Surface (Plan)

## Thesis
The homepage should answer **only three questions**, in order:
1. **What needs my attention?** (Now)
2. **Am I improving?** (Trajectory)
3. **Where should I go next?** (Explore)

Today it tries to answer ten questions halfway. It is a content dump: 11
stacked full-width sections that re-represent the same urgency and the same
finance numbers in 4–5 different shapes. The fix is not more widgets — it is a
stronger homepage thesis and a single ranking model that decides what shows.

## The current page (what we're replacing)
`DEFAULT_SECTIONS` renders, top to bottom:

| id | label | role today | redundant with |
|---|---|---|---|
| `ai-summary` | AI Summary | narrative restating metrics | everything below |
| `hero-kpis` | Net Worth / Cash Flow / Budget | strategic finance | `finance`, `obligations` |
| `kpis` | 6 chips (tasks/spend/habits/journal/bills/docs) | mixed strategic+operational | `needs-attention`, `obligations` |
| `finance` (hidden) | FinanceWidget | spend/budget/cashflow/networth | `hero-kpis` |
| `obligations` | Bills & Subscriptions | urgency (bills) | `kpis` Bills, `upcoming-dates`, `needs-attention` |
| `today` | Today's Schedule | urgency (events) | `upcoming-dates`, `needs-attention` |
| `needs-attention` | Action Required | urgency (tasks+bills) | `today`, `obligations`, `upcoming-dates` |
| `goals` | Goals (full list) | trajectory + overdue urgency | `needs-attention` (overdue), `activity` |
| `key-findings` | Key Findings | trends/insight snippets | `ai-summary` |
| `activity` | Recent Activity | log feed | none (but homepage-priority too high) |
| `upcoming-dates` | Upcoming | urgency (birthdays/renewals/appts) | `today`, `obligations`, `needs-attention` |

**Four sections (`obligations`, `today`, `needs-attention`, `upcoming-dates`)
are all "urgency from a different angle."** Two (`hero-kpis`, `finance`) are the
same finance numbers. That's the whole problem.

## Target architecture — three layers, ~6 blocks

```
┌─ HERO BRIEFING ───────────────────────────────────────────┐
│ "Good afternoon, Robert." + 1-sentence AI state + 1 CTA    │  ← answers "what's the headline"
├─ NOW QUEUE ───────────────────────────────────────────────┤
│ One ranked list: overdue, next 2 events, bills ≤7d,        │  ← answers "what needs attention"
│ expiring docs, overdue goals, top habit prompt             │
├─ KEY METRICS (max 6) ─────────────────────────────────────┤
│ Net worth · Cash flow · Active tasks · Due soon ·          │  ← answers "am I ok right now"
│ Health consistency · Expiring docs                         │
├─ TRENDS (2–3) ────────────────────────────────────────────┤
│ Spending vs income · Net-worth/debt trajectory · Health    │  ← answers "am I improving"
│ adherence — each with a next-step caption                  │
├─ DOMAIN HUBS (compact) ───────────────────────────────────┤
│ Finance · Health · Calendar · Documents · Goals ·          │  ← answers "where do I go next"
│ Relationships — each = count + 1 CTA, drill-down only      │
└─ EXPLORE / FEED (collapsible right rail or tab) ──────────┘
  Recent Activity, full Goals list, full Bills module
```

### New `DEFAULT_SECTIONS` (replaces the 11)
1. `hero-briefing` — greeting + AI one-liner + single recommended action
2. `now-queue` — the unified urgency queue (the big consolidation)
3. `key-metrics` — the existing `kpis` chip row, capped at 6, no journal/spend unless pinned
4. `trends` — 2–3 trend modules with captions
5. `domain-hubs` — compact Finance/Health/Calendar/Docs/Goals/Relationships cards
6. `feed` — Recent Activity + detailed lists, collapsed by default (or its own tab)

`hero-kpis` (Net Worth/Cash Flow/Budget) folds into **Key Metrics + the Finance
hub + Trends** rather than being its own hero band. `ai-summary`, `today`,
`needs-attention`, `obligations`, `upcoming-dates`, `goals`, `key-findings`,
`activity`, `finance` are all **dissolved** into the six blocks above.

## The Now Queue — one ranking model
This is the heart of the redesign: **merge** `needs-attention` + `obligations`
(bills) + `upcoming-dates` + `today` (events) + overdue `goals` + expiring docs
into a single ranked queue. We already have most of the engine:
`shared/upcoming-dates.ts` (`classifyUrgency`, `extractObligations`,
`extractGoals`, events/docs extractors, `URGENCY_COLORS`). v2 makes every
urgency surface a **consumer of one ranked list** instead of five hand-rolled
filters.

### Ranking score (compute once, render top N)
`score = w_u·Urgency + w_i·Impact + w_m·Momentum + w_c·Confidence + Preference`

- **Urgency** — days-until / overdue / expiration window. (overdue tasks &
  expired docs highest; due-today/≤7d next; future decays.) Source: due dates,
  `nextDueDate`, doc expiry, goal `deadline`.
- **Impact** — money at risk (bill `amount`, highest-interest debt), health
  risk, commitment `priority`, doc criticality (ID/insurance > receipt).
- **Momentum** — trend improving/declining (spend trend, net-worth trend,
  habit adherence, goal pace) — only to break ties / flag opportunities.
- **Confidence** — data completeness (has due date? amount? owner?). Low-
  confidence items rank lower so the top of the page is trustworthy.
- **Preference** — pinned domains, suppressed widgets, active dashboard mode.

Render the **top 5–7** as the Now Queue; everything else is reachable via the
domain hubs. Each row: icon · title · why-it-matters chip (e.g. "$140 · due in
2d", "ID expires in 9d", "47d overdue") · one inline action (Pay / Snooze /
Open / Mark done).

> This also kills the trust bug: the AI Summary saying "nothing logged today"
> while five urgency blocks show items. With one queue and one AI input set,
> the briefing can never contradict the list under it.

## AI Briefing — reframed to a contract
Stop restating metrics. The briefing emits exactly **one of three states** +
**one action**:
- **Attention needed** → "Review highest-interest debt (Amex Platinum, 18%)."
- **On track** → "You're on pace; confirm today's dental appointment."
- **Opportunity** → "You under-spent groceries 31% — move it to savings?"

Implementation: a small server resolver picks state from the same ranked
entity list that feeds the Now Queue (top item's category + momentum). The
hero shows greeting + that one sentence + that one CTA button. No long
narrative on the homepage.

## Trends layer (2–3, each with a caption)
- **Spending vs income** (this month, with trend %) → caption: "Net +$2,446".
- **Net worth / debt payoff** (snapshot series — the `/api/net-worth/history`
  endpoint already exists) → caption: "Down 8.4% — driven by Amex balance".
- **Health adherence** (habit completion over 30d) → caption: "33% — below your
  60% target".

Captions are the point: a static sparkline without a next step is what the
critique calls out. Each trend ends in a verb.

## Domain hubs (Explore) — compact, count + CTA
Replace the big mixed sections (full Goals list, full Bills module, long
Activity feed) with **one compact card per domain**:

| Hub | Shows | CTA |
|---|---|---|
| Finance | net worth · cash flow · budget % | "Open Finance" |
| Health | adherence % · top tracker delta | "Log / View" |
| Calendar | next event · count next 7d | "Open Calendar" |
| Documents | # expiring · # total | "Review docs" |
| Goals | # active · # at-risk | "Open Goals" |
| Relationships | next birthday · # people | "Open Profiles" |

Full detail lives on the domain pages (which already exist:
`/dashboard/finance`, `/calendar`, `/dashboard/obligations`, `/goals`,
`/dashboard/health`, `/profiles`). The homepage links, it does not dump.

## Dashboard modes (user-configurable thesis)
Portol is too broad for one static homepage. Add a mode switcher that reweights
the ranking and shows/hides hubs:
- **Executive** (default) — balanced; top urgency + 6 metrics + 3 trends.
- **Finance-first** — finance metrics/trends/hub promoted; health demoted.
- **Health-first** — adherence + trackers promoted.
- **Daily operations** — Now Queue expanded; trends collapsed.
- **Custom / pinned** — user pins specific metric chips and hubs.

Modes are just a `Preference` weight set + a visibility map persisted via the
existing layout preference (`/api/preferences/dashboard_layout`). No new data
model — reuse the customize infra already in the page.

## What moves OFF the homepage
- **Recent Activity** → collapsible feed / right rail / "Activity" tab (log
  data, not decision data).
- **Full Goals list** → Goals hub card + `/goals`.
- **Detailed Bills & Subscriptions module** → Finance hub + `/dashboard/obligations`.
- **Standalone Finance widget** → already hidden; retire it (superseded by hub + trends).
- **Long AI narrative** → one-sentence briefing only.

## Implementation phases (each independently shippable)
**Phase 1 — Now Queue (highest impact).**
Build `NowQueueSection` that consumes a single ranked list. Internally reuse
`shared/upcoming-dates.ts` + tasks + the `ActionRequiredSection` inputs. Replace
`needs-attention`, `today`, `obligations`(urgency view), and `upcoming-dates` in
`DEFAULT_SECTIONS` with one `now-queue`. Bump `LAYOUT_VERSION` so saved layouts
reset. *Outcome: four urgency sections → one. Biggest redundancy gone.*

**Phase 2 — Hero Briefing contract.**
Add the 3-state resolver (server: small function over the ranked list; or
client-side initially). Shrink `ai-summary` to greeting + one sentence + one
CTA. *Outcome: AI stops contradicting/duplicating.*

**Phase 3 — Cap Key Metrics at 6 + Trends with captions.**
Trim `kpis` to 6, move journal/monthly-spend behind "pin". Add `trends` block
(spending-vs-income, net-worth history, health adherence) each with a verb
caption. *Outcome: KPIs vs trends separation, the classic dashboard hierarchy.*

**Phase 4 — Domain hubs + move feed/lists down.**
Add `domain-hubs` compact cards; collapse Recent Activity and full lists into a
`feed` block / tab. Retire `finance` and the standalone full modules.

**Phase 5 — Dashboard modes + ranking weights + pinning.**
Add the mode switcher and the `Preference` weighting; let users pin metric chips
and hubs. Persist via existing layout preference.

## Data / endpoints
- **Reuse:** `/api/dashboard-bootstrap`, `/api/dashboard-enhanced`, `/api/stats`,
  `/api/net-worth/history`, `shared/upcoming-dates.ts`, the customize/layout
  preference API.
- **New (small):** a ranking helper in `shared/` (`shared/now-rank.ts`) that
  takes the already-fetched entities (tasks, obligations, events, docs, goals,
  habits) and returns a scored, sorted `NowItem[]`. Pure function → testable,
  shared by the Now Queue and the AI briefing so they never diverge.
- **Optional:** fold the AI 3-state into `/api/dashboard-enhanced` or a tiny
  `/api/briefing` so the homepage stays one round-trip.

## Non-negotiable invariants (must hold through every phase)
The redesign is **presentation-layer only**. It must NOT change what the app can
do — especially the AI chat, which must keep being able to "talk and do
everything" exactly as it does today.

- **AI chat is untouched.** `client/src/pages/chat.tsx`, `POST /api/chat`,
  `processMessage` / the tool chain (`server/ai-engine.ts`, `server/ai-decide.ts`)
  and every tool it calls stay exactly as-is. The dashboard already has **zero**
  imports of the chat or `/api/chat` — they are decoupled and stay decoupled.
- **No data/CRUD endpoint changes.** Every endpoint the AI tools (and other
  pages) write to or read from — tasks, expenses, habits/checkins, obligations,
  events, documents, goals, profiles, budgets, incomes — keeps its contract.
  New dashboard blocks are new **readers** of existing endpoints; they never
  replace or gate them.
- **Storage layer untouched.** No change to `server/storage.ts` /
  `supabase-storage.ts` write paths or the schema.
- **Shared data, one source of truth.** When the AI mutates data, the dashboard
  reflects it (same cache keys / invalidation already in place). The Now Queue
  and AI briefing read the same entities the chat writes — they never fork a
  second data path.
- **Every interactive widget stays functional.** Like the rebuilt Habits popup,
  any consolidated widget (Now Queue actions: Pay / Snooze / Mark done / Open)
  calls the same mutation endpoints that exist today, so chat and dashboard
  remain interchangeable ways to act on the same data.
- **Regression gate:** before each phase ships, verify a chat round-trip
  (e.g. "log $12 lunch", "check in Drink water", "add task") still creates the
  record AND the redesigned dashboard shows it.

## Decisions (locked 2026-06-26)
- **Build scope:** plan only for now — do not implement until explicitly asked.
- **Default mode:** **Executive (balanced)** — top urgency + 6 metrics + 3 trends.
- **Recent Activity + full lists:** **collapsible block at the bottom** (the
  `feed` block), below the domain hubs. Not a separate tab, not a right rail.
- **Dashboard modes:** **fast-follow**, NOT in v1. Ship the static Executive
  layout first (Phases 1–4); add the mode switcher + ranking weights + pinning
  afterward (Phase 5).

### Still open (decide at build time, sensible defaults noted)
- **Now Queue depth:** default to **top 5 + "show N more"**.
- Whether the AI 3-state resolver ships server-side or client-side first
  (default: client-side in Phase 2, fold into an endpoint later).

## Definition of done (v1 = Phases 1–3)
The homepage answers exactly three questions, shows **one** urgency queue, the
AI line can't contradict it, finance numbers appear **once** as metrics and
**once** as a captioned trend, and Recent Activity / full lists are no longer
competing for the top of the scan path.
