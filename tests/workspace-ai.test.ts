// The AI boxes in the full-screen workspaces (owner request 2026-11-22).
// Every one returns a PROPOSAL and writes nothing: the workspace shows it and
// the user accepts or discards. A document never invents a personal fact —
// what is not on file is a marked blank, and the blanks reported are read
// back from the returned text. The journal AI reads; it never rewrites.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { documentBlanks, parseDraftReply, sanitizeDocumentHtml, documentPlainText } from "../shared/workspace-document";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

type Row = Record<string, any>;
const SELF = { id: "p-self", name: "Tron Moore", type: "self", fields: { email: "tron@example.test", occupation: "Nurse", ssn: "123-45-6789" } };
const BOB = { id: "p-bob", name: "Bob Robertson", type: "person", fields: { phone: "555-0100" } };
const db: { profiles: Row[]; documents: Row[]; journal: Row[]; writes: string[] } = { profiles: [], documents: [], journal: [], writes: [] };

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => db.profiles,
    getSelfProfile: async () => SELF,
    getDocuments: async () => db.documents,
    getJournalEntries: async () => db.journal,
  };
  // Any storage method this test did not define is recorded: a write here
  // would show up by name.
  return { storage: new Proxy(impl, { get: (t, p: string) => (p in t ? t[p] : async () => { db.writes.push(p); return []; }) }) };
});

let modelReply: string | Error = "";
let modelCalls: Row[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: async (req: Row) => {
      modelCalls.push(req);
      if (modelReply instanceof Error) throw modelReply;
      return { content: [{ type: "text", text: modelReply }], stop_reason: "end_turn" };
    } };
  },
}));

const LETTER =
  `TITLE: Cover Letter for Nursing Position\n` +
  `<h1>Tron Moore</h1><p>tron@example.test · [Missing: phone number]</p>` +
  `<p>Dear Hiring Manager,</p><p>I am a nurse writing to apply. I can start on [Missing: start date]. Call me on [Missing: Phone Number].</p>` +
  `<script>alert(1)</script><p onclick="x()">Sincerely,<br>Tron Moore</p>`;

let ai: typeof import("../server/workspace-ai");
beforeEach(async () => {
  db.profiles = [SELF, BOB]; db.documents = []; db.journal = []; db.writes = [];
  modelReply = LETTER; modelCalls = [];
  ai = await import("../server/workspace-ai");
});
const promptOf = (call: Row) => String(call.messages?.[0]?.content ?? "");
const WRITE_RE = /^(create|update|delete|save|log|link|set|upsert|insert|remove)/i;
const noWrites = () => expect(db.writes.filter((m) => WRITE_RE.test(m))).toEqual([]);

describe("the draft's rules (pure)", () => {
  it("blanks are read from the text, once each, whatever the case", () => {
    expect(documentBlanks("<p>[Missing: phone number] and [Missing: Phone Number], [Missing: start date]</p>"))
      .toEqual(["phone number", "start date"]);
    expect(documentBlanks("<p>No blanks [here]</p>")).toEqual([]);
  });

  it("only what the editor holds is kept", () => {
    const out = sanitizeDocumentHtml(
      `<p style="x" onclick="evil()">Hi <b>there</b></p><script>steal()</script><img src=x onerror=1>` +
      `<a href="javascript:alert(1)">bad</a><a href="https://example.test/a">good</a><div>kept text</div>`);
    expect(out).toBe(`<p>Hi <b>there</b></p><a>bad</a><a href="https://example.test/a">good</a>kept text`);
  });

  it("a reply with no document in it is not a draft", () => {
    expect(parseDraftReply("TITLE: Nothing\n")).toBeNull();
    expect(parseDraftReply("Sorry.")).toBeNull();
  });

  it("plain text back becomes paragraphs", () => {
    const d = parseDraftReply("TITLE: A Note\nDear Sam,\n\nThank you for the lovely dinner last night.");
    expect(d?.title).toBe("A Note");
    expect(d?.html).toBe("<p>Dear Sam,</p><p>Thank you for the lovely dinner last night.</p>");
    expect(documentPlainText(d!.html)).toBe("Dear Sam,\nThank you for the lovely dinner last night.");
  });
});

