// Shared by the live browser checks: a signed-in page of the deployed app, as
// a desktop mouse or as a phone with touch (T2: a screen with a control is
// checked by touch, not only with a mouse).
import { createRequire } from "node:module";
import { UI_BASE } from "../smoke/fixture/account";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./live-account";

const req = createRequire(import.meta.url);
export const { chromium } = (() => {
  try { return req("playwright"); } catch { return req("/opt/node-tools/node_modules/playwright"); }
})();

export type Surface = "desktop" | "phone";
export const t = (id: string) => `[data-testid="${id}"]`;

export interface SignedInPage {
  page: any;
  surface: Surface;
  /** A click on desktop, a tap on the phone — on the visible match. */
  press: (selector: string) => Promise<void>;
  /** Open one of the app's screens by its route. */
  open: (route: string) => Promise<void>;
  /** Script errors and 5xx answers seen since the last call (and clears them). */
  problems: () => string[];
  /** "" when nothing is wider than the screen, else what is. */
  overflow: () => Promise<string>;
  close: () => Promise<void>;
}

export async function openSignedIn(browser: any, surface: Surface, shots = false): Promise<SignedInPage> {
  const phone = surface === "phone";
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: shots ? 2 : 1, timezoneId: "America/Los_Angeles" }
    : { viewport: { width: 1400, height: 950 }, deviceScaleFactor: shots ? 2 : 1, timezoneId: "America/Los_Angeles" });
  const page = await ctx.newPage();
  await page.addInitScript("window.__name = (f) => f;");
  let seen: string[] = [];
  page.on("pageerror", (e: any) => seen.push(`script error: ${String(e).slice(0, 160)}`));
  page.on("response", (r: any) => {
    const u = new URL(r.url());
    // An environment with no AI provider (the isolated stack) answers its AI
    // routes 503 and marks them; that is its declared state, not a fault.
    // Only there (INTEGRITY_NO_AI=1): against a deployed app it still counts.
    if (process.env.INTEGRITY_NO_AI === "1" && r.status() === 503 && r.headers()["x-ai-unavailable"] === "1") return;
    if (u.pathname.startsWith("/api/") && r.status() >= 500) seen.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
  });
  const press = async (selector: string) => {
    const el = page.locator(selector).locator("visible=true").first();
    await el.waitFor({ timeout: 20000 });
    await (phone ? el.tap() : el.click());
  };
  await page.goto(UI_BASE);
  const email = page.locator(t("input-signin-email"));
  if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
    const start = page.getByRole("button", { name: /sign in|log in|get started/i }).first();
    await (phone ? start.tap({ timeout: 15000 }) : start.click({ timeout: 15000 })).catch(() => undefined);
    const tab = page.locator(t("tab-signin"));
    await (phone ? tab.tap({ timeout: 5000 }) : tab.click({ timeout: 5000 })).catch(() => undefined);
  }
  await email.waitFor({ timeout: 30000 });
  await email.fill(LIVE_EMAIL);
  await page.fill(t("input-signin-password"), LIVE_PASSWORD);
  await press(t("button-signin"));
  await page.waitForSelector(t("page-dashboard"), { timeout: 30000 });
  return {
    page, surface, press,
    open: async (route) => { await page.goto(`${UI_BASE}/#${route}`); },
    problems: () => { const out = seen; seen = []; return out; },
    overflow: () => page.evaluate(() => {
      const el = [...document.querySelectorAll("body *")].find((n) => {
        const b = (n as HTMLElement).getBoundingClientRect();
        if (b.width === 0 || b.right <= window.innerWidth + 1) return false;
        for (let p = n.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return false;
        }
        return true;
      }) as HTMLElement | undefined;
      const wide = document.documentElement.scrollWidth > window.innerWidth + 1;
      return el || wide ? `${document.documentElement.scrollWidth}px of ${window.innerWidth}px${el ? ` <${el.tagName.toLowerCase()} ${el.getAttribute("data-testid") || String(el.className).slice(0, 50)}>` : ""}` : "";
    }),
    close: () => ctx.close(),
  };
}
