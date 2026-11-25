// The AI behind the workspace apps' tabs (owner request 2026-11-25).
//
// What is pinned here:
//  - NOTHING writes: every function answers, and the storage sees no write.
//  - The writer's AI-access switches are enforced where the prompt is built:
//    a switch that is off means the data is not in the prompt at all. Journal
//    text reaches the Document AI only when its own switch is on.
//  - A structured answer is grounded: a note, a day or a quoted passage the
//    model names must exist in what it was sent.
//  - The coach is told it is not a therapist and must not diagnose, and says
//    so beside every answer.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { memoryKey, parseAiMemory } from "../shared/ai-memory";
import { WORKSPACE_AI_ACCESS_PREF, DEFAULT_WORKSPACE_AI_ACCESS, serializeWorkspaceAiAccess, withAccess, type WorkspaceAiAccess } from "../shared/workspace-access";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

type Row = Record<string, any>;
const SELF = { id: "p-self", name: "Tron Moore", type: "self", fields: { email: "tron@example.test", occupation: "Nurse", ssn: "123-45-6789" } };
const BOB = { id: "p-bob", name: "Bob Robertson", type: "person", fields: {} };
const CAR = { id: "p-car", name: "Honda CR-V", type: "vehicle", fields: { year: 2019, vin: "VIN123" } };
const db: { profiles: Row[]; documents: Row[]; journal: Row[]; artifacts: Row[]; trackers: Row[]; tasks: Row[]; events: Row[]; prefs: Record<string, string>; writes: string[]; prefWrites: string[] } =
  { profiles: [], documents: [], journal: [], artifacts: [], trackers: [], tasks: [], events: [], prefs: {}, writes: [], prefWrites: [] };

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => db.profiles,
    getSelfProfile: async () => SELF,
    getDocuments: async () => db.documents,
    getJournalEntries: async () => db.journal,
    getArtifacts: async () => db.artifacts,
    getTrackers: async () => db.trackers,
    getTasks: async () => db.tasks,
    getEvents: async () => db.events,
    getPreference: async (key: string) => db.prefs[key] ?? null,
    // The one row an AI may write: its own memory. Every key written is recorded.
    setPreference: async (key: string, value: string) => { db.prefWrites.push(key); db.prefs[key] = value; },
    acquireUserLock: async () => true,
    releaseUserLock: async () => undefined,
  };
  // Any storage method this test did not define is recorded by name: a write would show.
  return { storage: new Proxy(impl, { get: (t, p: string) => (p in t ? t[p] : async () => { db.writes.push(p); return []; }) }) };
});

let modelReply: string | Error = "";
let modelCalls: Row[] = [];
/** Something that happens while the model is writing its reply (the person taps a button meanwhile). */
let whileModelWrites: (() => Promise<void>) | null = null;
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: async (req: Row) => {
      modelCalls.push(req);
      if (whileModelWrites) { const act = whileModelWrites; whileModelWrites = null; await act(); }
      if (modelReply instanceof Error) throw modelReply;
      return { content: [{ type: "text", text: modelReply }], stop_reason: "end_turn" };
    } };
  },
}));

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const note = (id: string, title: string, content: string, tags: string[] = [], updatedAt = "2026-11-20T10:00:00Z") => ({ id, type: "note", title, content, tags, updatedAt, createdAt: updatedAt });
const entry = (id: string, date: string, content: string, extra: Row = {}) => ({ id, date, mood: "okay", title: "", content, tags: [], linkedProfiles: [], createdAt: `${date}T08:00:00Z`, ...extra });
const setAccess = (change: (a: WorkspaceAiAccess) => WorkspaceAiAccess) => { db.prefs[WORKSPACE_AI_ACCESS_PREF] = serializeWorkspaceAiAccess(change(DEFAULT_WORKSPACE_AI_ACCESS)); };

