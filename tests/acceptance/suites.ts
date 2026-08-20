// The rest of the acceptance matrix: profile isolation, cross-surface
// consistency, rapid navigation, consecutive writes, cross-tab, reload
// consistency, and repeated cycles.
import type { Browser, Page } from "playwright-core";
import type { Rig } from "./rig";
import { chat, navigateAndRecord, gotoHash } from "./driver";

export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "RIG";
export interface Result { name: string; verdict: Verdict; detail: string }

let seq = 0;
export const needle = (p: string) => `${p}${Date.now().toString(36)}${seq++}`;

/** Switch the profile scope through the app's own switcher — no reload. */
export async function switchScope(page: Page, target: "everyone" | string) {
  await gotoHash(page, "/dashboard");
  await page.waitForSelector('[data-testid="hub-profile-switcher"]', { timeout: 15000 });
  // The switcher is a dropdown: the items only exist once the trigger is open.
  await page.click('[data-testid="hub-profile-switcher"]');
  const sel = target === "everyone"
    ? '[data-testid="hub-switch-everyone"]'
    : `[data-testid="hub-switch-${target}"]`;
  await page.waitForSelector(sel, { timeout: 10000 });
  await page.click(sel);
  await page.waitForTimeout(400);
}

/**
 * Profile isolation.
 *
 * A row written for Bob must appear in Bob's views immediately and must never
 * appear in Jim's — not even for one frame. The frame series is what makes the
 * "not even for one frame" claim checkable rather than asserted.
 */
export async function profileIsolation(page: Page, rig: Rig): Promise<Result[]> {
  try {
    return await profileIsolationInner(page, rig);
  } finally {
    // A suite that leaves the app scoped to one person silently invalidates
    // every later suite — they would all be reading that person's empty views
    // and reporting the emptiness as staleness. Always hand back "Everyone".
    try { await switchScope(page, "everyone"); } catch { /* best effort */ }
  }
}

async function profileIsolationInner(page: Page, rig: Rig): Promise<Result[]> {
  const out: Result[] = [];
  const bob = rig.profiles.bob.id;
  const jim = rig.profiles.jim.id;

  await switchScope(page, bob);
  const n = needle("Bob");
  await chat(page, `##create_task {"title":"${n}","forProfile":"Bob"}`);

  const row = (await rig.storage.getTasks()).find((t: any) => String(t.title).includes(n));
  if (!row) return [{ name: "profile isolation", verdict: "RIG", detail: "task for Bob was not written" }];
  const linkedToBob = Array.isArray(row.linkedProfiles) && row.linkedProfiles.includes(bob);
  if (!linkedToBob) {
    out.push({
      name: "profile isolation (setup)", verdict: "RIG",
      detail: `task was not linked to Bob (linkedProfiles=${JSON.stringify(row.linkedProfiles)}) — isolation cannot be judged`,
    });
    return out;
  }

  // 1. specific profile → same specific profile: must be there on first render.
  const inBob = await navigateAndRecord(page, "/tasks", '[data-testid="page-tasks"]', n, { settleMs: 2000 });
  out.push(inBob.presentOnFirstPopulatedRender && !inBob.staleFlash
    ? { name: "Bob's row in Bob's view", verdict: "PASS", detail: `visible at t=${inBob.firstPopulated?.t}ms` }
    : { name: "Bob's row in Bob's view", verdict: "FAIL", detail: JSON.stringify({ first: inBob.firstPopulated, stale: inBob.staleFlash }) });

  // 2. specific → other specific: must NEVER appear, not for one frame.
  await switchScope(page, jim);
  const inJim = await navigateAndRecord(page, "/tasks", '[data-testid="page-tasks"]', n, { settleMs: 2000 });
  const leaked = inJim.frames.filter((f) => f.present).length;
  out.push(leaked === 0
    ? { name: "Bob's row must NOT leak into Jim's view", verdict: "PASS", detail: "absent in every frame" }
    : { name: "Bob's row must NOT leak into Jim's view", verdict: "FAIL", detail: `leaked in ${leaked} frame(s)` });

  // 3. specific → Everyone: must be there (Everyone includes Bob).
  await switchScope(page, "everyone");
  const inAll = await navigateAndRecord(page, "/tasks", '[data-testid="page-tasks"]', n, { settleMs: 2000 });
  out.push(inAll.presentOnFirstPopulatedRender
    ? { name: "Bob's row under Everyone", verdict: "PASS", detail: `visible at t=${inAll.firstPopulated?.t}ms` }
    : { name: "Bob's row under Everyone", verdict: "FAIL", detail: JSON.stringify(inAll.firstPopulated) });

  // 4. Everyone → specific, written under Everyone.
  const n2 = needle("Any");
  await chat(page, `##create_task {"title":"${n2}","forProfile":"Bob"}`);
  await switchScope(page, bob);
  const back = await navigateAndRecord(page, "/tasks", '[data-testid="page-tasks"]', n2, { settleMs: 2000 });
  out.push(back.presentOnFirstPopulatedRender && !back.staleFlash
    ? { name: "Everyone → Bob after write", verdict: "PASS", detail: `visible at t=${back.firstPopulated?.t}ms` }
    : { name: "Everyone → Bob after write", verdict: "FAIL", detail: JSON.stringify({ first: back.firstPopulated, stale: back.staleFlash }) });

  // 5. Rapid scope switching immediately after a write — no leak, no loss.
  const n3 = needle("Rap");
  await chat(page, `##create_task {"title":"${n3}","forProfile":"Bob"}`);
  let leakFrames = 0;
  for (const target of [jim, bob, "everyone", jim, bob] as const) {
    await switchScope(page, target as string);
    const r = await navigateAndRecord(page, "/tasks", '[data-testid="page-tasks"]', n3, { settleMs: 500 });
    if (target === jim) leakFrames += r.frames.filter((f) => f.present).length;
  }
  out.push(leakFrames === 0
    ? { name: "rapid profile switching after a write", verdict: "PASS", detail: "no cross-profile leak in any frame" }
    : { name: "rapid profile switching after a write", verdict: "FAIL", detail: `${leakFrames} leaked frame(s) in Jim's view` });

  return out;
}

