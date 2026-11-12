// ── A person's name is data, not permission to create a profile ─────────────
// Pure, no I/O.
//
// User report 2026-11-12: "Bob's birthday is September 30. Remind me every
// year for 10 years" created a PERSON profile for Bob. The system prompt told
// the model that update_profile would auto-create a missing profile; the tool
// answered "use create_profile" and the model did. The user asked for a
// birthday and reminders, not a person.
//
// The rules (user's spec, applied everywhere a person or pet can be born):
//   1. Only an explicit request creates a person/pet profile
//      ("create a profile for Bob", "add my cat Luna", "add Bob as a contact").
//   2. The original request is completed without one.
//   3. A profile is OFFERED ("Would you also like a profile for Bob?"),
//      once per name, never repeated.
//   4. The offer never blocks the record.
//   5. Declining leaves a standalone record. No placeholder profile.
//   6. An existing profile is reused, never duplicated.
//   7. Mentioning Bob does not make Bob the owner.

/** Profile types that are beings with names, the ones a mention must not mint. */
export const NAMED_BEING_TYPES = new Set(["person", "pet", "medical"]);

const KIN = "dog|cat|pet|puppy|kitten|bird|horse|rabbit|bunny|hamster|parrot|fish|turtle|son|daughter|wife|husband|spouse|partner|mom|mother|dad|father|brother|sister|sibling|grandma|grandmother|grandpa|grandfather|aunt|uncle|cousin|friend|kid|child|baby|boyfriend|girlfriend|fianc[eé]e?|roommate|coworker|colleague|boss|niece|nephew|neighbor|neighbour|stepson|stepdaughter|stepmom|stepdad|doctor|dentist|therapist|pediatrician|vet|veterinarian";

const PATTERNS: RegExp[] = [
  // "create a profile for Bob", "make Bob a profile", "new profile: Bob",
  // "set up a person profile", "add a contact for Bob", "add Bob as a contact".
  /\b(?:create|add|make|set\s*up|start|open|build|new)\b[^.!?\n]{0,40}\b(?:profiles?|contacts?)\b/i,
  // "add Bob as a person / to my people / to my family"
  /\badd\b[^.!?\n]{0,30}\b(?:as\s+(?:a\s+)?(?:new\s+)?(?:person|pet|family\s+member)|to\s+(?:my\s+)?(?:people|family|pets|contacts))\b/i,
  // "add a person named Bob", "create a new pet called Max"
  /\b(?:create|add|make|new)\s+(?:a\s+)?(?:new\s+)?(?:person|pet)\s+(?:named|called)\b/i,
  // "add my cat Luna", "add my new puppy Max", "create my son Jordan" —
  // but NOT "add my sister Dana's birthday" (the name is a possessive).
  new RegExp(`\\b(?:add|create|make)\\s+(?:my\\s+|our\\s+)?(?:new\\s+)?(?:${KIN})\\s+(?:(?:named|called)\\s+)?[\\p{L}][\\p{L}-]*(?![\\p{L}'’-])`, "iu"),
];

/**
 * True when the user's own words ask for a person/pet profile to exist.
 * A mention ("Bob's birthday", "I bought Sarah a gift", "call Mike at 3")
 * is not a request.
 */
export function hasExplicitProfileCreateIntent(message: unknown): boolean {
  const text = String(message ?? "");
  if (!text.trim()) return false;
  // "don't create a profile", "no profile", "without a profile" is the opposite.
  if (/\b(?:don'?t|do\s+not|no|never|without|skip)\b[^.!?\n]{0,25}\bprofiles?\b/i.test(text)) return false;
  return PATTERNS.some((re) => re.test(text));
}

/** The offer the client shows under a reply. */
export interface ProfileSuggestion {
  name: string;
  type: "person" | "pet" | "medical";
}

/** Normalized key for "have we already offered this name?". */
export function suggestionKey(name: unknown): string {
  return String(name ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
}

/** The two answers. "Yes" is an explicit request in the user's own words. */
export function profileSuggestionYesText(s: ProfileSuggestion): string {
  if (s.type === "pet") return `Create a pet profile for ${s.name}`;
  if (s.type === "medical") return `Create a medical provider profile for ${s.name}`;
  return `Create a profile for ${s.name}`;
}

/** Edit distance with transpositions, for "is this unknown name a typo of a real one?". */
function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // A swapped pair ("Bbo" for "Bob") is one slip, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[a.length][b.length];
}

/**
 * True when `name` is probably a misspelling of an existing profile's name
 * ("Bbo" for "Bob"). Such a name is a question ("did you mean Bob?"), not a
 * new person to file under the user.
 */
export function looksLikeTypoOf(name: unknown, profileNames: readonly string[]): boolean {
  const n = suggestionKey(name);
  if (n.length < 3) return false;
  return profileNames.some((p) => {
    const k = suggestionKey(p);
    const first = k.split(" ")[0];
    return [k, first].some((c) => c && c !== n && Math.abs(c.length - n.length) <= 2 && distance(c, n) <= (n.length <= 4 ? 1 : 2));
  });
}
