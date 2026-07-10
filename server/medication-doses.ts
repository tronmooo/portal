// ── Medication dose ledger — built ON medication trackers, no new tables ─────
// Medication trackers already carry the dose history: entries with values
// {drugName, dosage, timeTaken, adherence: taken|skipped|missed, sideEffects}.
// These helpers resolve the right medication tracker (mirroring the system
// prompt's "never guess which drug" rule) and compute expected-vs-logged dose
// math from the tracker's frequency via parseFrequencyToDosesPerDay.
import type { IStorage } from "./storage";
import type { Tracker } from "@shared/schema";
import { parseFrequencyToDosesPerDay } from "../shared/medication-refills";

const norm = (s: any) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const DAY = 86400000;

function isMedicationTracker(t: Tracker): boolean {
  return norm(t.category) === "medication"
    || (t.fields || []).some((f) => norm(f.name) === "adherence")
    || (t.entries || []).some((e) => e?.values && "adherence" in e.values);
}

/** The tracker's frequency lives in its name/unit or its entries' drugName —
 *  best signal wins. */
function trackerFrequencyText(t: Tracker): string {
  const lastEntry = (t.entries || []).slice(-1)[0];
  return [t.unit, t.name, lastEntry?.values?.frequency, lastEntry?.values?.dosage]
    .map((x) => String(x || "")).join(" ");
}

export function resolveMedicationTracker(
  trackers: Tracker[],
  medication?: string,
): { tracker?: Tracker; error?: string } {
  const meds = trackers.filter(isMedicationTracker);
  if (meds.length === 0) {
    return { error: "No medication trackers found. Say e.g. 'create a medication tracker for Lisinopril' first." };
  }
  if (!medication) {
    if (meds.length === 1) return { tracker: meds[0] };
    return { error: `Which medication? You track: ${meds.map((t) => t.name).join(", ")}.` };
  }
  const needle = norm(medication);
  const hit = meds.find((t) => norm(t.name) === needle)
    || meds.find((t) => norm(t.name).includes(needle) || needle.includes(norm(t.name)))
    || meds.find((t) => (t.entries || []).some((e) => norm(e?.values?.drugName).includes(needle)));
  if (!hit) return { error: `No medication tracker matches "${medication}". You track: ${meds.map((t) => t.name).join(", ")}.` };
  return { tracker: hit };
}

interface DoseWindowOpts {
  /** Days back from today, default 7. */
  days?: number;
}

/** Expected vs logged doses for a medication over the window. */
export function computeMissedDoses(tracker: Tracker, opts: DoseWindowOpts = {}) {
  const days = Math.max(1, Math.min(90, Number(opts.days) || 7));
  const now = Date.now();
  const windowStart = now - days * DAY;
  // Never expect doses from before the tracker existed.
  const createdMs = new Date(tracker.createdAt || 0).getTime() || now;
  const effectiveStart = Math.max(windowStart, createdMs);
  const effectiveDays = Math.max(0, (now - effectiveStart) / DAY);

  const dosesPerDay = parseFrequencyToDosesPerDay(trackerFrequencyText(tracker));
  const expected = Math.floor(effectiveDays * dosesPerDay);

  const inWindow = (tracker.entries || []).filter((e) => {
    const ts = new Date(e.timestamp || 0).getTime();
    return ts >= effectiveStart && ts <= now;
  });
  const byAdherence = (kind: string) => inWindow.filter((e) => norm(e?.values?.adherence) === kind);
  const taken = byAdherence("taken").length;
  const skipped = byAdherence("skipped").length;
  const explicitMissed = byAdherence("missed").length;
  // Gap = expected doses with no entry at all (unlogged ≠ confirmed missed —
  // report it as a gap, honestly distinct from explicit 'missed' logs).
  const unlogged = Math.max(0, expected - taken - skipped - explicitMissed);

  const perDay: Array<{ date: string; taken: number; skipped: number; missed: number }> = [];
  for (let i = 0; i < Math.min(days, Math.ceil(effectiveDays) + 1); i++) {
    const dayStart = now - (i + 1) * DAY;
    const dayEnd = now - i * DAY;
    const dayEntries = inWindow.filter((e) => {
      const ts = new Date(e.timestamp || 0).getTime();
      return ts > dayStart && ts <= dayEnd;
    });
    perDay.push({
      date: new Date(dayEnd).toISOString().slice(0, 10),
      taken: dayEntries.filter((e) => norm(e?.values?.adherence) === "taken").length,
      skipped: dayEntries.filter((e) => norm(e?.values?.adherence) === "skipped").length,
      missed: dayEntries.filter((e) => norm(e?.values?.adherence) === "missed").length,
    });
  }

  return {
    medication: tracker.name,
    window_days: days,
    doses_per_day: dosesPerDay,
    expected,
    taken,
    skipped,
    explicit_missed: explicitMissed,
    unlogged_gap: unlogged,
    per_day: perDay,
    message: expected === 0
      ? `No doses were expected for ${tracker.name} in the last ${days} day${days === 1 ? "" : "s"}.`
      : `${tracker.name}, last ${days} day${days === 1 ? "" : "s"}: ${taken}/${expected} expected doses taken, ${skipped} skipped, ${explicitMissed} logged as missed${unlogged > 0 ? `, ${unlogged} expected dose${unlogged === 1 ? "" : "s"} with no log (gap, not confirmed missed)` : ""}.`,
  };
}

/** Read-only dose history list. */
export function doseHistory(tracker: Tracker, opts: DoseWindowOpts = {}) {
  const days = Math.max(1, Math.min(90, Number(opts.days) || 14));
  const cutoff = Date.now() - days * DAY;
  const rows = (tracker.entries || [])
    .filter((e) => new Date(e.timestamp || 0).getTime() >= cutoff)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, 50)
    .map((e) => ({
      when: e.timestamp,
      adherence: e.values?.adherence || "taken",
      dosage: e.values?.dosage || undefined,
      time_taken: e.values?.timeTaken || undefined,
      side_effects: e.values?.sideEffects || undefined,
      notes: e.notes || e.values?.notes || undefined,
    }));
  return {
    medication: tracker.name,
    window_days: days,
    doses: rows,
    count: rows.length,
    message: rows.length === 0
      ? `No dose logs for ${tracker.name} in the last ${days} days.`
      : `${rows.length} dose log${rows.length === 1 ? "" : "s"} for ${tracker.name} in the last ${days} days.`,
  };
}
