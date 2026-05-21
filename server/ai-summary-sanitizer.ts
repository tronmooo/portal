// ────────────────────────────────────────────────────────────────────
// AI summary sanitizer — drop demographic facts that the user has
// explicitly removed from the profile.
//
// Background: the AI summary endpoint feeds every linked document's
// `extractedData` into the prompt. A driver's license extractedData
// typically contains `dateOfBirth`. If the user deletes the Birthday
// row on the profile (so it disappears from `profile.fields`), the
// DOB still survives inside the linked license documents — and the
// AI happily computes age from it ("Bob Robertson is a 45-year-old").
//
// Fix: for a fixed set of "sensitive" demographic keys, if the profile
// itself does NOT carry the key (top-level, aliased, or nested), strip
// every variant of that key from each linked document's extractedData
// before it ever reaches the AI. The document's own row in the DB is
// untouched — DATA IS NOT DELETED — we are only sanitizing the prompt.
//
// This MUST stay in lockstep with PROFILE_KEY_ALIAS_REVERSE and
// PROFILE_NESTED_GROUPS in server/supabase-storage.ts.
// ────────────────────────────────────────────────────────────────────

/**
 * Sensitive demographic facts that the AI can synthesize from linked
 * documents even when the user has scrubbed them from the profile.
 * For each, list every storage-key variant we need to strip from
 * documents when the profile does not carry the canonical key.
 */
const AI_SENSITIVE_FIELD_VARIANTS: Record<string, string[]> = {
  // birthday — the original Bob bug. "date_of_birth" + snake_case
  // and "birthDate" appear in various extractor outputs.
  birthday: ["birthday", "dateOfBirth", "date_of_birth", "dob", "DOB", "birthDate", "birth_date"],
  // age (computed) — sometimes extractors stuff a literal "age"
  age: ["age"],
  // SSN — similar privacy concern; user may have explicitly removed it
  ssn: ["ssn", "SSN", "socialSecurityNumber", "social_security_number"],
};

const NESTED_GROUPS_FOR_AI_SCAN = [
  "vehicles", "vehicle", "insurance", "housing", "other", "finance", "subscriptions", "utilities", "loan",
  "personal", "identity", "health", "contact", "contacts", "emergency",
  "pets", "pet",
];

/** Walk profile.fields (top-level + every known nested group) and
 *  return true if ANY of the listed key variants appears with a
 *  non-empty value. Used to detect "the user kept this fact on the
 *  profile" vs "the user removed it." */
function profileHasAnyVariant(fields: Record<string, any> | null | undefined, variants: string[]): boolean {
  if (!fields || typeof fields !== "object") return false;
  const isNonEmpty = (v: any) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0);
  for (const v of variants) {
    if (isNonEmpty(fields[v])) return true;
  }
  for (const group of NESTED_GROUPS_FOR_AI_SCAN) {
    const nested = fields[group];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    for (const v of variants) {
      if (isNonEmpty(nested[v])) return true;
    }
  }
  return false;
}

/** Compute the union of every variant whose canonical key is NOT
 *  present anywhere on the profile. These are the keys we strip from
 *  documents before sending to the AI. */
export function computeAiSensitiveStripKeys(profileFields: Record<string, any> | null | undefined): Set<string> {
  const drop = new Set<string>();
  for (const variants of Object.values(AI_SENSITIVE_FIELD_VARIANTS)) {
    if (!profileHasAnyVariant(profileFields, variants)) {
      for (const v of variants) drop.add(v);
    }
  }
  return drop;
}

/** Return a deep-cloned copy of `obj` with any key whose name is in
 *  `dropKeys` removed at every level. Strings are left alone — we only
 *  prune keys, never alter values. */
export function deepStripKeys(obj: any, dropKeys: Set<string>): any {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map((v) => deepStripKeys(v, dropKeys));
  if (typeof obj !== "object") return obj;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (dropKeys.has(k)) continue;
    out[k] = deepStripKeys(v, dropKeys);
  }
  return out;
}
