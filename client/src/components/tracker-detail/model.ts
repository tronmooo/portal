// Everything the detail tabs derive from one tracker, computed once per render
// of the popup and shared by every tab — so Overview, Trends and Insights can
// never disagree about what "calories per day" is.

import { useMemo } from "react";
import type { Tracker, Goal } from "@shared/schema";
import { BROWSER_TIMEZONE } from "@/lib/queryClient";
import { classifyTrackerPresentation, type TrackerPresentation } from "@shared/tracker-presentation";
import {
  pickPrimaryField, dailySeries, dayModeFor, polarityFor, fieldLabel, fieldUnit,
  numericFieldsWithData, dayKeyOf, dedupeEntries, dayLabel,
  rangeStartDay, daysBetween,
  type DayPoint, type DayMode, type Polarity, type AnalyticsField, type RangeKey,
} from "@shared/tracker-analytics";
import { trackerTheme, type TrackerTheme } from "./theme";

export interface GoalInfo {
  target: number;
  direction: "atLeast" | "atMost";
  unit: string;
  title: string;
}

export interface TrackerModel {
  tracker: Tracker;
  theme: TrackerTheme;
  pres: TrackerPresentation;
  tz: string;
  today: string;
  field: string | null;
  label: string;
  unit: string;
  mode: DayMode;
  polarity: Polarity;
  /** All-time daily series of the primary field. */
  points: DayPoint[];
  entries: Tracker["entries"];
  numericFields: AnalyticsField[];
  isNutrition: boolean;
  isDual: boolean;
  goal: GoalInfo | null;
  /** Logged days regardless of field (for trackers with no numbers). */
  activityDays: DayPoint[];
}

export function goalInfoFor(goals: Goal[] | undefined, trackerId: string): GoalInfo | null {
  const g = (goals || []).find((x) => x && x.trackerId === trackerId && x.status === "active" && typeof x.target === "number" && x.target > 0);
  if (!g) return null;
  const atMost = g.type === "weight_loss" || g.type === "spending_limit"
    || (typeof g.startValue === "number" && g.startValue > g.target);
  return { target: g.target, direction: atMost ? "atMost" : "atLeast", unit: g.unit || "", title: g.title };
}

export function buildTrackerModel(tracker: Tracker, goals: Goal[] | undefined, now: Date = new Date(), tz: string = BROWSER_TIMEZONE): TrackerModel {
  const theme = trackerTheme(tracker);
  const pres = classifyTrackerPresentation(tracker as any);
  const entries = dedupeEntries(tracker.entries || []) as Tracker["entries"];
  const isDual = pres.metricKind === "dual";
  const numericFields = numericFieldsWithData(tracker);
  const picked = isDual ? "systolic" : pres.metricKind === "adherence" ? null : pickPrimaryField(tracker);
  // A text field ("entry", "note") is not a number to chart; such trackers
  // get consistency views built from activityDays instead.
  const field = picked && (isDual || numericFields.some((f) => f.name === picked)) ? picked : null;
  const mode: DayMode = field ? dayModeFor(tracker, field) : "sum";
  const points = field ? dailySeries(entries, field, { mode, tz }) : [];

  // One point per day with ANY entry (value = entry count) — consistency views
  // for trackers that log text or checkmarks rather than numbers.
  const counts = new Map<string, { n: number; ids: string[] }>();
  for (const e of entries) {
    const d = dayKeyOf(e.timestamp, tz);
    const b = counts.get(d) || { n: 0, ids: [] };
    b.n++; b.ids.push(e.id);
    counts.set(d, b);
  }
  const activityDays: DayPoint[] = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, b]) => ({ day, label: dayLabel(day), value: b.n, entries: b.n, entryIds: b.ids }));

  return {
    tracker,
    theme,
    pres,
    tz,
    today: dayKeyOf(now, tz),
    field,
    label: field ? fieldLabel(tracker, field) : tracker.name,
    unit: field ? fieldUnit(tracker, field) : "",
    mode,
    polarity: field ? polarityFor(tracker, field) : "neutral",
    points,
    entries,
    numericFields,
    isNutrition: theme.identity === "nutrition",
    isDual,
    goal: goalInfoFor(goals, tracker.id),
    activityDays,
  };
}

export function useTrackerModel(tracker: Tracker, goals: Goal[] | undefined): TrackerModel {
  return useMemo(() => buildTrackerModel(tracker, goals), [tracker, goals]);
}

// ── The popup's time frame ───────────────────────────────────────────────────

export interface Period {
  key: RangeKey;
  /** First day in the window, or null for all time. */
  from: string | null;
  to: string;
  /** Calendar days in the window (for "all", since the first logged day). */
  days: number;
  /** "last 30 days", "all time" — for sentences. */
  name: string;
  /** "30d", "all time" — for compact labels. */
  short: string;
  /** "30-day", "all-time" — for "vs 30-day avg". */
  adj: string;
}

const PERIOD_TEXT: Record<RangeKey, { name: string; short: string; adj: string }> = {
  "7d": { name: "last 7 days", short: "7d", adj: "7-day" },
  "30d": { name: "last 30 days", short: "30d", adj: "30-day" },
  "90d": { name: "last 90 days", short: "90d", adj: "90-day" },
  "1y": { name: "last 12 months", short: "1y", adj: "12-month" },
  all: { name: "all time", short: "all time", adj: "all-time" },
};

export function periodFor(key: RangeKey, model: Pick<TrackerModel, "today" | "points" | "activityDays">): Period {
  const from = rangeStartDay(key, model.today);
  const first = [model.points[0]?.day, model.activityDays[0]?.day].filter(Boolean).sort()[0] as string | undefined;
  const days = from ? daysBetween(from, model.today) + 1 : first ? daysBetween(first, model.today) + 1 : 1;
  return { key, from, to: model.today, days, ...PERIOD_TEXT[key] };
}

export const PERIOD_OPTIONS: Array<{ value: RangeKey; label: string }> = [
  { value: "7d", label: "7D" }, { value: "30d", label: "30D" }, { value: "90d", label: "90D" },
  { value: "1y", label: "1Y" }, { value: "all", label: "All" },
];
