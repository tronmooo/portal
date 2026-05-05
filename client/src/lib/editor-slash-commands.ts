// Slash command items for the doc editor. The editor watches for "/" being
// typed and renders a floating menu populated from this list. Selecting an item
// calls `run(editor)` which invokes the Tiptap chain to apply the formatting.
//
// Item categories:
//   - basic blocks (heading, list, divider, quote, code)
//   - AI (improve, summarize, continue, shorten, expand, fix grammar)
//
// AI items dispatch a custom event "portol:ai-command" with detail.command and
// detail.selection — editor.tsx listens for this and runs the AI request.

import type { Editor } from "@tiptap/react";

export type SlashItem = {
  id: string;
  label: string;
  hint?: string;
  group: "basic" | "ai";
  keywords: string[];
  run: (editor: Editor) => void;
};

// Helper to remove the "/" trigger and any query the user has typed after it.
function clearSlashQuery(editor: Editor) {
  const { from } = editor.state.selection;
  // Walk backwards from the cursor until we hit the "/" trigger or whitespace.
  const $from = editor.state.doc.resolve(from);
  const lineText = $from.parent.textContent;
  const offsetInBlock = $from.parentOffset;
  // Scan back to find the "/" at start of slash query.
  let queryStart = offsetInBlock;
  for (let i = offsetInBlock - 1; i >= 0; i--) {
    const ch = lineText[i];
    if (ch === "/") { queryStart = i; break; }
    if (ch === " " || ch === "\t" || ch === "\n") break;
  }
  // Convert back to absolute positions.
  const absStart = from - (offsetInBlock - queryStart);
  editor.chain().focus().setTextSelection({ from: absStart, to: from }).deleteSelection().run();
}

// AI command dispatch — editor.tsx attaches a handler to the window for this event.
function dispatchAi(editor: Editor, command: string) {
  const { from, to } = editor.state.selection;
  const selectedText = editor.state.doc.textBetween(from, to, "\n").trim();
  // If nothing selected, fall back to the whole current paragraph.
  let context = selectedText;
  if (!context) {
    const $from = editor.state.doc.resolve(from);
    context = $from.parent.textContent;
  }
  const event = new CustomEvent("portol:ai-command", {
    detail: { command, selection: context, from, to: to === from ? from : to },
  });
  window.dispatchEvent(event);
}

export const SLASH_ITEMS: SlashItem[] = [
  // Basic blocks
  {
    id: "h1", label: "Heading 1", hint: "Large title", group: "basic",
    keywords: ["h1", "heading", "title", "header"],
    run: (e) => { clearSlashQuery(e); e.chain().focus().toggleHeading({ level: 1 }).run(); },
  },
  {
    id: "h2", label: "Heading 2", hint: "Section heading", group: "basic",
    keywords: ["h2", "heading", "subtitle"],
    run: (e) => { clearSlashQuery(e); e.chain().focus().toggleHeading({ level: 2 }).run(); },
  },
  {
    id: "h3", label: "Heading 3", hint: "Subsection", group: "basic",
    keywords: ["h3", "heading"],
    run: (e) => { clearSlashQuery(e); e.chain().focus().toggleHeading({ level: 3 }).run(); },
  },
  {
    id: "bullet", label: "Bullet list", hint: "Unordered list", group: "basic",
    keywords: ["list", "ul", "bullet", "unordered"],
    run: (e) => { clearSlashQuery(e); e.chain().focus().toggleBulletList().run(); },
  },
  {
    id: "ordered", label: "Numbered list", hint: "Ordered list", group: "basic",
    keywords: ["list", "ol", "numbered", "ordered"],
    run: (e) => { clearSlashQuery(e); e.chain().focus().toggleOrderedList().run(); },
  },
  {
    id: "quote", label: "Quote", hint: "Blockquote", group: "basic",
    keywords: ["quote", "blockquote", "callout"],
    run: (e) => { clearSlashQuery(e); e.chain().focus().toggleBlockquote().run(); },
  },
  {
    id: "code", label: "Code block", hint: "Monospace block", group: "basic",
    keywords: ["code", "pre", "snippet"],
    run: (e) => { clearSlashQuery(e); e.chain().focus().toggleCodeBlock().run(); },
  },
  {
    id: "divider", label: "Divider", hint: "Horizontal rule", group: "basic",
    keywords: ["hr", "rule", "divider", "separator", "line"],
    run: (e) => { clearSlashQuery(e); e.chain().focus().setHorizontalRule().run(); },
  },

  // AI commands
  {
    id: "ai-improve", label: "AI: Improve writing", hint: "Polish selection or paragraph", group: "ai",
    keywords: ["ai", "improve", "polish", "rewrite"],
    run: (e) => { clearSlashQuery(e); dispatchAi(e, "improve"); },
  },
  {
    id: "ai-summarize", label: "AI: Summarize", hint: "Condense to bullet points", group: "ai",
    keywords: ["ai", "summarize", "summary", "tldr"],
    run: (e) => { clearSlashQuery(e); dispatchAi(e, "summarize"); },
  },
  {
    id: "ai-continue", label: "AI: Continue writing", hint: "Add a paragraph after this", group: "ai",
    keywords: ["ai", "continue", "more", "write"],
    run: (e) => { clearSlashQuery(e); dispatchAi(e, "continue"); },
  },
  {
    id: "ai-shorten", label: "AI: Make shorter", hint: "Trim to essentials", group: "ai",
    keywords: ["ai", "shorten", "tighten", "concise"],
    run: (e) => { clearSlashQuery(e); dispatchAi(e, "shorten"); },
  },
  {
    id: "ai-expand", label: "AI: Make longer", hint: "Add detail and examples", group: "ai",
    keywords: ["ai", "expand", "elaborate", "longer"],
    run: (e) => { clearSlashQuery(e); dispatchAi(e, "expand"); },
  },
  {
    id: "ai-grammar", label: "AI: Fix grammar & spelling", hint: "Proofread selection", group: "ai",
    keywords: ["ai", "grammar", "spelling", "proofread", "fix"],
    run: (e) => { clearSlashQuery(e); dispatchAi(e, "grammar"); },
  },
];

export function filterSlashItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(item => {
    if (item.label.toLowerCase().includes(q)) return true;
    if (item.id.toLowerCase().includes(q)) return true;
    return item.keywords.some(k => k.includes(q));
  });
}
