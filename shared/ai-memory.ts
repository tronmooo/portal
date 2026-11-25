// What a workspace AI remembers between sittings (owner, 2026-11-25: "the
// memory for the AI therapist … have to talk about it and make it human").
//
// Two things are kept, per app (the Journal's Reflection Coach, the Notes
// assistant), on the writer's account and nowhere else:
//   - the CONVERSATION, so it can be picked up where it was left;
//   - MEMORIES: short facts the person told the AI that are worth keeping
//     ("Sam is my partner", "I'm trying to be in bed by eleven").
//
// The person is in charge of both: every memory is listed on screen, any one
// can be removed, the person can add their own, the conversation can be
// cleared, and one switch (shared/workspace-access.ts `memory`) turns
// remembering off — then nothing is saved and nothing is recalled.
//
// A memory is what the PERSON said. The model proposes them in a marked tail
// after its reply (`REMEMBER: [...]`); this module strips the tail from what
// is shown and keeps only short, new, plain statements. A memory is never a
// diagnosis the AI came up with (`looksClinical`).
//
// Pure. Pinned by tests/ai-memory.test.ts.

export type MemoryApp = "journal" | "notes";
export const MEMORY_APPS: MemoryApp[] = ["journal", "notes"];
export const isMemoryApp = (v: unknown): v is MemoryApp => MEMORY_APPS.includes(v as MemoryApp);

export const memoryKey = (app: MemoryApp) => `ai_memory:${app}`;
export const AI_MEMORY_KEY_PREFIX = "ai_memory:";

export const MEMORY_MAX_ITEMS = 80;
export const MEMORY_ITEM_MAX = 220;
export const MEMORY_PER_REPLY = 3;
export const CHAT_SAVED_TURNS = 40;
export const CHAT_SAVED_TURN_MAX = 6000;

export interface MemoryItem {
  id: string;
  text: string;
  /** When it was learned (ISO). */
  at: string;
  /** Who put it there: the AI noticed it in conversation, or the person typed it. */
  by: "ai" | "you";
}
export interface SavedTurn { role: "user" | "assistant"; content: string; at: string }
export interface AiMemory {
  memories: MemoryItem[];
  turns: SavedTurn[];
  /** The last time the person wrote to this AI (ISO), or null. */
  lastTalked: string | null;
}
export const EMPTY_MEMORY: AiMemory = { memories: [], turns: [], lastTalked: null };

const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const clean = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

export function parseAiMemory(raw: unknown): AiMemory {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return { ...EMPTY_MEMORY }; } }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...EMPTY_MEMORY };
  const src = v as Record<string, unknown>;
  const memories: MemoryItem[] = [];
  for (const m of Array.isArray(src.memories) ? src.memories : []) {
    const row = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
    const text = clean(row.text, MEMORY_ITEM_MAX);
    if (typeof row.id !== "string" || !text || !isIso(row.at)) continue;
    memories.push({ id: row.id, text, at: row.at, by: row.by === "you" ? "you" : "ai" });
  }
  const turns: SavedTurn[] = [];
  for (const t of Array.isArray(src.turns) ? src.turns : []) {
    const row = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
    const content = typeof row.content === "string" ? row.content.trim().slice(0, CHAT_SAVED_TURN_MAX) : "";
    if ((row.role !== "user" && row.role !== "assistant") || !content || !isIso(row.at)) continue;
    turns.push({ role: row.role, content, at: row.at });
  }
  return { memories: memories.slice(-MEMORY_MAX_ITEMS), turns: turns.slice(-CHAT_SAVED_TURNS), lastTalked: isIso(src.lastTalked) ? src.lastTalked : null };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * A label the AI must not attach to a person on its own: a condition named as
 * theirs. What the person says about themselves in the first person is theirs
 * to say ("I was diagnosed with ADHD") — the AI's memories are written in the
 * third person, so a clinical term is kept only when the memory says it came
 * from them ("said", "told", "mentioned", "was diagnosed").
 */
const CLINICAL = /\b(depress(ed|ion|ive)|anxiety disorder|bipolar|adhd|ptsd|ocd|borderline|narcissis\w*|schizo\w*|autis\w*|eating disorder|anorexi\w*|bulimi\w*|personality disorder|clinical(ly)?|disorder|diagnos\w*|suicid\w*|self[- ]harm)\b/i;
const ATTRIBUTED = /\b(said|says|told|mentioned|shared|was diagnosed|were diagnosed|has been diagnosed|their (doctor|therapist|psychiatrist))\b/i;
export function looksClinical(text: string): boolean {
  return CLINICAL.test(text) && !ATTRIBUTED.test(text);
}

export interface AddMemoryResult { memory: AiMemory; added: MemoryItem[] }

