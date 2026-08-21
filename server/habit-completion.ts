// server/habit-completion.ts — THE habit completion pipeline.
//
// User directive 2026-08-20: "Do not implement three separate pieces of
// completion logic." Every way a habit can be completed —
//
//   · AI chat inferring it from "I walked the dog"      (chat_inferred)
//   · AI chat told outright to "mark off my walk habit" (chat_explicit)
//   · tapping the habit on the dashboard or Habits page (habit_ui)
//   · logging the activity to the habit's linked tracker (tracker)
//   · a direct API call                                  (api)
//
// — lands here, in completeHabitOccurrence(). One canonical record, one set of
// side effects, one answer to "is it done today?". The bug that motivated this
// was a dashboard stuck at "0 of 2 done" after the user had marked the habit
// off: the chat path had written a tracker entry and nothing else, because the
// two halves of "completing a habit" lived in different places and neither knew
// about the other.
//
// What one call does:
//   1. resolves TODAY'S occurrence (or a named date) and refuses days the
//      habit isn't scheduled on;
//   2. records only as many completions as the day still has room for, so a
//      repeated report is a no-op instead of an inflated count;
//   3. mirrors the completion into the habit's linked tracker — the richer
//      record — unless the tracker entry is what triggered this in the first
//      place;
//   4. returns the canonical habit + day progress the caller reports from.
//
// Idempotency is structural, not a flag: step 2 clamps to `remaining`, and step
// 3 counts the mirror entries already on the tracker for that habit and day. Say
// "I walked the dog" and then tap the habit and you get one completion and one
// tracker entry, in either order.
//
// A habit's schedule NEVER produces a calendar entry — see the calendar rules
// in server/ai-engine.ts. Nothing in this file touches events or tasks.

import type { Habit, HabitCheckin, TrackerEntry, Tracker } from "@shared/schema";
import { habitDayProgress, type HabitDayProgress } from "@shared/habit-progress";
import { isHabitDueOn } from "@shared/habit-schedule";
import { toLocalDateStr, getUserToday, zonedTimeToUTC, DEFAULT_TIMEZONE } from "@shared/timezone";

/** Where a completion came from. Recorded for history/debugging; the resulting
 *  completion is identical whichever it is. */
export type HabitCompletionSource =
  | "chat_inferred"
  | "chat_explicit"
  | "habit_ui"
  | "tracker"
  | "api";

/** The storage surface this pipeline needs. Both MemStorage and
 *  SupabaseStorage satisfy it; passing it in keeps this module free of any
 *  import cycle with server/storage.ts. */
export interface HabitCompletionStorage {
  getHabit(id: string): Promise<Habit | undefined>;
  getHabits(): Promise<Habit[]>;
  checkinHabit(habitId: string, date?: string, value?: number, notes?: string): Promise<HabitCheckin | undefined>;
  updateHabit(id: string, data: Partial<Habit>): Promise<Habit | undefined>;
  getTracker(id: string): Promise<Tracker | undefined>;
  updateTracker(id: string, data: Partial<Tracker>): Promise<Tracker | undefined>;
  logEntry(data: any): Promise<TrackerEntry | undefined>;
}

export interface CompleteHabitOptions {
  habitId: string;
  source: HabitCompletionSource;
  /** YYYY-MM-DD. Defaults to today in `timezone`. */
  date?: string;
  /** Completions to record. Clamped to what the day still needs. Default 1. */
  count?: number;
  /** Values for the mirrored tracker entry. Omit and the entry records a bare
   *  completion — an honest "it happened, no measurement given". */
  values?: Record<string, any>;
  /** Optional numeric value recorded on the check-in itself (glasses, reps). */
  value?: number;
  notes?: string;
  /** The caller already wrote the tracker entry (source: "tracker"). */
  skipTrackerWrite?: boolean;
  timezone?: string;
}

export interface HabitCompletionResult {
  ok: boolean;
  /** Set when ok is false. */
  reason?: "not_found" | "not_scheduled";
  habitId: string;
  habitName: string;
  date: string;
  source: HabitCompletionSource;
  /** Completions this call actually wrote. 0 when the day was already full. */
  recorded: number;
  alreadyComplete: boolean;
  progress: HabitDayProgress;
  habit?: Habit;
  currentStreak: number;
  /** The linked tracker, when there is one. `name` is null on the
   *  tracker-sourced path, which deliberately skips reading the tracker (the
   *  caller already has it) — see the note in completeHabitOccurrence. */
  tracker?: { id: string; name: string | null } | null;
  /** Mirror entries this call wrote (empty when nothing was needed). */
  trackerEntries: TrackerEntry[];
}

