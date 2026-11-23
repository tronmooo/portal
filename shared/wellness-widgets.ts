// shared/wellness-widgets.ts — cards the user builds for their Wellness tab.
//
// Owner, 2026-11-23: "Built-in widgets should be a starting point, never a
// limitation." A Wellness widget is made three ways — a Widget Idea (one tap),
// the manual builder (pick the data, the calculation and the display; no AI),
// or the AI Builder (a sentence) — and all three produce THIS shape, held to
// `sanitizeWellnessWidget`.
//
// A widget stores no data and no formula text: it is a typed description
//   - METRIC  : one series, one calculation, one display;
//   - COMPARE : one series set against another, day by day ("sleep vs. exercise");
//   - SCORE   : a weighted score the user defines, with its working shown.
// The figures are computed on read from the same records every screen reads
// (Rule 1), so a widget cannot disagree with its source and a deleted record
// simply stops counting.
//
// What a widget may read is the fixed list of SOURCES below. The AI only
// CHOOSES among them; it can never emit a query, a formula or markup. To add a
// new kind of widget, add a source or a calculation here.
//
// A comparison describes a pattern in the user's own records. It is never
// worded as a cause or a medical conclusion (`COMPARE_CAVEAT`).
//
// Pure and deterministic. Pinned by tests/wellness-widgets.test.ts.

import { MOOD_SCORES } from "./schema";
import { CANONICAL_METRICS, getCanonicalMetric, resolveCanonicalMetric, type CanonicalMetric } from "./wellness-canon";
import { isWorkoutTracker, type MetricSeries } from "./wellness-readout";
import {
  ADDITIVE_METRICS, RANGE_WORDS, dailyPoints, formatPct, isWellnessRange, metricDailyPoints, pctChange,
  periodWindow, priorLabel, shortDay, sparkValues, summarize,
  type DayPoint, type PeriodSummary, type WellnessRange,
} from "./wellness-period";
import { addDays, localDayOf } from "./timezone";
import { routeForEntity } from "./entity-routes";

// ── Sources ──────────────────────────────────────────────────────────────────

export const WELLNESS_SOURCE_KINDS = ["metric", "tracker", "workouts", "mood", "spending"] as const;
export type WellnessSourceKind = (typeof WELLNESS_SOURCE_KINDS)[number];

export const WELLNESS_SOURCE_LABELS: Record<WellnessSourceKind, string> = {
  metric: "A health measurement (sleep, weight, blood pressure, a lab value…)",
  tracker: "One of your trackers (its entries, or one of its number fields)",
  workouts: "Workout sessions",
  mood: "Mood from your journal",
  spending: "Health spending from Finance",
};

export interface SeriesRef {
  kind: WellnessSourceKind;
  /** metric: the canonical metric id. tracker: the tracker's name.
   *  workouts / spending: optional text the tracker / expense must contain. */
  key?: string;
  /** tracker only: the number field to read. Absent = count the entries. */
  field?: string;
}

export const WELLNESS_CALCS = ["average", "latest", "total", "count", "min", "max", "change"] as const;
export type WellnessCalc = (typeof WELLNESS_CALCS)[number];
export const WELLNESS_CALC_LABELS: Record<WellnessCalc, string> = {
  average: "Average", latest: "Latest value", total: "Total", count: "Count entries",
  min: "Lowest", max: "Highest", change: "Change (first → last)",
};

export const WELLNESS_DISPLAYS = ["number", "line", "bar", "list"] as const;
export type WellnessDisplay = (typeof WELLNESS_DISPLAYS)[number];
export const WELLNESS_DISPLAY_LABELS: Record<WellnessDisplay, string> = {
  number: "Single number", line: "Line graph", bar: "Bar chart", list: "Compact list",
};

export const WELLNESS_WIDGET_ICONS = ["heart", "dumbbell", "chart", "flame", "target", "star", "book", "wallet", "check", "note"] as const;
export type WellnessWidgetIcon = (typeof WELLNESS_WIDGET_ICONS)[number];

export interface ScorePart {
  source: SeriesRef;
  /** Relative weight (1–10). */
  weight: number;
  /** The value that earns full marks. */
  target: number;
  better: "higher" | "lower";
}

export interface WellnessWidget {
  id: string;
  title: string;
  icon: WellnessWidgetIcon;
  kind: "metric" | "compare" | "score";
  /** metric: the series. compare: the series the days are grouped BY. */
  source?: SeriesRef;
  calc?: WellnessCalc;
  display?: WellnessDisplay;
  /** compare: the series that is compared. */
  other?: SeriesRef;
  /** compare: days at or above this value of `source` form the first group. Absent = the median. */
  threshold?: number;
  /** compare: read `other` on the same day (0) or the day after (1). */
  lag?: 0 | 1;
  /** score: its parts. */
  parts?: ScorePart[];
  /** Its own time range. Absent = the dashboard's range. */
  range?: WellnessRange;
  /** Who described it: the AI Builder, or the user by hand. */
  by?: "ai" | "manual";
}

export const COMPARE_CAVEAT = "A pattern in your own records, not a medical conclusion.";
export const MAX_WELLNESS_WIDGETS = 24;

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const oneOf = <T extends string>(xs: readonly T[], v: unknown): T | null => ((xs as readonly string[]).includes(String(v)) ? (v as T) : null);

export function sanitizeSeriesRef(raw: unknown): SeriesRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = oneOf(WELLNESS_SOURCE_KINDS, r.kind);
  if (!kind) return null;
  if (kind === "metric") {
    const m = getCanonicalMetric(String(r.key ?? ""));
    return m ? { kind, key: m.id } : null;
  }
  if (kind === "tracker") {
    const key = clip(r.key, 60);
    if (!key) return null;
    const field = clip(r.field, 40);
    return { kind, key, ...(field ? { field } : {}) };
  }
  if (kind === "mood") return { kind };
  const key = clip(r.key, 40);
  return { kind, ...(key ? { key } : {}) };
}

