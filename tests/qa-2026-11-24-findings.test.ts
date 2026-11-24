// QA 2026-11-24 — "Chat said the lens was filed under a different parent,
// while the lens profile and Assets list showed Tutorial Camera."
//
// The chat's confirmation is built from a read-back of the saved record
// (shared/field-receipt). It named the record and its fields, but not where
// the record sits, so the only words about the parent were the model's own —
// and those were wrong. The parent is now read back from the saved row
// (server/profile-write-verify.ts) and stated by the receipt; the model's
// sentence about placement is dropped like its other restatements.
//
// Also here: a profile's detail must fail when one of its lists fails to
// load, never answer with an empty list (Rule 7).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { buildFieldReceipt, composeReceiptReply, receiptCardSummary, receiptNestingParentName, receiptSavedTo } from "../shared/field-receipt";
import { verifyProfileWrite } from "../server/profile-write-verify";

const CAMERA = { id: "cam", name: "Tutorial Camera", type: "asset", fields: { currentValue: 900 }, parentProfileId: "me" };
const LENS = { id: "lens", name: "50mm Lens", type: "asset", fields: { currentValue: 300 }, parentProfileId: "cam" };
const ME = { id: "me", name: "Bob Robertson", type: "self", fields: {} };

function store(rows: any[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    getProfile: async (id: string) => byId.get(id),
    updateProfile: async (id: string, changes: any) => { const r = { ...byId.get(id), ...changes }; byId.set(id, r); return r; },
  };
}

describe("the chat's confirmation says where a nested record sits — from the saved row", () => {
  it("a lens created inside the camera is confirmed inside the camera", async () => {
    const { receipt } = await verifyProfileWrite(store([ME, CAMERA, LENS]), {
      profileId: "lens", profileName: "50mm Lens", profileType: "asset",
      requestedFields: { currentValue: 300 }, action: "created", presenceOnly: true,
    });
    expect(receipt.parentName).toBe("Tutorial Camera");
    expect(receipt.savedTo).toBe("Assets → Tutorial Camera → 50mm Lens");
    const reply = composeReceiptReply([receipt], "");
    expect(reply).toContain("**50mm Lens**, inside **Tutorial Camera**");
    expect(reply).toContain("Find it in **Assets → Tutorial Camera → 50mm Lens**");
    expect(receiptCardSummary(receipt)).toContain("Assets → Tutorial Camera");
  });

  it("the parent is the one the row HAS, not the one that was asked for", async () => {
    // The write was asked to nest under the camera; the saved row sits under
    // the user. The confirmation must not claim the camera.
    const strayLens = { ...LENS, parentProfileId: "me" };
    const { receipt } = await verifyProfileWrite(store([ME, CAMERA, strayLens]), {
      profileId: "lens", profileName: "50mm Lens", profileType: "asset",
      requestedFields: { currentValue: 300 }, action: "created", presenceOnly: true,
    });
    expect(receipt.parentName).toBeUndefined();
    expect(receipt.savedTo).toBe("Assets → 50mm Lens");
    expect(composeReceiptReply([receipt], "")).not.toContain("Tutorial Camera");
  });

  it("a person parent is the owner, not a container", () => {
    expect(receiptNestingParentName(ME)).toBeUndefined();
    expect(receiptNestingParentName({ name: "Jim", type: "person" })).toBeUndefined();
    expect(receiptNestingParentName({ name: "Rex", type: "pet" })).toBeUndefined();
    expect(receiptNestingParentName(CAMERA)).toBe("Tutorial Camera");
    expect(receiptNestingParentName(null)).toBeUndefined();
    const r = buildFieldReceipt({ stored: CAMERA, parent: ME, profileId: "cam", profileName: "Tutorial Camera", requestedFields: { currentValue: 900 }, action: "created", presenceOnly: true });
    expect(r.parentName).toBeUndefined();
    expect(r.savedTo).toBe(receiptSavedTo("asset", "Tutorial Camera"));
  });

  it("the model's own sentence about the parent is dropped; what else it said is kept", async () => {
    const { receipt } = await verifyProfileWrite(store([ME, CAMERA, LENS]), {
      profileId: "lens", profileName: "50mm Lens", profileType: "asset",
      requestedFields: { currentValue: 300 }, action: "created", presenceOnly: true,
    });
    const model = [
      "It's filed under Home Office Equipment.",
      "I nested it inside your Canon kit.",
      "Parent asset: Home Office Equipment",
      "Want me to add its serial number too?",
    ].join("\n");
    const reply = composeReceiptReply([receipt], model);
    expect(reply).not.toContain("Home Office Equipment");
    expect(reply).not.toContain("Canon kit");
    expect(reply).toContain("inside **Tutorial Camera**");
    expect(reply).toContain("Want me to add its serial number too?");
  });

  it("an update to a nested record names where it sits too", async () => {
    const { receipt } = await verifyProfileWrite(store([ME, CAMERA, { ...LENS, fields: { currentValue: 280 } }]), {
      profileId: "lens", profileName: "50mm Lens", profileType: "asset",
      requestedFields: { currentValue: 280 }, action: "updated",
    });
    expect(composeReceiptReply([receipt], "")).toContain("Assets → Tutorial Camera → 50mm Lens");
  });
});

describe("a profile's detail fails when one of its lists fails (Rule 7)", () => {
  const src = fs.readFileSync("server/supabase-storage.ts", "utf8");
  const start = src.indexOf("async getProfileDetail(id: string)");
  const body = src.slice(start, src.indexOf("const trackerIds = (trackersRes as any[])", start));

  it("the function is where the test expects it", () => {
    expect(start).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(500);
  });

  it("no list read turns an error into an empty list", () => {
    const code = body.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/\.then\(\s*r\s*=>\s*r\.data\s*\|\|\s*\[\]\s*\)/);
    // trackers, expenses, tasks, events, documents, journal, habits
    expect((code.match(/\.then\(rowsOrThrow\)/g) || []).length).toBe(7);
    expect(code).toMatch(/if \(r\.error\) throw r\.error;/);
  });
});
