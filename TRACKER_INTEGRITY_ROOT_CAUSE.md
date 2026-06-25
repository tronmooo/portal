# Tracker Integrity — Root-Cause Investigation & Permanent Fix

This document answers the standing question: **why do trackers keep
misclassifying, failing to save, duplicating, or changing units** — and what was
changed so it stops happening across *all* tracker types, not just the reported
examples.

## The reported symptoms (all instances of three root causes)

| # | Symptom | Root cause |
|---|---------|-----------|
| 1 | "Incline dumbbells / pushups" not saved from a multi-exercise workout | RC-D (AI emitted one entry for a multi-item log) |
| 2 | History tab shows the wrong/inconsistent unit ("Fish Oil → qt") | RC-A (units guessed at render time + a bad shape at create time) |
| 3 | Amoxicillin tracker "failed to create" | RC-B (no medication shape → a generic value tracker, not a usable adherence tracker) |
| 4 | Duplicate "Supplement Multivitamin" next to existing "Multivitamin" | RC-C (matching was exact/substring only, no canonical identity) |

These are not four bugs. They are four faces of the same architectural problem:
**the system decided three things — unit, identity, and shape — by ad-hoc
substring guessing, in several places, with divergent logic.**

---

## Root causes

### RC-A — Units were guessed at render time from name substrings, in multiple places
- `shared/tracker-shapes.ts` had an `oil_change` shape whose pattern list
  included the bare token **`"oil"`**. Creating a **"Fish Oil"** tracker matched
  it and assigned motor-oil fields (`quarts`, unit **`qt`**). The wrong unit was
  baked into the tracker at **creation time** — data-level corruption.
- `client/src/pages/trackers.tsx :: inferUnit()` independently guessed
  `name.includes("oil") → "qt"` at **render time**, so even a clean tracker
  rendered "qt" in the history tab, card, and chart. Three views, three chances
  to disagree → "the unit isn't the same every time."

### RC-B — No canonical shape for medication / supplements
- The shape catalog had shapes for lifts, cardio, vitals, nutrition, vehicles…
  but **none for medication or supplements**. `create_tracker("Amoxicillin",
  category:"medication")` therefore fell through to a generic single-`value`
  tracker — not an adherence tracker with dose/frequency/adherence — so it
  looked broken / "failed."

### RC-C — Tracker matching & dedup used exact/substring names, no identity model
- `create_tracker` dedup compared `name === name` (exact). `log_tracker_entry`
  matched on `includes`. Neither understood that **"Multivitamin",
  "Supplement Multivitamin", and "Daily Multivitamin" are the same tracker**, so
  a worded variant spawned a duplicate.

### RC-D — Multi-item logs depend on the model emitting one call per item
- A workout listing several exercises is several entries. When the model emits
  one call, the rest are dropped. This is guided by the prompt, not enforced by
  code.

**The common thread:** unit, identity, and shape are *stable properties* of a
tracker that were being **re-derived by guessing** at multiple call sites. The
permanent fix is to make each a **single, shared, tested source of truth** that
every code path (chat engine, cards, history, charts) reads from.

---

## The fixes (permanent, not per-case)

### 1. `shared/tracker-shapes.ts` — domain-correct shapes
- Added a **medication/supplement shape** (`drug, dosage, unit(dose form),
  frequency, adherence, timeTaken`) and catalog entries placed **first**, so
  Fish Oil / Multivitamin / Amoxicillin resolve to a real adherence tracker.
- Tightened the `oil_change` pattern: `"oil"` → `["oil change","motor oil",
  "engine oil"]`. Fish Oil can never grab motor-oil quarts again.
- Added a **domain guard** in `inferTrackerShape`: vehicle/maintenance shapes
  (qt/PSI/gal units) are never applied to a health-domain tracker, even on a
  future name collision.

### 2. `shared/tracker-identity.ts` (new) — one canonical identity
- `trackerIdentityKey(name)` strips noise words (supplement, daily, my, pills…)
  and punctuation so wording variants collapse to one key.
- `trackerNamesMatch(a,b)` / `findIdentityMatches(...)` are the single matcher
  used by **both** `log_tracker_entry` resolution **and** `create_tracker`
  dedup — they can no longer disagree.

### 3. `client/src/pages/trackers.tsx` — units from one source
- `inferUnit` returns `""` for adherence trackers (never a guessed physical
  unit) and no longer maps `"oil" → "qt"`.
- History rows for adherence show the **logged dose form** (tablet/softgel) from
  the entry, consistent with the card and chart, which already read
  `classifyTrackerPresentation(tracker).unit`.

### 4. `server/ai-engine.ts` — wiring + multi-exercise guidance
- `log_tracker_entry` and `create_tracker` now use `trackerNamesMatch`.
- Prompt: a multi-exercise workout MUST emit one `log_tracker_entry` per
  exercise, including bodyweight/"to failure" moves with no load.

---

## Tests proving it works across many tracker types

- `tests/tracker-identity.test.ts` — wording variants collapse; distinct
  subjects stay distinct; short fragments ("oil","run") can't swallow names.
- `tests/tracker-shapes-domain.test.ts` — Fish Oil / Multivitamin / Amoxicillin
  / Vitamin D all present as **adherence with an empty physical unit**; a real
  oil change still gets `qt`.
- Full suite: **348 tests green**, `tsc --noEmit` clean.

## How to keep it from regressing
1. **Never guess unit/identity/shape inline.** Call the shared module.
2. **New shapes go in the catalog with category-scoped patterns**, specific
   before generic, with a domain guard if the unit is domain-specific.
3. When adding a matcher, extend `tracker-identity.ts` and its test — do not add
   a second substring check at a call site.
