// "Add my car Civic …C" renamed the person's existing "Civic …M" to "…C" and
// replied that the new car was saved (equivalence.asset-ownership, preview
// 933548e, 2026-11-28): one car overwritten, none added. Drives the REAL
// dispatcher with the call the model made.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renameIsReallyAnAdd } from "../shared/rename-intent";

const SELF = { id: "p-self", name: "Tester", type: "self", fields: {}, tags: [], notes: "" };
const db = { profiles: [] as any[], updates: [] as any[] };

vi.mock("../server/storage", () => ({
  storage: {
    getProfiles: async () => db.profiles,
    getProfile: async (id: string) => db.profiles.find((p) => p.id === id),
    updateProfile: async (id: string, patch: any) => { db.updates.push({ id, patch }); const p = db.profiles.find((x) => x.id === id); Object.assign(p, patch); return p; },
    mutateProfileFields: async (id: string, fn: any) => { db.updates.push({ id, fn: true }); return db.profiles.find((x) => x.id === id); },
    getPreference: async () => null,
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  db.updates = [];
  db.profiles = [SELF, { id: "car-m", name: "Civic IGL39077M", type: "vehicle", fields: { purchasePrice: 28000, currentValue: 20000 }, tags: [], notes: "" }];
  ({ executeTool } = await import("../server/ai-engine"));
});

const MSG = "Add my car \"Civic IGL39077C\": I bought it for $28,000 on September 17, 2024 and it's worth $20,000 now.";

describe("update_profile does not turn one record into another the user is adding", () => {
  it("renaming Civic …M to …C for an 'Add my car …C' message is refused and writes nothing", async () => {
    const res = await executeTool("update_profile", {
      name: "Civic IGL39077M",
      changes: { name: "Civic IGL39077C", fields: { purchasePrice: 28000, currentValue: 20000, purchaseDate: "2024-09-17" } },
      __userMessage: MSG,
    }, "u1");
    expect(res.error).toMatch(/NOT_A_RENAME/);
    expect(res.error).toMatch(/create_profile/);
    expect(db.updates).toEqual([]);
    expect(db.profiles.find((p) => p.id === "car-m").name).toBe("Civic IGL39077M");
  });
  it("the not-found answer no longer offers a near name as the record to change", async () => {
    const res = await executeTool("update_profile", { name: "Civic IGL39077C", changes: { fields: { currentValue: 1 } }, __userMessage: MSG }, "u1");
    expect(res.error).toMatch(/DIFFERENT records/);
    expect(res.error).toMatch(/use create_profile/);
    expect(db.updates).toEqual([]);
  });
});

describe("renameIsReallyAnAdd", () => {
  it("an add that never names the old record is an add", () => {
    expect(renameIsReallyAnAdd(MSG, "Civic IGL39077M", "Civic IGL39077C")).toBe(true);
  });
  it("a real rename stays a rename", () => {
    expect(renameIsReallyAnAdd("Rename Bob QA to Bob Robertson", "Bob QA", "Bob Robertson")).toBe(false);
    expect(renameIsReallyAnAdd("my Civic is actually called Civic Sport", "Civic", "Civic Sport")).toBe(false);
    expect(renameIsReallyAnAdd("Change the Honda's name to Blue Honda and add a note", "Honda", "Blue Honda")).toBe(false);
    expect(renameIsReallyAnAdd("I spelled it wrong, it's Corolla not Corola", "Corola", "Corolla")).toBe(false);
  });
  it("a message naming the old record is not refused", () => {
    expect(renameIsReallyAnAdd("Add the trim to Civic M: it's the Civic M Sport", "Civic M", "Civic M Sport")).toBe(false);
  });
  it("no message (an internal call) is not refused", () => {
    expect(renameIsReallyAnAdd(undefined, "A", "B")).toBe(false);
  });
});
