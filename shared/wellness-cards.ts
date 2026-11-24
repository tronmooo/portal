// shared/wellness-cards.ts — what the built-in Wellness cards say about a period.
//
// The Wellness tab (owner, 2026-11-23) reads "how am I doing over time?": each
// function here turns the subject's records and a range into the plain figures
// one card draws. All of them go through `summarize` (shared/wellness-period),
// so the Overview tile, the Health Trends row, a custom widget and the AI
// Insights line state the SAME average for the same measurement (Rule 1).
//
// Rules every builder holds:
//   - a range is a filter: a measurement with nothing in the range still names
//     its last reading (`last`), never "no data" (Rule 4);
//   - nothing is invented: a tile for something never recorded is `tracked:
//     false` and the tab lists it as not tracked, without a zero;
//   - an estimate keeps its ≈.
//
// Pure and deterministic. Pinned by tests/wellness-cards.test.ts.

import { MOOD_SCORES } from "./schema";
import { LAB_PANELS, flagAgainstReference, flagIsConcern } from "./wellness-canon";
import { activityHistory, isWorkoutTracker, type LabPanel, type MetricSeries, type WorkoutGroup } from "./wellness-readout";
import {
  RANGE_WORDS, dailyPoints, formatPct, metricDailyPoints, pctChange, priorLabel, rangeDays, shortDay, sparkValues, summarize,
  type DayPoint, type PeriodSummary, type WellnessRange,
} from "./wellness-period";
import { formatWellnessValue, moveIsGood, resolveSeries } from "./wellness-widgets";
import { isMedicationTracker } from "./medication-doses";
import { resolveCanonicalMetric } from "./wellness-canon";
import { localDayOf } from "./timezone";
import { routeForEntity } from "./entity-routes";

