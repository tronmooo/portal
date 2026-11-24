// Live check for the QA findings of 2026-11-24, on the DEPLOYED app, in a real
// browser, as the smoke account — at desktop width, and again at phone width
// with touch (T2).
//
//   npx tsx tests/live-qa-2026-11-24-check.ts
//   (an undeployed client against the deployed API:
//    SMOKE_UI_BASE=http://localhost:5199 LIVE_API_ORIGIN=https://portol.me)
//
// What it proves:
//   · An expense and a nested asset added ELSEWHERE (the chat, another device)
//     show on the asset's own Financials and Contained tabs after a manual
//     refresh — the saved snapshot is a first paint, not the truth (Rule 7).
//   · An expense entered from the asset's own form shows there at once, and
//     adding it, switching tabs and saving never reload the page.
//   · Chat's confirmation of a nested asset names the parent the record HAS.
//   · A saved document, reopened, says "Saved" and writes nothing (W3).
//   · Artifacts never shows "0 artifacts" while its lists are loading.
//   · Fill In: the filled PDF holds the four approved values; the app behind
//     the workspace is inert; "Show it in Artifacts" leaves the workspace.
//
// Writes only to the smoke account, holds the gate lock (acquireGateLock) and
// deletes what it created.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const req = createRequire(import.meta.url);
const { chromium } = req("playwright");
const { PDFDocument } = req("pdf-lib");
const API_ORIGIN = process.env.LIVE_API_ORIGIN || "";
const SHOTS = process.env.SHOTS_DIR || "";
const t = (id: string) => `[data-testid="${id}"]`;
let failed = 0;
const check = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; };

async function call(method: string, path: string, body?: any): Promise<any> {
  const r = await api(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}

/** Requests the page made, and (for an undeployed client) the road to the deployed API. */
async function wire(page: any, seen: Array<{ method: string; path: string }>, delay?: { match: RegExp; ms: number }) {
  await page.route(/\/api\//, async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    seen.push({ method: request.method(), path: url.pathname });
    if (delay && delay.match.test(url.pathname)) await new Promise((r) => setTimeout(r, delay.ms));
    if (!API_ORIGIN) return route.continue().catch(() => undefined);
    const headers = { ...request.headers() };
    delete headers.host; delete headers.origin; delete headers.referer; delete headers["content-length"];
    try {
      const res = await fetch(`${API_ORIGIN}${url.pathname}${url.search}`, { method: request.method(), headers, body: request.postDataBuffer() ?? undefined });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) out[k] = v; });
      await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
    } catch { await route.abort().catch(() => undefined); }
  });
}

async function signIn(page: any) {
  await page.goto(UI_BASE);
  const email = page.locator(t("input-signin-email"));
  if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
    await page.getByRole("button", { name: /sign in|log in|get started/i }).first().click({ timeout: 15000 }).catch(() => undefined);
    await page.locator(t("tab-signin")).click({ timeout: 5000 }).catch(() => undefined);
  }
  await email.waitFor({ timeout: 30000 });
  await email.fill(LIVE_EMAIL);
  await page.fill(t("input-signin-password"), LIVE_PASSWORD);
  await page.click(t("button-signin"));
  await page.waitForSelector(t("page-dashboard"), { timeout: 45000 });
}

/** Nothing visible inside `sel` runs past the window's edges. */
async function fitsWidth(page: any, sel: string): Promise<string> {
  return page.evaluate((sel: string) => {
    const root = document.querySelector(sel) as HTMLElement | null;
    if (!root) return `no ${sel}`;
    const w = window.innerWidth;
    if (document.documentElement.scrollWidth > w + 1) return `the page scrolls sideways (${document.documentElement.scrollWidth} > ${w})`;
    const bad = Array.from(root.querySelectorAll("*")).find((el) => {
      const e = el as HTMLElement;
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      // Inside a row that scrolls sideways on purpose.
      for (let n: HTMLElement | null = e.parentElement; n && n !== root.parentElement; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") return false;
      }
      return r.right > w + 1 || r.left < -1;
    }) as HTMLElement | undefined;
    return bad ? `past the edge: <${bad.tagName.toLowerCase()} ${bad.getAttribute("data-testid") || String(bad.className).slice(0, 60)}>` : "";
  }, sel);
}

