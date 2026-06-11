/**
 * PR H — Tracker Metric Definition Standard
 *
 * Canonical metadata schema that every tracker must declare so data stays
 * accurate, comparable, and meaningful across all profiles and dashboards.
 *
 * Pillars:
 *   1. Metric identity   — what is being measured, in what unit, with what dataType
 *   2. Aggregation rules — how multiple same-day entries combine
 *   3. Cadence + freshness — how often it should be updated; when it's stale
 *   4. Performance zones — what counts as good, warning, bad (or in-band)
 *   5. Trend window      — default window used for arrow/sparkline computation
 *   6. Cross-links       — references to other app entities (expenses, habits, …)
 *
 * Values are stored in the canonical unit at write time; display units are
 * formatted via `formatMetricValue(value, definition)`.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const METRIC_DATA_TYPES = [
  "number",
  "duration",
  "boolean",
  "scale",
  "count",
  "currency",
  "percent",
] as const;
export type MetricDataType = (typeof METRIC_DATA_TYPES)[number];

export const METRIC_AGGREGATIONS = [
  "sum",
  "avg",
  "last",
  "max",
  "min",
] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

export const METRIC_CADENCES = [
  "daily",
  "weekly",
  "monthly",
  "event",
] as const;
export type MetricCadence = (typeof METRIC_CADENCES)[number];

export const METRIC_DIRECTIONS = [
  "higher_better",
  "lower_better",
  "target_band",
] as const;
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

export const METRIC_TREND_WINDOWS = ["7d", "30d", "90d"] as const;
export type MetricTrendWindow = (typeof METRIC_TREND_WINDOWS)[number];

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export interface MetricTargets {
  /** Lower bound of the "good" zone. */
  good?: number;
  /** Lower bound of the "warning" zone (above bad, below good). */
  warn?: number;
  /** For target_band metrics, an explicit healthy range [min, max]. */
  band?: [number, number];
}

export interface TrackerMetricDefinition {
  /** Canonical name of what's measured. Stable across profiles. */
  metric: string;
  /** Plain-language description of exactly what counts. */
  definition: string;
  /** Canonical storage unit (everything stored in this unit). */
  unit: string;
  /** Compact UI label, e.g. "hrs". */
  unitDisplay: string;
  dataType: MetricDataType;
  aggregation: MetricAggregation;
  cadence: MetricCadence;
  direction: MetricDirection;
  targets?: MetricTargets;
  trendWindow: MetricTrendWindow;
  /** References like "habit:sleep_routine" or "expense:groceries". */
  relatedTo?: string[];
}

// ---------------------------------------------------------------------------
// Zod
// ---------------------------------------------------------------------------

export const metricTargetsSchema = z.object({
  good: z.number().optional(),
  warn: z.number().optional(),
  band: z.tuple([z.number(), z.number()]).optional(),
});