/** A widget as stored, as the builder filled it in, or as a model proposed it → a valid widget, or null. */
export function sanitizeWellnessWidget(raw: unknown, fallbackId?: string): WellnessWidget | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = oneOf(["metric", "compare", "score"] as const, r.kind) ?? "metric";
  const title = clip(r.title, 40);
  if (title.length < 2) return null;
  const id = clip(r.id, 40).replace(/[^a-zA-Z0-9_-]/g, "") || fallbackId || "";
  if (!id) return null;
  const icon = oneOf(WELLNESS_WIDGET_ICONS, r.icon) ?? (kind === "score" ? "target" : kind === "compare" ? "chart" : "heart");
  const range = isWellnessRange(r.range) ? r.range : undefined;
  const by: "ai" | "manual" | undefined = r.by === "ai" ? "ai" : r.by === "manual" ? "manual" : undefined;
  const common = { id, title, icon, ...(range ? { range } : {}), ...(by ? { by } : {}) };

  if (kind === "score") {
    const parts: ScorePart[] = [];
    for (const p of Array.isArray(r.parts) ? r.parts.slice(0, 6) : []) {
      const source = sanitizeSeriesRef((p as any)?.source);
      const target = Number((p as any)?.target);
      if (!source || !Number.isFinite(target) || target <= 0) continue;
      const weight = Number((p as any)?.weight);
      parts.push({
        source,
        weight: Number.isFinite(weight) ? Math.min(10, Math.max(1, Math.round(weight))) : 1,
        target: Math.round(target * 100) / 100,
        better: (p as any)?.better === "lower" ? "lower" : "higher",
      });
    }
    return parts.length ? { ...common, kind, parts } : null;
  }

  const source = sanitizeSeriesRef(r.source);
  if (!source) return null;
  if (kind === "compare") {
    const other = sanitizeSeriesRef(r.other);
    if (!other) return null;
    const threshold = Number(r.threshold);
    return {
      ...common, kind, source, other,
      ...(r.threshold != null && r.threshold !== "" && Number.isFinite(threshold) ? { threshold } : {}),
      lag: Number(r.lag) === 1 ? 1 : 0,
    };
  }
  return {
    ...common, kind, source,
    calc: oneOf(WELLNESS_CALCS, r.calc) ?? "average",
    display: oneOf(WELLNESS_DISPLAYS, r.display) ?? "number",
  };
}

// ── Reading a source ─────────────────────────────────────────────────────────

export interface WellnessSourceData {
  /** The subject's canonical series (shared/wellness-readout collectMetrics). */
  metrics: Map<string, MetricSeries>;
  /** The subject's trackers. */
  trackers: any[];
  /** Journal entries; undefined = not loaded. */
  journal?: any[];
  /** Expenses; undefined = not loaded. */
  expenses?: any[];
  timezone?: string;
}

/** How far a value sits outside a metric's healthy range (0 inside it). */
function outsideRef(metric: CanonicalMetric, v: number): number | null {
  if (!metric.ref) return null;
  const { low, high } = metric.ref;
  if (low != null && v < low) return low - v;
  if (high != null && v > high) return v - high;
  return 0;
}

/** Did a move from `first` to `last` go the right way? null when that cannot be said. */
export function moveIsGood(metric: CanonicalMetric, first: number, last: number): boolean | null {
  if (first === last) return null;
  const a = outsideRef(metric, first), b = outsideRef(metric, last);
  if (a != null && b != null) return b < a ? true : b > a ? false : null;
  // Weight has no universal good direction: it depends on the person.
  if (metric.id === "weight" || metric.direction === "band") return null;
  return metric.direction === "higher_better" ? last > first : last < first;
}

