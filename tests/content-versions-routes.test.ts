// Version history, through the real routes (owner request 2026-11-25: "view
// and restore previous document versions"; "version history and undo").
//
// A save that replaces a note's, an entry's or a document's text keeps the
// text it replaced — one version per sitting, not one per autosave. Restoring
// puts an older text back AND keeps what it replaced, so a restore can be
// undone. Deleting the record deletes its versions. The versions row cannot
// be written through the generic preferences route.
import { describe, it, expect, afterEach, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { requestStorageContext } from "../server/storage";
import { registerRoutes } from "../server/routes";
import { makeFakeStorage, type FakeDb } from "./helpers/route-harness";
import { VERSION_MIN_GAP_MS, versionsKey } from "../shared/content-versions";

let seq = 0;
let server: Server | null = null;
let db: FakeDb & { preferences?: Record<string, string> };
let artifacts: any[] = [];
let journal: any[] = [];

async function boot() {
  db = {
    profiles: [{ id: "self-1", type: "self", name: "Me", fields: {} }], liabilityPayments: [], expenses: [], incomes: [],
    obligations: [], tasks: [], events: [], documents: [], trackers: [], getDocumentCalls: 0,
    bumpDataVersionCalls: 0, domainVersions: {}, lastBumpedDomains: [],
  } as any;
  const storage: any = makeFakeStorage(db);
  artifacts = [
    { id: "note-1", type: "note", title: "Plan", content: "first text", tags: ["work", "category:Old"], items: [], linkedProfiles: [], pinned: false },
    { id: "doc-1", type: "doc", title: "Letter", content: "<p>Dear Sam, first.</p>", tags: [], items: [], linkedProfiles: [], pinned: false },
    { id: "list-1", type: "checklist", title: "A list", content: "", tags: [], items: [], linkedProfiles: [], pinned: false },
  ];
  journal = [{ id: "j-1", date: "2026-11-20", mood: "okay", content: "morning words", tags: [], linkedProfiles: [], createdAt: "2026-11-20T08:00:00Z", energy: 3 }];
  storage.getArtifacts = async () => artifacts.map((a) => ({ ...a }));
  storage.getArtifact = async (id: string) => { const a = artifacts.find((x) => x.id === id); return a ? { ...a } : undefined; };
  storage.updateArtifact = async (id: string, patch: any) => { const a = artifacts.find((x) => x.id === id); if (!a) return undefined; Object.assign(a, patch); return { ...a }; };
  storage.deleteArtifact = async (id: string) => { const n = artifacts.length; artifacts = artifacts.filter((x) => x.id !== id); return artifacts.length < n; };
  storage.getJournalEntries = async () => journal.map((j) => ({ ...j }));
  storage.updateJournalEntry = async (id: string, patch: any) => { const j = journal.find((x) => x.id === id); if (!j) return undefined; Object.assign(j, patch); return { ...j }; };
  storage.deleteJournalEntry = async (id: string) => { const n = journal.length; journal = journal.filter((x) => x.id !== id); return journal.length < n; };
  const app = express();
  app.use(express.json());
  const userId = `versions-user-${++seq}`;
  app.use((req, _res, next) => { (req as any).userId = userId; requestStorageContext.run(storage, () => next()); });
  server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (method: string, path: string, body?: any) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}
afterEach(async () => { vi.useRealTimers(); if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

/** Move the clock past one sitting, so the next save keeps a version. */
const nextSitting = () => {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ["Date"], now: now + VERSION_MIN_GAP_MS + 60_000 });
};
const stored = (kind: "note" | "journal" | "document", id: string) => JSON.parse(db.preferences?.[versionsKey(kind, id)] || "[]");

describe("a note's versions", () => {
  it("the text a save replaces is kept; autosaves in one sitting are one version", async () => {
    const api = await boot();
    expect((await api("GET", "/api/workspace/versions/note/note-1")).data).toEqual({ versions: [] });

    expect((await api("PATCH", "/api/notes/note-1", { content: "second text" })).status).toBe(200);
    // Two more autosaves moments later: the same sitting.
    await api("PATCH", "/api/notes/note-1", { content: "second text, more" });
    await api("PATCH", "/api/notes/note-1", { content: "second text, more still" });
    let list = (await api("GET", "/api/workspace/versions/note/note-1")).data.versions;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "Plan", preview: "first text", words: 2, reason: "edit" });
    expect(list[0].content).toBeUndefined(); // the list carries no bodies

    nextSitting();
    await api("PATCH", "/api/notes/note-1", { content: "third text" });
    list = (await api("GET", "/api/workspace/versions/note/note-1")).data.versions;
    expect(list.map((v: any) => v.preview)).toEqual(["second text, more still", "first text"]);
  });

  it("a save that does not change the text keeps nothing", async () => {
    const api = await boot();
    await api("PATCH", "/api/notes/note-1", { title: "Renamed" });
    await api("PATCH", "/api/notes/note-1", { content: "first text" });
    await api("PATCH", "/api/notes/note-1", { tags: ["x"] });
    expect(stored("note", "note-1")).toEqual([]);
  });

  it("restore puts the old text back and keeps what it replaced, so it can be undone", async () => {
    const api = await boot();
    await api("PATCH", "/api/notes/note-1", { content: "second text" });
    const [first] = (await api("GET", "/api/workspace/versions/note/note-1")).data.versions;
    expect((await api("GET", `/api/workspace/versions/note/note-1/${first.id}`)).data).toMatchObject({ id: first.id, content: "first text" });

    const restored = await api("POST", "/api/workspace/versions/note/note-1/restore", { versionId: first.id });
    expect(restored.status).toBe(200);
    expect(restored.data.record).toMatchObject({ id: "note-1", content: "first text", title: "Plan" });
    expect(artifacts.find((a) => a.id === "note-1").content).toBe("first text");
    // Kept at once (forced), although the last version is seconds old.
    const list = (await api("GET", "/api/workspace/versions/note/note-1")).data.versions;
    expect(list.map((v: any) => [v.preview, v.reason])).toEqual([["second text", "restore"], ["first text", "edit"]]);

    // Undo the restore: restore the version it kept.
    const undo = await api("POST", "/api/workspace/versions/note/note-1/restore", { versionId: list[0].id });
    expect(undo.data.record.content).toBe("second text");
    // Restoring what is already saved is refused, not repeated.
    expect((await api("POST", "/api/workspace/versions/note/note-1/restore", { versionId: list[0].id })).status).toBe(409);
  });

  it("deleting the note deletes its versions", async () => {
    const api = await boot();
    await api("PATCH", "/api/notes/note-1", { content: "second text" });
    expect(stored("note", "note-1")).toHaveLength(1);
    expect((await api("DELETE", "/api/notes/note-1")).status).toBe(200);
    expect(stored("note", "note-1")).toEqual([]);
    expect((await api("GET", "/api/workspace/versions/note/note-1")).status).toBe(404);
  });
});