/**
 * Cache consistency: every surface that shows a liability must show the SAME
 * state right after the write. One screen new, another old is the failure.
 */
export async function cacheConsistency(page: Page, rig: Rig): Promise<Result[]> {
  const control = needle("CtlLiab");
  await chat(page, `##create_liability {"name":"${control}","amount":1000,"liabilityType":"loan"}`);
  const n = needle("Liab");
  await chat(page, `##create_liability {"name":"${n}","amount":5000,"liabilityType":"loan"}`);

  const surfaces: Array<[string, string, string]> = [
    ["liabilities list", "/liabilities", '[data-testid="button-create-liability"]'],
    ["assets tab", "/linked?tab=assets", '[data-testid="button-create-asset"]'],
    ["dashboard", "/dashboard", '[data-testid="page-dashboard"]'],
    ["finance", "/dashboard/finance", '[data-testid="page-finance"]'],
    ["calendar", "/calendar", '[data-testid="calendar-page"]'],
  ];
  const out: Result[] = [];
  for (const [label, route, marker] of surfaces) {
    const r = await navigateAndRecord(page, route, marker, n, { settleMs: 1800, control });
    if (!r.firstPopulated) {
      out.push({ name: `consistency: ${label}`, verdict: "INCONCLUSIVE", detail: "surface does not render liabilities by name" });
    } else if (r.staleFlash || r.regressed) {
      out.push({ name: `consistency: ${label}`, verdict: "FAIL", detail: r.staleFlash ? "showed the older set first" : "row was removed by a later response" });
    } else if (!r.presentOnFirstPopulatedRender) {
      out.push({ name: `consistency: ${label}`, verdict: "FAIL", detail: "absent when the list first had content" });
    } else {
      out.push({ name: `consistency: ${label}`, verdict: "PASS", detail: `in sync at t=${r.firstPopulated.t}ms` });
    }
  }
  return out;
}

/**
 * Rapid navigation: hammer routes immediately after a write, far faster than
 * the 1.2s timeout the old code relied on. Every visit must be correct.
 */
