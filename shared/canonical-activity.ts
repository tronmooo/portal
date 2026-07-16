// Canonical activity resolution — pure, no I/O.
//
// Different phrasings of the same real-world activity must land on ONE
// tracker: "Walking Distance", "Walking Miles", "Steps Walked", "Daily
// Walk", and "Walking Activity" are all the canonical "Walking" tracker
// with different metric fields — never five separate trackers.
// (User report 2026-07-15: "I walked 1 mile" created a Walking tracker
// that displayed "1 steps" — value shoved into the wrong field.)
//
// Pinned by tests/canonical-activity.test.ts.

export interface CanonicalActivity {
  /** Machine type, e.g. "walking". */
  type: "walking" | "running" | "hydration" | "sleep" | "cycling" | "swimming";
  /** The one tracker name this activity logs to. */
  trackerName: string;
}

const CANONICAL: Array<{ type: CanonicalActivity["type"]; trackerName: string; pattern: RegExp }> = [
  // Order matters: running before walking so "running steps" hits Running.
  { type: "running", trackerName: "Running", pattern: /\b(run|runs|running|ran|jog|jogging|jogged)\b/i },
  { type: "walking", trackerName: "Walking", pattern: /\b(walk|walks|walking|walked|stroll|strolling|steps?)\b/i },
  { type: "cycling", trackerName: "Cycling", pattern: /\b(cycle|cycling|cycled|bike|biking|biked|ride|riding|rode)\b/i },
  { type: "swimming", trackerName: "Swimming", pattern: /\b(swim|swims|swimming|swam|laps?)\b/i },
  { type: "hydration", trackerName: "Hydration", pattern: /\b(hydration|hydrate|water intake|water)\b/i },
  { type: "sleep", trackerName: "Sleep", pattern: /\b(sleep|slept|sleeping|nap|napped)\b/i },
];

/** Words that signal the name is a DIFFERENT domain despite a keyword hit
 * (e.g. "Plant Watering" contains "water" but is not hydration). */
const DOMAIN_BLOCKERS: Partial<Record<CanonicalActivity["type"], RegExp>> = {
  hydration: /\b(plant|garden|lawn|flower|aquarium|pet)\b/i,
  walking: /\b(dog|pet|puppy)\b/i, // "Dog Walking" is pet care, not the user's steps
  running: /\b(errand|errands|business)\b/i,
};

/**
 * Resolve a tracker name / activity phrase to its canonical tracker.
 * Returns null when nothing matches — the caller keeps the custom name.
 */
export function resolveCanonicalActivity(rawName: string): CanonicalActivity | null {
  const name = String(rawName || "").trim();
  if (!name) return null;
  for (const c of CANONICAL) {
    if (!c.pattern.test(name)) continue;
    const blocker = DOMAIN_BLOCKERS[c.type];
    if (blocker && blocker.test(name)) continue;
    return { type: c.type, trackerName: c.trackerName };
  }
  return null;
}
