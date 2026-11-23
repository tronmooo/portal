// Live check: Fill In, start to finish (owner request 2026-11-23: "the entire
// workflow must actually work … the completed file must contain the
// information, save correctly, reopen correctly"). Deployed app, smoke
// account, a real browser, the real model.
//
// It saves two uploads the way an old upload sits in Documents — a PICTURE of
// a driver's licence and a résumé PDF, neither ever read — and then:
//   1. fills an interactive PDF: the address must come from the licence
//      (read from the picture), the employer from the résumé; a tick box, a
//      multi-line answer; a detail DRAGGED from My Information onto a field;
//   2. saves, DOWNLOADS the completed file and opens the downloaded bytes with
//      pdf-lib: the form's own fields must hold the values;
//   3. fills a flat (non-interactive) PDF: values are drawn on the page; the
//      downloaded file's page text must contain them, on one page;
//   4. reopens the completed form, changes a value, saves again: the new file
//      holds the change and there is still one completed copy;
//   5. on a phone (touch): the form fits the screen, a field is edited by tap,
//      a detail is placed by tap, Save is reachable.
// Every document it creates is deleted at the end.
//
//   npx tsx tests/live-fill-check.ts
//   (a preview deployment:  SMOKE_UI_BASE=https://… SMOKE_API_BASE=https://…/api)
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { api } from "./smoke/fixture/api";
import { UI_BASE } from "./smoke/fixture/account";
import { acquireGateLock, preferenceLockIo } from "./smoke/fixture/gate-lock";
import { LIVE_EMAIL, LIVE_PASSWORD } from "./helpers/live-account";

const req = createRequire(import.meta.url);
const { chromium } = req("playwright");
const sharp = req("sharp");
const SHOTS = process.env.SHOTS_DIR || "";
const t = (id: string) => `[data-testid="${id}"]`;
let failed = 0;
const check = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed++; };

const TAG = Math.random().toString(36).slice(2, 6).toUpperCase();
const NAME = `Morgan Q. Testfill`;
const ADDRESS = `4821 Juniper Hollow Rd, Flagstaff, AZ 86004`;
const EMPLOYER = `Kestrel Ridge Logistics ${TAG}`;
const TITLE = "Dispatch Supervisor";

async function licencePng(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="620">
    <rect width="1000" height="620" fill="#e8eef7"/><rect x="20" y="20" width="960" height="580" rx="24" fill="#ffffff" stroke="#27457a" stroke-width="6"/>
    <text x="50" y="90" font-family="Arial, Helvetica, sans-serif" font-size="46" font-weight="bold" fill="#27457a">ARIZONA DRIVER LICENSE</text>
    <g font-family="Arial, Helvetica, sans-serif" font-size="34" fill="#111">
      <text x="50" y="170">DL NUMBER: D0${TAG}7731</text>
      <text x="50" y="230">NAME: ${NAME.toUpperCase()}</text>
      <text x="50" y="290">ADDRESS: ${ADDRESS.split(",")[0].toUpperCase()}</text>
      <text x="50" y="340">${ADDRESS.split(",").slice(1).join(",").trim().toUpperCase()}</text>
      <text x="50" y="410">DOB: 07/19/1988</text>
      <text x="50" y="470">ISS: 03/02/2024    EXP: 07/19/2032</text>
      <text x="50" y="530">CLASS: D    SEX: F    HGT: 5-06    EYES: BRN</text>
    </g></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function resumePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  [
    `${NAME}`, "Résumé", "", "EXPERIENCE",
    `${EMPLOYER} — ${TITLE}`, "March 2019 – Present, Flagstaff, AZ", "Runs a dispatch desk of nine drivers; scheduling, route planning and safety briefings.", "",
    "Pinecrest Freight Co. — Driver", "June 2014 – February 2019, Flagstaff, AZ", "",
    "EDUCATION", "Coconino Community College — A.A.S. Business, 2014", "",
    "SKILLS", "Route planning, CDL Class A, Spanish (conversational)",
  ].forEach((s, i) => page.drawText(s, { x: 56, y: 730 - i * 24, size: i === 0 ? 18 : 11, font }));
  return doc.save();
}

