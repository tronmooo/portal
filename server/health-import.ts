// server/health-import.ts
// =============================================================================
// Pure planning core for health-data import.
// =============================================================================
//
// Everything here is a pure function over the wire payload and the user's
// existing trackers — no database, no network — so the interesting behaviour
// (deterministic ids, bounds, value shaping) is unit-testable without a
// Supabase connection. The route in routes.ts does the I/O; this module decides
// what should be written.
//
// The load-bearing idea is the DETERMINISTIC ENTRY ID:
//
//   entryId = uuidv5(`${userId}|${trackerId}|${day}|${provider}`)
//
// which buys three properties at once:
//
//   1. Re-importing the same export updates rows instead of duplicating them —
//      the id collides, so an upsert turns into an UPDATE. No read-before-write,
//      no per-row SELECT, no dedupe index.
//   2. Entries the user logged by hand can never be hit. Those carry
//      randomUUID() ids, which cannot collide with a v5 hash, and the upsert
//      keys on `id` alone. Someone who weighs themselves manually and also
//      imports Apple Health keeps both readings.
//   3. Retrying a failed chunk is free — same inputs, same ids, no duplicates.
//
// Entries are additionally tagged ["health-import", "src:<provider>"] so the
// disconnect/purge path can find them. The tags are provenance, not the dedupe
// key — tracker_entries.tags is an unindexed JSONB column and querying it per
// row would undo the whole point.
// =============================================================================

import { createHash } from "crypto";
import { zonedTimeToUTC, DEFAULT_TIMEZONE } from "../shared/timezone";
import {
  getHealthMetric,
  HEALTH_IMPORT_TAG,
  providerTag,
  type DailyRow,
  type HealthMetricDef,
} from "../shared/health-metrics";

/**
 * Namespace UUID for health-import entry ids. Any fixed v4 UUID works; this one
 * is arbitrary and must never change — changing it would orphan every
 * previously imported entry and re-import them as duplicates.
 */
const HEALTH_IMPORT_NAMESPACE = "6f9d3a1e-4c2b-4f8a-9e3d-2b7c5a1f0e84";

/**
 * RFC 4122 v5 (SHA-1, name-based) UUID. Node's crypto has no uuid helper and
 * the `uuid` package isn't a dependency, so this is the 15-line version.
 */
export function uuidv5(name: string, namespace = HEALTH_IMPORT_NAMESPACE): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(nsBytes).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The stable id for one (user, tracker, day, provider) health entry. */
export function healthEntryId(
  userId: string,
  trackerId: string,
  day: string,
  provider: string,
): string {
  return uuidv5(`${userId}|${trackerId}|${day}|${provider}`);
}

/** Tags stamped on every imported entry. */
export function healthEntryTags(provider: string): string[] {
  return [HEALTH_IMPORT_TAG, providerTag(provider)];
}

// -----------------------------------------------------------------------------
// Bounds
// -----------------------------------------------------------------------------
// A health export is machine-generated and mostly trustworthy, but calibration
// glitches do occur (a chest strap reporting 700 bpm, a scale reporting 0). The
// tracker-entries route rejects the whole request on an out-of-range value;
// that is wrong here — one bad sample must never abort an import of 30,000 good
// ones. We drop the offending row and report it in `skipped`.

interface Bound { min: number; max: number }

const BOUNDS: Record<string, Bound> = {
  steps: { min: 0, max: 200000 },
  distance_walked: { min: 0, max: 300 },
  active_energy: { min: 0, max: 20000 },
  exercise_minutes: { min: 0, max: 1440 },
  heart_rate: { min: 20, max: 250 },
  resting_heart_rate: { min: 20, max: 200 },
  hrv: { min: 1, max: 500 },
  vo2_max: { min: 5, max: 100 },
  blood_oxygen: { min: 50, max: 100 },
  respiratory_rate: { min: 4, max: 80 },
  sleep: { min: 0, max: 24 },
  weight: { min: 2, max: 1000 },
  body_fat: { min: 1, max: 75 },
  bmi: { min: 5, max: 100 },
  blood_pressure: { min: 40, max: 300 },
  blood_glucose: { min: 10, max: 1000 },
  body_temp: { min: 80, max: 115 },
  hydration: { min: 0, max: 1000 },
  mindful_minutes: { min: 0, max: 1440 },
  dietary_energy: { min: 0, max: 20000 },
};

/** Secondary bound for the two-valued metric (diastolic). */
const SECOND_BOUNDS: Record<string, Bound> = {
  blood_pressure: { min: 20, max: 200 },
};

