/**
 * "Sarah and I both played soccer" is TWO entries, and they are not copies of
 * each other.
 *
 * Reported 2026-09-02, twice. The first fix told the model to write one entry
 * per participant; guidance is not a guarantee, and the user was explicit that
 * there must be two records — "one for Sarah and one for [me] and they're
 * completely different from each other because they're two different entries
 * dealing with two different people".
 *
 * So the fan-out is deterministic now. This module plans it: given the joint
 * subjects in the message and the tracker entries the turn actually wrote, it
 * returns the writes that are MISSING — one per participant who has no entry
 * for that activity yet. A participant the model already logged is never
 * planned again, so the fan-out can only ever fill gaps, never double-log.
 *
 * The planned values are deliberately NOT a verbatim copy. Everything that
 * depends on whose body did the activity — calories burned, steps, heart rate,
 * pace — is stripped, because the server's enrichment recomputes those from
 * the target profile's own weight, height and history (see the enrichment
 * branch in server/ai-engine.ts, which uses targetProfileId's fields and only
 * ever fills fields that are absent). What the participants genuinely shared —
 * the activity, its duration, its intensity, a distance they covered
 * together — carries over. That is what makes the two entries different
 * records about two different people rather than one record written twice.
 *
 * Pure and dependency-light so the contract tests can pin it.
 */
import { extractSharedActivities } from "./content-routing";
import { resolveCanonicalActivity } from "./canonical-activity";
import { trackerNamesMatch } from "./tracker-identity";

/** A tracker entry this turn already wrote. */
export interface FanoutWrite {
  /** The tracker name the tool was ASKED for ("Soccer"). */
  trackerName: string;
  /** Profile the entry landed on; null/undefined means the user's own. */
  profileId?: string | null;
  values: Record<string, any>;
}

export interface FanoutParticipant {
  id: string;
  name: string;
  /** Body weight in kg, when the profile records one. Used to scale the
   *  energy cost of the shared activity onto this person. */
  weightKg?: number | null;
}

export interface PlannedFanout {
  trackerName: string;
  /** Participant NAME — the tool resolves the profile from it. */
  forProfile: string;
  participantId: string;
  values: Record<string, any>;
  /** The clause that named this shared activity, for the log line. */
  clause: string;
}

/**
 * Fields whose value belongs to ONE person's body and must be recomputed for
 * the other participant rather than copied. `calories` is deliberately absent:
 * on a Nutrition entry it is the food's calories, which two people eating the
 * same dish genuinely share, and stripping it would leave a blank row.
 */
const PERSON_DERIVED = new Set([
  "caloriesburned", "calories_burned", "caloriesburnt",
  "steps", "stepcount", "step_count",
  "speedmph", "pace", "paceminutespermile",
  "heartrate", "avgheartrate", "heart_rate", "maxheartrate",
  "_enrichment",
  // The model's note is written from the logging user's point of view
  // ("played with Sarah this afternoon") and is simply wrong on Sarah's row.
  "_notes",
]);

function numeric(v: any): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * The same activity costs a heavier person more energy. The server's own
 * estimator already models this as MET x weight x hours, so scaling the
 * template's burn by the weight ratio is that formula with everything but
 * weight held constant — the honest way to carry one participant's number
 * onto another. Without both weights there is nothing to scale by, and an
 * invented number would be worse than an absent one: the field is left off
 * and the entry still records what was actually shared.
 */
function scaledCaloriesBurned(
  template: Record<string, any>,
  source: FanoutParticipant | undefined,
  target: FanoutParticipant,
): number | null {
  const burned = numeric(template.caloriesBurned ?? template.calories_burned ?? template.caloriesBurnt);
  if (burned == null || burned <= 0) return null;
  const from = source?.weightKg;
  const to = target.weightKg;
  if (!from || !to || from <= 0 || to <= 0) return null;
  return Math.round(burned * (to / from));
}

function shareableValues(values: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (PERSON_DERIVED.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function mentionsTracker(clause: string, trackerName: string): boolean {
  const name = String(trackerName || "").trim();
  if (name.length < 3) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}`, "i").test(clause);
}

/**
 * The entries a shared activity still needs.
 *
 * `resolveName` is supplied by the caller so this module never has to know how
 * profiles are matched (nicknames, partial names); it returns null for a name
 * that is not a real profile, and such a "participant" is dropped — a
 * capitalized phrase that is not a person can never generate a write.
 */
export function planSharedActivityFanout(opts: {
  userMessage: string;
  writes: FanoutWrite[];
  resolveName: (name: string) => FanoutParticipant | null;
  /** The user's own profile, for the "and I" half of the subject. */
  selfProfile?: FanoutParticipant | null;
}): PlannedFanout[] {
  const { userMessage, writes, resolveName, selfProfile } = opts;
  if (!writes.length) return [];

  const planned: PlannedFanout[] = [];
  const claimed = new Set<string>();

  for (const shared of extractSharedActivities(userMessage)) {
    const participants: FanoutParticipant[] = [];
    if (shared.includesSelf && selfProfile) participants.push(selfProfile);
    for (const name of shared.names) {
      const p = resolveName(name);
      if (p && !participants.some((x) => x.id === p.id)) participants.push(p);
    }
    if (participants.length < 2) continue;

    // Which of this turn's writes is this clause about? The canonical activity
    // ("played soccer" -> Soccer) names the tracker; a tracker the clause
    // mentions by name covers the rest.
    const canonical = resolveCanonicalActivity(shared.clause)?.trackerName;
    const sources = writes.filter((w) =>
      (canonical && trackerNamesMatch(w.trackerName, canonical)) || mentionsTracker(shared.clause, w.trackerName),
    );
    // The model logged nothing for this activity — nothing to fan out FROM.
    // Inventing an entry from a sentence alone is a different, riskier job.
    if (sources.length === 0) continue;

    const template = sources[0];
    const covered = new Set(
      sources.map((w) => w.profileId || (selfProfile ? selfProfile.id : "")).filter(Boolean),
    );
    const sourceId = template.profileId || (selfProfile ? selfProfile.id : "");
    const sourceParticipant = participants.find((x) => x.id === sourceId);
    for (const p of participants) {
      if (covered.has(p.id)) continue;
      const key = `${template.trackerName.toLowerCase()}::${p.id}`;
      if (claimed.has(key)) continue;
      claimed.add(key);
      const values = shareableValues(template.values);
      const burned = scaledCaloriesBurned(template.values, sourceParticipant, p);
      if (burned != null) values.caloriesBurned = burned;
      planned.push({
        trackerName: template.trackerName,
        forProfile: p.name,
        participantId: p.id,
        values,
        clause: shared.clause,
      });
    }
  }
  return planned;
}
