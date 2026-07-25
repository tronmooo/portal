// End-to-end proof for the reported lifting bug — runs the REAL
// log_tracker_entry handler (server/ai-engine executeTool) against an
// in-memory storage and asserts the rows that actually get persisted, not the
// confirmation text.
//
// Reported input (2026-07-25):
//   "Dumbbells I did 45 pounds 10 reps each three times I ran a mile bench
//    pressed 145 pounds 10 reps each and I walked for a mile"
// The model emits one log_tracker_entry per exercise and used to put sets:3 on
// BOTH lifts. The server now re-scopes each entry to the user's own clause.
import { describe, it, expect, beforeEach } from "vitest";
import { executeTool } from "../server/ai-engine";
import { requestStorageContext } from "../server/storage";
import { liftingRecordFromValues, isLiftingEntry, formatLiftingDetail, liftingSetsNote } from "@shared/lifting-scope";

const USER_MESSAGE =
  "Dumbbells I did 45 pounds 10 reps each three times I ran a mile bench pressed 145 pounds 10 reps each and I walked for a mile";

interface LoggedEntry { id: string; trackerId: string; values: Record<string, any> }

function makeStorage() {
  const trackers: any[] = [
    {
      id: "trk-lift", name: "Lifting", category: "fitness", unit: null, entries: [],
      fields: [
        { name: "weight", type: "number", unit: "lbs", isPrimary: true },
        { name: "reps", type: "number", unit: "reps" },
        { name: "sets", type: "number", unit: "sets" },
      ],
    },
    {
      id: "trk-run", name: "Running", category: "fitness", unit: null, entries: [],
      fields: [
        { name: "distance", type: "number", unit: "mi", isPrimary: true },
        { name: "duration", type: "number", unit: "min" },
      ],
    },
  ];
  const entries: LoggedEntry[] = [];
  const base: Record<string, any> = {
    getTrackers: async () => trackers,
    getTracker: async (id: string) => trackers.find((t) => t.id === id) || null,
    getProfiles: async () => [{ id: "self-1", type: "self", name: "Me", fields: {} }],
    getSelfProfile: async () => ({ id: "self-1", type: "self", name: "Me", fields: {} }),
    getPreference: async () => null,
    setPreference: async () => undefined,
    getGoals: async () => [],
    getMemories: async () => [],
    logActivity: () => undefined,
    updateTracker: async (id: string, changes: any) => {
      const t = trackers.find((x) => x.id === id);
      if (t) Object.assign(t, changes);
      return t;
    },
    logEntry: async (row: any) => {
      const entry: LoggedEntry = { id: `e${entries.length + 1}`, trackerId: row.trackerId, values: row.values };
      entries.push(entry);
      trackers.find((t) => t.id === row.trackerId)?.entries.push({ ...entry, timestamp: new Date().toISOString() });
      return entry;
    },
  };
  // Anything the handler reaches for that this fake doesn't model returns an
  // empty list — enough for the log path, and it never silently succeeds on a
  // write we care about (those are all modelled above).
  const storage = new Proxy(base, {
    get: (t, prop: string) => (prop in t ? t[prop] : async () => []),
  }) as any;
  return { storage, entries, trackers };
}

function logExercise(storage: any, trackerName: string, values: Record<string, any>) {
  return requestStorageContext.run(storage, () =>
    executeTool("log_tracker_entry", { trackerName, values, __userMessage: USER_MESSAGE }, "user-1"),
  );
}

