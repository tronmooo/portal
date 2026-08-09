// Owner-name hygiene for entity display names.
//
// The app scopes everything to a profile via linkedProfiles / parentProfileId
// and filters the UI by profile, so an owner's name does NOT belong inside an
// entity's own name. Two historical leaks this module cleans up:
//
//   1. Trackers auto-created "for <Person>" were suffixed "<Name> - <Person>"
//      ("Calories - Craig", "Running - Craig"). See server/ai-engine.ts.
//   2. Assets/vehicles were often named with a possessive owner prefix
//      ("Craig's Ford F250 2025") straight from the user's phrasing.
//
// Both helpers are pure and conservative: they only strip when the owner token
// matches a KNOWN owner name passed by the caller, so brand names ("Levi's",
// "McDonald's") and unrelated separators ("Blood Pressure - Morning") are left
// untouched. Pinned by tests/entity-naming.test.ts.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove a trailing " - <Owner>" (also en/em-dash) from a tracker name when
 * <Owner> matches one of the tracker's owner names. Case-insensitive.
 *   stripTrackerOwnerSuffix("Calories - Craig", ["Craig"]) === "Calories"
 *   stripTrackerOwnerSuffix("Blood Pressure - Morning", ["Craig"]) === "Blood Pressure - Morning"
 */
export function stripTrackerOwnerSuffix(name: string, ownerNames: Array<string | null | undefined>): string {
  if (!name) return name;
  let out = String(name).trim();
  for (const owner of ownerNames) {
    const o = (owner || "").trim();
    if (!o) continue;
    const re = new RegExp(`\\s*[-–—]\\s*${escapeRegExp(o)}\\s*$`, "i");
    if (re.test(out)) out = out.replace(re, "").trim();
  }
  return out || String(name).trim();
}

/**
 * Remove a leading first-person determiner ("my ", "our ") from an entity name.
 *
 * Regression (2026-08-09, user screenshot): "Create a profile for my MacBook
 * Pro m4" produced TWO profiles — "MacBook Pro M4" (asset) and "my MacBook Pro
 * m4" (person). The determiner is the user's phrasing, never part of the
 * entity's name, and leaving it in defeated the name-equality dedup that would
 * otherwise have collapsed the second write into the first.
 *
 * Trackers have normalized this away since they were introduced
 * (normalizeEntityName in shared/entity-classify.ts drops "my"/"the"/"a");
 * profiles never did. This closes that gap.
 *
 * Scoped to "my"/"our" on purpose. Stripping "the"/"a" would maul real names
 * ("The Home Depot"), and only the first-person forms are reliably the
 * speaker's determiner rather than the name. A space is required after it, so
 * single-token brands ("MyFitnessPal") are untouched; a spelled-out "My
 * Fitness Pal" would lose its "My", which is the accepted cost of not letting
 * every "my <thing>" become a second record.
 */
export function stripLeadingDeterminer(name: string): string {
  const raw = String(name ?? "").trim();
  if (!raw) return raw;
  const out = raw.replace(/^(?:my|our)['’ʼ]?\s+/i, "").trim();
  // Never strip the whole name away, and never leave a stub.
  return out.length >= 2 ? out : raw;
}

/**
 * Remove a leading possessive owner prefix ("Craig's ", "Craig' ", "Craigs ")
 * from an asset/vehicle name when the owner token matches a known owner name.
 * Straight, curly, and modifier-letter apostrophes are accepted; a plain
 * non-possessive prefix ("Craig Ford") is left alone. Case-insensitive.
 *   stripOwnerPossessivePrefix("Craig's Ford F250 2025", ["Craig"]) === "Ford F250 2025"
 *   stripOwnerPossessivePrefix("Levi's 501 Jeans", ["Craig"]) === "Levi's 501 Jeans"
 */
export function stripOwnerPossessivePrefix(name: string, ownerNames: Array<string | null | undefined>): string {
  if (!name) return name;
  let out = String(name).trim();
  for (const owner of ownerNames) {
    const o = (owner || "").trim();
    if (!o) continue;
    // <owner> followed by a possessive marker ('s / ' / s) and whitespace.
    const re = new RegExp(`^${escapeRegExp(o)}(?:['’ʼ]s?|s)\\s+`, "i");
    if (re.test(out)) out = out.replace(re, "").trim();
  }
  return out || String(name).trim();
}
