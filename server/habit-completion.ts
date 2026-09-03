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
import { habitDayProgress, habitDayCheckins, latestCheckinOn, checkinAtPosition, type HabitDayProgress } from "@shared/habit-progress";
import { isHabitDueOn } from "@shared/habit-schedule";
import { toLocalDateStr, getUserToday, zonedTimeToUTC, DEFAULT_TIMEZONE } from "@shared/timezone";
import { detectHabitMetric, UMBRELLA_TRACKER_NAMES } from "@shared/habit-metric";
import { findIdentityMatches } from "@shared/tracker-identity";
import { resolveTrackerCategory } from "@shared/entity-classify";

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
  deleteHabitCheckin(habitId: string, checkinId: string): Promise<boolean>;
  updateHabit(id: string, data: Partial<Habit>): Promise<Habit | undefined>;
  getTracker(id: string): Promise<Tracker | undefined>;
  getTrackers(): Promise<Tracker[]>;
  createTracker(data: any): Promise<Tracker>;
  updateTracker(id: string, data: Partial<Tracker>): Promise<Tracker | undefined>;
  logEntry(data: any): Promise<TrackerEntry | undefined>;
  deleteTrackerEntry(trackerId: string, entryId: string): Promise<boolean>;
  getProfiles(): Promise<Array<{ id: string; type?: string }>>;
}

/** Best-effort steps report what they skipped instead of swallowing it. */
export type HabitLogger = Pick<Console, "warn">;
const noopLogger: HabitLogger = { warn: () => {} };

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
  /**
   * Give the habit a tracker if it doesn't have one, so the completion always
   * lands somewhere trackable (user directive: "manual habit completion =
   * habit completion + tracker entry"). Default true; pass false to complete
   * the habit alone.
   */
  ensureTracker?: boolean;
  timezone?: string;
}

