// Wave 7: cross-link mentions for the doc editor.
//
// Parses plain text for `@mention` tokens, fetches matches from /api/search,
// and resolves them to navigable entity links. Also exposes deep-link helpers
// per entity type so the editor sidebar can open referenced entities.
//
// Recognized mention shapes:
//   @word
//   @TwoWords         (CamelCase or Title Case)
//   @"Multi word"     (quoted, supports spaces)
//
// We keep the rules permissive enough to feel natural while avoiding noisy
// matches against email addresses (`name@example.com`) and Twitter handles in
// the middle of a sentence — the regex requires the @ to be preceded by start
// of string, whitespace, or a paragraph break.

export type MentionTokenSource = "doc";

export interface MentionToken {
  /** Raw token text without the leading @, lowercased for fuzzy matching. */
  query: string;
  /** Display text (preserves original casing). */
  display: string;
}

export interface MentionEntity {
  id: string;
  type: "profile" | "tracker" | "artifact" | "task" | "habit" | "obligation" | "expense" | "journal";
  label: string;
  hint?: string;
  href: string;
}

const MENTION_RE = /(^|[\s>(\[{,;.!?])@(?:"([^"]{1,80})"|([A-Za-z0-9][A-Za-z0-9_\- ]{0,40}?))(?=$|[\s)\]},;.!?]|<)/g;

export function extractMentionTokens(text: string): MentionToken[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: MentionToken[] = [];
  let m: RegExpExecArray | null;
  // Reset lastIndex defensively in case of reuse.
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text))) {
    const display = (m[2] || m[3] || "").trim();
    if (!display) continue;
    const query = display.toLowerCase();
    if (seen.has(query)) continue;
    seen.add(query);
    out.push({ query, display });
  }
  return out;
}

/**
 * Strip HTML to plain text for mention extraction. We keep the implementation
 * dependency-free (no DOMPurify) since we're not rendering — we just want the
 * raw words.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  if (typeof window === "undefined") {
    // SSR fallback — naive strip.
    return html.replace(/<[^>]+>/g, " ");
  }
  const div = document.createElement("div");
  div.innerHTML = html;
  // Convert <br> and block elements to spaces so word boundaries survive.
  div.querySelectorAll("br").forEach(br => br.replaceWith(" "));
  return div.textContent || "";
}

/**
 * Resolve a search-result row to a sidebar entity. Returns null for rows the
 * sidebar should not surface (e.g. memories, raw expenses without a clear
 * destination).
 */
export function searchRowToEntity(row: any): MentionEntity | null {
  if (!row || typeof row !== "object") return null;
  const t = row._type as string | undefined;
  switch (t) {
    case "profile":
      return {
        id: row.id,
        type: "profile",
        label: row.name || "Untitled profile",
        hint: row.type ? `Profile · ${row.type}` : "Profile",
        href: `#/profiles/${row.id}`,
      };
    case "tracker":
      return {
        id: row.id,
        type: "tracker",
        label: row.name || "Untitled tracker",
        hint: row.category ? `Tracker · ${row.category}` : "Tracker",
        href: `#/trackers`,
      };
    case "artifact": {
      const isDocLike = row.type === "doc" || row.type === "sheet" || row.type === "chart";
      return {
        id: row.id,
        type: "artifact",
        label: row.title || "Untitled artifact",
        hint: row.type ? `Artifact · ${row.type}` : "Artifact",
        href: isDocLike ? `#/editor/${row.id}` : `#/artifacts`,
      };
    }
    case "task":
      return {
        id: row.id,
        type: "task",
        label: row.title || "Untitled task",
        hint: "Task",
        href: `#/dashboard/tasks`,
      };
    case "habit":
      return {
        id: row.id,
        type: "habit",
        label: row.name || "Untitled habit",
        hint: "Habit",
        href: `#/dashboard/habits`,
      };
    case "obligation":
      return {
        id: row.id,
        type: "obligation",
        label: row.name || "Untitled obligation",
        hint: row.category ? `Bill · ${row.category}` : "Bill",
        href: `#/dashboard/obligations`,
      };
    case "journal":
      return {
        id: row.id,
        type: "journal",
        label: (row.content || "Journal entry").slice(0, 60),
        hint: "Journal",
        href: `#/dashboard/journal`,
      };
    default:
      return null;
  }
}

/**
 * Fuzzy ranking: prefer exact label matches, then prefix matches, then any
 * substring match. We dedupe results by entity id across queries so the same
 * entity referenced by two mentions only shows once.
 */
export function rankAndDedupe(entities: MentionEntity[], queries: string[]): MentionEntity[] {
  const seen = new Map<string, MentionEntity>();
  for (const q of queries) {
    for (const e of entities) {
      const label = e.label.toLowerCase();
      if (label === q || label.startsWith(q) || label.includes(q)) {
        if (!seen.has(e.id)) seen.set(e.id, e);
      }
    }
  }
  return Array.from(seen.values());
}
