// Entity resolution — the DATABASE decides existence, not the model.
//
// THE REPORT (2026-08-17). The dashboard showed a habit "Clean my room".
//   "Mark Clean my room done"       → "Couldn't find a TASK called …"
//   "Mark habit clean my room done" → "No habit called … found"
// The record was healthy: id 3bf2af41…, deleted_at null, linked to the user's
// own self profile. What failed was the ROUTE — `complete_task` reported
// absence without ever asking whether a habit of that name existed, and the
// model relayed that as fact.
//
// These tests pin the seeded scenario the user asked for:
//   Habit: Clean my room · Task: Buy groceries · Habit: Bathroom Visit (2/day)
// and the rules that must hold for EVERY actionable entity, not just habits.

import { describe, it, expect } from "vitest";
import {
  explicitKind, rankByName, sameEntityName, pickResolution, ACTIONABLE_KINDS,
} from "../shared/entity-resolution";
import { resolveActionable, ofKind, crossKindHint } from "../server/entity-resolver";

// ── The seed, mirroring the real rows ───────────────────────────────────────
const SELF = { id: "p-self", name: "robert sennabaum", type: "self" };
const PET = { id: "p-pet", name: "Rex", type: "pet" };

const HABITS = [
  { id: "h-clean", name: "Clean my room", linkedProfiles: [SELF.id], targetPerDay: 1 },
  { id: "h-bath", name: "Bathroom Visit", linkedProfiles: [SELF.id], targetPerDay: 2 },
  { id: "h-run", name: "Daily run", linkedProfiles: [], targetPerDay: 1 },     // orphan
  { id: "h-rex", name: "Go to the bathroom 3x daily", linkedProfiles: [PET.id], targetPerDay: 1 },
];
const TASKS = [
  { id: "t-groc", title: "Buy groceries", status: "open", linkedProfiles: [SELF.id] },
  { id: "t-done", title: "Old finished thing", status: "done", linkedProfiles: [SELF.id] },
];
const GOALS = [{ id: "g-1", title: "Save $5000", status: "active", linkedProfiles: [SELF.id] }];
const EVENTS = [{ id: "e-1", title: "Dentist Appointment", completed: false, linkedProfiles: [SELF.id] }];

const storage = {
  getHabits: async () => HABITS,
  getTasks: async () => TASKS,
  getGoals: async () => GOALS,
  getEvents: async () => EVENTS,
  getProfiles: async () => [SELF, PET],
};

// ─────────────────────────────────────────────────────────────────────────────
describe("normalization: one record, however it is typed", () => {
  it("resolves every casing and phrasing of the same name", () => {
    for (const q of [
      "Clean my room", "clean my room", "CLEAN MY ROOM", "  Clean My Room  ",
      "clean my room!", "Clean-my-room",
      // Command wrappers the model may pass through verbatim.
      "mark clean my room done", "complete clean my room",
      "I finished cleaning my room",
    ]) {
      const hits = rankByName(HABITS, q, h => h.name);
      expect(hits[0]?.id, `query: ${q}`).toBe("h-clean");
    }
  });

  it("does not match unrelated records that merely share a word", () => {
    // "Buy groceries" must not resolve from "buy a car".
    expect(rankByName(TASKS, "buy a car", t => t.title).map(t => t.id)).not.toContain("t-groc");
  });

  it("sameEntityName ignores case and punctuation", () => {
    expect(sameEntityName("Clean my room", "  clean-my-room ")).toBe(true);
    expect(sameEntityName("Clean my room", "Clean my house")).toBe(false);
  });
});