async function interactiveForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  page.drawText(`Employment application ${TAG}`, { x: 50, y: 745, size: 16, font });
  const rows: Array<[string, boolean?]> = [["Full Name"], ["Street Address"], ["City"], ["State"], ["ZIP Code"], ["Date of Birth"], ["Current Employer"], ["Job Title"], ["Mailing Address"], ["Describe your experience", true]];
  let y = 700;
  for (const [name, multi] of rows) {
    page.drawText(`${name}:`, { x: 50, y: y + 4, size: 10, font });
    const f = form.createTextField(name);
    if (multi) f.enableMultiline();
    f.addToPage(page, { x: 220, y: multi ? y - 44 : y, width: 330, height: multi ? 62 : 18 });
    y -= multi ? 80 : 30;
  }
  page.drawText("I can work weekends", { x: 76, y: y + 4, size: 10, font });
  form.createCheckBox("Weekends").addToPage(page, { x: 50, y, width: 14, height: 14 });
  page.drawText("Signature:", { x: 50, y: y - 40, size: 10, font });
  return doc.save();
}

async function flatForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  [`CHANGE OF ADDRESS REQUEST ${TAG}`, "", "Full name: ______________________________________", "Address: ________________________________________________________",
    "City: ____________________   State: ______   ZIP: ____________", "Date of birth: ________________", "Employer: ______________________________________", "[ ] Send me a confirmation",
  ].forEach((s, i) => page.drawText(s, { x: 50, y: 730 - i * 34, size: 11, font }));
  return doc.save();
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((it: any) => it.str).join(" ").replace(/\s+/g, " "));
  return out;
}

const fieldSel = (label: string) => `[data-testid^="fill-field-"][aria-label^="${label}:"]`;

