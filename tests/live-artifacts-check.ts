// Live check for the Artifact rules (AR1–AR4), on the DEPLOYED app, as the
// smoke account, in a real browser — a phone with touch (390 and 360 wide)
// and a desktop.
//
//   npx tsx tests/live-artifacts-check.ts
//   (an undeployed client against the deployed API:
//    SMOKE_UI_BASE=http://localhost:5199 LIVE_API_ORIGIN=https://portol.me)
//
// What it proves:
//   1. The Artifacts tab and every view (Grid / List / Gallery) fit the screen.
//   2. Every kind opens FULL SCREEN with its whole body, an X that closes it,
//      and nothing wider than the screen; opening writes nothing.
//   3. A checklist tap and the star are written to the stored row.
//   4. Sending: the phone's share sheet gets the text, the file and the link;
//      Copy as text, Copy view-only link and Download work on desktop; the
//      link opens signed OUT and shows the artifact; Turn off kills it.
//   5. "Open in Chat" (#/chat?artifact=) opens it over the chat.
//   6. An artifact the chat makes opens from its card in the same viewer.
//
// Writes only to the smoke account, holds the gate lock and deletes what it
// created.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const req = createRequire(import.meta.url);
const { chromium } = req("playwright");
const API_ORIGIN = process.env.LIVE_API_ORIGIN || "";
const SHOTS = process.env.SHOTS || "";
const t = (id: string) => `[data-testid="${id}"]`;
let failed = 0;
const check = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; };

async function call(method: string, path: string, body?: any): Promise<any> {
  const r = await api(method, path, body);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}

