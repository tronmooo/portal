// A note is stored as markdown text (chat reads it, search reads it, every
// list shows it). The Notes workspace edits it as rich text. These two
// functions are the bridge: markdown → the editor's HTML, and the editor's
// document → markdown.
//
// What the rich editor can hold: headings, paragraphs, bold / italic /
// strikethrough / inline code, links, bullet, numbered and CHECK lists,
// quotes, code blocks and rules. A note with anything else (a table, raw
// HTML, a picture) is opened as plain markdown instead, so editing it never
// drops what the editor could not show (`noteNeedsPlainEditor`).
//
// Pure. Pinned by tests/note-markdown.test.ts.
import { marked, type Tokens } from "marked";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A note the rich editor would damage: keep it in the plain editor. */
export function noteNeedsPlainEditor(markdown: string): boolean {
  const md = String(markdown ?? "");
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m.test(md)) return true; // a table's rule row
  if (/!\[[^\]]*\]\([^)]*\)/.test(md)) return true;                                // a picture
  if (/<\/?[a-z][a-z0-9]*(\s[^<>]*)?>/i.test(md.replace(/`[^`]*`/g, "").replace(/```[\s\S]*?```/g, ""))) return true; // raw HTML
  if (/^\[\^[^\]]+\]:/m.test(md)) return true;                                     // footnotes
  return false;
}

/** Markdown → HTML in the shape the note editor reads (check lists included). */
export function markdownToNoteHtml(markdown: string): string {
  const renderer = new marked.Renderer();
  renderer.html = (token: Tokens.HTML | Tokens.Tag) => escapeHtml(String((token as any).text ?? (token as any).raw ?? ""));
  renderer.checkbox = () => "";
  renderer.listitem = function (item: Tokens.ListItem) {
    const inner = this.parser.parse(item.tokens, !!item.loose).trim();
    if (item.task) {
      const body = /^<p>/.test(inner) ? inner : `<p>${inner}</p>`;
      return `<li data-type="taskItem" data-checked="${item.checked ? "true" : "false"}">${body}</li>`;
    }
    return `<li>${inner}</li>`;
  };
  renderer.list = function (token: Tokens.List) {
    const allTasks = token.items.length > 0 && token.items.every((i) => i.task);
    if (!allTasks) {
      // A list that mixes checks and plain items stays a plain list, with the
      // boxes kept as text so they are not lost.
      const body = token.items.map((i) => {
        const inner = this.parser.parse(i.tokens, !!i.loose).trim();
        const box = i.task ? (i.checked ? "[x] " : "[ ] ") : "";
        return `<li>${/^<p>/.test(inner) ? inner.replace(/^<p>/, `<p>${box}`) : `${box}${inner}`}</li>`;
      }).join("");
      const tag = token.ordered ? "ol" : "ul";
      const start = token.ordered && typeof token.start === "number" && token.start !== 1 ? ` start="${token.start}"` : "";
      return `<${tag}${start}>${body}</${tag}>`;
    }
    return `<ul data-type="taskList">${token.items.map((i) => this.listitem(i)).join("")}</ul>`;
  };
  const html = marked.parse(String(markdown ?? ""), { gfm: true, breaks: true, async: false, renderer }) as string;
  return html.trim() || "<p></p>";
}

// ── editor document → markdown ──────────────────────────────────────────────
export interface NoteNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
  content?: NoteNode[];
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/`/g, "\\`")
    .replace(/(^|[\s(])_(?=\S)/g, "$1\\_")
    .replace(/\[(?=[^\]]*\]\()/g, "\\[")
    .replace(/</g, "&lt;");
}

function inline(nodes: NoteNode[] | undefined): string {
  let out = "";
  for (const n of nodes || []) {
    if (n.type === "hardBreak") { out += "  \n"; continue; }
    if (n.type !== "text") { out += inline(n.content); continue; }
    const marks = new Set((n.marks || []).map((m) => m.type));
    const link = (n.marks || []).find((m) => m.type === "link");
    let text = n.text || "";
    if (marks.has("code")) {
      text = `\`${text.replace(/`/g, "'")}\``;
    } else {
      // Emphasis marks hug the words: spaces at the ends stay outside them.
      const lead = /^\s*/.exec(text)![0];
      const trail = /\s*$/.exec(text.slice(lead.length))![0];
      let core = escapeText(text.slice(lead.length, text.length - trail.length));
      if (core) {
        if (marks.has("strike")) core = `~~${core}~~`;
        if (marks.has("italic")) core = `*${core}*`;
        if (marks.has("bold")) core = `**${core}**`;
      }
      text = `${lead}${core}${trail}`;
    }
    if (link?.attrs?.href) text = `[${text}](${String(link.attrs.href).replace(/[()\s]/g, encodeURIComponent)})`;
    out += text;
  }
  return out;
}

