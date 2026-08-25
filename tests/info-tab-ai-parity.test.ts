// Everything the Info tab can edit, chat can edit too — and the reverse.
//
// The tab and the assistant are two doors onto the same records, and they have
// drifted apart in both directions:
//
//   · chat could re-type a profile and rename it in the schema's imagination,
//     while the executor dropped the name entirely (2026-08-25);
//   · the tab could DELETE a profile field from the day the X button shipped,
//     and chat had no tool for it at all — the model's only move was to write
//     an empty string, which leaves an empty row on the very screen the user
//     asked to clear.
//
// This drives the real executeTool dispatcher over each surface the Info tab
// renders, so a door that stops working is a failing test rather than a
// support report.

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = { id: string; name: string; type: string; fields: Record<string, any>; notes?: string; tags?: string[] };

const db: { profiles: Row[]; memories: any[] } = { profiles: [], memories: [] };

function reseed() {
  db.profiles = [
    { id: "p-self", name: "Robert", type: "self", fields: {}, notes: "", tags: [] },
    {
      id: "p-bob",
      name: "Bob QA",
      type: "person",
      fields: { phone: "555-0100", identity: { licenseNumber: "D1234567" } },
      notes: "Free-text scratchpad.",
      tags: ["household"],
    },
    { id: "p-truck", name: "The Beast", type: "person", fields: {}, notes: "", tags: [] },
  ];
  db.memories = [{ id: "m1", key: "coffee", value: "black, no sugar" }];
}

// deleteProfileFields is the storage layer's identity sweep; the double uses
// the real one so "delete licenseNumber" behaves here as it does in Postgres.
vi.mock("../server/storage", async () => {
  const { deleteProfileFields } = await import("../shared/profile-field-identity");
  return {
    storage: {
      getProfiles: async () => db.profiles,
      getProfile: async (id: string) => db.profiles.find(p => p.id === id),
      getHabits: async () => [], getTasks: async () => [], getGoals: async () => [],
      getEvents: async () => [], getTrackers: async () => [], getExpenses: async () => [],
      getObligations: async () => [], getDocuments: async () => [], getJournalEntries: async () => [],
      getMemories: async () => db.memories,
      wouldCreateCycle: async () => false,
      updateProfile: async (id: string, patch: any) => {
        const p = db.profiles.find(x => x.id === id);
        if (!p) return undefined;
        const { fieldsToDelete, fieldPathsToDelete, ...rest } = patch;
        Object.assign(p, rest);
        if (fieldsToDelete?.length) {
          p.fields = deleteProfileFields(p.fields, fieldsToDelete).fields;
        }
        return p;
      },
      updateMemory: async (id: string, patch: any) => {
        const m = db.memories.find(x => x.id === id);
        if (!m) return undefined;
        Object.assign(m, patch);
        return m;
      },
      deleteMemory: async (id: string) => {
        const before = db.memories.length;
        db.memories = db.memories.filter(m => m.id !== id);
        return db.memories.length < before;
      },
    },
  };
});

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  ({ executeTool } = await import("../server/ai-engine"));
});

const bob = () => db.profiles.find(p => p.id === "p-bob")!;