async function wire(page: any, writes: Array<{ method: string; path: string }>) {
  await page.route(/\/api\//, async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") writes.push({ method: request.method(), path: url.pathname });
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

async function signIn(page: any, phone: boolean) {
  await page.goto(UI_BASE);
  const email = page.locator(t("input-signin-email"));
  if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
    await page.getByRole("button", { name: /sign in|log in|get started/i }).first().click({ timeout: 15000 }).catch(() => undefined);
    await page.locator(t("tab-signin")).click({ timeout: 5000 }).catch(() => undefined);
  }
  await email.waitFor({ timeout: 30000 });
  await email.fill(LIVE_EMAIL);
  await page.fill(t("input-signin-password"), LIVE_PASSWORD);
  const btn = page.locator(t("button-signin"));
  await (phone ? btn.tap() : btn.click());
  await page.waitForSelector(t("page-dashboard"), { timeout: 45000 });
}

/** "" when nothing is wider than the screen (or the viewer), else what is. */
const overflow = (page: any, within?: string) => page.evaluate((sel: string | undefined) => {
  const root = sel ? document.querySelector(sel) : document.body;
  if (!root) return "no root";
  const limit = sel ? (root as HTMLElement).getBoundingClientRect().right : window.innerWidth;
  const el = [...root.querySelectorAll("*")].find((n) => {
    const b = (n as HTMLElement).getBoundingClientRect();
    if (b.width === 0 || b.right <= limit + 1) return false;
    for (let p = n.parentElement; p && p !== root.parentElement; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return false;
    }
    return true;
  }) as HTMLElement | undefined;
  const wide = !sel && document.documentElement.scrollWidth > window.innerWidth + 1;
  return el || wide ? `${Math.round(el?.getBoundingClientRect().right ?? document.documentElement.scrollWidth)}px of ${Math.round(limit)}px <${el?.tagName.toLowerCase()} ${el?.getAttribute("data-testid") || String(el?.className || "").slice(0, 60)}>` : "";
}, within);

(async () => {
  const release = await acquireGateLock(preferenceLockIo(api as any) as any, { gate: "live-artifacts" });
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const made: string[] = [];
  const madeDocs: string[] = [];
  const browser = await chromium.launch();
  try {
    // ── Records, one per kind ───────────────────────────────────────────
    const longLine = "A very long unbroken word: " + "supercalifragilisticexpialidocious".repeat(3);
    const kinds: Array<{ key: string; body: any; expect: string | RegExp }> = [
      { key: "markdown", body: { type: "markdown", title: `Sleep & Wellness Plan ${tag} with a fairly long title that wraps`, content: `# Sleep plan ${tag}\n\n- **Biggest gap:** No sleep tracking yet.\n\n| Habit | Streak | Status | Notes |\n| --- | --- | --- | --- |\n| Morning Run | 12 days | Perfect | keep going strong every morning |\n| Yoga | 5 days | Good | evenings |\n\n${longLine}\n\n\`\`\`\nconst wide = "${"x".repeat(160)}";\n\`\`\`` }, expect: `Sleep plan ${tag}` },
      { key: "checklist", body: { type: "checklist", title: `Morning Routine ${tag}`, content: "", items: [{ text: `Drink water ${tag}`, checked: false }, { text: "Stretch", checked: true }] }, expect: `Drink water ${tag}` },
      { key: "chart", body: { type: "note", title: `Monthly Spending ${tag}`, content: JSON.stringify({ type: "bar", title: `Monthly Spending ${tag}`, xAxisKey: "name", series: [{ dataKey: "amount", name: "Amount" }], data: [{ name: "Food", amount: 420 }, { name: "Rent", amount: 1200 }, { name: "Gas", amount: 310 }, { name: "Fun", amount: 260 }] }) }, expect: `Monthly Spending ${tag}` },
      { key: "rawchart", body: { type: "chart", title: `Vehicle Value ${tag}`, content: JSON.stringify([{ name: "2023", value: 28500 }, { name: "2024", value: 25200 }, { name: "2025", value: 23100 }]), chartType: "line" }, expect: /line/i },
      { key: "html", body: { type: "html", title: `Tip Calculator ${tag}`, content: `<html><body><h2>Tip ${tag}</h2><input id=b value=50><button id=go onclick="document.getElementById('o').textContent=(+document.getElementById('b').value*0.2).toFixed(2)">20%</button><p>Tip: $<span id=o>0</span></p></body></html>` }, expect: "" },
      { key: "code", body: { type: "code", language: "python", title: `Budget script ${tag}`, content: `def monthly(total):\n    return total / 12  # ${"comment ".repeat(20)}\nprint(monthly(14400))` }, expect: "def monthly" },
      { key: "svg", body: { type: "svg", title: `Badge ${tag}`, content: `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200" viewBox="0 0 900 200"><rect width="900" height="200" rx="20" fill="#7c3aed"/><text x="40" y="120" font-size="64" fill="white">Badge ${tag}</text></svg>` }, expect: "" },
    ];
    const ids: Record<string, string> = {};
    for (const k of kinds) {
      const row = await call("POST", "/artifacts", { ...k.body, source: "chat" });
      ids[k.key] = row.id; made.push(row.id);
    }

    // A real PDF and a real photo, so the List view's previews are proven on
    // actual files (owner's design, 2026-11-26: a PDF's first page, a scan).
    const docs: Record<string, string> = {};
    {
      const maker = await (await browser.newContext()).newPage();
      await maker.setContent(`<html><body style="font-family:sans-serif;padding:40px"><h1>Avery Chen ${tag}</h1><h3>Product Manager</h3><p>Six years building user-centric products.</p><ul><li>Led growth</li><li>Shipped mobile apps</li></ul></body></html>`);
      const pdf = (await maker.pdf({ format: "A4" })).toString("base64");
      await maker.setViewportSize({ width: 300, height: 420 });
      await maker.setContent(`<html><body style="margin:0;background:#fff;font-family:monospace;padding:20px"><h2 style="text-align:center">Sunny Day Cafe ${tag}</h2><p>Iced Latte ........ $4.75</p><p>Avocado Toast ..... $7.50</p><p><b>Total ............. $12.25</b></p></body></html>`);
      const png = (await maker.screenshot({ type: "png" })).toString("base64");
      await maker.context().close();
      const d1 = await call("POST", "/documents", { name: `Resume ${tag}.pdf`, title: `Résumé ${tag}`, type: "other", mimeType: "application/pdf", fileData: pdf, tags: ["career"], extractedData: { name: `Avery Chen ${tag}` } });
      const d2 = await call("POST", "/documents", { name: `Sunny Day Cafe ${tag}.png`, title: `Sunny Day Cafe Receipt ${tag}`, type: "receipt", mimeType: "image/png", fileData: png, tags: ["receipt"], extractedData: { total: 12.25 } });
      docs.pdf = d1.id; docs.png = d2.id;
      madeDocs.push(d1.id, d2.id);
    }

    for (const surface of ([
      { name: "phone 390", phone: true, viewport: { width: 390, height: 844 } },
      { name: "phone 360", phone: true, viewport: { width: 360, height: 740 } },
      { name: "desktop", phone: false, viewport: { width: 1400, height: 950 } },
    ] as const).filter((x) => !process.env.SURFACES || process.env.SURFACES.split(",").includes(x.name))) {
      const ctx = await browser.newContext({
        viewport: surface.viewport, hasTouch: surface.phone, isMobile: surface.phone,
        deviceScaleFactor: SHOTS ? 2 : 1, timezoneId: "America/Los_Angeles", acceptDownloads: true,
      });
      // What the app copies: the selection behind execCommand("copy") and any
      // navigator.clipboard.writeText — read back without the OS clipboard.
      await ctx.addInitScript(() => {
        (window as any).__copied = [];
        const exec = document.execCommand.bind(document);
        (document as any).execCommand = (cmd: string, ...rest: any[]) => {
          if (cmd === "copy") {
            const a = document.activeElement as HTMLTextAreaElement | null;
            (window as any).__copied.push(a && "value" in a ? a.value : String(document.getSelection() || ""));
          }
          return exec(cmd, ...rest);
        };
        if (navigator.clipboard) {
          const w = navigator.clipboard.writeText?.bind(navigator.clipboard);
          (navigator.clipboard as any).writeText = async (x: string) => { (window as any).__copied.push(x); try { await w?.(x); } catch { /* headless */ } };
        }
      });
      if (surface.phone) {
        // The phone's share sheet: record what the app hands it.
        await ctx.addInitScript(() => {
          (window as any).__shared = [];
          (navigator as any).share = async (d: any) => {
            (window as any).__shared.push({ title: d.title, text: d.text, url: d.url, files: (d.files || []).map((f: File) => ({ name: f.name, type: f.type, size: f.size })) });
          };
          (navigator as any).canShare = () => true;
        });
      }
      const page = await ctx.newPage();
      const writes: Array<{ method: string; path: string }> = [];
      const errors: string[] = [];
      page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
      await wire(page, writes);
      const press = async (sel: string) => {
        const el = page.locator(sel).locator("visible=true").first();
        await el.waitFor({ timeout: 20000 });
        await (surface.phone ? el.tap() : el.click());
      };
      const L = (s: string) => `${surface.name} · ${s}`;
      await signIn(page, surface.phone);

      // ── 1 · the tab fits, in every view ───────────────────────────────
      await page.goto(`${UI_BASE}/#/artifacts`);
      await page.locator(t(`artifact-card-${ids.markdown}`)).first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(800);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${surface.name.replace(" ", "-")}-tab.png` });
      for (const v of ["grid", "list", "gallery", "grid"]) {
        await press(t(`view-${v}`));
        await page.waitForTimeout(300);
        const o = await overflow(page);
        check(o === "", L(`the Artifacts tab fits the screen in ${v} view${o ? ` (${o})` : ""}`));
      }
      // The List view: real previews, kind · format · time, tags, Send.
      await press(t("view-list"));
      for (const [k, id] of Object.entries(docs)) {
        const row = page.locator(t(`artifact-card-${id}`));
        await row.scrollIntoViewIfNeeded();
        const thumb = row.locator(t(`doc-thumb-${id}`));
        const drawn = await thumb.locator(k === "pdf" ? "canvas" : "img").first().waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
        let ok = drawn;
        if (drawn && k === "png") ok = await thumb.locator("img").first().evaluate((im: any) => im.complete && im.naturalWidth > 0);
        if (drawn && k === "pdf") ok = await thumb.locator("canvas").first().evaluate((c: any) => c.width > 0 && c.height > 0);
        check(ok, L(`the ${k === "pdf" ? "PDF's first page" : "photo"} is the row's preview`));
        const meta = (await row.locator(t(`artifact-row-meta-${id}`)).textContent()) || "";
        check(k === "pdf" ? /^Document · PDF · (Today|Yesterday|\w{3} \d)/.test(meta) : /^Scan · /.test(meta), L(`the row says "${meta}"`));
        check(await row.getByText("Send").locator("visible=true").count() === 1, L(`the ${k} row has one Send`));
      }
      await page.waitForTimeout(500);
      // Every row keeps its preview at the side: the thumbnail is narrower
      // than the row and the text column starts to its right, inside the row.
      const rowsBad = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="artifact-card-"]')].map((row) => {
        const r = row.getBoundingClientRect();
        const kids = [...row.children] as HTMLElement[];
        const thumb = kids[0]?.getBoundingClientRect(); const text = kids[1]?.getBoundingClientRect();
        // Nothing inside the text column overlaps another control (the star
        // over the owner chip, 2026-11-26).
        const els = [...(kids[1]?.querySelectorAll("button, span.rounded-full") || [])].map((n) => (n as HTMLElement).getBoundingClientRect()).filter((b) => b.width > 0);
        const overlap = els.some((a, i) => els.some((b, j) => j > i && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1 && !(a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom) && !(b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom)));
        const bad = !thumb || !text || overlap || thumb.width > r.width * 0.45 || text.left < thumb.right - 1 || text.right > r.right + 1 || text.width < 120;
        return bad ? `${row.getAttribute("data-testid")}${overlap ? " controls overlap" : ""} thumb ${Math.round(thumb?.width ?? 0)} text ${Math.round(text?.left ?? 0)}..${Math.round(text?.right ?? 0)} of ${Math.round(r.right)}` : "";
      }).filter(Boolean));
      check(rowsBad.length === 0, L(`every List row keeps its preview at the side and its text inside${rowsBad.length ? ` (${rowsBad.join("; ")})` : ""}`));
      const ol = await overflow(page);
      check(ol === "", L(`the List view fits the screen${ol ? ` (${ol})` : ""}`));
      if (SHOTS) {
        await page.locator(t(`artifact-card-${docs.pdf}`)).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${SHOTS}/${surface.name.replace(" ", "-")}-list.png` });
      }
      if (surface.phone) {
        // Send on an uploaded document hands the share sheet the file itself.
        const row = page.locator(t(`artifact-card-${docs.pdf}`));
        await row.getByText("Send").locator("visible=true").first().tap();
        await page.locator(t("share-document-file")).waitFor({ timeout: 10000 });
        await page.locator(t("share-document-file")).tap();
        await page.waitForFunction(() => ((window as any).__shared || []).some((x: any) => x.files?.length), undefined, { timeout: 20000 }).catch(() => undefined);
        const sent = await page.evaluate(() => ((window as any).__shared || []).find((x: any) => x.files?.length));
        check(sent?.files?.[0]?.type === "application/pdf" && sent.files[0].size > 1000, L(`Send on a PDF hands the share sheet the PDF (${JSON.stringify(sent?.files?.[0])})`));
        await page.evaluate(() => { (window as any).__shared = []; });
      }
      await press(t("view-grid"));
      await page.waitForTimeout(300);
      const cards = await page.locator('[data-testid^="artifact-card-"]').count();
      const total = Number((await page.locator(`${t("artifacts-stat-showing")} p`).nth(0).textContent())?.trim() || "-1");
      check(cards === total, L(`the Total tile (${total}) equals the cards drawn (${cards})`));

      // ── 2 · every kind opens full screen ──────────────────────────────
      writes.length = 0;
      for (const k of kinds) {
        await page.locator(t(`artifact-card-${ids[k.key]}`)).scrollIntoViewIfNeeded();
        await press(t(`artifact-card-${ids[k.key]}`));
        const viewer = page.locator(t("artifact-viewer"));
        await viewer.waitFor({ timeout: 15000 });
        await page.waitForTimeout(k.key.includes("chart") ? 1500 : 500);
        const box = await viewer.boundingBox();
        const vp = surface.viewport;
        const full = surface.phone
          ? !!box && box.width >= vp.width - 1 && box.height >= vp.height - 2
          : !!box && box.width >= 800 && box.height >= vp.height * 0.85;
        check(full, L(`${k.key} opens full screen (${box ? `${Math.round(box.width)}×${Math.round(box.height)}` : "none"})`));
        const body = page.locator(t("artifact-viewer-body"));
        const text = (await body.innerText()).trim();
        if (k.key === "html") {
          const frame = page.frameLocator(t("artifact-html-frame"));
          await frame.locator("#go").click({ timeout: 10000 });
          const tip = await frame.locator("#o").textContent({ timeout: 5000 });
          check(tip === "10.00", L(`the HTML artifact runs: 20% of 50 = ${tip}`));
        } else if (k.key === "svg") {
          check(await body.locator("svg").count() > 0, L("the SVG artifact is drawn"));
        } else {
          const ok = typeof k.expect === "string" ? text.includes(k.expect) : k.expect.test(text) || (await body.locator("svg").count()) > 0;
          check(ok && !/Unknown artifact type/.test(text), L(`${k.key} shows its whole body`));
        }
        // Nothing sticks out sideways: the scroll area itself must not scroll
        // horizontally, and no element (outside a block that scrolls on its
        // own, like a code box or a wide table) may run past its edge.
        const o = (await overflow(page, t("artifact-viewer-body"))) || await page.evaluate((sel: string) => {
          const b = document.querySelector(sel) as HTMLElement | null;
          if (!b) return "no viewer body";
          const inner = b.firstElementChild as HTMLElement | null;
          const clipped = [...b.querySelectorAll("p, li, h1, h2, h3, td, th, span")].find((n) => {
            const r = (n as HTMLElement).getBoundingClientRect();
            const box = b.getBoundingClientRect();
            if (r.width === 0 || r.right <= box.right + 1) return false;
            for (let p = n.parentElement; p && p !== b; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if (ox === "auto" || ox === "scroll") return false; }
            return true;
          }) as HTMLElement | undefined;
          if (b.scrollWidth > b.clientWidth + 1) return `scrolls sideways ${b.scrollWidth}/${b.clientWidth}`;
          if (inner && inner.scrollWidth > inner.clientWidth + 1) return `content ${inner.scrollWidth}/${inner.clientWidth}`;
          return clipped ? `cut off: "${(clipped.textContent || "").slice(0, 40)}"` : "";
        }, t("artifact-viewer-body"));
        check(o === "", L(`${k.key}: nothing in the viewer is wider than it${o ? ` (${o})` : ""}`));
        const ho = await overflow(page, t("artifact-viewer"));
        check(ho === "", L(`${k.key}: the viewer's header fits${ho ? ` (${ho})` : ""}`));
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/${surface.name.replace(" ", "-")}-${k.key}.png` });
        await press(t("button-artifact-viewer-close"));
        await viewer.waitFor({ state: "detached", timeout: 10000 }).catch(() => undefined);
        check(!(await viewer.isVisible().catch(() => false)), L(`${k.key}: the X closes the viewer`));
      }
      check(writes.length === 0, L(`opening every artifact wrote nothing${writes.length ? ` (${writes.map((w) => `${w.method} ${w.path}`).join(", ")})` : ""}`));
      check(errors.length === 0, L(`no script errors${errors.length ? ` (${errors.join(" | ")})` : ""}`));

      // ── 3 · checklist tap and star are stored ─────────────────────────
      await press(t(`artifact-card-${ids.checklist}`));
      await page.locator(t("artifact-checklist")).waitFor({ timeout: 15000 });
      await press(t("artifact-checklist-item-0"));
      await page.waitForTimeout(2500);
      const afterTap = await call("GET", `/artifacts/${ids.checklist}`);
      const first = (afterTap.items || []).find((i: any) => String(i.text).includes(`Drink water ${tag}`));
      check(!!first?.checked, L("a checklist tap is saved on the stored row"));
      await press(t("artifact-checklist-item-0"));
      await page.waitForTimeout(2000);
      await press(t("button-artifact-viewer-star"));
      await page.waitForTimeout(2500);
      check((await call("GET", `/artifacts/${ids.checklist}`)).pinned === true, L("the star is saved"));
      await press(t("button-artifact-viewer-star"));
      await page.waitForTimeout(2000);

      // ── 4 · sending it anywhere ───────────────────────────────────────
      const viewerShare = `${t("artifact-viewer")} ${t("button-artifact-share")}`;
      const openShare = async () => { await press(viewerShare); await page.locator(t("share-copy-text")).waitFor({ timeout: 10000 }); };
      await openShare();
      const options = ["share-copy-text", "share-email", "share-sms", "share-download", surface.phone ? "share-native" : "share-link"];
      for (const o of options) check(await page.locator(t(o)).isVisible(), L(`Share offers ${o.replace("share-", "")}`));
      const menuFit = await page.evaluate(() => {
        const m = document.querySelector('[role="menu"]') as HTMLElement | null;
        if (!m) return "no menu";
        const b = m.getBoundingClientRect();
        return b.left >= 0 && b.right <= window.innerWidth + 1 && b.bottom <= window.innerHeight + 1 ? "" : `${Math.round(b.left)}..${Math.round(b.right)} × ..${Math.round(b.bottom)}`;
      });
      check(menuFit === "", L(`the share menu fits on screen${menuFit ? ` (${menuFit})` : ""}`));
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${surface.name.replace(" ", "-")}-share.png` });

      if (surface.phone) {
        await press(t("share-native"));
        await page.waitForTimeout(500);
        await openShare(); await press(t("share-file"));
        await page.waitForTimeout(800);
        await openShare(); await press(t("share-link"));
        await page.waitForTimeout(3000);
        const shared = await page.evaluate(() => (window as any).__shared);
        check(!!shared?.[0]?.text?.includes(`☐ Drink water ${tag}`) || !!shared?.[0]?.text?.includes(`Drink water ${tag}`), L("Share to an app hands the share sheet the checklist as text"));
        check(shared?.[1]?.files?.[0]?.name === `Morning Routine ${tag}.txt` && shared[1].files[0].size > 0, L(`Send as a file hands it a file (${JSON.stringify(shared?.[1]?.files?.[0])})`));
        check(/\/#\/share\/[0-9a-f]{64}$/.test(shared?.[2]?.url || ""), L("a view-only link goes to the share sheet"));
      } else {
        await press(t("share-copy-text"));
        await page.waitForTimeout(500);
        const txt = await page.evaluate(() => ((window as any).__copied || []).slice(-1)[0] || "");
        check(txt.includes(`Morning Routine ${tag}`) && txt.includes(`Drink water ${tag}`), L("Copy as text puts the checklist on the clipboard"));
        await openShare();
        const dl = page.waitForEvent("download", { timeout: 15000 });
        await press(t("share-download"));
        const file = await dl;
        const path = await file.path();
        const content = path ? (await import("node:fs")).readFileSync(path, "utf8") : "";
        check(file.suggestedFilename() === `Morning Routine ${tag}.txt` && content.includes(`Drink water ${tag}`), L(`Download saves ${file.suggestedFilename()}`));
        await openShare(); await press(t("share-link"));
        await page.waitForTimeout(3000);
        const link = await page.evaluate(() => ((window as any).__copied || []).slice(-1)[0] || "");
        check(/\/#\/share\/[0-9a-f]{64}$/.test(link), L("Copy view-only link puts a share link on the clipboard"));
        if (!/\/#\/share\//.test(link)) throw new Error(`no share link was copied (${link.slice(0, 80)})`);
        // The link opens signed OUT and shows each kind.
        const anon = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const pub = await anon.newPage();
        await pub.goto(link);
        await pub.getByText(`Drink water ${tag}`).first().waitFor({ timeout: 30000 }).catch(() => undefined);
        check(await pub.getByText(`Drink water ${tag}`).first().isVisible().catch(() => false), "public link · a signed-out phone sees the checklist");
        const po = await overflow(pub);
        check(po === "", `public link · the shared page fits a phone${po ? ` (${po})` : ""}`);
        for (const k of ["markdown", "chart", "html", "code", "svg"]) {
          const tok = (await call("POST", `/artifacts/${ids[k]}/share`)).token;
          await pub.goto(`${UI_BASE}/#/share/${tok}`);
          await pub.reload();
          await pub.waitForTimeout(3500);
          const txt2 = await pub.locator("main").innerText().catch(() => "");
          const ok = k === "markdown" ? txt2.includes(`Sleep plan ${tag}`)
            : k === "chart" ? (await pub.locator("main svg").count()) > 0
            : k === "html" ? (await pub.locator("main iframe").count()) > 0
            : k === "code" ? txt2.includes("def monthly")
            : (await pub.locator("main svg").count()) > 0;
          check(ok && !/isn't available/.test(txt2), `public link · a shared ${k} renders signed out`);
          const o2 = await overflow(pub);
          check(o2 === "", `public link · the shared ${k} fits a phone${o2 ? ` (${o2})` : ""}`);
          if (SHOTS) await pub.screenshot({ path: `${SHOTS}/public-${k}.png` });
        }
        // Turning the link off kills it.
        await page.reload();
        await page.locator(t(`artifact-card-${ids.checklist}`)).first().waitFor({ timeout: 30000 });
        await press(t(`artifact-card-${ids.checklist}`));
        await openShare(); await press(t("share-revoke"));
        await page.waitForTimeout(3000);
        await pub.goto(link); await pub.reload();
        await pub.waitForTimeout(3500);
        check(/isn't available/.test(await pub.locator("body").innerText()), "public link · after Turn off, the link no longer opens");
        await anon.close();
      }
      await page.keyboard.press("Escape").catch(() => undefined);
      // Close the viewer the way a person does (its X), not by typing an
      // address over an open dialog.
      if (await page.locator(t("button-artifact-viewer-close")).isVisible().catch(() => false)) {
        await press(t("button-artifact-viewer-close"));
        await page.locator(t("artifact-viewer")).waitFor({ state: "detached", timeout: 10000 }).catch(() => undefined);
      }

      // ── 5 · Open in Chat ──────────────────────────────────────────────
      // From the viewer's ⋯ menu, as a person taps it…
      await page.goto(`${UI_BASE}/#/artifacts`);
      await page.locator(t(`artifact-card-${ids.markdown}`)).first().waitFor({ timeout: 30000 });
      await press(t(`artifact-card-${ids.markdown}`));
      await page.locator(t("artifact-viewer")).waitFor({ timeout: 15000 });
      await press(t("button-artifact-viewer-more"));
      await press(t("artifact-open-in-chat"));
      await page.waitForFunction(() => location.hash.startsWith("#/chat"), undefined, { timeout: 15000 }).catch(() => undefined);
      const mt = (await page.locator(t("artifact-viewer-title")).textContent({ timeout: 20000 }).catch(() => "")) || "";
      check(mt.includes(tag) && (await page.evaluate(() => location.hash)) === "#/chat", L(`the viewer's ⋯ → Open in Chat opens it over the chat (${await page.evaluate(() => location.hash)})`));
      if (await page.locator(t("button-artifact-viewer-close")).isVisible().catch(() => false)) await press(t("button-artifact-viewer-close"));
      // …and from a link.
      await page.goto(`${UI_BASE}/#/chat?artifact=${ids.markdown}`);
      await page.reload();
      const v = page.locator(t("artifact-viewer"));
      await v.waitFor({ timeout: 30000 }).catch(() => undefined);
      const vt = (await page.locator(t("artifact-viewer-title")).textContent().catch(() => "")) || "";
      check(vt.includes(tag), L(`#/chat?artifact= opens that artifact over the chat${vt.includes(tag) ? "" : ` (title "${vt}", hash ${await page.evaluate(() => location.hash)}, viewers ${await page.locator(t("artifact-viewer")).count()})`}`));
      check(!(await page.evaluate(() => location.hash)).includes("artifact="), L("the artifact parameter leaves the address"));
      if (await v.isVisible().catch(() => false)) await press(t("button-artifact-viewer-close"));

      await ctx.close();
    }

    // ── 6 · an artifact the chat makes opens from its card ──────────────
    if (!process.env.SKIP_CHAT) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: SHOTS ? 2 : 1 });
      const page = await ctx.newPage();
      await wire(page, []);
      await signIn(page, true);
      await page.goto(`${UI_BASE}/#/chat`);
      const input = page.locator(t("input-chat")).locator("visible=true").first();
      await input.waitFor({ timeout: 30000 });
      await input.fill(`Create a markdown artifact titled "Chat Plan ${tag}" with a heading and a two-row table of habits.`);
      await page.locator(t("button-send")).locator("visible=true").first().tap();
      const card = page.getByRole("button", { name: /open artifact/i }).first();
      const appeared = await card.waitFor({ timeout: 120000 }).then(() => true).catch(() => false);
      check(appeared, "chat · the chat made an artifact and shows its card");
      if (appeared) {
        await card.tap();
        const viewer = page.locator(t("artifact-viewer"));
        await viewer.waitFor({ timeout: 20000 }).catch(() => undefined);
        await page.waitForTimeout(600);
        const body = await page.locator(t("artifact-viewer-body")).innerText().catch(() => "");
        check(await page.locator(t("button-artifact-viewer-star")).isVisible().catch(() => false), "chat · the viewer has the saved artifact (its star is there)");
        check(await viewer.isVisible() && body.length > 20 && !/Unknown artifact type/.test(body), "chat · Open artifact shows the whole artifact full screen");
        const box = await viewer.boundingBox();
        check(!!box && box.width >= 389, "chat · the viewer fills the phone's width");
        // Nothing sticks out sideways: the scroll area itself must not scroll
        // horizontally, and no element (outside a block that scrolls on its
        // own, like a code box or a wide table) may run past its edge.
        const o = (await overflow(page, t("artifact-viewer-body"))) || await page.evaluate((sel: string) => {
          const b = document.querySelector(sel) as HTMLElement | null;
          if (!b) return "no viewer body";
          const inner = b.firstElementChild as HTMLElement | null;
          const clipped = [...b.querySelectorAll("p, li, h1, h2, h3, td, th, span")].find((n) => {
            const r = (n as HTMLElement).getBoundingClientRect();
            const box = b.getBoundingClientRect();
            if (r.width === 0 || r.right <= box.right + 1) return false;
            for (let p = n.parentElement; p && p !== b; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if (ox === "auto" || ox === "scroll") return false; }
            return true;
          }) as HTMLElement | undefined;
          if (b.scrollWidth > b.clientWidth + 1) return `scrolls sideways ${b.scrollWidth}/${b.clientWidth}`;
          if (inner && inner.scrollWidth > inner.clientWidth + 1) return `content ${inner.scrollWidth}/${inner.clientWidth}`;
          return clipped ? `cut off: "${(clipped.textContent || "").slice(0, 40)}"` : "";
        }, t("artifact-viewer-body"));
        check(o === "", `chat · nothing in it is wider than the screen${o ? ` (${o})` : ""}`);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/chat-artifact.png` });
      }
      await ctx.close();
      const all = (await call("GET", "/artifacts")) as any[];
      for (const a of all.filter((a) => String(a.title || "").includes(tag))) if (!made.includes(a.id)) made.push(a.id);
    }
  } catch (e: any) {
    check(false, `run stopped: ${e?.message || e}`);
  } finally {
    for (const id of made) await api("DELETE", `/artifacts/${id}`).catch(() => undefined);
    for (const id of madeDocs) await api("POST", `/documents/${id}/purge`).catch(() => undefined);
    await browser.close();
    await release();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll artifact checks passed");
  process.exit(failed ? 1 : 0);
})();
