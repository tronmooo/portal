// client/src/lib/lift-summary.ts
// ─────────────────────────────────────────────────────────────────────────────
// How a lift entry is summarized on a tracker card.
//
// Extracted from pages/trackers.tsx (2026-08-02) so the rule that broke can be
// pinned by a test: THE NUMBER AND THE UNIT MUST COME FROM THE SAME FIELD.
//
// The bug: the card asked for the weight with a fallback ladder that ended in
// "any number in the entry", then printed the hardcoded unit "lbs" beside
// whatever came back. On a tracker whose weight had been stored as the string
// "70/80/80" (per-set), the ladder fell through to the set count and the card
// read "3 lbs" for a 3-set workout.
//
// The rule here: read the entry through readStrengthEntry (the one reader that
// understands per-set values), and resolve the unit for the FIELD the number
// came from via resolveTrackerUnit. A count is labeled with its own unit —
// "3 sets", "10 reps" — or nothing at all. It is never labeled with a load unit.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveTrackerUnit, type UnitTrackerLike } from "@shared/tracker-units";
import { readStrengthEntry, formatSetList } from "@shared/strength-entry";

export interface LiftSummary {
  /** false when the entry has no load, reps, or sets to show. */
  hasData: boolean;
  /** Headline number, already formatted. */
  value: string;
  /** Unit for THAT number — "lbs" only when the number is a load. */
  unit: string;
  /** "70/80/80 lbs · 10/8/6 reps · 3 sets" */
  subline: string;
  /** One-line human sentence for the card. */
  insight: string;
}

const fmt = (n: number) => (Math.abs(n - Math.round(n)) < 0.05 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString();

export function summarizeLiftEntry(
  tracker: UnitTrackerLike,
  values: Record<string, any> | null | undefined,
): LiftSummary {
  const s = readStrengthEntry(values);
  if (s.weight == null && s.reps == null && s.sets == null) {
    return { hasData: false, value: "—", unit: "", subline: "", insight: "Log a set to start tracking." };
  }

  // Units come from the ONE canonical resolver, for the field each number was
  // actually read from ("weight", "weightLbs", …).
  const weightUnit = s.weightKey ? (resolveTrackerUnit(tracker, s.weightKey) || "lbs") : "";
  const repsUnit = resolveTrackerUnit(tracker, s.repsKey || "reps") || "reps";
  const setsUnit = resolveTrackerUnit(tracker, "sets") || "sets";

  const weightText = s.weightPerSet ? formatSetList(s.weightPerSet) : (s.weight != null ? fmt(s.weight) : "");
  const repsText = s.repsPerSet ? formatSetList(s.repsPerSet) : (s.reps != null ? fmt(s.reps) : "");

  const subParts: string[] = [];
  if (s.weightPerSet) subParts.push(`${weightText} ${weightUnit}`.trim());
  if (repsText) subParts.push(`${repsText} ${repsUnit}`.trim());
  if (s.sets != null) subParts.push(`${fmt(s.sets)} ${setsUnit}`.trim());

  const headline = s.weight != null ? { value: fmt(s.weight), unit: weightUnit }
    : s.sets != null ? { value: fmt(s.sets), unit: setsUnit }
    : { value: fmt(s.reps as number), unit: repsUnit };

  const insight = s.weight != null
    ? `Lifted ${weightText} ${weightUnit}${repsText ? ` × ${repsText} ${repsUnit}` : ""}${s.sets != null ? ` × ${fmt(s.sets)} ${setsUnit}` : ""}.`
    : s.sets != null
      ? `${fmt(s.sets)} ${setsUnit}${repsText ? ` × ${repsText} ${repsUnit}` : ""} logged.`
      : `${repsText} ${repsUnit} logged.`;

  return { hasData: true, value: headline.value, unit: headline.unit, subline: subParts.join(" · "), insight };
}
