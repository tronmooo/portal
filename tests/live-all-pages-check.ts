// Live check (production, smoke account, real browser): EVERY screen opens,
// on a desktop and on a phone with touch.
//
// The workflow matrix (docs/WORKFLOW_MATRIX.md, 2026-11-24) found 15 of the
// app's 29 pages opened by no browser check, and 18 by none on a phone. This
// opens each one the way a person does (signed in, by its link) and holds it
// to what every page owes:
//   · it renders its own content: not the error screen, not "Page not found",
//     not a blank page
//   · no script error, no request answered 5xx
//   · opening it writes nothing (Rule 3)
//   · on a phone nothing is wider than the screen
//   · it is usable within the route budget (docs/PERFORMANCE_QA_CHECKLIST.md)
//
// The pages themselves are only opened. A page that shows ONE record needs
// one to exist, so what the smoke account lacks is created first (an account,
// a document, a saved document) and removed afterwards, under the gate lock.
//   npx tsx tests/live-all-pages-check.ts            (both)
//   MODE=phone npx tsx tests/live-all-pages-check.ts
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { list } from "./helpers/live-workflow";

// A 1×1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const req = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const t = (id: string) => `[data-testid="${id}"]`;
const SHOTS = process.env.SHOT_DIR || "";
const MODE = process.env.MODE || "both";

/** Data settled within this (R3: 1.5 s, heavy screens; measured from the link, on a cloud browser). */
const SETTLE_BUDGET_MS = 4000;
/** A background request a page may make on open that is not the user's data being written. */
const NOT_A_WRITE = [
  /^POST \/api\/client-errors$/, /^POST \/api\/auth\//, /^POST \/api\/audit-log$/,
  // Reads sent as POST (the server's READONLY_POST_PATHS).
  /^POST \/api\/chat\/(suggest|status)/, /^POST \/api\/workspace\//,
  // Opening an asset asks for a current estimate (P2: by design, once a day).
  /^POST \/api\/profiles\/[^/]+\/valuation\/refresh$/, /^POST \/api\/valuations\//,
];

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

async function firstId(path: string, pick: (row: any) => boolean = () => true): Promise<string | null> {
  const r = await api("GET", path);
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return list(r.data).find(pick)?.id ?? null;
}

