// shared/tracker-identity.ts
// =============================================================================
// Canonical tracker identity & matching — ONE source of truth for the question
// "do these two tracker names refer to the same thing?".
// =============================================================================
//
// Trackers were being duplicated whenever the same subject arrived with
// different wording: a pre-existing "Multivitamin" tracker plus a new
// "Supplement Multivitamin" / "Daily Multivitamin" because the engine only did
// exact/substring name matching. This module reduces a name to a stable
// IDENTITY KEY by stripping noise words (supplement, daily, my, pills, …) and
// punctuation, so all of those collapse to the same key and match.
//
// Pure + unit-tested. Used by the AI engine for BOTH log_tracker_entry tracker
// resolution and create_tracker dedup, so the two never disagree.
// =============================================================================

// Words that carry no identity. "Daily Multivitamin", "Multivitamin Supplement"
// and "Multivitamin" are the SAME tracker. Note these only strip as WHOLE
// tokens, never substrings — "Multivitamin" is one token and survives, while
// "Vitamin D" keeps the disambiguating "d".
const NOISE_WORDS = new Set([
  "supplement", "supplements", "supp", "supps",
  "daily", "morning", "evening", "nightly", "my", "the", "a", "an", "of",
  "tracker", "log", "logger", "intake", "tracking",
  "pill", "pills", "tablet", "tablets", "capsule", "capsules",
  "softgel", "softgels", "gummy", "gummies", "dose", "doses", "dosage",
  "med", "meds", "medication", "medications", "prescription", "rx",
]);

/**
 * Reduce a tracker name to a stable identity key.
 *  - lowercased, punctuation → spaces
 *  - trailing auto-number "(2)" removed
 *  - noise words removed (whole-token only)
 *  - remaining tokens joined with no separator
 *
 * "Multivitamin"            → "multivitamin"
 * "Supplement Multivitamin" → "multivitamin"
 * "Daily Multivitamin"      → "multivitamin"
 * "Fish Oil"                → "fishoil"
 * "Fish Oil Supplement"     → "fishoil"
 * "Vitamin D"               → "vitamind"   (distinct from "Vitamin C" → "vitaminc")
 * "Supplements"             → "supplements" (all-noise → de-noised fallback)
 */
export function trackerIdentityKey(name: string | null | undefined): string {
  const raw = String(name ?? "").toLowerCase();
  const noNum = raw.replace(/\s*\(\d+\)\s*$/, " ");
  const tokens = noNum
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = tokens.filter((t) => !NOISE_WORDS.has(t));
  const key = meaningful.join("");
  // If every token was noise (e.g. literally "Supplements" or "My Meds"),
  // fall back to the de-noised full string so the name still has a stable key.
  return key || tokens.join("");
}

/**
 * Do two tracker names refer to the same tracker? True when their identity
 * keys are equal, or (for compound names) one key fully contains the other and
 * both are long enough that the containment is meaningful (so "Bench Press" and
 * "Morning Bench Press" match, while "Leg Press" and "Bench Press" do not).
 */
export function trackerNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = trackerIdentityKey(a);
  const kb = trackerIdentityKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // Conservative containment for compound names. Require the shorter key to be
  // at least 5 chars so short fragments ("oil", "run") can't swallow others.
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (short.length >= 5 && long.includes(short)) return true;
  return false;
}

export interface TrackerIdentityLike {
  id?: string;
  name?: string | null;
  category?: string | null;
  linkedProfiles?: string[];
}

/**
 * Return every tracker whose identity matches `queryName`. This is the set the
 * caller (engine) then narrows by profile via pickTrackerForLog. Matching is
 * intentionally broader than exact-name so a logged subject reuses the existing
 * tracker instead of spawning a numbered/worded duplicate.
 */
export function findIdentityMatches<T extends TrackerIdentityLike>(
  trackers: T[],
  queryName: string | null | undefined,
): T[] {
  if (!queryName) return [];
  return trackers.filter((t) => trackerNamesMatch(t.name, queryName));
}
