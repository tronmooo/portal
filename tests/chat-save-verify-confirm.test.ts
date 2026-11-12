// Save → verify → confirm (owner spec 2026-11-12).
//
// "My car is white, has 35,000 miles, and is all-wheel drive." must update the
// EXISTING car, then read the row back from the database and report each field
// with a ✓ only if the read-back holds it. A field the database did not keep is
// named as failed; a write that kept nothing is an error, never a success.
//
// Drives the real executeTool("update_profile") against a storage double whose
// write can be told to drop fields — the read-back, not the write's return
// value, decides what is verified.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildFieldReceipt, formatFieldReceiptText, receiptDisplayValue, receiptValuesMatch } from "../shared/field-receipt";

type Row = { id: string; name: string; type: string; fields: Record<string, any>; notes?: string };
const db: { profiles: Row[]; dropKeys: Set<string>; lieOnReturn: boolean } = { profiles: [], dropKeys: new Set(), lieOnReturn: false };

function reseed() {
  db.dropKeys = new Set();
  db.lieOnReturn = false;
  db.profiles = [
    { id: "p-self", name: "Robert", type: "self", fields: {} },
    { id: "p-car", name: "Honda CR-V", type: "vehicle", fields: { make: "Honda", model: "CR-V", year: 2021 } },
  ];
}

