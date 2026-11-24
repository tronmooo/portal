// A new entry derives what the chat derives (shared/entry-rederive
// `deriveNewEntry`). QA 2026-11-24: on the Trackers page, Add Entry on a
// Running tracker with 2 miles in 20 minutes saved distance and duration only;
// pace and speed were still missing after a reload, though the form says
// secondary data is computed automatically. The chat lane ran the estimation
// engine before writing; the form → POST route → storage.logEntry path never
// did. Both storages now derive on create when the caller brought no
// provenance of its own.
import { describe, it, expect } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";
import { MemStorage } from "../server/storage";
import { deriveNewEntry } from "../shared/entry-rederive";

const RUN_FIELDS = [
  { name: "distance", type: "number", unit: "mi", isPrimary: true },
  { name: "duration", type: "number", unit: "min" },
  { name: "pace", type: "number", unit: "min/mi" },
  { name: "speed", type: "number", unit: "mph" },
  { name: "caloriesBurned", type: "number", unit: "kcal" },
  { name: "heartRate", type: "number", unit: "bpm" },
];
/** Exactly what the Add Entry form posts for "2 miles in 20 minutes". */
const FORM_BODY = { values: { distance: 2, duration: 20 }, allowDuplicate: true };

function supabaseStorage() {
  const inserts: any[] = [];
  const from = (table: string) => {
    const b: any = {
      _row: null as any,
      insert(row: any) { b._row = row; if (table === "tracker_entries") inserts.push(row); return b; },
      select() { return b; },
      eq() { return b; }, is() { return b; }, gte() { return b; }, order() { return b; }, limit() { return b; },
      async maybeSingle() { return { data: b._row, error: null }; },
      then(res: any) { return Promise.resolve({ data: [], error: null }).then(res); },
    };
    return b;
  };
  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = "user-1";
  storage.supabase = { from };
  storage.getTracker = async () => ({
    id: "t1", name: "Running", category: "fitness", unit: "mi", linkedProfiles: [], entries: [], fields: RUN_FIELDS,
  });
  storage.getProfile = async () => undefined;
  storage.getHabits = async () => [];
  storage.logActivity = () => undefined;
  return { storage, inserts };
}

describe("a manually added run derives pace and speed (both storages)", () => {
  it("SupabaseStorage.logEntry stores pace, speed and their provenance", async () => {
    const { storage, inserts } = supabaseStorage();
    const entry: any = await storage.logEntry({ trackerId: "t1", ...FORM_BODY });
    expect(inserts).toHaveLength(1);
    const v = inserts[0].entry_values;
    expect(v.distance).toBe(2);
    expect(v.duration).toBe(20);
    expect(v.paceMinutesPerMile).toBe(10);
    expect(v.speedMph).toBe(6);
    // The tracker's own Pace / Speed fields, left blank on the form, are filled.
    expect(v.pace).toBe(10);
    expect(v.speed).toBe(6);
    // Provenance lets a later edit re-derive them (Rule 11b).
    expect(inserts[0].computed.enrichment.calculated.paceMinutesPerMile.value).toBe(10);
    expect(inserts[0].computed.enrichment.activityType).toBe("running");
    expect(entry.values.pace).toBe(10);
  });

  it("MemStorage.logEntry does the same", async () => {
    const mem = new MemStorage();
    const tracker = await mem.createTracker({ name: "Running", category: "fitness", unit: "mi", fields: RUN_FIELDS } as any);
    const entry: any = await mem.logEntry({ trackerId: tracker.id, ...FORM_BODY } as any);
    expect(entry.values.paceMinutesPerMile).toBe(10);
    expect(entry.values.speedMph).toBe(6);
    expect(entry.values.pace).toBe(10);
    expect(entry.values.speed).toBe(6);
    expect(entry.computed.enrichment.calculated.speedMph.value).toBe(6);
    // …and an edit of that entry now re-derives (it had nothing to re-derive from).
    const edited: any = await mem.updateTrackerEntry(tracker.id, entry.id, { values: { ...entry.values, distance: 2.5 } });
    expect(edited.values.paceMinutesPerMile).toBe(8);
    expect(edited.values.pace).toBe(8);
  });

  it("a stated pace is never replaced", async () => {
    const mem = new MemStorage();
    const tracker = await mem.createTracker({ name: "Running", category: "fitness", fields: RUN_FIELDS } as any);
    const entry: any = await mem.logEntry({ trackerId: tracker.id, values: { distance: 2, duration: 20, pace: 9.5 }, allowDuplicate: true } as any);
    expect(entry.values.pace).toBe(9.5);
    expect(entry.values.speedMph).toBe(6);
  });

  it("the chat lane's own provenance is kept as sent (no second derivation)", async () => {
    const mem = new MemStorage();
    const tracker = await mem.createTracker({ name: "Running", category: "fitness", fields: RUN_FIELDS } as any);
    const sent = { activityType: "running", calculated: {}, estimated: {}, canonical: {}, assumptions: [], marker: "chat" };
    const entry: any = await mem.logEntry({ trackerId: tracker.id, values: { distance: 2, duration: 20, _enrichment: sent }, allowDuplicate: true } as any);
    expect(entry.computed.enrichment.marker).toBe("chat");
    expect(entry.values.pace).toBeUndefined();
    expect("pace" in entry.values).toBe(false);
  });
});

describe("deriveNewEntry leaves alone what it cannot read", () => {
  it("another kind of tracker", () => {
    expect(deriveNewEntry({ trackerName: "Blood Pressure", values: { systolic: 120, diastolic: 80 } })).toBeNull();
  });
  it("an entry with nothing measured (a habit tick) — never a made-up typical run", () => {
    expect(deriveNewEntry({ trackerName: "Running", values: { completed: 1 } })).toBeNull();
  });
  it("a distance in kilometres (the cardio engine reads miles)", () => {
    expect(deriveNewEntry({
      trackerName: "Running", values: { distance: 5, duration: 25 },
      ctx: { fields: [{ name: "distance", unit: "km" }, { name: "duration", unit: "min" }] as any },
    })).toBeNull();
  });
  it("a walk with distance and duration gets pace and speed", () => {
    const r = deriveNewEntry({ trackerName: "Walking", values: { distance: 1, duration: 20 } });
    expect(r?.values.paceMinutesPerMile).toBe(20);
    expect(r?.values.speedMph).toBe(3);
  });
});
