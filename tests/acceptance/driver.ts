// Browser-side helpers for the acceptance run.
//
// The whole test hinges on ONE measurement: at the moment of the FIRST render
// after navigation, is the new row on screen? So navigation here never waits for
// the network and never refreshes — it clicks/pushes, then reads the DOM as soon
// as React has painted, and separately watches for a "stale flash" (old state
// rendered first, replaced by new state a moment later).
import type { Page } from "playwright-core";

export const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/**
 * Send a chat message and resolve when the turn's response has been applied.
 *
 * /api/chat is rate limited to 20 turns per minute per user (routes.ts). An
 * acceptance run makes far more than that, and a throttled turn still posts an
 * assistant bubble — so without this the run would sail on measuring writes
 * that never happened and report them as UI failures. Detect the throttle, wait
 * out the window, and retry.
 */
export async function chat(page: Page, message: string, attempt = 0): Promise<void> {
  await gotoHash(page, "/chat");
  await page.waitForSelector('[data-testid="input-chat"]', { timeout: 15000 });
  await page.fill('[data-testid="input-chat"]', message);
  const before = await page.evaluate(() => document.querySelectorAll("[data-testid^='message-']").length);
  await page.click('[data-testid="button-send"]');
  await page.waitForFunction(
    (n) => document.querySelectorAll("[data-testid^='message-']").length > (n as number) + 1,
    before,
    { timeout: 40000 },
  );
  // The response has landed and applyChatMutations has run synchronously in the
  // same task as onSuccess. No sleep: waiting would defeat the point.
  const throttled = await page.evaluate(`(() => {
    const nodes = document.querySelectorAll("[data-testid^='message-']");
    const last = nodes[nodes.length - 1];
    const t = last ? (last.textContent || "") : "";
    return t.indexOf("Too many requests") !== -1 || t.indexOf("429") !== -1 || t.indexOf("short break") !== -1;
  })()`);
  if (throttled) {
    if (attempt >= 3) throw new Error("chat still rate limited after 3 waits");
    await page.waitForTimeout(31000); // the limiter's window is 60s; half of it plus slack
    return chat(page, message, attempt + 1);
  }
}

/** Hash-router navigation. Deliberately no waitForLoadState — we want first paint. */
export async function gotoHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => { window.location.hash = `#${h}`; }, hash);
}

/**
 * Navigate and record EVERY rendered frame until the page settles.
 *
 * This is the measurement the whole acceptance run rests on, so it is
 * deliberately unforgiving:
 *   · no waiting before reading — sampling starts on the next animation frame
 *   · no refresh, ever
 *   · every frame is kept, so a "stale flash" (old state painted first, new
 *     state swapped in later) and a regression (new state painted, then an
 *     older network response overwrites it) are both visible in the series.
 *
 * `marker` identifies that the target page has actually mounted; frames before
 * that are "not rendered yet" and are excluded from the first-render verdict.
 */
export interface FrameSeries {
  frames: Array<{ t: number; mounted: boolean; present: boolean; populated: boolean }>;
  /** First frame where the destination view had rendered LIST CONTENT. */
  firstPopulated: { t: number; present: boolean } | null;
  /** First frame where the destination view was mounted at all. */
  firstMounted: { t: number; present: boolean } | null;
  /** Was the row there the moment the list first had content? */
  presentOnFirstPopulatedRender: boolean;
  /** The list rendered WITHOUT the row, then the row appeared. The real bug. */
  staleFlash: boolean;
  /** The row rendered, then a later response removed it. */
  regressed: boolean;
  /** The view mounted empty (no list content yet) before painting content. */
  loadedLate: boolean;
}

/**
 * Navigate and record every rendered frame.
 *
 * `control` is a string known to already be in this list (an item created
 * earlier in the run). It is what makes the verdict honest: without it, "the
 * list rendered but is missing the new row" (the reported bug) and "the list
 * has not rendered yet" (an ordinary loading state) look identical — both are
 * simply "needle absent". With it:
 *
 *   control present, needle absent   → STALE: the user is looking at old data
 *   control absent,  needle absent   → the list has not painted yet
 *
 * Pass an empty control only when the list is genuinely expected to be empty.
 */