export interface WellnessCardsInput {
  metrics: Map<string, MetricSeries>;
  /** The subject's trackers. */
  trackers: any[];
  range: WellnessRange;
  todayISO: string;
  timezone?: string;
  now?: Date;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const sum = (m: MetricSeries | undefined, i: WellnessCardsInput) => summarize(metricDailyPoints(m), i.range, i.todayISO);

export { moveIsGood };

// ── Nutrition ────────────────────────────────────────────────────────────────

const NUTRITION_TRACKER = /nutrition|calorie|food|meal|diet|macro/i;
const NUTRIENT_FIELDS = {
  calories: /^(calories?|kcal|energy|cals?)$/i,
  protein: /^proteins?(_g|g)?$/i,
  carbs: /^(carbs?|carbohydrates?)(_g|g)?$/i,
  fat: /^(fats?|total ?fat)(_g|g)?$/i,
} as const;
export type Nutrient = keyof typeof NUTRIENT_FIELDS;

export interface NutritionSeries { calories: DayPoint[]; protein: DayPoint[]; carbs: DayPoint[]; fat: DayPoint[]; trackerId: string | null }

/** What was eaten per day, from the subject's food trackers (one entry per food, summed by day). */
const NUTRITION = new WeakMap<object, Map<string, NutritionSeries>>();
export function nutritionSeries(trackers: readonly any[], timezone?: string): NutritionSeries {
  let memo = NUTRITION.get(trackers);
  if (!memo) { memo = new Map(); NUTRITION.set(trackers, memo); }
  const key = timezone ?? "";
  if (!memo.has(key)) memo.set(key, nutritionSeriesNow(trackers, timezone));
  return memo.get(key)!;
}

function nutritionSeriesNow(trackers: readonly any[], timezone?: string): NutritionSeries {
  const rows: Record<Nutrient, Array<{ value: number; at: string }>> = { calories: [], protein: [], carbs: [], fat: [] };
  let trackerId: string | null = null;
  for (const t of trackers) {
    if (!t || !NUTRITION_TRACKER.test(`${t.name || ""} ${t.category || ""}`) || isMedicationTracker(t) || isWorkoutTracker(t)) continue;
    for (const e of t.entries || []) {
      if (!e?.timestamp) continue;
      for (const [field, raw] of Object.entries(e.values || {})) {
        const v = typeof raw === "number" ? raw : parseFloat(String(raw ?? ""));
        if (!Number.isFinite(v) || v < 0) continue;
        for (const k of Object.keys(NUTRIENT_FIELDS) as Nutrient[]) {
          if (NUTRIENT_FIELDS[k].test(field)) { rows[k].push({ value: v, at: e.timestamp }); trackerId = trackerId ?? t.id; }
        }
      }
    }
  }
  return {
    calories: dailyPoints(rows.calories, "sum", timezone), protein: dailyPoints(rows.protein, "sum", timezone),
    carbs: dailyPoints(rows.carbs, "sum", timezone), fat: dailyPoints(rows.fat, "sum", timezone), trackerId,
  };
}

// ── Overview tiles ───────────────────────────────────────────────────────────

export type OverviewTileKey = "sleep" | "activity" | "weight" | "bp" | "hydration" | "nutrition";

export interface OverviewTile {
  key: OverviewTileKey;
  label: string;
  /** Something has been recorded for it, at any time. */
  tracked: boolean;
  /** The figure for the range; null when the range holds nothing. */
  value: string | null;
  /** The comparison under it ("+12% vs prior 30d", "−9 lbs (4.2%)"). */
  delta?: { text: string; good: boolean | null; dir: "up" | "down" | "flat" };
  /** "Last: Oct 21" — the newest reading, of any age. */
  last?: string;
  /** The figure shown is older than the range: its date is always shown with it. */
  stale?: boolean;
  /** A second line that is not a comparison ("3 days logged"). */
  note?: string;
  series: number[];
  href?: string;
}

const dirOf = (n: number): "up" | "down" | "flat" => (Math.round(n * 10) === 0 ? "flat" : n > 0 ? "up" : "down");

/** `judge`: true/false = is more better; a canonical metric = judged against its healthy range; null = not judged. */
function vsPrior(now: number | null, before: number | null, range: WellnessRange, judge: boolean | null | MetricSeries["metric"]): OverviewTile["delta"] | undefined {
  const pct = pctChange(now, before);
  if (pct == null || !priorLabel(range)) return undefined;
  const flat = Math.round(pct) === 0;
  const good = flat || judge == null ? null : typeof judge === "boolean" ? (judge ? pct > 0 : pct < 0) : moveIsGood(judge, before!, now!);
  return { text: `${formatPct(pct)} ${priorLabel(range)}`, good, dir: flat ? "flat" : pct > 0 ? "up" : "down" };
}

/** The newest day both pressures were read on, inside `points` of each. */
function pairedPressure(sys: readonly DayPoint[], dia: readonly DayPoint[]): Array<{ day: string; sys: number; dia: number }> {
  const d = new Map(dia.map((p) => [p.day, p.value]));
  return sys.filter((p) => d.has(p.day)).map((p) => ({ day: p.day, sys: p.value, dia: d.get(p.day)! }));
}

export function overviewTiles(i: WellnessCardsInput): OverviewTile[] {
  const { metrics, range } = i;
  const tiles: OverviewTile[] = [];
  const lastOf = (s: PeriodSummary) => (s.latestEver ? `Last: ${shortDay(s.latestEver.day)}` : undefined);
  const trackerHref = (m: MetricSeries | undefined) => {
    const id = m?.latest?.trackerId;
    return id && !String(id).startsWith("doc:") ? routeForEntity("tracker", String(id)) : undefined;
  };

  // Sleep: the average night.
  {
    const m = metrics.get("sleep_hours"); const s = sum(m, i);
    tiles.push({
      key: "sleep", label: "Sleep", tracked: !!s.latestEver,
      value: s.avg != null ? `${s.estimated ? "≈" : ""}${round1(s.avg)} hrs avg` : null,
      delta: vsPrior(s.avg, s.priorAvg, range, m?.metric ?? null), last: lastOf(s), series: sparkValues(s.points), href: trackerHref(m),
    });
  }
  // Activity: sessions; steps when no workout is tracked.
  {
    const w = resolveSeries({ kind: "workouts" }, { metrics, trackers: i.trackers, timezone: i.timezone })!;
    const s = summarize(w.points, range, i.todayISO);
    const steps = metrics.get("steps"); const st = sum(steps, i);
    if (s.latestEver || !st.latestEver) {
      tiles.push({
        key: "activity", label: "Activity", tracked: !!s.latestEver,
        value: s.entries > 0 ? `${s.entries} session${s.entries === 1 ? "" : "s"}` : null,
        delta: vsPrior(s.entries || null, s.priorEntries || null, range, true), last: lastOf(s), series: sparkValues(s.points), href: "/trackers",
      });
    } else {
      tiles.push({
        key: "activity", label: "Activity", tracked: true,
        value: st.avg != null ? `${Math.round(st.avg).toLocaleString("en-US")} steps avg` : null,
        delta: vsPrior(st.avg, st.priorAvg, range, true), last: lastOf(st), series: sparkValues(st.points), href: trackerHref(steps),
      });
    }
  }
  // Weight: the latest weigh-in, and how far it moved over the range.
  {
    const m = metrics.get("weight"); const s = sum(m, i);
    const unit = m?.metric.unit || "lbs";
    tiles.push({
      key: "weight", label: "Weight", tracked: !!s.latestEver,
      // A weigh-in is a reading: the newest one is shown even when it is older
      // than the range, with its date; the change is the range's own.
      value: s.latestEver ? `${s.latestEver.estimated ? "≈" : ""}${round1(s.latestEver.value)} ${unit}` : null,
      stale: !!s.latestEver && !s.last,
      delta: s.change != null && s.first ? {
        text: `${s.change > 0 ? "+" : s.change < 0 ? "−" : ""}${round1(Math.abs(s.change))} ${unit}${s.changePct != null ? ` (${Math.abs(round1(s.changePct))}%)` : ""}`,
        good: null, dir: dirOf(s.change),
      } : undefined,
      last: lastOf(s), series: sparkValues(s.points), href: trackerHref(m),
    });
  }
  // Blood pressure: the latest reading of both numbers.
  {
    const sysM = metrics.get("bp_systolic");
    const pairs = pairedPressure(metricDailyPoints(sysM), metricDailyPoints(metrics.get("bp_diastolic"))).filter((p) => p.day <= i.todayISO);
    const s = summarize(pairs.map((p) => ({ day: p.day, value: p.sys, n: 1 })), range, i.todayISO);
    const newest = pairs[pairs.length - 1];
    tiles.push({
      key: "bp", label: "Blood Pressure", tracked: pairs.length > 0,
      // The newest reading, dated — shown even when it is older than the range.
      value: newest ? `${Math.round(newest.sys)} / ${Math.round(newest.dia)}` : null,
      stale: !!newest && !s.last,
      last: newest ? `Last: ${shortDay(newest.day)}` : undefined, series: sparkValues(s.points), href: trackerHref(sysM),
    });
  }
  // Hydration: the average day that has any.
  {
    const m = metrics.get("hydration"); const s = sum(m, i);
    tiles.push({
      key: "hydration", label: "Hydration", tracked: !!s.latestEver,
      value: s.avg != null ? `${s.estimated ? "≈" : ""}${Math.round(s.avg)} ${m?.metric.unit || "oz"} avg` : null,
      delta: vsPrior(s.avg, s.priorAvg, range, true), last: lastOf(s), series: sparkValues(s.points), href: trackerHref(m),
    });
  }
  // Nutrition: calories on the average logged day.
  {
    const n = nutritionSeries(i.trackers, i.timezone);
    const s = summarize(n.calories, range, i.todayISO);
    tiles.push({
      key: "nutrition", label: "Nutrition", tracked: !!s.latestEver,
      value: s.avg != null ? `${Math.round(s.avg).toLocaleString("en-US")} kcal avg` : null,
      delta: vsPrior(s.avg, s.priorAvg, range, null),
      note: s.days > 0 ? `${s.days} day${s.days === 1 ? "" : "s"} logged` : undefined,
      last: lastOf(s), series: sparkValues(s.points), href: n.trackerId ? routeForEntity("tracker", String(n.trackerId)) : undefined,
    });
  }
  return tiles;
}

// ── Health trends ────────────────────────────────────────────────────────────

export interface TrendRow {
  key: string;
  label: string;
  /** "213 → 204 lbs". */
  span: string;
  /** "−9 lbs (4.2%)", "Improved", "+0.9 hrs". */
  change: string;
  good: boolean | null;
  series: number[];
  href?: string;
}

const TREND_ORDER = ["weight", "bp_systolic", "sleep_hours", "resting_hr", "hrv", "steps", "hydration", "body_fat", "bmi"];

/**
 * One measurement's readings split by the record they came from. A trend
 * compares a start with an end, and both must come from the SAME tracker: a
 * series merged from a Run tracker and another tracker compared a 140-mile
 * entry with a 1.5-mile run ("−139 mi"), and the row opened the Running
 * tracker, where the 140 was nowhere (QA 2026-11-24). Readings read off
 * documents stay together as one group (they have no tracker to open).
 */
function seriesBySource(m: MetricSeries): Array<{ series: MetricSeries; trackerId: string | null; name: string | null }> {
  const groups = new Map<string, MetricSeries["readings"]>();
  for (const r of m.readings) {
    const key = String(r.trackerId || "").startsWith("doc:") ? "doc:" : String(r.trackerId || "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return [...groups.entries()].map(([key, readings]) => {
    const latest = readings[readings.length - 1] || null;
    return {
      series: { ...m, readings, latest, previous: readings.length > 1 ? readings[readings.length - 2] : null },
      trackerId: key === "doc:" || !key ? null : key,
      name: key === "doc:" ? "Documents" : latest?.trackerName || null,
    };
  });
}

/** Where each measurement started in the range and where it is now — per source tracker. */
export function trendRows(i: WellnessCardsInput, max = 6): TrendRow[] {
  const rows: TrendRow[] = [];
  const ids = [...i.metrics.keys()].filter((id) => {
    const m = i.metrics.get(id)!.metric;
    return !LAB_PANELS.includes(m.panel) && id !== "height" && id !== "bp_diastolic";
  });
  ids.sort((a, b) => (TREND_ORDER.indexOf(a) + 1 || 99) - (TREND_ORDER.indexOf(b) + 1 || 99));
  const dia = i.metrics.get("bp_diastolic");
  const diaParts = dia ? seriesBySource(dia) : [];
  for (const id of ids) {
    if (rows.length >= max) break;
    const parts = seriesBySource(i.metrics.get(id)!);
    const qualifying = parts.filter((p) => { const s = sum(p.series, i); return !!s.first && !!s.last && s.days >= 2; });
    for (const part of qualifying) {
      if (rows.length >= max) break;
      const m = part.series;
      const s = sum(m, i);
      const unit = m.metric.unit;
      const href = part.trackerId ? routeForEntity("tracker", String(part.trackerId)) : undefined;
      // Name the tracker only when the measurement has more than one in the range.
      const suffix = qualifying.length > 1 && part.name ? ` · ${part.name}` : "";
      const keySuffix = qualifying.length > 1 ? `:${part.trackerId ?? "doc"}` : "";
      if (id === "bp_systolic") {
        const diaPart = diaParts.find((d) => d.trackerId === part.trackerId);
        const pairs = pairedPressure(s.points, summarize(metricDailyPoints(diaPart?.series), i.range, i.todayISO).points);
        if (pairs.length < 2 || !dia) continue;
        const a = pairs[0], b = pairs[pairs.length - 1];
        const gs = moveIsGood(m.metric, a.sys, b.sys), gd = moveIsGood(dia.metric, a.dia, b.dia);
        const good = gs === false || gd === false ? (gs === true || gd === true ? null : false) : gs === true || gd === true ? true : null;
        rows.push({
          key: `bp${keySuffix}`, label: `Blood Pressure${suffix}`, span: `${Math.round(a.sys)}/${Math.round(a.dia)} → ${Math.round(b.sys)}/${Math.round(b.dia)}`,
          change: good === true ? "Improved" : good === false ? "Higher" : a.sys === b.sys && a.dia === b.dia ? "No change" : "Mixed",
          good, series: sparkValues(s.points), href,
        });
        continue;
      }
      const change = s.change ?? 0;
      const sign = change > 0 ? "+" : change < 0 ? "−" : "";
      rows.push({
        key: `${id}${keySuffix}`, label: `${m.metric.label}${suffix}`,
        span: `${round1(s.first!.value).toLocaleString("en-US")} → ${formatWellnessValue(round1(s.last!.value), unit === "h" ? "hrs" : unit)}`,
        change: change === 0 ? "No change" : `${sign}${formatWellnessValue(round1(Math.abs(change)), unit === "h" ? "hrs" : unit)}${id === "weight" && s.changePct != null ? ` (${Math.abs(round1(s.changePct))}%)` : ""}`,
        good: moveIsGood(m.metric, s.first!.value, s.last!.value), series: sparkValues(s.points), href,
      });
    }
  }
  return rows;
}

// ── Activity summary ─────────────────────────────────────────────────────────

export interface ActivitySummary {
  sessions: number;
  priorSessions: number | null;
  minutes: number | null;
  minutesEstimated: boolean;
  distance: number | null;
  distanceEstimated: boolean;
  /** kcal burned, from each entry's stored figure; null when none carries one. */
  calories: number | null;
  groups: WorkoutGroup[];
  /** When the last session of ANY age was. */
  lastAt: string | null;
}

const ALL_DAYS = 36500;

export function activitySummary(i: WellnessCardsInput): ActivitySummary {
  const now = i.now ?? new Date();
  const days = rangeDays(i.range);
  const groups = activityHistory(i.trackers, { now, days: days ?? ALL_DAYS });
  const sessions = groups.reduce((a, g) => a + g.sessions, 0);
  const some = (k: "minutes" | "distance") => groups.some((g) => g[k] != null);
  let priorSessions: number | null = null;
  if (days != null) {
    const both = activityHistory(i.trackers, { now, days: days * 2 }).reduce((a, g) => a + g.sessions, 0);
    priorSessions = both - sessions;
  }
  // Calories: the one stored figure per entry (shared/fitness-metrics writes it).
  const cutoff = days != null ? now.getTime() - days * 86400000 : -Infinity;
  let calories = 0, sawCal = false;
  for (const t of i.trackers) {
    if (!isWorkoutTracker(t)) continue;
    for (const e of t.entries || []) {
      const ts = e?.timestamp ? new Date(e.timestamp).getTime() : NaN;
      const c = Number(e?.computed?.caloriesBurned);
      if (Number.isFinite(ts) && ts >= cutoff && ts <= now.getTime() + 86400000 && Number.isFinite(c) && c > 0) { calories += c; sawCal = true; }
    }
  }
  const ever = activityHistory(i.trackers, { now, days: ALL_DAYS });
  return {
    sessions, priorSessions,
    minutes: some("minutes") ? groups.reduce((a, g) => a + (g.minutes ?? 0), 0) : null,
    minutesEstimated: groups.some((g) => g.minutesEstimated),
    distance: some("distance") ? round1(groups.reduce((a, g) => a + (g.distance ?? 0), 0)) : null,
    distanceEstimated: groups.some((g) => g.distanceEstimated),
    calories: sawCal ? Math.round(calories) : null,
    groups, lastAt: ever[0]?.lastAt ?? null,
  };
}

/** "7h 20m" / "45m". */
export function formatMinutes(min: number): string {
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

// ── Sleep & recovery, nutrition ──────────────────────────────────────────────

export interface StatLine {
  key: string;
  label: string;
  /** null = nothing in the range. */
  value: string | null;
  delta?: string;
  good?: boolean | null;
  last?: string;
  series?: number[];
}

function statLine(key: string, label: string, s: PeriodSummary, unit: string, range: WellnessRange, judge: boolean | null | MetricSeries["metric"], digits = 1): StatLine {
  const d = vsPrior(s.avg, s.priorAvg, range, judge);
  return {
    key, label,
    value: s.avg != null ? `${s.estimated ? "≈" : ""}${(digits ? round1(s.avg) : Math.round(s.avg)).toLocaleString("en-US")} ${unit}` : null,
    delta: d?.text, good: d?.good ?? null,
    last: s.latestEver ? `Last: ${shortDay(s.latestEver.day)}` : undefined,
    series: sparkValues(s.points),
  };
}

/** Only lines for things that were ever recorded. */
export function sleepLines(i: WellnessCardsInput): StatLine[] {
  const out: StatLine[] = [];
  const sleep = sum(i.metrics.get("sleep_hours"), i);
  if (sleep.latestEver) {
    out.push(statLine("sleep", "Average sleep", sleep, "hrs", i.range, i.metrics.get("sleep_hours")!.metric));
    if (sleep.days > 0) {
      out.push({ key: "nights", label: "Nights recorded", value: `${sleep.days}` });
      out.push({ key: "range", label: "Shortest · longest", value: `${round1(sleep.min!)} · ${round1(sleep.max!)} hrs` });
    }
  }
  const rhr = sum(i.metrics.get("resting_hr"), i);
  if (rhr.latestEver) out.push(statLine("rhr", "Resting heart rate", rhr, "bpm", i.range, i.metrics.get("resting_hr")!.metric, 0));
  const hrv = sum(i.metrics.get("hrv"), i);
  if (hrv.latestEver) out.push(statLine("hrv", "HRV", hrv, "ms", i.range, true, 0));
  return out;
}

export function nutritionLines(i: WellnessCardsInput): StatLine[] {
  const out: StatLine[] = [];
  const n = nutritionSeries(i.trackers, i.timezone);
  const add = (key: Nutrient, label: string, unit: string) => {
    const s = summarize(n[key], i.range, i.todayISO);
    if (s.latestEver) out.push({ ...statLine(key, label, s, unit, i.range, null, 0), label: `${label} per day` });
  };
  add("calories", "Calories", "kcal"); add("protein", "Protein", "g"); add("carbs", "Carbs", "g"); add("fat", "Fat", "g");
  const cal = summarize(n.calories, i.range, i.todayISO);
  if (cal.days > 0) out.push({ key: "days", label: "Days logged", value: `${cal.days}` });
  const water = sum(i.metrics.get("hydration"), i);
  if (water.latestEver) out.push({ ...statLine("water", "Water per day", water, i.metrics.get("hydration")?.metric.unit || "oz", i.range, true, 0) });
  return out;
}

// ── Insights ─────────────────────────────────────────────────────────────────

export interface Insight { tone: "good" | "info" | "warn"; text: string }

/**
 * What the period did, in sentences — only about data that exists, computed
 * from the same summaries the cards show. Observations, not advice: an
 * out-of-range reading is named with its reference, never diagnosed.
 */
export function periodInsights(i: WellnessCardsInput, labs: readonly LabPanel[] = []): Insight[] {
  const out: Insight[] = [];
  const words = RANGE_WORDS[i.range];
  const over = i.range === "all" ? "across everything recorded" : `over ${words}`;

  const weightM = i.metrics.get("weight");
  const weight = sum(weightM, i);
  if (weight.change != null && Math.abs(weight.change) >= 0.5) {
    const unit = weightM!.metric.unit;
    out.push({ tone: "info", text: `Weight is ${weight.change < 0 ? "down" : "up"} ${round1(Math.abs(weight.change))} ${unit}${weight.changePct != null ? ` (${Math.abs(round1(weight.changePct))}%)` : ""} ${over}.` });
  }

  const act = activitySummary(i);
  if (act.sessions > 0) {
    const pct = pctChange(act.sessions, act.priorSessions || null);
    out.push(pct != null && Math.round(pct) !== 0
      ? { tone: pct > 0 ? "good" : "info", text: `Activity is ${pct > 0 ? "up" : "down"} ${Math.abs(Math.round(pct))}% with ${act.sessions} session${act.sessions === 1 ? "" : "s"} ${over}.` }
      : { tone: "good", text: `You logged ${act.sessions} workout session${act.sessions === 1 ? "" : "s"} ${over}.` });
  }

  const sleep = sum(i.metrics.get("sleep_hours"), i);
  if (sleep.avg != null) {
    const d = sleep.priorAvg != null ? sleep.avg - sleep.priorAvg : null;
    out.push(d != null && Math.abs(d) >= 0.25
      ? { tone: d > 0 ? "good" : "info", text: `Sleep ${d > 0 ? "improved" : "dropped"} by ${round1(Math.abs(d))} hrs per night, to ${round1(sleep.avg)} hrs.` }
      : { tone: "info", text: `Sleep averaged ${round1(sleep.avg)} hrs a night ${over}.` });
  }

  for (const id of ["bp_systolic", "bp_diastolic"] as const) {
    const m = i.metrics.get(id);
    const s = sum(m, i);
    if (!m || !s.last) continue;
    const flag = flagAgainstReference(m.metric, s.last.value);
    if (flagIsConcern(m.metric, flag)) {
      out.push({ tone: "warn", text: `${m.metric.label} blood pressure is ${flag === "low" ? "below" : "above"} the reference range (${Math.round(s.last.value)} mmHg on ${shortDay(s.last.day)}). Worth keeping an eye on.` });
      break;
    }
  }

  const flagged = labs.flatMap((p) => p.rows.filter((r) => r.flag === "low" || r.flag === "high" || r.flag === "elevated"));
  if (flagged.length > 0) {
    out.push({ tone: "warn", text: flagged.length === 1
      ? `One lab value is out of range: ${flagged[0].label} at ${round1(flagged[0].value)} ${flagged[0].unit}.`
      : `${flagged.length} lab values are out of range, including ${flagged[0].label} at ${round1(flagged[0].value)} ${flagged[0].unit}.` });
  }

  const water = sum(i.metrics.get("hydration"), i);
  const wp = pctChange(water.avg, water.priorAvg);
  if (out.length < 5 && water.avg != null && wp != null && Math.abs(wp) >= 5) {
    out.push({ tone: wp > 0 ? "good" : "info", text: `Water is ${wp > 0 ? "up" : "down"} ${Math.abs(Math.round(wp))}%, at ${Math.round(water.avg)} ${i.metrics.get("hydration")!.metric.unit} a day.` });
  }
  return out.slice(0, 5);
}

// ── Mood & energy ────────────────────────────────────────────────────────────

const MOOD_WORD: Record<number, string> = { 8: "Amazing", 7: "Great", 6: "Good", 5: "Okay", 4: "Neutral", 3: "Bad", 2: "Awful", 1: "Terrible" };

export interface MoodSummary {
  entries: number;
  /** "Good" — the word for the average. */
  average: string | null;
  averageScore: number | null;
  delta?: string;
  /** Moods written in the range, most frequent first. */
  counts: Array<{ mood: string; count: number }>;
  /** Average energy (1–5), when entries carry it. */
  energy: number | null;
  series: number[];
  last?: string;
}

export function moodSummary(journal: readonly any[], range: WellnessRange, todayISO: string, timezone?: string): MoodSummary {
  const readings: Array<{ value: number; at: string }> = [];
  const dayOf = (j: any) => String(j?.date || "").slice(0, 10) || localDayOf(j?.createdAt, timezone) || "";
  for (const j of journal) {
    const score = MOOD_SCORES[String(j?.mood ?? "").toLowerCase()];
    if (score && dayOf(j)) readings.push({ value: score, at: dayOf(j) });
  }
  const pts = dailyPoints(readings, "sum", timezone).map((p) => ({ ...p, value: p.value / p.n }));
  const s = summarize(pts, range, todayISO);
  const inRange = new Set(s.points.map((p) => p.day));
  const counts = new Map<string, number>();
  let energy = 0, energyN = 0;
  for (const j of journal) {
    if (!inRange.has(dayOf(j))) continue;
    const mood = String(j?.mood ?? "").toLowerCase();
    if (MOOD_SCORES[mood]) counts.set(mood, (counts.get(mood) || 0) + 1);
    const e = Number(j?.energy);
    if (Number.isFinite(e) && e >= 1 && e <= 5) { energy += e; energyN++; }
  }
  const d = s.avg != null && s.priorAvg != null ? s.avg - s.priorAvg : null;
  return {
    entries: s.entries,
    average: s.avg != null ? MOOD_WORD[Math.max(1, Math.min(8, Math.round(s.avg)))] : null,
    averageScore: s.avg != null ? round1(s.avg) : null,
    delta: d != null && Math.abs(d) >= 0.3 && priorLabel(range) ? `${d > 0 ? "Higher" : "Lower"} ${priorLabel(range)}` : undefined,
    counts: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([mood, count]) => ({ mood: mood[0].toUpperCase() + mood.slice(1), count })),
    energy: energyN ? round1(energy / energyN) : null,
    series: sparkValues(s.points),
    last: s.latestEver ? `Last: ${shortDay(s.latestEver.day)}` : undefined,
  };
}

// ── Symptoms & notes ─────────────────────────────────────────────────────────

const SYMPTOM_TRACKER = /symptom|headache|migraine|\bpain\b|ache\b|nausea|allerg|fatigue|cough|fever|cramp|dizz|heartburn|reflux|anxiety|stress|flare|rash|insomnia/i;

export interface SymptomRow { trackerId: string; name: string; count: number; last?: string; note?: string }

/** Symptom trackers: how often each was logged in the range, and the last note. */
export function symptomRows(i: WellnessCardsInput): SymptomRow[] {
  const rows: SymptomRow[] = [];
  for (const t of i.trackers) {
    if (!t || !SYMPTOM_TRACKER.test(`${t.name || ""} ${t.category || ""}`)) continue;
    if (isMedicationTracker(t) || isWorkoutTracker(t) || resolveCanonicalMetric(t.name, t.category)) continue;
    const entries = (t.entries || []).filter((e: any) => e?.timestamp);
    const pts = dailyPoints(entries.map((e: any) => ({ value: 1, at: e.timestamp })), "sum", i.timezone);
    const s = summarize(pts, i.range, i.todayISO);
    if (!s.latestEver) continue;
    const days = new Set(s.points.map((p) => p.day));
    const noted = [...entries].reverse().find((e: any) => days.has(localDayOf(e.timestamp, i.timezone) || "") && String(e.notes || e.values?.notes || "").trim());
    rows.push({
      trackerId: t.id, name: t.name, count: s.entries,
      last: `Last: ${shortDay(s.latestEver.day)}`,
      note: noted ? String(noted.notes || noted.values?.notes).trim().slice(0, 120) : undefined,
    });
  }
  return rows.sort((a, b) => b.count - a.count).slice(0, 8);
}

// ── Vitals graphs ────────────────────────────────────────────────────────────

export interface VitalGraph { id: string; label: string; unit: string; values: number[]; from: string; to: string; low: string; high: string; href?: string }

/** A graph per vital / body measurement with at least two days in the range. */
export function vitalGraphs(i: WellnessCardsInput): VitalGraph[] {
  const out: VitalGraph[] = [];
  for (const m of i.metrics.values()) {
    if (!["vitals", "body", "sleep"].includes(m.metric.panel) || m.metric.id === "height") continue;
    const s = sum(m, i);
    if (s.days < 2) continue;
    const tid = m.latest?.trackerId;
    out.push({
      id: m.metric.id, label: m.metric.label, unit: m.metric.unit, values: sparkValues(s.points, 80),
      from: shortDay(s.first!.day), to: shortDay(s.last!.day),
      low: formatWellnessValue(round1(s.min!), m.metric.unit), high: formatWellnessValue(round1(s.max!), m.metric.unit),
      ...(tid && !String(tid).startsWith("doc:") ? { href: routeForEntity("tracker", String(tid)) } : {}),
    });
  }
  return out;
}

// ── Health goals ─────────────────────────────────────────────────────────────

const HEALTH_GOAL_TYPES = new Set(["weight_loss", "weight_gain", "fitness_distance", "fitness_frequency"]);
const HEALTH_GOAL_WORDS = /health|fitness|wellness|weight|sleep|water|hydrat|exercise|workout|run|walk|step|nutrition|calorie|protein|meditat|blood|strength/i;

export interface GoalRow { id: string; title: string; progress: string; pct: number | null; deadline?: string }

/** The user's active goals that are about health: by type, by a linked tracker, or by what they are called. */
export function healthGoals(goals: readonly any[], trackers: readonly any[]): GoalRow[] {
  const mine = new Set(trackers.map((t) => t?.id));
  return goals
    .filter((g) => g && g.status === "active" && (
      HEALTH_GOAL_TYPES.has(g.type) || (g.trackerId && mine.has(g.trackerId)) || HEALTH_GOAL_WORDS.test(`${g.title || ""} ${g.category || ""}`)))
    .map((g) => {
      const target = Number(g.target), current = Number(g.current), start = Number(g.startValue);
      let pct: number | null = null;
      if (Number.isFinite(target) && Number.isFinite(current)) {
        // A goal with a starting value measures the distance covered (a weight
        // goal counts DOWN); otherwise current against target.
        pct = Number.isFinite(start) && start !== target ? ((current - start) / (target - start)) * 100 : target !== 0 ? (current / target) * 100 : null;
        if (pct != null) pct = Math.max(0, Math.min(100, Math.round(pct)));
      }
      const unit = g.unit ? ` ${g.unit}` : "";
      return {
        id: String(g.id), title: String(g.title || "Goal"),
        progress: Number.isFinite(current) && Number.isFinite(target) ? `${round1(current).toLocaleString("en-US")} of ${round1(target).toLocaleString("en-US")}${unit}` : "",
        pct, ...(g.deadline ? { deadline: `By ${shortDay(String(g.deadline).slice(0, 10))}` } : {}),
      };
    })
    .slice(0, 8);
}
