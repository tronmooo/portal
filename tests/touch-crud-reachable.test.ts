// Every edit and delete control must be reachable on a phone.
//
// User report 2026-07-26 (Info tab screenshot, iPhone):
//   "Why won't it let me edit these or delete them or crud functionality make
//    sure there's nothing like this in my app. I want you to do a full audit."
//
// THE BUG. Controls were styled `opacity-0 group-hover:opacity-100` — invisible
// until the pointer hovers the row. A touch screen never hovers, so on the
// phone the delete button was rendered at zero opacity and simply did not
// exist. The code looked correct in review and passed every unit test, because
// the handler was wired; only the pixels were missing.
//
// The audit found 13 real controls in this state:
//
//   pages/profile-detail.tsx        7 × Trash2 delete, 1 × find-value
//   components/DocumentViewer.tsx   1 × delete extracted field
//   pages/document-detail.tsx       1 × delete extracted field
//   pages/chat.tsx                  1 × remove attachment
//   pages/dashboard.tsx             1 × pin / unpin
//   components/ui/toast.tsx         1 × dismiss
//
// THE PATTERN that works, already used at profile-detail.tsx:2430:
//   opacity-60 sm:opacity-0 sm:group-hover:opacity-100
// Visible (dimmed) on touch, hover-reveal from the `sm` breakpoint up.
//
// Decorative overlays are exempt — an avatar's camera scrim and a link's
// chevron are not controls; the element behind them is already tappable.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "client/src");

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.tsx$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const HOVER_ONLY = /opacity-0[^"'`]*group-hover:opacity-100/;
/** Mobile-safe: dimmed-but-present on touch, hover-reveal on pointer devices. */
const TOUCH_SAFE = /sm:opacity-0/;

/**
 * A hover-only class is acceptable only on a non-interactive overlay: an avatar
 * scrim or an affordance chevron sitting inside an already-tappable parent.
 */
const DECORATIVE = /bg-black\/\d+|<(ExternalLink|ChevronRight|ChevronDown|ArrowUpRight)\b/;

interface Offender { file: string; line: number; snippet: string; }

function findOffenders(): Offender[] {
  const out: Offender[] = [];
  for (const file of walk(ROOT)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // Skip our own explanatory comments.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (!HOVER_ONLY.test(line)) return;
      if (TOUCH_SAFE.test(line)) return;
      // Look at the element this class belongs to, a few lines either side.
      const ctx = lines.slice(Math.max(0, i - 4), i + 5).join("\n");
      if (DECORATIVE.test(ctx) && !/<button|onClick=/.test(lines[i])) return;
      // An interactive element within the same tag?
      if (!/<button|onClick=|role="button"|<a\b/.test(ctx)) return;
      out.push({
        file: path.relative(path.resolve(__dirname, ".."), file),
        line: i + 1,
        snippet: line.trim().slice(0, 100),
      });
    });
  }
  return out;
}