vi.mock("../server/storage", () => ({
  storage: {
    getProfiles: async () => db.profiles,
    getProfile: async (id: string) => {
      const p = db.profiles.find(x => x.id === id);
      return p ? JSON.parse(JSON.stringify(p)) : undefined;
    },
    getHabits: async () => [], getTasks: async () => [], getGoals: async () => [],
    getEvents: async () => [], getTrackers: async () => [], getExpenses: async () => [],
    getObligations: async () => [], getMemories: async () => [], getDocuments: async () => [],
    getJournalEntries: async () => [],
    wouldCreateCycle: async () => false,
    updateProfile: async (id: string, patch: any) => {
      const p = db.profiles.find(x => x.id === id);
      if (!p) return undefined;
      const asked = { ...p, ...patch, fields: { ...p.fields, ...(patch.fields || {}) } };
      // Persist everything except the keys this test says the DB loses.
      const kept = { ...(patch.fields || {}) };
      for (const k of db.dropKeys) delete kept[k];
      Object.assign(p, { ...patch, fields: { ...p.fields, ...kept } });
      // A write call that returns what it was ASKED to write is exactly why
      // its return value can't be trusted as verification.
      return db.lieOnReturn ? asked : p;
    },
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  ({ executeTool } = await import("../server/ai-engine"));
});

const car = () => db.profiles.find(p => p.id === "p-car")!;
const CAR_FACTS = { color: "white", mileage: 35000, drivetrain: "AWD" };

describe("update_profile: save, read back, confirm each field", () => {
  it("updates the existing car (no duplicate) and verifies all three fields", async () => {
    const res = await executeTool("update_profile", { name: "Honda CR-V", changes: { fields: CAR_FACTS } });
    expect(res.error).toBeUndefined();
    expect(db.profiles.filter(p => p.type === "vehicle")).toHaveLength(1);
    expect(car().fields).toMatchObject(CAR_FACTS);

    const r = res.fieldReceipt;
    expect(r.profileId).toBe("p-car");
    expect(r.allVerified).toBe(true);
    expect(r.failedKeys).toEqual([]);
    expect(r.savedTo).toBe("Assets → Vehicles → Honda CR-V");
    const byKey = Object.fromEntries(r.lines.map((l: any) => [l.key, l]));
    expect(Object.keys(byKey).sort()).toEqual(["color", "drivetrain", "mileage"]);
    expect(byKey.color).toMatchObject({ label: "Color", display: "White", verified: true });
    expect(byKey.mileage).toMatchObject({ label: "Mileage", display: "35,000 miles", verified: true });
    expect(byKey.drivetrain).toMatchObject({ label: "Drivetrain", display: "All-wheel drive (AWD)", verified: true });

    expect(res.receiptText).toContain("• Mileage: 35,000 miles ✓");
    expect(res.receiptText).toContain("Saved to: Assets → Vehicles → Honda CR-V");
  });

  it("names the field the database did not keep — no ✓ on it, ✓ on the rest", async () => {
    db.dropKeys = new Set(["drivetrain"]);
    db.lieOnReturn = true; // the write call claims it saved everything
    const res = await executeTool("update_profile", { name: "Honda CR-V", changes: { fields: CAR_FACTS } });
    expect(res.error).toBeUndefined();
    const r = res.fieldReceipt;
    expect(r.allVerified).toBe(false);
    expect(r.failedKeys).toEqual(["drivetrain"]);
    expect(r.verifiedCount).toBe(2);
    const drive = r.lines.find((l: any) => l.key === "drivetrain");
    expect(drive.verified).toBe(false);
    expect(res.receiptText).toMatch(/Drivetrain: All-wheel drive \(AWD\) ✗ \(not saved\)/);
    expect(res.receiptText).not.toMatch(/Drivetrain[^\n]*✓/);
  });

  it("a write that kept nothing is an error, not a success", async () => {
    db.dropKeys = new Set(Object.keys(CAR_FACTS));
    db.lieOnReturn = true;
    const res = await executeTool("update_profile", { name: "Honda CR-V", changes: { fields: CAR_FACTS } });
    expect(typeof res.error).toBe("string");
    expect(res.error).toMatch(/Nothing was saved/);
    expect(res.fieldReceipt.verifiedCount).toBe(0);
  });

  it("a later question reads the stored mileage", async () => {
    await executeTool("update_profile", { name: "Honda CR-V", changes: { fields: { mileage: 35000 } } });
    const stored = await (await import("../server/storage")).storage.getProfile("p-car");
    expect(stored!.fields.mileage).toBe(35000);
  });
});

describe("buildFieldReceipt (pure)", () => {
  it("unverified when the read-back is missing entirely", () => {
    const r = buildFieldReceipt({ stored: undefined, profileId: "x", profileName: "Car", profileType: "vehicle", requestedFields: { color: "white" } });
    expect(r.lines[0].verified).toBe(false);
    expect(r.allVerified).toBe(false);
  });

  it("matches across spellings and number formats", () => {
    expect(receiptValuesMatch(35000, "35,000")).toBe(true);
    expect(receiptValuesMatch("white", "white ")).toBe(true);
    expect(receiptValuesMatch("white", "black")).toBe(false);
    expect(receiptValuesMatch("white", undefined)).toBe(false);
    const r = buildFieldReceipt({
      stored: { id: "c", name: "Car", type: "vehicle", fields: { vehicle: { odometer: 35000 } } },
      profileId: "c", profileName: "Car", requestedFields: { mileage: 35000 },
    });
    expect(r.lines[0].verified).toBe(true);
  });

  it("removed fields verify by absence", () => {
    const r = buildFieldReceipt({
      stored: { id: "c", name: "Car", type: "vehicle", fields: { vin: "123" } },
      profileId: "c", profileName: "Car", removedFields: ["vin", "licensePlate"],
    });
    expect(r.lines.map(l => [l.key, l.verified])).toEqual([["vin", false], ["licensePlate", true]]);
    expect(formatFieldReceiptText(r)).toContain("VIN: removed ✗");
  });

  it("formats values the way a person reads them", () => {
    expect(receiptDisplayValue("mileage", "35000")).toBe("35,000 miles");
    expect(receiptDisplayValue("drivetrain", "all-wheel drive")).toBe("All-wheel drive (AWD)");
    expect(receiptDisplayValue("driveType", "4WD")).toBe("Four-wheel drive (4WD)");
    expect(receiptDisplayValue("currentValue", 26000)).toBe("$26,000");
    expect(receiptDisplayValue("vin", "1HGCM82633A004352")).toBe("1HGCM82633A004352");
  });
});
