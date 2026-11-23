// Live check: on a PHONE, with real touch events, a drag on a control never
// navigates away (owner, 2026-11-23: dragging the ownership slider to 100%
// left the asset profile for the Dashboard with the change unsaved).
//
//   npx tsx tests/live-touch-gestures-check.ts
//   (an undeployed client against the deployed API:
//    SMOKE_UI_BASE=http://localhost:5199 LIVE_API_ORIGIN=https://portol.me)
//
// What it proves, in a touch browser as the smoke account:
//   · a co-owner is removed, the remaining share is DRAGGED to 100% in both
//     directions, the page stays, Save stores one owner at 100%
//   · on every main screen, a fast sideways drag across each slider and each
//     row that scrolls sideways leaves the address where it was
//
// Writes only to the smoke account, under the gate lock, and deletes what it made.
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
const where = (page: any) => page.url().replace(UI_BASE, "");

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

/** A quick finger drag from (x0,y) to (x1,y): ~200 ms, the shape SwipeNav reads as a page swipe. */
async function drag(cdp: any, page: any, x0: number, x1: number, y: number) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / 8, y }] });
    await page.waitForTimeout(25);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(700);
}

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-touch-gestures-check" });
  const ids: string[] = [];
  try {
    const profiles = (await api("GET", "/profiles")).data;
    const self = profiles.find((p: any) => p.type === "self");
    const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
    const joe = (await api("POST", "/profiles", { type: "person", name: `Joe ${tag}`, fields: {} })).data; ids.push(joe.id);
    const asset = (await api("POST", "/profiles", { type: "asset", name: `Touch Car ${tag}`, fields: { purchasePrice: 9000, currentValue: 8000 } })).data; ids.push(asset.id);
    const seeded = await api("PUT", `/profiles/${asset.id}/owners`, { owners: [{ partyProfileId: self.id, ownershipPercentage: 50 }, { partyProfileId: joe.id, ownershipPercentage: 50 }] });
    if (!seeded.ok) throw new Error(`seed owners: ${seeded.status}`);
    const owners = async () => (await api("GET", "/asset-party-links")).data.filter((l: any) => l.assetProfileId === asset.id).map((l: any) => [l.partyProfileId, Number(l.ownershipPercentage)]);

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true, timezoneId: "America/Los_Angeles" });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
    await forwardApi(page);
    const cdp = await ctx.newCDPSession(page);
    try {
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
      await page.waitForSelector(t("page-dashboard"), { timeout: 30000 });

      // ── The owner's steps: remove the co-owner, drag the share to 100%, save ──
      await page.goto(`${UI_BASE}/#/profiles/${asset.id}`);
      await page.locator(t("asset-details")).waitFor({ timeout: 30000 });
      await page.locator(t("button-profile-menu")).tap();
      await page.locator(t("menu-open-ownership")).tap();
      await page.locator(t("card-ownership-editor")).waitFor({ timeout: 20000 });
      const home = where(page);
      await page.locator(t(`owner-remove-${joe.id}`)).tap();
      const slider = page.locator(t(`owner-slider-${self.id}`));
      await slider.scrollIntoViewIfNeeded();
      let box = await slider.boundingBox();
      const y = () => box.y + box.height / 2;
      await drag(cdp, page, box.x + box.width * 0.9, box.x + 4, y());                 // left, on the track
      check(where(page) === home, `dragging the share slider LEFT stays on the profile (${where(page)})`);
      box = await slider.boundingBox();
      await drag(cdp, page, box.x + 6, box.x + box.width + 30, y());                   // right, past the end
      check(where(page) === home, `dragging the share slider RIGHT to 100% stays on the profile (${where(page)})`);
      check((await page.locator(t(`owner-input-${self.id}`)).inputValue()) === "100", `the drag set the share to 100% (${await page.locator(t(`owner-input-${self.id}`)).inputValue()})`);
      check((await owners()).length === 2, "dragging alone stores nothing");
      await page.locator(t("owner-save")).tap();
      let stored = await owners();
      for (let i = 0; i < 15 && stored.length !== 1; i++) { await page.waitForTimeout(700); stored = await owners(); }
      check(stored.length === 1 && stored[0][0] === self.id && stored[0][1] === 100, `Save stored one owner at 100% (${JSON.stringify(stored.map((o: any) => o[1]))})`);
      await page.waitForTimeout(2500);
      check(where(page) === home && (await page.locator(t("card-ownership-editor")).count()) === 1, `after saving, the page is still the profile (${where(page)})`);

      // ── Every main screen: a sideways drag on a slider or a scrolling row stays put ──
      const screens = ["/dashboard", "/dashboard/executive", "/linked", "/linked?tab=liabilities", "/trackers", "/finance", "/calendar", "/tasks", "/artifacts", `/profiles/${asset.id}`, `/profiles/${asset.id}/financials`];
      for (const path of screens) {
        await page.goto(`${UI_BASE}/#${path}`);
        await page.waitForTimeout(2500);
        const start = where(page);
        const targets: Array<{ x: number; y: number; w: number; what: string }> = await page.evaluate(() => {
          const out: Array<{ x: number; y: number; w: number; what: string }> = [];
          const main = document.getElementById("main-content");
          if (!main) return out;
          for (const el of Array.from(main.querySelectorAll<HTMLElement>("*"))) {
            const r = el.getBoundingClientRect();
            if (r.width < 120 || r.height < 8 || r.top < 60 || r.bottom > window.innerHeight - 90) continue;
            const slider = el.getAttribute("role") === "slider" || el.hasAttribute("data-swipe-ignore");
            const ox = getComputedStyle(el).overflowX;
            const scrolls = (ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1;
            if (slider || scrolls) out.push({ x: r.left, y: r.top + Math.min(r.height / 2, 20), w: r.width, what: `${slider ? "slider" : "scrolling row"} ${el.getAttribute("data-testid") || el.className.toString().slice(0, 40)}` });
          }
          return out.slice(0, 6);
        });
        let moved = "";
        for (const g of targets) {
          for (const dir of [-1, 1]) {
            const a = g.x + g.w * (dir < 0 ? 0.85 : 0.15), b = g.x + g.w * (dir < 0 ? 0.15 : 0.85);
            await drag(cdp, page, a, b, g.y);
            if (where(page) !== start) { moved = `${g.what} dragged ${dir < 0 ? "left" : "right"} → ${where(page)}`; break; }
          }
          if (moved) break;
        }
        check(!moved, `${path}: ${targets.length} sideways control(s) dragged, address unchanged${moved ? ` — ${moved}` : ""}`);
      }
      check(errors.length === 0, `no page errors (${errors.slice(0, 2).join(" | ") || "none"})`);
    } finally { await browser.close(); }
  } finally {
    for (const id of ids.reverse()) await api("DELETE", `/profiles/${id}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
