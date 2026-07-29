// server/reminder-mirror.ts
//
// A timed reminder is mirrored onto the calendar as a companion event, so
// "remind me to call the plumber at 5pm" is visible on the calendar rather than
// only firing a silent notification. The mirror is created by the chat tool
// (`create_reminder` in ai-engine.ts).
//
// The mirror is a SECOND row, and that is what made it dangerous. QA report
// 2026-07-29 (CRUD-T2-002): a chat-created reminder was edited, then deleted
// through the UI — both actions reported success — and it reappeared on the
// calendar at its ORIGINAL time on the next fetch. `DELETE /api/reminders/:id`
// and `PATCH /api/reminders/:id` only ever touched the reminder row; the
// mirror event outlived its source, so the calendar kept projecting a reminder
// the user had already deleted, and the edit never moved it.
//
// The chat tools already carried their own inline copies of this cleanup. This
// module is the one implementation, shared by the chat tools and the REST
// routes, so a reminder cannot be deleted through one door and survive behind
// the other.

import { DEFAULT_TIMEZONE } from "@shared/timezone";

/** The minimum storage surface these helpers need — keeps them testable. */
export interface MirrorStorage {
  getEvents(): Promise<any[]>;
  updateEvent(id: string, patch: any): Promise<any>;
  deleteEvent(id: string): Promise<any>;
}

const lc = (s: unknown) => String(s || "").toLowerCase().trim();

/**
 * The calendar events that mirror a given reminder.
 *
 * Match rule: tagged "reminder", same (case-insensitive) title, on the same
 * local date as the reminder's fire time. Reminders carry no event id, so the
 * title+date identity is the only link available — the same rule the chat
 * `delete_reminder` tool has always used, kept here so both agree.
 */
export function findReminderMirrors(
  events: readonly any[],
  reminder: { title: string; fireAt: string | Date },
  timezone: string = DEFAULT_TIMEZONE,
): any[] {
  const fire = reminder.fireAt instanceof Date ? reminder.fireAt : new Date(reminder.fireAt);
  if (isNaN(fire.getTime())) return [];
  const day = fire.toLocaleDateString("en-CA", { timeZone: timezone });
  const title = lc(reminder.title);
  return events.filter(
    (e) => Array.isArray(e?.tags) && e.tags.includes("reminder") && lc(e.title) === title && String(e.date || "").slice(0, 10) === day,
  );
}

/**
 * Delete every calendar event mirroring `reminder`.
 *
 * Best-effort by design: the reminder row is the source of truth and has
 * already been deleted by the caller, so a mirror that fails to delete must not
 * turn a successful delete into an error. Returns how many were removed.
 */
export async function deleteReminderMirrors(
  storage: MirrorStorage,
  reminder: { title: string; fireAt: string | Date },
  timezone: string = DEFAULT_TIMEZONE,
): Promise<number> {
  try {
    const events = await storage.getEvents();
    const mirrors = findReminderMirrors(events, reminder, timezone);
    let removed = 0;
    for (const m of mirrors) {
      try { await storage.deleteEvent(m.id); removed++; } catch { /* best effort */ }
    }
    return removed;
  } catch (e: any) {
    console.warn("[reminder-mirror] cleanup failed:", e?.message || e);
    return 0;
  }
}

/**
 * Move / retitle the mirrored calendar events after a reminder is edited, so
 * the calendar shows the new time instead of stranding a copy at the old one.
 *
 * `before` is the reminder as it was (needed to FIND the mirror — the match is
 * on the old title and old date); `after` is the updated row.
 */
export async function syncReminderMirrors(
  storage: MirrorStorage,
  before: { title: string; fireAt: string | Date },
  after: { title: string; fireAt: string | Date },
  timezone: string = DEFAULT_TIMEZONE,
): Promise<number> {
  try {
    const fire = after.fireAt instanceof Date ? after.fireAt : new Date(after.fireAt);
    if (isNaN(fire.getTime())) return 0;
    const events = await storage.getEvents();
    const mirrors = findReminderMirrors(events, before, timezone);
    const patch = {
      title: String(after.title || before.title),
      date: fire.toLocaleDateString("en-CA", { timeZone: timezone }),
      time: fire.toLocaleTimeString("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }),
    };
    let moved = 0;
    for (const m of mirrors) {
      try { await storage.updateEvent(m.id, patch); moved++; } catch { /* best effort */ }
    }
    return moved;
  } catch (e: any) {
    console.warn("[reminder-mirror] move failed:", e?.message || e);
    return 0;
  }
}
