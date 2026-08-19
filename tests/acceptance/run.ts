// The acceptance run.
//
// Verdicts are deliberately three-way, because "the page never showed it" and
// "the page showed it late" are different problems and only one of them is the
// bug under test:
//   PASS         — present on the destination view's first rendered frame
//   FAIL         — absent on the first frame, present later (the staleness bug),
//                  or present and then overwritten by a later response
//   INCONCLUSIVE — the row is in the database but this view never shows it at
//                  all, so the rig cannot observe the property here
//   RIG          — the tool never wrote the row; nothing about the UI was tested
import { chromium, type Browser, type Page } from "playwright-core";
import { startRig, type Rig } from "./rig";
import { CHROME, chat, navigateAndRecord, perfMarks, gotoHash } from "./driver";
import { CASES } from "./matrix";
import {
  profileIsolation, cacheConsistency, rapidNavigation, consecutiveWrites,
  crossTab, reloadConsistency, repeatedCycles, switchScope,
  dashboardBootstrap, uploadPath,
} from "./suites";

export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "RIG";
export interface Result {
  name: string;
  verdict: Verdict;
  detail: string;
  firstFrameMs?: number;
  staleFlash?: boolean;
  regressed?: boolean;
}

const results: Result[] = [];
function record(r: Result) {
  results.push(r);
  const tag = { PASS: "✓", FAIL: "✗", INCONCLUSIVE: "?", RIG: "!" }[r.verdict];
  console.log(`  ${tag} ${r.name} — ${r.detail}`);
}

let needleSeq = 0;
const needle = (p: string) => `${p}${Date.now().toString(36)}${needleSeq++}`;

/**
 * Open the app. `sameContextAs` opens a second TAB in an existing context,
 * which is what the cross-tab test needs: a fresh browser context is an
 * isolated storage partition, so BroadcastChannel — the very mechanism under
 * test — cannot cross it. Two contexts are two browsers, not two tabs.
 */
