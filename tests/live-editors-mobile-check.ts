// Live check: the three editors on a phone (owner request 2026-11-23,
// "compact, mobile-friendly, unlimited length, Save always reachable").
// Real browser, touch context, three phone widths (320 / 375 / 390), the
// smoke account. For each of Journal, Notes and Document it checks:
//  - nothing is wider than the screen (no sideways scroll, nothing cut off);
//  - the header is X (left) … Save (right), both on screen, and stays on
//    screen after scrolling to the end of a long entry and back;
//  - a long entry (thousands of words, paragraphs, a list) is written,
//    saved with the Save button ("Saved"), and reads back whole;
//  - a photo attaches as a small thumbnail (Journal, Notes);
//  - autosave plus Save made ONE record, not two.
// Every record it writes is deleted at the end.
//
//   npx tsx tests/live-editors-mobile-check.ts
//   (an undeployed client against the deployed API:
//    SMOKE_UI_BASE=http://localhost:5199 LIVE_API_ORIGIN=https://portol.me)
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const { chromium } = createRequire(import.meta.url)("playwright");
const API_ORIGIN = process.env.LIVE_API_ORIGIN || "";
const SHOTS = process.env.SHOTS_DIR || "";
const t = (id: string) => `[data-testid="${id}"]`;
let failed = 0;
const check = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; };

// A 1×1 PNG: the smallest real photo.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function forwardApi(page: any) {
  if (!API_ORIGIN) return;
  await page.route(/\/api\//, async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = { ...request.headers() };
    delete headers.host; delete headers.origin; delete headers.referer; delete headers["content-length"];
    try {
      const res = await fetch(`${API_ORIGIN}${url.pathname}${url.search}`, { method: request.method(), headers, body: request.postDataBuffer() ?? undefined });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) out[k] = v; });
      await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
    } catch { await route.abort(); }
  });
}