describe("an entry's and a document's versions", () => {
  it("a journal entry keeps its replaced text, restores it, and forgets it when deleted", async () => {
    const api = await boot();
    await api("PATCH", "/api/journal/j-1", { content: "evening rewrite", mood: "good" });
    const [v] = (await api("GET", "/api/workspace/versions/journal/j-1")).data.versions;
    expect(v.preview).toBe("morning words");
    const r = await api("POST", "/api/workspace/versions/journal/j-1/restore", { versionId: v.id });
    expect(r.data.record).toMatchObject({ content: "morning words", mood: "good" }); // only the text went back
    await api("DELETE", "/api/journal/j-1");
    expect(stored("journal", "j-1")).toEqual([]);
  });

  it("a document keeps its replaced text; the list is read as text, not markup", async () => {
    const api = await boot();
    await api("PATCH", "/api/artifacts/doc-1", { content: "<p>Dear Sam, second.</p>" });
    const [v] = (await api("GET", "/api/workspace/versions/document/doc-1")).data.versions;
    expect(v).toMatchObject({ preview: "Dear Sam, first.", words: 3 });
    const r = await api("POST", "/api/workspace/versions/document/doc-1/restore", { versionId: v.id });
    expect(r.data.record.content).toBe("<p>Dear Sam, first.</p>");
    await api("DELETE", "/api/artifacts/doc-1");
    expect(stored("document", "doc-1")).toEqual([]);
  });

  it("a version belongs to its own kind of record, and a missing one is a 404", async () => {
    const api = await boot();
    expect((await api("GET", "/api/workspace/versions/document/note-1")).status).toBe(404); // a note is not a document
    expect((await api("GET", "/api/workspace/versions/note/list-1")).status).toBe(404); // a checklist is neither
    expect((await api("GET", "/api/workspace/versions/sheet/doc-1")).status).toBe(400);
    expect((await api("POST", "/api/workspace/versions/note/note-1/restore", { versionId: "nope" })).status).toBe(404);
    expect((await api("POST", "/api/workspace/versions/note/note-1/restore", {})).status).toBe(400);
    expect(artifacts.find((a) => a.id === "note-1").content).toBe("first text");
  });

  it("the versions row is not writable through the preferences route", async () => {
    const api = await boot();
    const r = await api("PUT", `/api/preferences/${encodeURIComponent(versionsKey("note", "note-1"))}`, { value: JSON.stringify([{ id: "forged", savedAt: new Date().toISOString(), title: "", content: "forged text", reason: "edit" }]) });
    expect(r.status).toBe(400);
    expect(stored("note", "note-1")).toEqual([]);
  });
});