export interface ResolvedSeries {
  label: string;
  unit: string;
  points: DayPoint[];
  /** A day's value is a total; a day with nothing is zero, not unknown. */
  additive: boolean;
  /** Is more better? null when it depends (a band, a weight). */
  higherBetter: boolean | null;
  /** A canonical measurement judges a move against its healthy range. */
  metric?: CanonicalMetric;
  /** Where the records live. */
  href?: string;
}

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /\d:\d/.test(v)) return NaN; // a clock time or pace is not a quantity
  const n = parseFloat(String(v ?? "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};
const lc = (s: unknown) => String(s ?? "").toLowerCase();

export function findTrackerByName(trackers: readonly any[], name: string): any | null {
  const want = lc(name).trim();
  if (!want) return null;
  return trackers.find((t) => lc(t?.name).trim() === want) ?? trackers.find((t) => lc(t?.name).includes(want)) ?? null;
}

/** A tracker's number fields, from its declared fields and its entries. */
export function trackerNumberFields(t: any): string[] {
  const out = new Set<string>();
  for (const f of t?.fields || []) if (f?.name && f.type !== "text" && f.type !== "boolean") out.add(String(f.name));
  for (const e of (t?.entries || []).slice(-20)) {
    for (const [k, v] of Object.entries(e?.values || {})) {
      if (/^_|^(notes?|timestamp|source|mood|tags)$/i.test(k)) continue;
      if (Number.isFinite(num(v))) out.add(k);
    }
  }
  return [...out];
}

/** Expenses that are about health when no text is given. */
export const HEALTH_SPENDING = /health|medical|medicine|doctor|dental|dentist|vision|optom|pharmac|prescription|therap|hospital|clinic|copay|gym|fitness|supplement|vitamin|wellness/i;

// One resolution per (list, source): the tab asks for "workout sessions" from
// several cards and on every range change, and the lists are replaced, never
// mutated, when their data changes.
const RESOLVED = new WeakMap<object, Map<string, ResolvedSeries | null>>();

/** The days of a source, or null when the source needs a list that has not loaded. */
export function resolveSeries(ref: SeriesRef, data: WellnessSourceData): ResolvedSeries | null {
  const owner: object | undefined = ref.kind === "metric" ? data.metrics : ref.kind === "mood" ? data.journal : ref.kind === "spending" ? data.expenses : data.trackers;
  if (!owner) return resolveSeriesNow(ref, data);
  let memo = RESOLVED.get(owner);
  if (!memo) { memo = new Map(); RESOLVED.set(owner, memo); }
  const key = `${ref.kind}|${ref.key ?? ""}|${ref.field ?? ""}|${data.timezone ?? ""}`;
  if (!memo.has(key)) memo.set(key, resolveSeriesNow(ref, data));
  return memo.get(key)!;
}

function resolveSeriesNow(ref: SeriesRef, data: WellnessSourceData): ResolvedSeries | null {
  const tz = data.timezone;
  if (ref.kind === "metric") {
    const metric = getCanonicalMetric(ref.key || "");
    if (!metric) return { label: "Unknown measurement", unit: "", points: [], additive: false, higherBetter: null };
    const s = data.metrics.get(metric.id);
    const trackerId = s?.latest?.trackerId;
    return {
      label: metric.label, unit: metric.unit, points: metricDailyPoints(s), metric,
      additive: ADDITIVE_METRICS.has(metric.id),
      higherBetter: metric.direction === "higher_better" ? true : metric.direction === "lower_better" && metric.id !== "weight" ? false : null,
      ...(trackerId && !String(trackerId).startsWith("doc:") ? { href: routeForEntity("tracker", String(trackerId)) } : {}),
    };
  }
  if (ref.kind === "tracker") {
    const t = findTrackerByName(data.trackers, ref.key || "");
    if (!t) return { label: ref.key || "Tracker", unit: "", points: [], additive: true, higherBetter: null };
    const field = ref.field && trackerNumberFields(t).find((f) => lc(f) === lc(ref.field));
    const readings: Array<{ value: number; at: string }> = [];
    for (const e of t.entries || []) {
      if (!e?.timestamp) continue;
      const value = field ? num(e.values?.[field]) : 1;
      if (Number.isFinite(value)) readings.push({ value, at: e.timestamp });
    }
    const unit = field ? String((t.fields || []).find((f: any) => f?.name === field)?.unit || "") : "entries";
    return {
      label: field ? `${t.name} · ${field}` : t.name, unit,
      points: dailyPoints(readings, "sum", tz), additive: true, higherBetter: null, href: routeForEntity("tracker", String(t.id)),
    };
  }
  if (ref.kind === "workouts") {
    const want = lc(ref.key);
    const readings: Array<{ value: number; at: string }> = [];
    for (const t of data.trackers) {
      if (!isWorkoutTracker(t)) continue;
      if (want && !lc(`${t.name} ${t.category}`).includes(want)) continue;
      for (const e of t.entries || []) if (e?.timestamp) readings.push({ value: 1, at: e.timestamp });
    }
    return {
      label: want ? `${ref.key} sessions` : "Workout sessions", unit: "sessions",
      points: dailyPoints(readings, "sum", tz), additive: true, higherBetter: true, href: "/trackers",
    };
  }
  if (ref.kind === "mood") {
    if (!data.journal) return null;
    const readings: Array<{ value: number; at: string }> = [];
    for (const j of data.journal) {
      const score = MOOD_SCORES[lc(j?.mood)];
      const day = String(j?.date || "").slice(0, 10) || localDayOf(j?.createdAt, tz);
      if (score && day) readings.push({ value: score, at: day });
    }
    // Several entries in a day: the day's mood is their mean.
    const days = dailyPoints(readings, "sum", tz).map((p) => ({ ...p, value: Math.round((p.value / p.n) * 10) / 10 }));
    return { label: "Mood", unit: "/ 8", points: days, additive: false, higherBetter: true, href: "/journal" };
  }
  // spending
  if (!data.expenses) return null;
  const want = lc(ref.key);
  const readings: Array<{ value: number; at: string }> = [];
  for (const x of data.expenses) {
    const hay = `${x?.category ?? ""} ${x?.description ?? ""} ${x?.vendor ?? ""} ${(x?.tags || []).join(" ")}`;
    if (want ? !lc(hay).includes(want) : !HEALTH_SPENDING.test(hay)) continue;
    const amount = Number(x?.amount);
    const day = String(x?.date || "").slice(0, 10);
    if (Number.isFinite(amount) && amount > 0 && day) readings.push({ value: amount, at: day });
  }
  return {
    label: want ? `Spending · ${ref.key}` : "Health spending", unit: "$",
    points: dailyPoints(readings, "sum", tz), additive: true, higherBetter: null, href: "/dashboard/finance",
  };
}

/** Lists a widget reads beyond trackers and documents — so its card fetches only those. */
export function wellnessWidgetNeeds(w: WellnessWidget): Array<"journal" | "expenses"> {
  const refs = [w.source, w.other, ...(w.parts || []).map((p) => p.source)].filter(Boolean) as SeriesRef[];
  const out = new Set<"journal" | "expenses">();
  for (const r of refs) { if (r.kind === "mood") out.add("journal"); if (r.kind === "spending") out.add("expenses"); }
  return [...out];
}

// ── What the card shows ──────────────────────────────────────────────────────

export function formatWellnessValue(n: number | null | undefined, unit = ""): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (unit === "$") return `$${Math.round(n).toLocaleString("en-US")}`;
  const body = Math.abs(n) < 10 && !Number.isInteger(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: 1 })
    : Math.round(n).toLocaleString("en-US");
  const one = Math.abs(n) === 1 ? ({ sessions: "session", entries: "entry" } as Record<string, string>)[unit] : undefined;
  return unit ? `${body} ${one ?? unit}` : body;
}

export interface WellnessWidgetRow { key: string; label: string; value: string; sub?: string }

