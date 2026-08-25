// POST /api/profiles/bulk-delete — removing people from the app for good.
//
// The single-profile DELETE already cascades; this route exists so the
// profiles index can clear several at once behind one confirmation. What has
// to hold: the rows really go (the profile AND everything that named it, not
// a hide), your own Self profile is refused, and a batch where one id fails
// still reports the ones that succeeded instead of claiming all-or-nothing.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startHarness, type Harness } from "./helpers/route-harness";

const seed = () => ({
  profiles: [
    { id: "self-1", type: "self", name: "Me", fields: {} },
    { id: "bob-1", type: "person", name: "Bob QA", fields: {} },
    { id: "jane-1", type: "person", name: "Jane Doe", fields: {} },
    // Bob's car — a child profile, so it must go when Bob does.
    { id: "car-1", type: "vehicle", name: "Bob's Civic", parentProfileId: "bob-1", fields: {} },
  ],
  expenses: [
    { id: "exp-bob", profileId: "bob-1", amount: 20, description: "Bob lunch" },
    { id: "exp-jane", profileId: "jane-1", amount: 30, description: "Jane lunch" },
  ],
  tasks: [{ id: "task-bob", linkedProfiles: ["bob-1"], title: "Call Bob" }],
  documents: [{ id: "doc-car", profileId: "car-1", name: "Civic registration" }],
});

let h: Harness;
beforeEach(async () => { h = await startHarness(seed()); });
afterEach(async () => { await h.close(); });

const ids = () => h.db.profiles.map((p: any) => p.id);

describe("POST /api/profiles/bulk-delete", () => {
  it("deletes several people and everything linked to them", async () => {
    const r = await h.api("POST", "/api/profiles/bulk-delete", { ids: ["bob-1", "jane-1"] });

    expect(r.status).toBe(200);
    expect(r.data.success).toBe(true);
    expect(r.data.deleted.map((d: any) => d.name).sort()).toEqual(["Bob QA", "Jane Doe"]);
    expect(r.data.failed).toEqual([]);

    // The profiles are gone, and so is Bob's child vehicle.
    expect(ids()).toEqual(["self-1"]);
    // Their data went with them — this is the part a "hide" would get wrong.
    expect(h.db.expenses).toEqual([]);
    expect(h.db.tasks).toEqual([]);
    expect(h.db.documents).toEqual([]);
  });

  it("refuses your own Self profile and keeps its rows", async () => {
    const r = await h.api("POST", "/api/profiles/bulk-delete", { ids: ["self-1"] });

    expect(r.status).toBe(500);
    expect(r.data.success).toBe(false);
    expect(r.data.deleted).toEqual([]);
    expect(r.data.failed[0]).toMatchObject({ id: "self-1" });
    expect(String(r.data.failed[0].reason)).toMatch(/can't be deleted/i);
    expect(ids()).toContain("self-1");
  });

  it("reports a partial batch as 207 — the ones that worked are really gone", async () => {
    const r = await h.api("POST", "/api/profiles/bulk-delete", { ids: ["bob-1", "self-1", "ghost-9"] });

    expect(r.status).toBe(207);
    expect(r.data.success).toBe(false);
    expect(r.data.deleted.map((d: any) => d.id)).toEqual(["bob-1"]);
    expect(r.data.failed.map((f: any) => f.id).sort()).toEqual(["ghost-9", "self-1"]);
    expect(ids()).toEqual(expect.arrayContaining(["self-1", "jane-1"]));
    expect(ids()).not.toContain("bob-1");
    // Jane is untouched: a batch must not over-reach past the ids it was given.
    expect(h.db.expenses.map((e: any) => e.id)).toEqual(["exp-jane"]);
  });

  it("deduplicates repeated ids instead of double-deleting", async () => {
    const r = await h.api("POST", "/api/profiles/bulk-delete", { ids: ["bob-1", "bob-1"] });
    expect(r.status).toBe(200);
    expect(r.data.deleted).toHaveLength(1);
  });

  it("rejects an empty or malformed id list", async () => {
    for (const body of [{}, { ids: [] }, { ids: "bob-1" }, { ids: [null, 3] }]) {
      const r = await h.api("POST", "/api/profiles/bulk-delete", body);
      expect(r.status).toBe(400);
    }
    // Nothing was touched by any of the rejected calls.
    expect(ids()).toHaveLength(4);
  });

  it("caps the batch size", async () => {
    const r = await h.api("POST", "/api/profiles/bulk-delete", {
      ids: Array.from({ length: 101 }, (_, i) => `p-${i}`),
    });
    expect(r.status).toBe(400);
    expect(String(r.data.error)).toMatch(/max 100/i);
  });
});
