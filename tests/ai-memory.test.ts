// What the Reflection Coach and the Notes assistant remember between sittings
// (owner, 2026-11-25: "the memory for the AI therapist … make it human").
// The pure rules (shared/ai-memory.ts) and the real routes the person uses to
// read and change that memory.
import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { requestStorageContext } from "../server/storage";
import { registerRoutes } from "../server/routes";
import { makeFakeStorage, type FakeDb } from "./helpers/route-harness";
import {
  CHAT_SAVED_TURNS, EMPTY_MEMORY, MEMORY_MAX_ITEMS, MEMORY_PER_REPLY, addMemories, appendExchange, explicitMemoryRequest, looksClinical, memoryKey, parseAiMemory,
  removeMemory, sinceLastTalked, splitReplyAndMemories,
} from "../shared/ai-memory";
import { WORKSPACE_AI_ACCESS_PREF, DEFAULT_WORKSPACE_AI_ACCESS, serializeWorkspaceAiAccess, withAccess } from "../shared/workspace-access";

const NOW = new Date("2026-11-25T18:00:00Z");

describe("the reply and what it proposes to remember", () => {
  it("the remember-tail is never shown, readable or not", () => {
    expect(splitReplyAndMemories('That sounds like a lot to carry.\n\nREMEMBER: ["Sam is their partner", "They work nights"]'))
      .toEqual({ answer: "That sounds like a lot to carry.", remember: ["Sam is their partner", "They work nights"] });
    expect(splitReplyAndMemories("Glad it went well.")).toEqual({ answer: "Glad it went well.", remember: [] });
    // Broken machinery is dropped, not printed.
    expect(splitReplyAndMemories("Okay.\nREMEMBER: [not json")).toEqual({ answer: "Okay.", remember: [] });
    expect(splitReplyAndMemories('Okay.\nREMEMBER: {"a":1}')).toEqual({ answer: "Okay.", remember: [] });
    // At most a few per reply, and only strings.
    expect(splitReplyAndMemories(`Hi.\nREMEMBER: ${JSON.stringify(["a fact one", 7, "a fact two", "a fact three", "a fact four"])}`).remember).toHaveLength(MEMORY_PER_REPLY);
  });
});

describe("asked outright to remember", () => {
  it("what they asked is taken in their own words", () => {
    expect(explicitMemoryRequest("Please remember this: my sister Ana lives in Porto and I miss her.")).toBe("My sister Ana lives in Porto and I miss her.");
    expect(explicitMemoryRequest("Rough day. Don't forget that Sam's birthday is June 3rd")).toBe("Sam's birthday is June 3rd");
    expect(explicitMemoryRequest("Can you remember that I prefer short answers")).toBe("I prefer short answers");
    expect(explicitMemoryRequest("ok, keep in mind — mornings are hardest for me")).toBe("Mornings are hardest for me");
  });

  it("a question about its memory is not a request to remember", () => {
    for (const q of ["Do you remember my nickname?", "What do you remember about my family?", "Can you remember my nickname?", "Remember when we talked about Sam?", "I can't remember what I said.", "Remember?", "I remember that day well."]) {
      expect(explicitMemoryRequest(q), q).toBeNull();
    }
  });
});