describe("chat can change every identity surface the Info tab shows", () => {
  it("the NAME — header rename", async () => {
    await executeTool("update_profile", { name: "Bob QA", changes: { name: "Bob Robertson" } });
    expect(bob().name).toBe("Bob Robertson");
  });

  it("the TYPE — 'my truck shows up as a person'", async () => {
    const res = await executeTool("update_profile", { name: "The Beast", changes: { type: "vehicle" } });
    expect(res.error).toBeUndefined();
    expect(db.profiles.find(p => p.id === "p-truck")!.type).toBe("vehicle");
  });

  it("refuses to turn a record into the user's own profile", async () => {
    const res = await executeTool("update_profile", { name: "Bob QA", changes: { type: "self" } });
    expect(res.error).toMatch(/one 'me' profile/i);
    expect(bob().type).toBe("person");
  });

  it("refuses to demote the user's own profile", async () => {
    const res = await executeTool("update_profile", { name: "Robert", changes: { type: "person" } });
    expect(res.error).toMatch(/your own profile/i);
    expect(db.profiles.find(p => p.id === "p-self")!.type).toBe("self");
  });

  it("refuses a type that isn't one", async () => {
    const res = await executeTool("update_profile", { name: "Bob QA", changes: { type: "spaceship" } });
    expect(res.error).toMatch(/isn't a profile type/i);
  });

  it("a FIELD value — the same write the Info cell makes", async () => {
    await executeTool("update_profile", { name: "Bob QA", changes: { fields: { phone: "555-0199" } } });
    expect(bob().fields.phone).toBe("555-0199");
  });

  it("adds a field that did not exist", async () => {
    await executeTool("update_profile", { name: "Bob QA", changes: { fields: { nickname: "Bobby" } } });
    expect(bob().fields.nickname).toBe("Bobby");
  });

  it("DELETES a field — the Info tab's X, which chat had no tool for", async () => {
    const res = await executeTool("update_profile", { name: "Bob QA", changes: { removeFields: ["phone"] } });
    expect(res.error).toBeUndefined();
    expect(bob().fields.phone).toBeUndefined();
  });

  it("deletes a NESTED field by identity, twins and all", async () => {
    await executeTool("update_profile", { name: "Bob QA", changes: { removeFields: ["licenseNumber"] } });
    expect(bob().fields.identity?.licenseNumber).toBeUndefined();
  });

  it("records a deleted field's old value so Revert can restore it", async () => {
    const res = await executeTool("update_profile", { name: "Bob QA", changes: { removeFields: ["phone"] } });
    expect(res._previousState.fields.phone).toBe("555-0100");
  });

  it("edits and removes fields in one call", async () => {
    await executeTool("update_profile", {
      name: "Bob QA",
      changes: { fields: { nickname: "Bobby" }, removeFields: ["phone"] },
    });
    expect(bob().fields.nickname).toBe("Bobby");
    expect(bob().fields.phone).toBeUndefined();
  });

  it("the NOTES scratchpad", async () => {
    await executeTool("update_profile", { name: "Bob QA", changes: { notes: "Updated scratchpad." } });
    expect(bob().notes).toBe("Updated scratchpad.");
  });

  it("the TAGS", async () => {
    await executeTool("update_profile", { name: "Bob QA", changes: { tags: ["household", "vip"] } });
    expect(bob().tags).toEqual(["household", "vip"]);
  });

  it("a chat-saved FACT — the memories card", async () => {
    const res = await executeTool("update_memory", { query: "coffee", newValue: "oat milk, one sugar" });
    expect(res.error).toBeUndefined();
    expect(db.memories[0].value).toBe("oat milk, one sugar");
  });

  it("deletes a chat-saved fact", async () => {
    await executeTool("delete_memory", { query: "coffee" });
    expect(db.memories).toHaveLength(0);
  });
});

describe("the tools the Info tab's sections depend on all exist", () => {
  it("every editable surface has a named tool", async () => {
    const { TOOL_DEFINITIONS } = await import("../server/ai-engine");
    const names = new Set((TOOL_DEFINITIONS as any[]).map(t => t.name));
    // Section on the Info tab           → the tool chat uses for it
    for (const tool of [
      "update_profile",   // name, type, fields, notes, tags
      "update_note",      // a saved note's title/body
      "delete_note",
      "create_note",
      "update_memory",    // "facts from chat"
      "delete_memory",
      "manage_document",  // the documents card (rename / relink / delete)
    ]) {
      expect(names.has(tool), tool).toBe(true);
    }
  });

  it("update_profile advertises rename and field removal, so the model uses them", async () => {
    const { TOOL_DEFINITIONS } = await import("../server/ai-engine");
    const tool = (TOOL_DEFINITIONS as any[]).find(t => t.name === "update_profile");
    const props = tool.input_schema.properties;
    expect(props.removeFields).toBeTruthy();
    expect(String(props.changes.description)).toMatch(/rename/i);
  });
});
