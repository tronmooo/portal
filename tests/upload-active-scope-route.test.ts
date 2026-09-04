// PROP-005 for uploads: a file saved while one profile is the active scope
// belongs to that profile.
//
// Reported 2026-09-04: with "Bob Robertson" selected in the dashboard filter,
// the user saved a file and the Documents tab still read "Nothing to list here
// yet". The upload routes never looked at the X-Active-Profile-Ids header, so a
// save with no owner picked wrote linkedProfiles: [] — which storage (and every
// reader) treats as the self profile's — and Bob's filter hid it.
//
// tests/qa-2026-07-29-routes.test.ts proves the rule for the JSON create
// routes; this one drives the three upload routes through the REAL Express app.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// No API key in CI: extraction fails and the upload lands on the "save the
// document even though extraction died" path, which links from `profileId`
// exactly like the happy path does.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: async () => { throw new Error("model unavailable"); },
    };
  },
}));

import { startHarness, type Harness } from "./helpers/route-harness";
import { ACTIVE_PROFILE_HEADER } from "../shared/active-scope";

const SELF = { id: "self-1", type: "self", name: "Test" };
const BOB = { id: "bob-1", type: "person", name: "Bob Robertson" };
const JANE = { id: "jane-1", type: "person", name: "Jane" };
const FILE = Buffer.from("a saved file").toString("base64");
const asBob = { [ACTIVE_PROFILE_HEADER]: BOB.id };

let h: Harness;
beforeEach(async () => { h = await startHarness({ profiles: [SELF, BOB, JANE] }); });
afterEach(async () => { await h.close(); });

describe("POST /api/upload/save-only — active scope", () => {
  it("links the saved file to the active profile when none is chosen", async () => {
    const r = await h.api("POST", "/api/upload/save-only",
      { fileName: "lease.pdf", mimeType: "application/pdf", fileData: FILE, profileIds: [] }, asBob);
    expect(r.status).toBe(200);
    expect(h.db.documents).toHaveLength(1);
    expect(h.db.documents[0].linkedProfiles).toEqual([BOB.id]);
    expect(r.data.linkedProfiles).toEqual([{ id: BOB.id, name: BOB.name }]);
  });

  it("treats a 'none' selection the same as no selection", async () => {
    await h.api("POST", "/api/upload/save-only",
      { fileName: "lease.pdf", mimeType: "application/pdf", fileData: FILE, profileIds: ["none"] }, asBob);
    expect(h.db.documents[0].linkedProfiles).toEqual([BOB.id]);
  });

  it("honours an explicitly chosen profile over the active scope", async () => {
    await h.api("POST", "/api/upload/save-only",
      { fileName: "lease.pdf", mimeType: "application/pdf", fileData: FILE, profileIds: [JANE.id] }, asBob);
    expect(h.db.documents[0].linkedProfiles).toEqual([JANE.id]);
  });

  it("leaves the file unowned when several profiles are in scope", async () => {
    await h.api("POST", "/api/upload/save-only",
      { fileName: "lease.pdf", mimeType: "application/pdf", fileData: FILE },
      { [ACTIVE_PROFILE_HEADER]: `${BOB.id},${JANE.id}` });
    expect(h.db.documents[0].linkedProfiles).toEqual([]);
  });

  it("changes nothing when the scope is Everyone (no header)", async () => {
    await h.api("POST", "/api/upload/save-only",
      { fileName: "lease.pdf", mimeType: "application/pdf", fileData: FILE });
    expect(h.db.documents[0].linkedProfiles).toEqual([]);
  });
});

describe("POST /api/upload — active scope", () => {
  it("links the upload to the active profile when none is chosen", async () => {
    const r = await h.api("POST", "/api/upload",
      { fileName: "receipt.jpg", mimeType: "image/jpeg", fileData: FILE }, asBob);
    expect(r.status).toBe(200);
    expect(h.db.documents).toHaveLength(1);
    expect(h.db.documents[0].linkedProfiles).toEqual([BOB.id]);
  });

  it("treats profileId 'none' as no choice", async () => {
    await h.api("POST", "/api/upload",
      { fileName: "receipt.jpg", mimeType: "image/jpeg", fileData: FILE, profileId: "none" }, asBob);
    expect(h.db.documents[0].linkedProfiles).toEqual([BOB.id]);
  });

  it("honours an explicit profileId over the active scope", async () => {
    await h.api("POST", "/api/upload",
      { fileName: "receipt.jpg", mimeType: "image/jpeg", fileData: FILE, profileId: JANE.id }, asBob);
    expect(h.db.documents[0].linkedProfiles).toEqual([JANE.id]);
  });

  it("changes nothing when the scope is Everyone", async () => {
    await h.api("POST", "/api/upload",
      { fileName: "receipt.jpg", mimeType: "image/jpeg", fileData: FILE });
    expect(h.db.documents[0].linkedProfiles).toEqual([]);
  });
});

describe("POST /api/upload/batch — active scope", () => {
  it("links every file with no chosen profile to the active profile", async () => {
    const r = await h.api("POST", "/api/upload/batch", {
      files: [
        { fileName: "a.jpg", mimeType: "image/jpeg", fileData: Buffer.from("aaa").toString("base64") },
        { fileName: "b.jpg", mimeType: "image/jpeg", fileData: Buffer.from("bbb").toString("base64"), profileId: "none" },
        { fileName: "c.jpg", mimeType: "image/jpeg", fileData: Buffer.from("ccc").toString("base64"), profileId: JANE.id },
      ],
    }, asBob);
    expect(r.status).toBe(200);
    expect(h.db.documents).toHaveLength(3);
    const byName = Object.fromEntries(h.db.documents.map((d: any) => [d.name, d.linkedProfiles]));
    expect(byName["a.jpg"]).toEqual([BOB.id]);
    expect(byName["b.jpg"]).toEqual([BOB.id]);
    expect(byName["c.jpg"]).toEqual([JANE.id]);
  });
});
