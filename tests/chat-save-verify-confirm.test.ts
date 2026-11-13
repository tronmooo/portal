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
const db: { profiles: Row[]; dropKeys: Set<string>; lieOnReturn: boolean; dropOnce: boolean } = { profiles: [], dropKeys: new Set(), lieOnReturn: false, dropOnce: false };

function reseed() {
  db.dropKeys = new Set();
  db.lieOnReturn = false;
  db.dropOnce = false;
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
      if (db.dropOnce) db.dropKeys = new Set();
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
    expect(res.fieldReceipt.retried).toBeUndefined();
    expect(res.receiptText).toContain("Saved to: Assets → Vehicles → Honda CR-V");
  });

  it("a field lost on the first write is re-saved, then verified", async () => {
    db.dropKeys = new Set(["drivetrain"]);
    db.dropOnce = true;
    db.lieOnReturn = true; // the write call claims it saved everything
    const res = await executeTool("update_profile", { name: "Honda CR-V", changes: { fields: CAR_FACTS } });
    expect(res.error).toBeUndefined();
    expect(car().fields.drivetrain).toBe("AWD");
    expect(res.fieldReceipt.allVerified).toBe(true);
    expect(res.fieldReceipt.retried).toBe(true);
  });

  it("a field the database never keeps is not shown as saved", async () => {
    db.dropKeys = new Set(["drivetrain"]);
    db.lieOnReturn = true;
    const res = await executeTool("update_profile", { name: "Honda CR-V", changes: { fields: CAR_FACTS } });
    expect(res.error).toBeUndefined();
    const r = res.fieldReceipt;
    expect(r.failedKeys).toEqual(["drivetrain"]);
    expect(r.verifiedCount).toBe(2);
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
    expect(formatFieldReceiptText(r)).toContain("VIN: removed (NOT confirmed");
  });

  it("formats values the way a person reads them", () => {
    expect(receiptDisplayValue("mileage", "35000")).toBe("35,000 miles");
    expect(receiptDisplayValue("drivetrain", "all-wheel drive")).toBe("All-wheel drive (AWD)");
    expect(receiptDisplayValue("driveType", "4WD")).toBe("Four-wheel drive (4WD)");
    expect(receiptDisplayValue("currentValue", 26000)).toBe("$26,000");
    expect(receiptDisplayValue("vin", "1HGCM82633A004352")).toBe("1HGCM82633A004352");
  });
});

import { composeReceiptReply, receiptReplyBlock, receiptCardSummary } from "../shared/field-receipt";
import { checkClaims } from "../shared/ai-claim-check";

const carStored = { id: "c", name: "Honda CR-V", type: "vehicle", fields: { color: "white", mileage: 35000, drivetrain: "AWD" } };
const fullReceipt = () => buildFieldReceipt({ stored: carStored, profileId: "c", profileName: "Honda CR-V", requestedFields: { color: "white", mileage: 35000, drivetrain: "AWD" } });
const partialReceipt = () => buildFieldReceipt({ stored: { ...carStored, fields: { color: "white", mileage: 35000 } }, profileId: "c", profileName: "Honda CR-V", requestedFields: { color: "white", mileage: 35000, drivetrain: "AWD" } });