export interface WellnessWidgetView {
  /** The big figure. */
  headline?: { value: string; label: string };
  /** A comparison line under it ("+12% vs prior 30d"). */
  delta?: { text: string; good: boolean | null };
  /** Values for a chart, oldest first. */
  series?: number[];
  chart?: "line" | "bar";
  rows?: WellnessWidgetRow[];
  /** Why there is nothing to show — never a bare "no data". */
  empty?: string;
  /** What was read, in the user's words. */
  sources: string[];
  /** How the figure was worked out. */
  explain: string;
  /** Shown under a comparison. */
  caveat?: string;
  href?: string;
}

/** A widget's value for its calculation, from a period summary. */
export function calcValue(calc: WellnessCalc, s: PeriodSummary): number | null {
  switch (calc) {
    case "average": return s.avg;
    case "latest": return s.last?.value ?? null;
    case "total": return s.total;
    case "count": return s.entries > 0 ? s.entries : null;
    case "min": return s.min;
    case "max": return s.max;
    case "change": return s.change;
  }
}

function emptyText(label: string, range: WellnessRange, s: PeriodSummary): string {
  if (s.latestEver) return `No ${label.toLowerCase()} in ${RANGE_WORDS[range]} · Last: ${shortDay(s.latestEver.day)}`;
  return `Nothing recorded for ${label.toLowerCase()} yet.`;
}

function metricView(w: WellnessWidget, src: ResolvedSeries, range: WellnessRange, today: string): WellnessWidgetView {
  const calc = w.calc ?? "average";
  const display = w.display ?? "number";
  const s = summarize(src.points, range, today);
  const sources = [src.label];
  const per = src.additive && calc === "average" ? " per day logged" : "";
  const explain = `${WELLNESS_CALC_LABELS[calc]}${per} of ${src.label} over ${RANGE_WORDS[range]} (${s.days} day${s.days === 1 ? "" : "s"} with data).`;
  if (s.days === 0) return { empty: emptyText(src.label, range, s), sources, explain, href: src.href };
  const unit = calc === "count" ? "entries" : src.unit;
  const value = calcValue(calc, s);
  const sign = calc === "change" && value != null && value > 0 ? "+" : "";
  const view: WellnessWidgetView = {
    headline: { value: `${s.estimated && calc !== "count" ? "≈" : ""}${sign}${formatWellnessValue(value, unit)}`, label: `${WELLNESS_CALC_LABELS[calc]} · ${RANGE_WORDS[range]}` },
    sources, explain, href: src.href,
  };
  // Against the period before: the same calculation where it can be restated.
  const before = calc === "average" ? s.priorAvg : calc === "total" ? s.priorTotal : calc === "count" ? (s.priorEntries || null) : null;
  const pct = pctChange(value, before);
  if (pct != null && priorLabel(range)) {
    const good = Math.round(pct) === 0 ? null
      : src.metric && !src.additive ? moveIsGood(src.metric, before!, value!)
      : src.higherBetter == null ? null : src.higherBetter ? pct > 0 : pct < 0;
    view.delta = { text: `${formatPct(pct)} ${priorLabel(range)}`, good };
  } else if (calc !== "change" && s.change != null && s.first && s.last) {
    view.delta = { text: `${formatWellnessValue(s.first.value, src.unit)} → ${formatWellnessValue(s.last.value, src.unit)}`, good: null };
  }
  if (display === "line" || display === "bar") {
    if (s.points.length >= 2) { view.series = sparkValues(s.points); view.chart = display; }
  }
  if (display === "list") {
    view.rows = s.points.slice(-6).reverse().map((p) => ({ key: p.day, label: shortDay(p.day), value: `${p.estimated ? "≈" : ""}${formatWellnessValue(p.value, src.unit)}` }));
  }
  return view;
}

/** Every day from `from` to `to`, inclusive. */
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from, i = 0; d <= to && i < 4000; d = addDays(d, 1), i++) out.push(d);
  return out;
}

export const MIN_COMPARE_DAYS = 6;

function compareView(w: WellnessWidget, a: ResolvedSeries, b: ResolvedSeries, range: WellnessRange, today: string): WellnessWidgetView {
  const lag = w.lag === 1 ? 1 : 0;
  const win = periodWindow(range, today);
  const inRange = (day: string) => day <= win.to && (win.from == null || day >= win.from);
  const bByDay = new Map(b.points.map((p) => [p.day, p.value]));
  // An additive measure has a value on every day between its first and last
  // record: a day with no session is zero sessions, not a gap.
  const bFirst = b.points[0]?.day, bLast = b.points[b.points.length - 1]?.day;
  const bOn = (day: string): number | null => {
    const v = bByDay.get(day);
    if (v != null) return v;
    return b.additive && bFirst && bLast && day >= bFirst && day <= today ? 0 : null;
  };
  // The days the condition has a value on: its recorded days — or, for a total
  // (sessions, water), every day since its first record, zero when nothing was logged.
  const aDays: Array<{ day: string; value: number }> = [];
  if (a.additive && a.points.length) {
    const aBy = new Map(a.points.map((p) => [p.day, p.value]));
    const start = win.from && win.from > a.points[0].day ? win.from : a.points[0].day;
    for (const day of eachDay(start, today)) aDays.push({ day, value: aBy.get(day) ?? 0 });
  } else {
    for (const p of a.points) if (inRange(p.day)) aDays.push({ day: p.day, value: p.value });
  }
  const pairs: Array<{ a: number; b: number }> = [];
  for (const p of aDays) {
    const day = lag ? addDays(p.day, 1) : p.day;
    if (day > today) continue;
    const v = bOn(day);
    if (v != null) pairs.push({ a: p.value, b: v });
  }
  const when = lag ? "the day after" : "the same day";
  const sources = [a.label, b.label];
  const sorted = pairs.map((p) => p.a).sort((x, y) => x - y);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  // A total with no threshold splits into "days with any" and "days with none".
  const anyOrNone = a.additive && w.threshold == null;
  const cut = w.threshold ?? (anyOrNone ? (sorted.find((v) => v > 0) ?? 1) : median);
  const hiLabel = anyOrNone ? `Days with ${a.label.toLowerCase()}` : `${a.label} ${formatWellnessValue(cut, a.unit)} or more`;
  const loLabel = anyOrNone ? `Days without` : `${a.label} under ${formatWellnessValue(cut, a.unit)}`;
  const explain = anyOrNone
    ? `Days are split into those with ${a.label.toLowerCase()} and those without. ${b.label} is averaged ${when} for each group, over ${RANGE_WORDS[range]}.`
    : `Days are split by ${a.label} (${formatWellnessValue(cut, a.unit)} or more, and under). ${b.label} is averaged ${when} for each group, over ${RANGE_WORDS[range]}.`;
  const hi = pairs.filter((p) => p.a >= cut), lo = pairs.filter((p) => p.a < cut);
  if (pairs.length < MIN_COMPARE_DAYS || hi.length < 2 || lo.length < 2) {
    return {
      empty: `Not enough days with both yet: ${hi.length} + ${lo.length} of the ${MIN_COMPARE_DAYS} needed (at least 2 in each group).`,
      sources, explain, caveat: COMPARE_CAVEAT,
    };
  }
  const avg = (xs: Array<{ b: number }>) => xs.reduce((s, p) => s + p.b, 0) / xs.length;
  const hiAvg = avg(hi), loAvg = avg(lo);
  const pct = pctChange(hiAvg, loAvg);
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    headline: {
      value: pct != null ? formatPct(pct) : `${round(hiAvg - loAvg) > 0 ? "+" : ""}${formatWellnessValue(round(hiAvg - loAvg), b.unit)}`,
      label: anyOrNone ? `${b.label} ${when}, on days with ${a.label.toLowerCase()}` : `${b.label} ${when}, when ${a.label} is ${formatWellnessValue(cut, a.unit)}+`,
    },
    rows: [
      { key: "hi", label: hiLabel, value: formatWellnessValue(round(hiAvg), b.unit), sub: `${hi.length} days` },
      { key: "lo", label: loLabel, value: formatWellnessValue(round(loAvg), b.unit), sub: `${lo.length} days` },
    ],
    sources, explain, caveat: COMPARE_CAVEAT,
  };
}

