// Rules 19/20 — linked data propagates via relationships, not copies.
//
// A measurable habit mirrors into a tracker. When none existed the tracker
// was auto-created and NAMED AFTER THE HABIT — a copy of habit.name. Renaming
// the habit ("Read for 15 minutes" → "Read for 12 minutes") must carry into
// that mirror; a tracker the user made themselves and linked keeps its own
// name. The decision is the RELATIONSHIP (tracker.linkedHabitId), with a
// name-equality fallback only for legacy mirrors created before the stamp.
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { cascadeHabitRename } from "../server/habit-rename-cascade";
import { resolveTrackerForHabit } from "../server/habit-completion";
import { FIELD_ORIGIN } from "../shared/schema";

const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);

let storage: MemStorage;
beforeEach(() => { storage = new MemStorage(); });

describe("cascadeHabitRename", () => {
  it("renames the mirror tracker (linkedHabitId === habit.id) when the habit is renamed", async () => {
    const habit = await storage.createHabit({ name: "Read for 15 minutes", frequency: "daily", targetPerDay: 1 } as any);
    const mirror = await storage.createTracker({
      name: "Read for 15 minutes", category: "custom",
      fields: [{ name: "completions", type: "number", unit: "×", isPrimary: true }],
      linkedHabitId: habit.id,
    } as any);
    await storage.updateHabit(habit.id, { linkedTrackerId: mirror.id } as any);

    await storage.updateHabit(habit.id, { name: "Read for 12 minutes" } as any);
    const result = await cascadeHabitRename(storage, habit.id, "Read for 15 minutes", "Read for 12 minutes");

    expect(result.renamedTrackerId).toBe(mirror.id);
    expect((await storage.getTracker(mirror.id))?.name).toBe("Read for 12 minutes");
  });

  it("leaves a user-named tracker alone, even though the habit links to it", async () => {
    const exercise = await storage.createTracker({
      name: "Exercise", category: "fitness",
      fields: [{ name: "minutes", type: "number", unit: "min", isPrimary: true }],
    } as any);
    const habit = await storage.createHabit({ name: "Morning Run", frequency: "daily", targetPerDay: 1, linkedTrackerId: exercise.id } as any);

    await storage.updateHabit(habit.id, { name: "Evening Run" } as any);
    const result = await cascadeHabitRename(storage, habit.id, "Morning Run", "Evening Run");

    expect(result.renamedTrackerId).toBeNull();
    expect(result.reason).toBe("not_a_mirror");
    expect((await storage.getTracker(exercise.id))?.name).toBe("Exercise");
  });

  it("recognises a LEGACY mirror (no stamp) by the copied name, and only by that", async () => {
    const legacy = await storage.createTracker({ name: "Drink Water", category: "health", fields: [] } as any);
    const habit = await storage.createHabit({ name: "Drink Water", frequency: "daily", targetPerDay: 1, linkedTrackerId: legacy.id } as any);
    const res = await cascadeHabitRename(storage, habit.id, "Drink Water", "Drink 64 oz of water");
    expect(res.renamedTrackerId).toBe(legacy.id);
    expect((await storage.getTracker(legacy.id))?.name).toBe("Drink 64 oz of water");

    // A tracker stamped for ANOTHER habit is never this habit's mirror.
    const otherHabit = await storage.createHabit({ name: "Meditate", frequency: "daily", targetPerDay: 1 } as any);
    const otherMirror = await storage.createTracker({ name: "Meditate", category: "custom", fields: [], linkedHabitId: otherHabit.id } as any);
    const h2 = await storage.createHabit({ name: "Meditate", frequency: "daily", targetPerDay: 1, linkedTrackerId: otherMirror.id } as any);
    const res2 = await cascadeHabitRename(storage, h2.id, "Meditate", "Meditate 10 min");
    expect(res2.renamedTrackerId).toBeNull();
    expect((await storage.getTracker(otherMirror.id))?.name).toBe("Meditate");
  });

  it("is a no-op for a habit with no tracker, an unchanged name, or a missing tracker", async () => {
    const lone = await storage.createHabit({ name: "Make the bed", frequency: "daily", targetPerDay: 1 } as any);
    expect((await cascadeHabitRename(storage, lone.id, "Make the bed", "Make my bed")).reason).toBe("no_linked_tracker");
    expect((await cascadeHabitRename(storage, lone.id, "Make the bed", "Make the bed")).reason).toBe("no_change");
    const gone = await storage.createHabit({ name: "Floss", frequency: "daily", targetPerDay: 1, linkedTrackerId: "nope" } as any);
    expect((await cascadeHabitRename(storage, gone.id, "Floss", "Floss nightly")).reason).toBe("tracker_missing");
  });

  it("never throws when the tracker write fails — the habit rename already succeeded", async () => {
    const habit = await storage.createHabit({ name: "Stretch", frequency: "daily", targetPerDay: 1 } as any);
    const mirror = await storage.createTracker({ name: "Stretch", category: "custom", fields: [], linkedHabitId: habit.id } as any);
    await storage.updateHabit(habit.id, { linkedTrackerId: mirror.id } as any);
    const broken = Object.create(storage);
    broken.updateTracker = async () => { throw new Error("db down"); };
    const res = await cascadeHabitRename(broken, habit.id, "Stretch", "Stretch 5 min");
    expect(res).toEqual({ renamedTrackerId: null, reason: "write_failed" });
  });
});

describe("the mirror relationship is stamped at creation", () => {
  it("resolveTrackerForHabit stamps linkedHabitId on the tracker it auto-creates", async () => {
    const habit = await storage.createHabit({ name: "Read for 15 minutes", frequency: "daily", targetPerDay: 1 } as any);
    const resolved = await run(storage, () => resolveTrackerForHabit(storage, habit, { fallbackToHabitName: true }));
    expect(resolved?.created).toBe(true);
    const tracker = await storage.getTracker(resolved!.id);
    expect(tracker?.linkedHabitId).toBe(habit.id);
  });

  it("FIELD_ORIGIN documents the mirror name as a copy kept in sync by the cascade", () => {
    expect(FIELD_ORIGIN["tracker.name[mirror]"].kind).toBe("copied");
    expect(FIELD_ORIGIN["tracker.name[mirror]"].from).toBe("habit.name");
    expect(FIELD_ORIGIN["tracker.name[mirror]"].syncedBy).toBe("server/habit-rename-cascade.ts");
    expect(FIELD_ORIGIN["liability_payments.*"].kind).toBe("snapshot");
    expect(FIELD_ORIGIN["habit.name"].kind).toBe("canonical");
  });
});

describe("the PATCH route and the AI update_habit handler both cascade", () => {
  it("routes.ts calls cascadeHabitRename after updateHabit", () => {
    const fs = require("fs"); const path = require("path");
    const src = fs.readFileSync(path.resolve(__dirname, "../server/routes.ts"), "utf8");
    const at = src.indexOf('app.patch("/api/habits/:id"');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 2500)).toContain("cascadeHabitRename(storage, req.params.id, previousName, result.name)");
    const ai = fs.readFileSync(path.resolve(__dirname, "../server/ai-engine.ts"), "utf8");
    const c = ai.indexOf('case "update_habit":');
    expect(ai.slice(c, c + 2500)).toContain("cascadeHabitRename(storage, uhMatch.id, uhMatch.name, updated.name)");
  });
});