async function openApp(browser: Browser, rig: Rig, sameContextAs?: Page): Promise<Page> {
  const ctx = sameContextAs ? sameContextAs.context() : await browser.newContext();
  if (!sameContextAs) {
    await ctx.addInitScript(([s]) => {
      localStorage.setItem("portol_session", s as string);
      sessionStorage.setItem("portol_session", s as string);
    }, [JSON.stringify(rig.session)]);
  }
  const page = await ctx.newPage();
  await page.goto(rig.url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="nav-chat"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  return page;
}

/** One write → immediate navigation → first-render verdict. */
async function checkSurface(
  page: Page, rig: Rig, label: string, route: string, marker: string,
  n: string, opts: { control?: string; expectAbsent?: boolean } = {},
): Promise<Result> {
  const rec = await navigateAndRecord(page, route, marker, n, {
    settleMs: 2500, control: opts.control,
  });
  const mounted = rec.frames.filter((f) => f.mounted);
  if (mounted.length === 0) {
    return { name: label, verdict: "RIG", detail: `destination view never mounted (${marker})` };
  }
  if (opts.expectAbsent) {
    const everPresent = mounted.some((f) => f.present);
    return everPresent
      ? { name: label, verdict: "FAIL", detail: "deleted row still rendered" }
      : { name: label, verdict: "PASS", detail: `absent from first render (t=${rec.firstMounted?.t}ms)` };
  }
  // The list never painted content at all — this surface does not show this
  // entity, so it cannot answer the question either way.
  if (!rec.firstPopulated) {
    return { name: label, verdict: "INCONCLUSIVE", detail: `row is in the DB but ${route} never renders this entity` };
  }
  if (rec.regressed) {
    return { name: label, verdict: "FAIL", detail: "rendered, then a later response REMOVED it", regressed: true };
  }
  if (rec.staleFlash) {
    const firstYes = rec.frames.find((f) => f.mounted && f.present)!;
    return {
      name: label, verdict: "FAIL",
      detail: `STALE: list had content WITHOUT the row at t=${rec.firstPopulated.t}ms, row appeared at t=${firstYes.t}ms`,
      firstFrameMs: rec.firstPopulated.t, staleFlash: true,
    };
  }
  const late = rec.loadedLate ? ` (list painted at t=${rec.firstPopulated.t}ms, view mounted at t=${rec.firstMounted!.t}ms)` : "";
  return {
    name: label, verdict: "PASS",
    detail: `present the moment the list had content, t=${rec.firstPopulated.t}ms${late}`,
    firstFrameMs: rec.firstPopulated.t,
  };
}

/**
 * Seed one "control" row per entity type BEFORE the timed writes.
 *
 * The control is what lets a verdict distinguish the reported bug (the list
 * rendered, showing older rows, without the new one) from an ordinary cold
 * first paint (the list had not rendered at all yet). Without it every
 * slow-loading page looks like a staleness bug, and the run would cry wolf.
 */
async function seedControls(page: Page): Promise<Map<string, string>> {
  console.log("\n── Seeding controls (one existing row per entity type) ──");
  const controls = new Map<string, string>();
  for (const c of CASES) {
    const n = needle("Ctl");
    await chat(page, c.turn(n));
    controls.set(c.name, n);
  }
  console.log(`  seeded ${controls.size} control rows`);
  return controls;
}

async function runEntityMatrix(page: Page, rig: Rig, controls: Map<string, string>) {
  console.log("\n── Entity matrix ──");
  for (const c of CASES) {
    const n = needle("Acc");
    const control = controls.get(c.name);
    await chat(page, c.turn(n));
    const inDb = await c.dbCheck(rig.storage, n);
    if (!inDb) {
      record({ name: c.name, verdict: "RIG", detail: "tool did not write the row — UI not exercised" });
      continue;
    }
    record(await checkSurface(page, rig, c.name, c.route, c.marker, n, { control }));
    for (const extra of c.alsoOn ?? []) {
      record(await checkSurface(page, rig, `${c.name} @ ${extra.route}`, extra.route, extra.marker, n, { control }));
    }
  }
}

async function runUpdateAndDelete(page: Page, rig: Rig) {
  console.log("\n── Updates and deletes ──");
  const original = needle("Upd");
  await chat(page, `##create_task {"title":"${original}"}`);
  const renamed = needle("Ren");
  await chat(page, `##update_task {"title":"${original}","changes":{"title":"${renamed}"}}`);
  const tasks = await rig.storage.getTasks();
  if (!tasks.some((t: any) => String(t.title).includes(renamed))) {
    const stillOld = tasks.some((t: any) => String(t.title).includes(original));
    record({
      name: "update existing record", verdict: "RIG",
      detail: `update_task did not rename the row (original still present: ${stillOld}; ${tasks.length} tasks in db)`,
    });
  } else {
    record(await checkSurface(page, rig, "update existing record", "/tasks", '[data-testid="page-tasks"]', renamed, { control: original }));
  }

  const doomed = needle("Del");
  await chat(page, `##create_task {"title":"${doomed}"}`);
  await chat(page, `##delete_task {"title":"${doomed}"}`);
  const after = await rig.storage.getTasks();
  const live = after.filter((t: any) => String(t.title).includes(doomed) && !t.deletedAt);
  if (live.length > 0) {
    record({ name: "delete", verdict: "RIG", detail: "delete_task did not remove the row" });
  } else {
    record(await checkSurface(page, rig, "delete", "/tasks", '[data-testid="page-tasks"]', doomed, { expectAbsent: true }));
  }
}

async function main() {
  const rig = await startRig({ instances: 2 });
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const page = await openApp(browser, rig);

  // Repeated cycles run FIRST, deliberately. /api/tasks paginates at 100 rows
  // by default (routes.ts paginate), and the rest of this run creates enough
  // tasks to cross that cap — after which a newly created task is legitimately
  // absent from page 1 and the verdict would be measuring the pager, not the
  // cache. Ten cycles on a near-empty dataset measure what they claim to.
  console.log("\n── Repeated cycles (run first: /api/tasks pages at 100) ──");
  for (const r of await repeatedCycles(page, rig, 10)) record(r);

  const controls = await seedControls(page);
  await runEntityMatrix(page, rig, controls);
  await runUpdateAndDelete(page, rig);

  const suites: Array<[string, () => Promise<any[]>]> = [
    ["Profile isolation", () => profileIsolation(page, rig)],
    ["Cache consistency across surfaces", () => cacheConsistency(page, rig)],
    ["Rapid navigation", () => rapidNavigation(page, rig)],
    ["Consecutive writes", () => consecutiveWrites(page, rig)],
    ["Dashboard bootstrap", () => dashboardBootstrap(page, rig)],
    ["Upload / extraction", () => uploadPath(page, rig)],
    ["Reload consistency", () => reloadConsistency(page, rig)],
  ];
  let perfSnapshot: Array<{ name: string; ms: number }> = [];
  for (const [label, fn] of suites) {
    if (label === "Reload consistency") perfSnapshot = await perfMarks(page);
    console.log(`\n── ${label} ──`);
    try {
      // Every suite starts from the same scope, so one suite's scope change
      // can never be mistaken for the next suite's staleness.
      await switchScope(page, "everyone");
      for (const r of await fn()) record(r);
    } catch (e: any) {
      record({ name: label, verdict: "RIG", detail: `suite threw: ${String(e?.message || e).slice(0, 160)}` });
    }
  }

  console.log("\n── Cross-tab ──");
  try {
    for (const r of await crossTab(browser, rig, () => openApp(browser, rig, page))) record(r);
  } catch (e: any) {
    record({ name: "cross-tab", verdict: "RIG", detail: `suite threw: ${String(e?.message || e).slice(0, 160)}` });
  }

  console.log("\n── Perf (client marks) ──");
  // Captured before the reload suite runs: page.reload() clears the browser's
  // performance timeline, so reading marks afterwards reports an empty table.
  const marks = perfSnapshot.length > 0 ? perfSnapshot : await perfMarks(page);
  const interesting = marks.filter((m) => m.name.startsWith("chat:"));
  const byName: Record<string, number[]> = {};
  for (const m of interesting) (byName[m.name] ||= []).push(m.ms);
  for (const [name, values] of Object.entries(byName)) {
    const sorted = [...values].sort((a, b) => a - b);
    console.log(`  ${name}: n=${values.length} median=${sorted[Math.floor(sorted.length / 2)]}ms max=${sorted[sorted.length - 1]}ms`);
  }

  console.log("\n── Summary ──");
  const counts = results.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] || 0) + 1), a), {} as Record<string, number>);
  console.log(" ", JSON.stringify(counts));
  for (const r of results.filter((r) => r.verdict === "FAIL")) console.log("  FAIL:", r.name, "—", r.detail);
  for (const r of results.filter((r) => r.verdict !== "PASS" && r.verdict !== "FAIL")) console.log(` ${r.verdict}:`, r.name, "—", r.detail);

  await browser.close();
  await rig.close();
  process.exit(counts.FAIL ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
