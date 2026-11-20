// What a chat message asks of the JOURNAL and of NOTES — pure, no I/O.
//
// Three reads the model used to get wrong (Journal tutorial QA, 2026-11-20):
//
//   · "I had a pretty good day today… Save this as today's journal entry"
//     — the text to save is the message itself. The model sent an empty entry
//     ("Journal entry needs content or mood") and logged the run and the walk
//     the narrative mentioned as tracker entries nobody asked for.
//   · "Show me my journal entry from today" / "What was my mood earlier
//     today?" / "Summarize what I wrote in my journal today" — a question
//     about a stored entry. The chat answered with a piano warranty, or said
//     it could not see the journal.
//   · "Find my note about buying new tires" — a question about a NOTE. The
//     document fast path opened a tire-warranty PDF.
//
// Pinned by tests/journal-intent.test.ts.

const lc = (s: unknown): string => String(s ?? "").toLowerCase();

// ─── "Save this as today's journal entry" ────────────────────────────────────

const FILING_VERB = String.raw`(?:add|save|put|file|record|write|keep|make|log|store|turn)`;
const FILING_OBJECT = String.raw`(?:this|that|it|the\s+above|all\s+(?:of\s+)?(?:this|that))`;
const JOURNAL_TARGET = String.raw`(?:in|to|into|as|on|under)?\s*(?:my|the|a|an|today'?s|todays)?\s*(?:new\s+)?(?:journal|diary)(?:\s+entry)?(?:\s+(?:for|from)\s+today)?`;

/** "…Save this as today's journal entry." — the directive closes the message. */
const TRAILING_FILING = new RegExp(
  String.raw`(?:^|[.!?…\n]\s*|\s+[-—]\s*)(?:and\s+)?(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:${FILING_VERB}\s+${FILING_OBJECT}\s*(?:down\s+)?${JOURNAL_TARGET}|journal\s+${FILING_OBJECT})(?:\s*,?\s*please)?[\s.!?]*$`,
  "i",
);

/** "Journal this: …" / "Save this as today's journal entry: …" — it opens it. */
const LEADING_FILING = new RegExp(
  String.raw`^\s*(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:${FILING_VERB}\s+${FILING_OBJECT}\s*(?:down\s+)?${JOURNAL_TARGET}|journal\s+${FILING_OBJECT})\s*[:\-—.]\s*`,
  "i",
);

/**
 * When the message is "<narrative>. Save this as today's journal entry" (or the
 * directive comes first), the narrative — the text the entry should hold.
 * Null when the message is not a whole-message journal filing.
 */
export function journalFilingContent(message: string): string | null {
  const raw = String(message ?? "").trim();
  if (!raw) return null;
  const trailing = raw.match(TRAILING_FILING);
  if (trailing && trailing.index !== undefined) {
    // Keep the sentence's own closing punctuation, drop the directive.
    const keepUntil = trailing.index + (/^[.!?…]/.test(trailing[0]) ? 1 : 0);
    const text = raw.slice(0, keepUntil).trim().replace(/\s+[-—]\s*$/, "").trim();
    return text.length >= 3 ? text : null;
  }
  const leading = raw.match(LEADING_FILING);
  if (leading) {
    const text = raw.slice(leading[0].length).trim().replace(/^["“]|["”]$/g, "").trim();
    return text.length >= 3 ? text : null;
  }
  return null;
}

/** The message asks for ONE thing: file its own text as a journal entry. */
export function isWholeMessageJournalFiling(message: string): boolean {
  return journalFilingContent(message) !== null;
}

// ─── Reading the journal ─────────────────────────────────────────────────────

export type JournalReadKind = "show" | "mood" | "summarize";

export interface JournalReadIntent {
  kind: JournalReadKind;
  /** "today", "yesterday", a YYYY-MM-DD day, or null for the latest entry. */
  day: "today" | "yesterday" | string | null;
}

const WRITE_LEAD = /^\s*(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:add|create|write|log|save|append|put|delete|remove|erase|update|change|edit|replace|make|start|new|journal\s+(?:this|that|it))\b/;

function readDay(l: string): JournalReadIntent["day"] {
  const iso = l.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  if (/\byesterday\b|\blast\s+night\b/.test(l)) return "yesterday";
  if (/\btoday\b|\btonight\b|\bthis\s+(?:morning|afternoon|evening)\b|\bearlier\b/.test(l)) return "today";
  return null;
}

/**
 * A question about what the journal already holds. Null for anything that
 * writes ("add a journal entry…") and for anything that is not about the
 * journal or the user's recorded mood.
 */
