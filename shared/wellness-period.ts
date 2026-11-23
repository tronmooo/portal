// shared/wellness-period.ts — "how am I doing over time?", computed once.
//
// Owner, 2026-11-23: the Wellness tab is about a PERIOD (7D / 30D / 90D / 1Y /
// All), not about today: an average, where it started and where it is now,
// and how that compares with the period before. Every tile, trend row, custom
// widget and insight on the tab reads a series through `summarize`, so two
// cards can never state a different average for the same thing (Rule 1).
//
// A series here is one value per local calendar day (`DayPoint`):
//   - an ADDITIVE measure (water, steps, minutes, sessions, dollars) is the
//     day's total;
//   - a READING (weight, blood pressure, sleep) is the day's last reading.
//
// A period with no reading is not "no data": `latestEver` carries the newest
// reading of any age, so a tile says "Last: Oct 21" instead of pretending
// nothing was ever recorded (Rule 4: a range is a filter).
//
// Pure and deterministic. Pinned by tests/wellness-period.test.ts.

import { addDays, localDayOf } from "./timezone";
import type { MetricSeries } from "./wellness-readout";

export const WELLNESS_RANGES = ["7d", "30d", "90d", "1y", "all"] as const;
export type WellnessRange = (typeof WELLNESS_RANGES)[number];
export const DEFAULT_WELLNESS_RANGE: WellnessRange = "30d";

export const RANGE_LABEL: Record<WellnessRange, string> = { "7d": "7D", "30d": "30D", "90d": "90D", "1y": "1Y", all: "All" };
/** "over 30 days", "vs prior 30d". */
export const RANGE_WORDS: Record<WellnessRange, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", "1y": "12 months", all: "all time" };
const RANGE_SHORT: Record<WellnessRange, string> = { "7d": "7d", "30d": "30d", "90d": "90d", "1y": "year", all: "" };

export const isWellnessRange = (x: unknown): x is WellnessRange => typeof x === "string" && (WELLNESS_RANGES as readonly string[]).includes(x);

/** Days in the range; null for all time. */
export function rangeDays(range: WellnessRange): number | null {
  return range === "7d" ? 7 : range === "30d" ? 30 : range === "90d" ? 90 : range === "1y" ? 365 : null;
}

export interface PeriodWindow {
  /** First day of the range (inclusive); null = no lower bound. */
  from: string | null;
  to: string;
  /** The period of the same length just before it; null for all time. */
  priorFrom: string | null;
  priorTo: string | null;
  days: number | null;
}

export function periodWindow(range: WellnessRange, todayISO: string): PeriodWindow {
  const to = String(todayISO).slice(0, 10);
  const days = rangeDays(range);
  if (days == null) return { from: null, to, priorFrom: null, priorTo: null, days: null };
  const from = addDays(to, -(days - 1));
  return { from, to, priorFrom: addDays(from, -days), priorTo: addDays(from, -1), days };
}

export interface DayPoint {
  day: string;
  value: number;
  /** How many entries the day's value was made from. */
  n: number;
  /** The value rests on an estimate (shown with ≈). */
  estimated?: boolean;
}

/** Metrics whose day is a TOTAL of its entries, not its last reading. */
export const ADDITIVE_METRICS: ReadonlySet<string> = new Set(["hydration", "steps", "exercise_minutes", "distance"]);

// A local day per timestamp, fast: one formatter per timezone and a memo per
// timestamp string. (`toLocaleDateString` builds a formatter on every call —
// ten thousand entries took two seconds per range change.)
const DAY_FORMAT = new Map<string, Intl.DateTimeFormat>();
const DAY_MEMO = new Map<string, Map<string, string>>();
function fastLocalDay(at: string, timezone?: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  if (!timezone) return localDayOf(at) || String(at).slice(0, 10);
  let memo = DAY_MEMO.get(timezone);
  if (!memo) { memo = new Map(); DAY_MEMO.set(timezone, memo); }
  const hit = memo.get(at);
  if (hit !== undefined) return hit;
  let day = "";
  try {
    let f = DAY_FORMAT.get(timezone);
    if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }); DAY_FORMAT.set(timezone, f); }
    const d = new Date(at);
    day = isNaN(d.getTime()) ? "" : f.format(d);
  } catch { day = localDayOf(at, timezone) || ""; }
  if (memo.size > 200_000) memo.clear();
  memo.set(at, day);
  return day;
}

