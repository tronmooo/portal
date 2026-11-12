// Live check (production, smoke account): a date about another person never
// shows the account holder's name. Takes the gate lock (CLAUDE.md), writes
// two events with no owner (so they default to the smoke account's self
// profile — the exact shape of the 2026-11-11 report), reads the real
// Recurring page in a browser, then deletes the events.
//   npx tsx tests/live-dated-owner-check.ts
import { createRequire } from "node:module";
import { api, expectOk } from "./smoke/fixture/api";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

// Playwright is preinstalled in CI/cloud images but not a repo dependency.
const req = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();

const SHOT = process.env.SHOT_DIR || ".";

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-dated-owner-check" });
  const created: string[] = [];
  let failed = false;
  try {
    const self = (expectOk(await api("GET", "/profiles"), "profiles") as any[]).find((p) => p.type === "self");
    if (!self?.name) throw new Error("smoke account has no self profile");
    const d = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    for (const title of ["🎂 Jordan's birthday", "Jordan's dentist appointment"]) {
      const ev: any = expectOk(await api("POST", "/events", {
        title, date: d, allDay: true, recurrence: "yearly", category: "personal",
        linkedProfiles: [], tags: ["rdate", title.includes("birthday") ? "rd:kind:birthday" : "rd:kind:event"],
        source: "manual", __allowDuplicate: true,
      }), `create ${title}`);
      created.push(ev.id);
      console.log(`created "${title}" owners=${JSON.stringify(ev.linkedProfiles)} (self=${self.id})`);
    }

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 430, height: 1400 } });
    await page.goto("https://portol.me");
    const email = page.locator('[data-testid="input-signin-email"]');
    if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
      // The landing page leads to the form.
      await page.getByRole("button", { name: /sign in|log in|get started/i }).first().click({ timeout: 15000 }).catch(() => undefined);
      await page.locator('[data-testid="tab-signin"]').click({ timeout: 5000 }).catch(() => undefined);
    }
    await email.waitFor({ timeout: 30000 });
    await email.fill(LIVE_EMAIL);
    await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
    await page.click('[data-testid="button-signin"]');
    await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });
    await page.goto("https://portol.me/#/calendar");
    await page.click('[data-testid="calendar-tab-recurring"]', { timeout: 20000 });
    for (const id of created) {
      const card = page.locator(`[data-testid="rule-card-event:${id}"]`);
      await card.waitFor({ timeout: 30000 });
      const text = (await card.innerText()).replace(/\s+/g, " ");
      const bad = text.includes(self.name);
      console.log(`${bad ? "FAIL" : "PASS"}  card: ${text}`);
      if (bad) failed = true;
      if (id === created[0]) {
        await card.screenshot({ path: `${SHOT}/live-jordan-birthday-card.png` });
        // The detail panel's Source must not name the account holder either.
        await page.click(`[data-testid="rule-open-event:${id}"]`);
        const src = page.locator('[data-testid="cal-detail-source-link"]');
        await src.waitFor({ timeout: 15000 });
        const s = (await src.innerText()).trim();
        const badSrc = s.includes(self.name);
        console.log(`${badSrc ? "FAIL" : "PASS"}  detail Source: ${s}`);
        if (badSrc) failed = true;
        await page.keyboard.press("Escape");
      }
    }
    await browser.close();
  } finally {
    for (const id of created) await api("DELETE", `/events/${id}`).catch(() => undefined);
    console.log(`cleaned up ${created.length} event(s)`);
    await release();
  }
  if (failed) { console.error("LIVE CHECK FAILED"); process.exit(1); }
  console.log("LIVE CHECK PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
