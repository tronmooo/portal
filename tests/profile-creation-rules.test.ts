// Person & profile creation rules (user spec 2026-11-12).
//
// Reported: "Bob's birthday is September 30. Remind me every year for 10
// years" created a PERSON profile for Bob. A name is data, not permission to
// create an entity. These drive the REAL chat tools (executeTool) against an
// in-memory store, plus the per-turn offer collector, one case per rule:
//
//   1  explicit intent required          6  existing profile reused, no offer
//   2  original request completed        7  mentioning Bob ≠ Bob owns it
//   3  profile offered (Yes text works)  8  later profile picks up the birthday
//   4  never blocks the record           9  applies to tasks, expenses, events,
//   5  No → no placeholder, never asked     pets, providers, ownership links
//      again                            10 these tests
import { describe, it, expect, beforeEach, vi } from "vitest";
import { hasExplicitProfileCreateIntent, profileSuggestionYesText, looksLikeTypoOf } from "../shared/profile-intent";

const SELF = { id: "p-self", name: "Robert Smith", type: "self", fields: {} };
const db: any = {};
let seq = 0;
const mk = (prefix: string, data: any) => ({ id: `${prefix}${++seq}`, ...data });

function reseed() {
  db.profiles = [SELF];
  db.events = [];
  db.tasks = [];
  db.expenses = [];
  db.prefs = {} as Record<string, string>;
}

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => db.profiles,
    getProfile: async (id: string) => db.profiles.find((p: any) => p.id === id),
    getSelfProfile: async () => SELF,
    createProfile: async (data: any) => { const row = mk("prof", { fields: {}, ...data }); db.profiles.push(row); return row; },
    updateProfile: async (id: string, patch: any) => { const p = db.profiles.find((x: any) => x.id === id); Object.assign(p, patch); return p; },
    getEvents: async () => db.events,
    createEvent: async (data: any) => { const row = mk("ev", { ...data, linkedProfiles: data.linkedProfiles?.length ? data.linkedProfiles : [SELF.id] }); db.events.push(row); return row; },
    updateEvent: async (id: string, patch: any) => { const e = db.events.find((x: any) => x.id === id); Object.assign(e, patch); return e; },
    getTasks: async () => db.tasks,
    createTask: async (data: any) => { const row = mk("t", { status: "todo", ...data, linkedProfiles: data.linkedProfiles?.length ? data.linkedProfiles : [SELF.id] }); db.tasks.push(row); return row; },
    getExpenses: async () => db.expenses,
    createExpense: async (data: any) => { const row = mk("x", { ...data, linkedProfiles: data.linkedProfiles?.length ? data.linkedProfiles : [SELF.id] }); db.expenses.push(row); return row; },
    linkProfileTo: async () => undefined,
    getPreference: async (k: string) => db.prefs[k] ?? null,
    setPreference: async (k: string, v: string) => { db.prefs[k] = v; },
    getMemories: async () => [],
    getDocuments: async () => [],
    getTrackers: async () => [],
    getHabits: async () => [],
    getObligations: async () => [],
    getIncomes: async () => [],
    wouldCreateCycle: async () => false,
    createAiActionLog: async (row: any) => ({ id: "log1", ...row }),
  };
  const storage = new Proxy(impl, { get(target, prop: string) { return prop in target ? target[prop] : async () => []; } });
  return { storage };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => { throw new Error("model must not be called"); },
      stream: () => { throw new Error("model must not be called"); },
    };
  },
}));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
let suggestions: typeof import("../server/profile-suggestions");
beforeEach(async () => {
  reseed();
  ({ executeTool } = await import("../server/ai-engine"));
  suggestions = await import("../server/profile-suggestions");
});

const finish = () => suggestions.finishProfileSuggestions({
  profiles: db.profiles,
  getPreference: async (k) => db.prefs[k] ?? null,
  setPreference: async (k, v) => { db.prefs[k] = v; },
});
const people = () => db.profiles.filter((p: any) => p.type !== "self");

const BOB_MSG = "Bob's birthday is September 30. Remind me every year for 10 years.";

