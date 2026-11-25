// Live walk-through (deployed app, smoke account, real browser, phone touch
// and desktop) of Notes, Journal and Word as full applications behind the
// chat box's three small buttons (CLAUDE.md "Workspace app rules", owner
// request 2026-11-25).
//   npx tsx tests/live-workspace-apps-check.ts
//   (an undeployed client against the deployed API:
//    SMOKE_UI_BASE=http://localhost:5199 LIVE_API_ORIGIN=https://portol.me)
// Takes the gate lock; deletes what it creates and puts the AI-access setting
// back. SHOTS_DIR=<dir> keeps screenshots.
//
// It needs the server routes of the same change (version history, the
// category write, the workspace AI tabs). Against a server that does not have
// them yet it says so and stops, rather than reporting a red run.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";
import { WORKSPACE_AI_ACCESS_PREF } from "../shared/workspace-access";
import { journalEmotions, journalStress } from "../shared/journal-feelings";
import { noteCategory } from "../shared/note-markdown";

const { chromium } = createRequire(import.meta.url)("playwright");
const API_ORIGIN = process.env.LIVE_API_ORIGIN || "";
const SHOTS = process.env.SHOTS_DIR || "";
const t = (id: string) => `[data-testid="${id}"]`;
let failed = 0;
const check = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; };
const get = async (path: string): Promise<any> => { const r = await api("GET", path); if (!r.ok) throw new Error(`GET ${path}: ${r.status}`); return r.data; };
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 20000): Promise<T | null> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await new Promise((r) => setTimeout(r, 600)); }
  return null;
};

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

/** Nothing sticks out past the window (rows that scroll sideways on purpose aside). */
const overflow = (page: any, surface: string) => page.evaluate((surface: string) => {
  const w = window.innerWidth;
  const root = document.querySelector(`[data-testid="${surface}"]`) as HTMLElement | null;
  if (!root) return "no workspace on screen";
  const bad = Array.from(root.querySelectorAll("*")).find((el) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || (el as HTMLElement).closest("[data-swipe-ignore]")) return false;
    return r.right > w + 1 || r.left < -1;
  }) as HTMLElement | undefined;
  return bad ? `<${bad.tagName.toLowerCase()} ${bad.getAttribute("data-testid") || String(bad.className).slice(0, 60)}>` : "";
}, surface);

