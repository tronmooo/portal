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
//
// SERIES MIRRORS (2026-08-09). A repeating reminder is a set of materialized
// reminder rows, but it is mirrored as ONE recurring calendar event spanning
// the whole series (`recurrence` + `recurrenceEnd`) — see create_reminder.
// So a mirror is no longer identified by an exact date match alone: the event
// backing "every Tuesday at 9am through Aug 2027" is dated at the FIRST
// Tuesday and covers the other 51. These helpers therefore match a series
// mirror whose window covers the reminder's date, and edit it per-occurrence
// (`rd:skip:<date>`, shared/recurring-dates) instead of deleting or moving the
// entire series when a single occurrence is removed or rescheduled.

import { DEFAULT_TIMEZONE } from "@shared/timezone";

/** The minimum storage surface these helpers need — keeps them testable. */
export interface MirrorStorage {
  getEvents(): Promise<any[]>;
  updateEvent(id: string, patch: any): Promise<any>;
  deleteEvent(id: string): Promise<any>;
  /** Optional: lets a rescheduled occurrence leave its series behind. */
  createEvent?(data: any): Promise<any>;
}

const lc = (s: unknown) => String(s || "").toLowerCase().trim();
const day10 = (s: unknown) => String(s || "").slice(0, 10);

/** Is this event a reminder mirror carrying a whole repeating series? */
export function isSeriesMirror(e: any): boolean {
  return !!e && Array.isArray(e.tags) && e.tags.includes("reminder")
    && typeof e.recurrence === "string" && e.recurrence !== "none";
}

/**
 * Does a series mirror's window cover `dayISO`? Deliberately a window check,
 * not a cadence check: the mirror's title and "reminder" tag already pin it to
 * one reminder series, so re-deriving which weekdays it lands on would only add
 * a way for the two expansions to disagree.
 */
function seriesCovers(e: any, dayISO: string): boolean {
  const start = day10(e?.date);
  if (!start || dayISO < start) return false;
  const end = day10(e?.recurrenceEnd);
  return !end || dayISO <= end;
}

/**
 * The calendar events that mirror a given reminder.
 *
 * Match rule: tagged "reminder", same (case-insensitive) title, and either
 * dated on the same local date as the reminder's fire time OR a series mirror
 * whose recurrence window covers that date. Reminders carry no event id, so the
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
  return events.filter((e) => {
    if (!Array.isArray(e?.tags) || !e.tags.includes("reminder")) return false;
    if (lc(e.title) !== title) return false;
    return day10(e.date) === day || (isSeriesMirror(e) && seriesCovers(e, day));
  });
}

/**
 * Every mirror event for a reminder TITLE, whatever date it sits on.
 *
 * `delete_reminder` removes every un-fired occurrence of a series in one go, so
 * it needs the series mirror gone outright rather than skipped date by date
 * (which would leave a fully-skipped husk of an event behind forever).
 */
export function findReminderMirrorsByTitle(events: readonly any[], title: string): any[] {
  const needle = lc(title);
  if (!needle) return [];
  return events.filter(
    (e) => Array.isArray(e?.tags) && e.tags.includes("reminder") && lc(e.title) === needle,
  );
}

/**
 * Retire the calendar mirror of ONE reminder occurrence.
 *
 * A stand-alone mirror is deleted. A series mirror is not — the other 51
 * Tuesdays are still armed — so the removed date is marked `rd:skip:<date>`,
 * which both calendar timelines already honour per occurrence.
 *
 * Best-effort by design: the reminder row is the source of truth and has
 * already been deleted by the caller, so a mirror that fails to update must not
 * turn a successful delete into an error. Returns how many mirrors were touched.
 */
