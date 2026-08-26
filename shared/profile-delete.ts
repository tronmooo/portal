// ─── Deleting a profile ─────────────────────────────────────────────────────
//
// Deleting a person or a pet is the one write on a profile that cannot be
// walked back: `storage.deleteProfile` cascades onto everything the profile
// solely owns (trackers and their entries, tasks, events, expenses, documents,
// journal entries, goals, habits…) and strips the profile from anything it
// co-owns. Until now nothing on the Info tab could do it — a profile created by
// mistake, or a person no longer being tracked, stayed forever.
//
// The rule the door is held to lives here so the screen and the route refuse
// for the same reason, and say the same sentence when they do.

/** A profile can be deleted unless it is the user's own record. */
export type ProfileDeleteCheck =
  | { status: "ok" }
  | { status: "rejected"; error: string };

/**
 * May this profile be deleted?
 *
 * "self" is refused for the same reason it can't be re-typed
 * (checkProfileTypeChange): the app resolves the user's own record BY that
 * type. Deleting it leaves scope, ownership and every "Me" resolution with no
 * answer, and the cascade would take the user's own data with it.
 */
export function checkProfileDelete(
  profile: { type?: unknown; name?: unknown } | null | undefined,
): ProfileDeleteCheck {
  if (!profile) return { status: "rejected", error: "That profile no longer exists." };
  if (String(profile.type ?? "").trim().toLowerCase() === "self") {
    return {
      status: "rejected",
      error: "This is your own profile — the app resolves everything you own by it, so it can't be deleted.",
    };
  }
  return { status: "ok" };
}

/**
 * The sentence shown above the confirm button. Deleting cascades, so the
 * warning names what actually goes and what survives — a co-owned expense is
 * not deleted, it just stops being theirs.
 */
export function profileDeleteWarning(name: unknown): string {
  const who = String(name ?? "").trim() || "this profile";
  return `Deleting ${who} removes the profile and every record it solely owns — fields, notes, tags, documents, trackers and their entries, tasks, events, expenses, habits, goals and journal entries. Anything shared with someone else is kept, with ${who} removed from it. This cannot be undone.`;
}
