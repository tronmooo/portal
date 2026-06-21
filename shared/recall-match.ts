// Alias-aware, token-based matching for the unified "recall" search — the AI's
// "what do you know about me" tool (storage.recallMemory).
//
// THE BUG THIS FIXES: recall used to match a field only when the *entire* query
// string was a literal substring of the field key or value. So "What is the VIN
// of my Honda CRV?" — and even the focused query "vin" — never matched a
// registration document whose extracted field is labeled "Vehicle ID Number".
// The data was sitting right there; the matcher just couldn't bridge the user's
// vocabulary ("VIN") to the stored label ("Vehicle ID Number").
//
// The fix has two parts:
//   1. Tokenize the query, drop stopwords, and match per-token (any token may
//      match) instead of requiring the whole sentence to be a substring.
//   2. Expand each token through bidirectional ALIAS groups so "vin" also
//      searches for "vehicle id number" / "vehicle identification number", and
//      vice-versa. Single-word terms match whole words (or substrings when
//      long enough); multi-word alias phrases match as substrings.

// Words that carry no search signal in a natural-language question. Dropping
// them is what lets "what is the vin of my honda crv 2021" collapse to the
// meaningful tokens [vin, honda, crv, 2021].
const STOPWORDS = new Set([
  "a", "an", "the", "of", "my", "our", "your", "their", "his", "her", "its",
  "what", "whats", "which", "who", "whose", "where", "when", "why", "how",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did",
  "have", "has", "had", "to", "in", "on", "at", "for", "with", "and", "or",
  "me", "i", "you", "we", "they", "it", "tell", "show", "find", "give",
  "get", "pull", "look", "know", "about", "that", "this", "these", "those",
  "there", "any", "all", "please", "again", "up", "s", "re", "much", "many",
  "number", "value", "info", "information", "detail", "details", "stored", "saved",
]);

// Bidirectional alias groups: a query hitting ANY member searches for ALL
// members. Groups may overlap (e.g. "license number" appears under both plate
// and driver-license) — recall favors high recall, so a wider net is fine; the
// AI reads the candidates and picks the right one. Single-word members are
// matched as whole words; multi-word members are matched as substrings.
export const RECALL_ALIAS_GROUPS: string[][] = [
  ["vin", "vehicle id number", "vehicle identification number", "vehicleid", "chassis number", "frame number"],
  ["plate", "license plate", "licenseplate", "plate number", "tag number", "registration number", "license number"],
  ["dl", "drivers license", "driver license", "driver's license", "drivers licence", "license number", "dl number"],
  ["dob", "date of birth", "birthday", "birthdate", "born"],
  ["ssn", "social security number", "social security"],
  ["phone", "phone number", "cell", "cellphone", "mobile", "telephone", "contact number"],
  ["email", "email address"],
  ["address", "home address", "street address", "mailing address", "residence"],
  ["sqft", "square feet", "square footage", "floor area"],
  ["odometer", "mileage", "miles", "odometer reading"],
  ["policy", "policy number", "insurance policy"],
  ["account", "account number", "account no", "acct number", "routing number"],
  ["serial", "serial number", "serial no"],
  ["member", "member id", "membership number", "member number"],
  ["expiration", "expiration date", "expires", "expiry", "exp date", "valid until"],
  ["make", "manufacturer"],
  ["model", "model name"],
  ["year", "model year"],
  ["color", "colour"],
  ["breed", "species"],
  ["microchip", "chip number", "chip id"],
  ["owner", "registered owner", "registrant"],
];

export interface RecallTerms {
  tokens: string[];   // single-word terms (whole-word match, or substring when long)
  phrases: string[];  // multi-word alias terms (substring match)
  isEmpty: boolean;
}

// Lowercase, split camelCase ("vehicleIdNumber" → "vehicle id number"), and
// turn every run of non-alphanumerics into a single space so "CR-V", "CR_V",
// and "Vehicle ID Number" all normalize predictably for matching.
export function normalizeForMatch(input: unknown): string {
  return String(input ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Turn a raw user query into the set of single-word tokens + multi-word alias
// phrases that recall should search for.
export function buildRecallTerms(query: string): RecallTerms {
  const norm = normalizeForMatch(query);
  if (!norm) return { tokens: [], phrases: [], isEmpty: true };

  const words = norm.split(" ").filter(w => w && w.length >= 2 && !STOPWORDS.has(w));
  const tokenSet = new Set<string>(words);
  const phraseSet = new Set<string>();

  // Alias expansion: a group fires when any of its members appears in the
  // query (single words must be present as tokens; phrases as substrings).
  for (const group of RECALL_ALIAS_GROUPS) {
    const fired = group.some(member =>
      member.includes(" ") ? norm.includes(member) : tokenSet.has(member),
    );
    if (!fired) continue;
    for (const member of group) {
      if (member.includes(" ")) phraseSet.add(member);
      else tokenSet.add(member);
    }
  }

  return {
    tokens: [...tokenSet],
    phrases: [...phraseSet],
    isEmpty: tokenSet.size === 0 && phraseSet.size === 0,
  };
}

// Score one candidate (a key path + its value) against the query terms. 0 means
// no match; higher means more relevant. Key-path matches outrank value matches
// (the user is usually naming the FIELD they want, e.g. "vin"), phrase matches
// outrank single-token matches, and covering more distinct terms adds a bonus.
export function recallMatchScore(terms: RecallTerms, keyPath: string, value: unknown): number {
  if (terms.isEmpty) return 0;

  const keyNorm = normalizeForMatch(keyPath);
  const keyWords = new Set(keyNorm.split(" ").filter(Boolean));
  const valNorm = normalizeForMatch(typeof value === "object" ? JSON.stringify(value) : value);
  const valWords = new Set(valNorm.split(" ").filter(Boolean));

  let score = 0;
  const matched = new Set<string>();

  // Short tokens (vin, dob, dl, bmw…) must hit a whole word to avoid noise like
  // "vin" inside "vinyl"; longer tokens may match as a substring.
  const tokenHit = (token: string, words: Set<string>, text: string) =>
    words.has(token) || (token.length >= 5 && text.includes(token));

  for (const t of terms.tokens) {
    if (tokenHit(t, keyWords, keyNorm)) { score += 6; matched.add(t); }
    else if (tokenHit(t, valWords, valNorm)) { score += 3; matched.add(t); }
  }
  for (const p of terms.phrases) {
    if (keyNorm.includes(p)) { score += 7; matched.add(p); }
    else if (valNorm.includes(p)) { score += 4; matched.add(p); }
  }

  if (matched.size > 1) score += (matched.size - 1) * 2;
  return score;
}