export async function rapidNavigation(page: Page, rig: Rig): Promise<Result[]> {
  const control = needle("CtlRap");
  await chat(page, `##create_task {"title":"${control}"}`);
  const n = needle("Fast");
  await chat(page, `##create_task {"title":"${n}"}`);

  const hops = ["/dashboard", "/tasks", "/calendar", "/dashboard/finance", "/tasks", "/liabilities", "/tasks"];
  let bad = 0;
  let checked = 0;
  const timings: number[] = [];
  for (const hop of hops) {
    if (hop === "/tasks") {
      const r = await navigateAndRecord(page, hop, '[data-testid="page-tasks"]', n, { settleMs: 400, control });
      // A hop where the list never painted is NOT a pass — it is a hop this
      // check could not judge. Counting only the hops that painted would let an
      // all-blank run report "all correct".
      if (!r.firstPopulated) { bad++; continue; }
      checked++;
      timings.push(r.firstPopulated.t);
      if (!r.presentOnFirstPopulatedRender || r.staleFlash || r.regressed) bad++;
    } else {
      await gotoHash(page, hop);
      await page.waitForTimeout(120);
    }
  }
  return [bad === 0 && checked === 3
    ? { name: "rapid navigation (<1.2s hops)", verdict: "PASS", detail: `3 returns to /tasks all correct (t=${timings.join(",")}ms)` }
    : { name: "rapid navigation (<1.2s hops)", verdict: "FAIL", detail: `${bad} bad of 3 returns (judged ${checked}); timings ${timings.join(",")}ms` }];
}

/**
 * Consecutive writes: five mutations back to back, checking that a later
 * network response never restores an earlier version of the data.
 */
export async function consecutiveWrites(page: Page, rig: Rig): Promise<Result[]> {
  const out: Result[] = [];
  const control = needle("CtlSeq");
  await chat(page, `##create_task {"title":"${control}"}`);

  const t1 = needle("SeqTask");
  const e1 = needle("SeqExp");
  const t2 = needle("SeqRenamed");
  const l1 = needle("SeqLiab");

  await chat(page, `##create_task {"title":"${t1}"}`);
  await chat(page, `##create_expense {"description":"${e1}","amount":11,"category":"Food"}`);
  await chat(page, `##update_task {"title":"${t1}","changes":{"title":"${t2}"}}`);
  await chat(page, `##create_liability {"name":"${l1}","amount":2500,"liabilityType":"loan"}`);
  await chat(page, `##delete_expense {"description":"${e1}"}`);

  // The renamed task must show the NEW title and never revert to the old one.
  const renamed = await navigateAndRecord(page, "/tasks", '[data-testid="page-tasks"]', t2, { settleMs: 2500, control });
  const oldTitle = await navigateAndRecord(page, "/tasks", '[data-testid="page-tasks"]', t1, { settleMs: 2500, control });
  out.push(renamed.presentOnFirstPopulatedRender && !renamed.regressed
    ? { name: "consecutive: rename visible and stable", verdict: "PASS", detail: `t=${renamed.firstPopulated?.t}ms, never reverted` }
    : { name: "consecutive: rename visible and stable", verdict: "FAIL", detail: JSON.stringify({ first: renamed.firstPopulated, regressed: renamed.regressed }) });
  out.push(oldTitle.frames.every((f) => !f.present)
    ? { name: "consecutive: old title never reappears", verdict: "PASS", detail: "absent in every frame" }
    : { name: "consecutive: old title never reappears", verdict: "FAIL", detail: "an older response restored the pre-rename title" });

  const liab = await navigateAndRecord(page, "/liabilities", '[data-testid="button-create-liability"]', l1, { settleMs: 2000 });
  out.push(liab.presentOnFirstPopulatedRender
    ? { name: "consecutive: liability visible", verdict: "PASS", detail: `t=${liab.firstPopulated?.t}ms` }
    : { name: "consecutive: liability visible", verdict: liab.firstPopulated ? "FAIL" : "INCONCLUSIVE", detail: JSON.stringify(liab.firstPopulated) });

  const gone = await navigateAndRecord(page, "/dashboard", '[data-testid="page-dashboard"]', e1, { settleMs: 2000 });
  out.push(gone.frames.every((f) => !f.present)
    ? { name: "consecutive: deleted expense stays gone", verdict: "PASS", detail: "absent in every frame" }
    : { name: "consecutive: deleted expense stays gone", verdict: "FAIL", detail: "the deleted row came back" });
  return out;
}

