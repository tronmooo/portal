// Editing a tracker entry re-derives what the engine derived from it
// (shared/entry-rederive). QA 2026-11-24: a run changed from 1.25 to 1.5 miles
// kept "11.2 min/mile · 5.36 mph" in its history row while the card said 9:20.
import { describe, it, expect } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";
import { MemStorage } from "../server/storage";
import { enrichWalkRunEntry, applyEnrichmentToValues } from "../shared/estimation-engine";
import { rederiveEditedEntry } from "../shared/entry-rederive";

/** A run as the chat lane stores it: what was said, plus what the engine filled in. */
function loggedRun() {
  const values: Record<string, any> = { activityType: "running", distance: 1.25, duration: 14 };
  const enrichment = enrichWalkRunEntry("running", values, {});
  applyEnrichmentToValues(values, enrichment);
  return { values, enrichment };
}
/** What the edit form sends: every field it shows, one of them changed. */
const formPatch = (values: Record<string, any>, change: Record<string, any>) => ({ ...values, ...change });

function supabaseWith(row: any) {
  const captured: { update: any } = { update: null };
  const from = () => {
    const b: any = {
      _u: false,
      select() { return b; },
      update(p: any) { b._u = true; captured.update = p; return b; },
      eq() { return b; }, is() { return b; },
      async maybeSingle() { return { data: b._u ? { ...row, ...captured.update } : row, error: null }; },
    };
    return b;
  };
  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = "user-1";
  storage.supabase = { from };
  storage.getTracker = async () => ({
    id: "t1", name: "Running", category: "fitness", linkedProfiles: [], entries: [],
    fields: ["activityType", "distance", "duration", "paceMinutesPerMile", "speedMph", "steps", "caloriesBurned"]
      .map((name) => ({ name, type: name === "activityType" ? "text" : "number" })),
  });
  return { storage, captured };
}

describe("an edited entry's derived figures follow the edit", () => {
  it("the fixture is the reported run: 11.2 min/mile, 5.36 mph", () => {
    const { values } = loggedRun();
    expect(values.paceMinutesPerMile).toBe(11.2);
    expect(values.speedMph).toBe(5.36);
    expect(typeof values.steps).toBe("number");
    expect(typeof values.caloriesBurned).toBe("number");
  });

  it("a new distance re-derives pace, speed, steps and calories in the stored row", async () => {
    const { values, enrichment } = loggedRun();
    const { storage, captured } = supabaseWith({
      id: "e1", tracker_id: "t1", user_id: "user-1", entry_values: values,
      computed: { validated: true, enrichment }, timestamp: "2026-11-24T10:00:00.000Z", updated_at: "x",
    });
    const saved = await storage.updateTrackerEntry("t1", "e1", { values: formPatch(values, { distance: 1.5 }), valuesToDelete: [] });
    const v = captured.update.entry_values;
    expect(v.distance).toBe(1.5);
    expect(v.duration).toBe(14);
    expect(v.paceMinutesPerMile).toBe(9.3);
    expect(v.speedMph).toBe(6.43);
    expect(v.steps).toBeGreaterThan(values.steps);
    expect(v.caloriesBurned).toBeGreaterThan(values.caloriesBurned);
    // The provenance describes the row it sits on.
    const e = captured.update.computed.enrichment;
    expect(e.calculated.paceMinutesPerMile.value).toBe(9.3);
    expect(e.calculated.speedMph.value).toBe(6.43);
    expect(e.estimated.steps.value).toBe(v.steps);
    expect(e.canonical.distanceMeters).toBeCloseTo(1.5 * 1609.344, 0);
    // One calorie figure: the mirrored field and the computed one agree.
    expect(captured.update.computed.caloriesBurned).toBe(v.caloriesBurned);
    expect(captured.update.computed.pace).toBe("9:20/mi");
    expect(saved.values.distance).toBe(1.5);
  });

  it("a pace or speed stored under another name follows too (the chat's `pace: 11.2`)", () => {
    const { values, enrichment } = loggedRun();
    const stored = { ...values, pace: 11.2, avg_speed: 5.36, heart_rate: 150 };
    const out = rederiveEditedEntry({ trackerName: "Running", storedValues: stored, enrichment, patchValues: formPatch(stored, { distance: 1.5 }) })!;
    expect(out.values.pace).toBe(9.3);
    expect(out.values.avg_speed).toBe(6.43);
    expect(out.values.heart_rate).toBe(150);
    // One the user typed in this edit is kept.
    const typed = rederiveEditedEntry({ trackerName: "Running", storedValues: stored, enrichment, patchValues: formPatch(stored, { distance: 1.5, pace: 9 }) })!;
    expect(typed.values.pace).toBe(9);
  });

  it("a derived figure the user changes is theirs: it is kept and no longer marked derived", () => {
    const { values, enrichment } = loggedRun();
    const out = rederiveEditedEntry({ trackerName: "Running", storedValues: values, enrichment, patchValues: formPatch(values, { steps: 2500 }) })!;
    expect(out.values.steps).toBe(2500);
    expect(out.enrichment.estimated.steps).toBeUndefined();
    expect(out.values.distance).toBe(1.25);
    expect(out.values.paceMinutesPerMile).toBe(11.2);
  });

  it("a derived figure the user removes stays removed", () => {
    const { values, enrichment } = loggedRun();
    const { steps: _gone, ...rest } = values;
    const out = rederiveEditedEntry({ trackerName: "Running", storedValues: values, enrichment, patchValues: rest, valuesToDelete: ["steps"] })!;
    expect("steps" in out.values).toBe(false);
    expect(out.enrichment.estimated.steps).toBeUndefined();
  });

  it("an edit that changes no value re-derives nothing (a note, an untouched form)", () => {
    const { values, enrichment } = loggedRun();
    expect(rederiveEditedEntry({ trackerName: "Running", storedValues: values, enrichment, patchValues: { ...values } })).toBeNull();
    expect(rederiveEditedEntry({ trackerName: "Running", storedValues: values, enrichment, patchValues: undefined })).toBeNull();
  });

  it("an entry with no derived figures is merged as before", () => {
    expect(rederiveEditedEntry({ trackerName: "Sleep", storedValues: { hours: 8 }, enrichment: null, patchValues: { hours: 7 } })).toBeNull();
  });

  it("the in-memory storage follows the same rule", async () => {
    const mem = new MemStorage();
    const tracker = await mem.createTracker({ name: "Running", category: "fitness", fields: [{ name: "distance", type: "number" }, { name: "duration", type: "number" }] } as any);
    const { values, enrichment } = loggedRun();
    const entry = await mem.logEntry({ trackerId: tracker.id, values: { ...values, _enrichment: enrichment } } as any);
    expect((entry as any).computed.enrichment.calculated.speedMph.value).toBe(5.36);
    const saved: any = await mem.updateTrackerEntry(tracker.id, entry!.id, { values: formPatch(values, { distance: 1.5 }) });
    expect(saved.values.speedMph).toBe(6.43);
    expect(saved.computed.enrichment.calculated.speedMph.value).toBe(6.43);
  });
});