let intel: typeof import("../server/workspace-intel");
let ai: typeof import("../server/workspace-ai");
beforeEach(async () => {
  db.profiles = [SELF, BOB, CAR]; db.documents = []; db.trackers = []; db.tasks = []; db.events = []; db.prefs = {}; db.writes = []; db.prefWrites = [];
  db.artifacts = [
    note("n1", "Trip plan", "Fly to Lisbon in March.\n- [ ] book flights\n- [x] renew passport", ["category:Travel"]),
    note("n2", "Budget", "Trip fund: 1200 saved of 3000.", []),
    note("n3", "Ideas", "Learn Portuguese before Lisbon.", []),
    { id: "d1", type: "doc", title: "A document", content: "<p>Not a note</p>", tags: [] },
  ];
  db.journal = [
    entry("j1", daysAgo(2), "Work was heavy and I snapped at Sam. SECRETJOURNALWORD."),
    entry("j2", daysAgo(9), "A calm walk by the river helped.", { energy: 4, tags: ["stress:2", "emotion:calm"] }),
    entry("j3", daysAgo(30), "Worried about the Lisbon budget again."),
    entry("j-bob", daysAgo(3), "Bob's own entry BOBSECRET.", { linkedProfiles: ["p-bob"] }),
  ];
  modelReply = "An answer."; modelCalls = [];
  intel = await import("../server/workspace-intel");
  ai = await import("../server/workspace-ai");
});
const sentTo = (call: Row) => `${call.system ?? ""}\n${(call.messages || []).map((m: Row) => m.content).join("\n")}`;
const WRITE_RE = /^(create|update|delete|save|log|link|set|upsert|insert|remove)/i;
/** No record the person owns is written; the only row an AI may write is its own memory. */
const noWrites = () => {
  expect(db.writes.filter((m) => WRITE_RE.test(m))).toEqual([]);
  expect(db.prefWrites.filter((k) => !k.startsWith("ai_memory:"))).toEqual([]);
};
const stored = (app: "journal" | "notes") => parseAiMemory(db.prefs[memoryKey(app)] ?? null);
const ask = (q: string) => [{ role: "user", content: q }];
const ok = <T extends { ok: boolean }>(r: T) => { expect(r.ok, JSON.stringify(r)).toBe(true); return r as Extract<T, { ok: true }>; };

