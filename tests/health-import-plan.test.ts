import { describe, it, expect } from "vitest";
import {
  uuidv5,
  healthEntryId,
  healthEntryTags,
  isWithinBounds,
  buildEntryValues,
  dayToTimestamp,
  planHealthEntries,
  chunk,
  summarize,
} from "../server/health-import";
import { getHealthMetric, HEALTH_IMPORT_TAG } from "../shared/health-metrics";
import { MemStorage } from "../server/storage";

const metric = (id: string) => {
  const m = getHealthMetric(id);
  if (!m) throw new Error(`no metric ${id}`);
  return m;
};

const USER = "11111111-2222-3333-4444-555555555555";
const TRACKER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("uuidv5", () => {
  it("is deterministic and RFC-4122 shaped", () => {
    const a = uuidv5("hello");
    const b = uuidv5("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("differs for different names", () => {
    expect(uuidv5("a")).not.toBe(uuidv5("b"));
  });

  it("matches the RFC 4122 test vector for the DNS namespace", () => {
    // uuidv5("python.org", DNS namespace) is a published constant.
    expect(uuidv5("python.org", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"))
      .toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });
});

describe("healthEntryId", () => {
  it("is stable for the same user/tracker/day/provider", () => {
    expect(healthEntryId(USER, TRACKER, "2026-08-01", "file"))
      .toBe(healthEntryId(USER, TRACKER, "2026-08-01", "file"));
  });

  it("changes when any component changes", () => {
    const base = healthEntryId(USER, TRACKER, "2026-08-01", "file");
    expect(healthEntryId("other", TRACKER, "2026-08-01", "file")).not.toBe(base);
    expect(healthEntryId(USER, "other", "2026-08-01", "file")).not.toBe(base);
    expect(healthEntryId(USER, TRACKER, "2026-08-02", "file")).not.toBe(base);
    expect(healthEntryId(USER, TRACKER, "2026-08-01", "apple_health")).not.toBe(base);
  });
});

describe("bounds", () => {
  it("accepts plausible readings", () => {
    expect(isWithinBounds(metric("steps"), { metric: "steps", day: "d", value: 8214 })).toBe(true);
    expect(isWithinBounds(metric("heart_rate"), { metric: "heart_rate", day: "d", value: 62 })).toBe(true);
    expect(isWithinBounds(metric("sleep"), { metric: "sleep", day: "d", value: 7.5 })).toBe(true);
  });

  it("rejects impossible readings", () => {
    expect(isWithinBounds(metric("heart_rate"), { metric: "heart_rate", day: "d", value: 700 })).toBe(false);
    expect(isWithinBounds(metric("sleep"), { metric: "sleep", day: "d", value: 30 })).toBe(false);
    expect(isWithinBounds(metric("weight"), { metric: "weight", day: "d", value: 0 })).toBe(false);
    expect(isWithinBounds(metric("blood_oxygen"), { metric: "blood_oxygen", day: "d", value: 3 })).toBe(false);
  });

  it("bounds the diastolic value independently", () => {
    const bp = metric("blood_pressure");
    expect(isWithinBounds(bp, { metric: "blood_pressure", day: "d", value: 118, value2: 76 })).toBe(true);
    expect(isWithinBounds(bp, { metric: "blood_pressure", day: "d", value: 118, value2: 900 })).toBe(false);
  });
});

describe("buildEntryValues", () => {
  it("writes the registry field name", () => {
    expect(buildEntryValues(metric("steps"), { metric: "steps", day: "d", value: 8214 }))
      .toEqual({ steps: 8214 });
    expect(buildEntryValues(metric("sleep"), { metric: "sleep", day: "d", value: 7.5 }))
      .toEqual({ duration: 7.5 });
  });

  it("writes both blood-pressure fields", () => {
    expect(buildEntryValues(metric("blood_pressure"), { metric: "blood_pressure", day: "d", value: 118, value2: 76 }))
      .toEqual({ systolic: 118, diastolic: 76 });
  });
});

describe("dayToTimestamp", () => {
  // The property that matters: whatever instant we store, the user's own
  // timezone must render it on the day the health export said it was. A fixed
  // noon-UTC anchor cannot do this — real offsets span UTC-12..UTC+14, a
  // 26-hour range — so the anchor is noon in the user's zone.
  const zones = [
    "Pacific/Kiritimati",   // UTC+14, the extreme east
    "Pacific/Auckland",     // UTC+12/+13 with DST
    "Asia/Kolkata",         // UTC+5:30, half-hour offset
    "Europe/London",
    "America/Los_Angeles",
    "Pacific/Midway",       // UTC-11, the extreme west
  ];

  it("lands on the intended calendar day in every timezone", () => {
    for (const tz of zones) {
      for (const day of ["2026-08-01", "2026-01-15", "2026-03-08", "2026-11-01"]) {
        const ts = dayToTimestamp(day, tz);
        const rendered = new Intl.DateTimeFormat("en-CA", {
          timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date(ts));
        expect(rendered, `${day} in ${tz}`).toBe(day);
      }
    }
  });

  it("anchors around midday rather than a boundary", () => {
    const tz = "America/Los_Angeles";
    const hour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour: "2-digit", hour12: false,
    }).format(new Date(dayToTimestamp("2026-08-01", tz))));
    expect(hour).toBe(12);
  });

  it("is deterministic for the same day and zone", () => {
    expect(dayToTimestamp("2026-08-01", "UTC")).toBe(dayToTimestamp("2026-08-01", "UTC"));
  });
});

describe("planHealthEntries", () => {
  const trackerIdFor = () => TRACKER;

  it("plans one entry per row with deterministic ids and provenance tags", () => {
    const plan = planHealthEntries(
      [{ metric: "steps", day: "2026-08-01", value: 8214 }],
      { userId: USER, provider: "file", trackerIdFor },
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].entryId).toBe(healthEntryId(USER, TRACKER, "2026-08-01", "file"));
    expect(plan.entries[0].values).toEqual({ steps: 8214 });
    expect(plan.entries[0].tags).toEqual(healthEntryTags("file"));
    expect(plan.entries[0].tags).toContain(HEALTH_IMPORT_TAG);
  });

  it("is idempotent — planning the same rows twice yields the same ids", () => {
    const rows = [
      { metric: "steps", day: "2026-08-01", value: 8214 },
      { metric: "sleep", day: "2026-08-01", value: 7.5 },
    ];
    const a = planHealthEntries(rows, { userId: USER, provider: "file", trackerIdFor });
    const b = planHealthEntries(rows, { userId: USER, provider: "file", trackerIdFor });
    expect(a.entries.map(e => e.entryId)).toEqual(b.entries.map(e => e.entryId));
  });

  it("collapses a repeated (metric, day) to one entry, last value winning", () => {
    const plan = planHealthEntries(
      [
        { metric: "steps", day: "2026-08-01", value: 100 },
        { metric: "steps", day: "2026-08-01", value: 8214 },
      ],
      { userId: USER, provider: "file", trackerIdFor },
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].values).toEqual({ steps: 8214 });
  });

  it("skips out-of-range rows without dropping the rest of the batch", () => {
    const plan = planHealthEntries(
      [
        { metric: "heart_rate", day: "2026-08-01", value: 700 },
        { metric: "heart_rate", day: "2026-08-02", value: 62 },
      ],
      { userId: USER, provider: "file", trackerIdFor },
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0].day).toBe("2026-08-02");
    expect(plan.skipped).toEqual([{ metric: "heart_rate", day: "2026-08-01", reason: "value out of range" }]);
  });

  it("skips rows whose tracker could not be resolved", () => {
    const plan = planHealthEntries(
      [{ metric: "steps", day: "2026-08-01", value: 1 }],
      { userId: USER, provider: "file", trackerIdFor: () => undefined },
    );
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe("tracker unavailable");
  });

  it("reports the metrics seen and the day range", () => {
    const plan = planHealthEntries(
      [
        { metric: "steps", day: "2026-08-03", value: 1 },
        { metric: "sleep", day: "2026-08-01", value: 7 },
      ],
      { userId: USER, provider: "file", trackerIdFor },
    );
    expect(plan.metricIds).toEqual(["steps", "sleep"]);
    const s = summarize(plan);
    expect(s).toMatchObject({ written: 2, skipped: 0, firstDay: "2026-08-01", lastDay: "2026-08-03" });
  });
});

