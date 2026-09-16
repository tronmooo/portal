// ── Which documents belong on a health page ──────────────────────────────────
// The Wellness tab listed "Health Documents" by regex-matching the word
// "insurance" anywhere in a document's type, name or tags — so two homeowners
// insurance policies were filed under the user's health records.
//
// The rule here is by TYPE first: a document is a health document because of
// what it IS, not because its title happens to contain a health-ish word. An
// insurance document only counts when the policy itself is health, dental or
// vision cover; a homeowners, auto, renters or life policy never does.
//
// Pure + shared so the server and the client agree on the same list.

export interface HealthDocLike {
  type?: string | null;
  name?: string | null;
  title?: string | null;
  tags?: string[] | null;
  deletedAt?: string | null;
}

/**
 * Types that are health records whatever they are called. Document types are
 * free-form snake_case coming out of extraction ("lab_results",
 * "vaccination_record", "medical_report"), so this matches a health WORD
 * inside the type rather than a fixed list of exact strings.
 */
const HEALTH_TYPE = /(?:^|[_\s-])(?:medical|medicine|lab|labs|health|prescription|rx|pharmacy|immuni\w*|vaccin\w*|dental|vision|optometr\w*|imaging|radiology|discharge|referral|patient|clinic|hospital|surgery|therapy)s?(?:[_\s-]|$)/i;

/** Types that MIGHT be health — an insurance card is health cover or it isn't. */
const AMBIGUOUS_TYPE = /insurance|card|policy/i;

/** Text that makes an ambiguous document a health one. */
const HEALTH_CONTEXT = /\b(health|medical|dental|vision|hmo|ppo|medicare|medicaid|rx|pharmacy|prescription|hsa|fsa|clinic|hospital|patient|blue\s*cross|aetna|cigna|kaiser|humana|united\s*health)\b/i;

/** Text that rules it out even when it looks health-adjacent. */
const NOT_HEALTH = /\b(homeowners?|home|renters?|auto|car|vehicle|motor|boat|flood|umbrella|property|landlord|title|life\s*insurance|pet)\b/i;

export function isHealthDocument(doc: HealthDocLike | null | undefined): boolean {
  if (!doc || doc.deletedAt) return false;
  const type = String(doc.type || "").trim();
  const text = `${doc.title || ""} ${doc.name || ""} ${(doc.tags || []).join(" ")}`;
  if (NOT_HEALTH.test(text) && !HEALTH_TYPE.test(type)) return false;
  if (HEALTH_TYPE.test(type)) return true;
  // A tag is an explicit user classification, so it counts as a type signal.
  if ((doc.tags || []).some((t) => HEALTH_TYPE.test(String(t || "").trim()))) return true;
  if (AMBIGUOUS_TYPE.test(type)) return HEALTH_CONTEXT.test(text);
  return false;
}
