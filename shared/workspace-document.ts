// The Document workspace's AI (owner request 2026-11-22: "Portol already
// knows about you"): a document is written or revised from the facts on file
// and shown as a proposal the user accepts into the editor.
//
// The rules here are the ones that keep the draft honest:
//  - A fact the records do not hold is never made up. The model is told to
//    write a marked blank, `[Missing: phone number]`, and the list of blanks
//    the workspace shows is READ BACK from the returned text (`documentBlanks`), not
//    taken from what the model says it left out.
//  - The saved HTML is only what the editor can hold (`sanitizeDocumentHtml`).
//
// Pure. Pinned by tests/workspace-ai.test.ts.

/** The marker a missing fact is written as. */
export const MISSING_MARK_RE = /\[Missing:\s*([^\]\n]{1,80})\]/gi;

/** The blanks a draft still has, in order, once each. */
export function documentBlanks(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of String(html ?? "").matchAll(MISSING_MARK_RE)) {
    const label = m[1].replace(/\s+/g, " ").trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

const KEEP_TAGS = new Set([
  "p", "h1", "h2", "h3", "ul", "ol", "li", "strong", "b", "em", "i", "u", "s",
  "a", "br", "hr", "blockquote", "code", "pre",
  "table", "thead", "tbody", "tr", "th", "td",
]);
const VOID_TAGS = new Set(["br", "hr"]);
/** Elements whose CONTENT goes too, not only the tag. */
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|noscript|template|svg|math|head|title)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

function safeHref(raw: string): string | null {
  const href = raw.trim().replace(/[\u0000-\u001f\s]+/g, "");
  return /^(https?:\/\/|mailto:|tel:)/i.test(href) ? href.replace(/"/g, "%22") : null;
}

/**
 * Keep only the tags the document editor has, with no attributes except a
 * link's http(s)/mailto/tel address. Everything else loses its tag and keeps
 * its text; script-like elements go with their content.
 */
export function sanitizeDocumentHtml(input: string): string {
  let html = String(input ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(DROP_WITH_CONTENT, "");
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/g, (whole, rawName: string, attrs: string) => {
    const name = rawName.toLowerCase();
    if (!KEEP_TAGS.has(name)) return "";
    const closing = whole.startsWith("</");
    if (closing) return VOID_TAGS.has(name) ? "" : `</${name}>`;
    if (name === "a") {
      const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const href = m ? safeHref(m[1] ?? m[2] ?? m[3] ?? "") : null;
      return href ? `<a href="${href}">` : "<a>";
    }
    return `<${name}>`;
  });
  // A stray "<" that opened no kept tag must not open one later.
  return html.replace(/<(?!\/?(?:p|h[1-3]|ul|ol|li|strong|b|em|i|u|s|a|br|hr|blockquote|code|pre|table|thead|tbody|tr|th|td)\b)/gi, "&lt;").trim();
}

/** The draft's text without its tags, for a preview line. */
export function documentPlainText(html: string): string {
  return String(html ?? "")
    .replace(/<\/(p|h[1-3]|li|blockquote|pre)>|<br>|<hr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

export interface ParsedDraft { title: string | null; html: string }

/**
 * Read the model's answer: an optional first line `TITLE: …`, then the HTML.
 * Null when there is no document in it.
 */
export function parseDraftReply(raw: string): ParsedDraft | null {
  let text = String(raw ?? "").trim();
  text = text.replace(/^```(?:html)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  let title: string | null = null;
  const m = /^\s*TITLE\s*:\s*(.+)\s*(?:\n|$)/i.exec(text);
  if (m) {
    title = m[1].replace(/^["'“”*#\s]+|["'“”*\s]+$/g, "").trim().slice(0, 80) || null;
    text = text.slice(m[0].length).trim();
    text = text.replace(/^```(?:html)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  }
  // Plain text back instead of HTML: keep it, one paragraph per block.
  if (text && !/<(p|h[1-3]|ul|ol|li)\b/i.test(text)) {
    text = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
      .map((b) => `<p>${b.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`).join("");
  }
  const html = sanitizeDocumentHtml(text);
  if (documentPlainText(html).length < 20) return null;
  return { title, html };
}

// ── Pictures stay out of the model's hands ──────────────────────────────────
// A picture in a document is megabytes of base64. Before a document goes to
// the model each one is swapped for a marker, and put back in what returns.

export function picturesToMarkers(html: string): { html: string; pictures: string[] } {
  const pictures: string[] = [];
  const out = String(html ?? "").replace(/<img\b[^>]*>/gi, (tag) => {
    pictures.push(tag);
    return `<p>[[PICTURE ${pictures.length}]]</p>`;
  });
  return { html: out, pictures };
}

/** Put the pictures back. One the model dropped is appended, never lost. */
export function markersToPictures(html: string, pictures: string[]): string {
  const used = new Set<number>();
  let out = String(html ?? "").replace(/(?:<p>\s*)?\[\[PICTURE (\d+)\]\](?:\s*<\/p>)?/gi, (_m, n) => {
    const i = Number(n) - 1;
    if (!pictures[i] || used.has(i)) return "";
    used.add(i);
    return pictures[i];
  });
  pictures.forEach((tag, i) => { if (!used.has(i)) out += tag; });
  return out;
}
