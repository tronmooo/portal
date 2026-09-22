// shared/domain/tracker-metadata.ts — labels come from what the data IS.
//
// A Stretching tracker rendered as meditation, Mood and Energy showed
// "Scale 100%", and Wellness said "No reading today" beside fresh data,
// because the presentation layer fell back to generic defaults (a field named
// `scale` + a guessed "%" unit) when richer metadata was available. This
// module resolves ONE metadata record per tracker — display label, unit,
// icon, category, aggregation, interpretation — preferring the tracker's own
// metric definition, then its canonical metric, then its shape, and only then
// a category default.
//
// Pure. Pinned by tests/consistency-layer-trackers.test.ts.

import { getDefaultMetricDefinition, type TrackerMetricDefinition, type MetricAggregation } from "../tracker-metric-definition";
import { resolveCanonicalMetric } from "../wellness-canon";
import { resolveTrackerIcon, type TrackerIconCategory } from "./tracker-icons";
import { humanizeFieldName } from "../field-label";

export type Interpretation = "higher_better" | "lower_better" | "target_band" | "neutral";

export interface TrackerMetadata {
  displayLabel: string;
  unit: string;
  /** Unit as shown after a value ("/10", "%", " min"). */
  unitDisplay: string;
  icon: string;
  category: TrackerIconCategory;
  aggregation: MetricAggregation;
  interpretation: Interpretation;
  /** Which source decided the metadata, for debugging drift. */
  source: "definition" | "canonical" | "shape" | "category";
  /** The primary field the value is read from. */
  primaryField: string | null;
  /** True for a 1–N scale (mood, energy) — never rendered as a percentage. */
  isScale: boolean;
  scaleMax?: number;
}

export interface TrackerLike {
  name?: string | null;
  category?: string | null;
  unit?: string | null;
  icon?: string | null;
  fields?: Array<{ name: string; label?: string; type?: string; unit?: string; isPrimary?: boolean }> | null;
  metricDefinition?: Partial<TrackerMetricDefinition> | null;
}

const SCALE_NAME = /\b(mood|energy|stress|pain|anxiety|motivation|satisfaction|rating|score)\b/i;

export function resolveTrackerMetadata(t: TrackerLike | null | undefined): TrackerMetadata {
  const name = String(t?.name ?? "").trim();
  const category = String(t?.category ?? "custom").toLowerCase();
  const iconRes = resolveTrackerIcon({ name, category, icon: t?.icon });
  const primary = (t?.fields || []).find((f) => f.isPrimary) ?? (t?.fields || []).find((f) => f.type === "number" || f.type === "duration") ?? (t?.fields || [])[0] ?? null;
  const def = t?.metricDefinition;
  const isScaleName = SCALE_NAME.test(name) || (primary?.name ?? "").toLowerCase() === "scale";

  // 1. The tracker's own metric definition.
  if (def && (def.unit !== undefined || def.dataType || def.aggregation)) {
    const isScale = def.dataType === "scale" || isScaleName;
    const unit = isScale ? "" : String(def.unit ?? t?.unit ?? primary?.unit ?? "");
    const max = Number((def as any).targets?.max ?? (def as any).scaleMax ?? 10);
    return {
      displayLabel: name || humanizeFieldName(primary?.name ?? "Tracker"),
      unit, unitDisplay: isScale ? `/${Number.isFinite(max) ? max : 10}` : String(def.unitDisplay ?? (unit ? ` ${unit}` : "")),
      icon: iconRes.icon, category: iconRes.category,
      aggregation: (def.aggregation as MetricAggregation) ?? (isScale ? "avg" : "sum"),
      interpretation: (def.direction as Interpretation) ?? "neutral",
      source: "definition", primaryField: primary?.name ?? null, isScale, scaleMax: isScale ? max : undefined,
    };
  }
  // 2. A canonical health metric by name.
  const canon = resolveCanonicalMetric(name, category, primary?.name);
  if (canon && !isScaleName) {
    const agg: MetricAggregation = canon.panel === "hydration" || canon.panel === "activity" ? "sum" : "last";
    return {
      displayLabel: name || canon.label, unit: canon.unit, unitDisplay: canon.unit ? ` ${canon.unit}` : "",
      icon: iconRes.icon, category: iconRes.category, aggregation: agg,
      interpretation: canon.direction === "band" ? "target_band" : canon.direction,
      source: "canonical", primaryField: primary?.name ?? null, isScale: false,
    };
  }
  // 3. A 1–N scale (mood, energy): never a percentage.
  if (isScaleName) {
    return {
      displayLabel: name, unit: "", unitDisplay: "/10", icon: iconRes.icon, category: iconRes.category,
      aggregation: "avg", interpretation: "higher_better", source: "shape", primaryField: primary?.name ?? null, isScale: true, scaleMax: 10,
    };
  }
  // 4. Category defaults.
  const catDef = getDefaultMetricDefinition(category);
  const unit = String(t?.unit ?? primary?.unit ?? catDef.unit ?? "");
  return {
    displayLabel: name || humanizeFieldName(primary?.name ?? "Tracker"), unit,
    unitDisplay: unit ? ` ${unit}` : "", icon: iconRes.icon, category: iconRes.category,
    aggregation: catDef.aggregation, interpretation: (catDef.direction as Interpretation) ?? "neutral",
    source: "category", primaryField: primary?.name ?? null, isScale: false,
  };
}

/** "7/10", "42 min", "3 sessions" — never "Scale 100%". */
export function formatTrackerValue(value: number, meta: TrackerMetadata): string {
  if (!Number.isFinite(value)) return "—";
  const v = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${v}${meta.unitDisplay}`;
}
