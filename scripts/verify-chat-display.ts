/**
 * Front-end half of the chat tool sweep.
 *
 * scripts/verify-all-chat-tools.ts records, per tool, the exact reply the
 * server produced. This script signs in to the deployed app in a real browser
 * and, for every recorded reply, sends the same message with the network
 * answer replaced by that recording (as the SSE frames the server sends), then
 * reads the page: is the reply on screen, and is the thing that tool is
 * supposed to show (action card, chart, table, report, document preview)
 * actually rendered? No AI call is made, so it is free and repeatable.
 *
 *   npx tsx scripts/verify-chat-display.ts --in=<dir with results.jsonl>
 *
 * To check a client that is not deployed yet, serve it locally (`npx vite`)
 * and pass --ui=http://localhost:5173: every /api call the page makes is then
 * forwarded to the deployed API, so the local page runs on real data.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { SMOKE_EMAIL, SMOKE_PASSWORD, UI_BASE } from "../tests/smoke/fixture/account";
import { TOOL_ACTION_MAP } from "../server/ai-engine";

// Playwright is a tool of the machine that runs this, not a project dependency.
const { chromium } = createRequire(import.meta.url)("playwright") as typeof import("playwright");

const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
const IN_DIR = arg("in") || path.join(os.tmpdir(), "chat-tool-sweep");
const UI = arg("ui") || UI_BASE;
const only = arg("only")?.split(",");
const FORWARD_API = UI !== UI_BASE;

type Rec = { tool: string; message: string; display: string; actionTypes: string[]; final: any; toolsStarted: string[] };

function sse(final: any, tools: string[]): string {
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = frame("ack", { ok: true });
  for (const t of tools) out += frame("tool_start", { tool: t, label: t });
  out += frame("final", final);
  return out;
}

(async () => {
  const recs: Rec[] = fs.readFileSync(path.join(IN_DIR, "results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((r: Rec) => r.tool !== "(fixture)" && r.final && r.final.reply)
    .filter((r: Rec) => !only || only.includes(r.tool));

  const browser = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message)));

  let current: Rec | null = null;
  await page.route(/\/api\/chat(\?|$)/, async (route) => {
    if (route.request().method() !== "POST" || !current) return route.continue();
    // A fresh turn id per replay, so cards stay attached to their own message.
    const final = { ...current.final, pendingEnrichment: undefined };
    // A recording made before the server stamped the tool on each action:
    // stamp it here, from the tools that ran, so the page is checked against
    // what the server sends now.
    if (Array.isArray(final.actions)) {
      const ran = [...current.toolsStarted];
      final.actions = final.actions.map((a: any) => {
        if (!a || a.data?._tool) return a;
        const i = ran.findIndex((t) => TOOL_ACTION_MAP[t] === a.type);
        if (i === -1) return a;
        const [tool] = ran.splice(i, 1);
        return { ...a, data: { ...a.data, _tool: tool } };
      });
    }
    await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" }, body: sse(final, current.toolsStarted) });
  });

  if (FORWARD_API) {
    await page.route(/\/api\//, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === "POST" && /^\/api\/chat$/.test(url.pathname) && current) return route.fallback();
      try {
        const headers = { ...req.headers() };
        delete headers["host"]; delete headers["origin"]; delete headers["referer"]; delete headers["content-length"];
        const res = await fetch(`${UI_BASE}${url.pathname}${url.search}`, {
          method: req.method(), headers, body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() ?? undefined,
        });
        const body = Buffer.from(await res.arrayBuffer());
        const out: Record<string, string> = {};
        res.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding"].includes(k)) out[k] = v; });
        await route.fulfill({ status: res.status, headers: out, body });
      } catch { await route.abort(); }
    });
  }

  await page.goto(`${UI}/#/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="input-signin-email"], [data-testid="input-chat"]', { timeout: 60000 });
  if (await page.$('[data-testid="input-signin-email"]')) {
    await page.fill('[data-testid="input-signin-email"]', SMOKE_EMAIL);
    await page.fill('[data-testid="input-signin-password"]', SMOKE_PASSWORD);
    await page.click('[data-testid="button-signin"]');
  }
  await page.waitForSelector('[data-testid="input-chat"]', { timeout: 60000 });
  if (!page.url().includes("#/chat")) { await page.goto(`${UI}/#/chat`); await page.waitForSelector('[data-testid="input-chat"]'); }

  const out: any[] = [];
  let pass = 0;
  for (const rec of recs) {
    current = rec;
    const errorsBefore = pageErrors.length;
    const row: any = { tool: rec.tool, display: rec.display };
    try {
      if (!page.url().includes("#/chat")) { await page.goto(`${UI}/#/chat`); }
      await page.waitForSelector('[data-testid="input-chat"]', { timeout: 30000 });
      const before = await page.locator('[data-testid^="message-assistant-"]').count();
      const t0 = Date.now();
      await page.fill('[data-testid="input-chat"]', rec.message);
      await page.click('[data-testid="button-send"]');
      if (rec.display === "navigate") {
        // The reply is followed by the app opening the page it named.
        const want = (Array.isArray(rec.final.results) ? rec.final.results : []).map((r: any) => r?.navigateTo).find(Boolean);
        const prefix = `#/${want === "profile_detail" ? "profiles" : want}`;
        const moved = await page.waitForFunction((p) => location.hash.startsWith(p), prefix, { timeout: 8000 }).then(() => true).catch(() => false);
        row.renderMs = Date.now() - t0;
        row.url = page.url().split("#")[1];
        row.replyShown = true;
        row.shown = moved;
        row.cards = []; row.cardText = [];
        throw { handled: true };
      }
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="message-assistant-"]').length > n, before, { timeout: 30000 });
      row.renderMs = Date.now() - t0;
      await page.waitForTimeout(350);
      const last = page.locator('[data-testid^="message-assistant-"]').last();
      const text = (await last.innerText()).trim();
      // The reply's own words are on screen: the first 20 letters/digits of
      // the reply, compared ignoring markdown, spacing and case.
      const alnum = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
      const probe = alnum(String(rec.final.reply)).slice(0, 20);
      row.replyShown = probe.length > 0 && alnum(text).includes(probe);
      // Charts load their drawing code on demand — give it time to arrive.
      if (rec.display === "chart" || rec.display === "report") {
        await last.locator("svg.recharts-surface").first().waitFor({ timeout: 20000 }).catch(() => {});
      }
      row.cards = await last.locator('[data-testid^="action-card-"]:not([data-testid^="action-card-link-"])').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      row.cardText = await last.locator('[data-testid^="action-card-"]:not([data-testid^="action-card-link-"])').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim().slice(0, 120)));
      row.charts = await last.locator("svg.recharts-surface, canvas").count();
      row.tables = await last.locator("table").count();
      row.report = await last.locator('[aria-label*="report:"]').count();
      row.docPreview = await last.locator('img, iframe, [data-testid*="document"], [data-testid*="doc-"]').count();
      row.shown =
        rec.display === "card" ? row.cards.length > 0
        : rec.display === "chart" ? row.charts > 0
        : rec.display === "table" ? row.tables > 0
        : rec.display === "report" ? row.report > 0
        : rec.display === "document" ? row.docPreview > 0
        : row.replyShown;
      row.url = page.url().split("#")[1];
    } catch (e: any) {
      if (!e?.handled) row.error = String(e?.message || e).slice(0, 200);
    }
    row.pageErrors = pageErrors.slice(errorsBefore);
    row.ok = !row.error && row.replyShown && row.shown && row.pageErrors.length === 0;
    if (row.ok) pass++;
    out.push(row);
    console.log(`${row.ok ? "PASS" : "FAIL"} ${rec.tool.padEnd(30)} ${String(row.renderMs ?? "-").padStart(5)}ms ${rec.display.padEnd(8)} cards=${(row.cards || []).length} charts=${row.charts ?? 0} tables=${row.tables ?? 0} ${row.ok ? "" : JSON.stringify({ replyShown: row.replyShown, shown: row.shown, error: row.error, pageErrors: row.pageErrors, url: row.url })}`);
  }
  fs.writeFileSync(path.join(IN_DIR, "display.json"), JSON.stringify(out, null, 1));
  await page.screenshot({ path: path.join(IN_DIR, "chat-last.png") });
  await browser.close();
  console.log(`\n${pass}/${recs.length} recorded replies rendered correctly in the chat page (${UI}).\n`);
})();
