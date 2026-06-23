# Dynamic Tracker System — Plan

Goal: trackers feel like purpose-built mini-apps without hardcoding a component
per type. One **classification engine** reads any tracker's shape and the UI
renders the right units, graph, summary cards, and logging flow. New data types
work automatically — no migration, no new component.

The engine already exists and is tested: `shared/tracker-presentation.ts`
(`classifyTrackerPresentation`). This doc is the roadmap for wiring it through
the whole tracker tab.

---

## 1. The data taxonomy (every variation maps to a `metricKind`)

The system reduces the infinite space of "things people track" to a small set
of **metric kinds**. Each kind fully determines presentation.

| metricKind   | What it is | Examples | Aggregation | Chart | Headline KPIs | Unit examples |
|--------------|------------|----------|-------------|-------|---------------|---------------|
| `additive`   | accumulates over a period; the **total** matters | water, calories, carbs, miles, steps, minutes, $ spent, reps | **sum / day** (or week) | grouped **bars** | Total · Avg/active day · Peak · Days logged | oz, kcal, g, mi, steps, min, $ |
| `measurement`| a **reading** at a point in time; latest matters | weight, glucose, body temp, heart rate, SpO₂, body fat | **last / day** | **line** | Latest · Average · Low · High | lb, mg/dL, °F, bpm, %, ms |
| `dual`       | two paired numbers read together | blood pressure | last / day | **dual line** (sys+dia) | Latest 120/80 · Avg systolic · Avg diastolic · Readings | mmHg |
| `adherence`  | did / didn't do a scheduled thing | medication, supplements | per-day taken? | **7-day dose grid** + streak | Adherence % · Doses logged · Taken-today · Refill countdown | mg/mcg/IU/capsule/etc. |
| `categorical`| a bounded scale / rating | mood, stress, pain (1–10), energy | last / day | line on a fixed 1–N axis | Latest · Average · Best/Worst day | (scale label) |
| `unknown`    | text-only, no numeric field | freeform journal-style | — | none | Recent entries list + good empty state | — |

Rule of correctness: **a kind never borrows another kind's unit or graph.**
Heart rate is `bpm` (measurement), blood pressure is `120/80 mmHg` (dual), a
supplement is adherence — they can never be confused because classification is
field/category/name-driven, not guessed at render time.

---

## 2. How a tracker is classified (`classifyTrackerPresentation`)

Priority order (first match wins), so specific beats generic:

1. **Adherence** — category ∈ {medication, prescription, supplement}, OR fields
   are dose-shaped (`dosage`/`dose` + `taken`/`adherence`/`drug`), OR the name
   is a known drug/supplement (fish oil, omega, multivitamin, melatonin, …).
   → This is why mis-categorized **Fish Oil/Multivitamin** still render as meds.
2. **Dual** — has `systolic` + `diastolic`, or the name is blood pressure.
3. Pick the **primary numeric field** (declared primary → first numeric → first).
4. **Additive vs measurement** — `classifyMetric()` plus volume/count context
   (ounces/cups/mL/reps/sets/laps/"water") so hydration sums correctly.
5. **Categorical** — primary field is a mood/rating/score/pain/stress/energy scale.
6. **Unit** — declared → field unit → inferred from the field name.
7. **unknown** — no numeric field → graceful list + empty state.

Everything downstream (cards, charts, logging) reads this one spec.

---

## 3. Data sources — all feed the same shape

Whatever the origin, data is normalized to `{ trackerId, entry_values, … }`
and the same classification applies. Sources:

- **Chat (natural language)** — the AI logs via `log_tracker_entry`, auto-creating
  the tracker with inferred category/fields. Routing guards keep metrics apart
  (HR split out of BP; supplements → medication; generic `amount` → primary field).
- **Manual add** — the "+ Add" dialog, including ad-hoc custom fields.
- **Document extraction** — lab reports, vitals, prescriptions extracted from
  uploads become tracker entries / medication trackers.
- **Future: device/API import** (Apple Health, CGM, scales) — lands as entries
  with the same `entry_values` shape; classification is unchanged.

Because classification is shape-based, **a new source needs zero presentation work.**

---

## 4. Per-kind logging flow (the "mini-app" feel)

- `adherence` → one-tap **"Take dose"** (already in MedicationOverview) + dosage/time;
  refill reminders via `schedule_medication_refills` (shipped).
- `additive` → quick-add a quantity with the unit prefilled; "+8 oz" style chips.
- `measurement` → single number with unit; optional time.
- `dual` → two fields (systolic/diastolic) side by side.
- `categorical` → a 1–N segmented picker (mood faces / 1–10).
- All kinds → the universal per-entry editor (add/edit/delete fields) already shipped.

---

## 5. Overview redesign (driven by the spec, not per-type code)

A single `DynamicOverview` reads the spec and composes:
- **KPI strip** — the `kpis[]` from the spec (Total/Avg/Peak vs Latest/Avg/Low/High vs Adherence%/Doses…).
- **Graph** — `chartStyle` (bar/line/dual/adherence) fed by `aggregateTimeSeries`
  (already built) with the spec's `aggregation` and granularity by range.
- **Goal ring** — when `goalCapable` and a goal exists.
- **Recent logs** — universal list (tap-to-edit).
- **Empty / low-data states** — friendly nudges (shipped for the standard chart).
- **Color** — per `metricKind` accent (health=rose, fitness=orange, hydration=cyan,
  nutrition=green, mental=violet, medication=red) so each card is visually distinct.

The specialized components that exist today (medication, weight, BP, sleep,
running) become **presets of the same dynamic renderer**, not separate code paths.

---

## 6. Implementation phases

- **Phase 0 — Engine (DONE).** `classifyTrackerPresentation` + tests; supplement
  detection; HR≠BP guard; hydration field mapping; low-data states; refill reminders.
- **Phase 1 — Dynamic Overview.** Replace the "standard" overview's KPI row +
  chart with spec-driven rendering (bars for additive w/ daily totals, line for
  measurement, correct units everywhere). Hydration/heart-rate/mood instantly
  look right with no bespoke components.
- **Phase 2 — Dynamic dashboard cards.** The Linked cards read the same spec so
  the headline metric/unit/sparkline always match the kind.
- **Phase 3 — Per-kind logging flows + color system.** Quick-add chips, segmented
  pickers, kind accents.
- **Phase 4 — Goals & insights per kind.** Goal rings, PRs for additive fitness,
  adherence streaks, range/zone bands for measurements.
- **Phase 5 — New sources.** Device/API import maps into the same shape.

Each phase is independently shippable and regression-tested.