describe("rule 1: only an explicit request creates a person", () => {
  it("'Bob's birthday is…' does not create Bob", async () => {
    const res = await executeTool("create_profile", { name: "Bob", type: "person", __userMessage: BOB_MSG }, "u1");
    expect(res.code).toBe("PROFILE_NOT_REQUESTED");
    expect(res.profileSuggestion).toEqual({ name: "Bob", type: "person" });
    expect(people()).toEqual([]);
  });

  it("'Create a profile for Bob' does", async () => {
    const res = await executeTool("create_profile", { name: "Bob", type: "person", __userMessage: "Create a profile for Bob" }, "u1");
    expect(res.error).toBeUndefined();
    expect(people().map((p: any) => p.name)).toEqual(["Bob"]);
  });

  it("pets and medical providers follow the same rule", async () => {
    expect((await executeTool("create_profile", { name: "Max", type: "pet", __userMessage: "walked Max for 30 minutes" }, "u1")).code).toBe("PROFILE_NOT_REQUESTED");
    expect((await executeTool("create_profile", { name: "Dr. Lee", type: "medical", __userMessage: "dentist with Dr. Lee friday 2pm" }, "u1")).code).toBe("PROFILE_NOT_REQUESTED");
    expect(people()).toEqual([]);
    const luna = await executeTool("create_profile", { name: "Luna", type: "pet", __userMessage: "add my cat Luna" }, "u1");
    expect(luna.error).toBeUndefined();
    expect(people().map((p: any) => p.name)).toEqual(["Luna"]);
  });

  it("intent wording", () => {
    for (const yes of ["Create a profile for Bob", "add my cat Luna", "Add Bob as a contact", "add a person named Mike", "set up a profile for my mom"]) {
      expect(hasExplicitProfileCreateIntent(yes), yes).toBe(true);
    }
    for (const no of [BOB_MSG, "I bought Sarah a $50 gift", "Call Mike tomorrow at 3 PM", "add my sister Dana's birthday",
      "my sister Dana lives in austin, her bday is march 12", "don't create a profile for Bob, just add his birthday"]) {
      expect(hasExplicitProfileCreateIntent(no), no).toBe(false);
    }
  });
});

describe("rules 2, 4, 7: the original request is completed, owned by the user, with no profile", () => {
  it("the birthday is saved as a yearly event for 10 years", async () => {
    const ev = await executeTool("create_event", {
      title: "🎂 Bob's Birthday", date: "2027-09-30", recurrence: "yearly", recurrenceEnd: "2036-09-30", __userMessage: BOB_MSG,
    }, "u1");
    expect(ev.error).toBeUndefined();
    expect(db.events).toHaveLength(1);
    expect(db.events[0].recurrence).toBe("yearly");
    expect(db.events[0].recurrenceEnd).toBe("2036-09-30");
    expect(db.events[0].linkedProfiles).toEqual([SELF.id]);
    expect(people()).toEqual([]);
  });

  it("'I bought Sarah a $50 gift' is the user's expense; Sarah gets no profile", async () => {
    const res = await executeTool("create_expense", { amount: 50, description: "Gift for Sarah", category: "gifts", forProfile: "Sarah", __userMessage: "I bought Sarah a $50 gift" }, "u1");
    expect(res.error).toBeUndefined();
    expect(db.expenses).toHaveLength(1);
    expect(db.expenses[0].linkedProfiles).toEqual([SELF.id]);
    expect(people()).toEqual([]);
  });

  it("'Call Mike tomorrow at 3 PM' is the user's task; Mike gets no profile", async () => {
    const res = await executeTool("create_task", { title: "Call Mike", dueDate: "2026-11-13", dueTime: "15:00", forProfile: "Mike", __userMessage: "Call Mike tomorrow at 3 PM" }, "u1");
    expect(res.error).toBeUndefined();
    expect(db.tasks).toHaveLength(1);
    expect(db.tasks[0].linkedProfiles).toEqual([SELF.id]);
    expect(people()).toEqual([]);
  });

  it("a misspelling of an existing person is still a question, not a write to the user", async () => {
    db.profiles = [SELF, { id: "p-bob", name: "Bob", type: "person", fields: {} }];
    const res = await executeTool("create_task", { title: "Call Bbo", forProfile: "Bbo", __userMessage: "call bbo tomorrow" }, "u1");
    expect(res.needsOwner).toBe(true);
    expect(db.tasks).toHaveLength(0);
  });
});

