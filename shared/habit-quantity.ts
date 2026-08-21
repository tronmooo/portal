// shared/habit-quantity.ts — habits whose day is finished by an AMOUNT.
//
// Why this exists (QA report, reqs 10 + 11):
//
//   Habit "Walk 2 Miles — daily". The user records a 2.4-mile walk. The
//   tracker takes it correctly, and the habit stays unchecked, because habit
//   completion counted CHECK-INS and knew nothing about miles.
//
//   Habit "Drink 64 oz". The hydration tracker already totals additively —
//   32 oz + 16 oz = 48 oz — and that behaviour is the one the report says
//   works and must not regress. What was missing was the other half: the day's
//   RUNNING TOTAL deciding whether the habit is done.
//
// So a habit can carry a quantitative daily target, and when it does, "is
// today complete?" is answered by summing the day's measurements rather than
// counting taps:
//
//   Walk 2 Miles      1.2 mi + 0.8 mi = 2.0  → complete
//   Walk 2 Miles      one 2.4-mile walk      → complete (2.4 ≥ 2)
//   Drink 64 oz       32 + 16 + 16 = 64      → complete
//   Brush teeth 2×    no amount, targetPerDay 2 → still counted, unchanged
//
// The count-based path is untouched: a habit with no quantitative target
// behaves exactly as before. This module only adds an answer for habits that
// state an amount.
//
// Pure, no I/O. Pinned by tests/habit-quantity.test.ts.

/** A quantitative daily target parsed off a habit's name. */
export interface HabitQuantityTarget {
  /** How much per day. */
  value: number;
  /** Canonical unit, e.g. "mi", "oz", "min", "steps". */
  unit: string;
  /** Tracker field names that carry this measurement, best first. */
  fields: string[];
}

/** unit alias → { canonical unit, tracker fields that carry it }. */
const UNIT_MAP: Array<{ re: RegExp; unit: string; fields: string[] }> = [
  { re: /^(mi|mile|miles)$/i, unit: "mi", fields: ["distance", "miles"] },
  { re: /^(km|kilometer|kilometers|kilometre|kilometres)$/i, unit: "km", fields: ["distance", "km"] },
  { re: /^(step|steps)$/i, unit: "steps", fields: ["steps"] },
  { re: /^(oz|ounce|ounces)$/i, unit: "oz", fields: ["ounces", "oz", "amount"] },
  { re: /^(ml|milliliter|milliliters|millilitre|millilitres)$/i, unit: "ml", fields: ["ml", "amount"] },
  { re: /^(l|liter|liters|litre|litres)$/i, unit: "l", fields: ["liters", "amount"] },
  { re: /^(glass|glasses|cup|cups|bottle|bottles)$/i, unit: "glasses", fields: ["glasses", "cups", "amount"] },
  { re: /^(min|mins|minute|minutes)$/i, unit: "min", fields: ["duration", "minutes"] },
  { re: /^(hr|hrs|hour|hours)$/i, unit: "hr", fields: ["hours", "duration"] },
  { re: /^(page|pages)$/i, unit: "pages", fields: ["pages"] },
  { re: /^(rep|reps)$/i, unit: "reps", fields: ["reps"] },
  { re: /^(cal|cals|calorie|calories|kcal)$/i, unit: "cal", fields: ["calories"] },
];

const UNIT_ALT = [
  "miles?", "mi", "kilometers?", "kilometres?", "km", "steps?",
  "ounces?", "oz", "milliliters?", "millilitres?", "ml", "liters?", "litres?", "l",
  "glasses", "glass", "cups?", "bottles?",
  "minutes?", "mins?", "min", "hours?", "hrs?", "hr",
  "pages?", "reps?", "calories?", "cals?", "kcal",
].join("|");

/**
 * A number immediately followed by a unit: "Walk 2 Miles", "Drink 64 oz of
 * water", "Read 20 pages", "Meditate 10 minutes".
 *
 * Deliberately requires the number and unit to be ADJACENT. "Walk the dog 2
 * times a day" is a count, not a distance, and must keep falling through to
 * the count-based path.
 */
const QUANTITY_RE = new RegExp(
  String.raw`(\d+(?:[.,]\d+)?)\s*(${UNIT_ALT})\b`,
  "i",
);

/** Phrases that mean "N times", never "N units" — guard against reading a
 *  per-day cadence as an amount. */
const CADENCE_RE = /\b\d+\s*(?:x|times?)\b/i;

/**
 * Parse a quantitative daily target off a habit name, or null when the habit
 * measures nothing (a plain "make my bed" / "brush teeth twice" habit).
 */
export function parseHabitQuantityTarget(habitName: unknown): HabitQuantityTarget | null {
  const name = String(habitName ?? "").trim();
  if (!name) return null;

  // Strip cadence phrases first so "Walk 2 miles 3x a day" reads 2 miles.
  const cleaned = name.replace(CADENCE_RE, " ");
  const hit = cleaned.match(QUANTITY_RE);
  if (!hit) return null;

  const value = Number(String(hit[1]).replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;

  const rawUnit = String(hit[2] || "");
  const mapped = UNIT_MAP.find((u) => u.re.test(rawUnit));
  if (!mapped) return null;

  return { value, unit: mapped.unit, fields: [...mapped.fields] };
}

/** A tracker entry, in the shape this module needs. */
export interface QuantityEntry {
  timestamp?: string | null;
  values?: Record<string, any> | null;
}

/**
 * Sum one day's measurements for a target, across every entry.
 *
 * ADDITIVE by design — this is the hydration behaviour the report says already
 * works, generalised. Three 16 oz logs total 48 oz; two walks of 1.2 and 0.8
 * miles total 2.
 *
 * `dayOf` is injected so this module stays free of timezone I/O — the caller
 * already knows how it converts a timestamp to a local date.
 */
export function sumDayQuantity(
  entries: readonly QuantityEntry[] | null | undefined,
  target: HabitQuantityTarget,
  date: string,
  dayOf: (timestamp: unknown) => string,
): number {
  let total = 0;
  for (const e of entries || []) {
    if (dayOf(e?.timestamp) !== date) continue;
    const values = e?.values || {};
    // First matching field only: an entry carrying both `distance` and `miles`
    // is one distance stated twice, not two walks (same rule as QA req 12).
    for (const field of target.fields) {
      const n = Number((values as any)[field]);
      if (Number.isFinite(n) && n > 0) { total += n; break; }
    }
  }
  return Math.round(total * 1e6) / 1e6;
}

export interface QuantityProgress {
  target: number;
  unit: string;
  total: number;
  remaining: number;
  percent: number;
  isComplete: boolean;
}

export function quantityProgress(target: HabitQuantityTarget, total: number): QuantityProgress {
  const t = Number(total) || 0;
  const remaining = Math.max(0, target.value - t);
  return {
    target: target.value,
    unit: target.unit,
    total: t,
    remaining: Math.round(remaining * 1e6) / 1e6,
    percent: target.value > 0 ? Math.min(100, Math.round((t / target.value) * 100)) : 0,
    // ≥, not ===. A 2.4-mile walk finishes a 2-mile habit.
    isComplete: t >= target.value,
  };
}
