// Live check (deployed app, smoke account, read-only): every page scrolls to
// its bottom and straight back to the top, on a phone and a desktop, across two
// navigation passes; nothing overlays the page scroller at the bottom; a
// refetch does not swap the scroller; closing a dialog/menu restores scrolling.
//   npx tsx tests/live-scroll-check.ts            (mobile, iPhone 13 touch)
//   npx tsx tests/live-scroll-check.ts desktop    (mouse wheel)
// History: 2026-11-21, iPhone "scroll to the bottom and it won't scroll back
// up" — see client/src/index.css (iOS scroll chaining) and
// client/src/components/PullToRefresh.tsx.
import { createRequire } from "module";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

// Same loader as the other live UI checks: the project's playwright, else the
// one preinstalled with the browser.
const req = createRequire(import.meta.url);
const { chromium, devices } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const ROUTES = ["/dashboard", "/trackers", "/dashboard/finance", "/wellness", "/linked?tab=assets", "/linked?tab=liabilities", "/dashboard/documents", "/calendar", "/artifacts", "/dashboard/tasks", "/chat", "/dashboard/habits", "/dashboard/journal", "/insights", "/settings"];
const MODE = process.argv[2] || "mobile";
const PRIMARY = `(() => {
  const main = document.getElementById("main-content");
  const isV = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY);
  const all = [...main.querySelectorAll("*")].filter(isV);
  const top = all.filter(el => { let p = el.parentElement; while (p && p !== main) { if (isV(p)) return false; p = p.parentElement; } return true; });
  const el = top.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
  window.__ps = el || null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { tid: el.dataset.testid || el.className.slice(0, 40), st: el.scrollTop, max: el.scrollHeight - el.clientHeight, x: r.left + r.width / 2, top: r.top, bottom: Math.min(r.bottom, innerHeight - 90), count: top.length };
})()`;
const ST = `(window.__ps ? window.__ps.scrollTop : -1)`;
const HIT = `(() => { const el = window.__ps; const r = el.getBoundingClientRect(); const bad = []; for (let i = 1; i < 6; i++) for (let j = 1; j < 5; j++) { const x = r.left + r.width * j / 5, y = r.top + (Math.min(r.bottom, innerHeight - 90) - r.top) * i / 6; const h = document.elementFromPoint(x, y); if (!h || !el.contains(h)) bad.push(Math.round(x) + "," + Math.round(y) + "→" + (h ? h.tagName + "." + String(h.className).slice(0, 40) : "null")); } return bad; })()`;
const TA = `(() => { const bad = new Set(); window.__ps.querySelectorAll("*").forEach(e => { const t = getComputedStyle(e).touchAction; if (t !== "auto" && t !== "manipulation" && !t.includes("pan-y")) bad.add(e.tagName + ":" + t + ":" + String(e.className).slice(0, 40)); }); return [...bad].slice(0, 5); })()`;
const BODY = `(() => ({ pe: document.body.style.pointerEvents, locked: document.body.hasAttribute("data-scroll-locked"), ov: document.body.style.overflow, dialogs: document.querySelectorAll("[role=dialog],[role=menu],[data-radix-popper-content-wrapper]").length }))()`;
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(MODE === "mobile" ? { ...devices["iPhone 13"] } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));
  await page.goto("https://portol.me");
  await page.locator('[data-testid="input-signin-email"]').fill(LIVE_EMAIL);
  await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });
  await page.waitForTimeout(2500);
  const cdp = MODE === "mobile" ? await ctx.newCDPSession(page) : null;
  const swipe = async (x: number, y0: number, y1: number) => {
    if (cdp) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
      for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 8 }] }); }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else { await page.mouse.move(x, (y0 + y1) / 2); await page.mouse.wheel(0, y0 - y1); }
    await page.waitForTimeout(120);
  };
  const problems: string[] = [];
  const roundTrip = async (label: string) => {
    const p: any = await page.evaluate(PRIMARY);
    if (!p) { problems.push(`${label}: no vertical scroller`); return; }
    if (p.max <= 2) return `${label}: fits on screen (${p.tid})`;
    const y0 = p.top + 20, y1 = p.bottom - 20, dist = y1 - y0;
    let n = 0; let last = await page.evaluate(ST);
    while (last < p.max - 1 && n < 60) { await swipe(p.x, y1, y0); const now = await page.evaluate(ST); if (now <= last) { problems.push(`${label}: swipe DOWN #${n} did not move (st ${last}/${p.max})`); break; } last = now; n++; }
    const hits = await page.evaluate(HIT);
    if (hits.length) problems.push(`${label}: overlay over scroller at bottom: ${hits.slice(0, 3).join(" | ")}`);
    // reverse immediately
    let m = 0;
    while (last > 0 && m < 60) { await swipe(p.x, y0, y1); const now = await page.evaluate(ST); if (now >= last) { problems.push(`${label}: swipe UP #${m} did not move (st ${last}/${p.max})`); break; } last = now; m++; }
    return `${label}: ${p.tid} ${p.max}px · down ${n} swipes · back up ${m} swipes · top=${last === 0}`;
  };
  const go = async (r: string) => { await page.evaluate((h) => { location.hash = h; }, r); await page.waitForTimeout(2200); };
  for (let pass = 1; pass <= 2; pass++) {
    for (const r of ROUTES) {
      await go(r);
      const res = await roundTrip(`[${MODE} p${pass}] ${r}`);
      if (res) console.log(res);
      if (pass === 1) { const ta = await page.evaluate(TA).catch(() => []); if ((ta as any[]).length) console.log(`   touch-action in ${r}:`, ta); }
      const b: any = await page.evaluate(BODY); if (b.pe || b.locked || b.ov || b.dialogs) problems.push(`${r}: body ${JSON.stringify(b)}`);
    }
  }
  // Re-render while scrolled to bottom: is the scroller swapped / position lost?
  await go("/dashboard");
  const p: any = await page.evaluate(PRIMARY);
  await page.evaluate(`window.__ps.scrollTop = 1e6; window.__ps.__mark = 1;`);
  const before = await page.evaluate(ST);
  await page.evaluate(`(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); })()`);
  await page.waitForTimeout(6000);
  const same = await page.evaluate(`(() => { const p = document.querySelector("[data-testid=page-dashboard]"); return { same: !!(p && p.__mark), st: p ? p.scrollTop : -1 }; })()`);
  console.log(`refetch while at bottom: before st=${before}`, same);
  // Dialogs: open + close, then scrolling must still work
  const dialogs = [["notification bell", '[data-testid="button-notification-bell"]'], ["profile switcher", '[data-testid="hub-profile-switcher"]'], ["search", '[data-testid="button-command-search"], [aria-label*="Search" i]']];
  for (const [name, sel] of dialogs) {
    await go("/dashboard");
    const btn = page.locator(sel).first();
    if (!(await btn.count())) { console.log(`dialog ${name}: trigger not found`); continue; }
    await btn.click(); await page.waitForTimeout(800);
    const open: any = await page.evaluate(BODY);
    await page.keyboard.press("Escape"); await page.waitForTimeout(800);
    const closed: any = await page.evaluate(BODY);
    const res = await roundTrip(`after ${name}`);
    console.log(`dialog ${name}: open ${JSON.stringify(open)} closed ${JSON.stringify(closed)} → ${res}`);
    if (closed.pe || closed.locked || closed.ov) problems.push(`${name}: body not restored ${JSON.stringify(closed)}`);
  }
  console.log("PROBLEMS:", problems.length ? "\n  " + problems.join("\n  ") : "none");
  if (problems.length || errors.length) process.exitCode = 1;
  console.log("page errors:", errors.slice(0, 5));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
