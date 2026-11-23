// The Journal page's routes.
//
// History: the journal used to keep ONE entry per day. The free-write
// composer's autosave then replaced the entry chat had written that morning
// (Journal tutorial QA, 2026-11-20). The one-per-day rule is gone (owner
// decision, same day): every save from the page is its own entry, a day can
// hold several, and each has a title. These drive the real routes with the
// request sequence the composer sends.
import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { requestStorageContext } from "../server/storage";
import { registerRoutes } from "../server/routes";
import { makeFakeStorage, type FakeDb } from "./helpers/route-harness";
import { getUserToday } from "../shared/timezone";

const TZ = "America/Los_Angeles";
let seq = 0;
let server: Server | null = null;
let journal: any[] = [];

async function boot() {
  const db: FakeDb = {
    profiles: [{ id: "self-1", type: "self", name: "Me", fields: {} }], liabilityPayments: [], expenses: [], incomes: [],
    obligations: [], tasks: [], events: [], documents: [], trackers: [], getDocumentCalls: 0,
    bumpDataVersionCalls: 0, domainVersions: {}, lastBumpedDomains: [],
  };
  const storage: any = makeFakeStorage(db);
  journal = [];
  storage.getJournalEntries = async () => journal.map((j) => ({ ...j }));
  storage.createJournalEntry = async (d: any) => {
    const row = { id: `j-${journal.length + 1}`, tags: [], linkedProfiles: [], createdAt: new Date().toISOString(), ...d };
    journal.push(row); return { ...row };
  };
  storage.updateJournalEntry = async (id: string, patch: any) => {
    const row = journal.find((j) => j.id === id);
    if (!row) return undefined;
    Object.assign(row, patch); return { ...row };
  };
  storage.linkProfileTo = async () => undefined;
  const notes: any[] = [];
  storage.getArtifacts = async () => notes;
  storage.createArtifact = async (d: any) => { const row = { id: `n-${notes.length + 1}`, ...d }; notes.push(row); return row; };
  const app = express();
  app.use(express.json());
  const userId = `journal-user-${++seq}`;
  app.use((req, _res, next) => { (req as any).userId = userId; requestStorageContext.run(storage, () => next()); });
  server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (method: string, path: string, body?: any) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", "X-Timezone": TZ }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}
afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

const CHAT_TEXT = "I'm feeling frustrated and overwhelmed with work today.";

describe("a manual entry on a day that already has one", () => {
  it("is a NEW entry; the earlier one is untouched, and the composer's autosaves edit only its own row", async () => {
    const api = await boot();
    const today = getUserToday(TZ);
    journal.push({ id: "j-chat", date: today, mood: "bad", title: "Rough Day At Work", content: CHAT_TEXT, tags: ["work"], linkedProfiles: ["self-1"], createdAt: new Date(Date.now() - 60_000).toISOString() });

    // 1. First autosave, mid-sentence: a draft row of its own.
    const first = await api("POST", "/api/journal", { content: "W", entryDate: today, tags: [], draft: true });
    expect(first.status).toBe(201);
    expect(first.data.id).not.toBe("j-chat");

    // 2. The user keeps typing; then saves with no title typed.
    await api("PATCH", `/api/journal/${first.data.id}`, { content: "Walked the dog", tags: ["home"], mood: "neutral" });
    const saved = await api("PATCH", `/api/journal/${first.data.id}`, { content: "Walked the dog and cooked dinner", tags: ["home"], mood: "neutral", autoTitle: true });
    expect(saved.status).toBe(200);

    expect(journal).toHaveLength(2);
    const chat = journal.find((j) => j.id === "j-chat");
    expect(chat).toMatchObject({ content: CHAT_TEXT, mood: "bad", title: "Rough Day At Work", tags: ["work"] });
    const mine = journal.find((j) => j.id === first.data.id);
    expect(mine.content).toBe("Walked the dog and cooked dinner");
    // With no model key in the test, the title falls back to the text itself.
    expect(mine.title).toBe("Walked the dog and cooked dinner");
  });

  it("a draft that begins like an existing entry still gets its own row", async () => {
    const api = await boot();
    const today = getUserToday(TZ);
    journal.push({ id: "j-1", date: today, mood: "good", content: "I walked the dog", tags: [], linkedProfiles: [], createdAt: new Date().toISOString() });
    const r = await api("POST", "/api/journal", { content: "I", entryDate: today, draft: true });
    expect(r.status).toBe(201);
    expect(r.data.id).not.toBe("j-1");
    expect(journal.find((j) => j.id === "j-1").content).toBe("I walked the dog");
  });

  it("the same finished entry saved twice is one entry", async () => {
    const api = await boot();
    const a = await api("POST", "/api/journal", { content: "Quiet day at home, read a book." });
    const b = await api("POST", "/api/journal", { content: "Quiet day at home, read a book." });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.data.deduped).toBe(true);
    expect(journal).toHaveLength(1);
  });

  it("find/replace still edits one passage of the stored text", async () => {
    const api = await boot();
    journal.push({ id: "j-1", date: getUserToday(TZ), mood: "good", content: "Morning pages. Walked the dog.", tags: [], linkedProfiles: [] });
    const r = await api("PATCH", "/api/journal/j-1", { find: "Walked the dog.", replace: "Walked the dog twice." });
    expect(r.status).toBe(200);
    expect(journal[0].content).toBe("Morning pages. Walked the dog twice.");
  });
});

