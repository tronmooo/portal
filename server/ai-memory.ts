// The storage side of shared/ai-memory.ts: what the Reflection Coach and the
// Notes assistant keep between sittings. One preferences row per app
// (`ai_memory:<app>`; the generic preferences route refuses the prefix), read
// and written under a lock that re-reads the row inside it (Rule 6).
//
// These are the AI's OWN rows. Nothing here touches a note, an entry or any
// other record the person owns.
import { randomUUID } from "crypto";
import { storage } from "./storage";
import {
  EMPTY_MEMORY, addMemories, appendExchange, memoryKey, parseAiMemory, removeMemory, MEMORY_PER_REPLY,
  type AiMemory, type MemoryApp, type MemoryItem,
} from "@shared/ai-memory";

const LOCK_TTL_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    if (await storage.acquireUserLock(name, LOCK_TTL_MS)) break;
    if (Date.now() > deadline) throw new Error("memory lock busy");
    await new Promise((r) => setTimeout(r, 120));
  }
  try { return await fn(); } finally { await storage.releaseUserLock(name).catch(() => { /* the ttl frees it */ }); }
}

export async function readAiMemory(app: MemoryApp): Promise<AiMemory> {
  return parseAiMemory(await storage.getPreference(memoryKey(app)));
}

async function change(app: MemoryApp, fn: (m: AiMemory) => AiMemory): Promise<AiMemory> {
  const key = memoryKey(app);
  return withLock(key, async () => {
    const next = fn(parseAiMemory(await storage.getPreference(key)));
    await storage.setPreference(key, JSON.stringify(next));
    return next;
  });
}

/** After an answer: the exchange joins the conversation, and what the AI proposed to remember is kept. */
export async function rememberExchange(app: MemoryApp, user: string, assistant: string, proposed: string[]): Promise<{ memory: AiMemory; added: MemoryItem[] }> {
  let added: MemoryItem[] = [];
  const now = new Date();
  const memory = await change(app, (m) => {
    const r = addMemories(appendExchange(m, user, assistant, now), proposed, { by: "ai", now, ids: proposed.map(() => randomUUID()), max: MEMORY_PER_REPLY });
    added = r.added;
    return r.memory;
  });
  return { memory, added };
}

/** Something the person asks to be remembered, in their own words. */
export async function addOwnMemory(app: MemoryApp, text: string): Promise<{ memory: AiMemory; added: MemoryItem[] }> {
  let added: MemoryItem[] = [];
  const now = new Date();
  const memory = await change(app, (m) => { const r = addMemories(m, [text], { by: "you", now, ids: [randomUUID()] }); added = r.added; return r.memory; });
  return { memory, added };
}

export const forgetMemoryItem = (app: MemoryApp, id: string) => change(app, (m) => removeMemory(m, id));
/** Clear the conversation; what was learned stays. */
export const clearConversation = (app: MemoryApp) => change(app, (m) => ({ ...m, turns: [] }));
/** Forget everything: the conversation and every memory. */
export const forgetEverything = (app: MemoryApp) => change(app, () => ({ ...EMPTY_MEMORY }));
