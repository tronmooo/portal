// The chat box's Journal and Note buttons, and "Bob's journal" (owner request
// 2026-11-20).
//
// With a button on, the message is SAVED as that object, word for word. No
// model decides what it is — so a diary line shaped like a question is still
// an entry, and a run it mentions is not logged. A person named in the text
// ("Bob's journal: …") or picked in the "For" menu owns the record; a name
// with no profile never creates one (CLAUDE.md rule 13).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { parseCaptureTarget, fallbackTitle } from "../shared/capture-target";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const SELF = { id: "p-self", name: "Tron", type: "self", fields: {} };
const BOB = { id: "p-bob", name: "Bob Robertson", type: "person", fields: {} };
const REX = { id: "p-rex", name: "Rex", type: "pet", fields: {} };
const CAR = { id: "p-car", name: "Honda", type: "vehicle", fields: {} };
type Row = Record<string, any>;
const db: { profiles: Row[]; journal: Row[]; notes: Row[]; entries: Row[] } = { profiles: [], journal: [], notes: [], entries: [] };

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => db.profiles,
    getSelfProfile: async () => SELF,
    getJournalEntries: async () => db.journal.map((j) => ({ ...j })),
    createJournalEntry: async (d: Row) => {
      const row = { id: `j${db.journal.length + 1}`, tags: [], linkedProfiles: [], createdAt: new Date(Date.now() + db.journal.length).toISOString(), ...d };
      db.journal.push(row); return { ...row };
    },
    updateJournalEntry: async (id: string, patch: Row) => {
      const row = db.journal.find((j) => j.id === id);
      if (!row) return undefined;
      Object.assign(row, patch); return { ...row };
    },
    linkProfileTo: async () => undefined,
    getArtifacts: async () => db.notes,
    createArtifact: async (d: Row) => { const row = { id: `n${db.notes.length + 1}`, createdAt: new Date().toISOString(), ...d }; db.notes.push(row); return row; },
    getTrackers: async () => [],
    logEntry: async (d: Row) => { db.entries.push(d); return { id: "e1", ...d }; },
    getPreference: async () => null,
  };
  return { storage: new Proxy(impl, { get: (t, p: string) => (p in t ? t[p] : async () => []) }) };
});

// The only model call a button save makes is the TITLE.
let titleReply = "A Pretty Good Day";
let modelCalls: Row[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: async (req: Row) => { modelCalls.push(req); return { content: [{ type: "text", text: titleReply }], stop_reason: "end_turn" }; } };
  },
}));

let processMessage: (msg: string, history?: any[], userId?: string, options?: Row) => Promise<any>;
beforeEach(async () => {
  db.profiles = [SELF, BOB, REX, CAR]; db.journal = []; db.notes = []; db.entries = [];
  titleReply = "A Pretty Good Day"; modelCalls = [];
  ({ processMessage } = await import("../server/ai-engine"));
});
const journalBtn = (msg: string, profileId?: string) => processMessage(msg, [], "u1", { capture: { kind: "journal", ...(profileId ? { profileId } : {}) } });
const noteBtn = (msg: string, profileId?: string) => processMessage(msg, [], "u1", { capture: { kind: "note", ...(profileId ? { profileId } : {}) } });

describe("who it is for (pure)", () => {
  it.each([
    ["Bob's journal: he had a rough day at school", "Bob", "he had a rough day at school"],
    ["Journal for Bob: he had a rough day", "Bob", "he had a rough day"],
    ["Note for Bob Robertson - prefers morning appointments", "Bob Robertson", "prefers morning appointments"],
    ["For Rex: ate all his dinner", "Rex", "ate all his dinner"],
    ["My journal: slept well", null, "slept well"],
    ["I had a good day with Bob's family", null, "I had a good day with Bob's family"],
    ["Bob's car broke down today", null, "Bob's car broke down today"],
  ])("%s", (msg, name, text) => {
    expect(parseCaptureTarget(msg)).toEqual({ name, text });
  });

  it("fallback title is the first clause, without its full stop", () => {
    expect(fallbackTitle("Long drive home. Glad to be back.")).toBe("Long drive home");
  });
});

