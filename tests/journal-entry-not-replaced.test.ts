// Journal tutorial QA (2026-11-20): "Saving a manual entry deletes the one you
// already had."
//
// The journal keeps one entry per day. Chat wrote today's entry; the Journal
// page's free-write composer then autosaved — POST (joined onto the day's
// entry, returning ITS id) followed by PATCH { content: <only what was typed
// here> }, which replaced the whole entry. These drive the real routes with
// the request sequence the composer now sends.
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
    if (journal.some((j) => j.date === d.date)) throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    const row = { id: `j-${journal.length + 1}`, tags: [], linkedProfiles: [], createdAt: new Date().toISOString(), ...d };
    journal.push(row); return { ...row };
  };
  storage.updateJournalEntry = async (id: string, patch: any) => {
    const row = journal.find((j) => j.id === id);
    if (!row) return undefined;
    Object.assign(row, patch); return { ...row };
  };
  storage.linkProfileTo = async () => undefined;
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
  it("is added to the day's entry; the composer's later autosaves change only its own passage", async () => {
    const api = await boot();
    const today = getUserToday(TZ);
    journal.push({ id: "j-chat", date: today, mood: "bad", content: CHAT_TEXT, tags: ["work"], linkedProfiles: ["self-1"], createdAt: new Date().toISOString() });

    // 1. First autosave: POST. The server joins it onto the day's entry.
    const first = await api("POST", "/api/journal", { content: "Walked the dog", entryDate: today, tags: [] });
    expect(first.status).toBe(200);
    expect(first.data.appended).toBe(true);
    expect(first.data.id).toBe("j-chat");

    // 2. The user keeps typing; the composer edits ITS passage only.
    const second = await api("PATCH", "/api/journal/j-chat", { find: "Walked the dog", replace: "Walked the dog and cooked dinner", addTags: ["home"] });
    expect(second.status).toBe(200);

    expect(journal).toHaveLength(1);
    expect(journal[0].content).toBe(`${CHAT_TEXT}\n\nWalked the dog and cooked dinner`);
    // The earlier text, its mood and its tags are all still there.
    expect(journal[0].content.startsWith(CHAT_TEXT)).toBe(true);
    expect(journal[0].mood).toBe("bad");
    expect(journal[0].tags).toEqual(["work", "home"]);
  });

  it("a passage that is no longer in the entry is added, never used to overwrite it", async () => {
    const api = await boot();
    const today = getUserToday(TZ);
    journal.push({ id: "j-1", date: today, mood: "good", content: "Morning pages.", tags: [], linkedProfiles: [], createdAt: new Date().toISOString() });
    const r = await api("PATCH", "/api/journal/j-1", { find: "text that was edited away elsewhere", replace: "Evening thoughts." });
    expect(r.status).toBe(200);
    expect(journal[0].content).toBe("Morning pages.\n\nEvening thoughts.");
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

  it("text with no feeling in it leaves the day's mood alone", async () => {
    const api = await boot();
    const today = getUserToday(TZ);
    journal.push({ id: "j-1", date: today, mood: "bad", content: CHAT_TEXT, tags: [], linkedProfiles: [], createdAt: new Date().toISOString() });
    await api("POST", "/api/journal", { content: "Also went grocery shopping.", entryDate: today });
    expect(journal[0].mood).toBe("bad");
    expect(journal[0].content).toContain("Also went grocery shopping.");
  });
});

describe("entry date", () => {
  it("a backdated entry is filed under the day it is about", async () => {
    const api = await boot();
    const r = await api("POST", "/api/journal", { content: "Long drive home.", entryDate: "2026-11-01" });
    expect(r.status).toBe(201);
    expect(journal[0].date).toBe("2026-11-01");
  });

  it("moving an entry onto a day that has one is refused by name", async () => {
    const api = await boot();
    journal.push(
      { id: "j-1", date: "2026-11-01", mood: "good", content: "A", tags: [], linkedProfiles: [] },
      { id: "j-2", date: "2026-11-02", mood: "good", content: "B", tags: [], linkedProfiles: [] },
    );
    const r = await api("PATCH", "/api/journal/j-2", { date: "2026-11-01" });
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/already have a journal entry for 2026-11-01/);
    expect(journal.find((j) => j.id === "j-2").date).toBe("2026-11-02");
  });
});