/** A source's typical day over a range: the mean of its days, zeros included for a total. */
function typicalDay(src: ResolvedSeries, range: WellnessRange, today: string): number | null {
  const s = summarize(src.points, range, today);
  if (s.days === 0) return null;
  if (!src.additive) return s.avg;
  const win = periodWindow(range, today);
  const from = win.from && win.from > src.points[0].day ? win.from : src.points[0].day;
  return (s.total ?? 0) / Math.max(1, eachDay(from, today).length);
}

function scoreView(w: WellnessWidget, parts: Array<{ part: ScorePart; src: ResolvedSeries }>, range: WellnessRange, today: string): WellnessWidgetView {
  const rows: WellnessWidgetRow[] = [];
  let sum = 0, weights = 0;
  const totalWeight = parts.reduce((a, p) => a + p.part.weight, 0) || 1;
  for (const { part, src } of parts) {
    const v = typicalDay(src, range, today);
    const share = Math.round((part.weight / totalWeight) * 100);
    const goal = `${part.better === "lower" ? "at most" : "target"} ${formatWellnessValue(part.target, src.unit)}${src.additive ? " a day" : ""}`;
    if (v == null) { rows.push({ key: src.label, label: src.label, value: "—", sub: `No data in ${RANGE_WORDS[range]} · left out` }); continue; }
    const score = part.better === "higher"
      ? Math.min(100, (v / part.target) * 100)
      : v <= part.target ? 100 : Math.max(0, 100 - ((v - part.target) / part.target) * 100);
    sum += score * part.weight; weights += part.weight;
    rows.push({ key: src.label, label: src.label, value: `${Math.round(score)}`, sub: `${formatWellnessValue(Math.round(v * 10) / 10, src.unit)}${src.additive ? " a day" : ""} · ${goal} · weight ${share}%` });
  }
  const sources = parts.map((p) => p.src.label);
  const explain = `Each part scores 0–100 against its target over ${RANGE_WORDS[range]}; the score is their weighted average. A part with no data is left out, not counted as zero.`;
  if (weights === 0) return { empty: `None of this score's parts has data in ${RANGE_WORDS[range]}.`, rows, sources, explain };
  return { headline: { value: `${Math.round(sum / weights)}`, label: `out of 100 · ${RANGE_WORDS[range]}` }, rows, sources, explain };
}

/**
 * What a widget's card shows, or null while a list it needs is still loading
 * (the card then shows its loading or error state — never an empty account,
 * Rule 7). `range` is the dashboard's; the widget's own range wins.
 */
export function buildWellnessWidgetView(w: WellnessWidget, data: WellnessSourceData, dashboardRange: WellnessRange, todayISO: string): WellnessWidgetView | null {
  const range = w.range ?? dashboardRange;
  const today = String(todayISO).slice(0, 10);
  if (w.kind === "score") {
    const parts: Array<{ part: ScorePart; src: ResolvedSeries }> = [];
    for (const part of w.parts || []) {
      const src = resolveSeries(part.source, data);
      if (!src) return null;
      parts.push({ part, src });
    }
    return scoreView(w, parts, range, today);
  }
  if (!w.source) return { empty: "This card has no data source.", sources: [], explain: "" };
  const a = resolveSeries(w.source, data);
  if (!a) return null;
  if (w.kind === "compare") {
    if (!w.other) return { empty: "This card has nothing to compare with.", sources: [a.label], explain: "" };
    const b = resolveSeries(w.other, data);
    if (!b) return null;
    return compareView(w, a, b, range, today);
  }
  return metricView(w, a, range, today);
}

