// Browser verification of the audit fixes.
//
// Serves the REAL production bundle from dist/public, stubs every /api/* call
// with fixtures reproducing the exact numbers the audit reported on
// https://portol.me, then drives the UI and checks what actually renders.
//
// Deliberately NOT pointed at production: the audit recorded a real $90.50
// payment by misclicking during a read-only pass, and the P1 test below clicks
// the very same button.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

// Playwright's own browser resolution works when it managed the download. In
// preconfigured images the binary lives under PLAYWRIGHT_BROWSERS_PATH with a
// version suffix, so find it rather than pinning a version that will rot.
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base)) {
    if (!dir.startsWith("chromium-")) continue;
    const bin = path.join(base, dir, "chrome-linux", "chrome");
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}
const CHROME = findChrome();

const ROOT = path.resolve(process.cwd(), "dist/public");
const SHOTS = path.resolve(process.cwd(), "dist/browser-check");
const shot = (name) => path.join(SHOTS, `${name}.png`);
const PORT = 4317;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json", ".ico": "image/x-icon",
};

if (!fs.existsSync(path.join(ROOT, "index.html"))) {
  console.error("dist/public is missing — run `npm run build` first.");
  process.exit(2);
}
fs.mkdirSync(SHOTS, { recursive: true });

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let file = path.join(ROOT, url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
  const body = fs.readFileSync(file);
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  res.end(body);
});

// ── Fixtures: the audited account, reduced to what these checks need ─────────

const HOUSE_ID = "p-house", MORTGAGE_ID = "p-mortgage", QA_ASSET_ID = "p-qa-laptop";

// Ownership-adjusted balance sheet rows, exactly as the server sends them.
// House: 50% of $500,000. The audit saw "$250,000" here vs "$500,000" on the
// house's own page, with nothing reconciling the two.
const ASSET_BREAKDOWN = [
  { id: HOUSE_ID, name: "House", type: "property", grossValue: 500000, share: 50, value: 250000 },
  { id: "p-f150", name: "Ford F150 2025", type: "vehicle", grossValue: 18500, share: 100, value: 18500 },
  // Synthetic QA row. Hidden from the list by the test-data filter — the audit
  // found it still counted in the TOTAL.
  { id: QA_ASSET_ID, name: "Test Laptop QA", type: "asset", grossValue: 370, share: 50, value: 185 },
];

// Ten liabilities so the card must truncate at 8. The last two sum to $223 —
// the exact gap the audit measured between the header and the visible rows.
const LIABILITY_BREAKDOWN = [
  { id: MORTGAGE_ID, name: "Mike's House Mortgage", type: "mortgage", grossValue: 348889, share: 50, value: 174444 },
  { id: "l2", name: "Lakeview Cabin Mortgage", type: "mortgage", grossValue: 250000, share: 50, value: 125000 },
  { id: "l3", name: "2021 Honda HR-V Auto Loan", type: "auto", grossValue: 17100, share: 100, value: 17100 },
  { id: "l4", name: "Ford F150 2025 Auto Loan", type: "auto", grossValue: 15000, share: 100, value: 15000 },
  { id: "l5", name: "Card — Visa", type: "credit", grossValue: 6800, share: 100, value: 6800 },
  { id: "l6", name: "Card — Amex", type: "credit", grossValue: 4200, share: 100, value: 4200 },
  { id: "l7", name: "Student Loan", type: "student", grossValue: 3600, share: 100, value: 3600 },
  { id: "l8", name: "Goodyear Tires Financing", type: "other", grossValue: 2904, share: 100, value: 2904 },
  { id: "l9", name: "Dental Plan", type: "other", grossValue: 148, share: 100, value: 148 },
  { id: "l10", name: "Gym Contract", type: "other", grossValue: 75, share: 100, value: 75 },
];

const BILLS = [
  { id: "b-rent", name: "Rent the 1st", amount: 2500, daysUntil: -28, status: "overdue", category: "housing" },
  { id: "b-phone", name: "Phone Bill payment", amount: 86.5, daysUntil: -12, status: "overdue", category: "utilities" },
  { id: "b-elec", name: "Electric bill", amount: 140, daysUntil: -5, status: "overdue", category: "utilities" },
  { id: "b-water", name: "Water Bill payment", amount: 90.5, daysUntil: -2, status: "overdue", category: "utilities" },
  { id: "b-netflix", name: "Netflix", amount: 10, daysUntil: 6, status: "upcoming", category: "subscription" },
];

