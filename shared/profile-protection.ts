// shared/profile-protection.ts — WHO CANNOT BE DELETED.
//
// Portol has exactly one primary account owner per user: the profile with
// type "self". It is the root of the profile tree, the default owner of every
// asset created without an explicit owner, the fallback the profile filter
// falls back TO when a selection goes stale (client/src/lib/profileFilter.ts),
// and the row auth.ts creates at signup. Deleting it does not remove an
// account — it removes the anchor every other record hangs off, and there is
// no UI to make another one.
//
// Every other profile — additional people, pets, assets, liabilities — is the
// user's to delete, and deleting a person takes their data with them.
//
// One module so the rule is stated once and enforced everywhere: the route,
// the storage layer, the chat tool, and the two places in the UI that render a
// delete control.

/** The profile type that marks the primary account owner. */
export const PRIMARY_PROFILE_TYPE = "self";

/** Profile types that represent a human being (not a thing). */
export const PERSON_PROFILE_TYPES = ["self", "person"] as const;

/**
 * Is this the primary account owner — the one profile that must survive?
 *
 * Accepts anything with a `type`, so callers can pass a full profile, the lite
 * projection, or a bare `{ type }`.
 */
export function isPrimaryProfile(
  profile: { type?: string | null } | null | undefined,
): boolean {
  return String(profile?.type ?? "").toLowerCase() === PRIMARY_PROFILE_TYPE;
}

/** True for a person-shaped profile the user IS allowed to delete. */
export function isDeletablePerson(
  profile: { type?: string | null } | null | undefined,
): boolean {
  return String(profile?.type ?? "").toLowerCase() === "person";
}

/**
 * The one message shown or returned whenever a delete is refused, so the API,
 * the chat and the UI all say the same thing.
 */
export const PRIMARY_PROFILE_DELETE_ERROR =
  "This is your own profile — the primary account owner — so it can't be deleted. " +
  "You can rename it or edit its details, and you can delete any other person you've added.";