async function main() {
  const release = await acquireGateLock(preferenceLockIo((m, p, b) => api(m, p, b)), { gate: "live-fill-check" });
  const browser = await chromium.launch();
  try {
    // ── two uploads that have never been read ──
    const lic = await api("POST", "/upload/save-only", { fileName: `Drivers License ${TAG}.png`, mimeType: "image/png", fileData: (await licencePng()).toString("base64") });
    const cv = await api("POST", "/upload/save-only", { fileName: `Resume ${TAG}.pdf`, mimeType: "application/pdf", fileData: Buffer.from(await resumePdf()).toString("base64") });
    check(lic.ok && cv.ok, "seed: a picture of a licence and a résumé are saved to Documents, unread");
    const before = (await api("GET", "/smart-fill/information")).data;
    check(before.unindexed >= 2, `before filling, the uploads are waiting to be read (${before.unindexed})`);
    check(!/juniper hollow/i.test(JSON.stringify(before.facts)), "…and the licence's address is not on file anywhere yet");

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, timezoneId: "America/Los_Angeles" });
    const page = await ctx.newPage();
    await page.addInitScript("window.__name = (f) => f;");
    const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
    const signIn = async (p: any) => {
      await p.goto(UI_BASE);
      const email = p.locator(t("input-signin-email"));
      if (!(await email.isVisible({ timeout: 8000 }).catch(() => false))) {
        await p.getByRole("button", { name: /sign in|log in|get started/i }).first().click({ timeout: 15000 }).catch(() => undefined);
        await p.locator(t("tab-signin")).click({ timeout: 5000 }).catch(() => undefined);
      }
      await email.waitFor({ timeout: 30000 });
      await email.fill(LIVE_EMAIL);
      await p.fill(t("input-signin-password"), LIVE_PASSWORD);
      await p.click(t("button-signin"));
      await p.waitForSelector(t("page-dashboard"), { timeout: 30000 });
    };
    const shot = async (p: any, name: string) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/fill-${name}.png` }); };
    const value = (p: any, label: string) => p.locator(fieldSel(label)).first().innerText().then((s: string) => s.trim());
    const saveAndDownload = async (p: any): Promise<Uint8Array> => {
      await p.click(t("button-workspace-save"));
      await p.waitForSelector(t("fill-saved"), { timeout: 120000 });
      const [download] = await Promise.all([p.waitForEvent("download", { timeout: 60000 }), p.click(t("button-fill-download"))]);
      return new Uint8Array(await readFile(await download.path()));
    };

    await signIn(page);

    // ── 1. an interactive PDF ──
    await page.goto(`${UI_BASE}/#/workspace/fill`);
    await page.waitForSelector(t("fill-drop-zone"), { timeout: 30000 });
    await page.locator(t("input-fill-file")).setInputFiles({ name: `application-${TAG}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(await interactiveForm()) });
    await page.waitForSelector(t("fill-toolbar"), { timeout: 240000 });
    await page.waitForSelector(fieldSel("Full Name"), { timeout: 30000 });
    await shot(page, "1-interactive");
    const after = (await api("GET", "/smart-fill/information")).data;
    check(/juniper hollow/i.test(JSON.stringify(after.facts)), "choosing a form read the licence picture: its address is now on file, with the licence as its source");
    check(/4821 Juniper Hollow R(oa)?d/i.test(await value(page, "Street Address")), `Street Address is filled from the licence ("${await value(page, "Street Address")}")`);
    check(/flagstaff/i.test(await value(page, "City")) && /^AZ$/i.test(await value(page, "State")) && (await value(page, "ZIP Code")) === "86004", "City, State and ZIP are filled from the same address");
    check((await value(page, "Date of Birth")) === "07/19/1988", `Date of Birth is filled from the licence ("${await value(page, "Date of Birth")}")`);
    check((await value(page, "Current Employer")).includes("Kestrel Ridge Logistics"), `Current Employer is filled from the résumé ("${await value(page, "Current Employer")}")`);
    check(/dispatch supervisor/i.test(await value(page, "Job Title")), "Job Title is filled from the résumé");
    const src = await page.locator(fieldSel("Street Address")).first().getAttribute("title");
    check(/from .*licen[sc]e/i.test(String(src)), `…and the field names its source (${src})`);

    // A detail dragged from My Information onto a field.
    await page.fill(t("input-fill-search"), "Juniper");
    const fact = page.locator('[data-testid^="fill-fact-"]').filter({ hasText: "Juniper Hollow" }).first();
    await fact.dragTo(page.locator(fieldSel("Mailing Address")).first());
    check(/juniper hollow/i.test(await value(page, "Mailing Address")), "a detail dragged from My Information onto a field fills that field");
    await page.fill(t("input-fill-search"), "");
    // A tick box, a multi-line answer typed by hand, undo and redo.
    await page.locator(fieldSel("Weekends")).first().click();
    await page.locator(fieldSel("Describe your experience")).first().click();
    const story = "Nine years in dispatch.\nSafety briefings every Monday.\nComfortable with weekend shifts.";
    await page.fill(t("fill-editor-input"), story);
    await page.click(t("button-fill-undo"));
    await page.click(t("button-fill-redo"));
    check((await page.inputValue(t("fill-editor-input"))) === story, "typing in a field, then undo and redo, keeps the text");

    const filled = await saveAndDownload(page);
    await shot(page, "2-saved");
    check(/reopened and holds \d+ of \d+ values/.test(await page.locator(t("fill-saved")).innerText()), "Save reports the server's check of the reopened file");
    const pdf = await PDFDocument.load(filled);
    const form = pdf.getForm();
    const get = (n: string) => form.getTextField(n).getText() || "";
    check(/4821 Juniper Hollow R(oa)?d/i.test(get("Street Address")) && get("ZIP Code") === "86004", `DOWNLOADED file: the form's own Street Address and ZIP fields hold the values ("${get("Street Address")}")`);
    check(get("Current Employer").includes("Kestrel Ridge Logistics") && get("Date of Birth") === "07/19/1988", "DOWNLOADED file: employer and date of birth are in their fields");
    check(/juniper hollow/i.test(get("Mailing Address")), "DOWNLOADED file: the dragged value is in its field");
    check(get("Describe your experience").replace(/\r/g, "") === story, "DOWNLOADED file: the multi-line answer is whole");
    check(form.getCheckBox("Weekends").isChecked(), "DOWNLOADED file: the tick box is ticked");
    check(pdf.getPageCount() === 1, "DOWNLOADED file: still one page — no summary page was added");
    check(!form.getTextField("Full Name").isReadOnly(), "DOWNLOADED file: the fields are still editable");

    // ── 4. reopen the completed form, change a value, save again ──
    await page.click(t("button-fill-another")); await page.click(t("button-fill-another"));
    await page.waitForSelector(t("fill-forms"), { timeout: 30000 });
    await page.locator('[data-testid^="fill-form-"]').filter({ hasText: `application-${TAG}` }).first().getByText("Edit").click();
    await page.waitForSelector(fieldSel("Job Title"), { timeout: 60000 });
    check((await value(page, "Current Employer")).includes("Kestrel Ridge Logistics"), "a completed form reopens with its values");
    await page.locator(fieldSel("Job Title")).first().click();
    await page.fill(t("fill-editor-input"), "Operations Manager");
    const edited = await saveAndDownload(page);
    check((await PDFDocument.load(edited)).getForm().getTextField("Job Title").getText() === "Operations Manager", "the edit is in the re-saved file");
    const docs = (await api("GET", "/documents")).data as any[];
    check(docs.filter((d) => String(d.name).includes(`application-${TAG}`) && d.type === "smart_fill").length === 1, "…and there is one completed copy, beside the kept blank original");
    check(docs.some((d) => String(d.name).includes(`application-${TAG}`) && (d.tags || []).includes("fill-original")), "the original form is kept as its own document");

    // ── 3. a flat (non-interactive) PDF ──
    await page.click(t("button-fill-another")); await page.click(t("button-fill-another")).catch(() => undefined);
    await page.waitForSelector(t("fill-drop-zone"), { timeout: 30000 });
    await page.locator(t("input-fill-file")).setInputFiles({ name: `address-change-${TAG}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(await flatForm()) });
    await page.waitForSelector(fieldSel("Address"), { timeout: 240000 });
    check(/4821 Juniper Hollow R(oa)?d/i.test(await value(page, "Address")), `flat PDF: the Address blank is found and filled ("${await value(page, "Address")}")`);
    await page.locator(fieldSel("Send me a confirmation")).first().click();
    await shot(page, "3-flat");
    const flat = await saveAndDownload(page);
    const texts = await pageTexts(flat);
    check(texts.length === 1, "flat PDF, DOWNLOADED: still one page");
    check(/4821 Juniper Hollow R(oa)?d/i.test(texts[0]) && texts[0].includes("86004") && texts[0].includes("07/19/1988"), "flat PDF, DOWNLOADED: the address, ZIP and date of birth are drawn on the page");
    check(texts[0].includes("Kestrel Ridge Logistics"), "flat PDF, DOWNLOADED: the employer from the résumé is on the page");
    check(errors.length === 0, `desktop: no page errors${errors.length ? ` (${errors[0]})` : ""}`);
    await ctx.close();

    // ── 5. a phone, by touch ──
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: "dark", timezoneId: "America/Los_Angeles" });
    const mp = await phone.newPage();
    await mp.addInitScript("window.__name = (f) => f;");
    await signIn(mp);
    await mp.goto(`${UI_BASE}/#/workspace/fill`);
    await mp.waitForSelector(t("fill-drop-zone"), { timeout: 30000 });
    await mp.locator(t("input-fill-file")).setInputFiles({ name: `phone-form-${TAG}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(await flatForm()) });
    await mp.waitForSelector(fieldSel("Address"), { timeout: 240000 });
    const fits = await mp.evaluate(() => {
      const w = window.innerWidth;
      const over = Array.from(document.querySelectorAll('[data-testid="workspace-fill"] *')).find((el) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && !(el as HTMLElement).closest("[data-swipe-ignore]") && (r.right > w + 1 || r.left < -1); }) as HTMLElement | undefined;
      const save = document.querySelector('[data-testid="button-workspace-save"]')!.getBoundingClientRect();
      return { ok: !over && save.right <= w && save.top >= 0, why: over ? `${over.tagName} ${over.getAttribute("data-testid") || over.className}`.slice(0, 120) : "" };
    });
    check(fits.ok, `phone: the form fits the screen and Save is on it ${fits.why}`);
    await mp.locator(fieldSel("Employer")).first().tap();
    await mp.waitForSelector(t("fill-editor-input"));
    await mp.fill(t("fill-editor-input"), "Typed On A Phone LLC");
    check((await value(mp, "Employer")) === "Typed On A Phone LLC", "phone: a field is edited by tapping it");
    await mp.tap('[aria-label="Done with this field"]');
    await mp.tap(t("button-fill-info"));
    await mp.fill(t("input-fill-search"), "Juniper");
    await mp.locator('[data-testid^="fill-fact-"]').filter({ hasText: "Juniper Hollow" }).first().locator("button").first().tap();
    await mp.waitForSelector(t("fill-placing"));
    await mp.locator(fieldSel("Full name")).first().tap();
    check(/juniper hollow/i.test(await value(mp, "Full name")), "phone: a detail is placed by tapping it, then tapping a field");
    await shot(mp, "5-phone");
    await mp.tap(t("button-workspace-save"));
    await mp.waitForSelector(t("fill-saved"), { timeout: 120000 });
    check(true, "phone: Save writes and verifies the file");
    await phone.close();
  } finally {
    await browser.close();
    const docs = ((await api("GET", "/documents")).data || []) as any[];
    for (const d of docs) if (String(d.name).includes(TAG)) await api("DELETE", `/documents/${d.id}`);
    await release();
  }
  console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
