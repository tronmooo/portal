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

// ─── Changing what KIND of record this is ───────────────────────────────────
//
// A profile's type decides which tab it lands on, which fields it suggests,
// and whether it counts toward net worth. Chat could change it
// (`update_profile changes:{type}`) from the day that tool existed; the UI
// could not, so "my truck shows up as a person" had no manual fix at all.

/** Every type a profile row can hold. Mirrors update_profile's enum. */
export const PROFILE_TYPES = [
  "person", "pet", "vehicle", "property", "asset", "investment",
  "account", "loan", "subscription", "medical",
] as const;

export type ProfileType = typeof PROFILE_TYPES[number] | "self";

/**
 * Can this profile become that type?
 *
 * "self" is deliberately absent from PROFILE_TYPES and refused both ways: the
 * app resolves the user's own record by that type, so a second self — or a
 * self demoted to a person — leaves scope, ownership and "Me" resolution with
 * no answer. Everything else is the user's call.
 */
export function checkProfileTypeChange(currentType: unknown, nextType: unknown):
  | { status: "ok"; type: string }
  | { status: "unchanged" }
  | { status: "rejected"; error: string } {
  const next = String(nextType ?? "").trim().toLowerCase();
  const current = String(currentType ?? "").trim().toLowerCase();
  if (!next) return { status: "rejected", error: "No type given." };
  if (next === current) return { status: "unchanged" };
  if (current === "self") {
    return { status: "rejected", error: "This is your own profile — its type is what makes it yours, so it can't be changed to something else." };
  }
  if (next === "self") {
    return { status: "rejected", error: "There is exactly one 'me' profile, and another record can't become it. Merge into it instead." };
  }
  if (!(PROFILE_TYPES as readonly string[]).includes(next)) {
    return { status: "rejected", error: `"${nextType}" isn't a profile type. Pick one of: ${PROFILE_TYPES.join(", ")}.` };
  }
  return { status: "ok", type: next };
}

// ─── Owner names that were baked into other records' titles ─────────────────
//
// A profile's name is supposed to live in exactly one place, and mostly it
// does — everything else links by id. But the app has always generated a few
// titles FROM the name at the moment of creation:
//
//   · trackers and habits auto-created for someone get an owner suffix,
//     "Morning Run - Bob QA" (see shared/entity-naming.ts);
//   · the birthday event a profile's date of birth produces is titled
//     "🎂 Bob QA's Birthday".
//
// Those are copies, and a rename leaves them behind. For trackers it is worse
// than stale: the read path STRIPS a trailing owner suffix by matching it
// against the owner's CURRENT name, so renaming stops the strip from matching
// and the old name reappears on screen where it had been hidden.
//
// Found by sweeping the live database for a renamed profile's old name rather
// than by reading the code, which is why the rename shipped claiming to reach
// everywhere.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite an owner name where a title GENERATED it — nowhere else.
 *
 * Exactly two shapes, both of which the app writes itself:
 *   · a trailing " - <Owner>" suffix (hyphen, en dash or em dash)
 *   · a leading "<Owner>'s " possessive, after any emoji or padding
 *
 * Everything else is left alone on purpose. A note that happens to mention
 * someone, a journal entry, an audit row: those are records of what was
 * written or what happened, and rewriting them would be editing the user's
 * words or falsifying a log. Returns the title unchanged when neither shape
 * matches.
 */
export function renameOwnerInTitle(title: unknown, oldName: unknown, newName: unknown): string {
  const text = String(title ?? "");
  const from = cleanProfileName(oldName);
  const to = cleanProfileName(newName);
  // A one-character owner token would match far too much to be safe.
  if (!text || from.length < 2 || !to || sameProfileName(from, to)) return text;

  const owner = escapeRegExp(from);
  let out = text;

  // "Morning Run - Bob QA" → "Morning Run - Bob Robertson"
  out = out.replace(new RegExp(`(\\s[-–—]\\s*)${owner}(\\s*)$`, "i"), (_m, sep, tail) => `${sep}${to}${tail}`);

  // "🎂 Bob QA's Birthday" → "🎂 Bob Robertson's Birthday". The possessive must
  // start the title (emoji and spaces aside) so "Dinner with Bob QA's family"
  // is untouched — that is prose, not a generated label.
  out = out.replace(
    new RegExp(`^([^\\p{L}\\p{N}]*)${owner}(['’ʼ]s?\\s)`, "iu"),
    (_m, lead, poss) => `${lead}${to}${poss}`,
  );

  return out;
}

/** Did a rename leave this title carrying the old name in a generated shape? */
export function titleCarriesOwnerName(title: unknown, oldName: unknown, newName: unknown): boolean {
  return renameOwnerInTitle(title, oldName, newName) !== String(title ?? "");
}
