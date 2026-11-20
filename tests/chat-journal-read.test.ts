// Journal tutorial QA (2026-11-20), the chat half. Each test is a message the
// tester typed, run through the real processMessage with a scripted model.
//
//   2. "…Save this as today's journal entry" → "Journal entry needs content or
//      mood" (the model sent an empty entry).
//   3. "frustrated and overwhelmed" saved as Neutral; "Updated journal entry"
//      for one that was created.
//   7. "Show me my journal entry from today" → a piano warranty document.
//      "What was my mood earlier today?" → "I can't see the journal".
//      "Find my note about buying new tires" → a tire-warranty PDF.
//      "Summarize what I wrote in my journal today" → "I only see dates".
import { describe, it, expect, beforeEach, vi } from "vitest";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const TZ = "America/Los_Angeles";
const SELF = { id: "p-self", name: "Bob", type: "self", fields: {} };
type Row = Record<string, any>;
const db: { journal: Row[]; notes: Row[]; documents: Row[]; entries: Row[] } = { journal: [], notes: [], documents: [], entries: [] };
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => [SELF],
    getSelfProfile: async () => SELF,
    getJournalEntries: async () => db.journal.map((j) => ({ ...j })),
    createJournalEntry: async (d: Row) => {
      const row = { id: `j${db.journal.length + 1}`, tags: [], linkedProfiles: [], createdAt: new Date().toISOString(), ...d };
      db.journal.push(row); return { ...row };
    },
    updateJournalEntry: async (id: string, patch: Row) => {
      const row = db.journal.find((j) => j.id === id);
      if (!row) return undefined;
      Object.assign(row, patch); return { ...row };
    },
    linkProfileTo: async () => undefined,
    getArtifacts: async () => db.notes,
    getDocuments: async () => db.documents,
    getTrackers: async () => [],
    logEntry: async (d: Row) => { db.entries.push(d); return { id: `e${db.entries.length}`, ...d }; },
    getPreference: async () => null,
  };
  return { storage: new Proxy(impl, { get: (t, p: string) => (p in t ? t[p] : async () => []) }) };
});

let script: Array<{ content: any[]; stop_reason?: string }> = [];
let requests: Row[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async (req: Row) => {
        requests.push(req);
        return script.shift() ?? { content: [{ type: "text", text: "" }], stop_reason: "end_turn" };
      },
    };
  },
}));

const use = (name: string, input: Row) => ({ type: "tool_use", id: `tu_${name}_${Math.random().toString(36).slice(2, 7)}`, name, input });
const round = (...calls: Row[]) => ({ content: calls, stop_reason: "tool_use" });
const done = (text = "") => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });

let processMessage: (msg: string, history?: any[], userId?: string) => Promise<any>;
beforeEach(async () => {
  db.journal = []; db.notes = []; db.entries = [];
  db.documents = [
    { id: "d-piano", name: "Piano Warranty", type: "warranty", mimeType: "application/pdf", linkedProfiles: [] },
    { id: "d-tire", name: "Tire Warranty", type: "warranty", mimeType: "application/pdf", linkedProfiles: [] },
  ];
  script = []; requests = [];
  ({ processMessage } = await import("../server/ai-engine"));
});

const FRUSTRATED = "I'm feeling frustrated and overwhelmed with work today.";
const seedToday = (content = FRUSTRATED, mood = "bad") =>
  db.journal.push({ id: "j-today", date: today(), mood, content, tags: [], linkedProfiles: [SELF.id], createdAt: new Date().toISOString() });
const lastUserText = () => {
  const msgs = requests[requests.length - 1]?.messages || [];
  const last = [...msgs].reverse().find((m: Row) => m.role === "user");
  return typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
};

