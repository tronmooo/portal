// Editing a tracker entry re-derives what was derived from it.
//
// When an activity is logged, the estimation engine (shared/estimation-engine)
// fills the entry's derived figures into its real fields — pace and speed from
// distance and duration, steps and calories as estimates — and records which
// ones it filled in the entry's provenance (`computed.enrichment`). An EDIT
// used to merge the new values over the row and carry that provenance along
// untouched. The edit form sends every field it shows, so the old derived
// figures went back in as if the user had typed them: a run changed from
// 1.25 to 1.5 miles kept "11.2 min/mile · 5.36 mph · 140 cal" in its history
// row while the card, which divides distance by duration itself, said 9:20.
// Two screens, one entry, two paces (Rule 1). (QA, 2026-11-24.)
//
// The rule: a value the engine derived stays the engine's until the user
// changes THAT value. On an edit, every derived value the user did not touch
// is dropped and derived again from what the entry now says; one the user
// changed (or removed) is theirs from then on.

import {
  enrichWalkRunEntry, enrichFitnessEntry, enrichHydrationEntry, enrichSleepEntry,
  enrichStrengthEntry, mergeEnrichments, applyEnrichmentToValues,
  type Enrichment, type FitnessEnrichContext,
} from "./estimation-engine";
import { resolveCanonicalActivity } from "./canonical-activity";

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a == null || b == null || a === "" || b === "") return (a == null || a === "") && (b == null || b === "");
  const na = typeof a === "number" ? a : Number(a);
  const nb = typeof b === "number" ? b : Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a) === String(b);
};

const derivedKeysOf = (e: Partial<Enrichment> | null | undefined): string[] =>
  e && typeof e === "object" ? [...Object.keys(e.calculated || {}), ...Object.keys(e.estimated || {})] : [];

function enrichAgain(
  activityType: string | undefined,
  trackerName: string | null | undefined,
  explicit: Record<string, any>,
  ctx: FitnessEnrichContext,
): Enrichment {
  if (activityType === "walking" || activityType === "running" || activityType === "cycling") {
    return enrichWalkRunEntry(activityType, explicit, ctx);
  }
  if (activityType === "hydration") return enrichHydrationEntry(explicit);
  if (activityType === "sleep") return enrichSleepEntry(explicit);
  const fitness = enrichFitnessEntry(trackerName, explicit, ctx);
  return explicit.weight != null && explicit.reps != null
    ? mergeEnrichments(enrichStrengthEntry(explicit), fitness)
    : fitness;
}

/**
 * A pace or speed stored under another name ("pace: 11.2", which the chat
 * model sends beside the engine's own paceMinutesPerMile) is the same figure,
 * and the provenance does not list it. Once distance and duration are both
 * exact the pace IS their quotient, so a copy the user did not touch follows
 * it rather than contradict it in the same row.
 */
function paceOrSpeedFor(key: string, e: Enrichment): number | undefined {
  if (key.startsWith("_") || key === "paceMinutesPerMile" || key === "speedMph") return undefined;
  const name = key.toLowerCase().replace(/[^a-z]/g, "");
  return /^(avg|average)?pace(minpermile|minutespermile)?$/.test(name) ? e.calculated.paceMinutesPerMile?.value
    : /^(avg|average)?speed(mph)?$|^mph$/.test(name) ? e.calculated.speedMph?.value
    : undefined;
}

function followPaceAndSpeed(values: Record<string, any>, e: Enrichment, changed: Set<string>): void {
  const pace = e.calculated.paceMinutesPerMile?.value;
  for (const k of Object.keys(values)) {
    if (changed.has(k)) continue;
    const target = paceOrSpeedFor(k, e);
    if (target == null || !Number.isFinite(target)) continue;
    const v = values[k];
    if (typeof v === "number") values[k] = target;
    else if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) values[k] = target;
    else if (typeof v === "string" && /^\d{1,2}:\d{2}/.test(v.trim()) && target === pace) {
      const secs = Math.round(target * 60);
      values[k] = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    }
  }
}

export interface RederiveInput {
  trackerName?: string | null;
  /** The entry's values as stored, before the edit. */
  storedValues: Record<string, any> | null | undefined;
  /** The entry's stored provenance (`computed.enrichment`). */
  enrichment: Partial<Enrichment> | null | undefined;
  /** The values the edit sent (already unit-normalized). */
  patchValues: Record<string, any> | null | undefined;
  /** Keys the edit removes. */
  valuesToDelete?: string[] | null;
  /** The entry OWNER's body and history, and the tracker's fields. */
  ctx?: FitnessEnrichContext;
}

export interface RederiveResult {
  /** The whole values object to store. */
  values: Record<string, any>;
  /** The provenance that describes those values. */
  enrichment: Enrichment;
}

/**
 * The values and provenance an edited entry should hold, or null when the
 * edit changes nothing the engine derived from (a note, a timestamp, an
 * entry with no derived figures): the caller then merges as it always did.
 */
