// Chat ↔ record details: "my Civic is in good condition" lands as the SAME
// typed characteristic the Details panel writes — not as a loose text field.
//
// Drives the real executeTool against a storage double that keeps profiles,
// documents and the preference rows record details live in.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DETAIL_DEFS_PREF, parseDefinitions, parseRecordDetails, parseRecordDetailsKey, recordDetailsKey,
} from "../shared/record-details";

type Row = { id: string; name: string; type: string; fields: Record<string, any> };
const db: { profiles: Row[]; documents: any[]; prefs: Record<string, string> } = { profiles: [], documents: [], prefs: {} };

function reseed() {
  db.prefs = {};
  db.profiles = [
    { id: "p-self", name: "Robert", type: "self", fields: {} },
    { id: "p-civic", name: "Honda Civic", type: "vehicle", fields: { make: "Honda" } },
    { id: "p-crv", name: "Honda CR-V", type: "vehicle", fields: { make: "Honda", color: "white" } },
    { id: "p-house", name: "Maple St house", type: "property", fields: {} },
  ];
  db.documents = [{ id: "d-lease", name: "Office lease", type: "contract" }];
}

vi.mock("../server/storage", () => {
  const locks = new Map<string, number>();
  return {
    storage: {
      getProfiles: async () => db.profiles,
      getProfile: async (id: string) => {
        const p = db.profiles.find((x) => x.id === id);
        return p ? JSON.parse(JSON.stringify(p)) : undefined;
      },
      getDocuments: async () => db.documents,
      getDocumentMeta: async (id: string) => db.documents.find((d) => d.id === id),
      getHabits: async () => [], getTasks: async () => [], getGoals: async () => [],
      getEvents: async () => [], getTrackers: async () => [], getExpenses: async () => [],
      getObligations: async () => [], getMemories: async () => [], getJournalEntries: async () => [],
      wouldCreateCycle: async () => false,
      updateProfile: async (id: string, patch: any) => {
        const p = db.profiles.find((x) => x.id === id);
        if (!p) return undefined;
        Object.assign(p, { ...patch, fields: { ...p.fields, ...(patch.fields || {}) } });
        return p;
      },
      acquireUserLock: async (name: string) => { if (locks.has(name)) return false; locks.set(name, 1); return true; },
      releaseUserLock: async (name: string) => { locks.delete(name); },
      getDetailDefinitions: async () => parseDefinitions(db.prefs[DETAIL_DEFS_PREF] ?? null),
      saveDetailDefinitions: async (defs: any[]) => { db.prefs[DETAIL_DEFS_PREF] = JSON.stringify(defs); },
      getRecordDetails: async (t: string, id: string) => parseRecordDetails(db.prefs[recordDetailsKey(t, id)] ?? null),
      saveRecordDetails: async (t: string, id: string, rec: any) => {
        const k = recordDetailsKey(t, id);
        if (Object.keys(rec.values).length === 0) delete db.prefs[k]; else db.prefs[k] = JSON.stringify(rec);
      },
      listRecordDetails: async () => Object.entries(db.prefs).flatMap(([k, v]) => {
        const parsed = parseRecordDetailsKey(k);
        return parsed ? [{ ...parsed, details: parseRecordDetails(v) }] : [];
      }),
    },
  };
});

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  ({ executeTool } = await import("../server/ai-engine"));
});

const storedValue = (type: string, id: string, defId: string) =>
  parseRecordDetails(db.prefs[recordDetailsKey(type, id)] ?? null).values[defId]?.value;

