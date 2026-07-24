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

// Bidirectional alias groups: a query hitting any DETECT member searches for
// ALL of the group's members (detect + expand). The detect/expand split exists
// because some stored labels are ambiguous ACROSS document types: a vehicle
// registration prints the plate as "License Number", which is also exactly
// what a driver's license calls its own number. Such ambiguous labels live in
// `expand` — they are searched once the group fires, but they never fire the
// group themselves. Without the split, "what's my driver's license number?"
// dragged the plate group into the query via "license number" and the
// registration's plate (8YPJ480) outranked the actual license number
// (2026-07 driver's-license/plate report).
//
// `conflictsWith` names groups describing a rival document type. When a group
// fires and its rival does NOT, the rival's detect members become scoring
// PENALTIES — a plate question demotes driver's-license fields and vice versa.
//
// Members are normalized (normalizeForMatch) before use, so entries may be
// written naturally ("driver's license" ⇒ "driver s license"); the old code
// compared raw members against the normalized query, which silently made any
// member containing punctuation unmatchable.
export interface RecallAliasGroup {
  id?: string;
  detect: string[];
  expand?: string[];
  conflictsWith?: string[];
}

export const RECALL_ALIAS_GROUPS: RecallAliasGroup[] = [
  { detect: ["vin", "vehicle id number", "vehicle identification number", "vehicleid", "chassis number", "frame number"] },
  {
    id: "plate",
    detect: ["plate", "license plate", "licenseplate", "plate number", "tag number"],
    expand: ["registration number", "license number"],
    conflictsWith: ["dl"],
  },
  {
    id: "dl",
    detect: ["dl", "drivers license", "driver license", "driver's license", "drivers licence", "driver's licence", "dl number"],
    expand: ["license number", "licence number", "id number", "document number"],
    conflictsWith: ["plate"],
  },
  { detect: ["dob", "date of birth", "birthday", "birthdate", "born"] },
  { detect: ["ssn", "social security number", "social security"] },
  { detect: ["phone", "phone number", "cell", "cellphone", "mobile", "telephone", "contact number"] },
  { detect: ["email", "email address"] },
  { detect: ["address", "home address", "street address", "mailing address", "residence"] },
  { detect: ["sqft", "square feet", "square footage", "floor area"] },
  { detect: ["odometer", "mileage", "miles", "odometer reading"] },
  { detect: ["policy", "policy number", "insurance policy"] },
  { detect: ["account", "account number", "account no", "acct number", "routing number"] },
  { detect: ["serial", "serial number", "serial no"] },
  { detect: ["member", "member id", "membership number", "member number"] },
  { detect: ["passport", "passport number"] },
  { detect: ["expiration", "expiration date", "expires", "expiry", "exp date", "valid until"] },
  { detect: ["make", "manufacturer"] },
  { detect: ["model", "model name"] },
  { detect: ["year", "model year"] },
  { detect: ["color", "colour"] },
  { detect: ["breed", "species"] },
  { detect: ["microchip", "chip number", "chip id"] },
  { detect: ["owner", "registered owner", "registrant"] },
];

export interface RecallTerms {
  tokens: string[];   // single-word terms (whole-word match, or substring when long)
  phrases: string[];  // multi-word alias terms (substring match)
  /** Terms marking a CONFLICTING document type — a key path containing one is
   *  demoted (e.g. "driver license" keys when the query asked for the plate). */
  penalties: string[];
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

// Normalized view of the alias groups, computed once at module load.
const NORMALIZED_GROUPS = RECALL_ALIAS_GROUPS.map(g => ({
  id: g.id,
  conflictsWith: g.conflictsWith || [],
  detect: [...new Set(g.detect.map(normalizeForMatch).filter(Boolean))],
  all: [...new Set([...g.detect, ...(g.expand || [])].map(normalizeForMatch).filter(Boolean))],
}));

const memberPresent = (member: string, norm: string, tokenSet: Set<string>) =>
  member.includes(" ") ? norm.includes(member) : tokenSet.has(member);

// Turn a raw user query into the set of single-word tokens + multi-word alias
// phrases that recall should search for.
export function buildRecallTerms(query: string): RecallTerms {
  const norm = normalizeForMatch(query);
  if (!norm) return { tokens: [], phrases: [], penalties: [], isEmpty: true };

  const words = norm.split(" ").filter(w => w && w.length >= 2 && !STOPWORDS.has(w));
  const tokenSet = new Set<string>(words);
  const queryTokens = new Set<string>(tokenSet);
  const phraseSet = new Set<string>();

  // Alias expansion: a group fires when any of its DETECT members appears in
  // the query (single words as tokens; phrases as substrings). Firing is
  // evaluated against the ORIGINAL query tokens so one group's expansion can
  // never chain-fire another group.
  const firedIds = new Set<string>();
  for (const group of NORMALIZED_GROUPS) {
    if (group.detect.some(m => memberPresent(m, norm, queryTokens))) {
      if (group.id) firedIds.add(group.id);
    }
  }
  for (const group of NORMALIZED_GROUPS) {
    const fired = group.id ? firedIds.has(group.id)
      : group.detect.some(m => memberPresent(m, norm, queryTokens));
    if (!fired) continue;
    for (const member of group.all) {
      if (member.includes(" ")) phraseSet.add(member);
      else tokenSet.add(member);
    }
  }

  // Conflict penalties: a fired group demotes its rival's territory — but only
  // when the rival did NOT fire too (both named ⇒ genuinely ambiguous, no bias).
  const penaltySet = new Set<string>();
  for (const group of NORMALIZED_GROUPS) {
    if (!group.id || !firedIds.has(group.id)) continue;
    for (const rivalId of group.conflictsWith) {
      if (firedIds.has(rivalId)) continue;
      const rival = NORMALIZED_GROUPS.find(g => g.id === rivalId);
      for (const m of rival?.detect || []) penaltySet.add(m);
    }
  }

  return {
    tokens: [...tokenSet],
    phrases: [...phraseSet],
    penalties: [...penaltySet],
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

  // Conflicting-document-type demotion: the key path names the RIVAL document
  // type (e.g. a "driver license" key when the query asked for the plate).
  // One flat penalty — enough to rank it below same-strength candidates from
  // the right document, without hiding it entirely when nothing else matches.
  const penalties = terms.penalties || [];
  if (penalties.some(p => (p.includes(" ") ? keyNorm.includes(p) : keyWords.has(p)))) {
    score = Math.max(0, score - 10);
  }
  return score;
}
