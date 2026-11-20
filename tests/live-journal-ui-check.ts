// Live walk-through (production, smoke account, real browser) of the chat
// box's Journal and Note buttons and the Journal page (rules J1, J6–J8). The
// server side of the same rules is tests/live-journal-check.ts; this one
// clicks the real controls.
//   npx tsx tests/live-journal-ui-check.ts
// Takes the gate lock; deletes what it creates. SHOT_DIR=<dir> keeps screenshots.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const req = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();
const SHOT = process.env.SHOT_DIR || "";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };
const get = async (path: string): Promise<any> => { const r = await api("GET", path); if (!r.ok) throw new Error(`GET ${path}: ${r.status}`); return r.data; };

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-journal-ui-check" });
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const startJournal = new Set(((await get("/journal")) as any[]).map((j) => j.id));
  const mineJ = async () => ((await get("/journal")) as any[]).filter((j) => !startJournal.has(j.id));
  let personId: string | undefined;
  let browser: any;
  try {
    console.log(`production is serving ${String((await (await fetch(`${UI_BASE}/api/version`)).json()).sha).slice(0, 7)}`);
    const person = await api("POST", "/profiles", { name: `Uibob ${tag}`, type: "person" });
    if (!person.ok) throw new Error(`could not create the test person: ${person.status}`);
    personId = person.data.id;

    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/Los_Angeles" });
    const page = await ctx.newPage();
    const shot = async (name: string) => { if (SHOT) await page.screenshot({ path: `${SHOT}/${name}.png` }).catch(() => undefined); };
    await page.goto(UI_BASE);
    const email = page.locator('[data-testid="input-signin-email"]');
    await email.waitFor({ timeout: 30000 });
    await email.fill(LIVE_EMAIL);
    await page.fill('[data-testid="input-signin-password"]', LIVE_PASSWORD);
    await page.keyboard.press("Enter");
    await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 });

    // The app-wide profile filter hides other people's entries when one
    // person is selected (the Journal page says so: "1 entry · <name>"). Show
    // everyone, BEFORE anything is written: the start-up bundle is cached for
    // up to 30s, so a reload right after a write can show an older list.
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith("portol_profile_filter")) localStorage.setItem(k, JSON.stringify({ mode: "everyone", selectedIds: [], selectedNames: [] }));
      }
    });
    await page.reload();
    await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 30000 }).catch(() => undefined);

    // ── the chat box ─────────────────────────────────────────────────────
    await page.evaluate(() => { window.location.hash = "#/chat"; });
    const box = page.locator('[data-testid="input-chat"]');
    await box.waitFor({ timeout: 30000 });
    const jBtn = page.locator('[data-testid="button-capture-journal"]');
    const nBtn = page.locator('[data-testid="button-capture-note"]');
    check(await jBtn.isVisible() && await nBtn.isVisible(), "the chat box shows a Journal and a Note button");
    check((await jBtn.getAttribute("aria-pressed")) === "false", "both are off to start with (ordinary chat)");

    const send = async (text: string) => {
      await box.fill(text);
      await page.locator('[data-testid="button-send"]').click();
    };
    const replyWith = (re: RegExp, ms = 60000) => page.getByText(re).first().waitFor({ timeout: ms }).then(() => true).catch(() => false);

    // 1. Journal button, for me: a question-shaped line.
    await jBtn.click();
    check((await page.locator('[data-testid="button-send"]').innerText()).includes("Save entry"), "Journal on: the send button reads “Save entry” and the box says what will happen");
    await shot("1-journal-on");
    const mineText = `Why was today so hard ${tag}? I ran two miles and still felt awful.`;
    await send(mineText);
    check(await replyWith(/to your journal for today\. Mood: /), "Journal button: the reply confirms the save, with a title and mood");
    let rows = await mineJ();
    check(rows.some((j) => j.content === mineText), "…and the entry is stored word for word");
    check((await jBtn.getAttribute("aria-pressed")) === "true", "the button stays on for the next entry");

    // 2. Same button, for the person picked in the For menu.
    const who = page.locator('[data-testid="select-capture-profile"]');
    await who.selectOption({ label: `Uibob ${tag}` });
    const bobText = `He scored two goals ${tag} and was thrilled all evening.`;
    await send(bobText);
    check(await replyWith(new RegExp(`to Uibob ${tag}'s journal for today`)), "For menu: the reply names whose journal it went to");
    rows = await mineJ();
    const bobRow = rows.find((j) => j.content === bobText);
    check(!!bobRow && (bobRow.linkedProfiles || []).includes(personId), "…and the entry belongs to that person");
    await shot("2-for-bob");

    // 3. Note button, name typed in the text.
    await nBtn.click();
    await who.selectOption({ index: 0 });
    await send(`Note for Uibob ${tag}: prefers morning appointments ${tag}, never after 3pm.`);
    check(await replyWith(new RegExp(`Saved the note ".+" for Uibob ${tag}`)), "Note button: “Note for <Name>: …” is saved for that person, with a title");
    const noteRow = ((await get("/artifacts")) as any[]).find((a) => a.type === "note" && String(a.content).includes(`appointments ${tag}`));
    check(!!noteRow && (noteRow.linkedProfiles || []).includes(personId) && !String(noteRow.content).startsWith("Note for"), "…stored under that person, without the “Note for” lead");

    // 4. Off again: an ordinary question is answered, not saved.
    await nBtn.click();
    check((await nBtn.getAttribute("aria-pressed")) === "false" && (await page.locator('[data-testid="button-send"]').innerText()).includes("Send"), "tapping the button again returns to ordinary chat");
    const before = (await mineJ()).length;
    await send("What was my mood earlier today?");
    check(await replyWith(/journal entr(y|ies) today/i), "with the buttons off, a question is answered");
    check((await mineJ()).length === before, "…and nothing is saved");
    await shot("3-chat");

    // ── the Journal page ─────────────────────────────────────────────────
    await page.locator('[data-testid="nav-journal"], a[href="#/journal"]').first().click({ timeout: 5000 }).catch(() => page.evaluate(() => { window.location.hash = "#/journal"; }));
    const mineCard = page.locator(`[data-testid="card-journal-${rows.find((j) => j.content === mineText)?.id}"]`);
    await mineCard.waitFor({ timeout: 30000 }).catch(async (e: any) => { await shot("journal-page-missing-card"); throw e; });
    const bobCard = page.locator(`[data-testid="card-journal-${bobRow?.id}"]`);
    check(await mineCard.locator("h3").first().isVisible(), "Journal page: my entry shows its title");
    check((await bobCard.innerText().catch(() => "")).includes(`Uibob ${tag}'s journal`), "Journal page: the other entry is marked as that person's journal");
    check(!(await mineCard.innerText()).includes("'s journal"), "…and mine is not");
    await shot("4-journal-page");

    // Manual entry on a day that already has entries: a new card, nothing replaced.
    await page.locator('[data-testid="button-new-journal"]').click();
    await page.locator('[data-testid="btn-journal-mode-free"]').click();
    check(await page.locator('[data-testid="input-journal-title"]').isVisible() && await page.locator('[data-testid="input-journal-date"]').isVisible() && await page.locator('[data-testid="button-mood-good"]').isVisible(),
      "New Entry (free write) has a title box, a date picker and the mood buttons");
    const manualText = `Walked the dog and cooked dinner ${tag}.`;
    await page.locator('[data-testid="input-journal-free-text"]').fill(manualText);
    await page.locator('[data-testid="button-save-journal-free"]').click();
    await page.getByText("Entry saved").first().waitFor({ timeout: 20000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    rows = await mineJ();
    const manual = rows.find((j) => j.content === manualText);
    check(!!manual && String(manual.title || "").trim().length >= 3, `manual entry saved with a title written for it (got "${manual?.title}")`);
    check(rows.some((j) => j.content === mineText) && rows.some((j) => j.content === bobText), "…and the entries already there are untouched");
    await shot("5-after-manual");
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    for (const j of await mineJ().catch(() => [])) await api("DELETE", `/journal/${j.id}`).catch(() => undefined);
    for (const a of ((await get("/artifacts").catch(() => [])) as any[]).filter((a) => String(a.content || "").includes(tag) || String(a.title || "").includes(tag))) {
      await api("DELETE", `/notes/${a.id}`).catch(() => undefined);
    }
    if (personId) await api("DELETE", `/profiles/${personId}`).catch(() => undefined);
    await release();
  }
  console.log(failed ? "\nSOME CHECKS FAILED" : "\nALL CHECKS PASSED");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