describe("chunk", () => {
  it("splits without losing or duplicating items", () => {
    const items = Array.from({ length: 2500 }, (_, i) => i);
    const parts = chunk(items, 1000);
    expect(parts.map(p => p.length)).toEqual([1000, 1000, 500]);
    expect(parts.flat()).toEqual(items);
  });

  it("returns nothing for an empty list and rejects a zero size", () => {
    expect(chunk([], 10)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow();
  });
});

// ── The two properties the whole design rests on ────────────────────────────
describe("bulkUpsertHealthEntries (MemStorage)", () => {
  async function seed() {
    const store = new MemStorage();
    const tracker = await store.createTracker({
      name: "Steps", category: "steps", unit: "steps",
      fields: [{ name: "steps", type: "number", unit: "steps", isPrimary: true }],
    } as any);
    return { store, trackerId: tracker.id };
  }

  function planFor(trackerId: string, rows: any[], provider = "file") {
    return planHealthEntries(rows, { userId: USER, provider, trackerIdFor: () => trackerId });
  }

  it("re-importing the same day updates in place instead of duplicating", async () => {
    const { store, trackerId } = await seed();

    await store.bulkUpsertHealthEntries(
      planFor(trackerId, [{ metric: "steps", day: "2026-08-01", value: 8000 }]).entries,
    );
    let t = await store.getTracker(trackerId);
    expect(t!.entries).toHaveLength(1);
    expect(t!.entries[0].values).toEqual({ steps: 8000 });

    // Same day, corrected value — the export was re-run after more syncing.
    await store.bulkUpsertHealthEntries(
      planFor(trackerId, [{ metric: "steps", day: "2026-08-01", value: 8214 }]).entries,
    );
    t = await store.getTracker(trackerId);
    expect(t!.entries).toHaveLength(1);
    expect(t!.entries[0].values).toEqual({ steps: 8214 });
  });

  it("never touches an entry the user logged by hand on the same day", async () => {
    const { store, trackerId } = await seed();

    const manual = await store.logEntry({
      trackerId,
      values: { steps: 1234 },
      timestamp: "2026-08-01T09:00:00.000Z",
    } as any);

    await store.bulkUpsertHealthEntries(
      planFor(trackerId, [{ metric: "steps", day: "2026-08-01", value: 8214 }]).entries,
    );

    const t = await store.getTracker(trackerId);
    expect(t!.entries).toHaveLength(2);
    const kept = t!.entries.find(e => e.id === manual!.id);
    expect(kept).toBeTruthy();
    expect(kept!.values).toEqual({ steps: 1234 });
    expect(kept!.tags).toBeUndefined();
  });

  it("keeps different providers as separate rows", async () => {
    const { store, trackerId } = await seed();
    await store.bulkUpsertHealthEntries(
      planFor(trackerId, [{ metric: "steps", day: "2026-08-01", value: 8000 }], "file").entries,
    );
    await store.bulkUpsertHealthEntries(
      planFor(trackerId, [{ metric: "steps", day: "2026-08-01", value: 8100 }], "apple_health").entries,
    );
    const t = await store.getTracker(trackerId);
    expect(t!.entries).toHaveLength(2);
  });

  it("purge removes only the named provider's rows, leaving manual logs", async () => {
    const { store, trackerId } = await seed();
    await store.logEntry({ trackerId, values: { steps: 1234 }, timestamp: "2026-08-01T09:00:00.000Z" } as any);
    await store.bulkUpsertHealthEntries(
      planFor(trackerId, [{ metric: "steps", day: "2026-08-01", value: 8000 }], "file").entries,
    );
    await store.bulkUpsertHealthEntries(
      planFor(trackerId, [{ metric: "steps", day: "2026-08-02", value: 9000 }], "apple_health").entries,
    );

    const deleted = await store.deleteHealthEntriesByProvider("src:file");
    expect(deleted).toBe(1);

    const t = await store.getTracker(trackerId);
    expect(t!.entries).toHaveLength(2);
    expect(t!.entries.some(e => e.values.steps === 1234)).toBe(true);   // manual survives
    expect(t!.entries.some(e => e.values.steps === 9000)).toBe(true);   // other provider survives
    expect(t!.entries.some(e => e.values.steps === 8000)).toBe(false);  // purged
  });

  it("computes secondary data so downstream badges still work", async () => {
    const store = new MemStorage();
    const bp = await store.createTracker({
      name: "Blood Pressure", category: "vitals",
      fields: [
        { name: "systolic", type: "number", unit: "mmHg", isPrimary: true },
        { name: "diastolic", type: "number", unit: "mmHg" },
      ],
    } as any);
    await store.bulkUpsertHealthEntries(
      planHealthEntries(
        [{ metric: "blood_pressure", day: "2026-08-01", value: 118, value2: 76 }],
        { userId: USER, provider: "file", trackerIdFor: () => bp.id },
      ).entries,
    );
    const t = await store.getTracker(bp.id);
    expect(t!.entries[0].computed?.bloodPressureCategory).toBeTruthy();
  });
});
