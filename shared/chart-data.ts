// Time-series aggregation for AI-generated charts. Pure + unit-tested so the
// NUMBERS on a chart are provably correct — the previous chart code plotted the
// tracker's primary field (not the metric the user asked for) and never summed
// per day, so "carbs this week" showed the wrong values on sparse, gap-ridden
// bars. This module fixes that: pick the right field, bucket by day/week/month
// across the WHOLE requested range, aggregate correctly (sum vs measurement),
// and report how much real data backed the result.

export type AggMode = "sum" | "avg" | "last";
export type Granularity = "day" | "week" | "month";

// Additive metrics accumulate over a period — the daily/weekly TOTAL is the
// meaningful number (carbs eaten, miles run, dollars spent).
const ADDITIVE_FIELDS = new Set([
  "carbs", "carbohydrates", "carb", "protein", "fat", "fats", "sugar", "sugars",
  "fiber", "sodium", "calories", "cals", "cal", "kcal", "energy",
  "miles", "mileage", "distance", "steps", "km", "kilometers", "laps",
  "amount", "spending", "spend", "cost", "price", "total", "expense",
  "water", "caffeine", "alcohol", "drinks", "servings",
  "minutes", "duration", "reps", "sets", "count", "quantity", "qty",
]);

// Measurement metrics are a reading at a point in time — the LAST reading of the
// day is meaningful; summing them would be nonsense (you don't add up weights).
const MEASURE_FIELDS = new Set([
  "weight", "bodyweight", "bmi", "bodyfat", "bodyfatpercentage", "muscle",
  "systolic", "diastolic", "bp", "bloodpressure", "pulse", "heartrate", "hr",
  "glucose", "bloodsugar", "bloodglucose", "a1c", "cholesterol", "ldl", "hdl",
  "temperature", "temp", "spo2", "oxygen", "respiratoryrate",
  "height", "sleep", "sleephours", "mood", "stress", "rhr", "vo2",
]);

const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Decide how to aggregate a field across a time bucket.
export function classifyMetric(field: string): AggMode {
  const f = norm(field);
  if (MEASURE_FIELDS.has(f)) return "last";
  if (ADDITIVE_FIELDS.has(f)) return "sum";
  // Heuristic fallback for unknown fields: cumulative-sounding → sum, else last.
  if (/(amount|cost|spend|total|distance|step|cal|carb|protein|fat|sugar|mile|rep|set|count|qty|quantity|minute|duration|servings?)/.test(f)) {
    return "sum";
  }
  return "last";
}

// Granularity scales with the window so a chart never has hundreds of bars.
export function pickGranularity(range?: string): Granularity {
  if (range === "3months" || range === "6months") return "week";
  if (range === "year" || range === "all") return "month";
  return "day"; // week, month, undefined
}

function fmt(d: Date, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, ...opts }).format(d);
}

// YYYY-MM-DD in the given timezone.
function dayKey(d: Date, tz: string): string {
  return fmt(d, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
}
function monthKey(d: Date, tz: string): string {
  return dayKey(d, tz).slice(0, 7);
}
// Monday-anchored week key (the date of that week's Monday).
function weekKey(d: Date, tz: string): string {
  const ymd = dayKey(d, tz);
  const [y, m, day] = ymd.split("-").map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, day));
  const dow = (anchor.getUTCDay() + 6) % 7; // 0 = Monday
  anchor.setUTCDate(anchor.getUTCDate() - dow);
  return anchor.toISOString().slice(0, 10);
}

function bucketKey(d: Date, g: Granularity, tz: string): string {
  return g === "day" ? dayKey(d, tz) : g === "week" ? weekKey(d, tz) : monthKey(d, tz);
}

