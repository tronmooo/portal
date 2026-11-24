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
  return { values, enrichment: next };
}
