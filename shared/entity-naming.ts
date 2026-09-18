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

// ─── Is this NAME a person at all? ───────────────────────────────────────────
//
// QA 2026-09-18 BUG-02: the people list held "tires for my Dodge ram" (type
// person, its own dashboard, selectable as the active profile) and "my MacBook
// Pro M4 Financing". Both arrived through a create path that took the model's
// `type: "person"` (or the auto-created "party" of an ownership link) at its
// word. A human being's name looks like a name — one to three capitalised
// words, maybe a particle — never a possessive object phrase, a product with a
// model number, a price, or a debt instrument. This is the single test every
// identity-type create runs before it writes a row. Pinned by
// tests/entity-naming.test.ts.

const NAME_PARTICLES = new Set([
  "de", "da", "del", "della", "di", "du", "la", "le", "van", "von", "der", "den",
  "bin", "ibn", "al", "el", "y", "e", "of", "the", "and", "&", "jr", "sr", "ii", "iii", "iv",
  "mc", "mac", "st", "san", "dos", "das", "te", "ten", "ter", "op", "af", "av", "zu", "zur",
]);

/** Leading determiner / possessive: "my …", "our …", "the …", "a …". */
const LEADING_DETERMINER_RE = /^(?:my|our|your|his|her|their|its|the|a|an|some|this|that|these|those)\s+/i;

/** "tires FOR MY dodge ram", "insurance ON THE house", "loan FROM A bank". */
const PREPOSITION_PHRASE_RE =
  /\b(?:for|of|on|in|at|with|from|to|under|against)\s+(?:my|our|your|his|her|their|its|the|a|an|some)\b/i;

/** Nouns that name a thing, an expense, an asset or a liability — never a person. */
const OBJECT_NOUN_RE =
  /\b(?:financ(?:e|ing|ed)|loan|loans|mortgage|lease|leasing|payment|payments|installment|subscription|insurance|policy|premium|bill|bills|invoice|receipt|purchase|warranty|repair|repairs|service|maintenance|tires?|tyres?|wheels?|brakes?|battery|laptop|macbook|iphone|ipad|android|phone|computer|desktop|pc|tv|television|monitor|camera|console|xbox|playstation|nintendo|switch|car|truck|suv|van|sedan|vehicle|motorcycle|bike|bicycle|boat|jet\s*ski|trailer|house|home|condo|apartment|property|account|card|credit|debit|checking|savings|401k|ira|stocks?|crypto|bitcoin|gas|fuel|groceries|rent|utilities|electric|electricity|water|internet|wifi|netflix|spotify|hulu|gym|membership|fee|fees|tax|taxes|debt|balance|citation|ticket|fine|dodge|ram|ford|honda|toyota|tesla|chevy|chevrolet|bmw|audi|lexus|nissan|kia|hyundai|subaru|jeep)\b/i;

/**
 * Brands, products and debt instruments that are never a person's name even
 * when capitalised: two words containing one of these ("Honda Civic", "MacBook
 * Pro", "Netflix Premium") describe a thing. A single word stays a name — a
 * person can be called Dodge or Lexus.
 */
const STRONG_OBJECT_RE =
  /\b(?:macbook|imac|iphone|ipad|airpods|kindle|galaxy|pixel|thinkpad|chromebook|xbox|playstation|nintendo|netflix|spotify|hulu|disney\+|peloton|financ(?:e|ing|ed)|mortgage|refinanc\w*|subscription|membership|401k|roth|heloc|honda|toyota|tesla|chevy|chevrolet|bmw|audi|lexus|nissan|kia|hyundai|subaru|jeep|mazda|volkswagen|vw|porsche|ferrari|volvo|cadillac|buick|gmc|acura|infiniti|mitsubishi|dodge\s+ram|f-?150|f-?250|civic|corolla|camry|accord|silverado|tacoma|wrangler|model\s+[3sxy])\b/i;

/** "$60", "60 bucks", "95k", "1,200 dollars". */
const PRICE_RE = /(?:\$\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars?|bucks|usd|k)\b)/i;

/**
 * True when a proposed profile name reads as an OBJECT — a thing, an expense,
 * an asset or a liability description — rather than a person's (or pet's) name.
 *
 *   looksLikeObjectPhrase("tires for my Dodge ram")        → true
 *   looksLikeObjectPhrase("my MacBook Pro M4 Financing")   → true
 *   looksLikeObjectPhrase("MacBook Pro M4 Financing")      → true  (model number + debt noun)
 *   looksLikeObjectPhrase("Dana")                          → false
 *   looksLikeObjectPhrase("Bill Gates")                    → false (a capitalised name is a name)
 *   looksLikeObjectPhrase("Mary-Kate van der Berg")        → false
 *
 * Conservative on purpose: single capitalised words and short all-capitalised
 * phrases pass, so "Bill", "Rob", "Dodge" (a person named Dodge) stay people.
 * The object signals only fire on a phrase that ALSO carries a determiner, a
 * preposition, a price, a digit or a lowercase content word — the shape of a
 * description, not of a name.
 */
export function looksLikeObjectPhrase(name: unknown): boolean {
  const raw = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!raw) return false;
  const words = raw.split(" ");
  if (LEADING_DETERMINER_RE.test(raw)) return true;
  if (PREPOSITION_PHRASE_RE.test(raw)) return true;
  if (PRICE_RE.test(raw)) return true;
  if (words.length >= 6 || raw.length > 60) return true;
  if (words.length >= 2 && STRONG_OBJECT_RE.test(raw)) return true;
  const hasDigit = /\d/.test(raw);
  const hasLowercaseContentWord = words.some((w) => {
    const bare = w.replace(/[^\p{L}\p{N}'’-]/gu, "");
    if (!bare) return false;
    if (NAME_PARTICLES.has(bare.toLowerCase())) return false;
    return /^\p{Ll}/u.test(bare);
  });
  // A possessive INSIDE the phrase ("Bob's MacBook") names an owner and a thing.
  const innerPossessive = /\S['’]s\s+\S/.test(raw);
  const descriptive = hasDigit || innerPossessive || (words.length >= 2 && hasLowercaseContentWord);
  if (descriptive && OBJECT_NOUN_RE.test(raw)) return true;
  // Four or five words with a lowercase content word is a sentence fragment,
  // not a name ("tires for my dodge ram" is caught above; "new set of winter
  // tires" lands here).
  if (words.length >= 4 && hasLowercaseContentWord) return true;
  return false;
}

/** True when a proposed name is acceptable for a person / self / pet profile. */
export function looksLikePersonName(name: unknown): boolean {
  const raw = String(name ?? "").trim();
  if (!raw) return false;
  return !looksLikeObjectPhrase(raw);
}

/**
 * The profile type an object phrase most plausibly describes, for the message
 * that tells the model what to call instead. Never an identity type.
 */
export function suggestObjectProfileType(name: unknown): "liability" | "vehicle" | "property" | "subscription" | "asset" {
  const s = String(name ?? "").toLowerCase();
  if (/\b(financ\w*|loan|mortgage|lease|debt|credit card|payment|installment|balance owed)\b/.test(s)) return "liability";
  if (/\b(car|truck|suv|van|sedan|vehicle|motorcycle|boat|trailer|dodge|ram|ford|honda|toyota|tesla|chevy|chevrolet|bmw|audi|lexus|nissan|kia|hyundai|subaru|jeep)\b/.test(s)) return "vehicle";
  if (/\b(house|home|condo|apartment|property)\b/.test(s)) return "property";
  if (/\b(subscription|netflix|spotify|hulu|membership|plan)\b/.test(s)) return "subscription";
  return "asset";
}
