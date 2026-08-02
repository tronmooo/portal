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
function rawTokens(name: string | null | undefined): string[] {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Fold trivial plurals so "Pull-Ups" ≡ "Pull-Up". Whole-token only, and never
// 1–2 letter results, so identity stays stable on both sides of a compare.
function singularize(t: string): string {
  if (t.length > 3 && t.endsWith("es")) return t.slice(0, -2);
  if (t.length > 2 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

/** Identity tokens: de-noised, plural-folded. Empty only for empty names —
 * an all-noise name ("Supplements", "My Meds") falls back to its raw tokens. */
function identityTokens(name: string | null | undefined): string[] {
  const tokens = rawTokens(name);
  const meaningful = tokens.filter((t) => !NOISE_WORDS.has(t)).map(singularize);
  return meaningful.length ? meaningful : tokens.map(singularize);
}

export function trackerIdentityKey(name: string | null | undefined): string {
  return identityTokens(name).join("");
}

/** True when `contained`'s tokens appear as a contiguous run of WHOLE tokens
 * inside `container`'s tokens. Token-boundary aware by construction: "weight"
 * is not the token "weighted", so "Weight" is NOT contained in "Weighted
 * Pull-Ups" — but "Bench Press" IS contained in "Morning Bench Press". */
function tokensContain(container: string[], contained: string[]): boolean {
  if (!contained.length || contained.length > container.length) return false;
  for (let i = 0; i <= container.length - contained.length; i++) {
    let ok = true;
    for (let j = 0; j < contained.length; j++) {
      if (container[i + j] !== contained[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Do two tracker names refer to the same tracker? True when their identity
 * keys are equal, or (for compound names) the shorter name's tokens appear as
 * whole tokens inside the longer's — so "Bench Press" and "Morning Bench
 * Press" match, while "Leg Press" and "Bench Press" do not.
 *
 * Containment is TOKEN-BOUNDARY aware, never raw-substring. The old key-level
 * `long.includes(short)` matched partial words because keys are joined with no
 * separator: "Weight" (key "weight") matched "Weighted Pull-Ups" (key
 * "weightedpullups"), so workout logs were filed into the user's body-weight
 * tracker instead of creating their own (user report 2026-08-02). "weighted"
 * is a different word than "weight" — only whole-token runs match now.
 */
export function trackerNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = identityTokens(a);
  const tb = identityTokens(b);
  if (!ta.length || !tb.length) return false;
  const ka = ta.join("");
  const kb = tb.join("");
  if (ka === kb) return true;
  // Conservative containment for compound names. Require the shorter key to be
  // at least 5 chars so short fragments ("oil", "run") can't swallow others.
  const [shortT, longT] = ka.length <= kb.length ? [ta, tb] : [tb, ta];
  if (shortT.join("").length >= 5 && tokensContain(longT, shortT)) return true;
  return false;
}

/**
 * Loose one-directional containment for tracker lookup: does `containerName`
 * contain `containedName` as whole words? Replaces raw
 * `name.includes(query)` checks, which matched partial words (query "weight"
 * hijacked by a "Weighted Pull-Ups" tracker). No length guard — the caller
 * decides how much weight to give a match — but tokens only match whole.
 */
export function trackerNameContains(
  containerName: string | null | undefined,
  containedName: string | null | undefined,
): boolean {
  return tokensContain(
    rawTokens(containerName).map(singularize),
    rawTokens(containedName).map(singularize),
  );
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