describe("explicit kind is a hard constraint in both directions", () => {
  it("detects the word the user actually said", () => {
    expect(explicitKind("Mark habit clean my room done")).toBe("habit");
    expect(explicitKind("mark task buy groceries done")).toBe("task");
    expect(explicitKind("complete my goal Save $5000")).toBe("goal");
    expect(explicitKind("mark the dentist appointment done")).toBe("event");
    // No kind word → search everything.
    expect(explicitKind("Mark Clean my room done")).toBeNull();
  });

  it("searching with an explicit kind never returns another kind", async () => {
    const res = await resolveActionable(storage, {
      name: "Buy groceries", userMessage: "mark habit buy groceries done",
    });
    expect(res.explicit).toBe("habit");
    expect(res.searched).toEqual(["habit"]);
    // THE guard the user called out: saying "habit" must not touch the task.
    expect(ofKind(res, "task")).toHaveLength(0);
    expect(res.candidates).toHaveLength(0);
  });
});

describe("THE reported case", () => {
  it('"Mark Clean my room done" resolves the HABIT, with no task of that name', async () => {
    const res = await resolveActionable(storage, {
      name: "Clean my room", userMessage: "Mark Clean my room done",
    });
    // Every actionable type was consulted before any conclusion.
    expect(res.searched.sort()).toEqual([...ACTIONABLE_KINDS].sort());
    expect(ofKind(res, "task")).toHaveLength(0);
    const habits = ofKind(res, "habit");
    expect(habits).toHaveLength(1);
    expect(habits[0].id).toBe("h-clean");
    // Exactly one match overall → an unambiguous pick.
    expect(pickResolution(res).pick?.id).toBe("h-clean");
  });

  it('"Mark habit clean my room done" resolves the same record', async () => {
    const res = await resolveActionable(storage, {
      name: "clean my room", userMessage: "Mark habit clean my room done",
    });
    expect(res.explicit).toBe("habit");
    expect(pickResolution(res).pick?.id).toBe("h-clean");
  });

  it("tells the task tool that the name belongs to a habit", async () => {
    const res = await resolveActionable(storage, {
      name: "Clean my room", userMessage: "Mark Clean my room done",
    });
    const hint = crossKindHint(res, "task");
    expect(hint).toContain("habit");
    expect(hint).toContain("Clean my room");
  });

  it("only reports absence when NOTHING of any kind matches", async () => {
    const res = await resolveActionable(storage, {
      name: "Wash the dragon", userMessage: "mark wash the dragon done",
    });
    expect(res.candidates).toHaveLength(0);
    expect(crossKindHint(res, "task")).toBeNull();
    // …and it says which types it checked, so a caller can be honest about it.
    expect(res.searched.sort()).toEqual([...ACTIONABLE_KINDS].sort());
  });
});

describe("cross-type routing works in both directions", () => {
  it('"mark buy groceries done" resolves the TASK', async () => {
    const res = await resolveActionable(storage, {
      name: "Buy groceries", userMessage: "mark buy groceries done",
    });
    expect(ofKind(res, "habit")).toHaveLength(0);
    expect(pickResolution(res).pick?.kind).toBe("task");
    expect(pickResolution(res).pick?.id).toBe("t-groc");
  });

  it("tells the habit tool that the name belongs to a task", async () => {
    const res = await resolveActionable(storage, {
      name: "Buy groceries", userMessage: "mark buy groceries done",
    });
    expect(crossKindHint(res, "habit")).toContain("task");
  });

  it("resolves goals and events too — not just tasks and habits", async () => {
    const g = await resolveActionable(storage, { name: "Save $5000", userMessage: "mark save $5000 done" });
    expect(pickResolution(g).pick?.kind).toBe("goal");
    const e = await resolveActionable(storage, { name: "Dentist Appointment", userMessage: "mark dentist appointment done" });
    expect(pickResolution(e).pick?.kind).toBe("event");
  });
});

