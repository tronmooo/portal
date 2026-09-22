// shared/domain/outliers.ts — suspicious values are flagged before they are
// summed.
//
// "Core Workout: 4 sessions, 610 total minutes" reached the page because the
// only guard was the physically-possible range per canonical metric
// (shared/wellness-canon plausible bounds); a 400-minute session is possible
// and still wrong. This module runs the sanity checks every aggregate should
// run first — reasonable duration, unit compatibility, duplicate entries,
// unusual frequency, extreme values — and returns the flagged rows so a
// surface can exclude or annotate them instead of silently including them.
//
// Pure. Pinned by tests/consistency-layer-outliers.test.ts.

export type OutlierReason =
  | "implausible_duration"
  | "unit_mismatch"
  | "duplicate_entry"
  | "unusual_frequency"
  | "extreme_value"
  | "incompatible_measurement";

export interface OutlierEntry {
  id?: string;
  value: number;
  unit?: string | null;
  timestamp: string;
  /** e.g. "duration", "distance", "count", "weight". */
  measurement?: string | null;
}

export interface OutlierFlag {
  index: number;
  entry: OutlierEntry;
  reason: OutlierReason;
  detail: string;
}

export interface OutlierRules {
  /** The measurement the series is supposed to hold. */
  measurement?: string | null;
  /** The unit the series is supposed to hold. */
  unit?: string | null;
  /** Hard ceiling per entry (minutes for durations, miles for distance…). */
  maxPerEntry?: number | null;
  /** Hard floor per entry. */
  minPerEntry?: number | null;
  /** More entries than this on one day is suspicious. */
  maxPerDay?: number | null;
  /** Robust z-score above which a value is extreme. Default 3.5. */
  extremeZ?: number | null;
}

/** Sensible ceilings when the caller has none. */
export const DEFAULT_CEILINGS: Record<string, { maxPerEntry: number; unit: string; maxPerDay?: number }> = {
  duration: { maxPerEntry: 240, unit: "min", maxPerDay: 6 },   // one session longer than 4h is a typo
  distance: { maxPerEntry: 100, unit: "mi", maxPerDay: 6 },
  steps:    { maxPerEntry: 100_000, unit: "steps", maxPerDay: 24 },
  reps:     { maxPerEntry: 1_000, unit: "reps", maxPerDay: 50 },
  weight:   { maxPerEntry: 1_000, unit: "lbs", maxPerDay: 5 },
  water:    { maxPerEntry: 300, unit: "oz", maxPerDay: 30 },
  calories: { maxPerEntry: 10_000, unit: "kcal", maxPerDay: 20 },
  count:    { maxPerEntry: 500, unit: "", maxPerDay: 50 },
};