/** Cross-tab: a write in tab A must reach tab B with no reload. */
export async function crossTab(browser: Browser, rig: Rig, makePage: () => Promise<Page>): Promise<Result[]> {
  const out: Result[] = [];
  const a = await makePage();
  const b = await makePage();
  await gotoHash(b, "/tasks");
  await b.waitForSelector('[data-testid="page-tasks"]', { timeout: 15000 });
  await b.waitForTimeout(800);

  const n = needle("XTab");
  await chat(a, `##create_task {"title":"${n}"}`);
  // Tab B is untouched: no navigation, no reload. The cache bus broadcast is
  // the only thing that can put the row on screen.
  const appeared = await b.waitForFunction(
    `document.body.innerText.indexOf(${JSON.stringify(n)}) !== -1`,
    undefined, { timeout: 6000 },
  ).then(() => true).catch(() => false);
  out.push(appeared
    ? { name: "cross-tab A → B (no reload)", verdict: "PASS", detail: "row appeared in the second tab" }
    : { name: "cross-tab A → B (no reload)", verdict: "FAIL", detail: "second tab never updated without a reload" });

  const n2 = needle("XTabRev");
  await gotoHash(a, "/tasks");
  await a.waitForTimeout(500);
  await chat(b, `##create_task {"title":"${n2}"}`);
  await gotoHash(a, "/tasks");
  const appeared2 = await a.waitForFunction(
    `document.body.innerText.indexOf(${JSON.stringify(n2)}) !== -1`,
    undefined, { timeout: 6000 },
  ).then(() => true).catch(() => false);
  out.push(appeared2
    ? { name: "cross-tab B → A (no reload)", verdict: "PASS", detail: "row appeared in the first tab" }
    : { name: "cross-tab B → A (no reload)", verdict: "FAIL", detail: "first tab never updated without a reload" });

  await a.close();
  await b.close();
  return out;
}

/** Reload consistency: what a reload shows must equal what was already shown. */
export async function reloadConsistency(page: Page, rig: Rig): Promise<Result[]> {
  const n = needle("Reload");
  await chat(page, `##create_task {"title":"${n}"}`);
  await gotoHash(page, "/tasks");
  await page.waitForSelector('[data-testid="page-tasks"]', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const before = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="page-tasks"]');
    return (el ? el.innerText : "").replace(/\\s+/g, " ").trim();
  })()`) as string;

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="page-tasks"]', { timeout: 20000 });
  await page.waitForTimeout(2500);
  const after = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="page-tasks"]');
    return (el ? el.innerText : "").replace(/\\s+/g, " ").trim();
  })()`) as string;

  const bothHave = before.includes(n) && after.includes(n);
  // Compare the set of task titles rather than raw text: relative timestamps
  // ("2 minutes ago") legitimately differ across a reload.
  const titles = (s: string) => (s.match(/\b(?:Acc|Ctl|Seq|Bob|Any|Rap|Fast|Reload|XTab|Cyc)[a-z0-9]+/g) || []).sort().join(",");
  const same = titles(before) === titles(after);
  return [bothHave && same
    ? { name: "reload shows exactly what was already displayed", verdict: "PASS", detail: "same row set before and after reload" }
    : { name: "reload shows exactly what was already displayed", verdict: "FAIL", detail: bothHave ? "row set changed across reload" : "row missing on one side of the reload" }];
}

/** Ten consecutive write→navigate cycles, all of which must pass. */
export async function repeatedCycles(page: Page, rig: Rig, count = 10): Promise<Result[]> {
  const control = needle("CtlCyc");
  await chat(page, `##create_task {"title":"${control}"}`);
  const failures: string[] = [];
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const n = needle("Cyc");
    await chat(page, `##create_task {"title":"${n}"}`);
    const r = await navigateAndRecord(page, "/tasks", '[data-testid="page-tasks"]', n, { settleMs: 900, control });
    if (!r.firstPopulated) { failures.push(`#${i + 1}: list never painted`); continue; }
    times.push(r.firstPopulated.t);
    if (!r.presentOnFirstPopulatedRender) failures.push(`#${i + 1}: absent at t=${r.firstPopulated.t}ms`);
    else if (r.regressed) failures.push(`#${i + 1}: removed by a later response`);
    // Leave and come back — the row must survive the round trip.
    await gotoHash(page, "/dashboard");
    await page.waitForTimeout(120);
    const again = await navigateAndRecord(page, "/tasks", '[data-testid="page-tasks"]', n, { settleMs: 600, control });
    if (!again.presentOnFirstPopulatedRender) failures.push(`#${i + 1}: disappeared after navigating away and back`);
  }
  return [failures.length === 0
    ? { name: `${count} consecutive write→navigate cycles`, verdict: "PASS", detail: `all correct; first-render median ${times.sort((a, b) => a - b)[Math.floor(times.length / 2)]}ms` }
    : { name: `${count} consecutive write→navigate cycles`, verdict: "FAIL", detail: failures.join("; ") }];
}