/** One line for the Customize list. */
export function describeWellnessWidget(w: WellnessWidget): string {
  const name = (r?: SeriesRef) => !r ? "" : r.kind === "metric" ? (getCanonicalMetric(r.key || "")?.label ?? "Measurement")
    : r.kind === "tracker" ? `${r.key}${r.field ? ` · ${r.field}` : ""}` : r.kind === "workouts" ? (r.key ? `${r.key} sessions` : "Workouts")
    : r.kind === "mood" ? "Mood" : r.key ? `Spending · ${r.key}` : "Health spending";
  const span = w.range ? ` · ${RANGE_WORDS[w.range]}` : "";
  if (w.kind === "score") return `Score from ${(w.parts || []).map((p) => name(p.source)).join(", ")}${span}`;
  if (w.kind === "compare") return `${name(w.other)} against ${name(w.source)}${w.lag ? " the day before" : ""}${span}`;
  return `${name(w.source)} · ${WELLNESS_CALC_LABELS[w.calc ?? "average"]} · ${WELLNESS_DISPLAY_LABELS[w.display ?? "number"]}${span}`;
}

// ── Widget Ideas ─────────────────────────────────────────────────────────────

export interface WellnessWidgetIdea { key: string; hint: string; widget: Omit<WellnessWidget, "id"> }

const M = (key: string): SeriesRef => ({ kind: "metric", key });

export const WELLNESS_WIDGET_IDEAS: readonly WellnessWidgetIdea[] = [
  { key: "sleep-exercise", hint: "Do you train more after a good night?", widget: { title: "Sleep vs. Exercise", icon: "chart", kind: "compare", source: M("sleep_hours"), other: { kind: "workouts" }, lag: 0 } },
  { key: "mood-activity", hint: "Journal mood on days you work out", widget: { title: "Mood vs. Activity", icon: "book", kind: "compare", source: { kind: "workouts" }, other: { kind: "mood" }, lag: 0 } },
  { key: "consistency", hint: "Workout sessions over time", widget: { title: "Exercise Consistency", icon: "dumbbell", kind: "metric", source: { kind: "workouts" }, calc: "count", display: "bar" } },
  { key: "spending", hint: "Healthcare costs from Finance", widget: { title: "Health Spending", icon: "wallet", kind: "metric", source: { kind: "spending" }, calc: "total", display: "bar" } },
  { key: "rhr", hint: "Resting heart rate, first → last", widget: { title: "Resting Heart Rate", icon: "heart", kind: "metric", source: M("resting_hr"), calc: "average", display: "line" } },
  {
    key: "score", hint: "A score you define, with its working shown",
    widget: {
      title: "My Health Score", icon: "target", kind: "score",
      parts: [
        { source: M("sleep_hours"), weight: 4, target: 8, better: "higher" },
        { source: { kind: "workouts" }, weight: 3, target: 0.5, better: "higher" },
        { source: M("hydration"), weight: 3, target: 64, better: "higher" },
      ],
    },
  },
];

// ── A sentence → a widget, by fixed rules ────────────────────────────────────
// What the AI Builder falls back to with no model, a slow model or an answer
// that does not pass `sanitizeWellnessWidget` — so the builder always answers.

const SOURCE_WORDS: Array<{ re: RegExp; ref: SeriesRef; title: string }> = [
  { re: /\bsleep|slept|bed ?time/i, ref: M("sleep_hours"), title: "Sleep" },
  { re: /\bweigh|\bweight\b/i, ref: M("weight"), title: "Weight" },
  { re: /blood pressure|\bbp\b|systolic/i, ref: M("bp_systolic"), title: "Blood Pressure" },
  { re: /\bhrv\b|heart rate variab/i, ref: M("hrv"), title: "HRV" },
  { re: /resting (hr|heart)|heart rate|\bpulse\b/i, ref: M("resting_hr"), title: "Resting Heart Rate" },
  { re: /\bsteps?\b|walk(ing|ed)?\b/i, ref: M("steps"), title: "Steps" },
  { re: /water|hydrat/i, ref: M("hydration"), title: "Hydration" },
  { re: /\bmood|feel(ing)?s?\b|journal/i, ref: { kind: "mood" }, title: "Mood" },
  { re: /spend|spent|cost|expens|\bbills?\b|copay/i, ref: { kind: "spending" }, title: "Health Spending" },
  { re: /work ?outs?|exercis|train(ing|ed)?\b|\bgym\b|\bruns?\b|running|\bran\b|lift|session|activ/i, ref: { kind: "workouts" }, title: "Workouts" },
];