describe("Journal button", () => {
  it("saves the message word for word, with an AI title, under me", async () => {
    const text = "I had a pretty good day today. I went for a 3 mile run and took a walk after dinner.";
    const res = await journalBtn(text);
    expect(db.journal).toHaveLength(1);
    expect(db.journal[0]).toMatchObject({ content: text, title: "A Pretty Good Day", mood: "good", linkedProfiles: [SELF.id] });
    expect(res.reply).toBe('Saved "A Pretty Good Day" to your journal for today. Mood: Good.');
    // The run and the walk are in the entry — and nowhere else.
    expect(db.entries).toHaveLength(0);
    // One model call: the title. The chat model never ran.
    expect(modelCalls).toHaveLength(1);
    expect(res.mutations?.[0]?.domains).toContain("journal");
  });

  it("a diary line shaped like a question is still saved, not answered", async () => {
    const res = await journalBtn("Why was today so hard? I honestly don't know what went wrong.");
    expect(db.journal).toHaveLength(1);
    expect(db.journal[0].content).toBe("Why was today so hard? I honestly don't know what went wrong.");
    expect(res.reply).toMatch(/^Saved /);
  });

  it("several entries in one day are several entries", async () => {
    await journalBtn("Morning: slept badly but the coffee helped a lot.");
    await journalBtn("Evening: long walk, feeling calm and relaxed now.");
    expect(db.journal).toHaveLength(2);
    expect(new Set(db.journal.map((j) => j.date)).size).toBe(1);
  });

  it("the same message sent twice is one entry", async () => {
    await journalBtn("Morning: slept badly but the coffee helped a lot.");
    const again = await journalBtn("Morning: slept badly but the coffee helped a lot.");
    expect(db.journal).toHaveLength(1);
    expect(again.reply).toMatch(/already in your journal/);
  });

  it('"Bob\'s journal: …" files the entry under Bob, without the lead', async () => {
    titleReply = "Rough Day At School";
    const res = await journalBtn("Bob's journal: he had a rough day at school and was upset all evening.");
    expect(db.journal).toHaveLength(1);
    expect(db.journal[0]).toMatchObject({ content: "he had a rough day at school and was upset all evening.", linkedProfiles: [BOB.id], mood: "bad" });
    expect(res.reply).toBe('Saved "Rough Day At School" to Bob Robertson\'s journal for today. Mood: Bad.');
  });

  it("the For menu files it under the picked person; a name in the text wins over it", async () => {
    await journalBtn("Ate all his dinner and slept on the couch, very happy.", REX.id);
    expect(db.journal[0].linkedProfiles).toEqual([REX.id]);
    await journalBtn("Bob's journal: nervous about the test tomorrow.", REX.id);
    expect(db.journal[1].linkedProfiles).toEqual([BOB.id]);
  });

  it("Bob's entry and mine on the same day stay separate", async () => {
    await journalBtn("My day was fine, nothing special happened at all.");
    await journalBtn("Bob's journal: he scored two goals and was thrilled.");
    expect(db.journal).toHaveLength(2);
    expect(db.journal.map((j) => j.linkedProfiles[0])).toEqual([SELF.id, BOB.id]);
  });

  it("a name with no profile creates no profile: saved whole, under me, and says so", async () => {
    const res = await journalBtn("Sarah's journal: she finally passed her driving test.");
    expect(db.profiles).toHaveLength(4);
    expect(db.journal[0]).toMatchObject({ content: "Sarah's journal: she finally passed her driving test.", linkedProfiles: [SELF.id] });
    expect(res.reply).toMatch(/don't have a profile for Sarah, so it is saved under you/);
  });

  it("two profiles answering to the name: nothing is saved, and it asks which", async () => {
    db.profiles = [SELF, BOB, { id: "p-bob2", name: "Bob Miller", type: "person", fields: {} }];
    const res = await journalBtn("Bob's journal: he had a rough day.");
    expect(db.journal).toHaveLength(0);
    expect(res.reply).toMatch(/2 profiles that answer to "Bob": Bob Robertson, Bob Miller\. Nothing was saved/);
  });

  it("a thing is not a person: \"Honda's journal\" is not filed under the car", async () => {
    await journalBtn("Honda's journal: oil change done at 60k miles.");
    expect(db.journal[0].linkedProfiles).toEqual([SELF.id]);
  });

  it("a title the model botches falls back to the text", async () => {
    titleReply = "";
    await journalBtn("Long drive home through the rain. Glad to be back.");
    expect(db.journal[0].title).toBe("Long drive home through the rain");
  });
});

describe("Note button", () => {
  it("saves a note with an AI title", async () => {
    titleReply = "Buy New Winter Tires";
    const res = await noteBtn("Need to buy new tires for the Honda before winter, check the spare too.");
    expect(db.notes).toHaveLength(1);
    expect(db.notes[0]).toMatchObject({ type: "note", title: "Buy New Winter Tires", content: "Need to buy new tires for the Honda before winter, check the spare too.", linkedProfiles: [] });
    expect(res.reply).toBe('Saved the note "Buy New Winter Tires".');
    expect(db.journal).toHaveLength(0);
    expect(res.mutations?.[0]?.domains).toContain("artifacts");
  });

  it('"Note for Bob: …" belongs to Bob', async () => {
    titleReply = "Bob Prefers Mornings";
    const res = await noteBtn("Note for Bob: prefers morning appointments, never after 3pm.");
    expect(db.notes[0]).toMatchObject({ content: "prefers morning appointments, never after 3pm.", linkedProfiles: [BOB.id] });
    expect(res.reply).toBe('Saved the note "Bob Prefers Mornings" for Bob Robertson.');
  });

  it("the same note twice is one note", async () => {
    await noteBtn("Gate code for the storage unit is 4821, bay 12.");
    const again = await noteBtn("Gate code for the storage unit is 4821, bay 12.");
    expect(db.notes).toHaveLength(1);
    expect(again.reply).toMatch(/already have this note/);
  });
});

describe("no button: the chat still routes by the words", () => {
  it("the chat model passes the title in its journal_entry call; no second model call", async () => {
    const { executeTool } = await import("../server/ai-engine");
    const out = await executeTool("journal_entry", { content: "He had a rough day at school.", title: "Rough Day At School", forProfile: "Bob Robertson" }, "u1");
    expect(db.journal[0]).toMatchObject({ title: "Rough Day At School", linkedProfiles: [BOB.id] });
    expect(out.message).toBe('Saved "Rough Day At School" to Bob Robertson\'s journal for today. Mood: Bad.');
    expect(modelCalls).toHaveLength(0);
  });

  it("append_journal_entry joins my latest entry of the day, not Bob's", async () => {
    const { executeTool } = await import("../server/ai-engine");
    await executeTool("journal_entry", { content: "My morning was calm.", title: "Calm Morning" }, "u1");
    await executeTool("journal_entry", { content: "He was upset after school.", title: "Upset", forProfile: "Bob Robertson" }, "u1");
    const out = await executeTool("append_journal_entry", { content: "I also went grocery shopping." }, "u1");
    expect(db.journal).toHaveLength(2);
    expect(db.journal[0].content).toBe("My morning was calm.\n\nI also went grocery shopping.");
    expect(db.journal[1].content).toBe("He was upset after school.");
    expect(out.message).toMatch(/^Added to your journal entry for today/);
  });
});
