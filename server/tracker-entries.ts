// ─── Removing a tracker entry: one implementation, with its inverse edge ─────
//
// Deleting a tracker entry used to be a bare row delete wherever you did it —
// the Trackers page, the tracker-less by-id route, chat, smart-entry undo. But
// an entry can be the MIRROR of a habit check-in (values._habitId, written by
// server/habit-completion.ts): delete only the entry and the habit still shows
// done, the streak still counts the day, and re-logging mirrors nothing because
// the check-in is still there. The forward edge (logEntry → habit check-in via
// autoCheckinLinkedHabits) had no inverse. This is that inverse.

import type { IStorage } from "./storage";
import { HABIT_MIRROR_KEY, mirrorHabitIds, uncompleteHabitOccurrence, type HabitLogger } from "./habit-completion";
import { toLocalDateStr, DEFAULT_TIMEZONE } from "@shared/timezone";

const noopLogger: HabitLogger = { warn: () => {} };

export interface RemoveTrackerEntryResult {
  ok: boolean;
  reason?: "not_found";
  entryId: string;
  trackerId: string;
  /** Habit check-in removed because this entry was its mirror. */
  removedHabitCheckinId?: string;
  habitId?: string;
}

/**
 * Delete one tracker entry and, when the entry is a habit-completion mirror,
 * the habit check-in it mirrors — so "remove the entry" and "un-do the habit"
 * cannot drift apart. The check-in removal is best-effort and logged; the
 * entry removal is the contract.
 */
export async function removeTrackerEntry(
  storage: IStorage,
  input: { trackerId: string; entryId: string },
  timezone: string = DEFAULT_TIMEZONE,
  logger: HabitLogger = noopLogger,
): Promise<RemoveTrackerEntryResult> {
  const base: RemoveTrackerEntryResult = { ok: false, entryId: input.entryId, trackerId: input.trackerId };

  // Read BEFORE deleting — the mirror key and the entry's day are what let us
  // find the paired check-in afterwards.
  const entry = await storage.getTrackerEntry(input.entryId);
  const habitIds = entry ? mirrorHabitIds(entry.values) : [];
  const habitId = habitIds[0] || "";
  const entryDay = entry?.timestamp ? toLocalDateStr(new Date(String(entry.timestamp)), timezone) : "";

  const deleted = await storage.deleteTrackerEntry(input.trackerId, input.entryId);
  if (!deleted) return { ...base, reason: "not_found" };

  if (!habitId || !entryDay) return { ...base, ok: true };

  // A tracker two habits share pairs one entry with both: un-complete every
  // one of them (D227). The first is reported as before.
  for (const extra of habitIds.slice(1)) {
    try {
      await uncompleteHabitOccurrence(storage, { habitId: extra, date: entryDay, source: "tracker", skipTrackerRemoval: true, timezone }, logger);
    } catch (e: any) {
      logger.warn(`[tracker-entries] paired check-in removal failed for ${extra}:`, e?.message || e);
    }
  }

  // The entry mirrored a habit completion: retract that completion too. The
  // mirror is already gone (we just deleted it), so the pipeline's own mirror
  // sweep is suppressed — otherwise a two-dose day would lose both records.
  try {
    const undone = await uncompleteHabitOccurrence(storage, {
      habitId, date: entryDay, source: "tracker", skipTrackerRemoval: true, timezone,
    }, logger);
    if (undone.ok) {
      return { ...base, ok: true, habitId, removedHabitCheckinId: undone.removedCheckinId };
    }
    return { ...base, ok: true, habitId };
  } catch (e: any) {
    logger.warn(`[tracker-entries] paired check-in removal failed:`, e?.message || e);
    return { ...base, ok: true, habitId };
  }
}