describe("ownership: chat sees exactly what the dashboard sees", () => {
  it("includes orphans (no linked profile) — they belong to me", async () => {
    const res = await resolveActionable(storage, { name: "Daily run", userMessage: "mark daily run done" });
    expect(pickResolution(res).pick?.id).toBe("h-run");
  });

  it("does NOT reach another profile's habit on an unqualified message", async () => {
    const res = await resolveActionable(storage, {
      name: "Go to the bathroom 3x daily", userMessage: "mark go to the bathroom done",
    });
    expect(res.candidates.map(c => c.id)).not.toContain("h-rex");
  });

  it("reaches it when the user names that profile", async () => {
    const res = await resolveActionable(storage, {
      name: "Go to the bathroom 3x daily", userMessage: "mark Rex's bathroom habit done", forProfile: "Rex",
    });
    expect(res.candidates.map(c => c.id)).toContain("h-rex");
  });

  it("finds records under EVERY self profile, not just the first", async () => {
    // An account that ended up with two self rows had half its habits
    // invisible to chat while the dashboard showed them all.
    const twoSelves = {
      ...storage,
      getProfiles: async () => [SELF, { id: "p-self-2", name: "Bob", type: "self" }],
      getHabits: async () => [{ id: "h-2", name: "Stretch", linkedProfiles: ["p-self-2"], targetPerDay: 1 }],
    };
    const res = await resolveActionable(twoSelves, { name: "Stretch", userMessage: "mark stretch done" });
    expect(pickResolution(res).pick?.id).toBe("h-2");
  });

  it("excludes an already-completed task from a completion command", async () => {
    const res = await resolveActionable(storage, {
      name: "Old finished thing", userMessage: "mark old finished thing done",
    });
    expect(res.candidates).toHaveLength(0);
  });
});

describe("a mutation never guesses between two records of the same name", () => {
  it("returns ambiguity rather than picking one", async () => {
    const dupes = {
      ...storage,
      getHabits: async () => [
        { id: "h-a", name: "Walk", linkedProfiles: [SELF.id], targetPerDay: 1 },
        { id: "h-b", name: "Walk", linkedProfiles: [SELF.id], targetPerDay: 1 },
      ],
      getTasks: async () => [],
      getGoals: async () => [],
      getEvents: async () => [],
    };
    const res = await resolveActionable(dupes, { name: "Walk", userMessage: "mark walk done" });
    const picked = pickResolution(res);
    expect(picked.pick).toBeUndefined();
    expect(picked.ambiguous?.length).toBe(2);
  });
});

// D123 — "mark Linda's loan paperwork done": the task is linked to the loan
// Linda half-owns, not to Linda, so the person scope missed it.
describe("D123: a named person's scope reaches records of assets and loans they co-own", () => {
  const profiles = [
    { id: "self-1", type: "self", name: "Me" },
    { id: "linda-1", type: "person", name: "Linda" },
    { id: "car-1", type: "vehicle", name: "Honda", parentProfileId: "self-1" },
    { id: "loan-1", type: "liability", name: "Car loan", parentProfileId: "self-1" },
  ];
  const rows = [
    { id: "t-loan", title: "Loan paperwork", status: "todo", linkedProfiles: ["loan-1"] },
    { id: "t-car", title: "Oil change", status: "todo", linkedProfiles: ["car-1"] },
    { id: "t-self", title: "Loan paperwork", status: "todo", linkedProfiles: ["self-1"] },
  ];
  const linkedStorage = {
    getHabits: async () => [], getTasks: async () => rows, getProfiles: async () => profiles,
    getAssetPartyLinks: async () => [{ assetProfileId: "car-1", partyProfileId: "linda-1" }],
    getLiabilityProfileLinks: async () => [{ liabilityProfileId: "loan-1", partyProfileId: "linda-1" }],
  };
  it("resolves the loan's task and the car's task for Linda, never Self's own", async () => {
    const loan = await resolveActionable(linkedStorage, { name: "Loan paperwork", forProfile: "Linda" });
    expect(loan.candidates.map((c) => c.id)).toEqual(["t-loan"]);
    const car = await resolveActionable(linkedStorage, { name: "Oil change", forProfile: "Linda" });
    expect(car.candidates.map((c) => c.id)).toEqual(["t-car"]);
  });
  it("without the link tables Linda's scope stays empty", async () => {
    const bare = { getHabits: async () => [], getTasks: async () => rows, getProfiles: async () => profiles };
    const res = await resolveActionable(bare, { name: "Loan paperwork", forProfile: "Linda" });
    expect(res.candidates).toHaveLength(0);
  });
});