describe("set_record_detail", () => {
  it("'my Civic is in good condition' creates the condition scale, scoped to vehicles, and stores Good", async () => {
    const res = await executeTool("set_record_detail", { record: "Honda Civic", characteristic: "condition", value: "good" });
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({ success: true, record: "Honda Civic", characteristic: "Condition", value: "Good", createdCharacteristic: true, type: "condition" });
    expect(storedValue("profile", "p-civic", "condition")).toBe("Good");
    const defs = parseDefinitions(db.prefs[DETAIL_DEFS_PREF]);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ kind: "condition", appliesTo: ["vehicle"] });
    // The car's own fields are untouched: one source per value.
    expect(db.profiles.find((p) => p.id === "p-civic")!.fields).toEqual({ make: "Honda" });
  });

  it("a second record reuses the characteristic, and the reply quotes the stored value and what it was", async () => {
    await executeTool("set_record_detail", { record: "Honda Civic", characteristic: "Condition", value: "Excellent" });
    const again = await executeTool("set_record_detail", { record: "Honda Civic", characteristic: "Condition", value: "fair" });
    expect(again.message).toBe("Condition on Honda Civic: Fair (was Excellent).");
    const house = await executeTool("set_record_detail", { record: "Maple St house", characteristic: "Condition", value: "Poor" });
    expect(house.createdCharacteristic).toBe(false);
    expect(parseDefinitions(db.prefs[DETAIL_DEFS_PREF])).toHaveLength(1);
  });

  it("a value the characteristic can't hold is an error with the reason, and nothing is saved", async () => {
    await executeTool("set_record_detail", { record: "Honda Civic", characteristic: "Condition", value: "Good" });
    const bad = await executeTool("set_record_detail", { record: "Honda Civic", characteristic: "Condition", value: "shiny" });
    expect(bad.error).toMatch(/one of: Excellent, Good, Fair, Poor/);
    expect(storedValue("profile", "p-civic", "condition")).toBe("Good");
  });

  it("an ambiguous name asks instead of guessing", async () => {
    const res = await executeTool("set_record_detail", { record: "Honda", characteristic: "Condition", value: "Good" });
    expect(res.error).toMatch(/more than one record/);
    expect(Object.keys(db.prefs)).toEqual([]);
  });

  it("works on a contract: 'the office lease is signed'", async () => {
    const res = await executeTool("set_record_detail", { record: "Office lease", characteristic: "Signed", value: "yes" });
    expect(res).toMatchObject({ success: true, value: "Yes", type: "boolean" });
    expect(storedValue("document", "d-lease", "signed")).toBe(true);
  });

  it("null clears a value", async () => {
    await executeTool("set_record_detail", { record: "Honda Civic", characteristic: "Condition", value: "Good" });
    const res = await executeTool("set_record_detail", { record: "Honda Civic", characteristic: "Condition", value: null });
    expect(res.message).toBe("Cleared Condition on Honda Civic.");
    expect(storedValue("profile", "p-civic", "condition")).toBeUndefined();
  });
});

describe("reading details back", () => {
  it("get_record_details answers from the stored record", async () => {
    await executeTool("set_record_detail", { record: "Honda Civic", characteristic: "Condition", value: "Good" });
    const res = await executeTool("get_record_details", { record: "Honda Civic" });
    expect(res.details).toEqual([expect.objectContaining({ characteristic: "Condition", value: "Good" })]);
  });

  it("find_records_by_detail reports across records, filtered by the scale", async () => {
    await executeTool("set_record_detail", { record: "Honda Civic", characteristic: "Condition", value: "Good" });
    await executeTool("set_record_detail", { record: "Maple St house", characteristic: "Condition", value: "Poor" });
    const res = await executeTool("find_records_by_detail", { characteristic: "condition", comparison: "at_or_worse", value: "Fair" });
    expect(res.records.map((r: any) => r.name)).toEqual(["Maple St house"]);
    expect(res.filter).toBe("Condition is at or worse than Fair");
    const unknown = await executeTool("find_records_by_detail", { characteristic: "Sparkle" });
    expect(unknown.error).toMatch(/No characteristic/);
    expect(unknown.knownCharacteristics).toEqual(["Condition"]);
  });
});

describe("update_profile honours defined characteristics", () => {
  it("a field named like a defined characteristic is written to it, typed", async () => {
    await executeTool("set_record_detail", { record: "Honda Civic", characteristic: "Condition", value: "Good" });
    const res = await executeTool("update_profile", { name: "Honda Civic", changes: { fields: { condition: "fair" } } });
    expect(res.error).toBeUndefined();
    expect(res.detailsSaved).toEqual([{ label: "Condition", display: "Fair", previous: "Good" }]);
    expect(storedValue("profile", "p-civic", "condition")).toBe("Fair");
    expect(db.profiles.find((p) => p.id === "p-civic")!.fields.condition).toBeUndefined();
  });

  it("a field the record already holds stays a field (two copies would disagree)", async () => {
    await executeTool("set_record_detail", { record: "Honda Civic", characteristic: "Color", type: "text", value: "Blue" });
    const res = await executeTool("update_profile", { name: "Honda CR-V", changes: { fields: { color: "silver" } } });
    expect(res.error).toBeUndefined();
    expect(db.profiles.find((p) => p.id === "p-crv")!.fields.color).toBe("silver");
    expect(storedValue("profile", "p-crv", "color")).toBeUndefined();
  });

  it("with no characteristics defined, update_profile behaves exactly as before", async () => {
    const res = await executeTool("update_profile", { name: "Honda Civic", changes: { fields: { condition: "fair" } } });
    expect(res.error).toBeUndefined();
    expect(res.detailsSaved).toBeUndefined();
    expect(db.profiles.find((p) => p.id === "p-civic")!.fields.condition).toBe("fair");
  });
});