/** A line that would read as markdown structure is escaped at its start. */
function guardLineStart(line: string): string {
  // "1. x" is escaped after the number ("1\. x"): a digit cannot take a backslash.
  const numbered = /^(\s*\d+)([.)]\s)/.exec(line);
  if (numbered) return `${numbered[1]}\\${line.slice(numbered[1].length)}`;
  return line.replace(/^(\s*)(#{1,6}\s|>|[-+]\s|={3,}\s*$|-{3,}\s*$)/, (_m, sp, lead) => `${sp}\\${lead}`);
}

function indent(text: string, pad: string): string {
  return text.split("\n").map((l, i) => (i === 0 || !l ? l : pad + l)).join("\n");
}

function block(n: NoteNode): string {
  switch (n.type) {
    case "paragraph":
      return inline(n.content).split("\n").map(guardLineStart).join("\n");
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, Number(n.attrs?.level) || 1)))} ${inline(n.content)}`;
    case "blockquote":
      return blocks(n.content).split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
    case "codeBlock":
      return `\`\`\`${n.attrs?.language || ""}\n${(n.content || []).map((c) => c.text || "").join("")}\n\`\`\``;
    case "horizontalRule":
      return "---";
    case "bulletList":
      return (n.content || []).map((li) => `- ${indent(blocks(li.content, true), "  ")}`).join("\n");
    case "orderedList": {
      const start = Number(n.attrs?.start) || 1;
      return (n.content || []).map((li, i) => {
        const lead = `${start + i}. `;
        return `${lead}${indent(blocks(li.content, true), " ".repeat(lead.length))}`;
      }).join("\n");
    }
    case "taskList":
      return (n.content || []).map((li) => `- [${li.attrs?.checked ? "x" : " "}] ${indent(blocks(li.content, true), "  ")}`).join("\n");
    default:
      return n.content ? blocks(n.content) : (n.text || "");
  }
}

function blocks(nodes: NoteNode[] | undefined, tight = false): string {
  return (nodes || []).map(block).join(tight ? "\n" : "\n\n");
}

/** The editor's document (TipTap JSON) as markdown. */
export function noteDocToMarkdown(doc: NoteNode | null | undefined): string {
  return blocks(doc?.content).replace(/\n{3,}/g, "\n\n").trim();
}

// ── categories and attachments live in what a note already has ──────────────
export const CATEGORY_TAG_PREFIX = "category:";

/** A note's category: its one `category:<name>` tag. */
export function noteCategory(tags: string[] | undefined | null): string {
  const t = (tags || []).find((x) => typeof x === "string" && x.toLowerCase().startsWith(CATEGORY_TAG_PREFIX));
  return t ? t.slice(CATEGORY_TAG_PREFIX.length).trim() : "";
}
export function noteLabels(tags: string[] | undefined | null): string[] {
  return (tags || []).filter((x) => typeof x === "string" && !x.toLowerCase().startsWith(CATEGORY_TAG_PREFIX));
}
export function noteTagsFor(labels: string[], category: string): string[] {
  const clean = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
  const cat = category.trim();
  return cat ? [...clean, `${CATEGORY_TAG_PREFIX}${cat}`] : clean;
}

export interface NoteAttachment { name: string; documentId: string }
const ATTACHMENT_RE = /\[([^\]]+)\]\(#\/documents\/([A-Za-z0-9-]+)\)/g;
/** Files attached to a note: its links to saved documents. */
export function noteAttachments(markdown: string): NoteAttachment[] {
  const seen = new Set<string>();
  const out: NoteAttachment[] = [];
  for (const m of String(markdown ?? "").matchAll(ATTACHMENT_RE)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ name: m[1].replace(/\\/g, ""), documentId: m[2] });
  }
  return out;
}
export function attachmentLink(a: NoteAttachment): string {
  return `[${a.name.replace(/[\[\]]/g, "")}](#/documents/${a.documentId})`;
}