export interface WellnessInferContext { trackerNames?: string[] }
const NUMBER_WORDS: Record<string, number> = { five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function sourcesIn(text: string, ctx: WellnessInferContext): Array<{ at: number; ref: SeriesRef; title: string }> {
  const found: Array<{ at: number; end: number; ref: SeriesRef; title: string }> = [];
  const low = text.toLowerCase();
  const free = (at: number, end: number) => !found.some((f) => at < f.end && end > f.at);
  // The user's own trackers first: every word of the name appears in the sentence.
  for (const name of ctx.trackerNames || []) {
    const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3);
    if (!words.length || !words.every((x) => low.includes(x))) continue;
    // A tracker that IS a canonical measurement is read as that measurement,
    // so "Weight" merges with every other weight source the way the tab does.
    if (resolveCanonicalMetric(name)) continue;
    const at = Math.min(...words.map((x) => low.indexOf(x)));
    const end = Math.max(...words.map((x) => low.indexOf(x) + x.length));
    if (free(at, end)) found.push({ at, end, ref: { kind: "tracker", key: name.trim() }, title: name.trim() });
  }
  for (const s of SOURCE_WORDS) {
    const m = s.re.exec(text);
    if (m && free(m.index, m.index + m[0].length)) found.push({ at: m.index, end: m.index + m[0].length, ref: s.ref, title: s.title });
  }
  // Any other measurement, named in full ("ferritin", "blood oxygen") — whole words only.
  for (const metric of CANONICAL_METRICS) {
    if (metric.label.length < 3) continue;
    const m = new RegExp(`\\b${metric.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(text);
    if (m && free(m.index, m.index + m[0].length)) found.push({ at: m.index, end: m.index + m[0].length, ref: M(metric.id), title: metric.label });
  }
  const seen = new Set<string>();
  return found.sort((x, y) => x.at - y.at).filter((f) => {
    const k = `${f.ref.kind}:${f.ref.key ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function rangeIn(text: string): WellnessRange | undefined {
  if (/\b(week(ly)?|7 ?d(ays)?)\b/i.test(text)) return "7d";
  if (/\b(quarter(ly)?|90 ?d(ays)?|3 months?)\b/i.test(text)) return "90d";
  if (/\b(year(ly)?|12 months?)\b/i.test(text)) return "1y";
  if (/\b(all[- ]time|ever|since i started)\b/i.test(text)) return "all";
  if (/\b(month(ly)?|30 ?d(ays)?)\b/i.test(text)) return "30d";
  return undefined;
}

export function inferWellnessWidgetFromText(text: string, ctx: WellnessInferContext = {}, id = "widget"): WellnessWidget {
  const said = clip(text, 300);
  const found = sourcesIn(said, ctx);
  const range = rangeIn(said);
  const fallback: WellnessWidget = { id, title: "Workouts", icon: "dumbbell", kind: "metric", source: { kind: "workouts" }, calc: "count", display: "bar", by: "ai" };
  const done = (raw: Record<string, unknown>) => sanitizeWellnessWidget({ ...raw, id, by: "ai", ...(range ? { range } : {}) }, id) ?? fallback;

  if (/\bscore\b/i.test(said)) {
    const parts = (found.length ? found : [{ ref: M("sleep_hours") }, { ref: { kind: "workouts" } as SeriesRef }]).slice(0, 5).map(({ ref }) => {
      const idea = WELLNESS_WIDGET_IDEAS.find((i) => i.key === "score")!.widget.parts!.find((p) => p.source.kind === ref.kind && p.source.key === ref.key);
      return idea ?? { source: ref, weight: 1, target: ref.kind === "mood" ? 6 : ref.kind === "workouts" ? 0.5 : ref.key === "steps" ? 8000 : 1, better: "higher" as const };
    });
    return done({ title: "My Health Score", icon: "target", kind: "score", parts });
  }
  if (found.length >= 2 && /\b(vs\.?|versus|compare|against|after|when|whether|affect|tend|relat|correlat|impact)\b/i.test(said)) {
    // "X vs Y", "X after Y", "X when Y": X is what is compared, Y the condition
    // the days are grouped by — unless the sentence opens with the condition.
    const conditionFirst = /^\s*(when|after|if|on days)\b/i.test(said);
    const [first, second] = found;
    const by = conditionFirst ? first : second;
    const what = conditionFirst ? second : first;
    const th = /(\d+(?:\.\d+)?)\s*(?:\+|or more|hours?|hrs?|h\b)/i.exec(said.replace(/\b(five|six|seven|eight|nine|ten)\b/gi, (w) => String(NUMBER_WORDS[w.toLowerCase()])));
    return done({
      title: `${what.title} vs. ${by.title}`.slice(0, 40), icon: "chart", kind: "compare", source: by.ref, other: what.ref,
      ...(th && by.ref.key === "sleep_hours" ? { threshold: Number(th[1]) } : {}),
      lag: /\b(after|next day|following)\b/i.test(said) && by.ref.key !== "sleep_hours" ? 1 : 0,
    });
  }
  const one = found[0] ?? { ref: { kind: "workouts" } as SeriesRef, title: "Workouts" };
  const additive = one.ref.kind !== "mood" && (one.ref.kind !== "metric" || ADDITIVE_METRICS.has(one.ref.key || ""));
  const calc: WellnessCalc =
    /\b(how (many|often)|count|times|frequency|consisten)/i.test(said) ? "count"
    : /\b(total|sum|altogether|how much)\b/i.test(said) && additive ? "total"
    : /\b(latest|current|last|now)\b/i.test(said) ? "latest"
    : /\b(change|lost|gained|progress)\b/i.test(said) ? "change"
    : /\b(lowest|min(imum)?)\b/i.test(said) ? "min"
    : /\b(highest|max(imum)?|best)\b/i.test(said) ? "max"
    : one.ref.kind === "workouts" || one.ref.kind === "tracker" ? "count" : one.ref.kind === "spending" ? "total" : "average";
  const display: WellnessDisplay =
    /\bbar/i.test(said) ? "bar" : /\b(list|entries|log)\b/i.test(said) ? "list"
    : /\b(graph|chart|trend|over time|line|history)\b/i.test(said) ? "line"
    : calc === "count" || calc === "total" ? "bar" : "line";
  const icon: WellnessWidgetIcon = one.ref.kind === "workouts" ? "dumbbell" : one.ref.kind === "mood" ? "book" : one.ref.kind === "spending" ? "wallet" : one.ref.kind === "tracker" ? "chart" : "heart";
  return done({ title: one.title, icon, kind: "metric", source: one.ref, calc, display });
}

// ── Several widgets from one description ─────────────────────────────────────
// "A dashboard with my running distance, weekly sleep average, weight trend and
// whether I exercise more after sleeping eight hours" is four cards.

export const MAX_BUILD_WIDGETS = 6;

/** The fixed-rules reading of a description that may ask for several cards. */
export function inferWellnessWidgetsFromText(text: string, ctx: WellnessInferContext = {}): WellnessWidget[] {
  const said = clip(text, 400);
  const whole = () => [inferWellnessWidgetFromText(said, ctx, "widget-1")];
  // A score names its parts with "and"; it is one card.
  if (/\bscore\b/i.test(said)) return whole();
  const clauses = said.split(/[,;\n]|\band\b|\bplus\b|\balso\b/i).map((c) => c.trim()).filter((c) => c.length >= 3);
  const out: WellnessWidget[] = [];
  const seen = new Set<string>();
  for (const clause of clauses) {
    if (sourcesIn(clause, ctx).length === 0) continue;
    const w = inferWellnessWidgetFromText(clause, ctx, `widget-${out.length + 1}`);
    const key = JSON.stringify([w.kind, w.source, w.other, w.calc]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length >= MAX_BUILD_WIDGETS) break;
  }
  return out.length >= 2 ? out : whole();
}

/**
 * Hold a proposed widget to the user's ACTUAL trackers: a tracker source must
 * name one that exists (its real name is written back, and a field that tracker
 * does not have is dropped to "count entries"). A widget pointing at a tracker
 * the user does not have is refused — it could only ever draw "nothing
 * recorded". Other sources are fixed lists and need no grounding.
 */
export function groundWellnessWidget(w: WellnessWidget, trackers: readonly any[]): WellnessWidget | null {
  let ok = true;
  const ground = (ref: SeriesRef | undefined): SeriesRef | undefined => {
    if (!ref || ref.kind !== "tracker") return ref;
    const t = findTrackerByName(trackers, ref.key || "");
    if (!t) { ok = false; return ref; }
    // A tracker that IS a canonical measurement reads as that measurement, so
    // it merges with every other source of it the way the tab does.
    const canon = !ref.field ? resolveCanonicalMetric(t.name, t.category) : null;
    if (canon) return { kind: "metric", key: canon.id };
    const field = ref.field ? trackerNumberFields(t).find((f) => f.toLowerCase() === String(ref.field).toLowerCase()) : undefined;
    return { kind: "tracker", key: String(t.name), ...(field ? { field } : {}) };
  };
  const next: WellnessWidget = {
    ...w,
    ...(w.source ? { source: ground(w.source) } : {}),
    ...(w.other ? { other: ground(w.other) } : {}),
    ...(w.parts ? { parts: w.parts.map((p) => ({ ...p, source: ground(p.source)! })) } : {}),
  };
  return ok ? sanitizeWellnessWidget(next, w.id) : null;
}

// ── Suggested from what the user actually tracks ─────────────────────────────

export interface WellnessSuggestion { key: string; hint: string; entries: number; widget: Omit<WellnessWidget, "id"> }

const titleCase = (s: string) => clip(s, 30).replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Cards worth offering, read from the records themselves: every tracker and
 * measurement that has entries becomes a card that will show real figures the
 * moment it is added. Nothing is suggested for something with no data.
 */
export function suggestWellnessWidgets(data: WellnessSourceData, existing: ReadonlyArray<Pick<WellnessWidget, "title">> = [], max = 10): WellnessSuggestion[] {
  const out: WellnessSuggestion[] = [];
  const have = new Set(existing.map((w) => w.title.toLowerCase()));
  const push = (s: WellnessSuggestion) => { if (!have.has(s.widget.title.toLowerCase()) && !out.some((o) => o.widget.title === s.widget.title)) out.push(s); };
  const last = (pts: DayPoint[]) => (pts.length ? ` · last ${shortDay(pts[pts.length - 1].day)}` : "");

  for (const m of data.metrics.values()) {
    // Distance and exercise minutes are read off the workouts themselves below.
    if (m.metric.id === "distance" || m.metric.id === "exercise_minutes") continue;
    const pts = metricDailyPoints(m);
    if (pts.length < 2) continue;
    const n = pts.reduce((a, p) => a + p.n, 0);
    const additive = ADDITIVE_METRICS.has(m.metric.id);
    push({
      key: `metric:${m.metric.id}`, entries: n, hint: `${n} readings${last(pts)}`,
      widget: { title: clip(`${m.metric.label} ${additive ? "Per Day" : "Trend"}`, 40), icon: "heart", kind: "metric", source: M(m.metric.id), calc: "average", display: additive ? "bar" : "line" },
    });
  }
  for (const t of data.trackers) {
    const n = (t?.entries || []).length;
    if (!t?.name || n === 0 || resolveCanonicalMetric(t.name, t.category)) continue;
    const workout = isWorkoutTracker(t);
    // Number fields that are not already a health measurement of their own
    // (a Blood Pressure tracker's systolic is offered above, as the measurement).
    const fields = trackerNumberFields(t).filter((f) => !/^(id|sets?|reps?)$/i.test(f) && (workout || !resolveCanonicalMetric(f)));
    if (!workout && fields.length === 0 && trackerNumberFields(t).length > 0) continue;
    const pts = dailyPoints((t.entries as any[]).filter((e) => e?.timestamp).map((e) => ({ value: 1, at: e.timestamp })), "sum", data.timezone);
    const name = titleCase(t.name);
    const icon = workout ? "dumbbell" as const : "chart" as const;
    const counts = fields.map((f) => ({ f, n: (t.entries as any[]).filter((e) => Number.isFinite(num(e?.values?.[f]))).length })).sort((a, b) => b.n - a.n);
    const best = counts[0] && counts[0].n >= 2 ? counts[0] : null;
    // How often: for a workout, and for a tracker with no number to add up.
    if (workout || !best) {
      push({ key: `tracker:${t.id}`, entries: n, hint: `${n} entr${n === 1 ? "y" : "ies"}${last(pts)}`, widget: { title: clip(`${name} Log`, 40), icon, kind: "metric", source: { kind: "tracker", key: t.name }, calc: "count", display: "bar" } });
    }
    // Its busiest number: added up, or averaged when it is a level rather than an amount.
    if (best) {
      const level = /severity|level|rating|score|intensity|pain|mood|rate|bpm|temp|pace|speed/i.test(best.f);
      push({
        key: `tracker:${t.id}:${best.f}`, entries: best.n, hint: `${best.n} values${last(pts)}`,
        widget: { title: clip(`${name} ${titleCase(best.f)}`, 40), icon, kind: "metric", source: { kind: "tracker", key: t.name, field: best.f }, calc: level ? "average" : "total", display: level ? "line" : "bar" },
      });
    }
  }
  return out.sort((a, b) => b.entries - a.entries).slice(0, max);
}