describe("titles", () => {
  it("a typed title is kept", async () => {
    const api = await boot();
    const r = await api("POST", "/api/journal", { content: "Long drive home through the rain.", title: "The Drive Back" });
    expect(r.data.title).toBe("The Drive Back");
  });

  it("a saved entry with no title gets one; a draft does not ask for one", async () => {
    const api = await boot();
    const saved = await api("POST", "/api/journal", { content: "Long drive home through the rain. Glad to be back." });
    expect(saved.data.title).toBe("Long drive home through the rain");
    const draft = await api("POST", "/api/journal", { content: "Another thought", draft: true });
    // The draft's placeholder title is its text; the real one comes on save.
    expect(draft.data.title).toBe("Another thought");
  });

  it("a note with no title gets one from its text", async () => {
    const api = await boot();
    const r = await api("POST", "/api/notes", { content: "Buy new tires for the Honda before winter. Check the spare too." });
    expect(r.status).toBe(201);
    expect(r.data.title).toBe("Buy new tires for the Honda before winter");
  });
});

describe("mood", () => {
  it("is detected from the text when none was picked", async () => {
    const api = await boot();
    const r = await api("POST", "/api/journal", { content: CHAT_TEXT });
    expect(r.status).toBe(201);
    expect(r.data.mood).toBe("bad");
  });

  it("a PICKED mood is kept, whatever the text says", async () => {
    const api = await boot();
    const r = await api("POST", "/api/journal", { content: "A great day, honestly.", mood: "neutral" });
    expect(r.data.mood).toBe("neutral");
  });
});

describe("entry date", () => {
  it("a backdated entry is filed under the day it is about", async () => {
    const api = await boot();
    const r = await api("POST", "/api/journal", { content: "Long drive home.", entryDate: "2026-11-01" });
    expect(r.status).toBe(201);
    expect(journal[0].date).toBe("2026-11-01");
  });

  it("an entry can be moved onto a day that already has one", async () => {
    const api = await boot();
    journal.push(
      { id: "j-1", date: "2026-11-01", mood: "good", content: "A", tags: [], linkedProfiles: [] },
      { id: "j-2", date: "2026-11-02", mood: "good", content: "B", tags: [], linkedProfiles: [] },
    );
    const r = await api("PATCH", "/api/journal/j-2", { date: "2026-11-01" });
    expect(r.status).toBe(200);
    expect(journal.map((j) => j.date)).toEqual(["2026-11-01", "2026-11-01"]);
  });
});

describe("length (owner request 2026-11-23: unlimited-length entries)", () => {
  // The general input cleaner cut every text at 10,000 characters and still
  // answered 201: a long entry lost its end without a word.
  const LONG = Array.from({ length: 6000 }, (_, i) => `word${i}`).join(" ") + "\n\nThe last line.";

  it("a long journal entry is stored whole, on create and on every autosave", async () => {
    const api = await boot();
    expect(LONG.length).toBeGreaterThan(40_000);
    const created = await api("POST", "/api/journal", { content: LONG, entryDate: getUserToday(TZ), tags: [], draft: true });
    expect(created.status).toBe(201);
    expect(journal[0].content).toBe(LONG);
    const longer = `${LONG}\nOne more.`;
    await api("PATCH", `/api/journal/${created.data.id}`, { content: longer, tags: [], mood: "neutral" });
    expect(journal[0].content).toBe(longer);
  });

  it("a long note is stored whole", async () => {
    const api = await boot();
    const r = await api("POST", "/api/notes", { title: "Long", content: LONG, tags: [] });
    expect(r.status).toBe(201);
    expect(r.data.content).toBe(LONG);
  });
});