/** Marks a tracker entry as the mirror of a habit completion. Underscore-
 *  prefixed to follow the existing internal-value convention (`_notes`,
 *  `_enrichment`) so display surfaces skip it. */
export const HABIT_MIRROR_KEY = "_habitId";

const dayOf = (ts: unknown, tz: string) => {
  const d = new Date(String(ts ?? ""));
  return isNaN(d.getTime()) ? "" : toLocalDateStr(d, tz);
};

/** Mirror entries already on this tracker for this habit and day. */
function countMirrorEntries(tracker: Tracker | undefined, habitId: string, date: string, tz: string): number {
  if (!tracker) return 0;
  return (tracker.entries || []).filter(
    (e) => (e.values as any)?.[HABIT_MIRROR_KEY] === habitId && dayOf(e.timestamp, tz) === date,
  ).length;
}

/**
 * Complete one (or more) of a habit's occurrences for a day, from any source.
 *
 * Never throws: a failure to mirror into the tracker still leaves the habit
 * completed, because the habit is the thing the user acted on.
 */
export async function completeHabitOccurrence(
  storage: HabitCompletionStorage,
  opts: CompleteHabitOptions,
): Promise<HabitCompletionResult> {
  const tz = opts.timezone || DEFAULT_TIMEZONE;
  const date = String(opts.date || getUserToday(tz)).slice(0, 10);

  const habit = await storage.getHabit(opts.habitId);
  if (!habit) {
    return {
      ok: false, reason: "not_found", habitId: opts.habitId, habitName: "", date,
      source: opts.source, recorded: 0, alreadyComplete: false,
      progress: habitDayProgress({} as any, date), currentStreak: 0, trackerEntries: [],
    };
  }

  const before = habitDayProgress(habit as any, date);
  if (!before.isScheduled) {
    return {
      ok: false, reason: "not_scheduled", habitId: habit.id, habitName: habit.name, date,
      source: opts.source, recorded: 0, alreadyComplete: false,
      progress: before, currentStreak: habit.currentStreak || 0, trackerEntries: [],
    };
  }

  // ── 1. Record check-ins, clamped to what the day still needs ─────────────
  const asked = Number.isFinite(Number(opts.count)) && Number(opts.count) > 0
    ? Math.floor(Number(opts.count))
    : 1;
  const toRecord = Math.max(0, Math.min(asked, before.remaining));
  for (let i = 0; i < toRecord; i++) {
    await storage.checkinHabit(habit.id, date, opts.value, opts.notes);
  }

  const fresh = (await storage.getHabit(habit.id)) || habit;
  const after = habitDayProgress(fresh as any, date);
  const recorded = Math.max(0, after.completed - before.completed);

  // ── 2. Mirror into the linked tracker ────────────────────────────────────
  // Skipped when a tracker entry is what got us here (it already exists), and
  // bounded by how many mirror entries the day already has, so the same
  // completion never writes two records.
  const trackerEntries: TrackerEntry[] = [];
  let trackerInfo: { id: string; name: string | null } | null = null;
  const linkedTrackerId = (fresh as any).linkedTrackerId as string | undefined;
  if (linkedTrackerId) {
    // Reading the tracker pulls its whole entry history, so only do it when a
    // mirror entry might actually be written. The tracker-sourced path — the
    // hot one, since it runs on EVERY tracker entry — skips the read entirely
    // and reports the id alone; its caller already has the tracker in hand.
    const mayWrite = !opts.skipTrackerWrite && recorded > 0;
    if (!mayWrite) {
      trackerInfo = { id: linkedTrackerId, name: null };
    } else try {
      const tracker = await storage.getTracker(linkedTrackerId);
      if (tracker) {
        trackerInfo = { id: tracker.id, name: tracker.name };
        const already = countMirrorEntries(tracker, habit.id, date, tz);
        const needed = Math.max(0, Math.min(recorded, after.completed - already));
        if (needed > 0) {
          // A bare check-in carries no measurement, so it records the fact:
          // one completion. Give the tracker a `completions` field the first
          // time, so the entry is a first-class, chartable row rather than an
          // unknown value silently dropped from the card.
          const hasSuppliedValues = !!opts.values && Object.keys(opts.values).length > 0;
          if (!hasSuppliedValues && !(tracker.fields || []).some(f => f.name === "completions")) {
            try {
              await storage.updateTracker(tracker.id, {
                fields: [...(tracker.fields || []), { name: "completions", type: "number", unit: "×", isPrimary: (tracker.fields || []).length === 0 }],
              } as any);
            } catch { /* non-fatal: the entry still writes */ }
          }
          const timestamp = date === getUserToday(tz)
            ? new Date().toISOString()
            : zonedTimeToUTC(date, 12, 0, tz).toISOString();
          for (let i = 0; i < needed; i++) {
            const entry = await storage.logEntry({
              trackerId: tracker.id,
              values: {
                ...(hasSuppliedValues ? opts.values : { completions: 1 }),
                [HABIT_MIRROR_KEY]: habit.id,
              },
              notes: opts.notes || `${habit.name} — habit check-in`,
              ...(habit.linkedProfiles?.[0] ? { profileId: habit.linkedProfiles[0], forProfile: habit.linkedProfiles[0] } : {}),
              timestamp,
              // Recursion stop: this write must not come back around and
              // check the habit in again.
              __skipHabitSync: true,
            });
            if (entry) trackerEntries.push(entry);
          }
        }
      }
    } catch { /* the habit is completed either way */ }
  }

  return {
    ok: true,
    habitId: habit.id,
    habitName: habit.name,
    date,
    source: opts.source,
    recorded,
    alreadyComplete: recorded === 0 && before.isComplete,
    progress: after,
    habit: fresh,
    currentStreak: fresh.currentStreak || 0,
    tracker: trackerInfo,
    trackerEntries,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracker → habit: logging the activity completes the habit
// ─────────────────────────────────────────────────────────────────────────────

export interface HabitSyncResult {
  habitId: string;
  habitName: string;
  date: string;
  progress: HabitDayProgress;
}

/** First non-underscore numeric value — carried onto the check-in as context. */
function primaryNumericValue(values: Record<string, any> | undefined): number | undefined {
  for (const [k, v] of Object.entries(values || {})) {
    if (!k.startsWith("_") && typeof v === "number" && isFinite(v)) return v;
  }
  return undefined;
}

/**
 * Advance every habit linked to `trackerId` for the entry's day.
 *
 * Called from INSIDE both storages' logEntry, so it covers every write path —
 * AI chat, the deterministic quick-log lane, a manual log on the Trackers page,
 * a bulk import — without each caller having to remember. A day the habit isn't
 * scheduled on is skipped (running on a rest day enriches the tracker and
 * leaves the habit alone), and a day already satisfied is a no-op.
 *
 * Never throws: the tracker entry itself has already landed.
 */
export async function autoCheckinLinkedHabits(
  storage: HabitCompletionStorage,
  trackerId: string,
  opts: { timestamp?: string; values?: Record<string, any>; timezone?: string } = {},
): Promise<HabitSyncResult[]> {
  const results: HabitSyncResult[] = [];
  try {
    // An entry written BY a habit check-in must not check that habit in again.
    if ((opts.values as any)?.[HABIT_MIRROR_KEY]) return results;

    const habits = await storage.getHabits();
    const linked = habits.filter((h) => (h as any).linkedTrackerId === trackerId);
    if (linked.length === 0) return results;

    const tz = opts.timezone || DEFAULT_TIMEZONE;
    const when = opts.timestamp ? new Date(opts.timestamp) : new Date();
    const date = isNaN(when.getTime()) ? toLocalDateStr(new Date(), tz) : toLocalDateStr(when, tz);
    const value = primaryNumericValue(opts.values);

    for (const habit of linked) {
      try {
        if (!isHabitDueOn(habit as any, date)) continue;
        const res = await completeHabitOccurrence(storage, {
          habitId: habit.id,
          date,
          source: "tracker",
          // The tracker entry IS the record — mirroring it back would duplicate it.
          skipTrackerWrite: true,
          notes: value != null ? `Logged ${value} on ${habit.name}'s tracker` : undefined,
        });
        if (res.ok && res.recorded > 0) {
          results.push({ habitId: habit.id, habitName: habit.name, date, progress: res.progress });
        }
      } catch { /* one habit failing must not stop the others */ }
    }
  } catch { /* propagation is best-effort */ }
  return results;
}
