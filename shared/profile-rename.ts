// ─── Renaming a profile ─────────────────────────────────────────────────────
//
// A profile's NAME is how the person is addressed everywhere in the app: the
// header on their page, the owner badge on every task/expense/tracker card, the
// profile switcher, search, and the names the AI matches against when the user
// says "log Bob's run". Nothing denormalizes it — every surface resolves the
// name from the profile row by id — so changing the row IS the propagation.
//
// What was missing was the change itself. `update_profile` accepted `changes`
// with fields/notes/tags/type and silently dropped a name, so "Rename Bob QA to
// Bob Robertson" reported success, wrote nothing, and left the profile page
// showing the old name (user report 2026-08-25). Manual renaming did not exist
// at all: the Info header rendered the name as static text.
//
// Both doors now come through here, so a rename means the same thing and is
// refused for the same reasons whichever way it was asked for.

/** Trim and collapse whitespace. A name is one line of visible text. */
export function cleanProfileName(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/** Same name, ignoring case and surrounding space — "bob qa" IS "Bob QA". */
export function sameProfileName(a: unknown, b: unknown): boolean {
  return cleanProfileName(a).toLowerCase() === cleanProfileName(b).toLowerCase();
}

export const MAX_PROFILE_NAME_LENGTH = 80;

export type ProfileRenameCheck =
  /** The name is different and free — write it. */
  | { status: "ok"; name: string }
  /** The name is already what was asked for — writing it is a no-op. */
  | { status: "unchanged"; name: string }
  /** Refused, with a sentence that can be shown to the user as-is. */
  | { status: "rejected"; error: string };

/**
 * Can this profile take this name?
 *
 * Refuses an empty name and a name another profile already holds — two records
 * answering to "Bob" is precisely the ambiguity that makes every later "update
 * Bob" a coin flip, so the collision is reported rather than resolved by
 * guessing.
 */
export function checkProfileRename(
  profiles: Array<{ id: string; name: string }>,
  profileId: string,
  rawName: unknown,
  currentName: unknown,
): ProfileRenameCheck {
  const name = cleanProfileName(rawName);
  if (!name) return { status: "rejected", error: "A profile needs a name — the new name was empty." };
  if (name.length > MAX_PROFILE_NAME_LENGTH) {
    return { status: "rejected", error: `That name is ${name.length} characters — keep it under ${MAX_PROFILE_NAME_LENGTH}.` };
  }
  if (sameProfileName(name, currentName)) return { status: "unchanged", name };
  const clash = profiles.find((p) => p.id !== profileId && sameProfileName(p.name, name));
  if (clash) {
    return {
      status: "rejected",
      error: `Another profile is already named "${clash.name}". Two profiles with the same name make every later "update ${clash.name}" ambiguous — pick a different name, or merge the two.`,
    };
  }
  return { status: "ok", name };
}