export interface HabitCompletionResult {
  ok: boolean;
  /** Set when ok is false. */
  reason?: "not_found" | "not_scheduled" | "in_future";
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
/** Every habit an entry is paired with — a tracker two habits share pairs
 *  one entry with both (D227). `_habitId` keeps the first for older readers. */
export const HABIT_MIRROR_IDS_KEY = "_habitIds";

/** The habit ids an entry is paired with (either key, deduplicated). */
export function mirrorHabitIds(values: unknown): string[] {
  const v = (values && typeof values === "object" ? values : {}) as Record<string, unknown>;
  const out: string[] = [];
  const one = v[HABIT_MIRROR_KEY];
  if (typeof one === "string" && one) out.push(one);
  const many = v[HABIT_MIRROR_IDS_KEY];
  if (Array.isArray(many)) for (const id of many) if (typeof id === "string" && id && !out.includes(id)) out.push(id);
  return out;
}

const dayOf = (ts: unknown, tz: string) => {
  const d = new Date(String(ts ?? ""));
  return isNaN(d.getTime()) ? "" : toLocalDateStr(d, tz);
};

/** Mirror entries already on this tracker for this habit and day. */
function countMirrorEntries(tracker: Tracker | undefined, habitId: string, date: string, tz: string): number {
  if (!tracker) return 0;
  return (tracker.entries || []).filter(
    (e) => mirrorHabitIds(e.values).includes(habitId) && dayOf(e.timestamp, tz) === date,
  ).length;
}

/**
 * Find (or make) the tracker that should hold this habit's records.
 *
 * ONE resolver, shared by habit creation and habit completion, so the two can
 * never disagree about which tracker a habit belongs to. The ladder:
 *
 *   1. a hint (the model's `linkTracker` argument) or the habit's metric
 *      candidates, identity-matched against EXISTING trackers — "Water"
 *      reconnects to an existing Hydration tracker rather than duplicating it;
 *   2. an umbrella tracker for the same domain (an existing Exercise tracker
 *      absorbs a running habit instead of being shadowed by a new one);
 *   3. a new tracker, named for the metric — or, when the habit measures
 *      nothing nameable, for the habit itself.
 *
 * Only ever reuses a tracker the habit's owner can log to (theirs, or an
 * unowned orphan); adopting another profile's tracker would cross-contaminate
 * their data.
 *
 * `fallbackToHabitName` is the difference between the two callers, and it
 * encodes a distinction the user drew across two messages. At habit CREATION
 * it is false: "make my bed every morning" measures nothing, and manufacturing
 * a tracker for it is the "pointless tracker" they ruled out. At habit
 * COMPLETION it is true: they have now actually done the thing, and "manual
 * habit completion = habit completion + tracker entry", so the completion gets
 * a home even for a habit whose name suggests no metric.
 */
export async function resolveTrackerForHabit(
  storage: HabitCompletionStorage,
  habit: { id: string; name: string; linkedProfiles?: string[] | null },
  opts: {
    hint?: string;
    userMessage?: string;
    ownerProfileId?: string;
    fallbackToHabitName?: boolean;
  } = {},
): Promise<{ id: string; name: string; created: boolean } | null> {
  const hint = String(opts.hint || "").trim();
  if (/^(none|no|skip)$/i.test(hint)) return null;

  const metric = detectHabitMetric(habit.name, opts.userMessage);
  const candidates = Array.from(new Set([
    ...(hint ? [hint] : []),
    ...(metric ? metric.candidates : []),
    ...(opts.fallbackToHabitName ? [habit.name] : []),
  ].filter(Boolean)));
  if (candidates.length === 0) return null;

  const [allTrackers, profiles] = await Promise.all([storage.getTrackers(), storage.getProfiles()]);
  const ownerId = opts.ownerProfileId
    || habit.linkedProfiles?.[0]
    || profiles.find((p) => p.type === "self")?.id;
  const compatible = (t: Tracker) => {
    const owners = t.linkedProfiles || [];
    return owners.length === 0 || (!!ownerId && owners.includes(ownerId));
  };

  for (const cand of candidates) {
    const match = findIdentityMatches(allTrackers, cand).filter(compatible)[0];
    if (match) return { id: match.id, name: match.name, created: false };
  }
  if (metric) {
    for (const umbrella of UMBRELLA_TRACKER_NAMES[metric.category] || []) {
      const match = findIdentityMatches(allTrackers, umbrella).filter(compatible)[0];
      if (match) return { id: match.id, name: match.name, created: false };
    }
  }

  const name = candidates[0];
  const category = resolveTrackerCategory(name, { supplied: metric?.category }).category;
  // A habit with no metric still needs somewhere to put "it happened".
  const fields = (metric?.fields || [{ name: "completions", type: "number" as const, unit: "×", isPrimary: true }])
    .map((f) => ({ name: f.name, type: f.type, ...(f.unit ? { unit: f.unit } : {}), ...(f.isPrimary ? { isPrimary: true } : {}) }));
  const created = await storage.createTracker({
    name, category, fields,
    ...(ownerId ? { linkedProfiles: [ownerId] } : {}),
  });
  return { id: created.id, name: created.name, created: true };
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
  logger: HabitLogger = noopLogger,
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

  // A check-in is a record of something done; a day that has not happened
  // yet in the user's zone cannot carry one (the tracker log refuses future
  // entries the same way). It used to be accepted, and "done Thursday" on a
  // Tuesday inflated the streak with days that were never lived.
  const userToday = getUserToday(tz);
  if (date > userToday) {
    return {
      ok: false, reason: "in_future", habitId: habit.id, habitName: habit.name, date,
      source: opts.source, recorded: 0, alreadyComplete: false,
      progress: habitDayProgress(habit as any, date), currentStreak: habit.currentStreak || 0, trackerEntries: [],
    };
  }

  const before = habitDayProgress(habit as any, date);
  // An off-schedule day (a "weekly" habit — Mondays unless days are set —
  // tapped on a Friday, a Mon/Wed/Fri habit done on a Tuesday) used to be
  // refused with `recorded: 0` while the route still answered 201 and the
  // habits page had already toasted "complete!" — the tap was lost and the
  // card reverted a moment later (D225). A check-in is a record of something
  // done: it is kept, flagged `not_scheduled`, and stays out of the streak
  // (the streak walk only visits scheduled days) and the weekly rollup.
  const offSchedule = !before.isScheduled;

  // ── 1. Record check-ins, clamped to what the day still needs ─────────────
  const asked = Number.isFinite(Number(opts.count)) && Number(opts.count) > 0
    ? Math.floor(Number(opts.count))
    : 1;
  const toRecord = offSchedule ? asked : Math.max(0, Math.min(asked, before.remaining));
  for (let i = 0; i < toRecord; i++) {
    await storage.checkinHabit(habit.id, date, opts.value, opts.notes);
  }

  const fresh = (await storage.getHabit(habit.id)) || habit;
  const after = habitDayProgress(fresh as any, date);
  const recorded = offSchedule
    ? Math.max(0, (after.rawCompleted ?? 0) - (before.rawCompleted ?? 0))
    : Math.max(0, after.completed - before.completed);

  // ── 2. Mirror into the linked tracker ────────────────────────────────────
  // Skipped when a tracker entry is what got us here (it already exists), and
  // bounded by how many mirror entries the day already has, so the same
  // completion never writes two records.
  const trackerEntries: TrackerEntry[] = [];
  let trackerInfo: { id: string; name: string | null } | null = null;
  let linkedTrackerId = (fresh as any).linkedTrackerId as string | undefined;
  // Reading the tracker pulls its whole entry history, so only do it when a
  // mirror entry might actually be written. The tracker-sourced path — the
  // hot one, since it runs on EVERY tracker entry — skips the read entirely
  // and reports the id alone; its caller already has the tracker in hand.
  const mayWrite = !opts.skipTrackerWrite && recorded > 0;
  let tracker: Tracker | undefined;
  let trackerReadFailed = false;

  // A link that points at a tracker that no longer exists is no link at all.
  // deleteTracker used to leave habits.linked_tracker_id dangling, and this
  // path then read `undefined`, wrote no mirror, and never re-linked — the
  // ring said done and the chart said nothing, forever. Treat the dangling id
  // as "no tracker yet" so the resolver below gives the habit a live one.
  // (A read that THROWS is a transient failure, not a dangling link: keep the
  // link and skip the mirror rather than re-pointing the habit elsewhere.)
  if (linkedTrackerId && mayWrite) {
    try {
      tracker = await storage.getTracker(linkedTrackerId);
    } catch (e: any) {
      trackerReadFailed = true;
      logger.warn(`[habit-completion] tracker read failed for "${habit.name}":`, e?.message || e);
    }
    if (!tracker && !trackerReadFailed) {
      logger.warn(`[habit-completion] "${habit.name}" was linked to tracker ${linkedTrackerId}, which no longer exists — re-linking`);
      linkedTrackerId = undefined;
    }
  }

  // No tracker yet? Give it one, so a completion always leaves a record on the
  // tracker side too ("manual habit completion = habit completion + tracker
  // entry"). Reuses a compatible existing tracker before creating anything —
  // the same resolver habit creation uses, so the two cannot disagree.
  if (!linkedTrackerId && mayWrite && opts.ensureTracker !== false) {
    try {
      const resolved = await resolveTrackerForHabit(storage, fresh, { fallbackToHabitName: true });
      if (resolved) {
        await storage.updateHabit(fresh.id, { linkedTrackerId: resolved.id } as any);
        linkedTrackerId = resolved.id;
        tracker = undefined; // fetched fresh below
      }
    } catch (e: any) {
      // The habit is completed either way — but say what was skipped.
      logger.warn(`[habit-completion] tracker resolution failed for "${habit.name}":`, e?.message || e);
    }
  }

  if (linkedTrackerId) {
    if (!mayWrite || trackerReadFailed) {
      trackerInfo = { id: linkedTrackerId, name: null };
    } else try {
      if (!tracker) tracker = await storage.getTracker(linkedTrackerId);
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
            } catch (e: any) {
              logger.warn(`[habit-completion] adding completions field to "${tracker.name}" failed:`, e?.message || e);
            }
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
              // The 2nd and 3rd mirror of a "twice/thrice daily" habit carry
              // the same values as the 1st, moments apart — exactly the shape
              // logEntry's accidental-double-fire dedup swallows. It handed
              // back the FIRST row's id, so a 2× habit had one mirror entry
              // and the un-check then deleted the only one. Each check-in is
              // a deliberate, distinct record: bypass the dedup.
              __skipDedupe: true,
            });
            if (entry) trackerEntries.push(entry);
          }
        }
      }
    } catch (e: any) {
      // The habit is completed either way — but a silently missing mirror is
      // how "the ring says done, the chart says nothing" happens. Say so.
      logger.warn(`[habit-completion] tracker mirror failed for "${habit.name}":`, e?.message || e);
    }
  }

  return {
    ok: true,
    ...(offSchedule ? { reason: "not_scheduled" as const } : {}),
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
// The inverse: un-completing an occurrence
// ─────────────────────────────────────────────────────────────────────────────

export interface UncompleteHabitOptions {
  habitId: string;
  source: HabitCompletionSource;
  /** YYYY-MM-DD. Defaults to today in `timezone`. */
  date?: string;
  /** Explicit check-in row to remove. Wins over `position`. */
  checkinId?: string;
  /** 1-based position within the day ("undo my first dose"). Default: latest. */
  position?: number;
  /** The caller already removed the mirror entry (removeTrackerEntry) — do
   *  not sweep for another one, or a two-dose day loses both records. */
  skipTrackerRemoval?: boolean;
  timezone?: string;
}

export interface HabitUncompletionResult {
  ok: boolean;
  reason?: "not_found" | "no_checkin";
  habitId: string;
  habitName: string;
  date: string;
  removedCheckinId?: string;
  /** Mirror tracker entries removed alongside the check-in. */
  removedTrackerEntryIds: string[];
  progress: HabitDayProgress;
  habit?: Habit;
  currentStreak: number;
}

/**
 * Remove one of a habit's check-ins for a day — the exact inverse of
 * completeHabitOccurrence, which did not exist before: every un-check path
 * called storage.deleteHabitCheckin directly, so the mirrored tracker entry
 * survived (medication adherence kept counting the un-taken dose, and
 * countMirrorEntries then suppressed the mirror on a later re-check-in).
 *
 * Never throws. The check-in removal is the essential step; the mirror
 * removal is best-effort and logged.
 */
export async function uncompleteHabitOccurrence(
  storage: HabitCompletionStorage,
  opts: UncompleteHabitOptions,
  logger: HabitLogger = noopLogger,
): Promise<HabitUncompletionResult> {
  const tz = opts.timezone || DEFAULT_TIMEZONE;
  const date = String(opts.date || getUserToday(tz)).slice(0, 10);

  const habit = await storage.getHabit(opts.habitId);
  if (!habit) {
    return {
      ok: false, reason: "not_found", habitId: opts.habitId, habitName: "", date,
      removedTrackerEntryIds: [], progress: habitDayProgress({} as any, date), currentStreak: 0,
    };
  }

  // ── 1. Resolve which check-in to remove ──────────────────────────────────
  const dayCheckins = habitDayCheckins(habit as any, date);
  let target: { id?: string } | null = null;
  if (opts.checkinId) {
    target = dayCheckins.find((c) => c.id === opts.checkinId)
      ?? ((habit.checkins || []).find((c: any) => c.id === opts.checkinId) as any)
      ?? null;
  } else if (opts.position != null) {
    target = checkinAtPosition(habit as any, date, opts.position);
  } else {
    target = latestCheckinOn(habit as any, date);
  }
  if (!target?.id) {
    return {
      ok: false, reason: "no_checkin", habitId: habit.id, habitName: habit.name, date,
      removedTrackerEntryIds: [], progress: habitDayProgress(habit as any, date),
      currentStreak: habit.currentStreak || 0,
    };
  }

  // ── 2. Remove it (streak recompute lives in the storage method) ──────────
  const deleted = await storage.deleteHabitCheckin(habit.id, target.id);
  if (!deleted) {
    return {
      ok: false, reason: "no_checkin", habitId: habit.id, habitName: habit.name, date,
      removedTrackerEntryIds: [], progress: habitDayProgress(habit as any, date),
      currentStreak: habit.currentStreak || 0,
    };
  }

  // ── 3. Remove the mirrored tracker entry for the same day ────────────────
  // Newest-first, one per removed check-in. deleteTrackerEntry has no habit
  // sync, so there is no recursion to guard against.
  const removedTrackerEntryIds: string[] = [];
  const linkedTrackerId = (habit as any).linkedTrackerId as string | undefined;
  if (linkedTrackerId && !opts.skipTrackerRemoval) {
    try {
      const tracker = await storage.getTracker(linkedTrackerId);
      const mirrors = (tracker?.entries || [])
        .filter((e) => mirrorHabitIds(e.values).includes(habit.id) && dayOf(e.timestamp, tz) === date)
        .sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));
      const mirror = mirrors[0];
      if (mirror?.id && tracker) {
        const others = mirrorHabitIds(mirror.values).filter((id) => id !== habit.id);
        if (others.length === 0) {
          const gone = await storage.deleteTrackerEntry(tracker.id, mirror.id);
          if (gone) removedTrackerEntryIds.push(mirror.id);
        } else if (typeof (storage as any).updateTrackerEntry === "function") {
          // The entry is also another habit's record (a shared tracker): keep
          // the user's log and just unpair this habit from it (D227).
          // Storage merges `values`; a key that must go is named in
          // `valuesToDelete` (the same deletion intent the entry routes use).
          const values: Record<string, any> = { [HABIT_MIRROR_KEY]: others[0] };
          const patch: any = { values };
          if (others.length > 1) values[HABIT_MIRROR_IDS_KEY] = others;
          else patch.valuesToDelete = [HABIT_MIRROR_IDS_KEY];
          await (storage as any).updateTrackerEntry(tracker.id, mirror.id, patch);
        }
      }
    } catch (e: any) {
      logger.warn(`[habit-completion] mirror removal failed for "${habit.name}":`, e?.message || e);
    }
  }

  const fresh = (await storage.getHabit(habit.id)) || habit;
  return {
    ok: true,
    habitId: habit.id,
    habitName: habit.name,
    date,
    removedCheckinId: target.id,
    removedTrackerEntryIds,
    progress: habitDayProgress(fresh as any, date),
    habit: fresh,
    currentStreak: fresh.currentStreak || 0,
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
  storage: HabitCompletionStorage & { updateTrackerEntry?: (trackerId: string, entryId: string, patch: { values?: Record<string, any> }) => Promise<any> },
  trackerId: string,
  opts: { timestamp?: string; values?: Record<string, any>; timezone?: string; entryId?: string } = {},
): Promise<HabitSyncResult[]> {
  const results: HabitSyncResult[] = [];
  try {
    // An entry written BY a habit check-in must not check that habit in again.
    if (mirrorHabitIds(opts.values).length > 0) return results;

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
          timezone: tz, // computed above; without it the callee fell back to the default zone
          // The tracker entry IS the record — mirroring it back would duplicate it.
          skipTrackerWrite: true,
          notes: value != null ? `Logged ${value} on ${habit.name}'s tracker` : undefined,
        });
        if (res.ok && res.recorded > 0) {
          results.push({ habitId: habit.id, habitName: habit.name, date, progress: res.progress });
        }
      } catch { /* one habit failing must not stop the others */ }
    }
    // Pair the entry with every check-in it produced, the way a habit
    // check-in's mirror entry is paired: deleting this entry then un-completes
    // those habits (removeTrackerEntry). Without the pairing a habit stayed
    // "done" off a record the user had removed (D226); with a single id, a
    // tracker two habits share left the second one done (D227).
    if (results.length > 0 && opts.entryId && typeof storage.updateTrackerEntry === "function") {
      try {
        const ids = results.map((r) => r.habitId);
        const values: Record<string, any> = { ...(opts.values || {}), [HABIT_MIRROR_KEY]: ids[0] };
        if (ids.length > 1) values[HABIT_MIRROR_IDS_KEY] = ids;
        await storage.updateTrackerEntry(trackerId, opts.entryId, { values });
      } catch { /* pairing is best-effort; the completions already landed */ }
    }
  } catch { /* propagation is best-effort */ }
  return results;
}