// The audited weight goal: target 160, tracker says 181, started at 190.
const WEIGHT_GOAL = {
  id: "g-weight", title: "Weight goal", type: "weight_loss",
  target: 160, current: 181, startValue: 190, unit: "lbs",
  deadline: "2026-05-10", status: "active", milestones: [],
  linkedProfiles: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
};

const FINANCE_SNAPSHOT = {
  assetBreakdown: ASSET_BREAKDOWN,
  liabilityBreakdown: LIABILITY_BREAKDOWN,
  // Server totals INCLUDING the QA row — the finance card used to render these
  // verbatim while filtering the rows beneath them.
  totalAssetValue: ASSET_BREAKDOWN.reduce((s, r) => s + r.value, 0),
  totalLiabilities: LIABILITY_BREAKDOWN.reduce((s, r) => s + r.value, 0),
  upcomingBills: BILLS,
  totalMonthlySpend: 1384,
  monthlyObligationTotal: 2827,
  spendByCategory: { housing: 2500, utilities: 317 },
};

const PROFILES = [
  { id: "p-self", name: "Test", type: "self", fields: {} },
  { id: HOUSE_ID, name: "House", type: "property", fields: { currentValue: 500000 } },
];

// Records every mutating call the page makes, so P1 can be checked by what
// hit the wire rather than by what the toast said.
const calls = [];

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function apiHandler(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  const method = req.method();
  if (method !== "GET") calls.push(`${method} ${p}`);

  if (p === "/api/auth/config") return json(route, { supabaseUrl: "", supabaseAnonKey: "" });
  if (p === "/api/auth/me") return json(route, { user: { id: "u1", email: "test@example.com" } });
  if (p.startsWith("/api/auth/")) return json(route, { ok: true });

  if (p === "/api/dashboard-enhanced") return json(route, { financeSnapshot: FINANCE_SNAPSHOT });
  if (p === "/api/dashboard-bootstrap") return json(route, {});
  if (p === "/api/profiles") return json(route, PROFILES);
  if (p === "/api/goals") return json(route, [WEIGHT_GOAL]);
  if (p === "/api/obligations") return json(route, BILLS.map(b => ({ ...b, frequency: "monthly", kind: "bill" })));
  if (p.endsWith("/pay")) return json(route, { id: "pay-1" }, 201);
  if (p.endsWith("/last-payment")) return json(route, { ok: true });
  if (p === "/api/stats") return json(route, {});
  if (p === "/api/expenses" || p === "/api/incomes" || p === "/api/cashflow") return json(route, []);
  if (p === "/api/budgets") return json(route, { budgets: [] });
  if (p === "/api/net-worth/history") return json(route, []);
  return json(route, []);
}

// ── Checks ───────────────────────────────────────────────────────────────────

const results = [];
function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  [${id}] ${name}${detail ? `\n         ${detail}` : ""}`);
}

const BASE = `http://127.0.0.1:${PORT}`;

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  await ctx.route("**/api/**", apiHandler);
  await ctx.addInitScript(() => {
    // A far-future unsigned JWT: the client only decodes it for sub/email/exp.
    const b64 = (o) => btoa(JSON.stringify(o)).replace(/=/g, "");
    const jwt = `${b64({ alg: "none" })}.${b64({ sub: "u1", email: "test@example.com", exp: 4102444800 })}.x`;
    localStorage.setItem("portol_session", JSON.stringify({
      access_token: jwt, refresh_token: "r", expires_at: 4102444800,
    }));
    localStorage.setItem("portol_show_test_data", "0");
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));
  return page;
}

async function gotoFinance(page) {
  await page.goto(`${BASE}/#/dashboard/finance`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="money-overview"]', { timeout: 45000 });
}

