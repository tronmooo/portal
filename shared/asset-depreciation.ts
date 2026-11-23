// What an asset's value has done and, where there is enough to say so, what it
// is likely to do — pure arithmetic over figures the record already holds
// (purchase price and date, the stored valuation history, the current value).
// Nothing here estimates a value: that is the valuation engine's job.

export interface ValuePoint { at: string; value: number }

const DAY = 86_400_000;
const isoDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);

/**
 * The points of the value graph, oldest first: the purchase (when its price
 * AND a calendar date are on file), every stored valuation that produced a
 * value, and the current value "now". Consecutive points with the same value
 * on the same day are one point.
 */
export function valueSeries(input: {
  history: ReadonlyArray<{ valuedAt?: string | null; value?: number | null; status?: string | null }>;
  purchasePrice?: number | null;
  purchaseDate?: string | null;
  currentValue?: number | null;
  now: Date;
}): ValuePoint[] {
  const out: ValuePoint[] = [];
  if (input.purchasePrice && input.purchasePrice > 0 && isoDay(input.purchaseDate)) {
    out.push({ at: `${input.purchaseDate.slice(0, 10)}T12:00:00.000Z`, value: input.purchasePrice });
  }
  for (const h of input.history) {
    if (!h?.valuedAt || h.value == null || !(Number(h.value) > 0)) continue;
    if (h.status && h.status !== "valued") continue;
    out.push({ at: h.valuedAt, value: Number(h.value) });
  }
  if (input.currentValue && input.currentValue > 0) out.push({ at: input.now.toISOString(), value: input.currentValue });
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out.filter((p, i) => i === 0 || !(p.value === out[i - 1].value && p.at.slice(0, 10) === out[i - 1].at.slice(0, 10)));
}

export const VALUE_RANGES = [
  { key: "1m", label: "1M", days: 30 },
  { key: "3m", label: "3M", days: 91 },
  { key: "1y", label: "1Y", days: 365 },
  { key: "all", label: "All", days: null },
] as const;
export type ValueRangeKey = (typeof VALUE_RANGES)[number]["key"];

/** The points inside a range, with the last point before it carried to the
 *  range's start so the line begins at the edge rather than mid-air. */
export function seriesInRange(points: ReadonlyArray<ValuePoint>, range: ValueRangeKey, now: Date): ValuePoint[] {
  const days = VALUE_RANGES.find((r) => r.key === range)?.days ?? null;
  if (days == null) return [...points];
  const from = new Date(now.getTime() - days * DAY).toISOString();
  const inside = points.filter((p) => p.at >= from);
  const before = points.filter((p) => p.at < from).pop();
  return before ? [{ at: from, value: before.value }, ...inside] : inside;
}

/** The latest move between two different stored values: how much, and since when. */
export function recentChange(points: ReadonlyArray<ValuePoint>): { delta: number; pct: number; since: string } | null {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  for (let i = points.length - 2; i >= 0; i--) {
    if (points[i].value !== last.value) {
      return { delta: last.value - points[i].value, pct: ((last.value - points[i].value) / points[i].value) * 100, since: points[i].at };
    }
  }
  return null;
}

export interface DepreciationProjection {
  /** Yearly loss as a percent of the value at the start of the year. */
  annualRatePct: number;
  /** What it is likely to be worth a year from now at that rate. */
  inOneYear: number;
}

/**
 * Where the value is heading — only when there is enough to say so: a
 * purchase price and date on file, at least six months owned, a value that
 * has actually fallen, and a yearly rate that is plausible (1%–60%). The
 * projection never goes below the salvage value. Otherwise null: no figure is
 * better than an invented one.
 */
export function projectDepreciation(input: {
  purchasePrice?: number | null; purchaseDate?: string | null; currentValue?: number | null;
  salvageValue?: number | null; now: Date;
}): DepreciationProjection | null {
  const paid = Number(input.purchasePrice) || 0;
  const value = Number(input.currentValue) || 0;
  if (!(paid > 0) || !(value > 0) || value >= paid || !isoDay(input.purchaseDate)) return null;
  const bought = Date.parse(`${input.purchaseDate.slice(0, 10)}T12:00:00.000Z`);
  const years = (input.now.getTime() - bought) / (365.25 * DAY);
  if (!Number.isFinite(years) || years < 0.5) return null;
  const keep = Math.pow(value / paid, 1 / years); // share of its value it keeps each year
  const annualRatePct = (1 - keep) * 100;
  if (annualRatePct < 1 || annualRatePct > 60) return null;
  const floor = Math.max(0, Number(input.salvageValue) || 0);
  return { annualRatePct: Math.round(annualRatePct * 10) / 10, inOneYear: Math.max(floor, Math.round(value * keep)) };
}
