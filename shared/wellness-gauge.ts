// ── Reference-range gauge geometry ───────────────────────────────────────────
// The Wellness tab draws a small zone bar under each lab / vitals row: where
// the value sits against its reference range. The range is NOT defined here.
// It is the canonical metric's own `ref` (shared/wellness-canon.ts), the same
// one `flagAgainstReference` uses to put the "High"/"Low" pill on the row, so
// the bar and the pill cannot disagree.
//
// This module only lays that range out on a scale: it picks a sensible window
// around the range (and the value), and splits it into the zones the flag
// function already defines (low · in range · elevated · high). Pure; pinned by
// tests/wellness-gauge.test.ts.
import {
  getCanonicalMetric, flagAgainstReference, flagLabelFor,
  type CanonicalMetric, type RangeFlag,
} from "./wellness-canon";

export interface ReferenceGaugeZone {
  /** Upper edge of this zone on the scale. */
  to: number;
  flag: Exclude<RangeFlag, "unknown">;
  /** "Low" / "In range" / "Elevated" / "High", or the metric's own word ("Athletic"). */
  label: string;
}

export interface ReferenceGauge {
  min: number;
  max: number;
  zones: ReferenceGaugeZone[];
  /** The value's flag — identical to flagAgainstReference(metric, value). */
  flag: Exclude<RangeFlag, "unknown">;
}

/**
 * Zone geometry for one value against its metric's reference range, or null
 * when the metric has no reference range (weight, steps) or the value is not
 * a number.
 */
export function referenceGauge(metricOrId: CanonicalMetric | string, value: number): ReferenceGauge | null {
  const metric = typeof metricOrId === "string" ? getCanonicalMetric(metricOrId) : metricOrId;
  if (!metric || !metric.ref || !Number.isFinite(value)) return null;
  const { low, high, highFrom } = metric.ref;
  if (low == null && high == null) return null;
  const [pMin, pMax] = metric.plausible;

  // A window that shows the range with room on each side, never past what is
  // physically possible.
  let lo: number;
  let hi: number;
  if (low != null && high != null) {
    const pad = (high - low) * 0.6;
    lo = low - pad;
    hi = Math.max(high + pad, highFrom != null ? highFrom + (highFrom - high) : -Infinity);
  } else if (high != null) {
    hi = Math.min(pMax, Math.max(high * 1.6, highFrom != null ? highFrom * 1.2 : -Infinity));
    lo = high - (hi - high) * 1.5;
  } else {
    hi = Math.min(pMax, (low as number) * 2);
    lo = (low as number) - (hi - (low as number)) * 0.6;
  }
  // Keep the value on the bar, with a little margin.
  if (value > hi) hi = value + Math.abs(value) * 0.05;
  if (value < lo) lo = value - Math.abs(value) * 0.05;
  lo = Math.max(pMin, lo);
  hi = Math.min(pMax, hi);
  if (!(hi > lo)) return null;

  // The gauge picks the first zone whose `to` is >= the value. The flag rule
  // is strict at `low` (low iff v < low) and at `highFrom` (high iff
  // v >= highFrom), so those two edges sit a hair below the boundary: a value
  // exactly AT the edge then lands in the same zone the flag puts it in.
  const eps = (hi - lo) * 1e-9;
  const label = (flag: ReferenceGaugeZone["flag"]) =>
    flag === "normal" ? "In range" : flagLabelFor(metric, flag) ?? "";
  const zones: ReferenceGaugeZone[] = [];
  if (low != null && low > lo) zones.push({ to: low - eps, flag: "low", label: label("low") });
  if (high != null) {
    zones.push({ to: high, flag: "normal", label: label("normal") });
    if (highFrom != null && highFrom > high) {
      zones.push({ to: Math.min(hi, highFrom - eps), flag: "elevated", label: label("elevated") });
      if (highFrom < hi) zones.push({ to: hi, flag: "high", label: label("high") });
    } else if (high < hi) {
      zones.push({ to: hi, flag: "high", label: label("high") });
    }
  } else {
    zones.push({ to: hi, flag: "normal", label: label("normal") });
  }

  const flag = flagAgainstReference(metric, value);
  if (flag === "unknown") return null;
  return { min: lo, max: hi, zones, flag };
}

/** The zone a value falls in, read the way the gauge reads it. */
export function gaugeZoneFor(g: ReferenceGauge, value: number): ReferenceGaugeZone {
  return g.zones.find((z) => value <= z.to) || g.zones[g.zones.length - 1];
}
