// ─── Service / subscription name identity ────────────────────────────────────
//
// THE BUG THIS FIXES (QA 2026-08-20, BUG-1). A subscription was created as
// "Spotify". A later turn ("it charges on the 15th") arrived with the name
// "Spotify Premium", and every dedup check in the write path compares names
// with `===` after lowercasing. "spotify premium" !== "spotify", so the update
// landed on a SECOND liability profile, a SECOND $9.99 monthly bill and a third
// reminder — an entity family the user cannot tell apart, because both rows
// read $9.99 / monthly / next due Sep 15.
//
// A recurring service's identity is its BRAND, not the plan tier the user
// happened to say this time. "Netflix" / "Netflix Standard", "Spotify" /
// "Spotify Premium", "Hulu" / "Hulu subscription" and "Gym" / "Gym membership"
// are one bill each.
//
// Deliberately conservative — this drives MERGES, and a wrong merge destroys
// data that a wrong duplicate merely clutters:
//   · only tier/packaging words are stripped, never a distinguishing product
//     word ("Apple Music" ≠ "Apple TV", "Chase Sapphire" ≠ "Chase Freedom",
//     "Amex Gold" ≠ "Amex Platinum");
//   · what remains must match EXACTLY. There is no fuzzy/substring rule, so
//     "Car Loan" can never absorb "Car Insurance";
//   · a name that is ONLY qualifier words ("subscription", "monthly plan")
//     normalizes to empty and matches nothing, including another empty one.

/** Words that describe a plan tier or the packaging, never the service itself. */
const QUALIFIERS = new Set([
  "premium", "plus", "pro", "basic", "standard", "essential", "essentials",
  "family", "duo", "individual", "personal", "student", "unlimited", "lite",
  "subscription", "subscriptions", "membership", "plan", "package", "tier",
  "account", "service", "bill", "billing", "payment", "payments",
  "monthly", "yearly", "annual", "annually", "quarterly", "weekly",
  "recurring", "auto", "autopay", "renewal",
  // articles / filler that survive punctuation stripping
  "the", "a", "an", "my",
]);

/**
 * Reduce a service name to its brand tokens: lowercase, punctuation stripped,
 * tier/packaging words removed, single spaces. Returns "" when nothing
 * identifying is left.
 */
export function normalizeServiceName(raw: unknown): string {
  const flat = String(raw ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  const kept = flat.split(" ").filter(t => t && !QUALIFIERS.has(t));
  return kept.join(" ");
}

/**
 * True when two names denote the SAME recurring service.
 *
 * Exact match on the brand tokens only. Empty (all-qualifier) names never
 * match — "Subscription" is not an identity.
 */
export function sameServiceName(a: unknown, b: unknown): boolean {
  const na = normalizeServiceName(a);
  if (!na) return false;
  return na === normalizeServiceName(b);
}
