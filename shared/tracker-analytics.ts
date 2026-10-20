// Tracker analytics — the one place the tracker detail view gets its numbers.
//
// The detail popup used to compute the same things four different ways
// inline: a "7-day moving average" over ENTRIES (not days), macro "averages"
// divided by entry count (so one 400 kcal meal read as a 400 kcal day), a
// daily calorie bar that drew a day with no calories as 0, a trend verdict
// ("stable") from a single reading, and a correlation between whatever two
// fields happened to be declared first (Quantity vs Calories). Every one of
// those shipped to the owner in a screenshot.
//
// Rules this module enforces, each pinned in tests/tracker-analytics.test.ts:
//   - Values are bucketed by CALENDAR DAY. Additive metrics sum, readings take
//     the day's last value. A day with no value is absent — never 0.
//   - Every average says what it is averaged over (logged days vs entries).
//   - A trend is only described from enough logged days; below that the
//     verdict is "insufficient" and says how many more are needed.
//   - Correlations are day-aligned, need MIN_CORRELATION_DAYS matching days,
//     skip pairs that are arithmetically related (calories ↔ macros), and
//     never claim significance or causation.
//   - Insights are only produced when the data supports the sentence.
//
// Pure and deterministic: callers pass `now` and a timezone.

import { classifyMetric } from "./chart-data";
import { trackerFieldLabel } from "./field-label";
import { resolveTrackerUnit } from "./tracker-units";

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface AnalyticsField {
  name: string;
  label?: string;
  type?: string;
  unit?: string;
  isPrimary?: boolean;
}

export interface AnalyticsEntry {
  id?: string;
  timestamp: string;
  values: Record<string, unknown>;
}

export interface AnalyticsTracker {
  id?: string;
  name?: string;
  category?: string;
  unit?: string | null;
  fields?: AnalyticsField[];
  entries?: AnalyticsEntry[];
}

export type DayMode = "sum" | "last";
export type Polarity = "higher" | "lower" | "neutral";
export type RangeKey = "7d" | "30d" | "90d" | "1y" | "all";

export const RANGE_DAYS: Record<Exclude<RangeKey, "all">, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

/** Logged days needed before a trend is described at all. */
export const MIN_TREND_DAYS = 4;
/** Logged days needed before a moving average is drawn. */
export const MIN_MOVING_AVG_DAYS = 7;
/** Matching days needed before a correlation is reported. */
export const MIN_CORRELATION_DAYS = 7;

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ── Reading values ────────────────────────────────────────────────────────────