/**
 * Dashboard bootstrap.
 *
 * /api/dashboard-bootstrap is the dashboard's first paint AND the seed for ~24
 * dependent list caches, and it is persisted to localStorage. The specific risk
 * is that a PRE-write copy — cached server-side under the old version key, or
 * restored from localStorage on the next launch — gets served or re-seeded
 * after a write. So: warm it before the write (creating exactly such a
 * pre-write entry), write, then read what the dashboard actually receives.
 */
export async function dashboardBootstrap(page: Page, rig: Rig): Promise<Result[]> {
  await gotoHash(page, "/dashboard");
  await page.waitForSelector('[data-testid="page-dashboard"]', { timeout: 15000 });
  await page.waitForTimeout(1200); // a pre-write bootstrap is now cached server-side

  const n = needle("Boot");
  await chat(page, `##create_task {"title":"${n}"}`);

  rig.captured.length = 0;
  rig.setCapture(/\/api\/dashboard-bootstrap/);
  await navigateAndRecord(page, "/dashboard", '[data-testid="page-dashboard"]', n, { settleMs: 2000 });
  rig.setCapture(null);

  const responses = rig.captured;
  if (responses.length === 0) {
    return [{ name: "dashboard-bootstrap cannot serve pre-write data", verdict: "INCONCLUSIVE", detail: "no bootstrap request was made on this navigation" }];
  }
  const stale = responses.filter((r) => !(r.body || "").includes(n));
  return [stale.length === 0
    ? { name: "dashboard-bootstrap cannot serve pre-write data", verdict: "PASS", detail: `${responses.length} bootstrap response(s), all post-write` }
    : { name: "dashboard-bootstrap cannot serve pre-write data", verdict: "FAIL", detail: `${stale.length}/${responses.length} bootstrap responses were PRE-write` }];
}

/**
 * Upload and extraction.
 *
 * These paths carry the version barrier and the read-your-writes token but NOT
 * a precise manifest, so they fall back to the blanket refresh. The question is
 * only whether that still leaves newly extracted data invisible until a manual
 * refresh — the old behaviour.
 */
export async function uploadPath(page: Page, rig: Rig): Promise<Result[]> {
  const out: Result[] = [];
  const before = (await rig.storage.getDocuments()).length;
  const name = `Upload${Date.now().toString(36)}.txt`;

  await gotoHash(page, "/chat");
  // The input is deliberately class="hidden" — wait for it to EXIST, not to be
  // visible, or the wait can never succeed.
  await page.waitForSelector('[data-testid="input-file"]', { timeout: 15000, state: "attached" });
  await page.setInputFiles('[data-testid="input-file"]', {
    name,
    mimeType: "text/plain",
    buffer: Buffer.from("Acceptance rig upload. Policy number A-12345. Total due $42.00."),
  });
  // Attaching swaps the composer for the guided destination picker, so the
  // send control is a different button from the one a text turn uses.
  await page.waitForSelector('[data-testid="button-send-attachment"]', { timeout: 15000 });
  await page.click('[data-testid="button-send-attachment"]');
  const landed = await page.waitForFunction(
    `document.querySelectorAll("[data-testid^='message-']").length > 1`,
    undefined, { timeout: 90000 },
  ).then(() => true).catch(() => false);

  const after = (await rig.storage.getDocuments()).length;
  if (after <= before) {
    return [{ name: "single document upload", verdict: "RIG", detail: `upload did not create a document (${before} → ${after}); chat echoed name: ${landed}` }];
  }
  const doc = (await rig.storage.getDocuments()).slice(-1)[0];
  const docName = String(doc?.name || name);

  // Navigate straight to the documents surface — no refresh, no waiting.
  const r = await navigateAndRecord(page, "/linked?tab=documents", '[data-testid="page-trackers"]', docName, { settleMs: 3000 });
  if (!r.firstPopulated) {
    out.push({ name: "single document upload", verdict: "INCONCLUSIVE", detail: "documents surface never rendered content" });
  } else {
    out.push(r.frames.some((f) => f.present)
      ? { name: "single document upload", verdict: "PASS", detail: `document visible without a refresh (t=${r.frames.find((f) => f.present)!.t}ms; first render: ${r.presentOnFirstPopulatedRender})` }
      : { name: "single document upload", verdict: "FAIL", detail: "uploaded document never appeared without a refresh" });
  }
  return out;
}