describe("filing and clearing, on the stored row", () => {
  it("a category alone is applied to the note's stored tags: its other tags stay", async () => {
    const api = await boot();
    const r = await api("PATCH", "/api/notes/note-1", { category: "Travel" });
    expect(r.data.tags).toEqual(["work", "category:Travel"]);
    expect((await api("PATCH", "/api/notes/note-1", { category: "" })).data.tags).toEqual(["work"]);
  });

  it("a favorite is the note's own flag", async () => {
    const api = await boot();
    const r = await api("PATCH", "/api/artifacts/note-1", { pinned: true });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ pinned: true, content: "first text", tags: ["work", "category:Old"] });
    expect(stored("note", "note-1")).toEqual([]); // not a text change
  });

  it("an entry's energy can be taken off again", async () => {
    const api = await boot();
    expect((await api("PATCH", "/api/journal/j-1", { energy: 5 })).data.energy).toBe(5);
    const cleared = await api("PATCH", "/api/journal/j-1", { energy: null });
    expect(cleared.status).toBe(200);
    expect(journal[0].energy).toBeNull();
    expect((await api("PATCH", "/api/journal/j-1", { energy: 9 })).status).toBe(400);
  });
});

// Integrity run, 2026-11-28: the replaced text was kept AFTER the write, so a
// failure between the two lost it. It is kept first now, in all three routes.
describe("the replaced text is kept before the write", () => {
  const src = require("node:fs").readFileSync(`${process.cwd()}/server/routes.ts`, "utf8") as string;
  for (const [route, write] of [
    ['app.patch("/api/notes/:id"', "await updateNote(storage, req.params.id, changes)"],
    ['app.patch("/api/artifacts/:id"', "await storage.updateArtifact(req.params.id, req.body)"],
    ['app.patch("/api/journal/:id"', "await storage.updateJournalEntry(req.params.id, req.body)"],
  ] as const) {
    it(route, () => {
      const at = src.indexOf(route);
      expect(at).toBeGreaterThan(0);
      const body = src.slice(at, src.indexOf("\n  }));", at));
      const keep = body.indexOf("keepVersionBeforeWrite(");
      const w = body.indexOf(write);
      expect(keep).toBeGreaterThan(0);
      expect(w).toBeGreaterThan(keep);
    });
  }
});