describe("writing", () => {
  const STEP2 = "I had a pretty good day today. I went for a 3 mile run this morning and took a walk after dinner. Save this as today's journal entry";

  it("Step 2: an empty journal_entry call is filled with the user's own words", async () => {
    script = [round(use("journal_entry", { content: "" })), done("Saved.")];
    const res = await processMessage(STEP2, [], "u1");
    expect(db.journal).toHaveLength(1);
    expect(db.journal[0].content).toBe("I had a pretty good day today. I went for a 3 mile run this morning and took a walk after dinner.");
    expect(db.journal[0].mood).toBe("good");
    const ops = res.operations || [];
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("ok");
    expect(JSON.stringify(res)).not.toMatch(/needs content or mood/);
  });

  it("Step 2: the model is told the message is ONE journal entry, not activities to log", async () => {
    script = [done("")];
    await processMessage(STEP2, [], "u1");
    expect(lastUserText()).toMatch(/save this message as a journal entry/);
    expect(lastUserText()).toMatch(/Do NOT also log trackers/);
  });

  it("Step 3: 'frustrated and overwhelmed' is not saved as Neutral, and a new entry is not called 'Updated'", async () => {
    script = [round(use("append_journal_entry", { content: FRUSTRATED, mood: "neutral" })), done("")];
    const res = await processMessage(`Journal this: ${FRUSTRATED}`, [], "u1");
    expect(db.journal).toHaveLength(1);
    expect(db.journal[0].mood).toBe("bad");
    const said = JSON.stringify(res);
    expect(said).toMatch(/Saved a new journal entry for today\. Mood: Bad\./);
    expect(said).not.toMatch(/Updated journal/i);
  });

  it("adding to today's entry keeps what was there and says so", async () => {
    seedToday();
    script = [round(use("append_journal_entry", { content: "I also went grocery shopping after work." })), done("")];
    const res = await processMessage("Add to today's journal: I also went grocery shopping after work.", [], "u1");
    expect(db.journal).toHaveLength(1);
    expect(db.journal[0].content).toBe(`${FRUSTRATED}\n\nI also went grocery shopping after work.`);
    expect(db.journal[0].mood).toBe("bad");
    expect(JSON.stringify(res)).toMatch(/Added to your journal entry for today/);
  });
});

describe("reading", () => {
  it("'Show me my journal entry from today' shows the entry, not a document", async () => {
    seedToday();
    const res = await processMessage("Show me my journal entry from today", [], "u1");
    expect(res.reply).toContain(FRUSTRATED);
    expect(res.reply).toContain("Mood: **Bad**");
    expect(res.documentPreview).toBeUndefined();
    expect(res.reply).not.toMatch(/warranty/i);
    expect(requests).toHaveLength(0); // answered from the row, no model call
    expect(db.journal).toHaveLength(1);
  });

  it("says so when today has no entry", async () => {
    const res = await processMessage("Show me my journal entry from today", [], "u1");
    expect(res.reply).toMatch(/don't have a journal entry today/);
    expect(res.documentPreview).toBeUndefined();
  });

  it("'What was my mood earlier today?' answers from the journal", async () => {
    seedToday();
    const res = await processMessage("What was my mood earlier today?", [], "u1");
    expect(res.reply).toContain("**Bad**");
    expect(res.reply).not.toMatch(/can't see|cannot see|don't have access/i);
  });

  it("'Summarize what I wrote in my journal today' hands the model the entry's text", async () => {
    seedToday();
    script = [done("You had a frustrating, overwhelming day at work.")];
    const res = await processMessage("Summarize what I wrote in my journal today", [], "u1");
    expect(lastUserText()).toContain(FRUSTRATED);
    expect(res.reply).toMatch(/frustrating/);
  });

  it("read_journal returns the text and mood of an entry", async () => {
    seedToday();
    script = [round(use("read_journal", { date: "today" })), done("ok")];
    await processMessage("did I write about work in my diary recently, and how did it go overall?", [], "u1");
    const toolResult = JSON.stringify(requests[requests.length - 1].messages);
    expect(toolResult).toContain("frustrated and overwhelmed");
    expect(db.journal).toHaveLength(1);
  });
});

describe("notes", () => {
  const TIRES = { id: "n1", type: "note", title: "Buy new tires", content: "Need to buy new tires for the Honda before winter", linkedProfiles: [], createdAt: "2026-11-20T10:00:00Z" };

  it("'Find my note about buying new tires' shows the note, not the tire-warranty PDF", async () => {
    db.notes = [TIRES, { id: "n2", type: "note", title: "Gate code", content: "4821", linkedProfiles: [], createdAt: "2026-11-19T10:00:00Z" }];
    const res = await processMessage("Find my note about buying new tires", [], "u1");
    expect(res.reply).toContain("Need to buy new tires for the Honda before winter");
    expect(res.reply).not.toContain("Gate code");
    expect(res.documentPreview).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("says which notes exist when none is about the topic", async () => {
    db.notes = [TIRES];
    const res = await processMessage("Find my note about the piano", [], "u1");
    expect(res.reply).toMatch(/couldn't find a note about "the piano"/);
    expect(res.reply).toContain("Buy new tires");
    expect(res.documentPreview).toBeUndefined();
  });

  it("search_notes matches on words when the exact phrase is not in the note", async () => {
    db.notes = [TIRES];
    script = [round(use("search_notes", { query: "buying new tires" })), done("ok")];
    await processMessage("is there anything in what I jotted down regarding buying new tires?", [], "u1");
    expect(JSON.stringify(requests[requests.length - 1].messages)).toContain("Honda before winter");
  });

  it("a document is still opened by name", async () => {
    const res = await processMessage("open my tire warranty", [], "u1");
    expect(res.documentPreview?.id ?? res.documentPreviews?.[0]?.id).toBe("d-tire");
  });
});