export function isWithinBounds(metric: HealthMetricDef, row: DailyRow): boolean {
  const b = BOUNDS[metric.id];
  if (b && (!Number.isFinite(row.value) || row.value < b.min || row.value > b.max)) return false;
  if (row.value2 != null) {
    const b2 = SECOND_BOUNDS[metric.id];
    if (b2 && (!Number.isFinite(row.value2) || row.value2 < b2.min || row.value2 > b2.max)) return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// Value shaping
// -----------------------------------------------------------------------------

/**
 * The `values` object written into the tracker entry. Keys are the registry's
 * field names, which match shared/tracker-shapes.ts, so the entry renders with
 * the right labels and units everywhere.
 */
export function buildEntryValues(metric: HealthMetricDef, row: DailyRow): Record<string, number> {
  const values: Record<string, number> = { [metric.field]: row.value };
  const extra = metric.extraFields?.[0];
  if (extra && row.value2 != null) values[extra] = row.value2;
  return values;
}

/**
 * Noon on `day` in the user's timezone, as an ISO instant.
 *
 * Health data is date-granular, so we have to pick a time of day. Midnight is
 * the wrong choice — any renderer even an hour off would show the entry on the
 * adjacent day — and so is a fixed noon UTC, because real offsets span UTC-12
 * to UTC+14, a 26-hour range that no single UTC hour can straddle (a Kiribati
 * user at UTC+14 would see noon-UTC entries land the following day).
 *
 * Anchoring at noon in the user's OWN zone sidesteps the range entirely: the
 * entry reads as midday to the only person who looks at it, with ~12 hours of
 * slack either side. zonedTimeToUTC handles DST transitions, which is why we
 * reuse it rather than doing the offset arithmetic here.
 */
export function dayToTimestamp(day: string, timezone: string = DEFAULT_TIMEZONE): string {
  return zonedTimeToUTC(day, 12, 0, timezone).toISOString();
}

// -----------------------------------------------------------------------------
// Planning
// -----------------------------------------------------------------------------

export interface PlannedEntry {
  entryId: string;
  trackerId: string;
  metricId: string;
  day: string;
  values: Record<string, number>;
  tags: string[];
  timestamp: string;
}

export interface PlanResult {
  entries: PlannedEntry[];
  /** Rows dropped, with a reason, so the UI can be honest about what was skipped. */
  skipped: Array<{ metric: string; day: string; reason: string }>;
  /** Metric ids present in the payload, in first-seen order. */
  metricIds: string[];
}

/**
 * Turn validated wire rows into the exact entries to upsert.
 *
 * `trackerIdFor` resolves a metric to a tracker id. The caller supplies it
 * because find-or-create needs the database; keeping it as a parameter is what
 * lets this whole function stay pure and testable.
 */
export function planHealthEntries(
  rows: DailyRow[],
  opts: {
    userId: string;
    provider: string;
    trackerIdFor: (metricId: string) => string | undefined;
    timezone?: string;
  },
): PlanResult {
  const entries: PlannedEntry[] = [];
  const skipped: PlanResult["skipped"] = [];
  const metricIds: string[] = [];
  const seenMetrics = new Set<string>();
  // Guards against a payload that repeats the same (metric, day) — last wins,
  // which matches what a second import of the same day would do anyway.
  const byEntryId = new Map<string, number>();
  const tags = healthEntryTags(opts.provider);

  for (const row of rows) {
    const metric = getHealthMetric(row.metric);
    if (!metric) {
      skipped.push({ metric: row.metric, day: row.day, reason: "unknown metric" });
      continue;
    }
    if (!seenMetrics.has(metric.id)) {
      seenMetrics.add(metric.id);
      metricIds.push(metric.id);
    }
    if (!isWithinBounds(metric, row)) {
      skipped.push({ metric: row.metric, day: row.day, reason: "value out of range" });
      continue;
    }
    const trackerId = opts.trackerIdFor(metric.id);
    if (!trackerId) {
      skipped.push({ metric: row.metric, day: row.day, reason: "tracker unavailable" });
      continue;
    }

    const entryId = healthEntryId(opts.userId, trackerId, row.day, opts.provider);
    const planned: PlannedEntry = {
      entryId,
      trackerId,
      metricId: metric.id,
      day: row.day,
      values: buildEntryValues(metric, row),
      tags,
      timestamp: dayToTimestamp(row.day, opts.timezone),
    };

    const existingIdx = byEntryId.get(entryId);
    if (existingIdx != null) entries[existingIdx] = planned;
    else {
      byEntryId.set(entryId, entries.length);
      entries.push(planned);
    }
  }

  return { entries, skipped, metricIds };
}

/** Split an array into fixed-size batches. */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Summary of what an import batch did, stored on the connection preference so
 * the Settings card can say "12,480 days imported, last synced Tuesday".
 */
export interface ImportSummary {
  written: number;
  skipped: number;
  metrics: string[];
  firstDay: string | null;
  lastDay: string | null;
}

export function summarize(plan: PlanResult): ImportSummary {
  let firstDay: string | null = null;
  let lastDay: string | null = null;
  for (const e of plan.entries) {
    if (firstDay === null || e.day < firstDay) firstDay = e.day;
    if (lastDay === null || e.day > lastDay) lastDay = e.day;
  }
  return {
    written: plan.entries.length,
    skipped: plan.skipped.length,
    metrics: plan.metricIds,
    firstDay,
    lastDay,
  };
}