/** Nothing on the page is wider than the window, and the header's ends are on screen. */
async function layoutOk(page: any, surface: string) {
  return page.evaluate(({ surface }: { surface: string }) => {
    const w = window.innerWidth;
    const root = document.querySelector(`[data-testid="${surface}"]`) as HTMLElement | null;
    if (!root) return { ok: false, why: "no workspace" };
    const scrollers = [document.documentElement, document.body, root, ...Array.from(root.querySelectorAll("[data-workspace-scroll]"))] as HTMLElement[];
    const wide = scrollers.find((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "hidden" && el !== root);
    const overflowing = Array.from(root.querySelectorAll("*")).find((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      // Rows that scroll sideways on purpose (toolbars, chips) may run past the edge INSIDE their row.
      if ((el as HTMLElement).closest("[data-swipe-ignore]")) return false;
      return r.right > w + 1 || r.left < -1;
    }) as HTMLElement | undefined;
    const visible = (sel: string) => {
      const el = Array.from(root.querySelectorAll(sel)).find((e) => (e as HTMLElement).offsetParent !== null) as HTMLElement | undefined;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const x = visible('[data-testid="button-workspace-close"]');
    const save = visible('[data-testid="button-workspace-save"]');
    return {
      ok: !wide && !overflowing && !!x && !!save && x.left < save.left && save.right <= w && x.top >= 0 && save.top >= 0 && save.bottom < 120,
      why: wide ? `scrolls sideways: ${wide.tagName}.${wide.className}`.slice(0, 160)
        : overflowing ? `past the edge: <${overflowing.tagName.toLowerCase()} ${overflowing.getAttribute("data-testid") || overflowing.className}>`.slice(0, 160)
        : !x || !save ? "X or Save missing" : `X ${JSON.stringify(x)} Save ${JSON.stringify(save)}`,
    };
  }, { surface });
}

async function scrollEnds(page: any) {
  return page.evaluate(async () => {
    const sc = Array.from(document.querySelectorAll("[data-workspace-scroll]")).find((e) => (e as HTMLElement).offsetParent !== null) as HTMLElement | undefined;
    if (!sc) return { ok: false, tall: false };
    const tall = sc.scrollHeight > sc.clientHeight * 2;
    sc.scrollTop = sc.scrollHeight; await new Promise((r) => setTimeout(r, 150));
    const atEnd = Math.abs(sc.scrollTop + sc.clientHeight - sc.scrollHeight) < 4;
    sc.scrollTop = 0; await new Promise((r) => setTimeout(r, 150));
    return { ok: atEnd && sc.scrollTop === 0, tall, h: sc.scrollHeight, c: sc.clientHeight };
  });
}

const LONG = Array.from({ length: 40 }, (_, p) =>
  `Paragraph ${p + 1}. ` + Array.from({ length: 75 }, (_, i) => `word${p}_${i}`).join(" ")).join("\n\n");

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-editors-mobile-check" });
  const made = { journal: [] as string[], notes: [] as string[], artifacts: [] as string[], documents: [] as string[] };
  const browser = await chromium.launch();
  try {
    for (const [w, h] of [[320, 568], [375, 667], [390, 844]] as const) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: SHOTS ? 2 : 1, hasTouch: true, isMobile: true, timezoneId: "America/Los_Angeles" });
      const page = await ctx.newPage();
      // tsx names inner functions with a helper the page does not have.
      await page.addInitScript("window.__name = (f) => f;");
      const errors: string[] = [];
      page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
      await forwardApi(page);
      await page.goto(UI_BASE);
      const email = page.locator(t("input-signin-email"));
      if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
        await page.getByRole("button", { name: /sign in|log in|get started/i }).first().tap({ timeout: 15000 }).catch(() => undefined);
        await page.locator(t("tab-signin")).tap({ timeout: 5000 }).catch(() => undefined);
      }
      await email.waitFor({ timeout: 30000 });
      await email.fill(LIVE_EMAIL);
      await page.fill(t("input-signin-password"), LIVE_PASSWORD);
      await page.tap(t("button-signin"));
      await page.waitForSelector(t("page-dashboard"), { timeout: 30000 });
      const tag = `${w}-${Math.random().toString(36).slice(2, 6)}`;
      const shot = async (name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${w}-${name}.png` }); };

      // ── Journal ──
      await page.goto(`${UI_BASE}/#/workspace/journal`);
      await page.waitForSelector(t("workspace-journal"), { timeout: 30000 });
      let l = await layoutOk(page, "workspace-journal");
      check(l.ok, `${w}px Journal: fits the screen, X left and Save right (${l.why})`);
      check(await page.locator(t("button-workspace-save")).isDisabled(), `${w}px Journal: Save is shown, disabled while empty`);
      await shot("journal-empty");
      const jText = `Mobile check ${tag}\n\n${LONG}\n\n- one\n- two`;
      await page.locator(t("input-journal-free-text")).fill(jText);
      await page.tap(t("button-workspace-save"));
      await page.waitForSelector(`${t("button-workspace-save")}[data-state="saved"]`, { timeout: 30000 });
      check(true, `${w}px Journal: Save says Saved`);
      const s = await scrollEnds(page);
      check(s.ok && s.tall, `${w}px Journal: a long entry scrolls to its end and back (${s.h}/${s.c})`);
      l = await layoutOk(page, "workspace-journal");
      check(l.ok, `${w}px Journal: after a long entry, still fits with X and Save on screen (${l.why})`);
      await page.locator(t("input-journal-attach-library")).setInputFiles({ name: "check.png", mimeType: "image/png", buffer: PNG });
      await page.waitForSelector('[data-testid^="journal-photo-"]', { timeout: 30000 });
      check(true, `${w}px Journal: a photo attaches as a thumbnail`);
      await page.waitForTimeout(2500); // the autosave after the photo
      await page.waitForSelector(`${t("button-workspace-save")}[data-state="saved"]`, { timeout: 30000 });
      await shot("journal-long");
      const jRows = (await api("GET", "/journal")).data.filter((e: any) => String(e.content || "").startsWith(`Mobile check ${tag}`));
      made.journal.push(...jRows.map((e: any) => e.id));
      made.documents.push(...jRows.flatMap((e: any) => (e.tags || []).filter((x: string) => x.startsWith("photo:")).map((x: string) => x.slice(6))));
      check(jRows.length === 1, `${w}px Journal: autosave and Save made one entry (${jRows.length})`);
      check(jRows[0]?.content === jText, `${w}px Journal: the whole entry was saved (${String(jRows[0]?.content || "").length}/${jText.length} chars)`);
      check((jRows[0]?.tags || []).some((x: string) => x.startsWith("photo:")), `${w}px Journal: the photo is on the entry`);
      // Reopen it from the timeline: the text and the photo come back.
      await page.goto(`${UI_BASE}/#/chat`);
      await page.goto(`${UI_BASE}/#/workspace/journal`);
      await page.tap(t("button-journal-rail"));
      await page.tap(t(`journal-row-${jRows[0]?.id}`));
      const storedLen = String(jRows[0]?.content || "").length;
      await page.waitForFunction((len: number) => (document.querySelector('[data-testid="input-journal-free-text"]') as HTMLTextAreaElement)?.value.length === len, storedLen, { timeout: 15000 });
      check(await page.locator('[data-testid^="journal-photo-"]').count() === 1, `${w}px Journal: reopened, the entry and its photo are back`);

      // ── Notes ──
      await page.goto(`${UI_BASE}/#/workspace/notes`);
      await page.waitForSelector(t("workspace-notes"), { timeout: 30000 });
      l = await layoutOk(page, "workspace-notes");
      check(l.ok, `${w}px Notes: fits the screen, X left and Save right (${l.why})`);
      await shot("notes-empty");
      await page.tap(t("note-rich-editor"));
      await page.keyboard.type(`Note check ${tag}`);
      await page.keyboard.press("Enter");
      await page.evaluate((text: string) => {
        const el = document.querySelector('[data-testid="note-rich-editor"]') as HTMLElement;
        const dt = new DataTransfer(); dt.setData("text/plain", text);
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, LONG);
      await page.tap(t("button-workspace-save"));
      await page.waitForSelector(`${t("button-workspace-save")}[data-state="saved"]`, { timeout: 30000 });
      const ns = await scrollEnds(page);
      check(ns.ok && ns.tall, `${w}px Notes: a long note scrolls to its end and back (${ns.h}/${ns.c})`);
      await page.locator(t("input-note-attach-library")).setInputFiles({ name: "check.png", mimeType: "image/png", buffer: PNG });
      await page.waitForSelector('[data-testid^="note-attachment-"]', { timeout: 30000 });
      check(true, `${w}px Notes: a photo attaches as a thumbnail`);
      l = await layoutOk(page, "workspace-notes");
      check(l.ok, `${w}px Notes: after a long note, still fits with X and Save on screen (${l.why})`);
      await page.waitForTimeout(2000);
      await page.tap(t("button-workspace-save"));
      await page.waitForSelector(`${t("button-workspace-save")}[data-state="saved"]`, { timeout: 30000 });
      await shot("notes-long");
      const nRows = (await api("GET", "/notes")).data.filter((n: any) => String(n.content || "").startsWith(`Note check ${tag}`));
      made.notes.push(...nRows.map((n: any) => n.id));
      for (const n of nRows) for (const m of String(n.content).matchAll(/#\/documents\/([\w-]+)/g)) made.documents.push(m[1]);
      check(nRows.length === 1, `${w}px Notes: autosave and Save made one note (${nRows.length})`);
      check(String(nRows[0]?.content || "").includes("word39_74"), `${w}px Notes: the whole note was saved (${String(nRows[0]?.content || "").length} chars)`);

      // ── Document ──
      await page.goto(`${UI_BASE}/#/editor/new/doc?source=chat`);
      await page.waitForSelector(t("workspace-document"), { timeout: 30000 });
      l = await layoutOk(page, "workspace-document");
      check(l.ok, `${w}px Document: fits the screen, X left and Save right (${l.why})`);
      await shot("doc-empty");
      await page.locator(`${t("input-editor-title")}:visible`).fill(`Doc check ${tag}`);
      await page.tap(".ProseMirror");
      await page.evaluate((text: string) => {
        const el = document.querySelector(".ProseMirror") as HTMLElement;
        const dt = new DataTransfer(); dt.setData("text/plain", text);
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, LONG);
      await page.tap(t("button-workspace-save"));
      await page.waitForSelector(`${t("button-workspace-save")}[data-state="saved"]`, { timeout: 30000 });
      const ds = await scrollEnds(page);
      check(ds.ok && ds.tall, `${w}px Document: a long document scrolls to its end and back (${ds.h}/${ds.c})`);
      l = await layoutOk(page, "workspace-document");
      check(l.ok, `${w}px Document: after a long document, still fits with X and Save on screen (${l.why})`);
      check(await page.locator(t("toolbar-doc-mobile")).isVisible(), `${w}px Document: the formatting bar is on screen`);
      await shot("doc-long");
      await page.waitForTimeout(6000); // let any autosave land
      const aRows = (await api("GET", "/artifacts")).data.filter((a: any) => a.title === `Doc check ${tag}`);
      made.artifacts.push(...aRows.map((a: any) => a.id));
      check(aRows.length === 1, `${w}px Document: autosave and Save made one document (${aRows.length})`);
      check(String(aRows[0]?.content || "").includes("word39_74"), `${w}px Document: the whole document was saved`);

      check(errors.length === 0, `${w}px: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
    for (const id of made.journal) await api("DELETE", `/journal/${id}`);
    for (const id of made.notes) await api("DELETE", `/notes/${id}`);
    for (const id of made.artifacts) await api("DELETE", `/artifacts/${id}`);
    for (const id of new Set(made.documents)) await api("DELETE", `/documents/${id}`);
    await release();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
