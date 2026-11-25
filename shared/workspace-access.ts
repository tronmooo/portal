// What each workspace's AI may read (owner request 2026-11-25: "granular
// privacy and AI data-access controls … without exposing private journal
// content to unrelated AI features by default").
//
// ONE row on the account (preference `workspace_ai_access`). The SERVER reads
// it before it builds any prompt: a switch that is off means that data is
// never loaded for that model call, whatever the client sends. Anything this
// parser does not recognise is the default, and every default that crosses
// from one kind of record to another is OFF except the ones the Document AI
// has always had (the writer's profile and saved documents).
//
// Pure. Pinned by tests/workspace-access.test.ts.

export const WORKSPACE_AI_ACCESS_PREF = "workspace_ai_access";

export interface WorkspaceAiAccess {
  notes: {
    /** The assistant reads the whole notebook, not just the open note. */
    allNotes: boolean;
    /** Profile facts, open tasks and asset names from the rest of Portol. */
    portol: boolean;
    /** The assistant keeps the conversation and what it learned (shared/ai-memory.ts). */
    memory: boolean;
  };
  journal: {
    /** The coach and insights read saved entries, not only the page on screen. */
    pastEntries: boolean;
    /** Sleep, exercise and other tracker readings. */
    wellness: boolean;
    /** Tasks finished and events held on the days written about. */
    activity: boolean;
    /** The coach keeps the conversation and what it learned about the writer (shared/ai-memory.ts). */
    memory: boolean;
  };
  word: {
    profile: boolean;
    documents: boolean;
    notes: boolean;
    assets: boolean;
    /** Journal entries in a document. Off unless the writer turns it on. */
    journal: boolean;
  };
}

export type WorkspaceAiApp = keyof WorkspaceAiAccess;

export const DEFAULT_WORKSPACE_AI_ACCESS: WorkspaceAiAccess = {
  // `memory` is the AI's own record of its conversations with the writer —
  // nothing crosses from another kind of record — so it is on, and one switch
  // turns it off (then nothing is saved and nothing is recalled).
  notes: { allNotes: true, portol: false, memory: true },
  journal: { pastEntries: true, wellness: false, activity: false, memory: true },
  word: { profile: true, documents: true, notes: false, assets: false, journal: false },
};

/** What each switch says on screen. The order here is the order shown. */
export const WORKSPACE_AI_ACCESS_LABELS: { [A in WorkspaceAiApp]: Array<{ key: keyof WorkspaceAiAccess[A] & string; label: string; detail: string }> } = {
  notes: [
    { key: "allNotes", label: "All my notes", detail: "Answers and insights draw on the whole notebook. Off: only the note that is open." },
    { key: "portol", label: "The rest of Portol", detail: "My profile, open tasks and what I own, so an answer can connect a note to them." },
    { key: "memory", label: "Remember our conversations", detail: "Keeps the conversation and what the assistant learned, so it can pick up where we left off. Off: nothing is saved or recalled." },
  ],
  journal: [
    { key: "pastEntries", label: "My past entries", detail: "The coach, insights and growth read saved entries. Off: only what is on the page." },
    { key: "wellness", label: "Sleep, exercise and wellness", detail: "Tracker readings from the same days, to connect how I felt with what I did." },
    { key: "activity", label: "Tasks and calendar", detail: "What I finished and what was on my calendar on the days I wrote about." },
    { key: "memory", label: "Remember our conversations", detail: "The coach keeps our conversation and what it learned about me, so it can pick up where we left off. Off: nothing is saved or recalled." },
  ],
  word: [
    { key: "profile", label: "My profile", detail: "Name, contact details and saved facts, so a document is filled in correctly." },
    { key: "documents", label: "My uploaded files", detail: "What Portol read from saved documents that fit the request (a résumé, a lease)." },
    { key: "notes", label: "My notes", detail: "Notes whose words match what I ask for." },
    { key: "assets", label: "What I own and owe", detail: "Assets and liabilities by name, with their saved details." },
    { key: "journal", label: "My journal", detail: "Journal entries. Private by default — turn on only for a document about them." },
  ],
};

function section<T extends Record<string, boolean>>(raw: unknown, defaults: T): T {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...defaults } as Record<string, boolean>;
  for (const key of Object.keys(defaults)) if (typeof src[key] === "boolean") out[key] = src[key] as boolean;
  return out as T;
}

/** Read the stored row. Anything unreadable is the defaults. */
export function parseWorkspaceAiAccess(raw: unknown): WorkspaceAiAccess {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { value = null; }
  }
  const src = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    notes: section(src.notes, DEFAULT_WORKSPACE_AI_ACCESS.notes),
    journal: section(src.journal, DEFAULT_WORKSPACE_AI_ACCESS.journal),
    word: section(src.word, DEFAULT_WORKSPACE_AI_ACCESS.word),
  };
}

export function serializeWorkspaceAiAccess(access: WorkspaceAiAccess): string {
  return JSON.stringify(parseWorkspaceAiAccess(access));
}

/** One switch changed; everything else as it was. */
export function withAccess<A extends WorkspaceAiApp>(access: WorkspaceAiAccess, app: A, key: keyof WorkspaceAiAccess[A] & string, on: boolean): WorkspaceAiAccess {
  const next = parseWorkspaceAiAccess(access);
  if (key in next[app]) (next[app] as Record<string, boolean>)[key] = on;
  return next;
}

/** "your notes and your profile": what an answer may say it read. (Remembering is not a source: it is said on its own line.) */
export function accessSummary<A extends WorkspaceAiApp>(access: WorkspaceAiAccess, app: A): string[] {
  return WORKSPACE_AI_ACCESS_LABELS[app].filter((row) => row.key !== "memory" && (access[app] as Record<string, boolean>)[row.key]).map((row) => row.label);
}
