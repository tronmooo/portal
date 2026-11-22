// The chat box's Document button (owner request 2026-11-22): the message is a
// request for a document, written from the facts on file and saved as an
// editable doc. The draft never invents a personal fact: what is not on file
// is a marked blank, and the blanks the reply lists are read back from the
// saved text, not from what the model says.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { documentBlanks, parseDraftReply, sanitizeDocumentHtml, documentPlainText } from "../shared/workspace-document";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

type Row = Record<string, any>;
const SELF = { id: "p-self", name: "Tron Moore", type: "self", fields: { email: "tron@example.test", occupation: "Nurse", ssn: "123-45-6789" } };
const BOB = { id: "p-bob", name: "Bob Robertson", type: "person", fields: { phone: "555-0100" } };
const db: { profiles: Row[]; documents: Row[]; artifacts: Row[]; entries: Row[] } = { profiles: [], documents: [], artifacts: [], entries: [] };

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => db.profiles,
    getSelfProfile: async () => SELF,
    getDocuments: async () => db.documents,
    getArtifacts: async () => db.artifacts,
    createArtifact: async (d: Row) => { const row = { id: `a${db.artifacts.length + 1}`, createdAt: new Date().toISOString(), ...d }; db.artifacts.push(row); return row; },
    logEntry: async (d: Row) => { db.entries.push(d); return { id: "e1", ...d }; },
    getPreference: async () => null,
  };
  return { storage: new Proxy(impl, { get: (t, p: string) => (p in t ? t[p] : async () => []) }) };
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

let processMessage: (msg: string, history?: any[], userId?: string, options?: Row) => Promise<any>;
beforeEach(async () => {
  db.profiles = [SELF, BOB]; db.documents = []; db.artifacts = []; db.entries = [];
  modelReply = LETTER; modelCalls = [];
  ({ processMessage } = await import("../server/ai-engine"));
});
const docBtn = (msg: string) => processMessage(msg, [], "u1", { workspace: { mode: "document" } });
const promptOf = (call: Row) => String(call.messages?.[0]?.content ?? "");

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

describe("Document button", () => {
  it("saves one editable doc, written from the profile, and nothing else", async () => {
    const res = await docBtn("Write a cover letter for a nursing position. I ran 3 miles today.");
    expect(db.artifacts).toHaveLength(1);
    const doc = db.artifacts[0];
    expect(doc).toMatchObject({ type: "doc", title: "Cover Letter for Nursing Position" });
    expect(doc.content).toContain("<h1>Tron Moore</h1>");
    expect(doc.content).not.toMatch(/script|onclick|alert/);
    // One model call (the draft); the chat tool loop never ran, so the run is not logged.
    expect(modelCalls).toHaveLength(1);
    expect(db.entries).toHaveLength(0);
    // The card opens the editor: it carries the saved id and the doc type.
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0]).toMatchObject({ type: "create_artifact", data: { id: doc.id, type: "doc" } });
    expect(res.mutations?.[0]?.domains).toContain("artifacts");
  });

  it("the reply lists the blanks that are in the saved text, and says nothing was guessed", async () => {
    const res = await docBtn("Write a cover letter for a nursing position");
    expect(res.reply).toBe(
      'Drafted "Cover Letter for Nursing Position" and saved it to your documents. I used your profile. ' +
      "2 blanks are marked [Missing: …] because I don't have them on file: phone number and start date. I did not guess. " +
      "Open it to edit, or to export it as PDF or Word.");
    expect(res.actions[0].data.missing).toEqual(["phone number", "start date"]);
  });

  it("the model is given the facts on file, never a secret, and only the people the request names", async () => {
    db.documents = [
      { id: "d1", name: "Resume 2026", type: "resume", tags: [], extractedData: { employer: "Mercy Hospital", years: "2019-2026" } },
      { id: "d2", name: "Piano warranty", type: "warranty", tags: [], extractedData: { serial: "PX-1" } },
    ];
    const res = await docBtn("Write a cover letter for a nursing position");
    const prompt = promptOf(modelCalls[0]);
    expect(prompt).toContain("tron@example.test");
    expect(prompt).toContain("Mercy Hospital");
    expect(prompt).not.toContain("123-45-6789");
    expect(prompt).not.toContain("PX-1");
    expect(prompt).not.toContain("555-0100"); // Bob was not named
    expect(res.reply).toContain('I used your profile and "Resume 2026".');

    modelCalls = [];
    await docBtn("Write a letter introducing Bob to the school");
    expect(promptOf(modelCalls[0])).toContain("555-0100");
  });

  it("the rule against inventing facts is in every draft request", async () => {
    await docBtn("Write a cover letter");
    expect(String(modelCalls[0].system)).toMatch(/Never invent one/);
    expect(String(modelCalls[0].system)).toMatch(/\[Missing: <what is needed>\]/);
  });

  it("a failed model call saves nothing and says so", async () => {
    modelReply = new Error("overloaded");
    const res = await docBtn("Write a cover letter for a nursing position");
    expect(db.artifacts).toHaveLength(0);
    expect(res.actions).toEqual([]);
    expect(res.reply).toMatch(/Nothing was saved/);
  });

  it("an empty answer saves nothing", async () => {
    modelReply = "TITLE: Cover Letter\n";
    const res = await docBtn("Write a cover letter for a nursing position");
    expect(db.artifacts).toHaveLength(0);
    expect(res.reply).toMatch(/Nothing was saved/);
  });

  it("without the button, the same words are an ordinary chat turn", async () => {
    modelReply = "Sure — here are some tips for cover letters.";
    await processMessage("Write a cover letter for a nursing position", [], "u1", {});
    expect(db.artifacts.filter((a) => a.type === "doc")).toHaveLength(0);
  });
});