export function parseJournalReadIntent(message: string): JournalReadIntent | null {
  const l = lc(message).trim();
  if (!l || l.length > 220) return null;
  if (WRITE_LEAD.test(l) || isWholeMessageJournalFiling(message)) return null;
  const aboutJournal = /\b(?:journal|diary)\b/.test(l);

  // "Summarize what I wrote in my journal today"
  if (aboutJournal && /\b(?:summar(?:y|ize|ise|ies)|recap|tl;?dr|sum\s+up)\b/.test(l)) {
    return { kind: "summarize", day: readDay(l) };
  }
  // "What was my mood earlier today?" / "How was I feeling yesterday?"
  const moodQuestion =
    /\b(?:what|what's|whats|how)\b[^.?!]*\b(?:my\s+mood|mood\s+(?:was|did)|was\s+i\s+feeling|did\s+i\s+feel|i\s+was\s+feeling)\b/.test(l) ||
    /\bmy\s+mood\b[^.?!]*\?/.test(l);
  // A chart / trend / average is analytics, not a lookup of one day.
  if (moodQuestion && !/\b(?:chart|graph|plot|trend|average|avg|over\s+time|this\s+(?:week|month|year)|last\s+(?:week|month|year)|history)\b/.test(l)) {
    return { kind: "mood", day: readDay(l) };
  }
  // "Show me my journal entry from today" / "What did I write in my journal?"
  if (aboutJournal && (
    /\b(?:show|read|see|view|open|display|find|get|pull\s+up|look\s+up|bring\s+up|give\s+me)\b/.test(l) ||
    /\bwhat(?:'s|\s+is|\s+was|\s+did|\s+does|\s+have)\b/.test(l)
  )) {
    return { kind: "show", day: readDay(l) };
  }
  return null;
}

// ─── Finding a note ──────────────────────────────────────────────────────────

export interface NoteFindIntent {
  /** What the note is about; "" lists every note. */
  query: string;
}

const NOTE_READ_LEAD =
  /^\s*(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?(?:find|show|search|look\s+up|look\s+for|pull\s+up|bring\s+up|get|open|view|read|display|list|where(?:'s|\s+is)|what(?:'s|\s+is|\s+was|\s+were|\s+does|\s+did|\s+are|\s+notes?)|which\s+notes?|do\s+i\s+have)\b/;

/** "Find my note about buying new tires" → { query: "buying new tires" }. */
export function parseNoteFindIntent(message: string): NoteFindIntent | null {
  const l = lc(message).trim().replace(/[?.!]+$/, "");
  if (!l || l.length > 200) return null;
  if (!NOTE_READ_LEAD.test(l)) return null;
  const m = l.match(/\b(?:quick\s+)?notes?\b(.*)$/);
  if (!m) return null;
  // "show me the notes app", "what does the doctor's note say" stay with the model.
  if (!/\b(?:my|a|an|the|any|all|that|quick|what|which)\s+(?:\w+\s+){0,2}?notes?\b|\bnotes?\s+(?:about|on|for|regarding|re|that|with|named|called|titled|i\b)/.test(l)) return null;
  let rest = m[1].trim();
  // "search my notes for tires" / "note about X" / "note that says X"
  rest = rest
    .replace(/^(?:(?:do|did)\s+)?(?:i\s+(?:saved?|made|make|wrote|write|took|take|have|created?|added|add)\s*)?/, "")
    .replace(/^(?:about|on|for|regarding|re|that\s+(?:says?|said|mentions?)|with|named|called|titled|saying|mentioning)\s+/, "")
    .replace(/^(?:earlier|today|yesterday|before)\s*/, "")
    .replace(/\b(?:please|earlier|i\s+saved|i\s+made|i\s+wrote)\s*$/g, "")
    .trim();
  // A phrase in front of "note" is a topic too: "find my tire note".
  if (!rest) {
    const front = l.match(/\b(?:my|the|a|that)\s+((?:\w+\s+){1,3})notes?\b/);
    const topic = front ? front[1].replace(/\b(?:quick|saved|last|latest|recent|new|old|all)\b/g, "").trim() : "";
    return { query: topic };
  }
  return { query: rest };
}

// ─── Matching a note to a topic ──────────────────────────────────────────────

const STOP = new Set([
  "a", "an", "the", "my", "me", "i", "to", "of", "for", "on", "in", "at", "and", "or", "about", "that", "this",
  "it", "is", "was", "are", "with", "some", "any", "note", "notes", "new", "need", "get", "from", "by", "be",
]);

/** Light stemming: "buying" / "buy" / "buys" and "tires" / "tire" meet. */
function stem(w: string): string {
  let s = w;
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("es")) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

export function topicTokens(text: string): string[] {
  return lc(text).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w && !STOP.has(w)).map(stem);
}

/**
 * Notes that are about `query`, best first. A note matches when it holds at
 * least half of the query's meaningful words — "buying new tires" finds
 * "Buy new tires for the Honda", not every note with the word "new" in it.
 * An empty query returns the list unchanged.
 */
export function rankNotesByTopic<T extends { title?: string | null; content?: string | null }>(notes: T[], query: string): T[] {
  const want = Array.from(new Set(topicTokens(query)));
  if (want.length === 0) return notes;
  const need = Math.max(1, Math.ceil(want.length / 2));
  const scored: Array<{ n: T; score: number; i: number }> = [];
  notes.forEach((n, i) => {
    const have = new Set(topicTokens(`${n.title || ""} ${n.content || ""}`));
    const titleHave = new Set(topicTokens(String(n.title || "")));
    let score = 0;
    for (const w of want) {
      if (have.has(w)) score += 1;
      if (titleHave.has(w)) score += 0.5;
    }
    const hits = want.filter((w) => have.has(w)).length;
    if (hits >= need) scored.push({ n, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.n);
}
