// shared/active-scope.ts
//
// The profile-isolation invariant, in one place, for creates.
//
// The rule the product promises (see the Brain page on profile data isolation):
//
//     a record created while profile P is the active scope belongs to P.
//
// QA report 2026-07-29 (PROP-005) found it broken for expenses: with `Mike`
// selected, Add Expense wrote the row into the self profile's ledger with no
// error. The cause was structural rather than a single typo — every create
// surface resolved the owner itself (`filterMode === "selected" && ids.length
// === 1 ? ids[0] : selfId`, copy-pasted five times), so ANY surface that got it
// wrong, or whose `/api/profiles` query hadn't resolved when the dialog
// mounted, silently defaulted to self.
//
// Fixing the five call sites would not have fixed the invariant: the sixth
// (chat, an importer, a future dialog) would break it again. So the client now
// sends its active scope on every request (`X-Active-Profile-Ids`) and the
// SERVER applies the rule for every writer, once.
//
// Deliberately NOT an override: a create that names an owner explicitly (the
// owner picker in the quick-add dialog, "add Jane's dentist bill" in chat) is
// honoured as-is. The header only supplies an owner when the request carries
// none — which is precisely the case that used to fall back to self.

/** Request header carrying the caller's active profile selection (comma-separated ids). */
export const ACTIVE_PROFILE_HEADER = "x-active-profile-ids";

/** Parse the header value into profile ids. Tolerates undefined/empty/whitespace. */
export function parseActiveProfileIds(headerValue: string | string[] | undefined | null): string[] {
  const raw = Array.isArray(headerValue) ? headerValue.join(",") : (headerValue || "");
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * The owner ids a new record should carry.
 *
 * @param explicit  owner ids the request already specified (may be empty)
 * @param activeIds the caller's active profile scope, from the header
 *
 * Returns `explicit` untouched whenever it names anyone. Otherwise returns the
 * active scope — but only when the scope is a SINGLE profile: with two or more
 * selected there is no unambiguous owner, and guessing one would be a new way
 * to put a row in the wrong ledger. An empty result means "leave it unowned",
 * which every reader already treats as belonging to the primary user.
 */
export function resolveCreateOwnerIds(
  explicit: readonly string[] | null | undefined,
  activeIds: readonly string[] | null | undefined,
): string[] {
  const named = (explicit || []).filter(Boolean);
  if (named.length > 0) return [...named];
  const active = (activeIds || []).filter(Boolean);
  return active.length === 1 ? [active[0]] : [];
}
