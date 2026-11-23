// Live audit: on a PHONE, by touch, add one of every record the app has a
// manual form for, through that form, and time it (owner, 2026-11-23: "a full
// audit of everything that manually can be added … fast … and it's gotta work").
//
//   npx tsx tests/live-manual-entry-audit.ts
//   (an undeployed client against the deployed API:
//    SMOKE_UI_BASE=http://localhost:5199 LIVE_API_ORIGIN=https://portol.me)
//
// For each kind: open its screen, TAP the add control, fill the form, TAP
// save, then read the record back from the API. Reported per kind: saved or
// not, how long the screen took to offer the form, and how long from the Save
// tap until the record was stored. After each save the address must be where
// it was — a form never sends you somewhere else.
//
// Writes only to the smoke account, under the gate lock, and deletes what it made.
import { createRequire } from "node:module";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const { chromium } = createRequire(import.meta.url)("playwright");
const API_ORIGIN = process.env.LIVE_API_ORIGIN || "";
const ONLY = (process.env.ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const t = (id: string) => `[data-testid="${id}"]`;
const TAG = `QA${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
/** A save slower than this is reported as slow. */
const SLOW_SAVE_MS = 3000;

type Row = Record<string, any>;
const rowsOf = (data: any): Row[] => {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") for (const v of Object.values(data)) if (Array.isArray(v)) return v as Row[];
  throw new Error(`no list in response: ${JSON.stringify(data).slice(0, 120)}`);
};
async function list(path: string): Promise<Row[]> {
  const r = await api("GET", path);
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return rowsOf(r.data);
}
/** Poll until a stored row satisfies `match`; resolves with it and the wait. */
async function stored(path: string, match: (r: Row) => boolean, ms = 20000): Promise<Row | null> {
  const end = Date.now() + ms;
  for (;;) {
    const hit = (await list(path)).find(match);
    if (hit || Date.now() > end) return hit || null;
    await new Promise((r) => setTimeout(r, 400));
  }
}
const has = (r: Row, text: string) => JSON.stringify(r).includes(text);

interface Result { kind: string; ok: boolean; openMs?: number; saveMs?: number; note?: string }
const results: Result[] = [];
const cleanup: Array<() => Promise<any>> = [];

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-manual-entry-audit" });
  try {
    const version = await (await fetch(`${API_ORIGIN || UI_BASE}/api/version`)).json();
    console.log(`API is serving ${String(version.sha).slice(0, 7)}; UI at ${UI_BASE}; tag ${TAG}`);

    // Records the forms below hang off.
    const asset = (await api("POST", "/profiles", { type: "asset", name: `Audit Bike ${TAG}`, fields: { purchasePrice: 900, currentValue: 700 } })).data;
    const loan = (await api("POST", "/profiles", { type: "liability", type_key: "auto_loan", name: `Audit Loan ${TAG}`, fields: { balance: 5000, interestRate: 5, monthlyPayment: 200, dueDay: 12 } })).data;
    const tracker = (await api("POST", "/trackers", { name: `Audit Steps ${TAG}`, category: "fitness", unit: "steps", fields: [{ name: "value", type: "number", unit: "steps" }] })).data;
    cleanup.push(() => api("DELETE", `/profiles/${asset.id}`), () => api("DELETE", `/profiles/${loan.id}`));
    if (tracker?.id) cleanup.push(() => api("DELETE", `/trackers/${tracker.id}`));
    const self = (await list("/profiles")).find((p) => p.type === "self");

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 430, height: 900 }, hasTouch: true, isMobile: true, timezoneId: "America/Los_Angeles" });
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e: any) => pageErrors.push(String(e).slice(0, 160)));
    page.on("dialog", (d: any) => d.accept().catch(() => undefined));
    if (API_ORIGIN) {
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

    const tap = async (id: string, timeout = 15000) => {
      const el = page.locator(t(id)).first();
      await el.waitFor({ state: "visible", timeout });
      await el.scrollIntoViewIfNeeded().catch(() => undefined);
      await el.tap({ timeout });
    };
    const fill = async (id: string, value: string) => {
      const el = page.locator(t(id)).first();
      await el.waitFor({ state: "visible", timeout: 15000 });
      await el.fill(value);
    };
    const hashOf = () => { const u = page.url(); const i = u.indexOf("#"); return i < 0 ? "" : u.slice(i).split("?")[0]; };

    /**
     * One kind. `open` gets to the form (timed from navigation), `form` fills
     * it, `save` is the testid tapped to store it, `find` reads it back.
     */
    async function audit(kind: string, step: {
      route: string;
      open: () => Promise<void>;
      form: () => Promise<void>;
      save: string | (() => Promise<void>);
      find: () => Promise<Row | null>;
      remove?: (row: Row) => Promise<any>;
      /** The address may legitimately change (none do today). */
      mayNavigate?: boolean;
    }) {
      if (ONLY.length && !ONLY.includes(kind)) return;
      const r: Result = { kind, ok: false };
      try {
        const t0 = Date.now();
        await page.goto(`${UI_BASE}/#${step.route}`);
        await step.open();
        r.openMs = Date.now() - t0;
        await step.form();
        const before = hashOf();
        const t1 = Date.now();
        if (typeof step.save === "string") await tap(step.save); else await step.save();
        const row = await step.find();
        r.saveMs = Date.now() - t1;
        if (!row) { r.note = "the form was submitted but no record was stored"; }
        else {
          if (step.remove) cleanup.push(() => step.remove!(row));
          await page.waitForTimeout(800);
          const after = hashOf();
          if (!step.mayNavigate && after !== before) r.note = `saved, but the page moved from ${before} to ${after}`;
          else { r.ok = true; if (r.saveMs > SLOW_SAVE_MS) r.note = "saved, slowly"; }
        }
      } catch (e: any) {
        r.note = String(e?.message || e).split("\n")[0].slice(0, 170);
      }
      if (!r.ok && process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/audit-${kind.replace(/\W+/g, "-")}.png` }).catch(() => undefined);
      results.push(r);
      console.log(`${r.ok ? "PASS" : "FAIL"}  ${kind.padEnd(22)} form in ${String(r.openMs ?? "—").padStart(5)} ms · stored in ${String(r.saveMs ?? "—").padStart(5)} ms${r.note ? `  — ${r.note}` : ""}`);
      await page.keyboard.press("Escape").catch(() => undefined);
    }

    /** Finance keeps "More" open or closed between visits: open it only if the button is not there. */
    const openMore = async (id: string) => {
      await page.locator(t("finance-toggle-more")).first().waitFor({ state: "visible", timeout: 20000 });
      if (!(await page.locator(t(id)).first().isVisible().catch(() => false))) await tap("finance-toggle-more");
      await tap(id);
    };
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

    await audit("task", {
      route: "/tasks", open: () => tap("button-new-task"),
      form: () => fill("input-task-title", `Task ${TAG}`), save: "button-submit-task",
      find: () => stored("/tasks", (r) => r.title === `Task ${TAG}`), remove: (r) => api("DELETE", `/tasks/${r.id}`),
    });
    await audit("expense", {
      route: "/finance", open: () => tap("button-add-expense"),
      form: async () => { await fill("input-expense-description", `Expense ${TAG}`); await fill("input-expense-amount", "12.34"); },
      save: "button-save-expense",
      find: () => stored("/expenses", (r) => r.description === `Expense ${TAG}`), remove: (r) => api("DELETE", `/expenses/${r.id}`),
    });
    await audit("income", {
      route: "/finance", open: () => openMore("button-add-income"),
      form: async () => { await fill("input-income-description", `Income ${TAG}`); await fill("input-income-amount", "250"); },
      save: "button-save-income",
      find: () => stored("/incomes", (r) => r.description === `Income ${TAG}`), remove: (r) => api("DELETE", `/incomes/${r.id}`),
    });
    await audit("paycheck", {
      route: "/finance", open: () => openMore("button-add-paycheck"),
      form: async () => { await fill("input-paycheck-source", `Pay ${TAG}`); await fill("input-paycheck-amount", "1000"); await fill("input-paycheck-date", tomorrow); },
      save: "button-save-paycheck",
      find: () => stored("/paychecks", (r) => has(r, `Pay ${TAG}`)), remove: (r) => api("DELETE", `/paychecks/${r.id}`),
    });
    await audit("bill", {
      route: "/bills", open: () => tap("bills-add"),
      form: async () => { await fill("input-quick-add-bill-text", `Bill ${TAG}`); await fill("input-quick-add-bill-amount", "19.99"); },
      save: "btn-quick-add-bill-save",
      find: () => stored("/obligations", (r) => r.name === `Bill ${TAG}`), remove: (r) => api("DELETE", `/obligations/${r.id}`),
    });
    await audit("subscription", {
      route: "/calendar", open: async () => { await tap("btn-calendar-options"); await tap("btn-calendar-manager"); await page.locator(t("obl-name")).waitFor({ timeout: 15000 }); },
      form: async () => { await fill("obl-name", `Sub ${TAG}`); await fill("obl-amount", "7.5").catch(() => undefined); },
      save: "obl-create",
      find: () => stored("/obligations", (r) => r.name === `Sub ${TAG}`), remove: (r) => api("DELETE", `/obligations/${r.id}`),
    });
    await audit("habit", {
      route: "/habits", open: () => tap("button-create-habit"),
      form: () => fill("input-habit-name", `Habit ${TAG}`), save: "button-save-habit",
      find: () => stored("/habits", (r) => r.name === `Habit ${TAG}`), remove: (r) => api("DELETE", `/habits/${r.id}`),
    });
    await audit("calendar event", {
      route: "/calendar", open: async () => { await tap("btn-calendar-options"); await tap("menu-add-event"); },
      form: async () => { await fill("input-event-title", `Event ${TAG}`); await fill("input-event-date", tomorrow); },
      save: "btn-save-event",
      find: () => stored("/events", (r) => r.title === `Event ${TAG}`), remove: (r) => api("DELETE", `/events/${r.id}`),
    });
    await audit("goal", {
      route: "/goals", open: async () => { const first = page.locator(t("btn-create-first-goal")); const add = page.locator(t("btn-add-goal")); await first.or(add).first().waitFor({ timeout: 20000 }); await first.or(add).first().tap(); },
      form: async () => { await fill("input-goal-title", `Goal ${TAG}`); await fill("input-goal-target", "10"); },
      save: "btn-save-goal",
      find: () => stored("/goals", (r) => r.title === `Goal ${TAG}`), remove: (r) => api("DELETE", `/goals/${r.id}`),
    });
    await audit("journal entry", {
      route: "/journal", open: async () => { await tap("button-new-journal"); await tap("btn-journal-mode-free"); },
      form: () => fill("input-journal-free-text", `Journal ${TAG} wrote by hand on a phone.`),
      save: "button-save-journal-free",
      find: () => stored("/journal", (r) => has(r, `Journal ${TAG}`)), remove: (r) => api("DELETE", `/journal/${r.id}`),
    });
    await audit("note", {
      route: `/profiles/${self?.id}/info`, open: () => tap("info-notes-new"),
      form: async () => { await fill("new-note-title", `Note ${TAG}`); await fill("new-note-content", "Written by hand."); },
      save: "new-note-save",
      find: () => stored("/notes", (r) => r.title === `Note ${TAG}`), remove: (r) => api("DELETE", `/notes/${r.id}`),
    });
    await audit("account", {
      route: "/finance", open: () => tap("btn-add-account"),
      form: async () => { await fill("input-account-name", `Account ${TAG}`); await fill("input-account-balance", "321").catch(() => undefined); },
      save: "btn-save-account",
      find: () => stored("/profiles", (r) => r.name === `Account ${TAG}`), remove: (r) => api("DELETE", `/profiles/${r.id}`),
    });
    const createProfile = async (name: string) => {
      const dialog = page.locator(t("dialog-create-profile"));
      await dialog.waitFor({ timeout: 15000 });
      await dialog.locator("button[aria-pressed]").first().tap();
      await tap("btn-next-create-profile");
      await fill("input-profile-name", name);
      // Whatever this type marks required (a vehicle: year, make, model).
      const required = dialog.locator('[data-testid^="registry-field-"]').filter({ hasText: "*" });
      for (let i = 0; i < await required.count(); i++) {
        const input = required.nth(i).locator("input").first();
        if (!(await input.count())) continue;
        const hint = `${await input.getAttribute("placeholder") || ""} ${await input.getAttribute("type") || ""}`;
        const type = (await input.getAttribute("type")) || "";
        await input.fill(type === "date" ? "2024-01-15" : /\d{4}|number/.test(hint) ? "5" : "Audit");
      }
    };
    await audit("asset", {
      route: "/linked?tab=assets", open: () => tap("button-create-asset"),
      form: () => createProfile(`Asset ${TAG}`), save: "btn-submit-create-profile",
      find: () => stored("/profiles", (r) => r.name === `Asset ${TAG}`), remove: (r) => api("DELETE", `/profiles/${r.id}`),
    });
    await audit("liability", {
      route: "/liabilities", open: () => tap("button-create-liability"),
      form: () => createProfile(`Debt ${TAG}`), save: "btn-submit-create-profile",
      find: () => stored("/profiles", (r) => r.name === `Debt ${TAG}`), remove: (r) => api("DELETE", `/profiles/${r.id}`),
    });
    await audit("asset characteristic", {
      route: `/profiles/${asset.id}`, open: () => tap("asset-add-characteristic", 30000),
      form: async () => { await fill("add-field-key", "Frame size"); await fill("add-field-value", `M ${TAG}`); },
      save: "add-field-save",
      find: async () => { const end = Date.now() + 20000; for (;;) { const p = (await api("GET", `/profiles/${asset.id}`)).data; if (has(p?.fields || {}, `M ${TAG}`)) return p; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 400)); } },
    });
    await audit("asset date", {
      route: `/profiles/${asset.id}`, open: async () => { await tap("button-profile-menu", 30000); await tap("asset-add-date"); await page.locator(t("asset-add-date-dialog")).waitFor({ timeout: 10000 }); },
      form: async () => { await page.locator(t("asset-add-date-kind")).selectOption("warrantyExpiration"); await fill("asset-add-date-day", "2027-06-30"); },
      save: "asset-add-date-save",
      find: async () => { const end = Date.now() + 20000; for (;;) { const p = (await api("GET", `/profiles/${asset.id}`)).data; if (String(p?.fields?.warrantyExpiration || "").startsWith("2027-06-30")) return p; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 400)); } },
    });
    await audit("liability payment", {
      route: `/profiles/${loan.id}`, open: async () => { await tap("quick-pay-min", 30000); await page.locator(t("payment-dialog")).waitFor({ timeout: 10000 }); },
      form: () => fill("payment-amount-input", "123.45"),
      save: "payment-submit",
      find: () => stored(`/liabilities/${loan.id}/payments`, (r) => Math.abs(Number(r.amount) - 123.45) < 0.005),
    });
    if (tracker?.id) {
      await audit("tracker entry", {
        route: "/trackers", open: async () => { const card = page.locator(t(`card-tracker-${tracker.id}`)).or(page.locator(t(`tracker-row-${tracker.id}`))).or(page.getByRole("button", { name: new RegExp(`Audit Steps ${TAG}`) })).first(); const group = page.getByText(/NO DATA/i).first(); await card.or(group).first().waitFor({ timeout: 30000 }); if (!(await card.isVisible().catch(() => false))) await group.tap(); await card.waitFor({ timeout: 15000 }); await card.scrollIntoViewIfNeeded(); await card.tap(); await tap("button-add-entry-detail"); await page.locator(t(`dialog-add-entry-${tracker.id}`)).waitFor({ timeout: 10000 }); },
        form: async () => { await page.locator(t(`dialog-add-entry-${tracker.id}`)).locator('input[type="number"]').first().fill("4321"); },
        save: "button-entry-submit",
        find: async () => { const end = Date.now() + 20000; for (;;) { const tr = (await list("/trackers")).find((x) => x.id === tracker.id); if (tr && has(tr.entries || [], "4321")) return tr; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 400)); } },
      });
    } else {
      results.push({ kind: "tracker entry", ok: false, note: "could not create a tracker to log into" });
    }

    await browser.close();
    if (pageErrors.length) console.log(`page errors: ${pageErrors.slice(0, 5).join(" | ")}`);
    const bad = results.filter((r) => !r.ok);
    const slow = results.filter((r) => r.ok && (r.saveMs || 0) > SLOW_SAVE_MS);
    console.log(`\n${results.length - bad.length}/${results.length} kinds saved through their own form by touch; ${slow.length} slower than ${SLOW_SAVE_MS} ms to store.`);
    console.log("No manual form (chat only): a person, a pet, a new tracker, a reminder; a first budget.");
    process.exitCode = bad.length || pageErrors.length ? 1 : 0;
  } finally {
    for (const undo of cleanup.reverse()) await undo().catch(() => undefined);
    await release();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