export async function navigateAndRecord(
  page: Page,
  hash: string,
  marker: string,
  needle: string,
  opts: { settleMs?: number; control?: string } = {},
): Promise<FrameSeries> {
  const settleMs = opts.settleMs ?? 2500;
  const control = opts.control ?? "";
  // NOTE: the sampler is sent as a SOURCE STRING, not a function. tsx/esbuild
  // rewrites function declarations with a `__name` helper that does not exist
  // in the page, so a serialized closure throws ReferenceError on arrival.
  const script = `(async () => {
    const frames = [];
    const t0 = performance.now();
    let stop = false;
    const marker = ${JSON.stringify(marker)};
    const needle = ${JSON.stringify(needle)};
    const control = ${JSON.stringify(control)};
    // Read only from the app's PAGE CONTAINERS, never document.body.
    //
    // Toasts are portaled to the body, and the undo toast carries the deleted
    // item's own name for eight seconds — reading the whole body made a freshly
    // deleted row look present on every surface. Scoping to the marker element
    // was worse: several markers are BUTTONS (the liabilities tab is identified
    // by its "Add liability" button), whose text can never contain the needle,
    // so those pages read as "never rendered". Listing the page roots is
    // unambiguous: every surface under test lives inside one of them, and no
    // toast does.
    const PAGE_ROOTS = '[data-testid^="page-"], [data-testid="hub-shell"], [data-testid="calendar-page"], [data-testid="executive-briefing"], [data-testid="wellness-overview"]';
    const pageText = () => {
      const roots = document.querySelectorAll(PAGE_ROOTS);
      if (roots.length === 0) return "";
      let out = "";
      roots.forEach((el) => { out += " " + (el.innerText || ""); });
      return out;
    };
    const sample = () => {
      const mounted = !!document.querySelector(marker);
      const text = pageText();
      const present = text.indexOf(needle) !== -1;
      const populated = control ? (text.indexOf(control) !== -1 || present) : true;
      frames.push({ t: Math.round(performance.now() - t0), mounted: mounted, present: present, populated: populated });
      if (!stop) requestAnimationFrame(sample);
    };
    window.location.hash = ${JSON.stringify("#" + hash)};
    requestAnimationFrame(sample);
    await new Promise((r) => setTimeout(r, ${settleMs}));
    stop = true;
    return frames;
  })()`;
  const series = (await page.evaluate(script)) as FrameSeries["frames"];

  const mounted = series.filter((f) => f.mounted);
  const populated = mounted.filter((f) => f.populated);
  const firstMounted = mounted.length ? { t: mounted[0].t, present: mounted[0].present } : null;
  const firstPopulated = populated.length ? { t: populated[0].t, present: populated[0].present } : null;

  let sawPresent = false;
  let regressed = false;
  for (const f of populated) {
    if (f.present) sawPresent = true;
    else if (sawPresent) regressed = true;
  }
  const staleFlash = !!firstPopulated && !firstPopulated.present && sawPresent;
  const loadedLate = !!firstMounted && !!firstPopulated && firstPopulated.t > firstMounted.t;

  return {
    frames: series,
    firstPopulated,
    firstMounted,
    presentOnFirstPopulatedRender: !!firstPopulated?.present,
    staleFlash,
    regressed,
    loadedLate,
  };
}

/** Perf marks recorded by the instrumentation added with the fix. */
export async function perfMarks(page: Page): Promise<Array<{ name: string; ms: number }>> {
  return page.evaluate(() => (window as any).__portolPerf?.() ?? []);
}

export async function visibleText(page: Page): Promise<string> {
  return ((await page.textContent("body")) || "").replace(/\s+/g, " ");
}
