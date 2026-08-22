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
  return extractOwnerPossessive(name, ownerNames).name;
}

/**
 * Like `stripOwnerPossessivePrefix`, but KEEPS the owner it matched.
 *
 * Regression (2026-08-09, user report): "this is Bob's MacBook" had its
 * possessive stripped to "MacBook" and was then parented to SELF, because the
 * strip threw away the only evidence of who owned it. The laptop counted
 * toward the user's net worth instead of Bob's. The owner is in the sentence —
 * losing it during cleanup is what made the asset land on the wrong balance
 * sheet.
 *
 *   extractOwnerPossessive("Bob's MacBook", ["Bob"])
 *     → { name: "MacBook", owner: "Bob" }
 *   extractOwnerPossessive("Levi's 501 Jeans", ["Bob"])
 *     → { name: "Levi's 501 Jeans", owner: null }
 *
 * Still conservative: only a possessive matching a KNOWN owner name is
 * removed, so brands survive. `owner` is the caller's original spelling from
 * `ownerNames`, ready to resolve straight back to that profile.
 */
export function extractOwnerPossessive(
  name: string,
  ownerNames: Array<string | null | undefined>,
): { name: string; owner: string | null } {
  const original = String(name ?? "").trim();
  if (!original) return { name: original, owner: null };
  let out = original;
  let owner: string | null = null;
  for (const candidate of ownerNames) {
    const o = (candidate || "").trim();
    if (!o) continue;
    // <owner> followed by a possessive marker ('s / ' / s) and whitespace.
    const re = new RegExp(`^${escapeRegExp(o)}(?:['’ʼ]s?|s)\\s+`, "i");
    if (re.test(out)) {
      out = out.replace(re, "").trim();
      // First match wins — it is the outermost possessive, i.e. the owner.
      if (!owner) owner = o;
    }
  }
  if (!out) return { name: original, owner: null };
  return { name: out, owner };
}

/**
 * Owner named by a possessive, WITHOUT needing to know the owner list first.
 *
 * Used before profile resolution so an owner the user names but who has no
 * profile yet ("this is Robert's MacBook", no Robert on file) can be asked
 * about instead of silently filed under the user.
 *
 * Matches a single leading capitalized token or a relationship word. Returns
 * null for anything else, so "Levi's 501 Jeans" and lowercase noise are left
 * alone; a false positive here becomes a clarifying question, never a
 * misattributed asset.
 */
const RELATIONSHIP_WORDS =
  /^(wife|husband|spouse|partner|mom|mother|dad|father|son|daughter|brother|sister|roommate|girlfriend|boyfriend|fiance|fiancee|grandma|grandmother|grandpa|grandfather|aunt|uncle|cousin|nephew|niece)$/i;

/**
 * Brands whose name IS a possessive. Capitalization alone can't tell "Bob's
 * MacBook" from "Levi's 501 Jeans", and treating a brand as an owner would
 * interrupt the user with a pointless "who is Levi?" question. A short list of
 * the ones people actually own things from beats a clever rule here; anything
 * missing costs one clarifying question, never a misfiled asset.
 */
const BRAND_POSSESSIVES = new Set([
  "levi", "levis", "mcdonald", "mcdonalds", "kohl", "kohls", "macy", "macys",
  "wendy", "wendys", "arby", "arbys", "denny", "dennys", "applebee", "applebees",
  "lowe", "lowes", "sam", "sams", "bj", "bjs", "trader joe", "dunkin", "dunkins",
  "victoria", "victorias", "dillard", "dillards", "hardee", "hardees",
  "jimmy john", "papa john", "raising cane", "culver", "culvers",
]);

export function detectPossessiveOwner(name: string): { name: string; owner: string } | null {
  const raw = String(name ?? "").trim();
  // "<Token>'s <rest>" — one token only; multi-word owners must come from the
  // known-owner path above, where the full name is available to match against.
  const m = raw.match(/^([\p{L}][\p{L}'’-]*)['’]s\s+(.+)$/u);
  if (!m) return null;
  const [, token, rest] = m;
  const looksLikePerson = /^\p{Lu}/u.test(token) || RELATIONSHIP_WORDS.test(token);
  if (!looksLikePerson) return null;
  if (BRAND_POSSESSIVES.has(token.toLowerCase())) return null;
  const remaining = rest.trim();
  if (remaining.length < 2) return null;
  return { name: remaining, owner: token };
}

// ── Is this actually a PERSON? ────────────────────────────────────────────────
//
// QA 2026-08-22 (data quality): the calendar's "Filter by person" panel listed
// "my 2025 Do…" and "my MacBoo…" — both stored with type `person` — beside the
// real household members. They are the twins described above: a device or a
// document that a create landed on the person type, then kept the speaker's
// determiner so the name-equality dedup never collapsed them.
//
// `looksLikeNonPersonName` names that shape, once, for both ends of the
// problem: creates refuse to type such a name as a person, and the person
// filter hides the rows already in the database.
//
// Deliberately conservative — it must never hide a real household member. Only
// two signals count, and both are things a person's name never contains:
//   1. a first-person determiner ("my MacBook Pro", "our Honda"), and
//   2. a leading model year ("2025 Dodge Ram"),
// plus an explicit vocabulary of devices, vehicles and document types.

const NON_PERSON_WORDS = [
  // devices / electronics
  "macbook", "iphone", "ipad", "laptop", "desktop", "computer", "monitor",
  "printer", "airpods", "tablet", "playstation", "xbox", "nintendo", "kindle",
  "television", "router", "phone",
  // vehicles
  "car", "truck", "suv", "sedan", "motorcycle", "scooter", "boat", "trailer",
  // documents / paperwork
  "receipt", "invoice", "statement", "policy", "warranty", "contract", "lease",
  "registration", "license", "licence", "passport", "certificate", "deed",
];
// Deliberately absent: words that are also people's names or nicknames — Bill,
// Van, Will, Rich, Grant, Mercedes. A filter that hides a household member is
// a worse bug than the clutter it was added to remove.

const NON_PERSON_RE = new RegExp(`(^|\\s)(${NON_PERSON_WORDS.join("|")})(s)?(\\s|$)`, "i");

/**
 * True when a name reads as an object or a document rather than a person.
 * Used to keep such records out of the person filter and out of the `person`
 * profile type. Pinned by tests/entity-naming.test.ts.
 */
export function looksLikeNonPersonName(name: unknown): boolean {
  const raw = String(name ?? "").trim();
  if (!raw) return false;
  const hadDeterminer = /^(?:my|our)['’ʼ]?\s+/i.test(raw);
  const bare = stripLeadingDeterminer(raw);
  // "2025 Dodge Ram", "1998 Ford F150" — a person's name never opens with a
  // model year. A bare year on its own is not enough (nor is it a name).
  if (/^(19|20)\d{2}\s+\S/.test(bare)) return true;
  if (NON_PERSON_RE.test(bare)) return true;
  // "my <anything>" is the speaker describing a thing they own. A person is
  // introduced by name, never as "my Sarah" — but "My Nguyen" is a real
  // surname, so require more than one remaining word.
  if (hadDeterminer && bare.split(/\s+/).length >= 2) return true;
  return false;
}
