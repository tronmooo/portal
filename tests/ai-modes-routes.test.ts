// Custom AI Modes through the REAL routes (owner request 2026-11-27).
//
//  - Every change is applied to the STORED row by its own route (Rule 6) and
//    answers with the whole list; the generic preferences route refuses the row.
//  - Building and revising answer with a PROPOSAL and write nothing (W5) —
//    with no model, the fixed rules still answer.
//  - Deleting a mode forgets its conversation too.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { requestStorageContext } from "../server/storage";
import { registerRoutes } from "../server/routes";
import { makeFakeStorage, type FakeDb } from "./helpers/route-harness";
import { AI_MODES_PREF, MODE_TEMPLATES, modeFromTemplate, parseAiModes } from "../shared/ai-modes";

let seq = 0;
let server: Server | null = null;
let db: FakeDb;
const savedKey = process.env.ANTHROPIC_API_KEY;

async function boot() {
  db = {
    profiles: [{ id: "self-1", type: "self", name: "Sam Rivera", fields: {} }], liabilityPayments: [], expenses: [], incomes: [],
    obligations: [], tasks: [], events: [], documents: [], trackers: [], getDocumentCalls: 0,
    bumpDataVersionCalls: 0, domainVersions: {}, lastBumpedDomains: [], preferences: {},
  } as any;
  const storage: any = makeFakeStorage(db);
  const app = express();
  app.use(express.json());
  const userId = `modes-user-${++seq}`;
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
beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });
afterEach(async () => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});
const stored = () => parseAiModes(db.preferences?.[AI_MODES_PREF] ?? null);
const coach = () => modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "life-coach")!, [], new Date());

describe("the list of modes", () => {
  it("create, change, pin, duplicate, reorder, delete — each on the stored row", async () => {
    const api = await boot();
    expect((await api("GET", "/api/workspace/modes")).data).toEqual({ modes: [] });

    const created = await api("POST", "/api/workspace/modes", { mode: { ...coach(), access: ["tasks", "journal"] } });
    expect(created.status).toBe(201);
    expect(created.data.mode).toMatchObject({ id: "life-coach", name: "Life Coach" });
    // The person saved it with the journal on: that is their switch, and it is kept.
    expect(stored()[0].access).toEqual(["tasks", "journal"]);

    const patched = await api("PATCH", "/api/workspace/modes/life-coach", { patch: { name: "Coach Kim", pinned: true, id: "hijack" } });
    expect(patched.status).toBe(200);
    expect(patched.data.mode).toMatchObject({ id: "life-coach", name: "Coach Kim", pinned: true });

    const copy = await api("POST", "/api/workspace/modes/life-coach/duplicate");
    expect(copy.status).toBe(201);
    expect(copy.data.mode).toMatchObject({ id: "coach-kim-copy", name: "Coach Kim (copy)", pinned: false });
    expect(stored().map((m) => m.id)).toEqual(["life-coach", "coach-kim-copy"]);

    expect((await api("POST", "/api/workspace/modes/order", { ids: ["coach-kim-copy", "life-coach"] })).data.modes.map((m: any) => m.id)).toEqual(["coach-kim-copy", "life-coach"]);
    expect(stored().map((m) => m.id)).toEqual(["coach-kim-copy", "life-coach"]);

    // Deleting forgets its conversation and memories too.
    db.preferences!["ai_memory:mode-life-coach"] = JSON.stringify({ memories: [{ id: "m1", text: "Sam is training for a 10k", at: "2026-11-20T00:00:00Z", by: "ai" }], turns: [], lastTalked: null });
    const del = await api("DELETE", "/api/workspace/modes/life-coach");
    expect(del.status).toBe(200);
    expect(stored().map((m) => m.id)).toEqual(["coach-kim-copy"]);
    expect(JSON.parse(db.preferences!["ai_memory:mode-life-coach"]).memories).toEqual([]);

    expect((await api("DELETE", "/api/workspace/modes/life-coach")).status).toBe(404);
    expect((await api("PATCH", "/api/workspace/modes/nope", { patch: { name: "X" } })).status).toBe(404);
  });

  it("an invalid mode is refused and nothing is written", async () => {
    const api = await boot();
    expect((await api("POST", "/api/workspace/modes", { mode: { name: "" } })).status).toBe(400);
    expect((await api("POST", "/api/workspace/modes", { mode: "<script>" })).status).toBe(400);
    expect(db.preferences![AI_MODES_PREF]).toBeUndefined();
  });

  it("the generic preferences route cannot write the modes row", async () => {
    const api = await boot();
    const r = await api("PUT", `/api/preferences/${AI_MODES_PREF}`, { value: JSON.stringify({ modes: [{ id: "x", name: "Injected" }] }) });
    expect(r.status).toBe(400);
    expect(db.preferences![AI_MODES_PREF]).toBeUndefined();
  });
});

describe("building and revising write nothing", () => {
  it("with no model, a description still becomes a proposal by the fixed rules — and nothing is saved", async () => {
    const api = await boot();
    const r = await api("POST", "/api/workspace/modes/generate", { description: "An AI that helps me understand myself emotionally" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ by: "rules", suggestJournal: true });
    expect(r.data.mode.name).toBe("Personal Reflection");
    expect(r.data.mode.access).not.toContain("journal");
    expect(db.preferences![AI_MODES_PREF]).toBeUndefined();
    expect((await api("POST", "/api/workspace/modes/generate", { description: "" })).status).toBe(400);
  });

  it("a revision is a proposal; the stored mode is unchanged until it is applied", async () => {
    const api = await boot();
    await api("POST", "/api/workspace/modes", { mode: modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "fitness")!, [], new Date()) });
    const before = db.preferences![AI_MODES_PREF];
    const r = await api("POST", "/api/workspace/modes/revise", { modeId: "fitness-coach", instruction: "Add a sleep analysis tab and compare my sleep against my workout performance" });
    expect(r.status).toBe(200);
    expect(r.data.mode.tabs.map((t: any) => t.title)).toContain("Sleep");
    expect(db.preferences![AI_MODES_PREF]).toBe(before);
    // Something the rules cannot read, with no model, is refused — never guessed.
    expect((await api("POST", "/api/workspace/modes/revise", { modeId: "fitness-coach", instruction: "make it sing" })).status).toBe(503);
  });

  it("chat and analysis say plainly when there is no model, and write nothing", async () => {
    const api = await boot();
    await api("POST", "/api/workspace/modes", { mode: coach() });
    const before = JSON.stringify(db.preferences);
    expect((await api("POST", "/api/workspace/modes/chat", { modeId: "life-coach", messages: [{ role: "user", content: "hi" }] })).status).toBe(503);
    expect((await api("POST", "/api/workspace/modes/insights", { modeId: "life-coach", tabId: "patterns" })).status).toBe(503);
    expect((await api("POST", "/api/workspace/modes/insights", { modeId: "missing", tabId: "patterns" })).status).toBe(404);
    expect(JSON.stringify(db.preferences)).toBe(before);
  });

  it("a mode's memory is read through the shared memory routes, under its own switch", async () => {
    const api = await boot();
    await api("POST", "/api/workspace/modes", { mode: { ...coach(), remember: false } });
    const r = await api("GET", "/api/workspace/memory/mode-life-coach");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ remember: false, memories: [], turns: [] });
    expect((await api("GET", "/api/workspace/memory/mode-..%2Fx")).status).toBe(400);
  });
});
