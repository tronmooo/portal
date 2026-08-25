// Carry a rename into the titles that were generated from the old name.
//
// A profile's name lives on its own row and every screen resolves it by id, so
// renaming the row is almost the whole job. The exception is the handful of
// titles the app writes FROM the name when it creates a record for someone:
//
//   · "Morning Run - Bob QA"      a habit or tracker auto-created for a person
//   · "🎂 Bob QA's Birthday"       the event a profile's date of birth produces
//
// Those are copies of the name, and before this they simply went stale. For
// trackers the effect was worse than stale: the read path hides a trailing
// owner suffix by matching it against the owner's CURRENT name
// (stripTrackerOwnerSuffix), so a rename stopped the match and the OLD name
// reappeared on screen where it had been invisible.
//
// This walks only records LINKED TO THE RENAMED PROFILE BY ID, and only
// rewrites the two generated shapes. It deliberately does not touch:
//   · notes, journal entries, artifacts — the user's own words;
//   · ai_action_log / audit rows — a log says what happened at the time, and
//     rewriting history to match the present is falsifying it;
//   · any record not linked to this profile, however its title reads.
//
// Best-effort by design: a rename that succeeded must not be reported as
// failed because a follow-up title could not be written. Failures are counted
// and logged, never thrown.

import { renameOwnerInTitle } from "@shared/profile-rename";

export interface RenameCascadeResult {
  /** Rows whose title was rewritten, by kind. */
  updated: { habits: number; trackers: number; events: number; tasks: number };
  /** Rows that matched but could not be written. */
  failed: number;
}

const EMPTY: RenameCascadeResult = {
  updated: { habits: 0, trackers: 0, events: 0, tasks: 0 },
  failed: 0,
};

function linkedTo(row: any, profileId: string): boolean {
  const links = row?.linkedProfiles;
  if (Array.isArray(links)) return links.includes(profileId);
  return false;
}

/**
 * Rewrite the old name in the titles of this profile's own records.
 *
 * `storage` is the user-scoped storage the caller is already using, so the
 * walk sees only that user's rows.
 */
export async function cascadeProfileRename(
  storage: any,
  profileId: string,
  oldName: string,
  newName: string,
): Promise<RenameCascadeResult> {
  const result: RenameCascadeResult = {
    updated: { habits: 0, trackers: 0, events: 0, tasks: 0 },
    failed: 0,
  };
  if (!profileId || !oldName || !newName || oldName === newName) return EMPTY;

  // Each kind: how to list it, how to read its title, how to write it back.
  const kinds: Array<{
    key: keyof RenameCascadeResult["updated"];
    list: string;
    update: string;
    titleField: "name" | "title";
  }> = [
    { key: "habits", list: "getHabits", update: "updateHabit", titleField: "name" },
    { key: "trackers", list: "getTrackers", update: "updateTracker", titleField: "name" },
    { key: "events", list: "getEvents", update: "updateEvent", titleField: "title" },
    { key: "tasks", list: "getTasks", update: "updateTask", titleField: "title" },
  ];

  for (const kind of kinds) {
    if (typeof storage?.[kind.list] !== "function" || typeof storage?.[kind.update] !== "function") continue;
    let rows: any[] = [];
    try {
      rows = (await storage[kind.list]()) || [];
    } catch (e: any) {
      // One unreadable list must not stop the others.
      try { console.warn(`[rename-cascade] ${kind.list} failed: ${e?.message || e}`); } catch { /* noop */ }
      continue;
    }
    for (const row of rows) {
      if (!row?.id || !linkedTo(row, profileId)) continue;
      const current = row[kind.titleField];
      const next = renameOwnerInTitle(current, oldName, newName);
      if (next === current) continue;
      try {
        await storage[kind.update](row.id, { [kind.titleField]: next });
        result.updated[kind.key]++;
      } catch (e: any) {
        result.failed++;
        try { console.warn(`[rename-cascade] ${kind.update}(${row.id}) failed: ${e?.message || e}`); } catch { /* noop */ }
      }
    }
  }

  return result;
}
