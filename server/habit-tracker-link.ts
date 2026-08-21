// server/habit-tracker-link.ts — THE one way a habit gets its tracker.
//
// A measurable habit needs a tracker to hold the measurement. Until now the
// only place that link was ever established was create_habit in the AI engine:
// if a habit reached the world any other way — created before the linking
// existed, created from the Habits page, created by an import — it had no
// tracker, and nothing ever gave it one.
//
// That is the QA report's req 9. The user presses "Walk the Dog" in the Habits
// tab and expects a tracker entry to appear. Nothing happened, because
// completeHabitOccurrence mirrors into `linkedTrackerId` and that column was
// null. The report is explicit about the shape of the fix:
//
//   "If a tracker already exists, APPEND to it. Do NOT create a new tracker
//    every day. If no tracker exists, create the canonical tracker once, link
//    it to the habit, and then append the first entry. Future completions
//    reuse that tracker."
//
// So resolution is: reuse an identity-matched tracker → reuse the domain's
// umbrella tracker → create ONE canonical tracker and link it. The link is
// persisted on the habit, which is what makes it a once-ever cost rather than
// a daily one.
//
// Extracted here so create_habit and completeHabitOccurrence share it instead
// of holding two answers to the same question.

import { findIdentityMatches } from "@shared/tracker-identity";
import { detectHabitMetric, UMBRELLA_TRACKER_NAMES } from "@shared/habit-metric";
import { resolveTrackerCategory } from "@shared/entity-classify";

export interface HabitTrackerLinkStorage {
  getTrackers(): Promise<any[]>;
  getProfiles(): Promise<any[]>;
  createTracker(data: any): Promise<any>;
  updateHabit(id: string, data: any): Promise<any>;
}

export interface HabitTrackerLinkResult {
  tracker: { id: string; name: string } | null;
  /** True when this call created the tracker (first completion, or first
   *  measurable mention). False when an existing one was adopted. */
  created: boolean;
  /** True when this call wrote linkedTrackerId onto the habit. */
  linked: boolean;
}

const NONE: HabitTrackerLinkResult = { tracker: null, created: false, linked: false };

/**
 * Make sure `habit` has a tracker to measure into, creating and linking one
 * only if the habit genuinely measures something.
 *
 * Returns NONE for a completion-only habit ("make my bed"): manufacturing a
 * tracker full of `completions: 1` rows for those is the failure mode
 * shared/habit-metric.ts was written to avoid, and the report asks for a
 * tracker entry on manual completion, not for a tracker on every habit.
 *
 * Never throws — a habit without a tracker still completes.
 */
export async function ensureHabitTracker(
  storage: HabitTrackerLinkStorage,
  habit: { id: string; name: string; linkedTrackerId?: string | null; linkedProfiles?: string[] | null },
  opts: { userMessage?: string; candidateHint?: string } = {},
): Promise<HabitTrackerLinkResult> {
  try {
    // Already linked: the whole point — future completions reuse it.
    if (habit.linkedTrackerId) {
      const existing = (await storage.getTrackers()).find((t: any) => t.id === habit.linkedTrackerId);
      if (existing) return { tracker: { id: existing.id, name: existing.name }, created: false, linked: false };
      // Dangling link (tracker deleted): fall through and re-resolve.
    }

    const metric = detectHabitMetric(habit.name || "", opts.userMessage || "");
    const candidates = Array.from(
      new Set([...(opts.candidateHint ? [opts.candidateHint] : []), ...(metric?.candidates || [])]),
    );
    if (candidates.length === 0) return NONE;

    const allTrackers = await storage.getTrackers();
    const allProfiles = await storage.getProfiles();
    const selfId = allProfiles.find((p: any) => p.type === "self")?.id;
    const ownerId = habit.linkedProfiles?.[0] || selfId;

    // Per-person trackers: only reuse a tracker the habit's owner can log to —
    // theirs or an unowned orphan. Never adopt another profile's tracker.
    const compatible = (t: any) => {
      const owners: string[] = t.linkedProfiles || [];
      return owners.length === 0 || (!!ownerId && owners.includes(ownerId));
    };

    let tracker: any = null;
    for (const cand of candidates) {
      const matches = findIdentityMatches(allTrackers, cand).filter(compatible);
      if (matches.length > 0) { tracker = matches[0]; break; }
    }

    // Umbrella reuse: an existing general tracker for the same domain
    // (Exercise absorbing a Running habit) is expanded, not shadowed.
    if (!tracker && metric) {
      for (const u of UMBRELLA_TRACKER_NAMES[metric.category] || []) {
        const matches = findIdentityMatches(allTrackers, u).filter(compatible);
        if (matches.length > 0) { tracker = matches[0]; break; }
      }
    }

    let created = false;
    if (!tracker) {
      const trackerName = candidates[0];
      const resolved = resolveTrackerCategory(trackerName, { supplied: metric?.category });
      const fields = (metric?.fields || [{ name: "amount", type: "number" as const, isPrimary: true }])
        .map((f) => ({
          name: f.name,
          type: f.type,
          ...(f.unit ? { unit: f.unit } : {}),
          ...(f.isPrimary ? { isPrimary: true } : {}),
        }));
      tracker = await storage.createTracker({
        name: trackerName,
        category: resolved.category,
        fields,
        ...(ownerId ? { linkedProfiles: [ownerId] } : {}),
      } as any);
      created = true;
    }

    if (!tracker?.id) return NONE;
    await storage.updateHabit(habit.id, { linkedTrackerId: tracker.id } as any);
    return { tracker: { id: tracker.id, name: tracker.name }, created, linked: true };
  } catch {
    // A habit with no tracker still works; it just measures nothing.
    return NONE;
  }
}