export async function deleteReminderMirrors(
  storage: MirrorStorage,
  reminder: { title: string; fireAt: string | Date },
  timezone: string = DEFAULT_TIMEZONE,
): Promise<number> {
  try {
    const fire = reminder.fireAt instanceof Date ? reminder.fireAt : new Date(reminder.fireAt);
    if (isNaN(fire.getTime())) return 0;
    const day = fire.toLocaleDateString("en-CA", { timeZone: timezone });
    const events = await storage.getEvents();
    const mirrors = findReminderMirrors(events, reminder, timezone);
    let removed = 0;
    for (const m of mirrors) {
      try {
        if (isSeriesMirror(m)) {
          await skipSeriesDate(storage, m, day);
        } else {
          await storage.deleteEvent(m.id);
        }
        removed++;
      } catch { /* best effort */ }
    }
    return removed;
  } catch (e: any) {
    console.warn("[reminder-mirror] cleanup failed:", e?.message || e);
    return 0;
  }
}

/**
 * Delete every mirror event for a reminder title — the whole series, not one
 * occurrence. Used when the caller has just deleted every reminder row with
 * that title (chat `delete_reminder`).
 */
export async function deleteReminderSeriesMirrors(
  storage: MirrorStorage,
  title: string,
): Promise<number> {
  try {
    const events = await storage.getEvents();
    let removed = 0;
    for (const m of findReminderMirrorsByTitle(events, title)) {
      try { await storage.deleteEvent(m.id); removed++; } catch { /* best effort */ }
    }
    return removed;
  } catch (e: any) {
    console.warn("[reminder-mirror] series cleanup failed:", e?.message || e);
    return 0;
  }
}

/** Mark one date of a series mirror skipped, leaving the rest of it live. */
async function skipSeriesDate(storage: MirrorStorage, mirror: any, dayISO: string): Promise<void> {
  const tag = `rd:skip:${dayISO}`;
  const tags: string[] = Array.isArray(mirror.tags) ? mirror.tags : [];
  if (tags.includes(tag)) return;
  await storage.updateEvent(mirror.id, { tags: [...tags, tag] });
}

/**
 * Move / retitle the mirrored calendar events after a reminder is edited, so
 * the calendar shows the new time instead of stranding a copy at the old one.
 *
 * `before` is the reminder as it was (needed to FIND the mirror — the match is
 * on the old title and old date); `after` is the updated row.
 *
 * Editing ONE occurrence of a repeating reminder must not drag its 51 siblings
 * along, so a series mirror is skipped at the old date and the moved occurrence
 * is re-mirrored as its own stand-alone event.
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
    const wasFire = before.fireAt instanceof Date ? before.fireAt : new Date(before.fireAt);
    const oldDay = isNaN(wasFire.getTime()) ? "" : wasFire.toLocaleDateString("en-CA", { timeZone: timezone });
    const events = await storage.getEvents();
    const mirrors = findReminderMirrors(events, before, timezone);
    const patch = {
      title: String(after.title || before.title),
      date: fire.toLocaleDateString("en-CA", { timeZone: timezone }),
      time: fire.toLocaleTimeString("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }),
    };
    let moved = 0;
    for (const m of mirrors) {
      try {
        if (isSeriesMirror(m)) {
          if (!oldDay) continue;
          await skipSeriesDate(storage, m, oldDay);
          // Re-mirror the moved occurrence on its own. Without createEvent the
          // occurrence is only hidden at the old date, which is still better
          // than moving the entire series off its schedule.
          await storage.createEvent?.({
            title: patch.title,
            date: patch.date,
            time: patch.time,
            allDay: false,
            recurrence: "none",
            category: m.category || "personal",
            source: "chat",
            linkedProfiles: Array.isArray(m.linkedProfiles) ? m.linkedProfiles : [],
            linkedDocuments: [],
            tags: ["reminder"],
          });
        } else {
          await storage.updateEvent(m.id, patch);
        }
        moved++;
      } catch { /* best effort */ }
    }
    return moved;
  } catch (e: any) {
    console.warn("[reminder-mirror] move failed:", e?.message || e);
    return 0;
  }
}
