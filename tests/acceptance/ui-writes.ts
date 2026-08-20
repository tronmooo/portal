// UI writes — the path the user actually uses most.
//
// Everything measured so far went through /api/chat. Adding, editing and
// deleting from the interface goes through ~600 ordinary REST mutation call
// sites instead, and those got none of the chat path's machinery: no
// read-your-writes token on the response, and (at most call sites) no row-level
// cache patch — just an invalidate and a wait for the network.
//
// These checks drive the real buttons and measure the same property: is the
// change reflected everywhere, immediately, without a refresh?
import type { Page } from "playwright-core";
import type { Rig } from "./rig";
import { navigateAndRecord, gotoHash } from "./driver";
import type { Result } from "./suites";
import { needle } from "./suites";

async function openTasks(page: Page) {
  await gotoHash(page, "/tasks");
  await page.waitForSelector('[data-testid="page-tasks"]', { timeout: 15000 });
}

/** Create a task through the UI form and return its title. */
async function createTaskViaUi(page: Page, title: string) {
  await openTasks(page);
  await page.click('[data-testid="button-new-task"]');
  await page.waitForSelector('[data-testid="input-task-title"]', { timeout: 10000 });
  await page.fill('[data-testid="input-task-title"]', title);
  await page.click('[data-testid="button-submit-task"]');
  await page.waitForFunction(
    `document.body.innerText.indexOf(${JSON.stringify(title)}) !== -1`,
    undefined, { timeout: 20000 },
  );
}

export async function uiCreate(page: Page, rig: Rig): Promise<Result[]> {
  const control = needle("UiCtl");
  await createTaskViaUi(page, control);
  const n = needle("UiAdd");
  await createTaskViaUi(page, n);

  const row = (await rig.storage.getTasks()).find((t: any) => String(t.title).includes(n));
  if (!row) return [{ name: "UI create", verdict: "RIG", detail: "the form did not write the task" }];

  // Navigate away and straight back — no refresh, no waiting.
  await gotoHash(page, "/dashboard");
  await page.waitForTimeout(150);
  const r = await navigateAndRecord(page, "/tasks", '[data-testid="page-tasks"]', n, { settleMs: 2500, control });
  if (!r.firstPopulated) return [{ name: "UI create", verdict: "RIG", detail: "tasks list never painted" }];
  if (r.staleFlash) {
    const firstYes = r.frames.find((f) => f.mounted && f.present)!;
    return [{ name: "UI create", verdict: "FAIL", detail: `STALE: list had content without the new task at t=${r.firstPopulated.t}ms, it appeared at t=${firstYes.t}ms` }];
  }
  if (r.regressed) return [{ name: "UI create", verdict: "FAIL", detail: "task rendered, then a later response removed it" }];
  return [{ name: "UI create", verdict: "PASS", detail: `present when the list first had content, t=${r.firstPopulated.t}ms` }];
}

export async function uiEdit(page: Page, rig: Rig): Promise<Result[]> {
  const control = needle("UiCtlE");
  await createTaskViaUi(page, control);
  const original = needle("UiOrig");
  await createTaskViaUi(page, original);

  const row = (await rig.storage.getTasks()).find((t: any) => String(t.title).includes(original));
  if (!row) return [{ name: "UI edit", verdict: "RIG", detail: "setup task not written" }];

  // Toggle the task done through its checkbox — the most common edit there is.
  await openTasks(page);
  await page.click(`[data-testid="checkbox-task-${row.id}"]`);
  await page.waitForTimeout(400);

  const after = (await rig.storage.getTasks()).find((t: any) => t.id === row.id);
  if (after?.status !== "done") {
    return [{ name: "UI edit", verdict: "RIG", detail: `checkbox did not persist (status=${after?.status})` }];
  }

  // The Open tab must no longer contain it, immediately, on first render.
  await gotoHash(page, "/dashboard");
  await page.waitForTimeout(150);
  await openTasks(page);
  await page.click('[data-testid="tab-open"]');
  const r = await navigateAndRecord(page, "/tasks", '[data-testid="page-tasks"]', original, { settleMs: 2500, control });
  const shownAfterEdit = r.frames.filter((f) => f.mounted && f.present).length;
  return [shownAfterEdit === 0
    ? { name: "UI edit propagates", verdict: "PASS", detail: "completed task gone from the open list in every frame" }
    : { name: "UI edit propagates", verdict: "FAIL", detail: `completed task still listed as open in ${shownAfterEdit} frame(s)` }];
}

/**
 * UI delete — the sharpest complaint: "when I delete something it shows up
 * somewhere else, it takes time for it to be deleted throughout my entire app."
 * So this checks the row is gone from EVERY surface that showed it, on the
 * first render, with no refresh.
 */
export async function uiDelete(page: Page, rig: Rig): Promise<Result[]> {
  const out: Result[] = [];
  const control = needle("UiCtlD");
  await createTaskViaUi(page, control);
  const doomed = needle("UiDel");
  await createTaskViaUi(page, doomed);

  const row = (await rig.storage.getTasks()).find((t: any) => String(t.title).includes(doomed));
  if (!row) return [{ name: "UI delete", verdict: "RIG", detail: "setup task not written" }];

  // Warm the other surfaces FIRST so they hold a pre-delete copy — that is the
  // state in which "it still shows up somewhere else" actually happens.
  await navigateAndRecord(page, "/dashboard", '[data-testid="page-dashboard"]', doomed, { settleMs: 900 });
  await navigateAndRecord(page, "/calendar", '[data-testid="calendar-page"]', doomed, { settleMs: 900 });

  await openTasks(page);
  await page.click(`[data-testid="button-delete-task-${row.id}"]`);
  await page.waitForSelector('[data-testid="button-confirm-delete-task"]', { timeout: 10000 });
  await page.click('[data-testid="button-confirm-delete-task"]');
  await page.waitForFunction(
    `document.body.innerText.indexOf(${JSON.stringify(doomed)}) === -1`,
    undefined, { timeout: 20000 },
  ).catch(() => { /* judged below */ });

  const live = (await rig.storage.getTasks()).filter((t: any) => t.id === row.id && !t.deletedAt);
  if (live.length > 0) {
    return [{ name: "UI delete", verdict: "RIG", detail: "delete did not remove the row server-side" }];
  }

  // It must be gone everywhere, on first render, with no refresh.
  const surfaces: Array<[string, string, string]> = [
    ["tasks list", "/tasks", '[data-testid="page-tasks"]'],
    ["dashboard", "/dashboard", '[data-testid="page-dashboard"]'],
    ["calendar", "/calendar", '[data-testid="calendar-page"]'],
  ];
  for (const [label, route, marker] of surfaces) {
    const r = await navigateAndRecord(page, route, marker, doomed, { settleMs: 2500, control });
    const ghosts = r.frames.filter((f) => f.mounted && f.present);
    out.push(ghosts.length === 0
      ? { name: `UI delete gone from ${label}`, verdict: "PASS", detail: "absent in every frame" }
      : { name: `UI delete gone from ${label}`, verdict: "FAIL", detail: `deleted row still rendered in ${ghosts.length} frame(s), last at t=${ghosts[ghosts.length - 1].t}ms` });
  }
  return out;
}

// NOTE: a browser-level "a stale response resurrects the deleted row" test was
// tried here and removed. It passed with and without the tombstone logic — the
// local stack is too coherent to reproduce the ordering that causes it in
// production (one process, ~1ms network, warm caches). A test that cannot fail
// is worse than no test. The tombstone behaviour is pinned directly, and
// discriminatingly, in tests/write-sync.test.ts instead.
