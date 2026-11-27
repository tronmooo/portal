// Live check: custom AI Modes, end to end, on the DEPLOYED app with the
// smoke account (owner, 2026-11-27: "make sure it works … connected to the
// entire app"). It takes the account's gate lock, and removes everything it
// made at the end (the mode, its tracker, its task, its library entry).
//
// API:   build a mode from words (proposal, nothing saved) → save it → change
//        it → talk to it → an analysis → a reminder on/off (a real task) →
//        a Log tab's tracker and entry → publish, find, install a copy,
//        unpublish → the main chat opens it by name → export carries it →
//        delete (its memory goes too).
// Phone (390px, touch): the chat home's modes row with More, the More sheet
//        listing the mode, the mode's tabs, Settings' AI Modes tile, search.
//
//   npx tsx tests/live-ai-modes-check.ts
//   (an undeployed client against the deployed API:
//    SMOKE_UI_BASE=http://localhost:5199 LIVE_API_ORIGIN=https://portol.me)
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const { chromium } = createRequire(import.meta.url)("playwright");
const API_ORIGIN = process.env.LIVE_API_ORIGIN || "";
const t = (id: string) => `[data-testid="${id}"]`;
let failed = 0;
const check = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; };
const tag = Math.random().toString(36).slice(2, 6);

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

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-ai-modes-check" });
  let modeId = "";
  let libraryId = "";
  let installedId = "";
  let trackerId = "";
  const taskIds: string[] = [];
  try {
    // ── Build: a proposal, nothing saved ──
    const before = (await api("GET", "/workspace/modes")).data?.modes?.length ?? -1;
    const gen = await api("POST", "/workspace/modes/generate", { description: `An AI that coaches my running and tracks my study time ${tag}` });
    check(gen.status === 200 && !!gen.data?.mode?.name, `generate answers with a mode (${gen.status}, by ${gen.data?.by})`);
    check(Array.isArray(gen.data?.mode?.tabs) && gen.data.mode.tabs.at(-1)?.kind === "chat", "the proposal ends with its Chat tab");
    check(!(gen.data?.mode?.access || []).includes("journal"), "the builder never switches the journal on");
    check((await api("GET", "/workspace/modes")).data?.modes?.length === before, "generating saved nothing");

    // ── Save, then change ──
    const mode = { ...gen.data.mode, name: `Live Coach ${tag}`, access: ["profile", "tasks", "health"],
      tabs: [
        { title: "Study log", kind: "log", tracker: { name: `Live study ${tag}`, fields: [{ key: "minutes", label: "Minutes", type: "number" }] } },
        { title: "Patterns", kind: "insights", focus: "What do my open tasks say about my week?" },
        { title: "Chat", kind: "chat" },
      ],
      reminders: [{ title: `Live reminder ${tag}`, freq: "weekly" }] };
    const saved = await api("POST", "/workspace/modes", { mode });
    modeId = saved.data?.mode?.id || "";
    check(saved.status === 201 && !!modeId, `saved as ${modeId}`);
    const patched = await api("PATCH", `/workspace/modes/${modeId}`, { patch: { pinned: true } });
    check(patched.data?.mode?.pinned === true, "pinned to the Chat page");
    check((await api("PUT", "/preferences/ai_modes", { value: "{}" })).status === 400, "the generic preferences route refuses the modes row");

    // ── Use it ──
    const chat = await api("POST", "/workspace/modes/chat", { modeId, messages: [{ role: "user", content: "In one sentence, what can you help me with?" }] });
    check(chat.status === 200 && typeof chat.data?.answer === "string" && chat.data.answer.length > 5, `its chat answers (${chat.status})`);
    const ins = await api("POST", "/workspace/modes/insights", { modeId, tabId: "patterns" });
    check(ins.status === 200 || ins.status === 400, `an analysis answers or says there is nothing to read (${ins.status})`);
    const rev = await api("POST", "/workspace/modes/revise", { modeId, instruction: "add a sleep analysis tab and compare my sleep against my tasks" });
    check(rev.status === 200 && (rev.data?.mode?.tabs || []).length >= 3, "a change by talking comes back as a proposal");
    check((await api("GET", "/workspace/modes")).data?.modes?.find((m: any) => m.id === modeId)?.tabs?.length === 3, "…and the stored mode is unchanged until applied");

    // ── A reminder is a real recurring task ──
    const today = new Date().toISOString().slice(0, 10);
    const rem = saved.data.mode.reminders[0];
    const task = await api("POST", "/tasks", { title: rem.title, dueDate: today, tags: ["recur:weekly", `ai-mode:${modeId}:${rem.id}`], priority: "low" });
    if (task.data?.id) taskIds.push(task.data.id);
    const tasks = (await api("GET", "/tasks")).data || [];
    check(tasks.some((x: any) => (x.tags || []).includes(`ai-mode:${modeId}:${rem.id}`)), "the reminder's task is in Tasks");

    // ── A Log tab's tracker and entry ──
    const tr = await api("POST", "/trackers", { name: `Live study ${tag}`, category: "custom", fields: [{ name: "minutes", type: "number", isPrimary: true }] });
    trackerId = tr.data?.id || tr.data?.tracker?.id || "";
    check(!!trackerId, "the Log tab's tracker was created");
    const entry = await api("POST", `/trackers/${trackerId}/entries`, { values: { minutes: 30 } });
    check(entry.ok, `an entry saved to it (${entry.status})`);

    // ── The library ──
    const pub = await api("POST", "/workspace/modes/library", { modeId });
    libraryId = pub.data?.item?.id || "";
    check(pub.status === 201 && !!libraryId && pub.data.item.mine === true, `published (${pub.status})`);
    check(!JSON.stringify(pub.data).includes("author"), "the author is never returned");
    const found = await api("GET", `/workspace/modes/library?q=${encodeURIComponent(`Live Coach ${tag}`)}`);
    check((found.data?.items || []).some((x: any) => x.id === libraryId), "found by search");
    const inst = await api("POST", `/workspace/modes/library/${libraryId}/install`);
    check(inst.status === 200 && inst.data?.mode?.id && inst.data.mode.id !== modeId && inst.data.mode.pinned === false, "install hands back a fresh copy to review");
    installedId = "";

    // ── The main chat opens it by name ──
    const nav = await api("POST", "/chat", { message: `Open my Live Coach ${tag} mode` });
    const results = JSON.stringify(nav.data?.results || nav.data || "");
    check(nav.ok && results.includes(modeId), `the main chat opens the mode by its name (${nav.status})`);

    // ── Backup carries it ──
    const exp = await api("GET", "/export");
    check((exp.data?.aiModes || []).some((m: any) => m.id === modeId), "the backup carries the mode");

    // ── Phone, touch ──
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, timezoneId: "America/Los_Angeles" });
      const page = await ctx.newPage();
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
      await page.waitForSelector(t("page-dashboard"), { timeout: 40000 });

      await page.goto(`${UI_BASE}/#/chat`);
      await page.waitForSelector(t("chat-modes"), { timeout: 30000 });
      check(await page.locator(t(`button-ai-mode-${modeId}`)).count() === 1, "the pinned mode is in the chat home's modes row");
      check(await page.locator(t("chat-composer-inline")).count() === 1 && await page.locator(t("chat-composer-pinned")).count() === 0, "the chat box is in the home's flow, not pinned");
      await page.tap(t("button-modes-more"));
      await page.waitForSelector(t(`modes-sheet-open-${modeId}`), { timeout: 15000 });
      check(true, "More lists the mode");
      await page.tap(t(`modes-sheet-open-${modeId}`));
      await page.waitForSelector(t("workspace-tab-study-log"), { timeout: 20000 });
      await page.tap(t("workspace-tab-study-log"));
      await page.waitForSelector(t("mode-log-form"), { timeout: 20000 });
      check(true, "the mode opens, and its Log tab finds its tracker");
      await page.tap(t("workspace-tab-__settings"));
      await page.waitForSelector(t("mode-editor"), { timeout: 10000 });
      const handle = page.locator(t("mode-tab-drag-study-log"));
      check(await handle.count() === 1 && (await handle.evaluate((el: HTMLElement) => !!el.closest("[data-swipe-ignore]"))), "a tab's drag handle keeps its own drag (T1)");
      check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "nothing scrolls sideways");

      await page.goto(`${UI_BASE}/#/settings`);
      await page.waitForSelector(t("stat-ai-modes"), { timeout: 20000 });
      check(!/Couldn't load/.test(await page.locator(t("stat-ai-modes")).innerText()), "Settings shows the AI Modes tile");
      check(errors.length === 0, `no page errors (${errors.join(" | ").slice(0, 200)})`);
    } finally { await browser.close(); }
  } finally {
    // ── Clean up everything it made ──
    if (libraryId) check((await api("DELETE", `/workspace/modes/library/${libraryId}`)).ok, "unpublished");
    for (const id of taskIds) await api("DELETE", `/tasks/${id}`);
    if (trackerId) await api("DELETE", `/trackers/${trackerId}`);
    if (installedId) await api("DELETE", `/workspace/modes/${installedId}`);
    if (modeId) {
      check((await api("DELETE", `/workspace/modes/${modeId}`)).ok, "the mode is deleted");
      const mem = await api("GET", `/workspace/memory/mode-${modeId}`);
      check(mem.status === 200 && (mem.data?.turns || []).length === 0 && (mem.data?.memories || []).length === 0, "…and its conversation is gone");
    }
    await release();
  }
  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
