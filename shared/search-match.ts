// shared/search-match.ts — the ONE matcher behind /api/search.
//
// Both storages (Supabase in production, MemStorage in tests) used to carry
// their own copy of "which fields does a query match", and the two had
// drifted: one read a task's tags, neither read its description, and the
// birthdays a profile carries in its fields — the rows the Important Dates
// page lists — were not searched at all. "birthday" found one event row and
// missed five people; "dana" found the Dana profile and not the task that
// named her (QA 2026-09-18 F-48).
//
// Every field a row is searched on is listed HERE, once. The storages hand
// over their lists and get back the tagged result array the palette expects.

import { rulesFromProfiles, type DateRule } from "./date-rules";

export interface SearchCorpus {
  profiles?: readonly any[];
  trackers?: readonly any[];
  tasks?: readonly any[];
  expenses?: readonly any[];
  habits?: readonly any[];
  obligations?: readonly any[];
  artifacts?: readonly any[];
  journal?: readonly any[];
  memories?: readonly any[];
  events?: readonly any[];
  documents?: readonly any[];
}

/** Fields (string or string[]) each entity is matched on. Never file bodies. */
export const SEARCH_FIELDS: Record<string, readonly string[]> = {
  profile: ["name", "type", "tags", "notes", "description"],
  tracker: ["name", "category", "description"],
  task: ["title", "description", "notes", "tags", "category"],
  expense: ["description", "category", "vendor", "notes"],
  habit: ["name", "description", "category"],
  obligation: ["name", "category", "description", "notes", "vendor"],
  artifact: ["title", "content", "tags"],
  journal: ["content", "tags", "title"],
  memory: ["key", "value"],
  event: ["title", "description", "location", "category", "notes"],
  document: ["name", "title", "category", "type", "tags", "description", "notes"],
};

/** Keys that hold file bodies or base64 and must never leave the server. */
const DOCUMENT_BODY_KEYS = ["content", "fileData", "data"] as const;

function fieldText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join(" ");
  return "";
}

/** True when any listed field of `row` contains `q` (already lowercased). */
export function rowMatches(type: string, row: any, q: string): boolean {
  if (!row || !q) return false;
  const fields = SEARCH_FIELDS[type] || [];
  for (const f of fields) {
    const text = fieldText(row[f]);
    if (text && text.toLowerCase().includes(q)) return true;
  }
  return false;
}

/**
 * The dates people carry — a birthday, an anniversary, a licence expiry —
 * as searchable event rows. They have no row of their own (the Date Rule
 * engine derives them from profile fields), so without this pass a search
 * for "birthday" found only the birthdays someone had typed into the
 * calendar by hand.
 */
export function virtualDateRows(profiles: readonly any[]): any[] {
  let rules: DateRule[] = [];
  try { rules = rulesFromProfiles(profiles || []); } catch { rules = []; }
  return rules
    .filter((r) => r.active && (r.calendarVisible || r.importantVisible || r.upcomingVisible))
    .map((r) => ({
      id: r.id,
      title: r.label,
      description: r.subtitle,
      date: r.date,
      category: r.ruleType,
      recurrence: r.recurrence,
      profileId: r.profileId,
      linkedProfiles: r.ownerIds,
      href: r.href,
      virtual: true,
      _type: "event",
    }));
}

/**
 * Every row in `corpus` that matches `query`, tagged with `_type` — the exact
 * array /api/search returns. Documents are stripped of their file bodies.
 */
export function searchCorpus(corpus: SearchCorpus, query: string): any[] {
  const q = String(query || "").toLowerCase().trim();
  const results: any[] = [];
  if (!q) return results;
  const scan = (type: string, rows: readonly any[] | undefined, strip?: (row: any) => any) => {
    for (const row of rows || []) {
      if (!rowMatches(type, row, q)) continue;
      results.push({ ...(strip ? strip(row) : row), _type: type });
    }
  };
  scan("profile", corpus.profiles);
  scan("tracker", corpus.trackers);
  scan("task", corpus.tasks);
  scan("expense", corpus.expenses);
  scan("habit", corpus.habits);
  scan("obligation", corpus.obligations);
  scan("artifact", corpus.artifacts);
  scan("journal", corpus.journal);
  scan("memory", corpus.memories);
  scan("event", corpus.events);
  // Profile-derived dates sit next to the hand-entered events; the ids are
  // deterministic rule ids, so a re-run never yields a different row.
  const seenEventIds = new Set(results.filter((r) => r._type === "event").map((r) => r.id));
  for (const v of virtualDateRows(corpus.profiles || [])) {
    if (seenEventIds.has(v.id)) continue;
    if (rowMatches("event", v, q)) results.push(v);
  }
  scan("document", corpus.documents, (d) => {
    const rest: any = { ...d };
    for (const k of DOCUMENT_BODY_KEYS) delete rest[k];
    return rest;
  });
  return results;
}