describe("the chat message says what was saved and where", () => {
  it("one field: a sentence naming the value, the field, the record and where to find it", () => {
    const r = buildFieldReceipt({ stored: carStored, profileId: "c", profileName: "Honda CR-V", requestedFields: { color: "black" } });
    // stored "white" ≠ "black" → not verified; use a matching store instead
    const ok = buildFieldReceipt({ stored: { ...carStored, fields: { color: "Black" } }, profileId: "c", profileName: "Honda CR-V", requestedFields: { color: "black" } });
    expect(r.lines[0].verified).toBe(false);
    expect(ok.lines[0].verified).toBe(true); // "Black" stored for "black" is the user's value
    const text = receiptReplyBlock(ok);
    expect(text).toContain("✅ Saved **Black** as the **color** in the asset profile for your **Honda CR-V**.");
    expect(text).toContain("📍 Find it in **Assets → Vehicles → Honda CR-V**");
    expect(text).toContain("Verified — I read it back from your saved record and it matches.");
    expect(text).not.toMatch(/[✗❌]/);
  });

  it("several fields: each value listed with ✓, where to find it, all verified", () => {
    const text = receiptReplyBlock(fullReceipt());
    expect(text).toContain("✅ Saved three details in the asset profile for your **Honda CR-V**:");
    expect(text).toContain("- **Color:** White ✓");
    expect(text).toContain("- **Mileage:** 35,000 miles ✓");
    expect(text).toContain("- **Drivetrain:** All-wheel drive (AWD) ✓");
    expect(text).toContain("📍 Find it in **Assets → Vehicles → Honda CR-V**");
    expect(text).toContain("All three verified — I read them back from your saved record and they match.");
  });

  it("someone else's car is named as theirs", () => {
    const r = { ...fullReceipt(), ownerName: "Jim" };
    expect(receiptReplyBlock(r)).toContain("in the asset profile for Jim's **Honda CR-V**");
  });

  it("a new asset says it was created, what it holds and where", () => {
    const r = buildFieldReceipt({ stored: { id: "d", name: "Dodge Ram", type: "vehicle", fields: { color: "White", driveType: "4WD" } }, profileId: "d", profileName: "Dodge Ram", requestedFields: { color: "white", driveType: "4wd" }, action: "created", presenceOnly: true });
    const text = receiptReplyBlock(r);
    expect(text).toContain("✅ Created a new asset profile for your **Dodge Ram** and saved two details:");
    expect(text).toContain("- **Drivetrain:** Four-wheel drive (4WD) ✓");
    expect(text).toContain("📍 Find it in **Assets → Vehicles → Dodge Ram**");
  });

  it("no ✗ lines: an unconfirmed field is never listed as saved, and is named in one sentence", () => {
    const text = receiptReplyBlock(partialReceipt());
    expect(text).toContain("✅ Saved two details in the asset profile for your **Honda CR-V**:");
    expect(text).not.toMatch(/Drivetrain[^\n]*✓/);
    expect(text).not.toMatch(/[✗❌]/);
    expect(text).toContain("⚠️ I couldn't confirm the **drivetrain** (All-wheel drive (AWD)) on the record even after saving it again");
  });

  it("replaces the generic model line and its own restatement, keeps everything else", () => {
    const model = [
      'Updated asset "Honda CR-V".',
      "- Color: White ✓",
      "Mileage: 35,000 miles",
      "I've saved white as your car's color.",
      "Saved to: Assets → Vehicles → Honda CR-V",
      "All three details have been verified.",
      "Your next oil change is due at 37,500 miles.",
    ].join("\n");
    const out = composeReceiptReply([fullReceipt()], model);
    expect(out.startsWith("✅ Saved three details")).toBe(true);
    expect(out).not.toContain('Updated asset "Honda CR-V"');
    expect(out).not.toContain("I've saved white");
    expect(out.match(/Color/g)).toHaveLength(1);
    expect(out.trim().endsWith("Your next oil change is due at 37,500 miles.")).toBe(true);
  });

  it("the card line says what was saved and where", () => {
    const one = buildFieldReceipt({ stored: { ...carStored, fields: { color: "black" } }, profileId: "c", profileName: "Honda CR-V", requestedFields: { color: "black" } });
    expect(receiptCardSummary(one)).toBe("Color: Black saved · Assets → Vehicles");
    expect(receiptCardSummary(fullReceipt())).toBe("3 details saved & verified · Assets → Vehicles");
    expect(receiptCardSummary(partialReceipt())).toBe("2 details saved & verified · Assets → Vehicles · 1 to resend");
  });
});

describe("verifyProfileWrite re-saves what didn't land", () => {
  it("a field lost on the first write is written again and then verified", async () => {
    const { verifyProfileWrite } = await import("../server/profile-write-verify");
    const row: any = { id: "c", name: "Honda CR-V", type: "vehicle", fields: { color: "white", mileage: 35000 } };
    const writes: any[] = [];
    const store = {
      getProfile: async () => JSON.parse(JSON.stringify(row)),
      updateProfile: async (_id: string, patch: any) => { writes.push(patch); Object.assign(row.fields, patch.fields || {}); return row; },
    };
    const { receipt } = await verifyProfileWrite(store, { profileId: "c", profileName: "Honda CR-V", requestedFields: { color: "white", mileage: 35000, drivetrain: "AWD" } });
    expect(writes).toEqual([{ fields: { drivetrain: "AWD" } }]); // only the missing field
    expect(receipt.allVerified).toBe(true);
    expect(receipt.retried).toBe(true);
  });

  it("a field the database keeps refusing stays unconfirmed after the retries", async () => {
    const { verifyProfileWrite } = await import("../server/profile-write-verify");
    const row: any = { id: "c", name: "Car", type: "vehicle", fields: {} };
    let n = 0;
    const store = { getProfile: async () => ({ ...row }), updateProfile: async () => { n++; return row; } };
    const { receipt } = await verifyProfileWrite(store, { profileId: "c", profileName: "Car", requestedFields: { color: "black" } });
    expect(n).toBe(2);
    expect(receipt.failedKeys).toEqual(["color"]);
  });
});

describe("claim check: 'saved' is not 'created'", () => {
  it("an update reply that says 'saved and verified' is not a create/update mismatch", () => {
    const res = checkClaims({
      reply: "✅ Your Honda CR-V is updated — saved and verified:\nSaved to: Assets → Vehicles → Honda CR-V",
      operations: [{ tool: "update_profile", status: "ok", entityId: "c", raw: "Honda CR-V" }],
      intentEntity: "asset", intentOperation: "update",
    });
    expect(res.violations).toEqual([]);
  });

  it("'created' on an update turn is still caught", () => {
    const res = checkClaims({
      reply: "Created your Honda CR-V.",
      operations: [{ tool: "update_profile", status: "ok", entityId: "c", raw: "Honda CR-V" }],
    });
    expect(res.violations.map(v => v.mismatchType)).toContain("claimed_create_but_updated");
  });

  it("'saved' with nothing written is still an unsupported success", () => {
    const res = checkClaims({ reply: "Saved your car's mileage.", operations: [] });
    expect(res.unsupportedSuccess).toBe(true);
  });
});
