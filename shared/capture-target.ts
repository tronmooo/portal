// Who is this journal entry or note FOR?
//
// "Bob's journal: he had a rough day at school" and "Note for Bob: prefers
// morning appointments" name the person the record belongs to. This reads the
// name and the text apart; matching the name to a profile is the caller's job
// (a name with no profile never creates one — CLAUDE.md rule 13 — the text is
// then saved whole, under the writer).
//
// Pure. Pinned by tests/chat-capture-buttons.test.ts.

export type CaptureKind = "journal" | "note";

export interface CaptureTarget {
  /** The person named, as written ("Bob", "my mom"); null when none was. */
  name: string | null;
  /** The text to save, without the "Bob's journal:" lead. */
  text: string;
}

const NAME = String.raw`([\p{L}][\p{L}\p{M}'.-]*(?:\s+[\p{L}][\p{L}\p{M}'.-]*){0,3}?)`;
const KIND = String.raw`(?:journal|diary|notes?)(?:\s+entry)?`;
const SEP = String.raw`\s*[:\-—,]\s*`;

const PATTERNS: RegExp[] = [
  // "Bob's journal: …", "Bob's note - …"
  new RegExp(String.raw`^\s*${NAME}(?:'s|’s|s')\s+${KIND}${SEP}(.+)$`, "isu"),
  // "Journal for Bob: …", "Note for Bob: …", "Journal entry for Bob, …"
  new RegExp(String.raw`^\s*(?:(?:add|create|write|save|new)\s+(?:a\s+)?)?${KIND}\s+for\s+${NAME}${SEP}(.+)$`, "isu"),
  // "For Bob: …"
  new RegExp(String.raw`^\s*for\s+${NAME}\s*[:\-—]\s*(.+)$`, "isu"),
];

const SELF = /^(?:me|my|myself|i|mine|self)$/i;

export function parseCaptureTarget(message: string): CaptureTarget {
  const raw = String(message ?? "").trim();
  for (const re of PATTERNS) {
    const m = raw.match(re);
    if (!m) continue;
    const name = m[1].trim();
    const text = m[2].trim();
    if (!text) continue;
    if (SELF.test(name)) return { name: null, text };
    return { name, text };
  }
  // "My journal: …" / "Journal: …" — no person, just a lead to drop.
  const own = raw.match(new RegExp(String.raw`^\s*(?:my\s+)?${KIND}\s*[:\-—]\s*(.+)$`, "isu"));
  if (own && own[1].trim()) return { name: null, text: own[1].trim() };
  return { name: null, text: raw };
}

/** First clause of the text, capped: the title when no AI title is available. */
export function fallbackTitle(content: string, empty = "Untitled"): string {
  const flat = String(content ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return empty;
  const first = flat.split(/(?<=[.!?])\s|[—;:]\s/)[0] || flat;
  const clean = first.replace(/[.!?]+$/, "");
  return (clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}…` : clean) || empty;
}
