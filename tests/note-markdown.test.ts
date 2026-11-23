// A note is markdown in storage and rich text in the Notes workspace
// (owner request 2026-11-23). These pin the bridge: what the editor shows is
// what was stored, and what it saves is markdown the rest of the app reads.
import { describe, it, expect } from "vitest";
import {
  markdownToNoteHtml, noteDocToMarkdown, noteNeedsPlainEditor,
  noteCategory, noteLabels, noteTagsFor, noteAttachments, attachmentLink, type NoteNode,
} from "../shared/note-markdown";

const p = (...content: NoteNode[]): NoteNode => ({ type: "paragraph", content });
const t = (text: string, ...marks: string[]): NoteNode => ({ type: "text", text, marks: marks.map((type) => ({ type })) });
const doc = (...content: NoteNode[]): NoteNode => ({ type: "doc", content });

describe("markdown → the editor", () => {
  it("a check list becomes check items, with their state", () => {
    expect(markdownToNoteHtml("- [ ] milk\n- [x] eggs")).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>milk</p></li><li data-type="taskItem" data-checked="true"><p>eggs</p></li></ul>');
  });

  it("headings, emphasis, lists and links come through", () => {
    const html = markdownToNoteHtml("# Trip\n\n**Pack** the *charger*\n\n1. one\n2. two\n\n[site](https://example.test)");
    expect(html).toContain("<h1>Trip</h1>");
    expect(html).toContain("<strong>Pack</strong> the <em>charger</em>");
    expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(html).toContain('<a href="https://example.test">site</a>');
  });

  it("a list that mixes checks and plain items keeps the boxes as text", () => {
    expect(markdownToNoteHtml("- [ ] milk\n- bread")).toBe("<ul><li>[ ] milk</li><li>bread</li></ul>");
  });

  it("raw HTML in a note is shown as text, never run", () => {
    const html = markdownToNoteHtml('hello <img src=x onerror="alert(1)">');
    expect(html).not.toMatch(/<img/);
    expect(html).toContain("&lt;img");
  });

  it("an empty note is an empty paragraph", () => {
    expect(markdownToNoteHtml("")).toBe("<p></p>");
  });
});

describe("the editor → markdown", () => {
  it("writes the structures the editor has", () => {
    const md = noteDocToMarkdown(doc(
      { type: "heading", attrs: { level: 2 }, content: [t("Groceries")] },
      p(t("Buy "), t("fresh", "bold"), t(" things, "), t("soon", "italic"), t(".")),
      { type: "taskList", content: [
        { type: "taskItem", attrs: { checked: false }, content: [p(t("milk"))] },
        { type: "taskItem", attrs: { checked: true }, content: [p(t("eggs"))] },
      ] },
      { type: "bulletList", content: [{ type: "listItem", content: [p(t("bread"))] }] },
      { type: "orderedList", attrs: { start: 1 }, content: [{ type: "listItem", content: [p(t("first"))] }, { type: "listItem", content: [p(t("second"))] }] },
      { type: "blockquote", content: [p(t("a quote"))] },
      { type: "horizontalRule" },
      { type: "codeBlock", attrs: { language: "js" }, content: [t("let a = 1;")] },
    ));
    expect(md).toBe([
      "## Groceries",
      "Buy **fresh** things, *soon*.",
      "- [ ] milk\n- [x] eggs",
      "- bread",
      "1. first\n2. second",
      "> a quote",
      "---",
      "```js\nlet a = 1;\n```",
    ].join("\n\n"));
  });

  it("text that looks like markdown stays text", () => {
    const md = noteDocToMarkdown(doc(p(t("3 * 4 = 12")), p(t("# not a heading")), p(t("- not a list")), p(t("1. not numbered"))));
    expect(md).toBe("3 \\* 4 = 12\n\n\\# not a heading\n\n\\- not a list\n\n1\\. not numbered");
    // …and reads back as the same four paragraphs.
    const html = markdownToNoteHtml(md);
    expect(html).toBe("<p>3 * 4 = 12</p>\n<p># not a heading</p>\n<p>- not a list</p>\n<p>1. not numbered</p>");
  });

  it("a link keeps its address; bold hugs the words, not the spaces", () => {
    const linked: NoteNode = { type: "text", text: "the site", marks: [{ type: "link", attrs: { href: "https://example.test/a b" } }] };
    expect(noteDocToMarkdown(doc(p(t("see "), linked)))).toBe("see [the site](https://example.test/a%20b)");
    expect(noteDocToMarkdown(doc(p(t("a"), t(" bold ", "bold"), t("b"))))).toBe("a **bold** b");
  });

  it("a nested list is indented under its item", () => {
    const md = noteDocToMarkdown(doc({ type: "bulletList", content: [{ type: "listItem", content: [
      p(t("fruit")),
      { type: "bulletList", content: [{ type: "listItem", content: [p(t("apples"))] }] },
    ] }] }));
    expect(md).toBe("- fruit\n  - apples");
  });
});

describe("round trip: what is stored survives being opened and saved", () => {
  // The editor's own parse is the browser's; here the markdown produced for a
  // document is read back and must describe the same content.
  it.each([
    "## Plan\n\nCall the **dentist** and the *vet*.",
    "- [ ] milk\n- [x] eggs",
    "1. first\n2. second",
    "> remember this",
  ])("%s", (md) => {
    const html = markdownToNoteHtml(md);
    expect(markdownToNoteHtml(md)).toBe(html); // stable
    expect(html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length).toBeGreaterThan(3);
  });
});

describe("notes the rich editor would damage open as plain markdown", () => {
  it.each([
    ["| a | b |\n|---|---|\n| 1 | 2 |", true],
    ["![photo](https://example.test/p.png)", true],
    ["hello <b>there</b>", true],
    ["text[^1]\n\n[^1]: a footnote", true],
    ["# Title\n\n- [ ] milk\n\n`<b>` in code is fine", false],
    ["Just a line with a < b comparison", false],
  ])("%j → %s", (md, plain) => {
    expect(noteNeedsPlainEditor(md)).toBe(plain);
  });
});

describe("category and attachments", () => {
  it("a category is one tag; the other tags are the note's labels", () => {
    expect(noteCategory(["car", "category:Home"])).toBe("Home");
    expect(noteCategory(["car"])).toBe("");
    expect(noteLabels(["car", "category:Home"])).toEqual(["car"]);
    expect(noteTagsFor(["car", " car ", ""], "Home")).toEqual(["car", "category:Home"]);
    expect(noteTagsFor(["car"], "")).toEqual(["car"]);
  });

  it("an attachment is a link to a saved document, listed once", () => {
    const a = { name: "lease.pdf", documentId: "d-12ab" };
    const md = `Notes\n\n${attachmentLink(a)}\n${attachmentLink(a)}\n[site](https://example.test)`;
    expect(noteAttachments(md)).toEqual([a]);
    expect(noteAttachments("no files here")).toEqual([]);
  });
});