describe("Notes: a conversation about the whole notebook", () => {
  it("reads every note (and only notes), names how many, and writes nothing", async () => {
    const r = ok(await intel.notesChat({ messages: ask("What am I planning?") }));
    expect(r).toMatchObject({ answer: "An answer.", notesRead: 3, notesTotal: 3, usedPortol: false });
    const sent = sentTo(modelCalls[0]);
    expect(sent).toContain("Fly to Lisbon in March.");
    expect(sent).toContain("Trip fund: 1200 saved of 3000.");
    expect(sent).not.toContain("Not a note"); // a document is not a note
    expect(modelCalls[0].messages).toEqual([{ role: "user", content: "What am I planning?" }]);
    noWrites();
  });

  it("never carries journal text, and the rest of Portol only with permission", async () => {
    ok(await intel.notesChat({ messages: ask("Anything about work?") }));
    expect(sentTo(modelCalls[0])).not.toContain("SECRETJOURNALWORD");
    expect(sentTo(modelCalls[0])).not.toContain("Honda CR-V");
    expect(sentTo(modelCalls[0])).not.toContain("Nurse");

    setAccess((a) => withAccess(a, "notes", "portol", true));
    db.tasks = [{ id: "t1", title: "Renew the lease", status: "todo" }, { id: "t2", title: "Old chore", status: "done" }];
    const r = ok(await intel.notesChat({ messages: ask("Connect my notes to my tasks") }));
    expect(r.usedPortol).toBe(true);
    const sent = sentTo(modelCalls[1]);
    expect(sent).toContain("Honda CR-V");
    expect(sent).toContain("Renew the lease");
    expect(sent).not.toContain("Old chore");
    expect(sent).not.toContain("123-45-6789"); // a secret is never sent
    expect(sent).not.toContain("SECRETJOURNALWORD"); // still no journal
  });

  it("with 'all my notes' off, only the open note is read", async () => {
    setAccess((a) => withAccess(a, "notes", "allNotes", false));
    const r = ok(await intel.notesChat({ messages: ask("Tidy this"), openNote: { id: "n2", title: "Budget", content: "Trip fund: 1200 saved of 3000." } }));
    expect(r.notesRead).toBe(1);
    const sent = sentTo(modelCalls[0]);
    expect(sent).toContain("Trip fund");
    expect(sent).not.toContain("Fly to Lisbon");
    // With no note open there is nothing it may read: it says so and does not call the model.
    const none = await intel.notesChat({ messages: ask("What did I write?") });
    expect(none).toMatchObject({ ok: false, status: 400 });
    expect(modelCalls).toHaveLength(1);
  });

  it("a question is required; a failed model is an error, never an invented answer", async () => {
    expect(await intel.notesChat({ messages: [] })).toMatchObject({ ok: false, status: 400 });
    modelReply = new Error("boom");
    expect(await intel.notesChat({ messages: ask("hello there") })).toMatchObject({ ok: false, status: 502 });
    modelReply = "   ";
    expect(await intel.notesChat({ messages: ask("hello there") })).toMatchObject({ ok: false, status: 502 });
  });

  it("insights point only at real notes, by their stored ids", async () => {
    modelReply = JSON.stringify({
      recurring: [{ text: "Lisbon comes up in the plan and the ideas.", notes: ["N1", "N3", "N44"] }],
      related: [{ text: "Made up.", notes: ["N90", "N91"] }],
      unfinished: [{ text: "Flights are not booked.", notes: ["N1"] }],
      connections: [],
    });
    const r = ok(await intel.notesInsights());
    expect(r.insights.recurring).toEqual([{ text: "Lisbon comes up in the plan and the ideas.", notes: [{ id: "n1", title: "Trip plan" }, { id: "n3", title: "Ideas" }] }]);
    expect(r.insights.related).toEqual([]);
    expect(r.insights.unfinished[0].notes).toEqual([{ id: "n1", title: "Trip plan" }]);
    // The model sees labels, never the stored ids.
    expect(sentTo(modelCalls[0])).toContain("[N1] Trip plan");
    expect(sentTo(modelCalls[0])).not.toContain("n1]");
    noWrites();
    modelReply = "Sorry, nothing.";
    expect(await intel.notesInsights()).toMatchObject({ ok: false, status: 502 });
  });

  it("insights need the notebook: off in AI access, or one note, is refused without a model call", async () => {
    db.artifacts = [note("n1", "Only", "one note")];
    expect(await intel.notesInsights()).toMatchObject({ ok: false, status: 400 });
    setAccess((a) => withAccess(a, "notes", "allNotes", false));
    expect(await intel.notesInsights()).toMatchObject({ ok: false, status: 403 });
    expect(await intel.notesCategorize()).toMatchObject({ ok: false, status: 403 });
    expect(modelCalls).toHaveLength(0);
  });

  it("categories are suggested only for notes that have none, reuse an existing name, and file nothing", async () => {
    modelReply = JSON.stringify({ suggestions: [{ note: "N2", category: "travel" }, { note: "N1", category: "Already filed" }, { note: "N3", category: "Languages" }] });
    const r = ok(await intel.notesCategorize());
    expect(r.uncategorized).toBe(2);
    // "travel" takes the existing category's own spelling; N1 already had a category and was not offered.
    expect(r.suggestions).toEqual([{ id: "n2", title: "Budget", category: "Travel" }, { id: "n3", title: "Ideas", category: "Languages" }]);
    expect(sentTo(modelCalls[0])).not.toContain("Fly to Lisbon"); // the filed note's text is not sent
    noWrites();
    db.artifacts = [note("n1", "Trip plan", "x", ["category:Travel"])];
    expect(ok(await intel.notesCategorize())).toMatchObject({ suggestions: [], uncategorized: 0 });
    expect(modelCalls).toHaveLength(1); // nothing to file: no model call
  });
});

