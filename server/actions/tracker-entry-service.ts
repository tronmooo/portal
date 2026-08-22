// ─── Canonical tracker-entry logging ────────────────────────────────────────
//
// THE single value pipeline for logging a tracker entry once a concrete
// tracker is known, whatever door the log came through. Modeled on
// server/habit-completion.ts.
//
// Division of labor, deliberately:
//   · The CHAT door keeps its interpretation layer (canonical-activity
//     resolution, workout-vs-body-weight guard, per-person tracker matching,
//     enrichment/estimation, medication dose defaulting, schema auto-extend)
//     — that is understanding WHAT the user meant, and only chat has a
//     sentence to interpret.
//   · THIS service owns what happens to the VALUES of a known tracker:
//     guards (shared/tracker-entry-guards.ts — coercion, empties, signs,
//     sanity bounds), normalization to the tracker's schema
//     (server/tracker-normalize.ts), the duplicate window, the shared insert
//     schema, the write, and the implied writes that must fire for EVERY
//     door: habit auto-checkin (already structural, inside storage.logEntry)
//     and linked-goal progress (previously chat-only, so an entry logged from
//     the Trackers page never advanced its goal).
//
// Doors: chat tool log_tracker_entry · REST POST /api/trackers/:id/entries ·
// extraction confirm (Phase 4) · smart-entry. Each wraps the outcome contract
// at its own choke point (chat loop inline; REST via runMutation).
import type { IStorage } from "../storage";
import { insertTrackerEntrySchema } from "@shared/schema";
import { guardTrackerEntryValues, type GuardFailure } from "@shared/tracker-entry-guards";
import { normalizeTrackerEntry } from "../tracker-normalize";

export interface PreparedEntryValues {
  values: Record<string, any>;
  warnings: string[];
  error?: string;
  field?: string;
  received?: string;
}

/**
 * Shared value stage: guards then normalization. Returns the values as they
 * should be stored, or a failure the door renders its own way (REST → 400,
 * chat → tool error the model relays).
 */
export async function prepareTrackerEntryValues(
  storage: IStorage,
  tracker: { id: string; name: string; fields?: any[]; linkedProfiles?: string[] },
  rawValues: Record<string, any>,
): Promise<PreparedEntryValues> {
  const values = { ...rawValues };
  let isPetTracker = false;
  if (typeof values.weight === "number" && values.weight > 500) {
    // Only resolve profiles when the pet bound could actually matter. (Not a
    // profile-filter decision — a type lookup on the tracker's owners.)
    try {
      const profiles = await storage.getProfiles();
      const byId = new Map(profiles.map((p) => [p.id, p]));
      for (const pid of tracker.linkedProfiles || []) {
        if (byId.get(pid)?.type === "pet") { isPetTracker = true; break; }
      }
    } catch { /* the human bound still applies */ }
  }
  const failure: GuardFailure | null = guardTrackerEntryValues(tracker.fields, values, { isPetTracker });
  if (failure) return { values, warnings: [], ...failure };
  const { values: normalized, warnings } = normalizeTrackerEntry(tracker as any, values);
  return { values: normalized, warnings };
}

export interface LogPreparedEntryArgs {
  values: Record<string, any>;
  profileId?: string;
  timestamp?: string;
  notes?: string;
  mood?: string;
  tags?: string[];
}

export interface LogPreparedEntryOptions {
  /** Identical-numeric-values duplicate window. Default 2 minutes (the chat
   *  door's long-standing rule); the REST door passes a short double-submit
   *  window so a deliberate manual re-entry is never swallowed. 0 disables. */
  dedupWindowMs?: number;
}

export type LogEntryResult = Record<string, any> & { error?: string; deduped?: boolean };

/**
 * Write stage: duplicate window → shared insert schema → storage.logEntry
 * (which structurally fires the habit auto-checkin) → linked-goal progress.
 */
export async function logPreparedEntry(
  storage: IStorage,
  tracker: { id: string; name: string; entries?: any[] },
  args: LogPreparedEntryArgs,
  opts: LogPreparedEntryOptions = {},
): Promise<LogEntryResult> {
  const windowMs = opts.dedupWindowMs ?? 120_000;
  // Some storage backends return trackers without a materialized entries
  // array (or with a count in its place) — dedup is then simply skipped.
  const priorEntries = Array.isArray(tracker.entries) ? tracker.entries : [];
  if (windowMs > 0) {
    const cutoff = Date.now() - windowMs;
    const dup = priorEntries.find((e: any) => {
      if (new Date(e.timestamp).getTime() < cutoff) return false;
      const existingNums = Object.entries(e.values || {}).filter(([k, v]) => typeof v === "number" && !k.startsWith("_"));
      const newNums = Object.entries(args.values).filter(([k, v]) => typeof v === "number" && !k.startsWith("_"));
      if (existingNums.length === 0 || newNums.length === 0) return false;
      return newNums.every(([k, v]) => e.values[k] === v);
    });
    if (dup) {
      return { ...dup, deduped: true, message: `An identical ${tracker.name} entry was just logged — I didn't record it twice.` };
    }
  }

  const parsed = insertTrackerEntrySchema.safeParse({
    trackerId: tracker.id,
    values: args.values,
    profileId: args.profileId,
    forProfile: args.profileId,
    timestamp: args.timestamp || undefined,
    notes: args.notes,
    mood: args.mood,
    tags: args.tags,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message || "Tracker entry validation failed" };
  }

  const entry = await storage.logEntry(parsed.data);
  if (!entry) return { error: "Tracker not found" };

  // Implied write, EVERY door: an entry advances any active goal measured by
  // this tracker. Previously chat-only, so a manual log from the Trackers
  // page moved the history but never the goal it feeds.
  await autoUpdateGoalProgress(storage, tracker.id, args.values);
  return entry;
}

/** Advance active goals linked to a tracker by this entry's primary value. */
export async function autoUpdateGoalProgress(
  storage: IStorage,
  trackerId: string,
  values: Record<string, any>,
): Promise<void> {
  try {
    const goals = await storage.getGoals();
    const linkedGoals = goals.filter((g) => g.trackerId === trackerId && g.status === "active");
    for (const goal of linkedGoals) {
      let increment = 0;
      if (typeof values.distance === "number") increment = values.distance;
      else if (typeof values.value === "number") increment = values.value;
      else {
        const numVals = Object.entries(values)
          .filter(([k, v]) => typeof v === "number" && !k.startsWith("_"))
          .map(([, v]) => v as number);
        if (numVals.length > 0) increment = numVals[0];
      }
      if (increment > 0) {
        const newCurrent = (goal.current || 0) + increment;
        const update: Record<string, any> = { current: Math.min(newCurrent, goal.target) };
        if (newCurrent >= goal.target) update.status = "completed";
        await storage.updateGoal(goal.id, update);
      }
    }
  } catch (e) {
    console.error("[goal] autoUpdateGoalProgress failed:", e);
  }
}
