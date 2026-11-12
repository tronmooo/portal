// Live check (production, smoke account): a person's name is data, not
// permission to create a profile (CLAUDE.md rule 13, user spec 2026-11-12).
// Takes the gate lock, talks to the REAL chat, cleans up after itself.
//   npx tsx tests/live-profile-creation-check.ts
//
// Fresh made-up names each run, so "offered once per name" is tested from a
// clean slate and never collides with seeded people.
import { createRequire } from "node:module";
import { api, getSmokeToken, fetchWithRateLimitRetry } from "./smoke/fixture/api";
import { API_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const req = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || ".";

const syll = ["bar", "ven", "tor", "lis", "mar", "dex", "quin", "rol", "zan", "pel"];
const freshName = () => {
  const s = Array.from({ length: 3 }, () => syll[Math.floor(Math.random() * syll.length)]).join("");
  return s[0].toUpperCase() + s.slice(1);
};

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

// The read-your-writes token of the latest chat reply. The app sends it on
// every read after a reply; without it another warm server instance may
// answer from its pre-write cache for ~2s (see 1ddd1cd).
let dataVersion: string | undefined;
async function chat(message: string) {
  const r = await api("POST", "/chat", { message, history: [] });
  if (!r.ok) throw new Error(`chat failed ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  if (typeof (r.data as any)?.dataVersion === "string") dataVersion = (r.data as any).dataVersion;
  return r.data as any;
}
async function readAsApp(path: string): Promise<any[]> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await getSmokeToken()}` };
  if (dataVersion) headers["x-data-version"] = dataVersion;
  const { response } = await fetchWithRateLimitRetry(`${API_BASE}${path}`, { headers });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
  const body: any = await response.json();
  const rows = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : Array.isArray(body?.data) ? body.data : null;
  if (!rows) throw new Error(`unexpected list shape for ${path}: ${JSON.stringify(body).slice(0, 200)}`);
  return rows;
}
const profilesNamed = async (n: string) =>
  (await readAsApp("/profiles")).filter((p) => String(p.name).toLowerCase() === n.toLowerCase());
const eventsAbout = async (n: string) =>
  (await readAsApp("/events")).filter((e) => new RegExp(`\\b${n}\\b`, "i").test(String(e.title)));

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-profile-creation-check" });
  const BOB = freshName(), SARAH = freshName(), PAT = freshName();
  const createdExpenses: string[] = [];
  console.log(`names this run: ${BOB}, ${SARAH}, ${PAT}`);
  try {
    // 1. The reported message.
    const r1 = await chat(`${BOB}'s birthday is September 30. Remind me every year for 10 years.`);
    console.log(`reply: ${String(r1.reply).slice(0, 220)}`);
    check((await profilesNamed(BOB)).length === 0, `no profile created for ${BOB}`);
    const bday = (await eventsAbout(BOB)).filter((e) => /birthday/i.test(e.title));
    check(bday.length === 1, `exactly one birthday event for ${BOB} (got ${bday.length})`);
    check(bday[0]?.recurrence === "yearly", `birthday repeats yearly (got ${bday[0]?.recurrence})`);
    check(!!bday[0]?.recurrenceEnd && Number(String(bday[0].recurrenceEnd).slice(0, 4)) >= new Date().getFullYear() + 9,
      `birthday runs ~10 years (ends ${bday[0]?.recurrenceEnd})`);
    const offers1: any[] = Array.isArray(r1.profileSuggestions) ? r1.profileSuggestions : [];
    check(offers1.some((s) => s.name.toLowerCase() === BOB.toLowerCase()), `reply offers a profile for ${BOB} (${JSON.stringify(offers1)})`);

    // 2. Mentioned again: not offered again, still no profile.
    const r2 = await chat(`Remind me to buy ${BOB} a gift tomorrow at 5 PM`);
    const offers2: any[] = Array.isArray(r2.profileSuggestions) ? r2.profileSuggestions : [];
    check(!offers2.some((s) => s.name.toLowerCase() === BOB.toLowerCase()), `${BOB} is not offered a second time`);
    check((await profilesNamed(BOB)).length === 0, `still no profile for ${BOB}`);

    // 3. Gift expense: saved, Sarah gets no profile.
    const r3 = await chat(`I bought ${SARAH} a $50 gift`);
    const exp = (r3.actions || []).find((a: any) => /expense/.test(String(a.type)) && Number(a.data?.amount) === 50);
    check(!!exp?.data?._entityId, `the $50 gift expense was saved (${String(r3.reply).slice(0, 80)})`);
    if (exp?.data?._entityId) createdExpenses.push(exp.data._entityId);
    check((await profilesNamed(SARAH)).length === 0, `no profile created for ${SARAH}`);

    // 4. Yes: an explicit request creates the profile and picks up the birthday.
    const r4 = await chat(`Create a person profile for ${BOB}`); // the Yes button's exact text
    console.log(`reply: ${String(r4.reply).slice(0, 160)}`);
    const bob = await profilesNamed(BOB);
    check(bob.length === 1, `"Create a profile for ${BOB}" created exactly one profile`);
    const bday2 = (await eventsAbout(BOB)).filter((e) => /birthday/i.test(e.title));
    check(bday2.length === 1 && (bday2[0].linkedProfiles || []).includes(bob[0]?.id),
      `the existing birthday now belongs to ${BOB}'s profile, not copied (${bday2.length} event(s))`);

    // 5. The real chat page: the optional card, and No writes nothing.
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 430, height: 1100 } });
    await page.goto("https://portol.me");
    const email = page.locator('[data-testid="input-signin-email"]');
    if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
      await page.getByRole("button", { name: /sign in|log in|get started/i }).first().click({ timeout: 15000 }).catch(() => undefined);
      await page.locator('[data-testid="tab-signin"]').click({ timeout: 5000 }).catch(() => undefined);
    }
    await email.waitFor({ timeout: 30000 });
    await email.fill(LIVE_EMAIL);
    await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
    await page.click('[data-testid="button-signin"]');
    await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });
    await page.goto("https://portol.me/#/chat");
    const input = page.locator('[data-testid="input-chat"]');
    await input.waitFor({ timeout: 30000 });
    await input.fill(`${PAT}'s birthday is October 2`);
    await page.click('[data-testid="button-send"]');
    const card = page.locator(`[data-testid="profile-suggestion-${PAT}"]`);
    const shown = await card.waitFor({ timeout: 90000 }).then(() => true).catch(() => false);
    check(shown, `chat shows "Would you also like to create a profile for ${PAT}?"`);
    if (!shown) {
      await page.screenshot({ path: `${SHOT}/live-profile-offer-missing.png` });
      console.log(`page text: ${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(-700)}`);
    }
    if (shown) {
      await page.screenshot({ path: `${SHOT}/live-profile-offer.png` });
      console.log(`card: ${(await card.innerText()).replace(/\s+/g, " ")}`);
      await card.locator('[data-testid="profile-suggestion-no"]').click();
      check(await card.isHidden({ timeout: 5000 }).catch(() => false), `No closes the card`);
    }
    await browser.close();
    check((await profilesNamed(PAT)).length === 0, `No left ${PAT} without a profile`);
    check((await eventsAbout(PAT)).some((e) => /birthday/i.test(e.title)), `${PAT}'s birthday was still saved`);
  } finally {
    for (const id of createdExpenses) await api("DELETE", `/expenses/${id}`).catch(() => undefined);
    for (const n of [BOB, SARAH, PAT]) {
      for (const e of await eventsAbout(n).catch(() => [])) await api("DELETE", `/events/${e.id}`).catch(() => undefined);
      const tasks = (await api("GET", "/tasks").catch(() => ({ data: [] } as any))).data || [];
      for (const t of tasks.filter((t: any) => new RegExp(`\\b${n}\\b`, "i").test(String(t.title)))) await api("DELETE", `/tasks/${t.id}`).catch(() => undefined);
      const exps = (await api("GET", "/expenses").catch(() => ({ data: [] } as any))).data || [];
      for (const x of exps.filter((x: any) => new RegExp(`\\b${n}\\b`, "i").test(String(x.description || x.name || "")))) await api("DELETE", `/expenses/${x.id}`).catch(() => undefined);
      for (const p of await profilesNamed(n).catch(() => [])) await api("DELETE", `/profiles/${p.id}`).catch(() => undefined);
    }
    console.log("cleaned up");
    await release();
  }
  if (failed) { console.error("LIVE CHECK FAILED"); process.exit(1); }
  console.log("LIVE CHECK PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
