// Deleting a person or a pet from the Info tab.
//
// The rule (shared/profile-delete.ts) and the door (DELETE /api/profiles/:id).
// The screen shows the same sentence the route refuses with, so both are
// proved here rather than trusting the button to have asked nicely.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkProfileDelete, profileDeleteWarning } from "../shared/profile-delete";
import { startHarness, type Harness } from "./helpers/route-harness";

describe("checkProfileDelete", () => {
  it("allows a person", () => {
    expect(checkProfileDelete({ type: "person", name: "Bob QA" }).status).toBe("ok");
  });

  it("allows a pet", () => {
    expect(checkProfileDelete({ type: "pet", name: "Rex" }).status).toBe("ok");
  });

  it("refuses the self profile, with a reason worth showing", () => {
    const r = checkProfileDelete({ type: "self", name: "Me" });
    expect(r.status).toBe("rejected");
    expect(r.status === "rejected" && r.error).toMatch(/your own profile/i);
  });

  it("refuses a self profile whatever the casing or padding", () => {
    expect(checkProfileDelete({ type: " SELF " }).status).toBe("rejected");
  });

  it("refuses a profile that isn't there", () => {
    expect(checkProfileDelete(null).status).toBe("rejected");
    expect(checkProfileDelete(undefined).status).toBe("rejected");
  });

  it("names the profile in the warning, and says what survives", () => {
    const w = profileDeleteWarning("Bob QA");
    expect(w).toContain("Bob QA");
    expect(w).toMatch(/cannot be undone/i);
    expect(w).toMatch(/shared/i);
  });

  it("falls back to a generic subject when there is no name", () => {
    expect(profileDeleteWarning("  ")).toContain("this profile");
  });
});

const seed = () => [
  { id: "self-1", type: "self", name: "Test", fields: {} },
  { id: "bob-1", type: "person", name: "Bob QA", fields: { phone: "555-0100" } },
  { id: "rex-1", type: "pet", name: "Rex", fields: {} },
];

let h: Harness;
beforeEach(async () => {
  h = await startHarness({
    profiles: seed(),
    expenses: [
      { id: "exp-solo", amount: 10, linkedProfiles: ["bob-1"] },
      { id: "exp-shared", amount: 20, linkedProfiles: ["bob-1", "self-1"] },
    ],
  });
});
afterEach(async () => { await h.close(); });

describe("DELETE /api/profiles/:id", () => {
  it("deletes a person", async () => {
    const r = await h.api("DELETE", "/api/profiles/bob-1");
    expect(r.status).toBe(200);
    expect(h.db.profiles.find((p: any) => p.id === "bob-1")).toBeUndefined();
  });

  it("deletes a pet", async () => {
    const r = await h.api("DELETE", "/api/profiles/rex-1");
    expect(r.status).toBe(200);
    expect(h.db.profiles.find((p: any) => p.id === "rex-1")).toBeUndefined();
  });

  it("takes the data the profile solely owned with it", async () => {
    await h.api("DELETE", "/api/profiles/bob-1");
    expect(h.db.expenses.find((e: any) => e.id === "exp-solo")).toBeUndefined();
  });

  it("keeps a co-owned row and only drops the deleted owner from it", async () => {
    await h.api("DELETE", "/api/profiles/bob-1");
    const shared = h.db.expenses.find((e: any) => e.id === "exp-shared");
    expect(shared).toBeDefined();
    expect(shared.linkedProfiles).toEqual(["self-1"]);
  });

  it("refuses the self profile and keeps every row", async () => {
    const r = await h.api("DELETE", "/api/profiles/self-1");
    expect(r.status).toBe(400);
    expect(String(r.data?.error)).toMatch(/your own profile/i);
    expect(h.db.profiles.find((p: any) => p.id === "self-1")).toBeDefined();
    expect(h.db.expenses).toHaveLength(2);
  });

  it("404s a profile that does not exist", async () => {
    const r = await h.api("DELETE", "/api/profiles/nope-1");
    expect(r.status).toBe(404);
  });
});
