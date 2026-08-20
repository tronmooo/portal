// server/habit-tracker-sync.ts — one activity record updates both.
//
// The habit ↔ tracker separation (user directive 2026-08-20): a measurable
// habit is linked to the tracker that measures it (habits.linked_tracker_id).
// When a tracker entry lands — from AI chat, the deterministic quick-log lane,
// a manual log on the Trackers page, or a bulk import — any habit linked to
// that tracker gets ONE completion recorded for the entry's day, so "drank 32
// oz" advances both the Hydration tracker AND the water habit's progress
// without the user saying "habit" at all.
//
// Called from INSIDE both storage implementations' logEntry (MemStorage and
// SupabaseStorage) so every write path behaves identically — this is what
// makes the update appear "everywhere" without each caller remembering to
// propagate.
//
// Semantics, deliberately conservative:
//   · One entry = ONE completion, capped at the habit's targetPerDay for that
//     day (checkinHabit already enforces the cap — an extra glass of water
//     never overfills the day or double-counts a streak).
//   · The completion lands on the ENTRY's calendar day in the user's
//     timezone, so a backdated log advances the day it happened.
//   · Days outside the habit's schedule are skipped: running on a rest day
//     enriches the tracker but doesn't invent a habit occurrence. The habit's
//     schedule stays internal habit logic — never calendar logic.
//   · Failures are swallowed: propagation must never break the log itself.
//
// The reverse is intentionally absent: checking a habit off by hand does NOT
// fabricate a tracker entry (there is no measurement to record), and tracking
// something never creates a habit.

import type { HabitCheckin } from "@shared/schema";
import { isHabitDueOn, isHabitDoneOn } from "@shared/habit-schedule";
import { toLocalDateStr, DEFAULT_TIMEZONE } from "@shared/timezone";

/** The minimal storage surface the sync needs (both storages satisfy it). */
export interface HabitSyncStorage {
  getHabits(): Promise<Array<{
    id: string;
    name: string;
    linkedTrackerId?: string | null;
    frequency?: string;
    targetDays?: number[] | null;
    targetPerDay?: number | null;
    startDate?: string | null;
    endDate?: string | null;
    checkins?: Array<{ date?: string | null }> | null;
  }>>;
  checkinHabit(habitId: string, date?: string, value?: number, notes?: string): Promise<HabitCheckin | undefined>;
}

export interface HabitSyncResult {
  habitId: string;
  habitName: string;
  date: string;
}

/** First non-underscore numeric value in the entry — carried onto the check-in
 * (e.g. ounces on a water habit) purely as display context. */
function primaryNumericValue(values: Record<string, any> | undefined): number | undefined {
  for (const [k, v] of Object.entries(values || {})) {
    if (!k.startsWith("_") && typeof v === "number" && isFinite(v)) return v;
  }
  return undefined;
}

/**
 * Record one completion on every habit linked to `trackerId` for the entry's
 * day. Returns what moved (empty when nothing is linked or everything was
 * already satisfied). Never throws.
 */
export async function autoCheckinLinkedHabits(
  storage: HabitSyncStorage,
  trackerId: string,
  opts: { timestamp?: string; values?: Record<string, any>; timezone?: string } = {},
): Promise<HabitSyncResult[]> {
  const results: HabitSyncResult[] = [];
  try {
    const habits = await storage.getHabits();
    const linked = habits.filter((h) => h.linkedTrackerId === trackerId);
    if (linked.length === 0) return results;

    const tz = opts.timezone || DEFAULT_TIMEZONE;
    const when = opts.timestamp ? new Date(opts.timestamp) : new Date();
    const dateStr = isNaN(when.getTime())
      ? toLocalDateStr(new Date(), tz)
      : toLocalDateStr(when, tz);
    const value = primaryNumericValue(opts.values);

    for (const habit of linked) {
      try {
        if (!isHabitDueOn(habit, dateStr)) continue;   // rest day — tracker only
        if (isHabitDoneOn(habit, dateStr)) continue;   // day already satisfied
        const checkin = await storage.checkinHabit(habit.id, dateStr, value, "Auto-logged from tracker entry");
        if (checkin) results.push({ habitId: habit.id, habitName: habit.name, date: dateStr });
      } catch {
        // one habit failing must not stop the others
      }
    }
  } catch {
    // propagation is best-effort; the tracker entry itself already landed
  }
  return results;
}