/** A finite number stored under `field`, or null. Numeric strings count. */
export function readNumber(entry: AnalyticsEntry, field: string): number | null {
  const raw = entry?.values?.[field];
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Entries with a duplicated id are counted once (the last copy wins). */
export function dedupeEntries<E extends AnalyticsEntry>(entries: E[]): E[] {
  const byId = new Map<string, E>();
  const anon: E[] = [];
  for (const e of entries || []) {
    if (!e || !e.timestamp || isNaN(new Date(e.timestamp).getTime())) continue;
    if (e.id) byId.set(e.id, e);
    else anon.push(e);
  }
  return [...byId.values(), ...anon].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

// ── Fields ────────────────────────────────────────────────────────────────────

/** Fields that count servings rather than measure anything. */
const COUNT_FIELD = /^(quantity|qty|servings?|count|portions?|items?|units?)$/;

// What a person means by "the" number for a tracker, best first.
const MEANINGFUL_FIELDS = [
  "calories", "kcal", "distance", "miles", "km", "steps", "duration", "minutes",
  "hours", "sleephours", "weight", "systolic", "amount", "ounces", "oz", "ml",
  "glasses", "cups", "bpm", "heartrate", "rating", "mood", "value", "score",
];

function isNumericField(f: AnalyticsField): boolean {
  return f.type === "number" || f.type === "duration";
}

function fieldHasData(t: AnalyticsTracker, name: string): boolean {
  return (t.entries || []).some((e) => readNumber(e, name) != null);
}

/**
 * The field a tracker's headline, trend and goal are about.
 *
 * Honors the declared primary field — except a serving COUNT ("quantity",
 * "servings"), which chat-created trackers mark primary only because it was
 * the first key of the first entry. A nutrition tracker's number is calories,
 * not "2 servings"; that choice is what rendered "Quantity 2.0 – 2.0" as the
 * Nutrition trend.
 */
export function pickPrimaryField(t: AnalyticsTracker): string | null {
  const fields = (t.fields || []).filter((f) => f?.name && norm(f.name) !== "notes");
  const numeric = fields.filter(isNumericField);
  const hasEntries = (t.entries || []).length > 0;
  const usable = (f: AnalyticsField) => !hasEntries || fieldHasData(t, f.name);

  const declared = fields.find((f) => f.isPrimary && (isNumericField(f) || f.type === undefined));
  const isCount = (f: AnalyticsField) => COUNT_FIELD.test(norm(f.name));

  if (declared && !isCount(declared)) return declared.name;

  const better = numeric.filter((f) => !isCount(f) && usable(f));
  if (better.length > 0) {
    for (const want of MEANINGFUL_FIELDS) {
      const hit = better.find((f) => norm(f.name) === want);
      if (hit) return hit.name;
    }
    return better[0].name;
  }
  if (declared) return declared.name;
  if (numeric[0]) return numeric[0].name;
  return fields[0]?.name ?? null;
}

/** Numeric fields that actually hold data, primary first. */
export function numericFieldsWithData(t: AnalyticsTracker): AnalyticsField[] {
  const primary = pickPrimaryField(t);
  let list = (t.fields || []).filter((f) => isNumericField(f) && fieldHasData(t, f.name));
  // A serving count beside real measures is bookkeeping, not a metric to chart.
  if (list.some((f) => !COUNT_FIELD.test(norm(f.name)))) list = list.filter((f) => !COUNT_FIELD.test(norm(f.name)) || f.name === primary);
  return list.sort((a, b) => (a.name === primary ? -1 : b.name === primary ? 1 : 0));
}

export function fieldLabel(t: AnalyticsTracker, name: string): string {
  const f = (t.fields || []).find((x) => x.name === name);
  return f ? trackerFieldLabel(f) : trackerFieldLabel({ name });
}

export function fieldUnit(t: AnalyticsTracker, name: string): string {
  return resolveTrackerUnit(t as any, name);
}

/** How a field combines within one day: totals add up, readings don't. */
export function dayModeFor(t: AnalyticsTracker, field: string): DayMode {
  const f = norm(field);
  if (/(ounce|^oz$|cup|glass|^ml$|millilit|liter|litre|intake|^reps?$|^sets?$|^laps?$|drink)/.test(f)) return "sum";
  if (/(water|hydrat)/.test(norm(t.name)) && !/(weight|temp)/.test(f)) return "sum";
  return classifyMetric(field) === "sum" ? "sum" : "last";
}

/** Whether a bigger number is good news for this field. */
export function polarityFor(t: AnalyticsTracker, field: string): Polarity {
  const f = norm(field);
  const name = norm(t.name);
  if (/(systolic|diastolic|^bp$|glucose|cholesterol|ldl|sodium|sugar|caffeine|alcohol|drinks|stress|anxiety|pain|restinghr|rhr|expense|spend|cost|debt|pace)/.test(f)) return "lower";
  if (/(spend|expense|cost)/.test(name) && /(amount|total|value)/.test(f)) return "lower";
  if (/(sleep|hours|steps|distance|miles|km|protein|fiber|water|ounces|glasses|cups|minutes|duration|reps|mood|rating|energy|hdl|savings|income|focus)/.test(f)) return "higher";
  return "neutral";
}

// ── Days ──────────────────────────────────────────────────────────────────────

export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** YYYY-MM-DD of an instant in `tz`. */
export function dayKeyOf(ts: string | number | Date, tz: string): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Day arithmetic on YYYY-MM-DD strings, independent of the host zone. */
export function shiftDay(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function dayLabel(key: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
}

export interface DayPoint {
  day: string;          // YYYY-MM-DD
  label: string;        // "Aug 9"
  value: number;
  entries: number;      // entries that carried a value for this field
  entryIds: string[];
}

/**
 * One point per calendar day that HAS a value. Days without one are absent:
 * a chart draws a gap, an average skips them.
 */
export function dailySeries(
  entries: AnalyticsEntry[],
  field: string,
  opts: { mode: DayMode; tz: string; fromDay?: string; toDay?: string },
): DayPoint[] {
  const byDay = new Map<string, { sum: number; last: number; lastTs: number; n: number; ids: string[] }>();
  for (const e of dedupeEntries(entries)) {
    const v = readNumber(e, field);
    if (v == null) continue;
    const day = dayKeyOf(e.timestamp, opts.tz);
    if (opts.fromDay && day < opts.fromDay) continue;
    if (opts.toDay && day > opts.toDay) continue;
    const ts = new Date(e.timestamp).getTime();
    const b = byDay.get(day) || { sum: 0, last: v, lastTs: -Infinity, n: 0, ids: [] };
    b.sum += v;
    if (ts >= b.lastTs) { b.last = v; b.lastTs = ts; }
    b.n++;
    if (e.id) b.ids.push(e.id);
    byDay.set(day, b);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, b]) => ({
      day,
      label: dayLabel(day),
      value: round2(opts.mode === "sum" ? b.sum : b.last),
      entries: b.n,
      entryIds: b.ids,
    }));
}

/** First day of a range ending `today` (inclusive), or null for all time. */
export function rangeStartDay(range: RangeKey, today: string): string | null {
  if (range === "all") return null;
  return shiftDay(today, -(RANGE_DAYS[range] - 1));
}

export function filterSeries(points: DayPoint[], fromDay: string | null, toDay?: string): DayPoint[] {
  return points.filter((p) => (!fromDay || p.day >= fromDay) && (!toDay || p.day <= toDay));
}

/** Trailing mean over the previous `window` CALENDAR days that have data. */
export function rollingMean(points: DayPoint[], window = 7): Array<number | null> {
  if (points.length < MIN_MOVING_AVG_DAYS) return points.map(() => null);
  return points.map((p) => {
    const from = shiftDay(p.day, -(window - 1));
    const inWin = points.filter((q) => q.day >= from && q.day <= p.day);
    return inWin.length >= 3 ? round2(mean(inWin.map((q) => q.value))) : null;
  });
}

// ── Summaries ─────────────────────────────────────────────────────────────────

export interface PeriodStats {
  fromDay: string | null;
  toDay: string;
  spanDays: number | null;  // calendar days in the period (null = all time)
  loggedDays: number;
  entries: number;
  total: number;            // meaningful for sum metrics
  perDay: number | null;    // mean over LOGGED days
  latest: DayPoint | null;
  high: DayPoint | null;
  low: DayPoint | null;
}

export function periodStats(points: DayPoint[], fromDay: string | null, toDay: string): PeriodStats {
  const inRange = filterSeries(points, fromDay, toDay);
  const vals = inRange.map((p) => p.value);
  const by = (cmp: (a: number, b: number) => boolean) =>
    inRange.reduce<DayPoint | null>((best, p) => (best == null || cmp(p.value, best.value) ? p : best), null);
  return {
    fromDay,
    toDay,
    spanDays: fromDay ? daysBetween(fromDay, toDay) + 1 : null,
    loggedDays: inRange.length,
    entries: inRange.reduce((s, p) => s + p.entries, 0),
    total: round2(vals.reduce((s, v) => s + v, 0)),
    perDay: vals.length ? round2(mean(vals)) : null,
    latest: inRange[inRange.length - 1] ?? null,
    high: by((a, b) => a > b),
    low: by((a, b) => a < b),
  };
}

export interface PeriodComparison {
  current: PeriodStats;
  previous: PeriodStats;
  /** % change in per-logged-day value; null unless both periods have ≥2 logged days. */
  changePct: number | null;
}

/** This period vs the equal-length period right before it. */
export function comparePeriods(points: DayPoint[], days: number, today: string): PeriodComparison {
  const curFrom = shiftDay(today, -(days - 1));
  const prevTo = shiftDay(curFrom, -1);
  const prevFrom = shiftDay(prevTo, -(days - 1));
  const current = periodStats(points, curFrom, today);
  const previous = periodStats(points, prevFrom, prevTo);
  const ok = current.loggedDays >= 2 && previous.loggedDays >= 2 && previous.perDay != null && previous.perDay !== 0 && current.perDay != null;
  return {
    current,
    previous,
    changePct: ok ? round1(((current.perDay! - previous.perDay!) / Math.abs(previous.perDay!)) * 100) : null,
  };
}

export type TrendStatus = "insufficient" | "rising" | "falling" | "steady";

export interface TrendVerdict {
  status: TrendStatus;
  /** Fitted change across the window, as % of the mean. */
  pct: number | null;
  loggedDays: number;
  /** More logged days needed before a trend is described. */
  needed: number;
  /** good / bad / neutral given the field's polarity. */
  tone: "good" | "bad" | "neutral";
}

/** Least-squares slope over calendar days, reported as % change across the span. */
export function trendVerdict(points: DayPoint[], polarity: Polarity = "neutral"): TrendVerdict {
  const n = points.length;
  if (n < MIN_TREND_DAYS) {
    return { status: "insufficient", pct: null, loggedDays: n, needed: MIN_TREND_DAYS - n, tone: "neutral" };
  }
  const x0 = points[0].day;
  const xs = points.map((p) => daysBetween(x0, p.day));
  const ys = points.map((p) => p.value);
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den === 0 ? 0 : num / den;
  const span = xs[n - 1] - xs[0];
  const pct = my === 0 ? 0 : round1(((slope * span) / Math.abs(my)) * 100);
  const status: TrendStatus = Math.abs(pct) < 3 ? "steady" : pct > 0 ? "rising" : "falling";
  let tone: TrendVerdict["tone"] = "neutral";
  if (status !== "steady" && polarity !== "neutral") {
    tone = (status === "rising") === (polarity === "higher") ? "good" : "bad";
  }
  return { status, pct, loggedDays: n, needed: 0, tone };
}

// ── Nutrition ─────────────────────────────────────────────────────────────────

export interface MacroDay { day: string; protein: number; carbs: number; fat: number; calories: number | null; entries: number }

export interface MacroSummary {
  loggedDays: number;
  entries: number;
  /** Grams per LOGGED day. */
  perDay: { protein: number; carbs: number; fat: number; fiber: number | null; sugar: number | null; calories: number | null };
  /** Share of energy from each macro (protein/carbs ×4 kcal/g, fat ×9). */
  energyShare: { protein: number; carbs: number; fat: number } | null;
  /** Entries in range that carry no calories — totals are understated by these. */
  missingCalories: number;
  /** Days that have exactly one logged entry. */
  singleEntryDays: number;
}

export function macroSummary(entries: AnalyticsEntry[], tz: string, fromDay: string | null, toDay: string): MacroSummary {
  const list = dedupeEntries(entries).filter((e) => {
    const d = dayKeyOf(e.timestamp, tz);
    return (!fromDay || d >= fromDay) && d <= toDay;
  });
  const days = new Map<string, number>();
  const sum = { protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, calories: 0 };
  const seen = { fiber: false, sugar: false, calories: false };
  let missingCalories = 0;
  for (const e of list) {
    const d = dayKeyOf(e.timestamp, tz);
    days.set(d, (days.get(d) || 0) + 1);
    for (const k of ["protein", "carbs", "fat", "fiber", "sugar", "calories"] as const) {
      const v = readNumber(e, k);
      if (v != null) { sum[k] += v; if (k in seen) (seen as any)[k] = true; }
    }
    if (readNumber(e, "calories") == null) missingCalories++;
  }
  const n = days.size;
  const per = (v: number) => (n ? round1(v / n) : 0);
  const kcal = sum.protein * 4 + sum.carbs * 4 + sum.fat * 9;
  return {
    loggedDays: n,
    entries: list.length,
    perDay: {
      protein: per(sum.protein),
      carbs: per(sum.carbs),
      fat: per(sum.fat),
      fiber: seen.fiber ? per(sum.fiber) : null,
      sugar: seen.sugar ? per(sum.sugar) : null,
      calories: seen.calories ? Math.round(n ? sum.calories / n : 0) : null,
    },
    energyShare: kcal > 0
      ? { protein: Math.round((sum.protein * 4 / kcal) * 100), carbs: Math.round((sum.carbs * 4 / kcal) * 100), fat: Math.round((sum.fat * 9 / kcal) * 100) }
      : null,
    missingCalories,
    singleEntryDays: [...days.values()].filter((c) => c === 1).length,
  };
}

/** Items ranked by the summed value of `field` (e.g. foods by calories). */
export function topContributors(
  entries: AnalyticsEntry[],
  field: string,
  labelOf: (e: AnalyticsEntry) => string | null,
  limit = 5,
): Array<{ label: string; value: number; count: number; share: number }> {
  const by = new Map<string, { value: number; count: number }>();
  let total = 0;
  for (const e of dedupeEntries(entries)) {
    const v = readNumber(e, field);
    const label = labelOf(e);
    if (v == null || !label) continue;
    const key = label.trim();
    if (!key) continue;
    const b = by.get(key) || { value: 0, count: 0 };
    b.value += v; b.count++;
    by.set(key, b);
    total += v;
  }
  return [...by.entries()]
    .map(([label, b]) => ({ label, value: round1(b.value), count: b.count, share: total > 0 ? Math.round((b.value / total) * 100) : 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

/** Entries per weekday (Mon..Sun), from local day keys. */
export function weekdayCounts(points: DayPoint[]): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const p of points) {
    const [y, m, d] = p.day.split("-").map(Number);
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    out[dow] += 1;
  }
  return out;
}

/** Consecutive logged days ending today or yesterday. */
export function currentStreak(loggedDays: string[], today: string): number {
  const set = new Set(loggedDays);
  let cursor = set.has(today) ? today : shiftDay(today, -1);
  let n = 0;
  while (set.has(cursor)) { n++; cursor = shiftDay(cursor, -1); }
  return n;
}

export function longestStreak(loggedDays: string[]): number {
  const days = [...new Set(loggedDays)].sort();
  let best = 0, run = 0, prev: string | null = null;
  for (const d of days) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

// ── Correlations ──────────────────────────────────────────────────────────────

export interface SeriesSource {
  key: string;            // stable id, e.g. "<trackerId>:<field>"
  trackerId?: string;
  label: string;
  unit: string;
  points: DayPoint[];
}

export interface CorrelationResult {
  a: SeriesSource;
  b: SeriesSource;
  r: number;
  n: number;              // matching days
  /** Two-sided p-value (Fisher z). Shown only after a false-discovery check. */
  p: number;
  strength: "strong" | "moderate" | "weak" | "none";
  direction: "positive" | "negative" | "none";
  sentence: string;
  pairs: Array<{ day: string; x: number; y: number }>;
}

export interface NearCorrelation { a: SeriesSource; b: SeriesSource; n: number; needed: number }

export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null; // a constant series correlates with nothing
  return num / Math.sqrt(dx * dy);
}

export function describeStrength(r: number): CorrelationResult["strength"] {
  const a = Math.abs(r);
  return a >= 0.7 ? "strong" : a >= 0.4 ? "moderate" : a >= 0.2 ? "weak" : "none";
}

// Fields whose relationship is arithmetic, not behavioural: calories are made
// of macros, a serving count scales every nutrient.
const COMPOSITIONAL = /^(calories|kcal|protein|carbs|carbohydrates|fat|fats|fiber|sugar|sugars|sodium|quantity|qty|servings?)$/;

function isTrivialPair(a: SeriesSource, b: SeriesSource): boolean {
  if (a.trackerId && a.trackerId === b.trackerId) {
    const fa = norm(a.key.split(":").pop()), fb = norm(b.key.split(":").pop());
    if (COMPOSITIONAL.test(fa) && COMPOSITIONAL.test(fb)) return true;
    if (COUNT_FIELD.test(fa) || COUNT_FIELD.test(fb)) return true;
    // Pace is distance over duration — not a finding.
    if (/pace|speed/.test(fa + fb) && /(distance|miles|km|duration|minutes)/.test(fa + fb)) return true;
  }
  return false;
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26 erf), plenty for a p-value cut.
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Two-sided p-value for Pearson's r over n pairs (Fisher z-transform). */
export function correlationPValue(r: number, n: number): number {
  if (n < 4) return 1;
  const rc = Math.max(-0.999999, Math.min(0.999999, r));
  const z = Math.atanh(rc) * Math.sqrt(n - 3);
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/** Benjamini–Hochberg: which of these p-values survive at false-discovery rate q. */
function fdrSurvivors(ps: number[], q: number): boolean[] {
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let cutoff = -1;
  order.forEach((o, k) => { if (o.p <= ((k + 1) / ps.length) * q) cutoff = k; });
  const keep = ps.map(() => false);
  for (let k = 0; k <= cutoff; k++) keep[order[k].i] = true;
  return keep;
}

/**
 * Day-aligned correlations between every pair of sources, strongest first.
 *
 * Comparing many pairs guarantees some look "strong" by chance, so a pair is
 * only reported when it survives a false-discovery-rate check across every
 * pair tested (`tested` counts them; `results` holds the survivors). Pairs
 * with too few matching days come back as `near`, so the UI can say what's
 * close to unlocking instead of drawing an empty chart.
 */
export function rankCorrelations(
  sources: SeriesSource[],
  minDays = MIN_CORRELATION_DAYS,
  fdr = 0.1,
): { results: CorrelationResult[]; near: NearCorrelation[]; tested: number } {
  let results: CorrelationResult[] = [];
  const near: NearCorrelation[] = [];
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i], b = sources[j];
      if (isTrivialPair(a, b)) continue;
      const bMap = new Map(b.points.map((p) => [p.day, p.value]));
      const pairs = a.points.filter((p) => bMap.has(p.day)).map((p) => ({ day: p.day, x: p.value, y: bMap.get(p.day)! }));
      if (pairs.length < minDays) {
        if (pairs.length >= 2) near.push({ a, b, n: pairs.length, needed: minDays - pairs.length });
        continue;
      }
      const r = pearson(pairs.map((p) => p.x), pairs.map((p) => p.y));
      if (r == null) continue;
      const strength = describeStrength(r);
      const direction = strength === "none" ? "none" : r > 0 ? "positive" : "negative";
      results.push({ a, b, r: round2(r), n: pairs.length, p: correlationPValue(r, pairs.length), strength, direction, sentence: correlationSentence(a, b, r, pairs.length), pairs });
    }
  }
  const tested = results.length;
  const keep = fdrSurvivors(results.map((x) => x.p), fdr);
  results = results.filter((x, i) => keep[i] && x.strength !== "none");
  results.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  near.sort((x, y) => x.needed - y.needed);
  return { results, near, tested };
}

export function correlationSentence(a: SeriesSource, b: SeriesSource, r: number, n: number): string {
  const s = describeStrength(r);
  if (s === "none") return `No clear link between ${a.label} and ${b.label} across ${n} matching days.`;
  return `On days with higher ${a.label}, ${b.label} tends to be ${r > 0 ? "higher" : "lower"} — a ${s} ${r > 0 ? "positive" : "negative"} link across ${n} matching days.`;
}

// ── Insights ──────────────────────────────────────────────────────────────────

export type InsightTone = "improvement" | "decline" | "milestone" | "goal" | "unusual" | "quality" | "info";

export interface TrackerInsight {
  id: string;
  tone: InsightTone;
  title: string;
  detail: string;
}

export interface InsightContext {
  field: string;
  label: string;
  unit: string;
  mode: DayMode;
  polarity: Polarity;
  points: DayPoint[];       // all-time daily series of `field`
  entries: AnalyticsEntry[];
  today: string;
  goal?: { target: number; direction?: "atLeast" | "atMost" } | null;
  isNutrition?: boolean;
}

export function formatNumber(n: number): string {
  const abs = Math.abs(n);
  const r = abs >= 1000 ? Math.round(n) : abs >= 10 ? round1(n) : round2(n);
  return r.toLocaleString("en-US");
}

function withUnit(n: number, unit: string): string {
  if (unit === "$") {
    const abs = Math.abs(n);
    const whole = Math.abs(abs - Math.round(abs)) < 0.005;
    return `${n < 0 ? "-" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
  }
  if (/^(kcal|cal|calories|steps|mg)$/i.test(unit)) n = Math.round(n);
  return `${formatNumber(n)}${unit ? ` ${unit}` : ""}`;
}

/**
 * Data-backed observations, most useful first. Each one is only produced when
 * the numbers behind its sentence exist; an empty list is a valid answer.
 */
export function buildInsights(ctx: InsightContext): TrackerInsight[] {
  const out: TrackerInsight[] = [];
  const { points, today, unit, label, mode, polarity } = ctx;
  const what = mode === "sum" ? `daily ${label.toLowerCase()}` : label.toLowerCase();

  // 1. This week vs last week.
  const cmp = comparePeriods(points, 7, today);
  if (cmp.changePct != null && cmp.current.loggedDays >= 3 && cmp.previous.loggedDays >= 3 && Math.abs(cmp.changePct) >= 3) {
    const up = cmp.changePct > 0;
    const good = polarity === "neutral" ? null : up === (polarity === "higher");
    out.push({
      id: "week-change",
      tone: good == null ? "info" : good ? "improvement" : "decline",
      title: `${up ? "Up" : "Down"} ${Math.abs(cmp.changePct)}% vs last week`,
      detail: `Your ${what} averaged ${withUnit(cmp.current.perDay!, unit)} over ${cmp.current.loggedDays} logged days, against ${withUnit(cmp.previous.perDay!, unit)} the week before.`,
    });
  }

  // 2. Goal attainment.
  if (ctx.goal && ctx.goal.target > 0) {
    const recent = filterSeries(points, shiftDay(today, -13), today);
    if (recent.length >= 2) {
      const atMost = ctx.goal.direction === "atMost";
      const hit = recent.filter((p) => (atMost ? p.value <= ctx.goal!.target : p.value >= ctx.goal!.target)).length;
      out.push({
        id: "goal-hits",
        tone: "goal",
        title: `Goal met on ${hit} of ${recent.length} logged days`,
        detail: `Past two weeks, against your ${atMost ? "limit" : "target"} of ${withUnit(ctx.goal.target, unit)}${mode === "sum" ? " per day" : ""}.`,
      });
    }
  }

  // 3. Personal best this week.
  // (The lowest-spend day is not an achievement worth a trophy.)
  if (points.length >= 7 && polarity !== "neutral" && !(polarity === "lower" && unit === "$")) {
    const best = points.reduce((b, p) => (polarity === "higher" ? p.value > b.value : p.value < b.value) ? p : b);
    if (best.day >= shiftDay(today, -6)) {
      out.push({
        id: "personal-best",
        tone: "milestone",
        title: `Personal best: ${withUnit(best.value, unit)}`,
        detail: `${best.label} was your ${polarity === "higher" ? "highest" : "lowest"} ${what} across ${points.length} logged days.`,
      });
    }
  }

  // 4. Streak.
  const streak = currentStreak(points.map((p) => p.day), today);
  if (streak >= 3) {
    out.push({
      id: "streak",
      tone: "milestone",
      title: `${streak}-day logging streak`,
      detail: `You've logged ${label.toLowerCase()} every day since ${dayLabel(shiftDay(today, -(streak - 1)))}${streak >= longestStreak(points.map((p) => p.day)) ? " — your longest yet." : "."}`,
    });
  }

  // 5. Unusual recent day (≥2σ from the rest).
  if (points.length >= 10) {
    const vals = points.map((p) => p.value);
    const m = mean(vals);
    const sd = Math.sqrt(mean(vals.map((v) => (v - m) ** 2)));
    if (sd > 0) {
      const odd = filterSeries(points, shiftDay(today, -13), today).filter((p) => Math.abs(p.value - m) >= 2 * sd).pop();
      if (odd) {
        out.push({
          id: "unusual",
          tone: "unusual",
          title: `Unusual day: ${odd.label}`,
          detail: `${withUnit(odd.value, unit)} is well ${odd.value > m ? "above" : "below"} your typical ${withUnit(round1(m), unit)}.`,
        });
      }
    }
  }

  // 6. Data quality — say when totals are understated.
  const missing = dedupeEntries(ctx.entries).filter((e) => readNumber(e, ctx.field) == null).length;
  if (missing > 0 && ctx.entries.length > 0) {
    out.push({
      id: "missing-values",
      tone: "quality",
      title: `${missing} ${missing === 1 ? "entry has" : "entries have"} no ${label.toLowerCase()}`,
      detail: mode === "sum"
        ? `Daily totals leave those out, so they may read low. Edit the entries in History to fill them in.`
        : `Those entries are skipped in charts and averages.`,
    });
  }
  if (ctx.isNutrition && mode === "sum" && points.length >= 3) {
    const single = points.filter((p) => p.entries === 1).length;
    if (single / points.length >= 0.6) {
      out.push({
        id: "partial-days",
        tone: "quality",
        title: `Most days have one meal logged`,
        detail: `${single} of ${points.length} logged days have a single entry, so daily totals likely cover part of the day, not all of it.`,
      });
    }
  }

  // 7. Consistency over the last 30 days.
  const last30 = filterSeries(points, shiftDay(today, -29), today).length;
  if (points.length >= 5) {
    out.push({
      id: "consistency",
      tone: "info",
      title: `Logged on ${last30} of the last 30 days`,
      detail: last30 >= 20 ? "Consistent logging makes every chart here more reliable." : "More regular logging will make trends and comparisons more reliable.",
    });
  }

  return out;
}

// ── Math ──────────────────────────────────────────────────────────────────────

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}
function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
