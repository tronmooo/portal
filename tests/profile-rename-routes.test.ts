// The API door for renaming, re-typing and clearing profile fields.
//
// `profile-rename.test.ts` proves the rule and the AI tool; this drives the
// real Express app over HTTP, because the manual UI is only as safe as the
// route behind it. A screen can be talked out of a bad write; the route cannot.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startHarness, type Harness } from "./helpers/route-harness";

// Fresh rows per test: the harness stores what it is handed, and these
// handlers mutate what they store.
const seed = () => [
  { id: "self-1", type: "self", name: "Test", fields: {} },
  { id: "bob-1", type: "person", name: "Bob QA", fields: { phone: "555-0100" } },
  { id: "jane-1", type: "person", name: "Jane Doe", fields: {} },
];

let h: Harness;
beforeEach(async () => { h = await startHarness({ profiles: seed() }); });
afterEach(async () => { await h.close(); });

const bob = () => h.db.profiles.find((p: any) => p.id === "bob-1");

describe("PATCH /api/profiles/:id — rename", () => {
  it("renames the record", async () => {
    const r = await h.api("PATCH", "/api/profiles/bob-1", { name: "Bob Robertson" });
    expect(r.status).toBe(200);
    expect(bob().name).toBe("Bob Robertson");
  });

  it("trims and collapses whitespace rather than storing it", async () => {
    await h.api("PATCH", "/api/profiles/bob-1", { name: "  Bob   Robertson " });
    expect(bob().name).toBe("Bob Robertson");
  });

  it("refuses a name another profile already holds, and stores nothing", async () => {
    const r = await h.api("PATCH", "/api/profiles/bob-1", { name: "jane doe" });
    expect(r.status).toBe(409);
    expect(String(r.data?.error)).toMatch(/Jane Doe/);
    expect(bob().name).toBe("Bob QA");
  });

  it("refuses an empty name", async () => {
    const r = await h.api("PATCH", "/api/profiles/bob-1", { name: "   " });
    expect(r.status).toBe(400);
    expect(bob().name).toBe("Bob QA");
  });

  it("lets a profile keep its own name (a no-op save is not a collision)", async () => {
    const r = await h.api("PATCH", "/api/profiles/bob-1", { name: "Bob QA", notes: "hi" });
    expect(r.status).toBe(200);
    expect(bob().notes).toBe("hi");
  });
});

describe("PATCH /api/profiles/:id — type", () => {
  it("re-types a record", async () => {
    const r = await h.api("PATCH", "/api/profiles/bob-1", { type: "vehicle" });
    expect(r.status).toBe(200);
    expect(bob().type).toBe("vehicle");
  });

  it("refuses to make a second 'me'", async () => {
    const r = await h.api("PATCH", "/api/profiles/bob-1", { type: "self" });
    expect(r.status).toBe(400);
    expect(bob().type).toBe("person");
  });

  it("refuses to demote the user's own profile", async () => {
    const r = await h.api("PATCH", "/api/profiles/self-1", { type: "person" });
    expect(r.status).toBe(400);
    expect(h.db.profiles.find((p: any) => p.id === "self-1").type).toBe("self");
  });

  it("refuses a type that isn't one", async () => {
    const r = await h.api("PATCH", "/api/profiles/bob-1", { type: "spaceship" });
    expect(r.status).toBe(400);
    expect(bob().type).toBe("person");
  });
});

describe("PATCH /api/profiles/:id — clearing a field", () => {
  it("removes the field the Info tab's X names", async () => {
    const r = await h.api("PATCH", "/api/profiles/bob-1", { fieldsToDelete: ["phone"] });
    expect(r.status).toBe(200);
    expect(bob().fields?.phone).toBeUndefined();
  });
});