async function fourFieldForm(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const pg = pdf.addPage([420, 320]);
  const form = pdf.getForm();
  const rows: Array<[string, string]> = [["Full name", "full_name"], ["Email", "email"], ["Phone", "phone"], ["City", "city"]];
  rows.forEach(([label, name], i) => {
    const y = 260 - i * 50;
    pg.drawText(`${label}:`, { x: 20, y: y + 6, size: 12 });
    form.createTextField(name).addToPage(pg, { x: 120, y, width: 220, height: 22 });
  });
  return Buffer.from(await pdf.save());
}

async function run(browser: any, mode: "desktop" | "phone", made: { profiles: string[]; expenses: string[]; artifacts: string[]; documents: string[] }) {
  const phone = mode === "phone";
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const label = (s: string) => `[${mode}] ${s}`;
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: SHOTS ? 2 : 1, timezoneId: "America/Los_Angeles" }
    : { viewport: { width: 1400, height: 950 }, deviceScaleFactor: SHOTS ? 2 : 1, timezoneId: "America/Los_Angeles" });
  const page = await ctx.newPage();
  await page.addInitScript("window.__name = (f) => f;");
  // The visible one: the editor draws a phone header and a desktop header.
  const press = (sel: string) => { const el = page.locator(sel).locator("visible=true").first(); return phone ? el.tap() : el.click(); };
  const seen: Array<{ method: string; path: string }> = [];
  await wire(page, seen, { match: /^\/api\/(artifacts|documents)$/, ms: 0 });
  // A full-page load after sign-in is a reload the user did not ask for.
  let loads = 0;
  page.on("load", () => { loads++; });
  try {
    await signIn(page);

    // ── 1. The asset's own tabs after a manual refresh ──────────────────
    const camName = `Tutorial Camera ${tag}`;
    const cam = await call("POST", "/profiles", { type: "asset", name: camName, fields: { currentValue: 900, purchasePrice: 900 } });
    made.profiles.push(cam.id);
    await page.goto(`${UI_BASE}/#/profiles/${cam.id}`);
    await page.locator(t("asset-details")).waitFor({ timeout: 45000 });
    await page.waitForTimeout(1500);
    // Leave the asset's page, then write from elsewhere (what the chat does).
    await page.goto(`${UI_BASE}/#/`);
    await page.waitForSelector(t("page-dashboard"));
    const today = new Date().toISOString().slice(0, 10);
    const cloth = await call("POST", "/expenses", { description: `Cloth ${tag}`, amount: 12.34, category: "general", date: today, linkedProfiles: [cam.id] });
    made.expenses.push(cloth.id);
    const lensName = `Tutorial Lens ${tag}`;
    const chat = await call("POST", "/chat", { message: `Add a ${lensName} as a nested asset inside ${camName}. It's worth $250.`, history: [] });
    const all = (await call("GET", "/profiles")) as any[];
    const lens = all.find((p) => p.name === lensName);
    if (lens) made.profiles.push(lens.id);
    check(!!lens && lens.parentProfileId === cam.id, label("chat nested the lens under the camera"));
    check(String(chat.reply || "").includes(`inside **${camName}**`) && String(chat.reply || "").includes(`${camName} → ${lensName}`),
      label(`chat's confirmation names the parent the record has (${String(chat.reply || "").split("\n")[0].slice(0, 110)})`));

    const before = loads;
    await page.reload(); // the tester's manual refresh
    await page.waitForSelector(t("page-dashboard"), { timeout: 45000 });
    check(loads === before + 1, label("the manual refresh is the only page load"));
    await page.goto(`${UI_BASE}/#/profiles/${cam.id}/contained`);
    await page.locator(t("card-child-assets")).waitFor({ timeout: 45000 });
    await page.waitForFunction((n: string) => (document.querySelector('[data-testid="card-child-assets"]')?.textContent || "").includes(n), lensName, { timeout: 20000 }).catch(() => undefined);
    const kids = await page.locator(t("card-child-assets")).innerText();
    check(kids.includes(lensName), label("after a manual refresh, Contained lists the lens the chat nested"));
    check(!/No child assets yet/.test(kids), label("…and does not say \"No child assets yet\""));
    const loadsBeforeTabs = loads;
    await press(t("tab-financials"));
    await page.locator(t("asset-expenses")).waitFor({ timeout: 20000 });
    await page.waitForFunction(() => /\$12\.34/.test(document.querySelector('[data-testid="asset-expenses"]')?.textContent || ""), null, { timeout: 20000 }).catch(() => undefined);
    let fin = await page.locator(t("asset-expenses")).innerText();
    check(/\$12\.34/.test(fin) && !/No expenses logged/.test(fin), label("…and Financials counts the $12.34 expense added elsewhere"));

    // ── 2. An expense from the asset's own form ─────────────────────────
    await press(t("button-add-expense"));
    await page.locator(t("input-expense-desc")).fill(`Strap ${tag}`);
    await page.locator(t("input-expense-amount")).fill("4.56");
    const dialog = page.locator('[role="dialog"]');
    const submit = dialog.getByRole("button", { name: /add|save/i }).last();
    await (phone ? submit.tap() : submit.click());
    await page.waitForFunction(() => /\$16\.90/.test(document.querySelector('[data-testid="asset-expenses"]')?.textContent || ""), null, { timeout: 25000 }).catch(() => undefined);
    fin = await page.locator(t("asset-expenses")).innerText();
    check(/\$16\.90/.test(fin), label("the asset's own form adds $4.56: its Financials now total $16.90"));
    check(/View All Expenses\s*\(2\)/.test(fin.replace(/\n/g, " ")), label("…and lists both expenses"));
    const mine = ((await call("GET", "/expenses")) as any[]).filter((e) => String(e.description).includes(tag));
    for (const e of mine) if (!made.expenses.includes(e.id)) made.expenses.push(e.id);
    check(mine.length === 2 && mine.every((e) => (e.linkedProfiles || []).includes(cam.id)), label("each expense is stored once, linked to the camera"));
    await press(t("tab-contained"));
    await page.locator(t("card-child-assets")).waitFor({ timeout: 20000 });
    check(loads === loadsBeforeTabs, label("switching tabs and saving never reloaded the page"));
    if (phone) {
      const why = await fitsWidth(page, t("card-child-assets"));
      check(!why, label(`the Contained tab fits a phone${why ? ` — ${why}` : ""}`));
      await press(t("tab-financials"));
      await page.locator(t("asset-expenses")).waitFor({ timeout: 20000 });
      const why2 = await fitsWidth(page, t("asset-expenses"));
      check(!why2, label(`the Financials tab fits a phone${why2 ? ` — ${why2}` : ""}`));
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/qa-${mode}-asset.png` });

    // ── 3. A saved document, reopened ───────────────────────────────────
    const doc = await call("POST", "/artifacts", { type: "doc", title: `Tutorial Letter ${tag}`, content: `<p>Dear Sam,</p><p>Approved ${tag}.</p>`, source: "manual" });
    made.artifacts.push(doc.id);
    seen.length = 0;
    const loadsBeforeEditor = loads;
    await page.goto(`${UI_BASE}/#/editor/${doc.id}`);
    await page.waitForFunction((s: string) => (document.body.textContent || "").includes(s), `Approved ${tag}.`, { timeout: 45000 });
    await page.waitForTimeout(6500); // past the 5s autosave of a document that thinks it changed
    const editorText = await page.evaluate(() => document.body.innerText);
    check(!/Unsaved|Saving as you write|Not saved yet/.test(editorText) && /Saved/.test(editorText), label("a saved document reopens as \"Saved\""));
    check(!seen.some((r) => r.method !== "GET" && r.path.startsWith("/api/artifacts")), label("…and opening it wrote nothing"));
    // An edit, the Save button, and a refresh.
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/qa-${mode}-editor.png` });
    await page.locator(".ProseMirror:visible").first().evaluate((el: HTMLElement) => el.focus());
    await page.keyboard.press("Control+End");
    await page.keyboard.type(` Signed ${tag}.`);
    await press(t("button-workspace-save"));
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-testid="button-workspace-save"]')).some((b) => (b as HTMLElement).offsetParent !== null && /Saved/.test((b as HTMLElement).innerText)), null, { timeout: 20000 }).catch(() => undefined);
    const stored = await call("GET", `/artifacts/${doc.id}`);
    check(String(stored.content).includes(`Signed ${tag}.`), label("Save stores the edit"));
    check(loads === loadsBeforeEditor, label("…without reloading the page"));
    check(await page.evaluate((s: string) => (document.querySelector(".ProseMirror")?.textContent || "").includes(s), `Signed ${tag}.`), label("…and the page still holds what was typed"));
    await page.reload();
    await page.waitForFunction((s: string) => (document.body.textContent || "").includes(s), `Signed ${tag}.`, { timeout: 45000 });
    await page.waitForTimeout(1500);
    check(!/Unsaved|Saving as you write/.test(await page.evaluate(() => document.body.innerText)), label("after a refresh it reopens with the saved text, still \"Saved\""));
    if (phone) {
      const why = await fitsWidth(page, "[data-workspace-scroll]");
      check(!why, label(`the document editor fits a phone${why ? ` — ${why}` : ""}`));
    }
    await press(t("button-workspace-close"));
    await page.waitForTimeout(800);

    // ── 4. Artifacts while it loads ─────────────────────────────────────
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await wire(page, seen, { match: /^\/api\/(artifacts|documents)$/, ms: 2500 });
    await page.goto(`${UI_BASE}/#/artifacts`);
    const header = page.locator(t("artifacts-header-count"));
    await header.waitFor({ timeout: 30000 });
    const texts: string[] = [];
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const text = (await header.innerText().catch(() => "")).trim();
      if (text && texts[texts.length - 1] !== text) texts.push(text);
      if (/\b[1-9]\d* artifacts?\b/.test(text)) break;
      await page.waitForTimeout(100);
    }
    check(!texts.some((x) => /\b0 artifacts?\b/.test(x)), label(`Artifacts never read "0 artifacts" while loading (${texts.map((x) => x.split(" · ")[0]).join(" → ")})`));
    check(/\b[1-9]\d* artifacts?\b/.test(texts[texts.length - 1] || ""), label("…and then counts the saved records"));
    check((await page.locator(t("artifacts-empty-none")).count()) === 0, label("…with no \"No artifacts yet\""));
    if (phone) {
      const why = await fitsWidth(page, t("artifacts-summary"));
      check(!why, label(`Artifacts fits a phone${why ? ` — ${why}` : ""}`));
    }
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await wire(page, seen);

    // ── 5. Fill In: the four approved values, and the way out ───────────
    const approved: Record<string, string> = { full_name: `Sam Tester ${tag}`, email: `sam.${tag.toLowerCase()}@example.com`, phone: "555-0142", city: `Springfield ${tag}` };
    await page.goto(`${UI_BASE}/#/workspace/fill`);
    await page.waitForSelector(t("workspace-fill"), { timeout: 30000 });
    check(await page.evaluate(() => { const s = document.querySelector("[data-app-shell]"); return !!s && s.hasAttribute("inert"); }), label("with the Fill In workspace open, the app behind it is inert"));
    await page.setInputFiles(t("input-fill-file"), { name: `tutorial-form-${tag}.pdf`, mimeType: "application/pdf", buffer: await fourFieldForm() });
    await page.waitForSelector(t("smart-fill-dialog"), { timeout: 30000 });
    const analyze = page.locator(t("button-smart-fill-analyze"));
    await analyze.waitFor({ timeout: 30000 });
    if (!(await analyze.isEnabled())) await press('[data-testid^="smart-fill-source-"]');
    await press(t("button-smart-fill-analyze"));
    await page.waitForSelector(t("button-smart-fill-render"), { timeout: 150000 });
    // Review is the approval step: set every field to the approved value.
    const inputs = page.locator('[data-testid^="smart-fill-value-"], [data-testid^="smart-fill-missing-"]');
    const count = await inputs.count();
    const order = ["full_name", "email", "phone", "city"];
    const typed: string[] = [];
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      const row = (await input.evaluate((el: HTMLElement) => (el.closest("li, tr, [data-field-row], div.rounded-md, div.border")?.textContent || el.getAttribute("placeholder") || "").toLowerCase())) as string;
      const key = /mail/.test(row) ? "email" : /phone/.test(row) ? "phone" : /city/.test(row) ? "city" : /name/.test(row) ? "full_name" : order.find((k) => !typed.includes(k)) || "";
      if (!key || typed.includes(key)) continue;
      await input.fill(approved[key]);
      typed.push(key);
    }
    check(typed.length === 4, label(`the review lists the form's four fields (${typed.join(", ")})`));
    const rendered = page.waitForResponse((r: any) => r.url().includes("/api/smart-fill/render"), { timeout: 150000 });
    await press(t("button-smart-fill-render"));
    const result = await (await rendered).json().catch(() => null);
    if (result?.documentId) made.documents.push(result.documentId);
    await page.waitForSelector(t("button-open-filled-pdf"), { timeout: 150000 });
    let values: Record<string, string> = {};
    try {
      const filled = await PDFDocument.load(Buffer.from(String(result?.fileBase64 || ""), "base64"));
      for (const f of filled.getForm().getFields()) values[f.getName()] = (f as any).getText?.() ?? "";
    } catch { values = {}; }
    const flatText = Buffer.from(String(result?.fileBase64 || ""), "base64").toString("latin1");
    const holds = (v: string) => Object.values(values).includes(v) || flatText.includes(v);
    check(order.every((k) => holds(approved[k])), label(`the filled PDF holds the four approved values (${JSON.stringify(values).slice(0, 160)})`));
    const savedDoc = result?.documentId ? await api("GET", `/documents/${result.documentId}`) : null;
    check(!!savedDoc?.ok, label("the filled copy is a saved document"));
    if (phone) {
      const why = await fitsWidth(page, t("smart-fill-dialog"));
      check(!why, label(`Fill In's last step fits a phone${why ? ` — ${why}` : ""}`));
    }
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/qa-${mode}-fill-done.png` });
    const loadsBeforeLeave = loads;
    await press(t("button-smart-fill-view-artifacts"));
    await page.waitForFunction(() => location.hash.startsWith("#/artifacts"), null, { timeout: 15000 }).catch(() => undefined);
    check(page.url().includes("#/artifacts") && (await page.locator(t("workspace-fill")).count()) === 0, label("\"Show it in Artifacts\" leaves the Fill In workspace for Artifacts"));
    check(await page.evaluate(() => { const s = document.querySelector("[data-app-shell]"); return !!s && !s.hasAttribute("inert"); }), label("…and the app is reachable again"));
    check(loads === loadsBeforeLeave, label("…without reloading the page"));
    await page.waitForFunction((n: string) => (document.body.textContent || "").includes(n), `tutorial-form-${tag}`, { timeout: 20000 }).catch(() => undefined);
    check((await page.evaluate(() => document.body.innerText)).includes(`tutorial-form-${tag}`), label("…where the filled copy is listed"));
  } finally {
    await ctx.close();
  }
}

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-qa-2026-11-24-check" });
  const made = { profiles: [] as string[], expenses: [] as string[], artifacts: [] as string[], documents: [] as string[] };
  const browser = await chromium.launch();
  try {
    const version = await (await fetch(`${API_ORIGIN || UI_BASE}/api/version`)).json().catch(() => ({}));
    console.log(`API is serving ${String(version.sha || "?").slice(0, 7)}; UI at ${UI_BASE}`);
    for (const mode of (process.env.QA_MODES || "desktop,phone").split(",") as Array<"desktop" | "phone">) {
      try { await run(browser, mode, made); }
      catch (e: any) { check(false, `[${mode}] the run finished (${String(e?.message || e).split("\n")[0].slice(0, 200)})`); }
    }
  } finally {
    await browser.close();
    for (const id of made.expenses) await api("DELETE", `/expenses/${id}`).catch(() => undefined);
    for (const id of made.artifacts) await api("DELETE", `/artifacts/${id}`).catch(() => undefined);
    for (const id of made.documents) await api("DELETE", `/documents/${id}`).catch(() => undefined);
    // Children before parents.
    for (const id of made.profiles.reverse()) await api("DELETE", `/profiles/${id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