describe("Document workspace AI", () => {
  it("returns a proposal — sanitized, with its blanks read from the text — and saves nothing", async () => {
    const res: any = await ai.assistDocument({ instruction: "Write a cover letter for a nursing position" });
    expect(res.ok).toBe(true);
    expect(res.title).toBe("Cover Letter for Nursing Position");
    expect(res.html).toContain("<h1>Tron Moore</h1>");
    expect(res.html).not.toMatch(/script|onclick|alert/);
    expect(res.blanks).toEqual(["phone number", "start date"]);
    expect(res.sources).toEqual(["your profile"]);
    expect(res.revised).toBe(false);
    expect(modelCalls).toHaveLength(1);
    noWrites();
  });

  it("the model is given the facts on file, never a secret, and only the people the request names", async () => {
    db.documents = [
      { id: "d1", name: "Resume 2026", type: "resume", tags: [], extractedData: { employer: "Mercy Hospital", years: "2019-2026" } },
      { id: "d2", name: "Piano warranty", type: "warranty", tags: [], extractedData: { serial: "PX-1" } },
    ];
    const res: any = await ai.assistDocument({ instruction: "Write a cover letter for a nursing position" });
    const prompt = promptOf(modelCalls[0]);
    expect(prompt).toContain("tron@example.test");
    expect(prompt).toContain("Mercy Hospital");
    expect(prompt).not.toContain("123-45-6789");
    expect(prompt).not.toContain("PX-1");
    expect(prompt).not.toContain("555-0100"); // Bob was not named
    expect(res.sources).toEqual(["your profile", '"Resume 2026"']);

    modelCalls = [];
    await ai.assistDocument({ instruction: "Write a letter introducing Bob to the school" });
    expect(promptOf(modelCalls[0])).toContain("555-0100");
  });

  it("with a document already on the page it is a revision of that document", async () => {
    const res: any = await ai.assistDocument({
      instruction: "Make the tone warmer", title: "My letter",
      html: "<p>Dear Sam, I am writing about the garden fence between our houses.</p>",
    });
    expect(res.revised).toBe(true);
    expect(promptOf(modelCalls[0])).toContain("CURRENT DOCUMENT");
    expect(promptOf(modelCalls[0])).toContain("garden fence");
    expect(String(modelCalls[0].system)).toMatch(/return the WHOLE document/);
  });

  it("the rule against inventing facts is in every request", async () => {
    await ai.assistDocument({ instruction: "Write a cover letter" });
    expect(String(modelCalls[0].system)).toMatch(/Never invent one/);
    expect(String(modelCalls[0].system)).toMatch(/\[Missing: <what is needed>\]/);
  });

  it("a failed model call, an empty answer and an empty instruction are errors, not documents", async () => {
    modelReply = new Error("overloaded");
    expect(await ai.assistDocument({ instruction: "Write a cover letter" })).toMatchObject({ ok: false, status: 502 });
    modelReply = "TITLE: Cover Letter\n";
    expect(await ai.assistDocument({ instruction: "Write a cover letter" })).toMatchObject({ ok: false, status: 502 });
    modelCalls = [];
    expect(await ai.assistDocument({ instruction: " " })).toMatchObject({ ok: false, status: 400 });
    expect(modelCalls).toHaveLength(0);
    noWrites();
  });
});

describe("Notes workspace AI", () => {
  it("returns the proposed note text and saves nothing", async () => {
    modelReply = "```markdown\n## Shopping\n- [ ] milk\n- [ ] eggs\n```";
    const res: any = await ai.assistNote({ instruction: "Turn this into a checklist", content: "milk, eggs" });
    expect(res).toEqual({ ok: true, content: "## Shopping\n- [ ] milk\n- [ ] eggs" });
    expect(promptOf(modelCalls[0])).toContain("milk, eggs");
    expect(String(modelCalls[0].system)).toMatch(/add none of your own/);
    noWrites();
  });

  it("an empty answer is an error", async () => {
    modelReply = "   ";
    expect(await ai.assistNote({ instruction: "Organize this note", content: "a" })).toMatchObject({ ok: false, status: 502 });
  });
});

describe("Journal workspace AI", () => {
  const entry = (id: string, date: string, content: string, linkedProfiles: string[] = [SELF.id]) =>
    ({ id, date, mood: "good", title: "", content, linkedProfiles, createdAt: `${date}T10:00:00Z` });

  it("answers from the writer's own entries and changes none of them", async () => {
    db.journal = [
      entry("j1", "2026-11-20", "Long walk by the river, felt calm."),
      entry("j2", "2026-11-21", "Bob had a rough day at school.", [BOB.id]),
    ];
    modelReply = "You wrote about a calm walk by the river on Nov 20.";
    const res: any = await ai.reflectOnJournal({ instruction: "Summarize my last week", draft: "Tired tonight." });
    expect(res).toEqual({ ok: true, answer: "You wrote about a calm walk by the river on Nov 20.", entriesRead: 2 });
    const prompt = promptOf(modelCalls[0]);
    expect(prompt).toContain("Long walk by the river");
    expect(prompt).toContain("Tired tonight.");
    expect(prompt).not.toContain("rough day at school"); // Bob's journal is not "my journal"
    expect(String(modelCalls[0].system)).toMatch(/do not rewrite the entries/);
    noWrites();
  });

  it("with nothing written there is nothing to read, and no model call", async () => {
    const res = await ai.reflectOnJournal({ instruction: "Summarize my last week" });
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(modelCalls).toHaveLength(0);
  });
});