export function rederiveEditedEntry(input: RederiveInput): RederiveResult | null {
  const derived = derivedKeysOf(input.enrichment);
  if (derived.length === 0) return null;
  const stored = input.storedValues || {};
  const patch = input.patchValues && typeof input.patchValues === "object" ? input.patchValues : {};
  const removed = new Set((input.valuesToDelete || []).filter((k) => typeof k === "string"));

  const changed = new Set<string>();
  for (const [k, v] of Object.entries(patch)) {
    if (k.startsWith("_")) continue;
    if (!sameValue(v, stored[k])) changed.add(k);
  }
  for (const k of removed) if (!k.startsWith("_") && stored[k] !== undefined) changed.add(k);
  if (changed.size === 0) return null;

  // What the entry says once the edit is applied, minus every derived figure
  // the user left alone: those are the engine's to work out again.
  const explicit: Record<string, any> = { ...stored };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete explicit[k];
    else explicit[k] = v;
  }
  for (const k of removed) delete explicit[k];
  for (const k of derived) if (!changed.has(k)) delete explicit[k];
  delete explicit._enrichment;

  const next = enrichAgain(input.enrichment?.activityType, input.trackerName, explicit, input.ctx || {});
  // A figure the user removed stays removed: it is not filled back in, and
  // the provenance does not describe a value the entry no longer holds.
  for (const k of removed) { delete next.calculated[k]; delete next.estimated[k]; }
  const values = { ...explicit };
  applyEnrichmentToValues(values, next);
  followPaceAndSpeed(values, next, changed);
  return { values, enrichment: next };
}

// ── A NEW entry derives the same figures (QA, 2026-11-24) ────────────────────
//
// Chat logging runs the estimation engine before it writes; the Trackers
// page's Add Entry form posted straight to the route, so a 2-mile run in 20
// minutes was stored as distance and duration only — no pace, no speed, and
// no provenance, so a later edit had nothing to re-derive either. Both
// storages' logEntry ask this function when the caller brought no provenance
// of its own.

export interface NewEntryInput {
  trackerName?: string | null;
  /** The tracker's unit (read for the primary field when it names none). */
  trackerUnit?: string | null;
  /** The values as they will be stored (already unit-normalized and gated). */
  values: Record<string, any>;
  /** The entry OWNER's body and history, and the tracker's fields. */
  ctx?: FitnessEnrichContext;
}

const MILES_UNIT = /^(mi|mile|miles)$/i;
const MINUTES_UNIT = /^(min|mins|minute|minutes)$/i;
const MEASURED_KEYS = ["distance", "miles", "distanceMiles", "distanceKm", "km", "kilometers", "duration", "minutes", "durationMinutes", "steps"];

/**
 * The values and provenance a new walk / run / ride is stored with, or null
 * when the engine has nothing to add (another kind of tracker, nothing
 * measured, or units the cardio engine does not read). Stated values are never
 * replaced; the tracker's own pace / speed fields ("pace", "avg_speed") are
 * filled from the same calculation when they were left blank.
 */
export function deriveNewEntry(input: NewEntryInput): RederiveResult | null {
  const type = resolveCanonicalActivity(String(input.trackerName || ""))?.type;
  if (type !== "walking" && type !== "running" && type !== "cycling") return null;
  const values = input.values || {};
  const fields = (input.ctx?.fields || []) as Array<{ name: string; unit?: string | null; isPrimary?: boolean; type?: string }>;
  const unitOf = (name: string): string => {
    const f = fields.find((x) => x?.name === name);
    return String((f?.unit || (f?.isPrimary ? input.trackerUnit : "")) || "").trim();
  };
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  // Only a measured outing: an entry with nothing measured (a habit tick) is
  // never a reason to invent a typical run.
  if (!MEASURED_KEYS.some((k) => Number.isFinite(num(values[k])) && num(values[k]) > 0)) return null;
  // The cardio engine reads distance in miles and duration in minutes.
  const du = unitOf("distance");
  if (values.distance != null && du && !MILES_UNIT.test(du)) return null;
  const tu = unitOf("duration");
  if (values.duration != null && tu && !MINUTES_UNIT.test(tu)) return null;

  const explicit: Record<string, any> = {};
  for (const [k, v] of Object.entries(values)) if (!k.startsWith("_") && v != null && v !== "") explicit[k] = v;
  const e = enrichWalkRunEntry(type, explicit, input.ctx || {});
  if (Object.keys(e.calculated).length === 0 && Object.keys(e.estimated).length === 0) return null;
  const out: Record<string, any> = { ...values };
  applyEnrichmentToValues(out, e);
  // The tracker's own pace / speed fields, left blank on the form.
  for (const f of fields) {
    if (!f?.name || (out[f.name] != null && out[f.name] !== "")) continue;
    const target = paceOrSpeedFor(f.name, e);
    if (target == null || !Number.isFinite(target)) continue;
    if (f.type === "duration" && target === e.calculated.paceMinutesPerMile?.value) {
      const secs = Math.round(target * 60);
      out[f.name] = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    } else out[f.name] = target;
  }
  return { values: out, enrichment: e };
}