async function walk(name: string, viewport: { width: number; height: number }, touch: boolean, tag: string, hasAi: boolean) {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, timezoneId: "America/Los_Angeles" });
    const page = await ctx.newPage();
    // tsx names inner functions with a helper the page does not have.
    await page.addInitScript("window.__name = (f) => f;");
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
    await forwardApi(page);
    const tap = (sel: string) => (touch ? page.locator(sel).first().tap() : page.locator(sel).first().click());
    const shot = async (n: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${n}.png` }).catch(() => undefined); };
    const pick = async (id: string) => { await tap(t(`workspace-tab-${id}`)); await page.waitForTimeout(250); };
    const fits = async (surface: string, label: string) => { const o = await overflow(page, surface); check(o === "", `[${name}] ${label}: nothing past the edge${o ? ` — ${o}` : ""}`); };
    const saved = () => page.waitForFunction(() => document.querySelector('[data-testid="workspace-save-status"]')?.textContent === "Saved", null, { timeout: 15000 }).then(() => true).catch(() => false);
    const noteByText = async (text: string) => ((await get("/notes")) as any[]).find((n) => String(n.content).includes(text)) || null;

    await page.goto(UI_BASE);
    const email = page.locator(t("input-signin-email"));
    if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
      await page.getByRole("button", { name: /sign in|log in|get started/i }).first().click({ timeout: 15000 }).catch(() => undefined);
      await page.locator(t("tab-signin")).click({ timeout: 5000 }).catch(() => undefined);
    }
    await email.waitFor({ timeout: 30000 });
    await email.fill(LIVE_EMAIL);
    await page.fill(t("input-signin-password"), LIVE_PASSWORD);
    await page.locator(t("button-signin")).click();
    await page.waitForSelector(t("page-dashboard"), { timeout: 40000 });
    // Start from a clean memory of what was last open on this device.
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("portol_ws_")) localStorage.removeItem(k); });

    // ── Chat: three small buttons ───────────────────────────────────────────
    await page.goto(`${UI_BASE}/#/chat`);
    await page.waitForSelector(t("button-workspace-notes"), { timeout: 20000 });
    const labels = await Promise.all(["notes", "journal", "document"].map((k) => page.locator(t(`button-workspace-${k}`)).innerText()));
    check(labels.map((l) => l.trim()).join(",") === "Notes,Journal,Word", `[${name}] the chat box has small Notes, Journal and Word buttons`);
    // On the chat home (before the first message) they are the owner's tiles; once a
    // conversation is going they are the compact pills. Either way they are three
    // controls in the chat box, not navigation tabs.
    check((await page.locator('nav [data-testid^="button-workspace-"], [data-app-floating] [data-testid^="button-workspace-"]').count()) === 0, `[${name}] …and they are in the chat box, not in the app's navigation`);

    // ── Notes ───────────────────────────────────────────────────────────────
    await tap(t("button-workspace-notes"));
    await page.waitForSelector(t("workspace-notes"), { timeout: 20000 });
    check((await page.locator(`${t("workspace-tabs")} [role=tab]`).count()) === 6, `[${name}] Notes has its six tabs`);
    const hdr = await page.evaluate(() => { const r = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect(); return { x: r("button-workspace-close"), s: r("button-workspace-save"), w: window.innerWidth }; });
    check(hdr.w - hdr.x.right < 16 && hdr.x.left > hdr.s.left && hdr.x.top < 60, `[${name}] the X is in the upper right, with Save beside it`);
    const noteText = `Apps check ${tag} ${name}: first version of this note.`;
    await page.locator(t("note-rich-editor")).click();
    await page.keyboard.type(noteText);
    check(await saved(), `[${name}] Notes: typing saves itself`);
    const note = await until(() => noteByText(`${tag} ${name}`));
    check(!!note, `[${name}] …and the note is on the server`);
    if (!note) throw new Error("the note was not saved; the rest of the Notes walk needs it");
    await fits("workspace-notes", "Notes editor"); await shot("1-notes-editor");

    await pick("all");
    await page.waitForSelector(t(`all-note-${note.id}`), { timeout: 15000 });
    await page.locator(t("input-all-notes-search")).fill(`${tag} ${name}`);
    check(/^1 note of \d+$/.test(await page.locator(t("all-notes-count")).innerText()) || (await page.locator(t("all-notes-count")).innerText()) === "1 note", `[${name}] All Notes: search finds the note and says how many it shows`);
    await tap(t(`button-note-favorite-${note.id}`));
    check(!!(await until(async () => (await noteByText(`${tag} ${name}`))?.pinned === true)), `[${name}] starring a note saves it as a favorite`);
    await fits("workspace-notes", "All Notes"); await shot("2-notes-all");
    await pick("favorites");
    check(await page.locator(t(`all-note-${note.id}`)).waitFor({ timeout: 10000 }).then(() => true).catch(() => false), `[${name}] Favorites lists it`);

    await pick("categories");
    await page.waitForSelector(t(`input-category-${note.id}`), { timeout: 15000 });
    await page.locator(t(`input-category-${note.id}`)).fill(`Check ${tag}`);
    await page.locator(t(`input-category-${note.id}`)).press("Enter");
    check(!!(await until(async () => noteCategory((await noteByText(`${tag} ${name}`))?.tags) === `Check ${tag}`)), `[${name}] Categories: filing a note writes its category`);
    await fits("workspace-notes", "Categories"); await shot("3-notes-categories");

    await pick("insights");
    check(await page.locator(t("notes-insights")).innerText().then((x: string) => /Open check-list items · \d+/.test(x)), `[${name}] AI Insights counts open check-list items from the notes`);
    await pick("assistant");
    check((await page.locator(t("ai-access-line-notes")).innerText()).includes("AI access"), `[${name}] the assistant says what it may read`);
    if (hasAi) {
      await page.locator(t("notes-assistant-input")).fill(`Which of my notes mentions "${tag}"? Answer in one sentence.`);
      await tap(t("notes-assistant-send"));
      const answered = await page.locator(`${t("notes-assistant-assistant")}, ${t("notes-assistant-error")}`).first().waitFor({ timeout: 120000 }).then(() => true).catch(() => false);
      const said = answered && (await page.locator(t("notes-assistant-assistant")).count()) >= 1;
      check(said, `[${name}] the AI Assistant answers a question about the notes`);
      if (said) {
        const reply = await page.locator(t("notes-assistant-assistant")).last().innerText();
        console.log(`      assistant said: ${reply.replace(/\s+/g, " ").slice(0, 260)}`);
        check(/Read \d+ of \d+ notes/.test(reply), `[${name}] …and says how many notes it read`);
        check(reply.includes(tag) || /apps check/i.test(reply), `[${name}] …and the answer is about the note that mentions the tag`);
      }
      await fits("workspace-notes", "AI Assistant"); await shot("4-notes-assistant");
    } else console.log(`SKIP  [${name}] AI Assistant (no model on this server)`);

    // A version: replace the text, find the first text in History, restore it (two taps).
    await pick("editor");
    await page.waitForFunction((want: string) => (document.querySelector('[data-testid="note-rich-editor"]')?.textContent || "").includes(want), `${tag} ${name}`, { timeout: 15000 });
    await page.locator(t("note-rich-editor")).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type(`Apps check ${tag} ${name}: REWRITTEN.`);
    check(!!(await until(async () => String((await noteByText(`${tag} ${name}`))?.content).includes("REWRITTEN"))), `[${name}] the rewrite is saved`);
    await tap(t("button-note-history"));
    const firstVersion = page.locator(`${t("versions-note")} li`).first();
    check(await firstVersion.waitFor({ timeout: 15000 }).then(() => true).catch(() => false), `[${name}] History lists the text the rewrite replaced`);
    await firstVersion.locator("button").first().click();
    check((await page.locator(t("version-preview")).innerText().catch(() => "")).includes("first version of this note"), `[${name}] …and previews it`);
    const restore = page.locator('[data-testid^="button-version-restore-"]').first();
    await restore.click();
    check(String((await noteByText(`${tag} ${name}`))?.content).includes("REWRITTEN"), `[${name}] one tap on Restore changes nothing`);
    await restore.click();
    check(!!(await until(async () => String((await noteByText(`${tag} ${name}`))?.content).includes("first version of this note"))), `[${name}] the second tap restores the earlier text`);
    await fits("workspace-notes", "note history");
    // Reopening Notes brings the same note back.
    await tap(t("button-workspace-close"));
    await page.waitForSelector(t("button-workspace-notes"), { timeout: 20000 });
    check((await page.evaluate(() => window.location.hash)) === "#/chat", `[${name}] the Notes X returns to AI Chat`);
    await tap(t("button-workspace-notes"));
    check(await page.waitForFunction((want: string) => (document.querySelector('[data-testid="note-rich-editor"]')?.textContent || "").includes(want), `${tag} ${name}`, { timeout: 20000 }).then(() => true).catch(() => false), `[${name}] Notes reopens on the note last open`);
    await tap(t("button-workspace-close"));
    await page.waitForSelector(t("button-workspace-journal"), { timeout: 20000 });

    // ── Journal ─────────────────────────────────────────────────────────────
    await tap(t("button-workspace-journal"));
    await page.waitForSelector(t("workspace-journal"), { timeout: 20000 });
    check((await page.locator(`${t("workspace-tabs")} [role=tab]`).count()) === 7, `[${name}] Journal has its seven tabs`);
    const entryText = `Apps check ${tag} ${name}: a calm walk and a good night's sleep.`;
    await page.locator(t("input-journal-free-text")).fill(entryText);
    await tap(t("button-journal-feelings"));
    await tap(t("button-energy-4")); await tap(t("button-stress-2")); await tap(t("button-emotion-calm"));
    await fits("workspace-journal", "New Entry with feelings open"); await shot("5-journal-new");
    const entry = await until(async () => {
      const e = ((await get("/journal")) as any[]).find((j) => String(j.content).includes(`${tag} ${name}`));
      return e && e.energy === 4 && journalStress(e.tags) === 2 && journalEmotions(e.tags).includes("calm") ? e : null;
    }, 25000);
    check(!!entry, `[${name}] the entry is saved with its energy, stress and emotion`);
    await pick("past");
    check(await page.locator(t(`past-entry-${entry?.id}`)).waitFor({ timeout: 15000 }).then(() => true).catch(() => false), `[${name}] Past Entries lists it`);
    await tap(t("button-past-calendar"));
    const today = await page.evaluate(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }));
    check(/entr(y|ies)/.test((await page.locator(t(`calendar-day-${today}`)).getAttribute("aria-label")) || ""), `[${name}] the calendar marks today as written on`);
    await fits("workspace-journal", "Past Entries calendar"); await shot("6-journal-calendar");
    await pick("trends");
    check(await page.locator(t("trend-mood-chart")).waitFor({ timeout: 15000 }).then(() => true).catch(() => false), `[${name}] Trends draws mood from the entries`);
    check(/entr(y|ies) in this range/.test(await page.locator(t("trends-range-note")).innerText()), `[${name}] …and says how many entries the range holds`);
    await fits("workspace-journal", "Trends"); await shot("7-journal-trends");
    await pick("coach");
    check(/not a therapist/i.test(await page.locator(t("journal-coach-boundary")).innerText()), `[${name}] the Reflection Coach says it is not a therapist`);
    if (hasAi) {
      await page.locator(t("journal-coach-input")).fill("In one sentence: what did I write about today?");
      await tap(t("journal-coach-send"));
      const answered = await page.locator(`${t("journal-coach-assistant")}, ${t("journal-coach-error")}`).first().waitFor({ timeout: 120000 }).then(() => true).catch(() => false);
      const got = answered && (await page.locator(t("journal-coach-assistant")).count()) >= 1;
      check(got, `[${name}] the coach answers from the journal`);
      if (got) {
        const reply = await page.locator(t("journal-coach-assistant")).last().innerText();
        console.log(`      coach said: ${reply.replace(/\s+/g, " ").slice(0, 260)}`);
        check(!/REMEMBER:/.test(reply), `[${name}] …and none of the remembering machinery shows in the reply`);
        // Tell it something worth keeping, then leave and come back: the conversation and the memory are still there.
        await page.locator(t("journal-coach-input")).fill(`Please remember this: my sister ${tag} lives in Porto and I miss her.`);
        await tap(t("journal-coach-send"));
        await page.waitForFunction((n: number) => document.querySelectorAll('[data-testid="journal-coach-assistant"]').length > n, await page.locator(t("journal-coach-assistant")).count(), { timeout: 120000 }).catch(() => undefined);
        const kept = await until(async () => { const m = await get("/workspace/memory/journal"); return (m.memories as any[]).some((x) => String(x.text).includes(tag)) ? m : null; }, 60000);
        check(!!kept, `[${name}] the coach keeps what it was told (${kept ? (kept.memories as any[]).filter((x) => String(x.text).includes(tag)).map((x) => x.text).join(" | ") : "nothing kept"})`);
        check(!!kept && (kept.turns as any[]).length >= 4, `[${name}] …and the conversation is saved on the account`);
        await tap(t("button-workspace-close"));
        await page.waitForSelector(t("button-workspace-journal"), { timeout: 20000 });
        await tap(t("button-workspace-journal"));
        await page.waitForSelector(t("workspace-journal"), { timeout: 20000 });
        await pick("coach");
        check(await page.locator(t("journal-coach-user")).first().waitFor({ timeout: 20000 }).then(() => true).catch(() => false), `[${name}] reopening the Journal shows the earlier conversation`);
        await tap(t("button-memory-journal"));
        check((await page.locator(t("memory-panel-journal")).innerText()).includes(tag), `[${name}] "What I remember" lists it`);
        const repliesBefore = await page.locator(t("journal-coach-assistant")).count();
        await page.locator(t("journal-coach-input")).fill("What do you remember about my family? One sentence.");
        await tap(t("journal-coach-send"));
        // Wait for THIS reply (an earlier one also says Porto), so nothing is still on its way when Forget is tapped.
        await page.waitForFunction((n: number) => document.querySelectorAll('[data-testid="journal-coach-assistant"]').length > n, repliesBefore, { timeout: 120000 }).catch(() => undefined);
        const recalled = await until(async () => { if ((await page.locator(t("journal-coach-assistant")).count()) <= repliesBefore) return null; const txt = await page.locator(t("journal-coach-assistant")).last().innerText(); return /Porto/i.test(txt) ? txt : null; }, 30000);
        check(!!recalled, `[${name}] asked later, it recalls what it was told`);
        if (recalled) console.log(`      coach recalled: ${recalled.replace(/\s+/g, " ").slice(0, 260)}`);
        await fits("workspace-journal", "Reflection Coach with memory"); await shot("8-journal-coach");
        // Forget everything (two taps) leaves nothing behind.
        await tap(t("button-forget-all-journal")); await tap(t("button-forget-all-journal"));
        check(!!(await until(async () => { const m = await get("/workspace/memory/journal"); return m.memories.length === 0 && m.turns.length === 0; })), `[${name}] Forget everything clears the memories and the conversation`);
      }
    } else console.log(`SKIP  [${name}] Reflection Coach (no model on this server)`);
    const stillSame = ((await get("/journal")) as any[]).find((j) => j.id === entry?.id);
    check(!!stillSame && stillSame.content === entry?.content, `[${name}] …and the entry is unchanged`);
    await pick("guided");
    await page.getByText("What am I grateful for?").first().click();
    check(await page.waitForFunction(() => (document.querySelector('[data-testid="input-journal-free-text"]') as HTMLTextAreaElement | null)?.value === "What am I grateful for?\n", null, { timeout: 10000 }).then(() => true).catch(() => false), `[${name}] a guided prompt is put on a new page`);
    await page.waitForTimeout(3000);
    check(!((await get("/journal")) as any[]).some((j) => String(j.content).trim() === "What am I grateful for?"), `[${name}] …and nothing is saved until something is written`);
    await page.locator(t("input-journal-free-text")).fill("");
    await tap(t("button-workspace-close"));
    await page.waitForSelector(t("button-workspace-document"), { timeout: 20000 });

    // ── Word ────────────────────────────────────────────────────────────────
    await tap(t("button-workspace-document"));
    await page.waitForSelector(t("word-documents"), { timeout: 20000 });
    check((await page.locator(`${t("workspace-tabs")} [role=tab]`).count()) === 6, `[${name}] Word has its six tabs`);
    await fits("workspace-document", "My Documents");
    await pick("templates");
    await page.waitForSelector(t("template-letter-cover"));
    await fits("workspace-document", "Templates"); await shot("9-word-templates");
    const docsBefore = ((await get("/artifacts")) as any[]).filter((a) => a.type === "doc").length;
    await tap(t("button-template-use-letter-cover"));
    await page.locator(`${t("workspace-document")} .ProseMirror`).first().waitFor({ timeout: 30000 });
    check((await page.locator(`${t("workspace-document")} .ProseMirror`).first().innerText()).includes("[Missing: job title]"), `[${name}] a template opens in the editor with its blanks`);
    check((await page.locator(t("workspace-tab-editor")).getAttribute("aria-selected")) === "true", `[${name}] the editor shows Word's tabs`);
    const title = `Apps check ${tag} ${name}`;
    await page.locator(`${t("input-editor-title")}:visible`).first().fill(title);
    const doc = await until(async () => ((await get("/artifacts")) as any[]).find((a) => a.type === "doc" && a.title === title && String(a.content).includes("[Missing: job title]")), 30000);
    check(!!doc, `[${name}] the editor saves it as a document on its own`);
    check(((await get("/artifacts")) as any[]).filter((a) => a.type === "doc").length === docsBefore + 1, `[${name}] …as ONE document`);
    await fits("workspace-document", "document editor"); await shot("10-word-editor");
    await pick("history");
    await page.waitForSelector(t("word-history"), { timeout: 20000 });
    check((await page.evaluate(() => window.location.hash)).includes(`doc=${doc?.id}`), `[${name}] a Word tab picked in the editor opens the workspace on that document`);
    check((await page.locator(t("select-word-document")).inputValue()) === doc?.id, `[${name}] Version History has that document chosen`);
    await pick("review");
    if (hasAi && doc) {
      await tap(t("button-word-run-review"));
      const reviewed = await page.locator(t("word-review-result")).waitFor({ timeout: 120000 }).then(() => true).catch(() => false);
      check(reviewed, `[${name}] AI Review reports on the saved document`);
      if (reviewed) check(/Missing information · \d+/.test(await page.locator(t("word-review-result")).innerText()), `[${name}] …and lists its blanks as missing information`);
      await fits("workspace-document", "AI Review"); await shot("11-word-review");
      const after = ((await get("/artifacts")) as any[]).find((a) => a.id === doc.id);
      check(after?.content === doc.content, `[${name}] …and changes nothing`);
    } else console.log(`SKIP  [${name}] AI Review (no model on this server)`);
    await pick("documents");
    await page.locator(t("input-word-search")).fill(title);
    check(await page.locator(t(`word-doc-${doc?.id}`)).waitFor({ timeout: 15000 }).then(() => true).catch(() => false), `[${name}] My Documents finds it by search`);
    await tap(t("button-workspace-close"));
    await page.waitForSelector(t("button-workspace-document"), { timeout: 20000 });
    check((await page.evaluate(() => window.location.hash)) === "#/chat", `[${name}] the Word X returns to AI Chat`);
    check(errors.length === 0, `[${name}] no page errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
  } finally {
    await browser.close();
  }
}

async function main() {
  const version = await (await fetch(`${API_ORIGIN || UI_BASE}/api/version`)).json().catch(() => ({}));
  console.log(`client ${UI_BASE} · API ${API_ORIGIN || UI_BASE} serving ${String(version.sha || "unknown").slice(0, 7)}`);
  // Does this server have the routes of this change? (An unknown kind is a 400 there; a 404 before the deploy.)
  const probe = await api("GET", "/workspace/versions/unknown-kind/x");
  if (probe.status !== 400) {
    console.log(`NOT RUN  the server does not have the workspace-app routes yet (GET /api/workspace/versions answered ${probe.status}). Deploy first.`);
    process.exit(2);
  }
  const chat = await api("POST", "/workspace/notes/chat", { messages: [] });
  const hasAi = chat.status === 400; // 503 = no model configured
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-workspace-apps-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const accessBefore = (await get(`/preferences/${WORKSPACE_AI_ACCESS_PREF}`))?.value ?? null;
  try {
    await walk("phone", { width: 390, height: 844 }, true, tag, hasAi);
    await walk("desktop", { width: 1280, height: 900 }, false, tag, hasAi);
  } catch (err) {
    check(false, `the walk stopped: ${String((err as Error)?.message || err).split("\n")[0].slice(0, 300)}`);
  } finally {
    // Delete what this run made (found by its tag), and put the setting back.
    for (const a of ((await get("/artifacts").catch(() => [])) as any[])) {
      if (`${a.title} ${a.content}`.includes(tag)) await api("DELETE", a.type === "note" ? `/notes/${a.id}` : `/artifacts/${a.id}`).catch(() => undefined);
    }
    for (const j of ((await get("/journal").catch(() => [])) as any[])) {
      if (String(j.content).includes(tag)) await api("DELETE", `/journal/${j.id}`).catch(() => undefined);
    }
    // What the two assistants kept during the run (the smoke account has no memory of its own to keep).
    await api("DELETE", "/workspace/memory/journal").catch(() => undefined);
    await api("DELETE", "/workspace/memory/notes").catch(() => undefined);
    const accessAfter = (await get(`/preferences/${WORKSPACE_AI_ACCESS_PREF}`).catch(() => null))?.value ?? null;
    if (accessAfter !== accessBefore && accessBefore !== null) await api("PUT", `/preferences/${WORKSPACE_AI_ACCESS_PREF}`, { value: accessBefore }).catch(() => undefined);
    const left = [
      ...((await get("/artifacts").catch(() => [])) as any[]).filter((a) => `${a.title} ${a.content}`.includes(tag)),
      ...((await get("/journal").catch(() => [])) as any[]).filter((j) => String(j.content).includes(tag)),
    ];
    check(left.length === 0, `cleanup: nothing this run made is left (${left.length})`);
    await release();
  }
  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
  process.exit(failed ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(1); });