describe("what is kept", () => {
  it("a new, plain statement is kept once; the same thing said again is not", () => {
    const first = addMemories(EMPTY_MEMORY, ["Sam is their partner", "  sam is their partner! ", "ok"], { by: "ai", now: NOW, ids: ["a", "b", "c"] });
    expect(first.added.map((m) => m.text)).toEqual(["Sam is their partner"]);
    expect(first.memory.memories).toEqual([{ id: "a", text: "Sam is their partner", at: NOW.toISOString(), by: "ai" }]);
    expect(addMemories(first.memory, ["Sam is their partner."], { by: "ai", now: NOW, ids: ["d"] }).added).toEqual([]);
    expect(EMPTY_MEMORY.memories).toEqual([]); // the input is not changed
  });

  it("the AI never keeps a label of its own; what the person said about themselves is theirs to keep", () => {
    expect(looksClinical("They are depressed")).toBe(true);
    expect(looksClinical("Shows signs of an anxiety disorder")).toBe(true);
    expect(looksClinical("They said they were diagnosed with ADHD last year")).toBe(false);
    expect(looksClinical("Their therapist suggested a sleep routine")).toBe(false);
    expect(looksClinical("Sam is their partner")).toBe(false);
    const ai = addMemories(EMPTY_MEMORY, ["They have depression", "They told me they have been diagnosed with ADHD"], { by: "ai", now: NOW, ids: ["a", "b"] });
    expect(ai.added.map((m) => m.text)).toEqual(["They told me they have been diagnosed with ADHD"]);
    // The person's own words are never filtered.
    expect(addMemories(EMPTY_MEMORY, ["I have depression and I want you to know"], { by: "you", now: NOW, ids: ["c"] }).added).toHaveLength(1);
  });

  it("memory is bounded: the oldest fall off; one can be removed", () => {
    const many = addMemories(EMPTY_MEMORY, Array.from({ length: MEMORY_MAX_ITEMS + 5 }, (_, i) => `fact number ${i}`), { by: "you", now: NOW, ids: Array.from({ length: MEMORY_MAX_ITEMS + 5 }, (_, i) => `m${i}`) });
    expect(many.memory.memories).toHaveLength(MEMORY_MAX_ITEMS);
    expect(many.memory.memories[0].text).toBe("fact number 5");
    expect(removeMemory(many.memory, "m6").memories.some((m) => m.id === "m6")).toBe(false);
  });

  it("the saved conversation keeps the latest turns, starts with the person, and notes when they last talked", () => {
    let m = EMPTY_MEMORY;
    for (let i = 0; i < CHAT_SAVED_TURNS; i++) m = appendExchange(m, `q${i}`, `a${i}`, NOW);
    expect(m.turns).toHaveLength(CHAT_SAVED_TURNS);
    expect(m.turns[0]).toMatchObject({ role: "user" });
    expect(m.turns[m.turns.length - 1]).toMatchObject({ role: "assistant", content: `a${CHAT_SAVED_TURNS - 1}` });
    expect(m.lastTalked).toBe(NOW.toISOString());
  });

  it("an unreadable row is an empty memory; junk inside a row is dropped", () => {
    for (const raw of [null, "", "nope", "[]", 3]) expect(parseAiMemory(raw)).toEqual(EMPTY_MEMORY);
    const m = parseAiMemory(JSON.stringify({ memories: [{ id: "a", text: "kept", at: NOW.toISOString(), by: "you" }, { id: 1, text: "x" }, { id: "b", text: "", at: NOW.toISOString() }], turns: [{ role: "system", content: "x", at: NOW.toISOString() }, { role: "user", content: "hi", at: NOW.toISOString() }], lastTalked: "not a date" }));
    expect(m).toEqual({ memories: [{ id: "a", text: "kept", at: NOW.toISOString(), by: "you" }], turns: [{ role: "user", content: "hi", at: NOW.toISOString() }], lastTalked: null });
  });

  it("how long since they last talked reads the way a person would say it", () => {
    const ago = (ms: number) => sinceLastTalked(new Date(NOW.getTime() - ms).toISOString(), NOW);
    const H = 3_600_000, D = 24 * H;
    expect([ago(H), ago(5 * H), ago(D + H), ago(3 * D), ago(21 * D), ago(120 * D)]).toEqual(["a little while ago", "earlier today", "yesterday", "3 days ago", "3 weeks ago", "about 4 months ago"]);
    expect(sinceLastTalked(null, NOW)).toBeNull();
  });
});

// ── The routes the person uses to read and change the memory ─────────────────

