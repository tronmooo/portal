// A small, fixed health history for the Wellness tests: one person, sixty days
// ending 2026-11-23. Every number is written out so an assertion can be read
// against it.
import { collectMetrics } from "../../shared/wellness-readout";

export const TODAY = "2026-11-23";
export const NOW = new Date("2026-11-23T18:00:00Z");
export const TZ = "UTC";

const at = (day: string, hour = 8) => `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
let seq = 0;
export const entry = (day: string, values: Record<string, any>, extra: Record<string, any> = {}) =>
  ({ id: `e${++seq}`, timestamp: at(day, extra.hour ?? 8), values, computed: extra.computed ?? {}, ...(extra.notes ? { notes: extra.notes } : {}) });

export const tracker = (id: string, name: string, category: string, fields: Array<{ name: string; unit?: string }>, entries: any[]) =>
  ({ id, name, category, fields: fields.map((f) => ({ type: "number", ...f })), entries, linkedProfiles: [], createdAt: at("2026-01-01") });

/** day offsets back from TODAY → YYYY-MM-DD */
export const daysAgo = (n: number) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

export function fixtureTrackers() {
  return [
    // Weight: 213 on Oct 25 (29 days ago) → 204 on Nov 20; an older 215 on Sep 30.
    tracker("t-weight", "Weight", "health", [{ name: "weight", unit: "lbs" }], [
      entry("2026-09-30", { weight: 215 }), entry("2026-10-25", { weight: 213 }), entry("2026-11-08", { weight: 208 }), entry("2026-11-20", { weight: 204 }),
    ]),
    // Blood pressure: 138/86 on Oct 28, 139/80 on Oct 21?? — kept in date order below.
    tracker("t-bp", "Blood Pressure", "health", [{ name: "systolic", unit: "mmHg" }, { name: "diastolic", unit: "mmHg" }], [
      entry("2026-10-01", { systolic: 138, diastolic: 86 }), entry("2026-10-21", { systolic: 139, diastolic: 80 }),
    ]),
    // Sleep: last 10 nights alternate 8.5 / 7.0 (avg 7.75); the 10 nights 31–40 days ago are all 6.5.
    tracker("t-sleep", "Sleep", "health", [{ name: "hours", unit: "hours" }], [
      ...Array.from({ length: 10 }, (_, i) => entry(daysAgo(i), { hours: i % 2 === 0 ? 8.5 : 7 })),
      ...Array.from({ length: 10 }, (_, i) => entry(daysAgo(31 + i), { hours: 6.5 })),
    ]),
    // Running: a session on every 8.5-hour night (days 0,2,4,6,8), 2 mi in 20 min; one 40 days ago.
    tracker("t-run", "Running", "fitness", [{ name: "distance", unit: "mi" }, { name: "duration", unit: "min" }], [
      ...[0, 2, 4, 6, 8].map((n) => entry(daysAgo(n), { distance: 2, duration: 20 }, { hour: 17, computed: { caloriesBurned: 250 } })),
      entry(daysAgo(40), { distance: 3, duration: 30 }, { hour: 17 }),
    ]),
    // Nutrition: two foods yesterday (300 + 500 kcal), one today (700 kcal).
    tracker("t-food", "Nutrition", "nutrition", [{ name: "calories", unit: "kcal" }, { name: "protein", unit: "g" }], [
      entry(daysAgo(1), { item: "Banana", calories: 300, protein: 4 }), entry(daysAgo(1), { item: "Sandwich", calories: 500, protein: 30 }, { hour: 13 }),
      entry(daysAgo(0), { item: "Pasta", calories: 700, protein: 25 }),
    ]),
    // Headache: a symptom tracker, twice this week.
    tracker("t-head", "Headache", "health", [{ name: "severity" }], [
      entry(daysAgo(2), { severity: 3 }, { notes: "After a long drive" }), entry(daysAgo(5), { severity: 2 }),
    ]),
    // Guitar: minutes, but not a workout and not a health metric.
    tracker("t-guitar", "Guitar practice", "hobby", [{ name: "minutes", unit: "min" }], [entry(daysAgo(1), { minutes: 30 }), entry(daysAgo(3), { minutes: 45 })]),
  ];
}

export const fixtureMetrics = (trackers = fixtureTrackers()) => collectMetrics(trackers as any, { now: NOW, timezone: TZ });