describe("no control is hover-only", () => {
  it("every interactive element stays visible without a mouse", () => {
    const offenders = findOffenders();
    const report = offenders.map((o) => `  ${o.file}:${o.line}  ${o.snippet}`).join("\n");
    expect(
      offenders,
      `these controls are invisible on a touch screen — use ` +
      `"opacity-60 sm:opacity-0 sm:group-hover:opacity-100" instead:\n${report}`,
    ).toEqual([]);
  });

  it("the audit actually inspects the app, not an empty list", () => {
    // Guards the walker: a broken path would make the test above pass trivially.
    const files = walk(ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith("profile-detail.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("profile-info.tsx"))).toBe(true);
  });
});

describe("the Info tab can edit and delete every field it shows", () => {
  const SRC = fs.readFileSync(path.resolve(ROOT, "pages/profile-info.tsx"), "utf8");

  it("renders nested-group fields with the editable cell, not plain text", () => {
    // IDENTITY / PERSONAL / VEHICLES fields used to render as bare <div> text —
    // no onSave, no onRemove. That is most of what a scanned licence writes, and
    // it was all permanently read-only.
    const start = SRC.indexOf("{nestedGroups.map(");
    expect(start, "nested group rendering not found").toBeGreaterThan(-1);
    // Anchor on the cell itself rather than a byte window from the map — a
    // window is measuring comment length, and this test failed once for the
    // crime of someone explaining the code above it.
    const cell = SRC.indexOf("<FieldCell", start);
    expect(cell, "nested fields still render as static text").toBeGreaterThan(-1);
    const block = SRC.slice(cell, cell + 400);
    expect(block).toMatch(/onSave=\{/);
    expect(block).toMatch(/onRemove=\{/);
  });

  it("writes a nested edit back into its group, not to the top level", () => {
    // saveField sends `{ fields: { [key]: value } }`, which storage merges at
    // the TOP level — so editing `identity.class` minted a top-level `class`
    // and left the nested value stale. Nested cells must use saveGroupField.
    const start = SRC.indexOf("{nestedGroups.map(");
    const cell = SRC.indexOf("<FieldCell", start);
    const block = SRC.slice(cell, cell + 400);
    expect(block).toMatch(/onSave=\{[^}]*saveGroupField\(/);
  });

  it("deletes through the shared identity resolver, nested keys included", () => {
    expect(SRC).toContain("fieldsToDelete");
    expect(SRC).toContain("deleteProfileFields");
  });

  it("keeps the remove button visible without hover", () => {
    // Anchored on the testid, which survives the aria-label gaining a
    // `removeTitle ||` override for cells whose X removes a different field.
    const at = SRC.indexOf("data-testid={`info-remove-${label}`}");
    expect(at).toBeGreaterThan(-1);
    const btn = SRC.slice(Math.max(0, at - 600), at);
    expect(btn).not.toMatch(/opacity-0(?!.*sm:)/);
  });

  it("gives every field cell a delete, including the derived Age", () => {
    // User, 2026-08-05: "Why will it not let me delete the age". Age is computed
    // from Birthday and had no key of its own, so it got no X; Birthday was
    // separately excluded by name. Both are removable now.
    expect(SRC).toContain("removeAge");
    expect(SRC).toMatch(/removeAge\s*=\s*\(\)\s*=>\s*\n?\s*removeField\("birthday"/);
    // The old hard-coded escape hatch must not come back.
    expect(SRC).not.toMatch(/!\["birthday"\]\.includes/);
  });

  it("lets the Info tab delete its documents", () => {
    // The documents card was the one section on the page with no delete at all.
    expect(SRC).toMatch(/apiRequest\("DELETE", `\/api\/documents\/\$\{docId\}\?purgeFields=/);
    expect(SRC).toContain("info-doc-remove-");
  });
});

// ── Deleting a document asks first, and offers to take its data with it ───────
//
// User, 2026-08-05: "When you delete a document, you should delete all the data
// that comes with it and it should ask before you delete a document. If there is
// data I've saved with the document there should be an option when you delete the
// document it should say are you sure? Do you want to remove all the data in the
// info?"
//
// Four screens delete documents. They had four different answers to "does this
// ask first?" — the liability card didn't ask at all — and none of them mentioned
// the profile fields the document had written. One shared dialog now, so the
// question and the options can't differ by screen.
describe("every document delete goes through the shared confirmation", () => {
  const SURFACES = [
    "pages/profile-info.tsx",
    "pages/profile-detail.tsx",
    "pages/trackers.tsx",
    "pages/liability-detail.tsx",
  ];

  function read(rel: string): string {
    return fs.readFileSync(path.resolve(ROOT, rel), "utf8");
  }

  it("finds every surface that deletes a document", () => {
    // Guards the list below: a NEW delete surface must be added here, or this
    // whole describe block silently stops covering it.
    const withDelete = walk(ROOT).filter((f) =>
      /apiRequest\("DELETE", `\/api\/documents\//.test(fs.readFileSync(f, "utf8")));
    const rel = withDelete.map((f) => path.relative(ROOT, f)).sort();
    expect(rel).toEqual(SURFACES.slice().sort());
  });

  for (const surface of SURFACES) {
    it(`${surface} confirms through DeleteDocumentDialog`, () => {
      const src = read(surface);
      expect(src).toContain("DeleteDocumentDialog");
      // No delete may fire straight from a click handler — liability-detail.tsx
      // used to do exactly that, with no prompt on a permanent action.
      expect(src).not.toMatch(/onClick=\{\(\)\s*=>\s*deleteMutation\.mutate\(doc\.id\)\}/);
    });

    it(`${surface} passes the user's purge choice to the server`, () => {
      // The checkbox is meaningless if the caller drops it: the flag has to
      // reach DELETE /api/documents/:id or the data silently survives (or
      // silently doesn't) regardless of what the user chose.
      expect(read(surface)).toMatch(/purgeFields=\$\{purgeFields \? 1 : 0\}/);
    });
  }

  it("the dialog states what it will remove and defaults to removing it", () => {
    const dlg = read("components/DeleteDocumentDialog.tsx");
    // Asks the server what is actually on the profile right now…
    expect(dlg).toContain("derived-fields");
    // …offers the choice, checked by default ("delete the document" should mean
    // the data goes too)…
    expect(dlg).toContain("useState(true)");
    expect(dlg).toContain("doc-delete-purge-fields");
    // …and warns when a purge would discard the user's own edit.
    expect(dlg).toContain("editedCount");
  });
});