let seq = 0;
let server: Server | null = null;
let db: FakeDb & { preferences?: Record<string, string> };
async function boot() {
  db = {
    profiles: [{ id: "self-1", type: "self", name: "Tron Moore", fields: {} }], liabilityPayments: [], expenses: [], incomes: [],
    obligations: [], tasks: [], events: [], documents: [], trackers: [], getDocumentCalls: 0, bumpDataVersionCalls: 0, domainVersions: {}, lastBumpedDomains: [],
  } as any;
  const storage: any = makeFakeStorage(db);
  const app = express();
  app.use(express.json());
  const userId = `memory-user-${++seq}`;
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
afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = null; });

describe("the person is in charge of what is remembered", () => {
  it("a fresh memory is empty, on by default, and knows who is here", async () => {
    const api = await boot();
    expect((await api("GET", "/api/workspace/memory/journal")).data).toEqual({ memories: [], turns: [], lastTalked: null, remember: true, name: "Tron" });
    expect((await api("GET", "/api/workspace/memory/word")).status).toBe(400); // only the two assistants remember
  });

  it("they can add a memory, see it, and remove it; the same thing twice is refused", async () => {
    const api = await boot();
    const added = await api("POST", "/api/workspace/memory/journal/remember", { text: "My sister Ana lives in Porto" });
    expect(added.status).toBe(201);
    expect(added.data.memories).toMatchObject([{ text: "My sister Ana lives in Porto", by: "you" }]);
    expect((await api("POST", "/api/workspace/memory/journal/remember", { text: "my sister ana lives in porto" })).status).toBe(409);
    expect((await api("POST", "/api/workspace/memory/journal/remember", { text: "x" })).status).toBe(400);
    const id = added.data.memories[0].id;
    expect((await api("DELETE", `/api/workspace/memory/journal/items/${id}`)).data.memories).toEqual([]);
  });

  it("each assistant's memory is its own: the coach's is not the notes assistant's", async () => {
    const api = await boot();
    await api("POST", "/api/workspace/memory/journal/remember", { text: "Something private to the coach" });
    expect((await api("GET", "/api/workspace/memory/notes")).data.memories).toEqual([]);
    expect(Object.keys(db.preferences || {}).filter((k) => k.startsWith("ai_memory:"))).toEqual([memoryKey("journal")]);
  });

  it("the conversation can be cleared and the memories kept; forgetting everything clears both", async () => {
    const api = await boot();
    db.preferences = { [memoryKey("journal")]: JSON.stringify(appendExchange(addMemories(EMPTY_MEMORY, ["Sam is their partner"], { by: "ai", now: NOW, ids: ["m1"] }).memory, "hello", "hi there", NOW)) };
    const cleared = await api("DELETE", "/api/workspace/memory/journal/conversation");
    expect(cleared.data.turns).toEqual([]);
    expect(cleared.data.memories).toHaveLength(1);
    const gone = await api("DELETE", "/api/workspace/memory/journal");
    expect(gone.data).toMatchObject({ memories: [], turns: [], lastTalked: null });
  });

  it("the memory row cannot be written through the preferences route, and the view says when remembering is off", async () => {
    const api = await boot();
    const forged = await api("PUT", `/api/preferences/${encodeURIComponent(memoryKey("journal"))}`, { value: JSON.stringify({ memories: [{ id: "x", text: "They have a disorder", at: NOW.toISOString(), by: "ai" }], turns: [] }) });
    expect(forged.status).toBe(400);
    await api("PUT", `/api/preferences/${WORKSPACE_AI_ACCESS_PREF}`, { value: serializeWorkspaceAiAccess(withAccess(DEFAULT_WORKSPACE_AI_ACCESS, "journal", "memory", false)) });
    expect((await api("GET", "/api/workspace/memory/journal")).data.remember).toBe(false);
    expect((await api("GET", "/api/workspace/memory/notes")).data.remember).toBe(true);
  });
});