function bucketLabel(key: string, g: Granularity): string {
  if (g === "month") {
    const [y, m] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
  }
  // day & week labels: "Jun 17"
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export interface SeriesPoint { key: string; label: string; value: number | null; count: number }
export interface AggregateResult {
  points: SeriesPoint[];
  usedCount: number;     // number of source entries that fed the chart
  filledBuckets: number; // buckets that have at least one entry
  emptyBuckets: number;  // buckets in-range with no data (gaps)
  totalBuckets: number;
  mode: AggMode;
  firstLabel?: string;
  lastLabel?: string;
}

export interface AggregateOptions {
  since: Date;
  until?: Date;
  granularity: Granularity;
  mode: AggMode;
  tz?: string;
  maxBuckets?: number;
}

// Bucket entries across the FULL [since, until] window (so missing days appear
// as gaps, not silently dropped) and aggregate each bucket per `mode`.
export function aggregateTimeSeries(
  entries: Array<{ date: Date | string | number; value: number }>,
  opts: AggregateOptions,
): AggregateResult {
  const tz = opts.tz || "America/Los_Angeles";
  const until = opts.until || new Date();
  const g = opts.granularity;
  const maxBuckets = opts.maxBuckets ?? 120;

  // Group entry values by bucket key.
  const byBucket = new Map<string, number[]>();
  let usedCount = 0;
  for (const e of entries) {
    const d = e.date instanceof Date ? e.date : new Date(e.date);
    if (isNaN(d.getTime())) continue;
    if (d < opts.since || d > until) continue;
    if (!Number.isFinite(e.value)) continue;
    const k = bucketKey(d, g, tz);
    if (!byBucket.has(k)) byBucket.set(k, []);
    byBucket.get(k)!.push(e.value);
    usedCount++;
  }

  // Walk every bucket in the window so gaps are explicit.
  const keys: string[] = [];
  const cursor = new Date(opts.since.getTime());
  let guard = 0;
  while (cursor <= until && guard < maxBuckets) {
    keys.push(bucketKey(cursor, g, tz));
    if (g === "day") cursor.setDate(cursor.getDate() + 1);
    else if (g === "week") cursor.setDate(cursor.getDate() + 7);
    else cursor.setMonth(cursor.getMonth() + 1);
    guard++;
  }
  // Always include the final bucket (until) even if the cursor stepped past it.
  const lastKey = bucketKey(until, g, tz);
  if (!keys.includes(lastKey)) keys.push(lastKey);
  // De-dup while preserving order.
  const seen = new Set<string>();
  const orderedKeys = keys.filter(k => (seen.has(k) ? false : (seen.add(k), true)));

  let filled = 0, empty = 0;
  const points: SeriesPoint[] = orderedKeys.map(k => {
    const vals = byBucket.get(k) || [];
    let value: number | null = null;
    if (vals.length > 0) {
      filled++;
      if (opts.mode === "sum") value = vals.reduce((s, v) => s + v, 0);
      else if (opts.mode === "avg") value = vals.reduce((s, v) => s + v, 0) / vals.length;
      else value = vals[vals.length - 1]; // last reading in the bucket
      value = Math.round(value * 100) / 100;
    } else {
      empty++;
    }
    return { key: k, label: bucketLabel(k, g), value, count: vals.length };
  });

  const filledPts = points.filter(p => p.value !== null);
  return {
    points,
    usedCount,
    filledBuckets: filled,
    emptyBuckets: empty,
    totalBuckets: points.length,
    mode: opts.mode,
    firstLabel: filledPts[0]?.label,
    lastLabel: filledPts[filledPts.length - 1]?.label,
  };
}

// Resolve which numeric field of a tracker entry the user actually wants to
// plot. Honors an explicit requested field (with light synonym handling), then
// the chart title, then falls back to the tracker's primary/first numeric key.
// This is what stops a "Carbs" chart from secretly plotting calories.
const FIELD_SYNONYMS: Record<string, string[]> = {
  carbs: ["carbs", "carb", "carbohydrate", "carbohydrates"],
  protein: ["protein", "proteins"],
  fat: ["fat", "fats"],
  calories: ["calories", "calorie", "cals", "cal", "kcal"],
  sugar: ["sugar", "sugars"],
  fiber: ["fiber", "fibre"],
  miles: ["miles", "mileage", "distance"],
  steps: ["steps", "step"],
  weight: ["weight", "bodyweight"],
  systolic: ["systolic"],
  diastolic: ["diastolic"],
};

export function pickChartField(
  requested: string | undefined,
  title: string | undefined,
  availableFields: string[],
  primaryField?: string,
): string | undefined {
  const avail = availableFields.filter(Boolean);
  const availNorm = new Map(avail.map(f => [norm(f), f]));

  const tryMatch = (term: string): string | undefined => {
    const t = norm(term);
    if (!t) return undefined;
    if (availNorm.has(t)) return availNorm.get(t);
    // synonym group: if term maps to a canonical group, try each member
    for (const members of Object.values(FIELD_SYNONYMS)) {
      if (members.map(norm).includes(t)) {
        for (const m of members) if (availNorm.has(norm(m))) return availNorm.get(norm(m));
      }
    }
    // partial: an available field that contains the term
    const partial = avail.find(f => norm(f).includes(t) || t.includes(norm(f)));
    return partial;
  };

  // 1) explicit requested field
  if (requested) { const m = tryMatch(requested); if (m) return m; }
  // 2) keyword inside the title (e.g. "Carbs This Week")
  if (title) {
    for (const word of title.split(/\s+/)) {
      const m = tryMatch(word);
      if (m) return m;
    }
  }
  // 3) tracker's declared primary field, if it's numeric/available
  if (primaryField && availNorm.has(norm(primaryField))) return availNorm.get(norm(primaryField));
  // 4) first available field
  return avail[0];
}
