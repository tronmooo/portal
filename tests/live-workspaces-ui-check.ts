// Live walk-through (deployed app, smoke account, real browser) of the four
// full-screen workspaces opened from the chat box: Notes, Journal, Document
// and Fill In (CLAUDE.md "Workspace rules"). It clicks the real controls.
//   npx tsx tests/live-workspaces-ui-check.ts
// Takes the gate lock; deletes what it creates. SHOT_DIR=<dir> keeps
// screenshots. SMOKE_UI_BASE points it at another build of the client.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const req = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || "";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const get = async (path: string): Promise<any> => { const r = await api("GET", path); if (!r.ok) throw new Error(`GET ${path}: ${r.status}`); return r.data; };
const until = async (fn: () => Promise<boolean>, ms = 20000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 500)); }
  return false;
};

/** A one-page PDF with a line of text, built by hand (no library needed). */
function tinyPdf(): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 18 Tf 72 720 Td (Application form  Full name: ________  Email: ________) Tj ET";
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-workspaces-ui-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const startJournal = new Set(((await get("/journal")) as any[]).map((j) => j.id));
  const mineJ = async () => ((await get("/journal")) as any[]).filter((j) => !startJournal.has(j.id));
  const taggedArtifacts = async () => ((await get("/artifacts")) as any[]).filter((a) => `${a.title} ${a.content}`.includes(tag));
  let browser: any;
  try {
    const version = await (await fetch(`${UI_BASE}/api/version`)).json().catch(() => ({}));
    console.log(`serving ${String(version.sha || "unknown").slice(0, 7)} at ${UI_BASE}`);
    // Are the workspaces' AI routes on this server? (An empty ask is a 400 there, a 404 before the deploy.)
    const aiProbe = await api("POST", "/workspace/notes/assist", { instruction: "" });
    const hasAi = aiProbe.status === 400;

    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Los_Angeles" });
    const page = await ctx.newPage();
    const shot = async (name: string) => { if (SHOT) await page.screenshot({ path: `${SHOT}/${name}.png` }).catch(() => undefined); };
    const tid = (id: string) => page.locator(`[data-testid="${id}"]`);
    await page.goto(UI_BASE);
    const email = tid("input-signin-email");
    await email.waitFor({ timeout: 30000 });
    await email.fill(LIVE_EMAIL);
    await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });

    const toChat = async () => {
      await page.evaluate(() => { window.location.hash = "#/chat"; });
      await tid("input-chat").waitFor({ timeout: 30000 });
    };
    /** The workspace covers the whole window: every corner belongs to it. */
    const coversScreen = (id: string) => page.evaluate((testId) => {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      if (!el) return false;
      const pts: Array<[number, number]> = [[4, 4], [window.innerWidth - 4, 4], [4, window.innerHeight - 4], [window.innerWidth - 4, window.innerHeight - 4]];
      return pts.every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
    }, id);
    const closeToChat = async (what: string) => {
      await page.locator('[data-testid="button-workspace-close"]:visible').first().click();
      const back = await until(async () => (await page.evaluate(() => window.location.hash)).startsWith("#/chat") && await tid("input-chat").isVisible());
      check(back, `${what}: the X returns to AI Chat`);
    };

    // ── the chat box ─────────────────────────────────────────────────────
    await toChat();
    const kinds = ["notes", "journal", "document", "fill"];
    const visible = await Promise.all(kinds.map((k) => tid(`button-workspace-${k}`).isVisible()));
    check(visible.every(Boolean), "the chat box shows Notes, Journal, Document and Fill In");
    await shot("0-chat");

    // ── Notes ────────────────────────────────────────────────────────────
    await tid("button-workspace-notes").click();
    await tid("workspace-notes").waitFor({ timeout: 30000 });
    check(await coversScreen("workspace-notes"), "Notes fills the whole screen (no sidebar, no header)");
    // Rich text: a heading line, then a check list, typed into the editor.
    const note = tid("note-rich-editor");
    await note.click();
    await page.keyboard.type(`Workspace note ${tag}`);
    await page.keyboard.press("Enter");
    await tid("button-note-checklist").click();
    await note.locator('ul[data-type="taskList"] > li').first().waitFor({ timeout: 5000 });
    await page.waitForTimeout(300); // the toolbar hands the caret back to the editor
    await page.keyboard.type("pack the charger");
    const noteRow = async () => (await taggedArtifacts()).find((a) => a.type === "note");
    const noteSaved = await until(async () => String((await noteRow())?.content || "").includes("- [ ] pack the charger"));
    check(noteSaved, "Notes: rich text saves itself as a note, the check list as markdown the rest of the app reads");
    check((await tid("workspace-save-status").innerText()).includes("Saved"), "…and the header says Saved");
    await page.keyboard.press("Enter");
    await page.keyboard.type("and the adapter");
    const noteUpdated = await until(async () => {
      const rows = (await taggedArtifacts()).filter((a) => a.type === "note");
      return rows.length === 1 && rows[0].content.includes("- [ ] and the adapter");
    });
    check(noteUpdated, "…more typing updates the same note (one note, not two)");
    await note.locator('input[type="checkbox"]').first().click();
    check(await until(async () => String((await noteRow())?.content || "").includes("- [x] pack the charger")), "…and ticking a box in the note is saved as ticked");
    check(await tid(`note-row-${((await noteRow()) || {}).id}`).isVisible().catch(() => false), "…and it is listed with the saved notes");
    await tid("input-note-category").fill(`Trip ${tag}`);
    check(await until(async () => ((await noteRow())?.tags || []).includes(`category:Trip ${tag}`)), "Notes: a category is saved on the note");
    check(await until(() => tid(`notes-category-Trip ${tag}`).isVisible(), 10000), "…and becomes a filter beside the list");
    await tid("input-note-attach").setInputFiles({ name: `packing-${tag}.txt`, mimeType: "text/plain", buffer: Buffer.from(`packing list ${tag}`) });
    const attached = await until(async () => /\(#\/documents\/[A-Za-z0-9-]+\)/.test(String((await noteRow())?.content || "")), 30000);
    check(attached && await tid("note-attachments").isVisible(), "Notes: an attached file is saved to Documents and linked from the note");
    // Reopen it: what was saved is what the editor shows.
    await tid("button-note-new").click();
    await tid(`note-row-${((await noteRow()) || {}).id}`).click();
    check(await until(async () => (await note.locator('ul[data-type="taskList"] > li').count()) === 2 && (await note.locator('ul[data-type="taskList"] > li[data-checked="true"]').count()) === 1, 10000),
      "Notes: reopened, the note shows its two check items, one ticked");
    await page.waitForTimeout(1500);
    check(String((await noteRow())?.content || "").includes("- [x] pack the charger") && (await tid("workspace-save-status").innerText()).includes("Saved"), "…and reopening it changed nothing");
    if (hasAi) {
      await page.getByText("Turn this into a checklist").click();
      const proposed = await tid("note-ai-proposal").waitFor({ timeout: 90000 }).then(() => true).catch(() => false);
      check(proposed, "Notes AI: a suggestion is shown");
      check((await note.innerText()).includes("and the adapter") && String((await noteRow())?.content || "").includes("- [ ] and the adapter"), "…and the note is unchanged until it is accepted");
      if (proposed) await tid("button-note-ai-discard").click();
    } else console.log("SKIP  Notes AI (this server does not have the workspace AI routes yet)");
    await shot("1-notes");
    await closeToChat("Notes");

    // ── Journal ──────────────────────────────────────────────────────────
    await tid("button-workspace-journal").click();
    await tid("workspace-journal").waitFor({ timeout: 30000 });
    check(await coversScreen("workspace-journal"), "Journal fills the whole screen");
    check(await tid("journal-prompts").isVisible() && await tid("button-mood-good").isVisible() && await tid("journal-week").isVisible(), "Journal: the page has guided prompts, mood buttons and the week's moods");
    const entryText = `Workspace journal ${tag}: a calm and good day.`;
    await tid("input-journal-free-text").fill(entryText);
    await tid("input-journal-photo").setInputFiles({ name: `photo-${tag}.png`, mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQI12P8z8DAwMDEwMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64") });
    const photoShown = await page.locator('[data-testid^="journal-photo-"] img').first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    check(photoShown, "Journal: an added photo shows on the entry");
    await shot("2-journal");
    // Leave at once: the X must save what the typing pause has not saved yet.
    await closeToChat("Journal");
    check(await until(async () => (await mineJ()).some((j) => j.content === entryText), 15000), "Journal: the entry on the page was saved on the way out");
    const savedEntry = (await mineJ()).find((j) => j.content === entryText);
    check((savedEntry?.tags || []).some((t: string) => t.startsWith("photo:")), "…with its photo");
    check(await until(async () => String((await mineJ()).find((j) => j.content === entryText)?.title || "").trim().length >= 3, 15000), "…and a title written for it");

    // ── Document ─────────────────────────────────────────────────────────
    await tid("button-workspace-document").click();
    await tid("workspace-document").waitFor({ timeout: 30000 });
    check(await coversScreen("workspace-document"), "Document fills the whole screen");
    check(await tid("doc-empty-hint").isVisible(), "Document: an empty page says how to start");
    check(await tid("doc-ai-input").isVisible(), "Document: it has its own Ask AI box");
    const docTitle = `Workspace doc ${tag}`;
    await page.locator('[data-testid="input-editor-title"]:visible').fill(docTitle);
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("Dear Sam, thank you for the lovely dinner.");
    const docSaved = await until(async () => (await taggedArtifacts()).some((a) => a.type === "doc" && String(a.content).includes("lovely dinner")), 25000);
    check(docSaved, "Document: a new document saves itself, with no Save press");
    check(await page.evaluate(() => document.activeElement?.classList.contains("ProseMirror") ?? false), "…and the caret stays in the document while it saves");
    if (hasAi) {
      await tid("doc-ai-input").fill("Make the tone warmer");
      await tid("doc-ai-send").click();
      const proposed = await tid("doc-ai-proposal").waitFor({ timeout: 120000 }).then(() => true).catch(() => false);
      check(proposed, "Document AI: a revision is shown as a proposal");
      check((await page.locator(".ProseMirror").innerText()).includes("thank you for the lovely dinner"), "…and the document is unchanged until it is accepted");
      if (proposed) await tid("button-doc-ai-discard").click();
    } else console.log("SKIP  Document AI (this server does not have the workspace AI routes yet)");
    // A table, a picture and the page turned sideways.
    await page.locator(".ProseMirror").click();
    await page.keyboard.press("Control+End");
    await tid("button-doc-table").click();
    await tid("menu-table-insert").click();
    check(await page.locator(".ProseMirror table").count() === 1, "Document: a table can be inserted");
    await tid("input-doc-image").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQI12P8z8DAwMDEwMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64") });
    check(await page.locator(".ProseMirror img").first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false), "Document: a picture can be inserted");
    await tid("button-doc-page-setup").click();
    await tid("menu-page-landscape").click();
    check((await tid("doc-editor-canvas").getAttribute("data-page-setup")) === "page:letter;landscape;normal", "Document: the page can be turned to landscape");
    const richSaved = await until(async () => {
      const d = (await taggedArtifacts()).find((a) => a.type === "doc");
      return !!d && String(d.content).includes("<table") && String(d.content).includes("<img") && d.language === "page:letter;landscape;normal";
    }, 25000);
    check(richSaved, "…and the table, the picture and the page setup are saved with the document");
    await page.waitForTimeout(6000); // a later autosave must not reload the editor
    check(await page.locator(".ProseMirror table").count() === 1 && (await page.evaluate(() => window.location.hash)).startsWith("#/editor/new/doc"), "…and later autosaves leave the editor where it is");
    await shot("3-document");
    // Back into the document (the AI panel had the focus), at the end of the text.
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" See you soon.");
    await closeToChat("Document");
    check(await until(async () => (await taggedArtifacts()).some((a) => a.type === "doc" && String(a.content).includes("See you soon")), 15000), "Document: the last words typed were saved on the way out");
    check((await taggedArtifacts()).filter((a) => a.type === "doc").length === 1, "…as one document, not two");

    // ── Fill In ──────────────────────────────────────────────────────────
    await tid("button-workspace-fill").click();
    await tid("workspace-fill").waitFor({ timeout: 30000 });
    check(await coversScreen("workspace-fill"), "Fill In fills the whole screen");
    check(await tid("fill-drop-zone").isVisible(), "Fill In: there is a place to drop a form");
    await shot("4-fill");
    await tid("input-fill-file").setInputFiles({ name: `form-${tag}.pdf`, mimeType: "application/pdf", buffer: tinyPdf() });
    // The form opens ON the screen, with My Information beside it (the full
    // flow is checked by tests/live-fill-check.ts).
    const opened = await tid("fill-toolbar").waitFor({ timeout: 120000 }).then(() => true).catch(() => false);
    check(opened, "Fill In: a chosen form opens in the workspace with its tools");
    if (opened) {
      check(await tid("fill-panel").isVisible(), "…with My Information beside the form");
      check(await page.locator('[data-testid="button-workspace-close"]:visible').first().isEnabled() && !(await tid("fill-drop-zone").isVisible()), "…with the workspace's X still in reach");
      await shot("5-fill-review");
    }
    // Straight out: the X does not need the form closed first.
    await closeToChat("Fill In");

    // ── drag and drop into the chat box ──────────────────────────────────
    await page.evaluate((name) => {
      const zone = document.querySelector('[data-testid="chat-drop-zone"]')!;
      const dt = new DataTransfer();
      dt.items.add(new File(["hello from a dropped file"], name, { type: "text/plain" }));
      zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, `dropped-${tag}.txt`);
    check(await page.getByText(`dropped-${tag}.txt`).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false), "a file dropped on the chat box is attached");
    await shot("6-dropped");

    // ── a phone ──────────────────────────────────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await toChat();
    await tid("button-workspace-notes").click();
    await tid("workspace-notes").waitFor({ timeout: 30000 });
    check(await coversScreen("workspace-notes"), "on a phone, Notes covers the screen and the bottom tab bar is out of the way");
    await shot("7-phone-notes");
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    for (const j of await mineJ().catch(() => [])) await api("DELETE", `/journal/${j.id}`).catch(() => undefined);
    for (const d of ((await get("/documents").catch(() => [])) as any[]).filter((d) => String(d.name || "").includes(tag))) {
      await api("DELETE", `/documents/${d.id}`).catch(() => undefined);
    }
    for (const a of await taggedArtifacts().catch(() => [])) {
      await api("DELETE", a.type === "note" ? `/notes/${a.id}` : `/artifacts/${a.id}`).catch(() => undefined);
    }
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
