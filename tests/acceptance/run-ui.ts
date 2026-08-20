// Focused runner for the UI (non-chat) write paths.
import { chromium } from "playwright-core";
import { startRig } from "./rig";
import { CHROME } from "./driver";
import { uiCreate, uiEdit, uiDelete } from "./ui-writes";
import { switchScope } from "./suites";

async function main() {
  const rig = await startRig({ instances: 2 });
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const ctx = await browser.newContext();
  await ctx.addInitScript(([s]) => {
    localStorage.setItem("portol_session", s as string);
    sessionStorage.setItem("portol_session", s as string);
  }, [JSON.stringify(rig.session)]);
  const page = await ctx.newPage();
  await page.goto(rig.url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="nav-chat"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  let fails = 0;
  for (const [label, fn] of [
    ["UI create", () => uiCreate(page, rig)],
    ["UI edit", () => uiEdit(page, rig)],
    ["UI delete", () => uiDelete(page, rig)],
  ] as Array<[string, () => Promise<any[]>]>) {
    console.log(`\n── ${label} ──`);
    try {
      await switchScope(page, "everyone");
      for (const r of await fn()) {
        const tag = { PASS: "✓", FAIL: "✗", INCONCLUSIVE: "?", RIG: "!" }[r.verdict as string];
        console.log(`  ${tag} ${r.name} — ${r.detail}`);
        if (r.verdict === "FAIL") fails++;
      }
    } catch (e: any) {
      console.log(`  ! ${label} threw: ${String(e?.message || e).slice(0, 200)}`);
    }
  }
  console.log(`\nfails=${fails}`);
  await browser.close();
  await rig.close();
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
