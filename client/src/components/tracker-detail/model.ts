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
  type DayPoint, type DayMode, type Polarity, type AnalyticsField,
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