const UNIT_FAMILY: Record<string, string> = {
  min: "duration", mins: "duration", minutes: "duration", h: "duration", hr: "duration", hrs: "duration", hours: "duration", sec: "duration", s: "duration",
  mi: "distance", miles: "distance", km: "distance", m: "distance", meters: "distance",
  lbs: "weight", lb: "weight", kg: "weight", kgs: "weight",
  oz: "volume", ml: "volume", l: "volume", cups: "volume",
  steps: "steps", reps: "reps", kcal: "calories", cal: "calories",
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Flag suspicious entries. Never mutates; the caller decides whether to
 * exclude flagged rows from a total or just annotate them.
 */
export function detectOutliers(entries: readonly OutlierEntry[], rules: OutlierRules = {}): OutlierFlag[] {
  const flags: OutlierFlag[] = [];
  const measurement = String(rules.measurement ?? "").toLowerCase();
  const defaults = DEFAULT_CEILINGS[measurement];
  const maxPerEntry = rules.maxPerEntry ?? defaults?.maxPerEntry ?? null;
  const minPerEntry = rules.minPerEntry ?? 0;
  const maxPerDay = rules.maxPerDay ?? defaults?.maxPerDay ?? null;
  const expectedUnit = String(rules.unit ?? defaults?.unit ?? "").toLowerCase();
  const expectedFamily = UNIT_FAMILY[expectedUnit] ?? measurement;
  const extremeZ = rules.extremeZ ?? 3.5;

  const byDay = new Map<string, number[]>();
  const seen = new Map<string, number>();
  const finite = entries.map((e) => e.value).filter((v) => Number.isFinite(v));
  const med = finite.length >= 4 ? median(finite) : null;
  const mad = med !== null ? median(finite.map((v) => Math.abs(v - med))) : null;

  entries.forEach((e, index) => {
    const v = Number(e.value);
    if (!Number.isFinite(v)) { flags.push({ index, entry: e, reason: "incompatible_measurement", detail: "not a number" }); return; }
    const unit = String(e.unit ?? "").toLowerCase();
    if (unit && expectedFamily && UNIT_FAMILY[unit] && UNIT_FAMILY[unit] !== expectedFamily) {
      flags.push({ index, entry: e, reason: "unit_mismatch", detail: `${unit} is not a ${expectedFamily} unit` });
      return;
    }
    if (e.measurement && measurement && String(e.measurement).toLowerCase() !== measurement) {
      flags.push({ index, entry: e, reason: "incompatible_measurement", detail: `${e.measurement} logged into a ${measurement} series` });
      return;
    }
    if (maxPerEntry !== null && v > maxPerEntry) {
      flags.push({ index, entry: e, reason: measurement === "duration" ? "implausible_duration" : "extreme_value", detail: `${v} exceeds the ${maxPerEntry} ceiling for one entry` });
      return;
    }
    if (v < minPerEntry) {
      flags.push({ index, entry: e, reason: "extreme_value", detail: `${v} is below ${minPerEntry}` });
      return;
    }
    const key = `${String(e.timestamp).slice(0, 16)}|${v}`;
    const dupOf = seen.get(key);
    if (dupOf !== undefined) {
      flags.push({ index, entry: e, reason: "duplicate_entry", detail: `same value at the same minute as entry ${dupOf}` });
      return;
    }
    seen.set(key, index);
    const day = String(e.timestamp).slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(index);
    byDay.set(day, list);
    if (med !== null && mad !== null && mad > 0) {
      const z = (0.6745 * (v - med)) / mad;
      if (Math.abs(z) > extremeZ) flags.push({ index, entry: e, reason: "extreme_value", detail: `${v} is far from the typical ${med}` });
    }
  });

  if (maxPerDay !== null) {
    for (const [day, idxs] of byDay) {
      if (idxs.length > maxPerDay) {
        for (const index of idxs.slice(maxPerDay)) {
          if (!flags.some((f) => f.index === index)) flags.push({ index, entry: entries[index], reason: "unusual_frequency", detail: `${idxs.length} entries on ${day}` });
        }
      }
    }
  }
  return flags.sort((a, b) => a.index - b.index);
}

export interface SanitizedAggregate {
  total: number;
  count: number;
  flagged: OutlierFlag[];
  /** Total including the flagged rows, for a "raw" footnote. */
  rawTotal: number;
  suspicious: boolean;
}

/** Sum a series with the flagged rows left out. */
export function sanitizedTotal(entries: readonly OutlierEntry[], rules: OutlierRules = {}): SanitizedAggregate {
  const flagged = detectOutliers(entries, rules);
  const bad = new Set(flagged.map((f) => f.index));
  let total = 0, rawTotal = 0, count = 0;
  entries.forEach((e, i) => {
    const v = Number(e.value);
    if (!Number.isFinite(v)) return;
    rawTotal += v;
    if (bad.has(i)) return;
    total += v;
    count += 1;
  });
  return { total: Math.round(total * 100) / 100, count, flagged, rawTotal: Math.round(rawTotal * 100) / 100, suspicious: flagged.length > 0 };
}