export const trackerMetricDefinitionSchema = z.object({
  metric: z.string().min(1),
  definition: z.string().min(1),
  unit: z.string().min(1),
  unitDisplay: z.string().min(1),
  dataType: z.enum(METRIC_DATA_TYPES),
  aggregation: z.enum(METRIC_AGGREGATIONS),
  cadence: z.enum(METRIC_CADENCES),
  direction: z.enum(METRIC_DIRECTIONS),
  targets: metricTargetsSchema.optional(),
  trendWindow: z.enum(METRIC_TREND_WINDOWS).default("30d"),
  relatedTo: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Category defaults
// ---------------------------------------------------------------------------

/**
 * Canonical default metric definitions per tracker category.
 *
 * Used when:
 *   - The user creates a tracker without specifying full metadata (prefill).
 *   - Backfilling existing trackers that pre-date this standard.
 *
 * These are intentionally conservative defaults. Users can override every
 * field through the tracker creation/edit form.
 */
export const CATEGORY_METRIC_DEFAULTS: Record<string, TrackerMetricDefinition> = {
  health: {
    metric: "Resting heart rate",
    definition: "Beats per minute measured at rest, ideally first thing in the morning",
    unit: "bpm",
    unitDisplay: "bpm",
    dataType: "number",
    aggregation: "avg",
    cadence: "daily",
    direction: "lower_better",
    targets: { good: 60, warn: 70 },
    trendWindow: "30d",
  },
  fitness: {
    metric: "Activity duration",
    definition: "Total minutes of intentional physical activity per day",
    unit: "minutes",
    unitDisplay: "min",
    dataType: "duration",
    aggregation: "sum",
    cadence: "daily",
    direction: "higher_better",
    targets: { good: 30, warn: 15 },
    trendWindow: "7d",
  },
  sleep: {
    metric: "Sleep duration",
    definition: "Total time asleep between bedtime and wake, excluding awake periods",
    unit: "hours",
    unitDisplay: "hrs",
    dataType: "duration",
    aggregation: "sum",
    cadence: "daily",
    direction: "target_band",
    targets: { band: [7, 9] },
    trendWindow: "7d",
  },
  weight: {
    metric: "Body weight",
    definition: "Body weight measured on a scale, ideally same time of day each measurement",
    unit: "lb",
    unitDisplay: "lb",
    dataType: "number",
    aggregation: "last",
    cadence: "daily",
    direction: "target_band",
    trendWindow: "30d",
  },
  mood: {
    metric: "Mood",
    definition: "Subjective mood rating on a 1–10 scale",
    unit: "scale_1_10",
    unitDisplay: "/10",
    dataType: "scale",
    aggregation: "avg",
    cadence: "daily",
    direction: "higher_better",
    targets: { good: 7, warn: 5 },
    trendWindow: "30d",
  },
  nutrition: {
    metric: "Daily calorie intake",
    definition: "Total calories consumed per day across all meals and snacks",
    unit: "kcal",
    unitDisplay: "kcal",
    dataType: "number",
    aggregation: "sum",
    cadence: "daily",
    direction: "target_band",
    trendWindow: "7d",
  },
  productivity: {
    metric: "Deep work time",
    definition: "Minutes of focused, uninterrupted work per day",
    unit: "minutes",
    unitDisplay: "min",
    dataType: "duration",
    aggregation: "sum",
    cadence: "daily",
    direction: "higher_better",
    targets: { good: 120, warn: 60 },
    trendWindow: "7d",
  },
  finance: {
    metric: "Daily spend",
    definition: "Total amount spent per day, in user's home currency",
    unit: "USD",
    unitDisplay: "$",
    dataType: "currency",
    aggregation: "sum",
    cadence: "daily",
    direction: "lower_better",
    trendWindow: "30d",
  },
  custom: {
    metric: "Custom metric",
    definition: "User-defined metric — review the definition before relying on comparisons",
    unit: "unit",
    unitDisplay: "",
    dataType: "number",
    aggregation: "sum",
    cadence: "daily",
    direction: "higher_better",
    trendWindow: "30d",
  },
};

/**
 * Look up the canonical default for a category. Falls back to "custom" if
 * the category is unknown.
 */
export function getDefaultMetricDefinition(
  category: string | undefined,
): TrackerMetricDefinition {
  const key = (category || "custom").toLowerCase();
  return CATEGORY_METRIC_DEFAULTS[key] || CATEGORY_METRIC_DEFAULTS.custom;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type MetricZone = "good" | "warn" | "bad" | "unknown";

/**
 * Classify a single value into a performance zone based on the metric's
 * direction and targets. Returns "unknown" if no targets are configured.
 */
export function classifyMetricValue(
  value: number,
  def: Pick<TrackerMetricDefinition, "direction" | "targets">,
): MetricZone {
  const t = def.targets;
  if (!t) return "unknown";
  if (def.direction === "higher_better") {
    if (typeof t.good === "number" && value >= t.good) return "good";
    if (typeof t.warn === "number" && value >= t.warn) return "warn";
    return "bad";
  }
  if (def.direction === "lower_better") {
    if (typeof t.good === "number" && value <= t.good) return "good";
    if (typeof t.warn === "number" && value <= t.warn) return "warn";
    return "bad";
  }
  // target_band
  if (t.band) {
    const [lo, hi] = t.band;
    if (value >= lo && value <= hi) return "good";
    const span = hi - lo;
    // 20% slack on either side counts as warn
    if (value >= lo - span * 0.2 && value <= hi + span * 0.2) return "warn";
    return "bad";
  }
  return "unknown";
}

export const ZONE_COLORS: Record<MetricZone, { bg: string; text: string; ring: string }> = {
  good: { bg: "bg-emerald-500/10", text: "text-emerald-600 dark:text-emerald-400", ring: "ring-emerald-500/30" },
  warn: { bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-400", ring: "ring-amber-500/30" },
  bad: { bg: "bg-red-500/10", text: "text-red-600 dark:text-red-400", ring: "ring-red-500/30" },
  unknown: { bg: "bg-muted/30", text: "text-muted-foreground", ring: "ring-border" },
};

/** Maximum acceptable age before a tracker entry is considered stale. */
const CADENCE_STALE_HOURS: Record<MetricCadence, number> = {
  daily: 36,
  weekly: 24 * 9,
  monthly: 24 * 40,
  event: Number.POSITIVE_INFINITY, // event-cadence trackers never go stale
};

export function isMetricStale(
  lastEntryAt: string | Date | undefined,
  cadence: MetricCadence,
): boolean {
  if (cadence === "event") return false;
  if (!lastEntryAt) return true;
  const last = typeof lastEntryAt === "string" ? new Date(lastEntryAt) : lastEntryAt;
  const ageHours = (Date.now() - last.getTime()) / 36e5;
  return ageHours > CADENCE_STALE_HOURS[cadence];
}

/**
 * Aggregate a series of values into a single representative value, following
 * the metric's locked aggregation method. Returns NaN for empty input.
 */
export function aggregateValues(
  values: number[],
  aggregation: MetricAggregation,
): number {
  if (values.length === 0) return Number.NaN;
  switch (aggregation) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "last":
      return values[values.length - 1];
    case "max":
      return Math.max(...values);
    case "min":
      return Math.min(...values);
  }
}

export interface TrendResult {
  /** -1, 0, or +1 — direction of recent slope. */
  arrow: -1 | 0 | 1;
  /** Whether the arrow direction is favorable per the metric. */
  favorable: boolean | null;
  /** Percent change vs the prior comparable window, when computable. */
  changePct: number | null;
}

const TREND_WINDOW_DAYS: Record<MetricTrendWindow, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/**
 * Compare the recent window vs the prior same-length window for a series
 * of (date, value) points. Used by tracker cards to render trend arrows.
 */
export function computeTrend(
  points: Array<{ date: string | Date; value: number }>,
  def: Pick<TrackerMetricDefinition, "aggregation" | "direction" | "trendWindow">,
): TrendResult {
  if (points.length === 0) return { arrow: 0, favorable: null, changePct: null };
  const winDays = TREND_WINDOW_DAYS[def.trendWindow];
  const now = Date.now();
  const winMs = winDays * 24 * 3600 * 1000;
  const recent: number[] = [];
  const prior: number[] = [];
  for (const p of points) {
    const t = typeof p.date === "string" ? new Date(p.date).getTime() : p.date.getTime();
    const age = now - t;
    if (age < winMs) recent.push(p.value);
    else if (age < winMs * 2) prior.push(p.value);
  }
  if (recent.length === 0) return { arrow: 0, favorable: null, changePct: null };
  const recentAgg = aggregateValues(recent, def.aggregation);
  if (prior.length === 0) return { arrow: 0, favorable: null, changePct: null };
  const priorAgg = aggregateValues(prior, def.aggregation);
  if (!Number.isFinite(priorAgg) || priorAgg === 0) {
    return { arrow: 0, favorable: null, changePct: null };
  }
  const changePct = ((recentAgg - priorAgg) / Math.abs(priorAgg)) * 100;
  const arrow: -1 | 0 | 1 = changePct > 1 ? 1 : changePct < -1 ? -1 : 0;
  let favorable: boolean | null = null;
  if (def.direction === "higher_better") favorable = arrow === 1;
  else if (def.direction === "lower_better") favorable = arrow === -1;
  else favorable = null; // target_band — direction alone doesn't determine favorability
  return { arrow, favorable, changePct };
}

/** Format a value for display using the metric's unit. */
export function formatMetricValue(
  value: number,
  def: Pick<TrackerMetricDefinition, "dataType" | "unitDisplay">,
): string {
  if (!Number.isFinite(value)) return "—";
  switch (def.dataType) {
    case "currency":
      return `${def.unitDisplay}${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    case "percent":
      return `${value.toFixed(0)}%`;
    case "duration":
      // Stored in canonical unit (minutes or hours). Display as-is.
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${def.unitDisplay}`.trim();
    case "boolean":
      return value > 0 ? "Yes" : "No";
    case "scale":
      return `${value.toFixed(1)}${def.unitDisplay}`;
    case "count":
      return `${Math.round(value).toLocaleString()} ${def.unitDisplay}`.trim();
    case "number":
    default:
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${def.unitDisplay}`.trim();
  }
}