/** Raw readings → one point per local day, oldest first. */
export function dailyPoints(
  readings: ReadonlyArray<{ value: number; at: string; isEstimated?: boolean }>,
  mode: "sum" | "last",
  timezone?: string,
): DayPoint[] {
  const byDay = new Map<string, DayPoint & { at: number }>();
  for (const r of readings) {
    if (!Number.isFinite(r.value)) continue;
    const day = fastLocalDay(String(r.at), timezone) || String(r.at).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const at = new Date(r.at).getTime();
    const cur = byDay.get(day);
    if (!cur) { byDay.set(day, { day, value: r.value, n: 1, at, ...(r.isEstimated ? { estimated: true } : {}) }); continue; }
    cur.n += 1;
    if (mode === "sum") {
      cur.value += r.value;
      if (r.isEstimated) cur.estimated = true;
    } else if (at >= cur.at) {
      cur.value = r.value; cur.at = at;
      if (r.isEstimated) cur.estimated = true; else delete cur.estimated;
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map(({ at: _at, ...p }) => p);
}

/** A canonical metric's readings as one point per day. */
const METRIC_POINTS = new WeakMap<object, DayPoint[]>();
export function metricDailyPoints(s: MetricSeries | undefined | null): DayPoint[] {
  if (!s) return [];
  // A series object is built once per readout and never mutated afterwards.
  let pts = METRIC_POINTS.get(s);
  if (!pts) { pts = dailyPoints(s.readings, ADDITIVE_METRICS.has(s.metric.id) ? "sum" : "last", s.timezone); METRIC_POINTS.set(s, pts); }
  return pts;
}

export interface PeriodSummary {
  /** Points inside the range, oldest first. */
  points: DayPoint[];
  /** Days with a value in the range. */
  days: number;
  /** Entries in the range. */
  entries: number;
  avg: number | null;
  total: number | null;
  min: number | null;
  max: number | null;
  first: DayPoint | null;
  last: DayPoint | null;
  /** last − first; null with fewer than two days. */
  change: number | null;
  changePct: number | null;
  /** The same figures for the period just before (null when there is none or it is empty). */
  priorAvg: number | null;
  priorTotal: number | null;
  priorEntries: number;
  /** Newest point of ANY age — what an empty range falls back to naming. */
  latestEver: DayPoint | null;
  estimated: boolean;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarize(all: readonly DayPoint[], range: WellnessRange, todayISO: string): PeriodSummary {
  const w = periodWindow(range, todayISO);
  const points = all.filter((p) => p.day <= w.to && (w.from == null || p.day >= w.from));
  const prior = w.priorFrom && w.priorTo ? all.filter((p) => p.day >= w.priorFrom! && p.day <= w.priorTo!) : [];
  const values = points.map((p) => p.value);
  const first = points[0] ?? null;
  const last = points[points.length - 1] ?? null;
  const change = points.length >= 2 ? last!.value - first!.value : null;
  const upToToday = all.filter((p) => p.day <= w.to);
  return {
    points,
    days: points.length,
    entries: points.reduce((a, p) => a + p.n, 0),
    avg: mean(values),
    total: values.length ? values.reduce((a, b) => a + b, 0) : null,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    first, last, change,
    changePct: change != null && first!.value !== 0 ? (change / Math.abs(first!.value)) * 100 : null,
    priorAvg: mean(prior.map((p) => p.value)),
    priorTotal: prior.length ? prior.reduce((a, p) => a + p.value, 0) : null,
    priorEntries: prior.reduce((a, p) => a + p.n, 0),
    latestEver: upToToday[upToToday.length - 1] ?? null,
    estimated: points.some((p) => p.estimated === true),
  };
}

/** Percent change from `before` to `now`; null when it cannot be stated. */
export function pctChange(now: number | null | undefined, before: number | null | undefined): number | null {
  if (now == null || before == null || !Number.isFinite(now) || !Number.isFinite(before) || before === 0) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

/** "+12%", "−4%", "0%". */
export function formatPct(pct: number): string {
  const r = Math.round(pct);
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}%`;
}

/** "vs prior 30d" — what a comparison is against. Empty for all time. */
export function priorLabel(range: WellnessRange): string {
  return RANGE_SHORT[range] ? `vs prior ${RANGE_SHORT[range]}` : "";
}

/** "Oct 21" for a YYYY-MM-DD day (a calendar day, never shifted by a timezone). */
export function shortDay(day: string | null | undefined): string {
  const s = String(day ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** At most `max` values for a small chart, keeping the first and last. */
export function sparkValues(points: readonly DayPoint[], max = 40): number[] {
  if (points.length <= max) return points.map((p) => p.value);
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)].value);
}
