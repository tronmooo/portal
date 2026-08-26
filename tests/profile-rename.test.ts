// Renaming a profile — the write itself, and the guard that used to refuse it.
//
// User report 2026-08-25: "Rename Bob QA to Bob Robertson" answered "Done —
// Bob QA renamed to Bob Robertson" while the profile page kept saying Bob QA.
// Three separate defects met on that screen:
//
//   1. `update_profile` had no rename branch at all — a changes.name arrived,
//      fell through the fields/notes/tags merge, and was dropped. The reply
//      was a lie about the user's data.
//   2. Confirming a rename ("confirm") was blocked as a stale replay, because
//      the name being written appeared only in the EARLIER message. The
//      assistant had asked the question itself.
//   3. Nothing propagated, because nothing was written.
//
// These drive the real executeTool dispatcher, the real routing guard and the
// shared rule the manual UI shares with them.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkProfileRename, cleanProfileName, renameOwnerInTitle } from "../shared/profile-rename";
import { isStaleTurnReplay } from "../shared/ai-tool-routing";
import { isBareConfirmation, hasBackReference } from "../shared/ai-intent";
import { finalizeToolResult, buildTurnVerifyContext, buildChatMutation } from "../server/ai-envelope";

type Row = { id: string; name: string; type: string; fields: Record<string, any>; notes?: string; tags?: string[] };

const db: { profiles: Row[] } = { profiles: [] };

function reseed() {
  db.profiles = [
    { id: "p-self", name: "Robert", type: "self", fields: {} },
    { id: "p-bob", name: "Bob QA", type: "person", fields: { shoeSize: "12" } },
    { id: "p-jane", name: "Jane Doe", type: "person", fields: {} },
  ];
}