describe("rules 3, 5: offered once, never created on No, never asked twice", () => {
  it("the turn offers Bob, and the Yes answer is an explicit request", async () => {
    suggestions.beginProfileSuggestions();
    await executeTool("create_profile", { name: "Bob", type: "person", __userMessage: BOB_MSG }, "u1");
    await executeTool("create_event", { title: "🎂 Bob's Birthday", date: "2027-09-30", recurrence: "yearly", __userMessage: BOB_MSG }, "u1");
    const offers = await finish();
    expect(offers).toEqual([{ name: "Bob", type: "person" }]);
    expect(hasExplicitProfileCreateIntent(profileSuggestionYesText(offers[0]))).toBe(true);
  });

  it("Bob mentioned again in a later turn is not offered again", async () => {
    suggestions.beginProfileSuggestions();
    await executeTool("create_event", { title: "🎂 Bob's Birthday", date: "2027-09-30", recurrence: "yearly", __userMessage: BOB_MSG }, "u1");
    expect(await finish()).toHaveLength(1);
    suggestions.beginProfileSuggestions(); // next turn
    await executeTool("create_task", { title: "Buy Bob a gift", forProfile: "Bob", __userMessage: "remind me to buy Bob a gift" }, "u1");
    expect(await finish()).toEqual([]);
    expect(people()).toEqual([]); // No = nothing created, no placeholder
  });
});

describe("rule 6: an existing profile is reused, never offered or duplicated", () => {
  it("Bob already exists: the birthday goes to Bob and nothing is offered", async () => {
    suggestions.beginProfileSuggestions();
    db.profiles = [SELF, { id: "p-bob", name: "Bob", type: "person", fields: {} }];
    await executeTool("create_event", { title: "🎂 Bob's Birthday", date: "2027-09-30", recurrence: "yearly", __userMessage: BOB_MSG }, "u1");
    expect(db.events[0].linkedProfiles).toEqual(["p-bob"]);
    expect(await finish()).toEqual([]);
    expect(people()).toHaveLength(1);
  });
});

describe("rule 8: a profile created later picks up the birthday, without a copy", () => {
  it("'Create a profile for Bob' re-owns the existing birthday event", async () => {
    await executeTool("create_event", { title: "🎂 Bob's Birthday", date: "2027-09-30", recurrence: "yearly", __userMessage: BOB_MSG }, "u1");
    expect(db.events[0].linkedProfiles).toEqual([SELF.id]);
    const bob = await executeTool("create_profile", { name: "Bob", type: "person", __userMessage: "Create a profile for Bob" }, "u1");
    expect(bob.error).toBeUndefined();
    expect(db.events).toHaveLength(1);
    expect(db.events[0].linkedProfiles).toEqual([bob.id]);
  });
});

describe("helpers", () => {
  it("typo detection", () => {
    expect(looksLikeTypoOf("Bbo", ["Bob"])).toBe(true);
    expect(looksLikeTypoOf("Sarah", ["Bob", "Robert Smith"])).toBe(false);
  });
});

describe("the router never steers an unprofiled person's birthday into a question", () => {
  // Live check 2026-11-12: "Tordexmar's birthday is October 2" was routed to
  // "write it on the profile, do not also create an event"; with no profile
  // the model asked instead of saving anything.
  it("no profile → save a yearly event, don't ask, don't create a profile", async () => {
    const { buildContentRoutingDirective } = await import("../server/ai-engine");
    const d = String(buildContentRoutingDirective("Tordexmar's birthday is October 2", [SELF as any]));
    expect(d).toMatch(/Tordexmar, who has NO profile/);
    expect(d).toMatch(/create_event\(title:"🎂 Tordexmar's Birthday"/);
    expect(d).not.toMatch(/do not also create an event/);
    expect(d).not.toMatch(/Pass forProfile/);
    const span = String(buildContentRoutingDirective(BOB_MSG, [SELF as any]));
    expect(span).toMatch(/recurrenceEnd/);
  });

  it("an existing profile still gets the birthday on its record", async () => {
    const { buildContentRoutingDirective } = await import("../server/ai-engine");
    const d = String(buildContentRoutingDirective("Dana's birthday is March 4", [SELF as any, { id: "p-dana", name: "Dana", type: "person" }]));
    expect(d).toMatch(/belongs to the PROFILE_FIELD record/);
    expect(d).toMatch(/Named person\(s\): Dana/);
    expect(d).not.toMatch(/NO profile/);
  });
});