async function run() {
  const browser = await chromium.launch(
    CHROME ? { executablePath: CHROME } : {},
  );

  // ── D1 + D2 + Tier 5: the Finance balance sheet ──────────────────────────
  {
    const page = await newPage(browser);
    await gotoFinance(page);

    const houseRow = await page.textContent(`[data-testid="money-asset-${HOUSE_ID}"]`);
    check("D1a", "House row states the share it is showing",
      /your 50% of \$500,000/.test(houseRow || ""),
      `row text: ${JSON.stringify((houseRow || "").trim())}`);

    const mortRow = await page.textContent(`[data-testid="money-liability-${MORTGAGE_ID}"]`);
    check("D1b", "Partially-owned liability labelled too",
      /your 50% of \$348,889/.test(mortRow || ""),
      `row text: ${JSON.stringify((mortRow || "").trim())}`);

    const f150 = await page.textContent('[data-testid="money-asset-p-f150"]');
    check("D1c", "Wholly-owned row stays unlabelled",
      !/your \d+% of/.test(f150 || ""), `row text: ${JSON.stringify((f150 || "").trim())}`);

    // D2: header total must be accounted for by rows + remainder.
    const liabCard = await page.textContent('[data-testid="money-liabilities"]');
    const remainder = await page.textContent('[data-testid="money-liabilities-remainder"]');
    check("D2a", "Truncated rows are summarised, not silently dropped",
      /\+2 more items/.test(remainder || "") && /\$223/.test(remainder || ""),
      `remainder: ${JSON.stringify((remainder || "").trim())}`);

    // The audit's arithmetic: sum what's on screen, compare to the header.
    const reconcile = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="money-liabilities"]');
      const cash = (el) => {
        const m = [...(el?.textContent || "").matchAll(/\$([\d,]+)/g)].pop();
        return m ? Number(m[1].replace(/,/g, "")) : 0;
      };
      const rows = [...card.querySelectorAll('[data-testid^="money-liability-"]')]
        .filter(el => !el.dataset.testid.includes("share"));
      const rem = card.querySelector('[data-testid="money-liabilities-remainder"]');
      return {
        header: cash(card.querySelector('[data-testid="money-liabilities-total"]')),
        visible: rows.reduce((s, el) => s + cash(el), 0) + cash(rem),
        count: Number((card.querySelector('[data-testid="money-liabilities-count"]')?.textContent || "").match(/\d+/)?.[0] || 0),
        rendered: rows.length + (rem ? 1 : 0),
      };
    });
    check("D2b", "Header equals the sum of everything visible",
      reconcile.header === reconcile.visible,
      `header $${reconcile.header} vs visible $${reconcile.visible}`);
    check("D2d", "Card states the true item count, not the number of rows drawn",
      reconcile.count === LIABILITY_BREAKDOWN.length && reconcile.rendered === 9,
      `count says ${reconcile.count}, ${reconcile.rendered} elements drawn, ${LIABILITY_BREAKDOWN.length} liabilities exist`);

    // Tier 5: the QA row must be gone from BOTH the list and the total.
    const qaVisible = await page.locator(`[data-testid="money-asset-${QA_ASSET_ID}"]`).count();
    const assetsHeader = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="money-assets-total"]');
      return Number((el.textContent.match(/\$([\d,]+)/) || [0, "0"])[1].replace(/,/g, ""));
    });
    check("T5a", "Synthetic QA asset hidden from the list", qaVisible === 0);
    check("T5b", "…and excluded from the headline total",
      assetsHeader === 268500,
      `assets header $${assetsHeader}; server total incl. QA was $${FINANCE_SNAPSHOT.totalAssetValue}`);

    // The hub KPI strip sits directly above this card. Two net-worth figures
    // on one screen must be the same figure.
    const agree = await page.evaluate(() => {
      const cash = (el) => {
        const m = [...(el?.textContent || "").matchAll(/([\d,]+)/g)].pop();
        return m ? Number(m[1].replace(/,/g, "")) : null;
      };
      return {
        strip: cash(document.querySelector('[data-testid="hub-kpi-networth"]')),
        card: cash(document.querySelector('[data-testid="money-networth"]')),
      };
    });
    check("T5c", "Hub strip and Finance card report the SAME net worth",
      agree.strip != null && agree.strip === agree.card,
      `hub strip ${agree.strip} vs finance card ${agree.card}`);

    await page.screenshot({ path: shot("finance"), fullPage: false });
    await page.context().close();
  }

  // ── D3: the dashboard Overdue section ────────────────────────────────────
  {
    const page = await newPage(browser);
    await page.goto(`${BASE}/#/dashboard`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="brief-overdue"]', { timeout: 45000 });
    await page.waitForTimeout(1500);
    const section = await page.textContent('[data-testid="brief-overdue"]');
    check("D3a", "Overdue section does not claim all-clear over overdue bills",
      !/Nothing overdue/.test(section || ""),
      `section: ${JSON.stringify((section || "").trim().slice(0, 160))}`);
    const rentRow = await page.locator('[data-testid="brief-overdue-bill-b-rent"]').count();
    check("D3b", "…and names the overdue rent so the card is actionable", rentRow > 0);
    await page.screenshot({ path: shot("dashboard") });
    await page.context().close();
  }

  // ── P1: recording a payment is labelled honestly and is undoable ─────────
  {
    const page = await newPage(browser);
    await gotoFinance(page);

    const btn = page.locator('[data-testid="money-pay-b-rent"]');
    const label = (await btn.textContent() || "").trim();
    check("P1a", 'Button says "Mark paid", not "Pay"', label === "Mark paid", `label: ${JSON.stringify(label)}`);

    calls.length = 0;
    await btn.click();
    await page.waitForTimeout(1200);

    const undo = page.locator('[data-testid="undo-pay-b-rent"]');
    const undoVisible = await undo.count();
    check("P1b", "Success toast offers a reachable Undo", undoVisible > 0,
      `calls after click: ${JSON.stringify(calls)}`);

    if (undoVisible > 0) {
      // The undo window must outlive the old 4s auto-dismiss.
      await page.waitForTimeout(5000);
      const stillThere = await page.locator('[data-testid="undo-pay-b-rent"]').count();
      check("P1c", "Undo still reachable after 5s (old toast died at 4s)", stillThere > 0);

      await page.locator('[data-testid="undo-pay-b-rent"]').first().click();
      await page.waitForTimeout(800);
      check("P1d", "Undo actually deletes the payment server-side",
        calls.some(c => c.startsWith("DELETE") && c.endsWith("/last-payment")),
        `calls: ${JSON.stringify(calls)}`);
    }
    await page.context().close();
  }

  // ── P3: assets/documents are real routes with their own titles ───────────
  {
    const page = await newPage(browser);
    for (const [route, expect] of [["/#/assets", "Assets"], ["/#/documents", "Documents"]]) {
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3500);
      const body = await page.textContent("body");
      const title = await page.title();
      check(`P3-${expect}`, `${route} loads and is titled "${expect}"`,
        !/Page not found/i.test(body || "") && title.startsWith(expect),
        `title: ${JSON.stringify(title)}; notFound: ${/Page not found/i.test(body || "")}`);
    }
    // The old query form must still work.
    await page.goto(`${BASE}/#/linked?tab=documents`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    check("P3-alias", "Old /linked?tab=documents still resolves and is titled Documents",
      (await page.title()).startsWith("Documents"), `title: ${JSON.stringify(await page.title())}`);
    await page.context().close();
  }

  // ── U3: the weight goal ──────────────────────────────────────────────────
  {
    const page = await newPage(browser);
    await page.goto(`${BASE}/#/goals`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="page-goals"]', { timeout: 45000 });
    await page.waitForTimeout(2500);
    const body = await page.textContent("body");

    check("U3a", "Goal no longer claims the target is reached",
      !/Target reached/i.test(body || ""));
    check("U3b", "No 106% (or any >100%) progress on screen",
      !/\b1[0-9][0-9]%/.test(body || ""),
      `matches: ${JSON.stringify((body || "").match(/\b\d+%/g) || [])}`);

    // D2 (Goals half): the Overdue tile must not read 0 while the goal is late.
    const tiles = await page.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll("div")) {
        const t = el.textContent || "";
        const m = t.match(/^(\d+)(Active|At risk|Overdue|Done)$/);
        if (m) out[m[2]] = Number(m[1]);
      }
      return out;
    });
    check("D2c", "Overdue tile counts the late weight goal",
      tiles.Overdue === 1 && tiles.Done === 0,
      `tiles: ${JSON.stringify(tiles)}`);

    await page.screenshot({ path: shot("goals") });
    await page.context().close();
  }

  await browser.close();

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED: " + failed.map(f => f.id).join(", "));
    process.exitCode = 1;
  }
}

server.listen(PORT, async () => {
  try { await run(); } catch (e) { console.error("harness error:", e); process.exitCode = 1; }
  server.close();
});