/**
 * Add memories: short, plain, new. One that says the same as a kept one is
 * skipped; an AI-proposed one that reads as a diagnosis is dropped; the
 * oldest fall off past MEMORY_MAX_ITEMS. `ids` supplies an id per candidate.
 */
export function addMemories(memory: AiMemory, texts: unknown[], opts: { by: MemoryItem["by"]; now: Date; ids: string[]; max?: number }): AddMemoryResult {
  const have = new Set(memory.memories.map((m) => norm(m.text)));
  const added: MemoryItem[] = [];
  for (const [i, raw] of texts.entries()) {
    if (added.length >= (opts.max ?? texts.length)) break;
    const text = clean(raw, MEMORY_ITEM_MAX);
    const key = norm(text);
    if (text.length < 4 || !key || have.has(key)) continue;
    if (opts.by === "ai" && looksClinical(text)) continue;
    have.add(key);
    added.push({ id: opts.ids[i] ?? `${opts.now.getTime()}-${i}`, text, at: opts.now.toISOString(), by: opts.by });
  }
  return { memory: { ...memory, memories: [...memory.memories, ...added].slice(-MEMORY_MAX_ITEMS) }, added };
}

export function removeMemory(memory: AiMemory, id: string): AiMemory {
  return { ...memory, memories: memory.memories.filter((m) => m.id !== id) };
}

/** One exchange joins the saved conversation; the oldest turns fall off. */
export function appendExchange(memory: AiMemory, user: string, assistant: string, now: Date): AiMemory {
  const at = now.toISOString();
  const turns = [
    ...memory.turns,
    { role: "user" as const, content: user.trim().slice(0, CHAT_SAVED_TURN_MAX), at },
    { role: "assistant" as const, content: assistant.trim().slice(0, CHAT_SAVED_TURN_MAX), at },
  ].slice(-CHAT_SAVED_TURNS);
  // The saved conversation always starts with the person.
  while (turns.length && turns[0].role !== "user") turns.shift();
  return { ...memory, turns, lastTalked: at };
}

export const REMEMBER_MARK = "REMEMBER:";

/**
 * Split a model reply into what is shown and what it proposes to remember.
 * The tail is ALWAYS removed from the answer, readable or not: the person
 * never sees the machinery.
 */
export function splitReplyAndMemories(raw: string): { answer: string; remember: string[] } {
  const text = String(raw || "");
  const at = text.lastIndexOf(REMEMBER_MARK);
  if (at < 0) return { answer: text.trim(), remember: [] };
  const answer = text.slice(0, at).trim();
  const tail = text.slice(at + REMEMBER_MARK.length).trim();
  let remember: string[] = [];
  const start = tail.indexOf("[");
  const end = tail.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(tail.slice(start, end + 1));
      if (Array.isArray(v)) remember = v.filter((x) => typeof x === "string").map((x) => clean(x, MEMORY_ITEM_MAX)).filter(Boolean).slice(0, MEMORY_PER_REPLY);
    } catch { /* an unreadable tail is dropped, never shown */ }
  }
  return { answer, remember };
}

const ASK_CUE = /^(?:(?:please|pls|hey|ok|okay|so|and|also|oh|can you|could you|will you|i want you to|i'd like you to|i need you to)[\s,]+)*(?:remember|don'?t forget|do not forget|keep in mind|make a note)\b(?:\s+(?:this|that|for next time|for later))*\s*[:,\-–—]?\s*(.*)$/is;

/**
 * "Please remember that my sister lives in Porto" → "my sister lives in
 * Porto". When the person ASKS for something to be remembered, keeping it
 * does not depend on the model choosing to: this is what is kept, in their
 * own words, if the model proposed nothing. A question ("do you remember…?",
 * "can you remember my nickname?") is not a request to remember.
 */
export function explicitMemoryRequest(message: string): string | null {
  const text = String(message || "").trim();
  // The cue may open any sentence of the message.
  const starts = [0, ...[...text.matchAll(/[.!?\n]\s+/g)].map((m) => (m.index ?? 0) + m[0].length)];
  for (const at of starts) {
    const m = ASK_CUE.exec(text.slice(at));
    if (!m) continue;
    const said = clean(m[1], MEMORY_ITEM_MAX).replace(/^(?:that|this)\s+/i, "");
    if (said.length < 6 || /\?\s*$/.test(said) || /^(?:what|when|who|how|why|if|whether)\b/i.test(said)) continue;
    return said.charAt(0).toUpperCase() + said.slice(1);
  }
  return null;
}

/** "today", "yesterday", "3 days ago", "2 weeks ago", "about 4 months ago": how long since they last talked. */
export function sinceLastTalked(lastTalked: string | null, now: Date): string | null {
  if (!lastTalked) return null;
  const ms = now.getTime() - Date.parse(lastTalked);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return ms < 3 * 3_600_000 ? "a little while ago" : "earlier today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `about ${Math.round(days / 30)} months ago`;
}
