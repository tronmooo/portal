// What the workspace AIs may ANSWER (owner request 2026-11-25: AI Insights
// for Notes and Journal, AI Review for Word).
//
// The model is asked for JSON. Nothing it returns is shown as it came: each
// parser here keeps only the shape the screen draws, and GROUNDS every
// reference against the records the prompt was built from —
//   - a note an insight points at must be a note that was sent (by its ref);
//   - a day a journal pattern cites must be a day that has an entry;
//   - a passage a review quotes must be in the document.
// A reference that does not check out is dropped; an item left with nothing
// to stand on is dropped with it. So an insight can be wrong about what the
// notes MEAN, but never about which notes exist or what a document says.
//
// Pure. Pinned by tests/workspace-intel.test.ts.

/** Pull the first JSON object out of a model reply (it may be fenced). */
export function parseModelJson(raw: string): Record<string, unknown> | null {
  const text = String(raw || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ── Notes ────────────────────────────────────────────────────────────────────

/** A note as the model sees it: `ref` is "N1", "N2"… — never the stored id. */
export interface NoteRef { ref: string; id: string; title: string }
export interface NoteLink { id: string; title: string }
export interface NoteInsightItem { text: string; notes: NoteLink[] }
export interface NoteInsights {
  /** An idea that comes up in several notes. */
  recurring: NoteInsightItem[];
  /** Notes that belong together, and why. */
  related: NoteInsightItem[];
  /** A plan or list a note started and did not finish. */
  unfinished: NoteInsightItem[];
  /** A link between pieces of information the writer may not have made. */
  connections: NoteInsightItem[];
}
export const INSIGHT_MAX_ITEMS = 8;

function noteItems(raw: unknown, refs: Map<string, NoteRef>, minNotes: number): NoteInsightItem[] {
  const out: NoteInsightItem[] = [];
  for (const r of list(raw)) {
    const row = obj(r);
    const text = str(row.text, 400);
    if (!text) continue;
    const seen = new Set<string>();
    const notes: NoteLink[] = [];
    for (const ref of list(row.notes)) {
      const hit = refs.get(String(ref).trim().toUpperCase());
      if (hit && !seen.has(hit.id)) { seen.add(hit.id); notes.push({ id: hit.id, title: hit.title }); }
    }
    if (notes.length < minNotes) continue;
    out.push({ text, notes });
    if (out.length >= INSIGHT_MAX_ITEMS) break;
  }
  return out;
}

/** Null when the reply is not the JSON asked for. */
export function parseNoteInsights(raw: string, sent: NoteRef[]): NoteInsights | null {
  const json = parseModelJson(raw);
  if (!json) return null;
  const refs = new Map(sent.map((n) => [n.ref.toUpperCase(), n]));
  return {
    recurring: noteItems(json.recurring, refs, 2), // "recurring" needs two notes to stand on
    related: noteItems(json.related, refs, 2),
    unfinished: noteItems(json.unfinished, refs, 1),
    connections: noteItems(json.connections, refs, 1),
  };
}

export interface CategorySuggestion { id: string; title: string; category: string }
/** A category per uncategorised note. A note that was not sent is dropped. */
export function parseCategorySuggestions(raw: string, sent: NoteRef[]): CategorySuggestion[] | null {
  const json = parseModelJson(raw);
  if (!json) return null;
  const refs = new Map(sent.map((n) => [n.ref.toUpperCase(), n]));
  const out: CategorySuggestion[] = [];
  const seen = new Set<string>();
  for (const r of list(json.suggestions)) {
    const row = obj(r);
    const hit = refs.get(String(row.note ?? "").trim().toUpperCase());
    // One short name: no "category:" prefix, no commas (it is ONE tag, W8).
    const category = str(row.category, 40).replace(/^category:/i, "").replace(/[,:]/g, " ").replace(/\s+/g, " ").trim();
    if (!hit || !category || seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push({ id: hit.id, title: hit.title, category });
  }
  return out;
}

/** Open check-list items in a note's markdown: counted, never asked of a model. */
export function openChecklistItems(markdown: string): string[] {
  const out: string[] = [];
  for (const line of String(markdown || "").split("\n")) {
    const m = /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// ── Journal ──────────────────────────────────────────────────────────────────

/** What the reflection AI is and is not. Shown with every answer; part of its instructions. */
export const REFLECTION_BOUNDARY = "A reflection companion, not a therapist. It does not diagnose or treat, and it is not a substitute for professional care. If you are in crisis, contact local emergency services or a crisis line (in the US, call or text 988).";

export interface JournalInsightItem { title: string; detail: string; days: string[] }
export type JournalInsightFocus = "insights" | "growth";
export interface JournalInsights {
  focus: JournalInsightFocus;
  /** Section name → items. The sections depend on the focus. */
  sections: Array<{ key: string; label: string; items: JournalInsightItem[] }>;
}
export const JOURNAL_INSIGHT_SECTIONS: Record<JournalInsightFocus, Array<{ key: string; label: string }>> = {
  insights: [
    { key: "patterns", label: "Emotional patterns" },
    { key: "concerns", label: "Recurring concerns" },
    { key: "changes", label: "What has changed" },
    { key: "progress", label: "Progress" },
  ],
  growth: [
    { key: "challenges", label: "Recurring challenges" },
    { key: "accomplishments", label: "Accomplishments" },
    { key: "opportunities", label: "Opportunities" },
  ],
};

/**
 * Null when the reply is not the JSON asked for. An item must cite at least
 * one day that has an entry: an observation with no entry behind it is not
 * shown.
 */
export function parseJournalInsights(raw: string, focus: JournalInsightFocus, entryDays: Iterable<string>): JournalInsights | null {
  const json = parseModelJson(raw);
  if (!json) return null;
  const real = new Set(entryDays);
  const sections = JOURNAL_INSIGHT_SECTIONS[focus].map(({ key, label }) => {
    const items: JournalInsightItem[] = [];
    for (const r of list(json[key])) {
      const row = obj(r);
      const title = str(row.title, 120);
      const detail = str(row.detail, 600);
      const days = [...new Set(list(row.days).map((d) => String(d).slice(0, 10)).filter((d) => real.has(d)))].sort();
      if (!title || !detail || days.length === 0) continue;
      items.push({ title, detail, days });
      if (items.length >= INSIGHT_MAX_ITEMS) break;
    }
    return { key, label, items };
  });
  return { focus, sections };
}

/** Writing prompts: short questions, de-duplicated, at most `max`. */
export function parseJournalPrompts(raw: string, max = 6): string[] | null {
  const json = parseModelJson(raw);
  if (!json) return null;
  const out: string[] = [];
  for (const p of list(json.prompts)) {
    const text = str(p, 220);
    if (text.length < 8 || out.some((x) => x.toLowerCase() === text.toLowerCase())) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

// ── Word ─────────────────────────────────────────────────────────────────────

export const REVIEW_CATEGORIES = ["grammar", "clarity", "consistency", "formatting", "missing"] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];
export const REVIEW_LABELS: Record<ReviewCategory, string> = {
  grammar: "Grammar and spelling", clarity: "Clarity", consistency: "Consistency", formatting: "Formatting", missing: "Missing information",
};
export interface ReviewFinding {
  category: ReviewCategory;
  /** The passage, exactly as it stands in the document; "" for a finding about the whole document. */
  quote: string;
  issue: string;
  suggestion: string;
}
export const REVIEW_MAX_FINDINGS = 40;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Null when the reply is not the JSON asked for. A finding's quote must be in
 * the document (whitespace aside); one that is not is kept as a finding about
 * the whole document only for the categories that can be (formatting,
 * consistency, missing) — a "grammar" finding about words that are not there
 * is dropped.
 */
export function parseReviewFindings(raw: string, documentText: string): ReviewFinding[] | null {
  const json = parseModelJson(raw);
  if (!json) return null;
  const hay = squash(documentText);
  const out: ReviewFinding[] = [];
  for (const r of list(json.findings)) {
    const row = obj(r);
    const category = String(row.category ?? "").toLowerCase() as ReviewCategory;
    if (!REVIEW_CATEGORIES.includes(category)) continue;
    const issue = str(row.issue, 400);
    if (!issue) continue;
    let quote = str(row.quote, 300);
    if (quote && !hay.includes(squash(quote))) {
      if (category === "grammar" || category === "clarity") continue;
      quote = "";
    }
    out.push({ category, quote, issue, suggestion: str(row.suggestion, 600) });
    if (out.length >= REVIEW_MAX_FINDINGS) break;
  }
  return out;
}

// ── Conversations ────────────────────────────────────────────────────────────

export interface ChatTurn { role: "user" | "assistant"; content: string }
export const CHAT_MAX_TURNS = 24;
export const CHAT_TURN_MAX = 6000;

/**
 * The conversation as it may be sent on: user/assistant turns only, bounded,
 * starting with the user and ending with the user's question. Null when there
 * is no question to answer.
 */
export function cleanChatTurns(raw: unknown): ChatTurn[] | null {
  const turns: ChatTurn[] = [];
  for (const t of list(raw)) {
    const row = obj(t);
    const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : null;
    const content = typeof row.content === "string" ? row.content.trim().slice(0, CHAT_TURN_MAX) : "";
    if (!role || !content) continue;
    // Two turns from the same side in a row are one turn.
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${content}`.slice(0, CHAT_TURN_MAX);
    else turns.push({ role, content });
  }
  let kept = turns.slice(-CHAT_MAX_TURNS);
  while (kept.length && kept[0].role !== "user") kept = kept.slice(1);
  if (kept.length === 0 || kept[kept.length - 1].role !== "user") return null;
  return kept;
}