vi.mock("../server/storage", () => ({
  storage: {
    getProfiles: async () => db.profiles,
    getProfile: async (id: string) => db.profiles.find(p => p.id === id),
    getHabits: async () => [], getTasks: async () => [], getGoals: async () => [],
    getEvents: async () => [], getTrackers: async () => [], getExpenses: async () => [],
    getObligations: async () => [], getMemories: async () => [], getDocuments: async () => [],
    getJournalEntries: async () => [],
    wouldCreateCycle: async () => false,
    updateProfile: async (id: string, patch: any) => {
      const p = db.profiles.find(x => x.id === id);
      if (!p) return undefined;
      Object.assign(p, patch);
      return p;
    },
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  ({ executeTool } = await import("../server/ai-engine"));
});

const bob = () => db.profiles.find(p => p.id === "p-bob")!;

describe("update_profile renames the record", () => {
  it("writes the new name to the profile row — the reported failure", async () => {
    const res = await executeTool("update_profile", {
      name: "Bob QA",
      changes: { name: "Bob Robertson" },
    });
    expect(res.error).toBeUndefined();
    expect(bob().name).toBe("Bob Robertson");
    expect(res.name).toBe("Bob Robertson");
  });

  it("renames the SAME row — never creates a second profile", async () => {
    await executeTool("update_profile", { name: "Bob QA", changes: { name: "Bob Robertson" } });
    expect(db.profiles).toHaveLength(3);
    expect(db.profiles.filter(p => /^Bob/.test(p.name))).toHaveLength(1);
  });

  it("keeps everything else on the record — a rename is not a reset", async () => {
    await executeTool("update_profile", { name: "Bob QA", changes: { name: "Bob Robertson" } });
    expect(bob().fields.shoeSize).toBe("12");
    expect(bob().type).toBe("person");
  });

  it("renames and edits fields in one call", async () => {
    await executeTool("update_profile", {
      name: "Bob QA",
      changes: { name: "Bob Robertson", fields: { phone: "555-0101" } },
    });
    expect(bob().name).toBe("Bob Robertson");
    expect(bob().fields.phone).toBe("555-0101");
  });

  it("reports the rename so the card and the caches can follow it", async () => {
    const res = await executeTool("update_profile", { name: "Bob QA", changes: { name: "Bob Robertson" } });
    expect(res._renamed).toEqual({ from: "Bob QA", to: "Bob Robertson" });
    expect(res._displayData.name).toBe("Bob Robertson");
  });

  it("records the old name so Revert can put it back", async () => {
    const res = await executeTool("update_profile", { name: "Bob QA", changes: { name: "Bob Robertson" } });
    expect(res._previousState.name).toBe("Bob QA");
    expect(res._previousState.profileId).toBe("p-bob");
  });

  it("refuses a name another profile already answers to", async () => {
    const res = await executeTool("update_profile", { name: "Bob QA", changes: { name: "Jane Doe" } });
    expect(res.error).toMatch(/already named/i);
    expect(bob().name).toBe("Bob QA");
  });

  it("refuses an empty name", async () => {
    const res = await executeTool("update_profile", { name: "Bob QA", changes: { name: "   " } });
    expect(res.error).toBeTruthy();
    expect(bob().name).toBe("Bob QA");
  });

  it("a no-op rename to the same name is not an error", async () => {
    const res = await executeTool("update_profile", { name: "Bob QA", changes: { name: "bob qa" } });
    expect(res.error).toBeUndefined();
    expect(bob().name).toBe("Bob QA");
  });

  it("a field-only update still leaves the name alone", async () => {
    await executeTool("update_profile", { name: "Bob QA", changes: { fields: { phone: "555-0102" } } });
    expect(bob().name).toBe("Bob QA");
    expect(bob().fields.phone).toBe("555-0102");
  });
});

describe("the rename rule is the same for the manual door", () => {
  const profiles = [
    { id: "p-bob", name: "Bob QA" },
    { id: "p-jane", name: "Jane Doe" },
  ];

  it("accepts a free name", () => {
    expect(checkProfileRename(profiles, "p-bob", " Bob  Robertson ", "Bob QA"))
      .toEqual({ status: "ok", name: "Bob Robertson" });
  });

  it("reports a collision in words a user can act on", () => {
    const res = checkProfileRename(profiles, "p-bob", "jane doe", "Bob QA");
    expect(res.status).toBe("rejected");
    expect(res.status === "rejected" && res.error).toMatch(/Jane Doe/);
  });

  it("calls a same-name write what it is: unchanged", () => {
    expect(checkProfileRename(profiles, "p-bob", "Bob QA", "Bob QA").status).toBe("unchanged");
  });

  it("collapses whitespace rather than storing it", () => {
    expect(cleanProfileName("  Bob   Robertson\n")).toBe("Bob Robertson");
  });
});

describe("confirming a request is not replaying it", () => {
  // The assistant asks "rename Bob QA to Bob Robertson?" and the user answers.
  const HISTORY = ["Change bob's name to Bob Robertson"];
  const RENAME = { name: "Bob QA", changes: { name: "Bob Robertson" } };

  it('"confirm" lets the rename through — the reported dead end', () => {
    expect(isStaleTurnReplay(RENAME, "confirm", HISTORY)).toBe(false);
  });

  it("every ordinary way of saying yes works the same", () => {
    for (const yes of ["yes", "Yes.", "yep", "yes please", "go ahead", "do it", "sure", "confirmed", "sounds good", "correct", "OK"]) {
      expect(isStaleTurnReplay(RENAME, yes, HISTORY), yes).toBe(false);
      expect(isBareConfirmation(yes), yes).toBe(true);
      expect(hasBackReference(yes), yes).toBe(true);
    }
  });

  it("still blocks a genuine replay — a new request is not a confirmation", () => {
    // "Create a habit to walk the dog" two messages ago; this message is about
    // something else entirely, so re-running the habit IS replay.
    expect(isStaleTurnReplay(
      { name: "Walk the Dog" },
      "Create an asset for my Dodge Ram 2025",
      ["Create a habit to walk the dog"],
    )).toBe(true);
  });

  it("a yes that also carries new work is not a bare confirmation", () => {
    expect(isBareConfirmation("yes, and also add a task to call the vet")).toBe(false);
  });
});

describe("a rename reaches every screen that shows the name", () => {
  const renamed = { id: "p-bob", name: "Bob Robertson", type: "person", _renamed: { from: "Bob QA", to: "Bob Robertson" } };

  it("refreshes everything, not just the profile queries", () => {
    const mutation = buildChatMutation("update_profile", { entity: { type: "profile", id: "p-bob" }, ...renamed }, renamed);
    expect(mutation?.domains).toEqual(["everything"]);
  });

  it("an ordinary field update still refreshes only what it touched", () => {
    const row = { id: "p-bob", name: "Bob QA", type: "person" };
    const mutation = buildChatMutation("update_profile", { entity: { type: "profile", id: "p-bob" }, ...row }, row);
    expect(mutation?.domains).not.toContain("everything");
    expect(mutation?.domains).toContain("profiles");
  });

  it("keeps the rename marker out of the row written into the caches", () => {
    const mutation = buildChatMutation("update_profile", { entity: { type: "profile", id: "p-bob" }, ...renamed }, renamed);
    expect(mutation?.row?.name).toBe("Bob Robertson");
    expect(mutation?.row).not.toHaveProperty("_renamed");
  });

  it("does not report a rename as having landed on the wrong record", async () => {
    // The request names the OLD name on purpose; the read-back says the new
    // one. That is the rename working, not a misdirected write.
    const ctx = buildTurnVerifyContext({
      getProfiles: async () => [{ id: "p-bob", type: "person", name: "Bob Robertson" }],
    } as any);
    const env = await finalizeToolResult(
      "update_profile",
      "update_profile",
      { name: "Bob QA", changes: { name: "Bob Robertson" } },
      { id: "p-bob", name: "Bob Robertson" },
      ctx,
    );
    expect(env.success).toBe(true);
    expect(env.verification.requested_name_matches).toBe(true);
  });
});

// ── Titles the app generated from the old name ───────────────────────────────
//
// Found by sweeping the live database for a renamed profile's old name, not by
// reading the code — which is exactly why the first version of this rename
// shipped claiming to reach everywhere. Three real rows came back:
//
//   habits.name  "Morning Run - Bob QA", "Daily Walk - Bob QA"
//   events.title "🎂 Bob QA's Birthday"
//
// all linked to the profile by id. For trackers it is worse than stale: the
// read path hides a trailing owner suffix by matching the owner's CURRENT
// name, so renaming stops the match and the old name REAPPEARS on screen.

describe("renameOwnerInTitle rewrites generated labels only", () => {
  const from = "Bob QA", to = "Bob Robertson";

  it("rewrites a trailing owner suffix", () => {
    expect(renameOwnerInTitle("Morning Run - Bob QA", from, to)).toBe("Morning Run - Bob Robertson");
    expect(renameOwnerInTitle("Daily Walk — Bob QA", from, to)).toBe("Daily Walk — Bob Robertson");
  });

  it("rewrites a possessive title, emoji and all", () => {
    expect(renameOwnerInTitle("🎂 Bob QA's Birthday", from, to)).toBe("🎂 Bob Robertson's Birthday");
    expect(renameOwnerInTitle("Bob QA’s Checkup", from, to)).toBe("Bob Robertson’s Checkup");
  });

  it("leaves prose that merely mentions the person alone", () => {
    // A journal entry, a note, a task the user titled themselves.
    expect(renameOwnerInTitle("Dinner with Bob QA's family", from, to)).toBe("Dinner with Bob QA's family");
    expect(renameOwnerInTitle("Call Bob QA about the car", from, to)).toBe("Call Bob QA about the car");
  });

  it("leaves a separator that isn't an owner", () => {
    expect(renameOwnerInTitle("Blood Pressure - Morning", from, to)).toBe("Blood Pressure - Morning");
  });

  it("never fires on a one-character owner token", () => {
    expect(renameOwnerInTitle("Run - B", "B", "Robert")).toBe("Run - B");
  });
});

describe("the cascade touches only this profile's generated titles", () => {
  it("rewrites linked habits, trackers and events — and nothing else", async () => {
    const { cascadeProfileRename } = await import("../server/profile-rename-cascade");
    const rows = {
      habits: [
        { id: "h1", name: "Morning Run - Bob QA", linkedProfiles: ["p-bob"] },
        // Same title, someone else's habit: not this rename's business.
        { id: "h2", name: "Morning Run - Bob QA", linkedProfiles: ["p-jane"] },
      ],
      trackers: [{ id: "t1", name: "Weight - Bob QA", linkedProfiles: ["p-bob"] }],
      events: [
        { id: "e1", title: "🎂 Bob QA's Birthday", linkedProfiles: ["p-bob"] },
        { id: "e2", title: "Dinner with Bob QA's family", linkedProfiles: ["p-bob"] },
      ],
      tasks: [{ id: "k1", title: "Call Bob QA about the car", linkedProfiles: ["p-bob"] }],
    };
    const writes: Array<[string, string, any]> = [];
    const fake: any = {
      getHabits: async () => rows.habits, getTrackers: async () => rows.trackers,
      getEvents: async () => rows.events, getTasks: async () => rows.tasks,
      updateHabit: async (id: string, p: any) => writes.push(["habit", id, p]),
      updateTracker: async (id: string, p: any) => writes.push(["tracker", id, p]),
      updateEvent: async (id: string, p: any) => writes.push(["event", id, p]),
      updateTask: async (id: string, p: any) => writes.push(["task", id, p]),
    };

    const res = await cascadeProfileRename(fake, "p-bob", "Bob QA", "Bob Robertson");

    expect(res.updated).toEqual({ habits: 1, trackers: 1, events: 1, tasks: 0 });
    expect(writes).toEqual([
      ["habit", "h1", { name: "Morning Run - Bob Robertson" }],
      ["tracker", "t1", { name: "Weight - Bob Robertson" }],
      ["event", "e1", { title: "🎂 Bob Robertson's Birthday" }],
    ]);
  });

  it("a failed title write never fails the rename", async () => {
    const { cascadeProfileRename } = await import("../server/profile-rename-cascade");
    const fake: any = {
      getHabits: async () => [{ id: "h1", name: "Run - Bob QA", linkedProfiles: ["p-bob"] }],
      updateHabit: async () => { throw new Error("db down"); },
      getTrackers: async () => { throw new Error("db down"); },
      updateTracker: async () => {},
      getEvents: async () => [], updateEvent: async () => {},
      getTasks: async () => [], updateTask: async () => {},
    };
    const res = await cascadeProfileRename(fake, "p-bob", "Bob QA", "Bob Robertson");
    expect(res.failed).toBe(1);
    expect(res.updated.habits).toBe(0);
  });
});
