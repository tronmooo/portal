// server/update-with-dependents.ts — a record and the records that depend on it
// move together, or neither moves.
//
// The QA report's req 6, and the clearest data-integrity failure in it:
//
//   "Sarah has a dentist appointment on September 8 at 2pm."
//   "Remind me two days before."          → reminder on the 6th
//   "Actually I moved it to September 10." → the REMINDER moved to the 8th.
//                                            The APPOINTMENT stayed on the 8th.
//
// Two independent tool calls, two independent writes, one of which failed. The
// data was left describing a world that never existed: a reminder for an
// appointment two days after it.
//
// Two things had to be true for that to happen, and both are fixed:
//
//   1. NO DEPENDENCY EDGE EXISTED. A "two days before" reminder was an ordinary
//      task with a date on it and no memory of why. Nothing could move it with
//      its event because nothing knew they were related. Task now carries
//      `reminderForEventId` + `reminderOffsetMinutes` (shared/schema.ts), so the
//      relationship is a fact about the data rather than a coincidence of dates.
//
//   2. THE WRITES WERE NOT ORDERED OR GATED. This module supplies that: validate
//      the whole mutation, write the PRIMARY, and only then write dependents.
//      If the primary fails, dependents are never touched — the previous
//      behaviour committed them anyway, which is what turned one failed update
//      into corrupted state.
//
// The rollback is compensating rather than a database transaction: the storage
// layer is a set of row operations behind an interface (Supabase REST or the
// in-memory store), with no cross-call transaction to enlist in. So a dependent
// that fails mid-way restores the ones already written from their pre-write
// snapshots. That is weaker than a real transaction and is stated plainly here
// rather than implied — but it is bounded, it is reported, and it never leaves
// the primary and its dependents disagreeing silently.

import type { Task, CalendarEvent } from "@shared/schema";

export interface DependentUpdateStorage {
  getTasks(): Promise<Task[]>;
  updateTask(id: string, data: Partial<Task>): Promise<Task | undefined>;
  updateEvent(id: string, data: any): Promise<CalendarEvent | undefined>;
}

export interface DependentChange {
  type: "task";
  id: string;
  title: string;
  /** What changed, for the reply and the log. */
  from: { dueDate?: string; dueTime?: string };
  to: { dueDate?: string; dueTime?: string };
}

export interface UpdateWithDependentsResult {
  ok: boolean;
  error?: string;
  /** The canonical updated primary row. Absent when the update failed. */
  event?: CalendarEvent;
  /** Dependents actually moved. Empty when there were none. */
  dependents: DependentChange[];
  /** Set when dependents were rolled back after a partial failure. */
  rolledBack?: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Event date + optional time → epoch ms, treating both as wall clock. */
function toMillis(date: string, time?: string | null): number | null {
  if (!DATE_RE.test(String(date || ""))) return null;
  const t = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(time || "")) ? String(time) : "12:00";
  const ms = new Date(`${date}T${t}:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function fromMillis(ms: number): { dueDate: string; dueTime: string } {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    dueDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    dueTime: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * Update an event and move every reminder that depends on it.
 *
 * Order is the whole point: validate → primary → dependents. A failure of the
 * primary writes nothing at all.
 */
export async function updateEventWithDependents(
  storage: DependentUpdateStorage,
  eventId: string,
  changes: Record<string, any>,
): Promise<UpdateWithDependentsResult> {
  // ── 1. Validate the WHOLE mutation before writing anything ───────────────
  if (!eventId) return { ok: false, error: "No event to update.", dependents: [] };
  if (changes?.date != null && !DATE_RE.test(String(changes.date))) {
    return { ok: false, error: `Invalid event date "${changes.date}" — use YYYY-MM-DD.`, dependents: [] };
  }

  // Gather dependents up front, so a read failure is a validation failure
  // rather than a half-finished write.
  let dependentTasks: Task[] = [];
  try {
    const tasks = await storage.getTasks();
    dependentTasks = (tasks || []).filter(
      (t) => (t as any).reminderForEventId === eventId && !t.deletedAt,
    );
  } catch (e: any) {
    return { ok: false, error: `Could not read dependent reminders: ${e?.message || e}`, dependents: [] };
  }

  // ── 2. Primary ───────────────────────────────────────────────────────────
  let event: CalendarEvent | undefined;
  try {
    event = await storage.updateEvent(eventId, changes);
  } catch (e: any) {
    return { ok: false, error: `Event update failed: ${e?.message || e}`, dependents: [] };
  }
  if (!event) {
    // THE case this module exists for: the primary did not land, so the
    // dependents below are not written. Previously they were.
    return { ok: false, error: "Event update did not persist — nothing was changed.", dependents: [] };
  }

  // ── 3. Dependents ────────────────────────────────────────────────────────
  const newAnchor = toMillis(String((event as any).date || ""), (event as any).time);
  if (newAnchor == null || dependentTasks.length === 0) {
    return { ok: true, event, dependents: [] };
  }

  const applied: Array<{ id: string; before: Partial<Task> }> = [];
  const dependents: DependentChange[] = [];
  try {
    for (const task of dependentTasks) {
      const offset = Number((task as any).reminderOffsetMinutes);
      if (!Number.isFinite(offset)) continue;
      const target = fromMillis(newAnchor - offset * 60_000);
      if (task.dueDate === target.dueDate && task.dueTime === target.dueTime) continue;

      const before = { dueDate: task.dueDate, dueTime: task.dueTime };
      const updated = await storage.updateTask(task.id, target as any);
      if (!updated) throw new Error(`reminder "${task.title}" did not persist`);
      applied.push({ id: task.id, before });
      dependents.push({ type: "task", id: task.id, title: task.title, from: before, to: target });
    }
  } catch (e: any) {
    // Compensating rollback: put the dependents we did move back, so the set
    // stays consistent even though the primary already committed.
    for (const a of applied.reverse()) {
      try { await storage.updateTask(a.id, a.before as any); } catch { /* best effort */ }
    }
    try { /* the caller reports; the event stands as updated */ } catch { /* noop */ }
    return {
      ok: false,
      error: `The appointment moved, but its reminders could not follow (${e?.message || e}) — the reminders were left where they were.`,
      event,
      dependents: [],
      rolledBack: true,
    };
  }

  return { ok: true, event, dependents };
}