describe("persisted lifting records for the reported message", () => {
  let ctx: ReturnType<typeof makeStorage>;
  beforeEach(() => { ctx = makeStorage(); });

  it("saves dumbbell 45 lb × 10 reps × 3 sets and bench press 145 lb × 10 reps with NO sets", async () => {
    // Exactly what the model produced in the bug report — sets:3 on both.
    await logExercise(ctx.storage, "Lifting", { activityType: "dumbbell", exercise: "Dumbbells", weight: 45, reps: 10, sets: 3 });
    await logExercise(ctx.storage, "Lifting", { activityType: "bench press", exercise: "Bench Press", weight: 145, reps: 10, sets: 3 });

    expect(ctx.entries).toHaveLength(2);
    const dumbbell = liftingRecordFromValues(ctx.entries[0].values);
    const benchPress = liftingRecordFromValues(ctx.entries[1].values);

    expect(dumbbell.exerciseName).toBe("Dumbbells");
    expect(dumbbell.weight).toBe(45);
    expect(dumbbell.weightUnit).toBe("lb");
    expect(dumbbell.reps).toBe(10);
    expect(dumbbell.sets).toBe(3);

    expect(benchPress.exerciseName).toBe("Bench Press");
    expect(benchPress.weight).toBe(145);
    expect(benchPress.weightUnit).toBe("lb");
    expect(benchPress.reps).toBe(10);
    expect(benchPress.sets).toBeNull();

    // The leaked field is gone from the stored row, not merely hidden.
    expect("sets" in ctx.entries[1].values).toBe(false);
  });

  it("computes each lift's volume from its OWN set count", async () => {
    await logExercise(ctx.storage, "Lifting", { activityType: "dumbbell", exercise: "Dumbbells", weight: 45, reps: 10, sets: 3 });
    await logExercise(ctx.storage, "Lifting", { activityType: "bench press", exercise: "Bench Press", weight: 145, reps: 10, sets: 3 });
    expect(ctx.entries[0].values.totalVolume).toBe(45 * 10 * 3);
    expect(ctx.entries[1].values.totalVolume).toBe(145 * 10); // one set assumed, not three
  });

  it("renders the two mobile cards from the persisted rows", async () => {
    await logExercise(ctx.storage, "Lifting", { activityType: "dumbbell", exercise: "Dumbbells", weight: 45, reps: 10, sets: 3 });
    await logExercise(ctx.storage, "Lifting", { activityType: "bench press", exercise: "Bench Press", weight: 145, reps: 10, sets: 3 });

    // Mirrors the chat action card: title / detail / optional sets note.
    const card = (values: Record<string, any>) => {
      expect(isLiftingEntry("Lifting", values)).toBe(true);
      const rec = liftingRecordFromValues(values, "Lifting");
      return [rec.exerciseName.toUpperCase(), formatLiftingDetail(rec), liftingSetsNote(rec)]
        .filter(Boolean).join("\n");
    };

    expect(card(ctx.entries[0].values)).toBe("DUMBBELLS\n45 lb · 3 sets × 10 reps");
    expect(card(ctx.entries[1].values)).toBe("BENCH PRESS\n145 lb · 10 reps\nSets not specified");
  });

  it("does not leak reps or weight when the model copies the whole object", async () => {
    // Worst case: the model reused the dumbbell object verbatim for the bench.
    await logExercise(ctx.storage, "Lifting", { exercise: "Dumbbells", weight: 45, reps: 10, sets: 3 });
    await logExercise(ctx.storage, "Lifting", { exercise: "Bench Press", weight: 45, reps: 10, sets: 3 });
    const bench = liftingRecordFromValues(ctx.entries[1].values);
    expect(bench.weight).toBe(145); // corrected from the bench press's own clause
    expect(bench.reps).toBe(10);
    expect(bench.sets).toBeNull();
  });
});

describe("running and walking are untouched by the lifting guard", () => {
  it("keeps the run's stated distance and still enriches it", async () => {
    const ctx = makeStorage();
    const entry = await requestStorageContext.run(ctx.storage, () =>
      executeTool("log_tracker_entry", { trackerName: "Running", values: { distance: 1 }, __userMessage: USER_MESSAGE }, "user-1"),
    );
    expect(entry).toBeTruthy();
    const values = ctx.entries[0].values;
    expect(values.distance).toBe(1);
    // The estimation engine still fills duration/calories for cardio.
    expect(values._enrichment).toBeTruthy();
    expect(typeof values.duration).toBe("number");
    // No lifting field was invented on a cardio entry.
    expect(values.sets).toBeUndefined();
    expect(values.reps).toBeUndefined();
  });
});
