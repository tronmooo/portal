// Carry a habit rename into the tracker that mirrors it.
//
// A measurable habit mirrors its check-ins into a tracker
// (habit.linkedTrackerId). When no compatible tracker existed one was
// auto-created and NAMED AFTER THE HABIT (server/habit-completion.ts
// resolveTrackerForHabit). That name is a COPY of habit.name
// (shared/schema.ts FIELD_ORIGIN["tracker.name[mirror]"]), and before this it
// simply went stale: rename "Read for 15 minutes" to "Read for 12 minutes"
// and the Trackers page, the wellness tiles and Recent Activity kept saying
// "Read for 15 minutes" — a copy nothing kept in sync (Rules 19/20).
//
// The rule: a rename follows the RELATIONSHIP, not the text.
//   · tracker.linkedHabitId === habit.id  → it is this habit's mirror: rename.
//   · no stamp (a legacy mirror from before migrations/20260922) and its name
//     still equals the OLD habit name → the same mirror, recognised the old
//     way: rename.
//   · anything else — a tracker the user made and linked ("Exercise" absorbing
//     a running habit), or one stamped for another habit — is THEIRS: leave it.
//
// Best-effort by design, like profile-rename-cascade: the habit rename already
// succeeded and must not be reported as failed because the follow-up write
// could not land. Failures are logged as a stale_dependency, never thrown.

import { logIntegrity } from "./integrity-log";

export interface HabitRenameCascadeResult {
  /** The mirror tracker that was renamed, or null when nothing qualified. */
  renamedTrackerId: string | null;
  /** Why no tracker was renamed (for logs / tests). */
  reason?: "no_change" | "no_linked_tracker" | "tracker_missing" | "not_a_mirror" | "already_named" | "write_failed";
}

function norm(s: unknown): string {
  return String(s ?? "").trim();
}

/**
 * Rename the mirror tracker of `habitId` from `oldName` to `newName`.
 *
 * `storage` is the user-scoped storage the caller is already using
 * (IStorage: getHabit / getTracker / updateTracker).
 */
export async function cascadeHabitRename(
  storage: any,
  habitId: string,
  oldName: string,
  newName: string,
): Promise<HabitRenameCascadeResult> {
  const from = norm(oldName);
  const to = norm(newName);
  if (!habitId || !to || from === to) return { renamedTrackerId: null, reason: "no_change" };

  let habit: any;
  try { habit = await storage.getHabit(habitId); } catch { habit = undefined; }
  const trackerId = habit?.linkedTrackerId ? String(habit.linkedTrackerId) : null;
  if (!trackerId) return { renamedTrackerId: null, reason: "no_linked_tracker" };

  let tracker: any;
  try { tracker = await storage.getTracker(trackerId); } catch { tracker = undefined; }
  if (!tracker) return { renamedTrackerId: null, reason: "tracker_missing" };

  const stampedFor = tracker.linkedHabitId ? String(tracker.linkedHabitId) : null;
  const isMirror = stampedFor
    ? stampedFor === habitId
    : norm(tracker.name) === from; // legacy mirror: recognised by the copied name
  if (!isMirror) return { renamedTrackerId: null, reason: "not_a_mirror" };
  if (norm(tracker.name) === to) return { renamedTrackerId: tracker.id, reason: "already_named" };

  try {
    await storage.updateTracker(tracker.id, { name: to });
    return { renamedTrackerId: tracker.id };
  } catch (e: any) {
    // The copy is now stale — say so where an operator will see it.
    logIntegrity({
      kind: "stale_dependency",
      message: `habit ${habitId} renamed to "${to}" but its mirror tracker ${tracker.id} could not be renamed: ${e?.message || e}`,
      entityType: "tracker",
      entityId: tracker.id,
    } as any);
    return { renamedTrackerId: null, reason: "write_failed" };
  }
}