describe("Journal: the reflection coach", () => {
  it("is told it is not a therapist and must not diagnose, and says so with the answer", async () => {
    const r = ok(await intel.journalCoach({ messages: ask("What patterns do you notice in my journal entries?") }));
    expect(r.boundary).toMatch(/not a therapist/i);
    const system = String(modelCalls[0].system);
    expect(system).toMatch(/not a therapist/i);
    expect(system).toMatch(/Never diagnose/);
    expect(system).toMatch(/emergency services or a crisis line/);
    noWrites();
  });

  it("reads the writer's own entries — not another person's — and nothing else by default", async () => {
    db.trackers = [{ id: "t1", name: "Sleep", unit: "h", linkedProfiles: [], entries: [{ timestamp: `${daysAgo(2)}T07:00:00Z`, values: { hours: 5.5 } }] }];
    const r = ok(await intel.journalCoach({ messages: ask("How has my mindset changed?") }));
    expect(r).toMatchObject({ entriesRead: 3, entriesTotal: 3, used: { pastEntries: true, wellness: false, activity: false, memory: true } });
    const sent = sentTo(modelCalls[0]);
    expect(sent).toContain("SECRETJOURNALWORD");
    expect(sent).toContain("energy 4/5 · stress 2/5 · felt: calm");
    expect(sent).not.toContain("BOBSECRET");
    expect(sent).not.toContain("Sleep: hours 5.5"); // wellness is off until allowed
  });

  it("connects sleep and exercise only when wellness is allowed, and only the writer's own", async () => {
    db.trackers = [
      { id: "t1", name: "Sleep", unit: "h", linkedProfiles: [], entries: [{ timestamp: `${daysAgo(2)}T07:00:00Z`, values: { hours: 5.5, note: "restless" } }, { timestamp: "2020-01-01T07:00:00Z", values: { hours: 9 } }] },
      { id: "t2", name: "Bob Weight", linkedProfiles: ["p-bob"], entries: [{ timestamp: `${daysAgo(2)}T07:00:00Z`, values: { weight: 199 } }] },
    ];
    db.tasks = [{ id: "k1", title: "File taxes", status: "done", updatedAt: `${daysAgo(2)}T15:00:00Z` }];
    setAccess((a) => withAccess(withAccess(a, "journal", "wellness", true), "journal", "activity", true));
    const r = ok(await intel.journalCoach({ messages: ask("What situations seem to cause me the most stress?") }));
    expect(r.used).toEqual({ pastEntries: true, wellness: true, activity: true, memory: true });
    const sent = sentTo(modelCalls[0]);
    expect(sent).toContain(`${daysAgo(2)}: Sleep: hours 5.5 h`);
    expect(sent).not.toContain("restless"); // numbers only, never a tracker note
    expect(sent).not.toContain("hours 9"); // outside the window
    expect(sent).not.toContain("199"); // someone else's health
    expect(sent).toContain('finished task "File taxes"');
  });

  it("with past entries off, it knows only the conversation and the page being written", async () => {
    setAccess((a) => withAccess(a, "journal", "pastEntries", false));
    const r = ok(await intel.journalCoach({ messages: ask("Help me think this through"), draft: "Today I felt stuck." }));
    expect(r).toMatchObject({ entriesRead: 1, used: { pastEntries: false } });
    const sent = sentTo(modelCalls[0]);
    expect(sent).toContain("Today I felt stuck.");
    expect(sent).not.toContain("SECRETJOURNALWORD");
    expect(await intel.journalInsights({ focus: "insights" })).toMatchObject({ ok: false, status: 403 });
    expect(await intel.journalPrompts()).toMatchObject({ ok: false, status: 403 });
  });

  it("with remembering off, the conversation is the one the screen holds, and nothing is saved", async () => {
    setAccess((a) => withAccess(a, "journal", "memory", false));
    const r = ok(await intel.journalCoach({ messages: [{ role: "user", content: "I keep arguing with Sam." }, { role: "assistant", content: "What usually comes before it?" }, { role: "user", content: "Being tired." }] }));
    expect(modelCalls[0].messages.map((m: Row) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(r.used.memory).toBe(false);
    expect(r.remembered).toEqual([]);
    expect(String(modelCalls[0].system)).toMatch(/Remembering is switched off/);
    expect(String(modelCalls[0].system)).toMatch(/say plainly that remembering is off so you don't have it — never guess/);
    expect(String(modelCalls[0].system)).not.toMatch(/REMEMBER:/);
    expect(db.prefWrites).toEqual([]);
    expect(await intel.journalCoach({ messages: [{ role: "assistant", content: "hi" }] })).toMatchObject({ ok: false, status: 400 });
  });

  it("an insight must stand on a day that has an entry", async () => {
    modelReply = JSON.stringify({
      patterns: [{ title: "Work spills over", detail: "A hard day at work shows up at home.", days: [daysAgo(2), "1999-01-01"] }, { title: "Invented", detail: "No entry behind it.", days: ["1999-01-01"] }],
      concerns: [{ title: "The trip budget", detail: "It returns.", days: [daysAgo(30)] }], changes: [], progress: [],
    });
    const r = ok(await intel.journalInsights({ focus: "insights" }));
    expect(r.insights.sections.map((s) => [s.key, s.items.map((i) => i.title)])).toEqual([
      ["patterns", ["Work spills over"]], ["concerns", ["The trip budget"]], ["changes", []], ["progress", []],
    ]);
    expect(r.insights.sections[0].items[0].days).toEqual([daysAgo(2)]);
    expect(String(modelCalls[0].system)).toMatch(/never diagnose/);
    noWrites();
  });

  it("growth has its own sections; too few entries is said plainly, without a model call", async () => {
    modelReply = JSON.stringify({ challenges: [], accomplishments: [{ title: "Took the walk", detail: "You went anyway.", days: [daysAgo(9)] }], opportunities: [] });
    const r = ok(await intel.journalInsights({ focus: "growth" }));
    expect(r.insights.sections.map((s) => s.key)).toEqual(["challenges", "accomplishments", "opportunities"]);
    db.journal = db.journal.slice(0, 1);
    modelCalls = [];
    expect(await intel.journalInsights({ focus: "growth" })).toMatchObject({ ok: false, status: 400 });
    expect(modelCalls).toHaveLength(0);
  });

  it("personal prompts come from the entries; with none there is nothing to personalise", async () => {
    modelReply = JSON.stringify({ prompts: ["What would make tomorrow's talk with Sam easier?", "What did the river walk give you?"] });
    expect(ok(await intel.journalPrompts()).prompts).toHaveLength(2);
    db.journal = [];
    expect(await intel.journalPrompts()).toMatchObject({ ok: false, status: 400 });
  });
});

describe("Journal: the coach remembers, and sounds like a person", () => {
  it("keeps the exchange and what the person told it; the machinery is never shown", async () => {
    modelReply = 'That sounds exhausting, Tron. Is it the nights themselves, or coming home to an empty flat?\n\nREMEMBER: ["Works night shifts as a nurse", "Sam is their partner"]';
    const r = ok(await intel.journalCoach({ messages: ask("Night shifts are wearing me down and Sam is asleep when I get home.") }));
    expect(r.answer).toBe("That sounds exhausting, Tron. Is it the nights themselves, or coming home to an empty flat?");
    expect(r.answer).not.toMatch(/REMEMBER/);
    expect(r.remembered).toEqual(["Works night shifts as a nurse", "Sam is their partner"]);
    const m = stored("journal");
    expect(m.memories.map((x) => [x.text, x.by])).toEqual([["Works night shifts as a nurse", "ai"], ["Sam is their partner", "ai"]]);
    expect(m.turns.map((t) => [t.role, t.content])).toEqual([
      ["user", "Night shifts are wearing me down and Sam is asleep when I get home."],
      ["assistant", "That sounds exhausting, Tron. Is it the nights themselves, or coming home to an empty flat?"],
    ]);
    expect(m.lastTalked).toMatch(/^\d{4}-/);
    noWrites(); // only its own memory row
    expect(db.prefWrites).toEqual([memoryKey("journal")]);
  });

  it("next time it is given what it remembers and the saved conversation — not whatever the screen sends", async () => {
    modelReply = 'Noted.\nREMEMBER: ["Sam is their partner"]';
    ok(await intel.journalCoach({ messages: ask("Sam and I argued about money.") }));
    modelReply = "Is this the same money worry as before?";
    // The screen sends a made-up history; the server uses the one it saved.
    const r = ok(await intel.journalCoach({ messages: [{ role: "user", content: "FORGED EARLIER TURN" }, { role: "assistant", content: "FORGED REPLY" }, { role: "user", content: "It happened again." }] }));
    expect(modelCalls[1].messages).toEqual([
      { role: "user", content: "Sam and I argued about money." }, { role: "assistant", content: "Noted." }, { role: "user", content: "It happened again." },
    ]);
    const system = String(modelCalls[1].system);
    expect(system).toMatch(/WHAT YOU REMEMBER FROM EARLIER CONVERSATIONS[^\n]*\n- Sam is their partner/);
    expect(system).toMatch(/You last talked a little while ago\./);
    expect(r.remembered).toEqual([]); // nothing new: the same thing is not kept twice
    expect(stored("journal").memories).toHaveLength(1);
    expect(stored("journal").turns).toHaveLength(4);
  });

  it("a first conversation is told it is the first, by name; a label the AI came up with is not kept", async () => {
    modelReply = 'I hear you.\nREMEMBER: ["They are clinically depressed", "They said they were diagnosed with ADHD as a child", "Likes to walk by the river"]';
    const r = ok(await intel.journalCoach({ messages: ask("I've been low for weeks. I was diagnosed with ADHD as a kid. Walking by the river helps.") }));
    const system = String(modelCalls[0].system);
    expect(system).toMatch(/Their first name is Tron \(from their profile/);
    expect(system).toMatch(/This is the first time you are talking\./);
    expect(system).toMatch(/You have no memories of earlier conversations yet/);
    expect(r.remembered).toEqual(["They said they were diagnosed with ADHD as a child", "Likes to walk by the river"]);
  });

  it("is told to talk like a person, and the limits still do not bend", async () => {
    ok(await intel.journalCoach({ messages: ask("Rough day.") }));
    const system = String(modelCalls[0].system);
    expect(system).toMatch(/a wise, warm friend who really listens/);
    expect(system).toMatch(/Plain, everyday words and contractions/);
    expect(system).toMatch(/no therapy jargon/);
    expect(system).toMatch(/Listen first/);
    expect(system).toMatch(/Never recite a list of facts about them/);
    // The craft of a therapist, used and not announced.
    expect(system).toMatch(/HOW YOU WORK \(the craft a good therapist brings into the room/);
    expect(system).toMatch(/Pick up the thread\..*ask how it went before anything new/);
    expect(system).toMatch(/Reflect before you ask/);
    expect(system).toMatch(/do not argue with it: help them look at it/);
    expect(system).toMatch(/slow right down\. Offer one short grounding or breathing exercise, a step at a time/);
    expect(system).toMatch(/one small step that is doable this week and is theirs\. Then remember it/);
    expect(system).toMatch(/When they ask to wrap up/);
    expect(system).toMatch(/a step they said they would try/); // …so it can follow up next time
    expect(system).toMatch(/LIMITS \(these do not bend\)/);
    expect(system).toMatch(/not a therapist, counsellor or doctor\. Never diagnose/);
    expect(system).toMatch(/Do not pretend to be human if they sincerely ask/);
    expect(system).toMatch(/never a diagnosis or a label/); // what it may remember
  });

  it("asked outright to remember, it is kept even when the model proposes nothing — in the person's own words", async () => {
    modelReply = "Of course. Porto sounds lovely."; // no REMEMBER line at all
    const r = ok(await intel.journalCoach({ messages: ask("Please remember this: my sister Ana lives in Porto and I miss her.") }));
    expect(r.remembered).toEqual(["My sister Ana lives in Porto and I miss her."]);
    expect(stored("journal").memories.map((m) => [m.text, m.by])).toEqual([["My sister Ana lives in Porto and I miss her.", "you"]]);
    // When the model does propose, its wording is the one kept: not both.
    modelReply = 'Got it.\nREMEMBER: ["Their brother Leo is moving to Canada"]';
    ok(await intel.journalCoach({ messages: ask("Remember that my brother Leo is moving to Canada.") }));
    expect(stored("journal").memories.map((m) => m.text)).toEqual(["My sister Ana lives in Porto and I miss her.", "Their brother Leo is moving to Canada"]);
    // A question about its memory adds nothing.
    modelReply = "Your sister Ana is in Porto.";
    ok(await intel.journalCoach({ messages: ask("Do you remember where my sister lives?") }));
    expect(stored("journal").memories).toHaveLength(2);
    expect(String(modelCalls[0].system)).toMatch(/you MUST end your reply with one last line: REMEMBER:/);
  });

  it("Forget everything wins over a reply that was already on its way", async () => {
    const memory = await import("../server/ai-memory");
    modelReply = 'Noted.\nREMEMBER: ["Sam is their partner"]';
    ok(await intel.journalCoach({ messages: ask("Sam is my partner.") }));
    // The person forgets everything while the next reply is being written.
    modelReply = 'Sure.\nREMEMBER: ["They work nights"]';
    whileModelWrites = async () => { await memory.forgetEverything("journal"); };
    const r = ok(await intel.journalCoach({ messages: ask("I work nights. Remember that I work nights.") }));
    expect(r.answer).toBe("Sure."); // they still get the reply they were waiting for
    expect(r.remembered).toEqual([]); // but nothing is put back
    expect(stored("journal").memories).toEqual([]);
    expect(stored("journal").turns).toEqual([]);
    // And the next exchange is saved normally again.
    modelReply = "Hello again.";
    ok(await intel.journalCoach({ messages: ask("Starting over.") }));
    expect(stored("journal").turns).toHaveLength(2);
  });

  it("a failed answer saves nothing: the conversation is not left with a question and no reply", async () => {
    modelReply = new Error("boom");
    expect(await intel.journalCoach({ messages: ask("Are you there?") })).toMatchObject({ ok: false, status: 502 });
    expect(db.prefWrites).toEqual([]);
    expect(stored("journal").turns).toEqual([]);
  });

  it("the coach's memory is the coach's: the notes assistant is not given it, and keeps its own", async () => {
    modelReply = 'Okay.\nREMEMBER: ["COACHONLY: Sam is their partner"]';
    ok(await intel.journalCoach({ messages: ask("Sam is my partner.") }));
    modelReply = 'Sure.\nREMEMBER: ["Prefers notes grouped by project"]';
    const r = ok(await intel.notesChat({ messages: ask("Group my notes by project from now on.") }));
    expect(sentTo(modelCalls[1])).not.toContain("COACHONLY");
    expect(r).toMatchObject({ answer: "Sure.", remembered: ["Prefers notes grouped by project"], memoryOn: true });
    expect(stored("notes").memories.map((m) => m.text)).toEqual(["Prefers notes grouped by project"]);
    expect(stored("journal").memories.map((m) => m.text)).toEqual(["COACHONLY: Sam is their partner"]);
    // And insights, growth and the Document AI are never given either memory.
    modelReply = JSON.stringify({ patterns: [], concerns: [], changes: [], progress: [] });
    ok(await intel.journalInsights({ focus: "insights" }));
    modelReply = "TITLE: A Letter\n<p>Dear Sir, a letter about Sam and projects.</p>";
    ok(await ai.assistDocument({ instruction: "Write a letter about Sam and my projects" }));
    expect(sentTo(modelCalls[2])).not.toContain("COACHONLY");
    expect(sentTo(modelCalls[3])).not.toContain("COACHONLY");
    expect(sentTo(modelCalls[3])).not.toContain("grouped by project");
  });
});

describe("Word: review and what a document may draw on", () => {
  const DOC = `<h1>Cover letter</h1><p>I am writting to apply for the role. Call me on [Missing: phone number].</p><p>The interview is on Tuesday. I look forward to Wednesday's interview.</p>`;

  it("blanks are counted from the document; a quoted passage must be in it", async () => {
    modelReply = JSON.stringify({ findings: [
      { category: "grammar", quote: "I am writting to apply", issue: "Spelling.", suggestion: "writing" },
      { category: "grammar", quote: "should of", issue: "Not there.", suggestion: "should have" },
      { category: "missing", quote: "[Missing: phone number]", issue: "Blank.", suggestion: "Fill it." },
      { category: "consistency", quote: "The interview is on Tuesday", issue: "Tuesday and Wednesday disagree.", suggestion: "Use one day." },
    ] });
    const r = ok(await intel.reviewDocument({ html: DOC, title: "Cover letter" }));
    expect(r.findings.map((f) => [f.category, f.quote])).toEqual([
      ["missing", "[Missing: phone number]"], // read from the document itself, once
      ["grammar", "I am writting to apply"],
      ["consistency", "The interview is on Tuesday"],
    ]);
    expect(r.words).toBeGreaterThan(10);
    noWrites();
  });

  it("too little to review, or a reply that is not a review, changes nothing and says so", async () => {
    expect(await intel.reviewDocument({ html: "<p>Hi</p>" })).toMatchObject({ ok: false, status: 400 });
    expect(modelCalls).toHaveLength(0);
    modelReply = "Looks great!";
    expect(await intel.reviewDocument({ html: DOC })).toMatchObject({ ok: false, status: 502 });
  });

  const LETTER = "TITLE: A Letter\n<p>Dear Sir, this is a letter about the Lisbon trip and the Honda.</p>";

  it("the Document AI does not read notes, assets or the journal unless each is switched on", async () => {
    modelReply = LETTER;
    db.journal.push(entry("j9", daysAgo(1), "Lisbon trip budget worries, in the journal JOURNALONLY."));
    const r = ok(await ai.assistDocument({ instruction: "Write a letter about my Lisbon trip budget and my Honda" }));
    const sent = sentTo(modelCalls[0]);
    expect(sent).toContain("tron@example.test"); // the profile, as before
    expect(sent).not.toContain("Trip fund"); // a note
    expect(sent).not.toContain("VIN123"); // an asset
    expect(sent).not.toContain("JOURNALONLY"); // the journal
    expect(r.sources).toEqual(["your profile"]);
  });

  it("each switch adds exactly its own records, and the sources name them", async () => {
    modelReply = LETTER;
    db.journal.push(entry("j9", daysAgo(1), "Lisbon trip budget worries, in the journal JOURNALONLY."));
    setAccess((a) => withAccess(withAccess(a, "word", "notes", true), "word", "assets", true));
    let r = ok(await ai.assistDocument({ instruction: "Write a letter about my Lisbon trip budget and my Honda" }));
    let sent = sentTo(modelCalls[0]);
    expect(sent).toContain("Trip fund: 1200 saved of 3000.");
    expect(sent).toContain("VIN123");
    expect(sent).not.toContain("JOURNALONLY");
    expect(r.sources).toEqual(expect.arrayContaining(["your profile", "Honda CR-V", 'note "Budget"']));

    setAccess((a) => withAccess(withAccess(a, "word", "journal", true), "word", "profile", false));
    r = ok(await ai.assistDocument({ instruction: "Write a letter about my Lisbon trip budget" }));
    sent = sentTo(modelCalls[1]);
    expect(sent).toContain("JOURNALONLY");
    expect(sent).not.toContain("BOBSECRET"); // never another person's journal
    expect(sent).not.toContain("tron@example.test"); // the profile switch is off
    // Both of the writer's entries about the Lisbon budget, and nothing else.
    expect([...r.sources].sort()).toEqual([`journal entry of ${daysAgo(1)}`, `journal entry of ${daysAgo(30)}`].sort());
    noWrites();
  });
});

it("today is a real day (the helpers above depend on it)", () => { expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/); });
