// Live check (production, smoke account, real browser): the Settings page
// worked BY HAND, with a desktop mouse and with a phone's touch. It had no
// browser check before the workflow matrix (2026-11-24).
//   the account shown is the one signed in · Dark and Light switch the page
//   and survive a reload · a notification switch saves, reads back after a
//   reload, and is put back · Export hands over a file · Sign out asks first
//   and Cancel keeps the session · "Delete All Data" stays locked until the
//   word is typed (this check never types it and never confirms)
//   npx tsx tests/live-settings-ui-check.ts           (MODE=desktop|phone for one)
import { api } from "./smoke/fixture/api";
import { SMOKE_EMAIL } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { chromium, openSignedIn, t, type Surface } from "./helpers/live-browser";

const MODE = process.env.MODE || "both";
const PREF = "email_notifications";

let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed = true; };

async function run(browser: any, surface: Surface) {
  const L = (s: string) => `[${surface}] ${s}`;
  const s = await openSignedIn(browser, surface);
  const { page, press } = s;
  const hit = (loc: any) => (surface === "phone" ? loc.tap() : loc.click());
  const stored = async () => (await api("GET", `/preferences/${PREF}`)).data?.value ?? null;
  const original = await stored();
  try {
    await s.open("/settings");
    await page.locator(t("text-user-email")).first().waitFor({ timeout: 30000 });
    check((await page.locator(t("text-user-email")).first().innerText()).trim() === SMOKE_EMAIL, L("the account shown is the one signed in"));
    check((await s.overflow()) === "", L(`the Settings page fits the screen${await s.overflow() ? ` — ${await s.overflow()}` : ""}`));

    // Appearance.
    const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
    await press(t("mode-dark"));
    await page.waitForTimeout(300);
    check(await isDark(), L("Dark → the page is dark"));
    await page.reload();
    await page.locator(t("mode-dark")).first().waitFor({ timeout: 30000 });
    check(await isDark(), L("… and still dark after a reload"));
    await press(t("mode-light"));
    await page.waitForTimeout(300);
    check(!(await isDark()), L("Light → the page is light"));
    check((await page.locator(t("mode-light")).first().getAttribute("aria-pressed")) === "true", L("the Light button reads as the chosen one"));

    // A notification switch.
    const sw = page.locator(t(`switch-${PREF}`)).first();
    await sw.scrollIntoViewIfNeeded();
    const before = (await sw.getAttribute("aria-checked")) === "true";
    await hit(sw);
    await page.waitForTimeout(1500);
    check(((await sw.getAttribute("aria-checked")) === "true") === !before, L(`the email-notifications switch flips (${before} → ${!before})`));
    check((await stored()) === String(!before), L(`the server has it (${await stored()})`));
    await page.reload();
    const sw2 = page.locator(t(`switch-${PREF}`)).first();
    await sw2.waitFor({ timeout: 30000 });
    await page.waitForTimeout(1200);
    check(((await sw2.getAttribute("aria-checked")) === "true") === !before, L("it reads the same after a reload"));
    await sw2.scrollIntoViewIfNeeded();
    await hit(sw2);
    await page.waitForTimeout(1500);
    check((await stored()) === String(before), L("switched back → the server has the first setting again"));

    // Export.
    const exportBtn = page.locator(t("button-export")).first();
    await exportBtn.scrollIntoViewIfNeeded();
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 45000 }), hit(exportBtn)]);
    const file = await download.path();
    const size = file ? (await import("node:fs")).statSync(file).size : 0;
    check(size > 200, L(`Export hands over a file: ${download.suggestedFilename()} (${Math.round(size / 1024)} KB)`));

    // Sign out asks first.
    const out = page.locator(t("button-signout-settings")).first();
    await out.scrollIntoViewIfNeeded();
    await hit(out);
    await page.locator(t("button-cancel-signout")).first().waitFor({ timeout: 10000 });
    await press(t("button-cancel-signout"));
    await page.waitForTimeout(500);
    check(await page.locator(t("text-user-email")).first().isVisible(), L("Sign out asks first, and Cancel keeps the session"));

    // Delete All Data stays locked. This check never types the word.
    const del = page.locator(t("button-delete-data")).first();
    await del.scrollIntoViewIfNeeded();
    await hit(del);
    const box = page.locator(t("input-delete-confirm"));
    await box.waitFor({ timeout: 10000 });
    const confirm = page.getByRole("alertdialog").getByRole("button").filter({ hasNotText: /cancel/i }).last();
    check(await confirm.isDisabled(), L("Delete All Data: the confirm button is locked when the box is empty"));
    await box.fill("delete please");
    check(await confirm.isDisabled(), L("… and still locked for anything but the exact word"));
    await hit(page.getByRole("alertdialog").getByRole("button", { name: /cancel/i }));
    await page.waitForTimeout(400);
    check((await api("GET", "/profiles")).ok && Array.isArray((await api("GET", "/profiles")).data) && (await api("GET", "/profiles")).data.length > 0, L("Cancel → the account's data is all still there"));
    const p = s.problems();
    check(p.length === 0, L(`Settings: no script or server error${p.length ? ` — ${p.join("; ")}` : ""}`));
  } catch (e: any) {
    check(false, L(`stopped: ${String(e?.message || e).split("\n")[0].slice(0, 240)}`));
    if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${surface}-settings-stopped.png` }).catch(() => undefined);
  } finally {
    // Whatever happened, the setting is put back as it was found.
    if (original !== null && (await stored()) !== original) await api("PUT", `/preferences/${PREF}`, { value: String(original) });
    await s.close();
  }
}

(async () => {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-settings-ui-check" });
  const browser = await chromium.launch();
  try {
    if (MODE !== "phone") await run(browser, "desktop");
    if (MODE !== "desktop") await run(browser, "phone");
  } finally {
    await browser.close();
    await release();
  }
  console.log(failed ? "\nFAILED" : "\nALL PASS");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