async function run(browser: any, mode: "desktop" | "phone", routes: Array<{ path: string; name: string }>) {
  const phone = mode === "phone";
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: SHOTS ? 2 : 1, timezoneId: "America/Los_Angeles" }
    : { viewport: { width: 1400, height: 950 }, deviceScaleFactor: SHOTS ? 2 : 1, timezoneId: "America/Los_Angeles" });
  const page = await ctx.newPage();
  await page.addInitScript("window.__name = (f) => f;");

  let errors: string[] = [];
  let bad: string[] = [];
  let writes: string[] = [];
  // API requests in flight. A Set, emptied on each navigation: a request the
  // navigation cancels reports nothing, and a counter would never reach zero.
  const pending = new Set<any>();
  let lastActivity = Date.now();
  // An asset's estimate is ~40 s of research that runs behind the page (P2); the page does not wait for it.
  // The same for an Overview's refined layout: the page draws from the stored fields and swaps the layout in.
  const BACKGROUND = /\/valuation\/refresh$|^\/api\/valuations\/|\/overview\?layout=wait$/;
  const isApi = (r: any) => { const u = new URL(r.url()); return u.pathname.startsWith("/api/") && !BACKGROUND.test(u.pathname + u.search); };
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  page.on("request", (r: any) => {
    if (!isApi(r)) return;
    pending.add(r); lastActivity = Date.now();
    const line = `${r.method()} ${new URL(r.url()).pathname}`;
    if (r.method() !== "GET" && !NOT_A_WRITE.some((re) => re.test(line))) writes.push(line);
  });
  // How long each request of the page being opened took, to name what a slow page waited for.
  const began = new Map<any, number>();
  let took: Array<{ what: string; ms: number }> = [];
  page.on("request", (r: any) => { if (isApi(r)) began.set(r, Date.now()); });
  const done = (r: any) => {
    if (pending.delete(r)) lastActivity = Date.now();
    const b = began.get(r);
    if (b) { took.push({ what: `${r.method()} ${new URL(r.url()).pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}`, ms: Date.now() - b }); began.delete(r); }
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("response", (r: any) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") && r.status() >= 500) bad.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
  });
  /** No API request in flight, and none for 400 ms. Answers what was still open at the cap. */
  const settle = async (capMs = 12000): Promise<string[]> => {
    const t0 = Date.now();
    while (Date.now() - t0 < capMs) {
      if (pending.size === 0 && Date.now() - lastActivity > 400) return [];
      await page.waitForTimeout(100);
    }
    return [...pending].map((r) => `${r.method()} ${new URL(r.url()).pathname}`);
  };

  const press = (sel: string) => (phone ? page.tap(sel) : page.click(sel));
  await page.goto(UI_BASE);
  const email = page.locator(t("input-signin-email"));
  if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
    const start = page.getByRole("button", { name: /sign in|log in|get started/i }).first();
    await (phone ? start.tap({ timeout: 15000 }) : start.click({ timeout: 15000 })).catch(() => undefined);
    await (phone ? page.locator(t("tab-signin")).tap({ timeout: 5000 }) : page.locator(t("tab-signin")).click({ timeout: 5000 })).catch(() => undefined);
  }
  await email.waitFor({ timeout: 30000 });
  await email.fill(LIVE_EMAIL);
  await page.fill(t("input-signin-password"), LIVE_PASSWORD);
  // What the first screen asks for, with its scope (lib/scope-ready.ts).
  const firstLoads: string[] = [];
  const recordFirst = (r: any) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/")) firstLoads.push(u.pathname + u.search); };
  page.on("request", recordFirst);
  const tSign = Date.now();
  await press(t("button-signin"));
  await page.waitForSelector(t("page-dashboard"), { timeout: 30000 });
  const shownMs = Date.now() - tSign;
  await settle();
  page.off("request", recordFirst);
  check(true, `[${mode}] sign in → the dashboard, on screen in ${shownMs}ms`);
  // A fresh browser has no saved scope. The app settles on the user's own
  // profile, and must do so BEFORE loading the dashboard — not load it for
  // Everyone first and again for the person (2026-11-24: 30 requests, ~6 s).
  const savedScope = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.startsWith("portol_profile_filter_v5:"));
    return k ? JSON.parse(localStorage.getItem(k) || "null") : null;
  });
  const LISTS = /^\/api\/(tasks|stats|incomes|trackers|habits|dashboard-enhanced|dashboard-bootstrap)(\?|$)/;
  const unscoped = firstLoads.filter((u) => LISTS.test(u) && !u.includes("profileIds="));
  if (savedScope?.mode === "selected") {
    check(unscoped.length === 0, `[${mode}] the first screen loads its lists once, for the person it shows (unscoped loads: ${unscoped.join(", ") || "none"})`);
  } else {
    console.log(`NOTE  [${mode}] the account opened on ${JSON.stringify(savedScope?.mode)}; the load-once check needs a profile of its own`);
  }

  const slow: string[] = [];
  for (const r of routes) {
    errors = []; bad = []; writes = []; took = [];
    const t0 = Date.now();
    pending.clear();
    await page.goto(`${UI_BASE}/#${r.path}`);
    lastActivity = Date.now();
    const stillOpen = await settle();
    const ms = Date.now() - t0 - 400; // the quiet window itself is not load time
    const state = await page.evaluate(() => {
      // A workspace is mounted on <body>, outside <main> (W1), so read the whole page.
      const text = document.body.innerText || "";
      const wide = [...document.querySelectorAll("body *")].find((el) => {
        const b = (el as HTMLElement).getBoundingClientRect();
        if (b.width === 0 || b.right <= window.innerWidth + 1) return false;
        // Something inside a sideways scroller is that scroller's business.
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return false;
        }
        return true;
      }) as HTMLElement | undefined;
      return {
        chars: text.trim().length,
        crashed: /Something went wrong/.test(text),
        notFound: /Page not found/.test(text),
        scrollWidth: document.documentElement.scrollWidth,
        width: window.innerWidth,
        wide: wide ? `<${wide.tagName.toLowerCase()} ${wide.getAttribute("data-testid") || String(wide.className).slice(0, 50)}>` : "",
        hash: location.hash,
      };
    });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${mode}-${r.name.replace(/[^a-z0-9]+/gi, "-")}.png` });
    const where = `[${mode}] ${r.name} (${r.path})`;
    const problems: string[] = [];
    if (state.crashed) problems.push("shows the error screen");
    if (state.notFound) problems.push("shows Page not found");
    if (state.chars < 40) problems.push(`is nearly blank (${state.chars} characters)`);
    if (errors.length) problems.push(`script error: ${errors[0]}`);
    if (stillOpen.length) problems.push(`still loading after 12 s: ${[...new Set(stillOpen)].join(", ")}`);
    if (bad.length) problems.push(`server error: ${[...new Set(bad)].join(", ")}`);
    if (writes.length) problems.push(`wrote on open: ${[...new Set(writes)].join(", ")}`);
    if (phone && (state.scrollWidth > state.width + 1 || state.wide)) problems.push(`wider than the screen (${state.scrollWidth}px of ${state.width}px${state.wide ? `, ${state.wide}` : ""})`);
    check(problems.length === 0, `${where} opens clean in ${ms}ms${problems.length ? ` — ${problems.join("; ")}` : ""}`);
    if (ms > SETTLE_BUDGET_MS) {
      const worst = [...took].sort((a, b) => b.ms - a.ms).slice(0, 2).map((x) => `${x.what} ${x.ms}ms`).join(", ");
      slow.push(`${r.name} ${ms}ms (slowest: ${worst || "nothing finished"})`);
    }
  }
  console.log(slow.length ? `SLOW  [${mode}] over ${SETTLE_BUDGET_MS}ms to settle: ${slow.join("; ")}` : `[${mode}] every page settled within ${SETTLE_BUDGET_MS}ms`);
  await ctx.close();
}

(async () => {
  const version = await (await fetch(`${UI_BASE}/api/version`)).json();
  console.log(`production is serving ${String(version.sha).slice(0, 7)}`);

  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-all-pages-check" });
  const undo: Array<() => Promise<unknown>> = [];
  try {
  // One real record of each kind, for the pages that show one.
  const kind = (types: string[]) => (p: any) => types.includes(p.type);
  const ensure = async (found: string | null, name: string, make: () => Promise<{ ok: boolean; status: number; data: any }>, remove: (id: string) => Promise<unknown>) => {
    if (found) return found;
    const made = await make();
    const id = made.data?.id ?? null;
    if (!made.ok || !id) { console.log(`SKIP  ${name}: could not create one (${made.status})`); return null; }
    undo.push(() => remove(id));
    return id as string;
  };
  const person = await firstId("/profiles", kind(["self", "person"]));
  const asset = await firstId("/profiles", kind(["asset", "vehicle", "property"]));
  const liability = await firstId("/profiles", kind(["liability", "loan"]));
  const account = await ensure(await firstId("/profiles", kind(["account"])), "An account",
    () => api("POST", "/accounts", { name: "Page Check Checking", accountKind: "checking", balance: 100 }), (id) => api("DELETE", `/accounts/${id}`));
  const document = await ensure(await firstId("/documents"), "A document",
    () => api("POST", "/documents", { name: "Page Check Receipt", type: "receipt", mimeType: "image/png", fileData: PNG }), (id) => api("POST", `/documents/${id}/purge`));
  const artifact = await ensure(await firstId("/artifacts", (a) => a.type === "doc"), "A saved document",
    () => api("POST", "/artifacts", { type: "doc", title: "Page Check Document", content: "<p>Opened by the page check.</p>" }), (id) => api("DELETE", `/artifacts/${id}`));
  const routes: Array<{ path: string; name: string }> = [
    { path: "/dashboard", name: "Dashboard" }, { path: "/dashboard/executive", name: "Dashboard · Executive" },
    { path: "/dashboard/daily", name: "Dashboard · Daily" }, { path: "/chat", name: "Chat" },
    { path: "/trackers", name: "Trackers" }, { path: "/linked", name: "Assets" }, { path: "/liabilities", name: "Liabilities" },
    { path: "/profiles", name: "Info" }, { path: "/profiles/list", name: "Profiles list" },
    { path: "/calendar", name: "Calendar" }, { path: "/tasks", name: "Tasks" }, { path: "/finance", name: "Finance" },
    { path: "/habits", name: "Habits" }, { path: "/journal", name: "Journal" }, { path: "/obligations", name: "Bills" },
    { path: "/goals", name: "Goals" }, { path: "/wellness", name: "Wellness" }, { path: "/insights", name: "Insights" },
    { path: "/artifacts", name: "Artifacts" }, { path: "/details", name: "Details" }, { path: "/settings", name: "Settings" },
    { path: "/workspace/notes", name: "Notes workspace" }, { path: "/workspace/journal", name: "Journal workspace" },
    { path: "/workspace/fill", name: "Fill In workspace" }, { path: "/editor/new/doc", name: "New document" },
    { path: "/privacy", name: "Privacy" }, { path: "/terms", name: "Terms" },
  ];
  const record = (id: string | null, path: (id: string) => string, name: string) => {
    if (id) routes.push({ path: path(id), name });
    else { console.log(`FAIL  ${name}: no record to open it with`); failed = true; }
  };
  record(person, (id) => `/profiles/${id}/info`, "A person's Info");
  record(asset, (id) => `/profiles/${id}`, "An asset");
  record(liability, (id) => `/profiles/${id}`, "A liability");
  record(account, (id) => `/profiles/${id}`, "An account");
  record(document, (id) => `/documents/${id}`, "A document");
  record(document, (id) => `/documents/${id}/review`, "A document's review");
  record(artifact, (id) => `/editor/${id}`, "A saved document in the editor");

  const browser = await chromium.launch();
  try {
    if (MODE !== "phone") await run(browser, "desktop", routes);
    if (MODE !== "desktop") await run(browser, "phone", routes);
  } finally {
    await browser.close();
  }
  } finally {
    for (const u of undo.reverse()) await u().catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nFAILED" : "\nALL PASS");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
