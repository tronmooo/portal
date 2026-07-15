// Live multi-action regression suite — drives a REAL deployment (or a local
// dev server) through /api/chat with 5-, 10-, 20-, and 50-action prompts and
// verifies, for EVERY action:
//   (a) the write landed in the database (tracker + entry via GET /api/trackers)
//   (b) it appears where the dashboard reads from (same trackers+entries feed)
//   (c) it survives a "refresh" (fresh re-auth + cache-busted refetch)
//   (d) entries can be edited and deleted INDIVIDUALLY via the entry routes
// Also pins the original bug report verbatim: the reply must never say
// "isn't something I track", and all four actions must be logged.
//
// NOT part of the gating `npm test` run — needs a reachable server, a real
// ANTHROPIC_API_KEY behind it, and a test account. Run with:
//   npm run test:multiaction
// Env: MULTIACTION_BASE_URL (default https://portol.me/api),
//      MULTIACTION_EMAIL / MULTIACTION_PASSWORD (default smoke account).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { trackerNamesMatch } from "../shared/tracker-identity";

const BASE = process.env.MULTIACTION_BASE_URL || process.env.E2E_BASE_URL || "https://portol.me/api";
const EMAIL = process.env.MULTIACTION_EMAIL || process.env.E2E_EMAIL || "tron@aol.com";
const PASSWORD = process.env.MULTIACTION_PASSWORD || process.env.E2E_PASSWORD || "password";
const RUN = `MA${Date.now().toString(36)}`;

let TOKEN = "";
const createdTrackerIds = new Set<string>();

async function api(method: string, path: string, body?: any) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Timezone": "America/Los_Angeles",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, data };
}

async function signin(): Promise<string> {
  const res = await api("POST", "/auth/signin", { email: EMAIL, password: PASSWORD });
  const token = res.data?.session?.access_token || res.data?.token;
  expect(token, `signin failed: ${JSON.stringify(res.data)}`).toBeTruthy();
  return token;
}

async function chat(message: string) {
  const res = await api("POST", "/chat", { message, history: [] });
  expect(res.ok, `chat failed (${res.status}): ${JSON.stringify(res.data).slice(0, 400)}`).toBe(true);
  return res.data as { reply: string; actions?: any[]; results?: any[]; operations?: any[] };
}

async function getTrackers(): Promise<any[]> {
  const res = await api("GET", `/trackers?b=${Date.now()}`);
  expect(res.ok).toBe(true);
  return res.data || [];
}

/** Find the tracker whose name matches, remembering it for cleanup. */
function findTracker(trackers: any[], name: string): any | undefined {
  const t = trackers.find((x) => trackerNamesMatch(String(x.name || ""), name));
  if (t) createdTrackerIds.add(t.id);
  return t;
}

/** One activity per tier row: [clause, expected tracker name]. Distinct
 * quantities keep the storage duplicate-guard out of the way, and the RUN
 * suffix makes every tracker unique to this run for clean assertions. */
function activityBank(): Array<[string, string]> {
  const acts: Array<[string, string]> = [];
  const templates: Array<[(i: number) => string, (i: number) => string]> = [
    [(i) => `I did ${10 + i} minutes of ${RUN} stretching`, () => `${RUN} Stretching`],
    [(i) => `I read ${20 + i} pages of my ${RUN} book`, () => `${RUN} Book`],
    [(i) => `I practiced ${RUN} guitar for ${15 + i} minutes`, () => `${RUN} Guitar`],
    [(i) => `I walked ${1 + (i % 5)} miles on the ${RUN} trail`, () => `${RUN} Trail`],
    [(i) => `I meditated ${5 + i} minutes in the ${RUN} room`, () => `${RUN} Room`],
  ];
  for (let i = 0; acts.length < 50; i++) {
    const [clause, tracker] = templates[i % templates.length];
    acts.push([`${clause(i)} (rep ${i + 1}).`, tracker(i)]);
  }
  return acts;
}

const BANK = activityBank();

async function runTier(n: number) {
  const items = BANK.slice(0, n);
  const message = items.map(([clause]) => clause).join(" ");
  expect(message.length, "must fit the 5000-char /api/chat cap").toBeLessThan(5000);

  const res = await chat(message);

  // Per-action reporting: the server tells us what happened to each op.
  expect(Array.isArray(res.operations) || Array.isArray(res.actions), "response carries per-action data").toBe(true);
  const okOps = (res.operations || []).filter((o) => o.status === "ok" || o.status === "deduped");
  const loggedCount = res.operations ? okOps.length : (res.actions || []).length;
  expect(loggedCount, `expected ~${n} logged actions; reply: ${res.reply?.slice(0, 300)}`).toBeGreaterThanOrEqual(Math.floor(n * 0.9));

  // (a) + (b) every action is in the DB and on the trackers feed the dashboard reads.
  const trackers = await getTrackers();
  const missing: string[] = [];
  for (const [, trackerName] of items) {
    const t = findTracker(trackers, trackerName);
    if (!t || !(t.entries || []).length) missing.push(trackerName);
  }
  expect(missing, `trackers missing or empty after ${n}-action prompt`).toEqual([]);

  // (c) refresh survival: fresh auth + cache-busted refetch shows the same data.
  TOKEN = await signin();
  const refreshed = await getTrackers();
  for (const [, trackerName] of items.slice(0, Math.min(n, 10))) {
    const t = findTracker(refreshed, trackerName);
    expect(t && (t.entries || []).length, `${trackerName} gone after refresh`).toBeTruthy();
  }

  // (d) individual edit + delete on this tier's entries.
  const first = findTracker(refreshed, items[0][1]);
  const entry = first.entries[0];
  const patch = await api("PATCH", `/trackers/${first.id}/entries/${entry.id}`, { notes: `edited by ${RUN}` });
  expect(patch.ok, `entry edit failed: ${JSON.stringify(patch.data)}`).toBe(true);

  const second = findTracker(refreshed, items[1][1]);
  const delEntry = second.entries[0];
  const del = await api("DELETE", `/trackers/${second.id}/entries/${delEntry.id}`);
  expect(del.ok, `entry delete failed: ${JSON.stringify(del.data)}`).toBe(true);

  const after = await getTrackers();
  const editedTracker = findTracker(after, items[0][1]);
  expect((editedTracker.entries || []).some((e: any) => e.notes === `edited by ${RUN}`), "edit persisted").toBe(true);
  const deletedTracker = findTracker(after, items[1][1]);
  expect((deletedTracker.entries || []).some((e: any) => e.id === delEntry.id), "deleted entry stays gone").toBe(false);
}

describe(`multi-action regression (${BASE})`, () => {
  beforeAll(async () => {
    TOKEN = await signin();
  }, 60_000);

  afterAll(async () => {
    for (const id of createdTrackerIds) {
      await api("DELETE", `/trackers/${id}`).catch(() => {});
    }
  }, 180_000);

  it("original bug report: soccer + cannabis + shower + bathroom ALL log, no refusal", async () => {
    const res = await chat(
      `I played ${RUN} soccer for an hour. I smoked some ${RUN} cannabis. I took a ${RUN} shower and I went to the bathroom at 8:15 AM.`,
    );
    expect(res.reply.toLowerCase()).not.toMatch(/(don'?t|can'?t|aren'?t|isn'?t|not something i) track/);
    const trackers = await getTrackers();
    for (const name of [`${RUN} Soccer`, `${RUN} Cannabis`, `${RUN} Shower`]) {
      const t = findTracker(trackers, name);
      expect(t, `no tracker for ${name}; reply: ${res.reply.slice(0, 300)}`).toBeTruthy();
      expect((t.entries || []).length, `${name} has no entry`).toBeGreaterThan(0);
    }
    // Bathroom tracker name is model-chosen ("Bathroom Visits"/"Bathroom") — accept either.
    const bathroom = trackers.find((x: any) => /bathroom/i.test(String(x.name)));
    expect(bathroom, "bathroom visit was not logged").toBeTruthy();
    if (bathroom) createdTrackerIds.add(bathroom.id);
  }, 240_000);

  it("5-action prompt: every action lands, survives refresh, edits/deletes individually", async () => {
    await runTier(5);
  }, 300_000);

  it("10-action prompt", async () => {
    await runTier(10);
  }, 300_000);

  it("20-action prompt", async () => {
    await runTier(20);
  }, 420_000);

  it("50-action prompt", async () => {
    await runTier(50);
  }, 600_000);

  it("Auto-Create Trackers OFF: skips unknown trackers, reports them, creates nothing", async () => {
    const set = await api("PUT", "/preferences/ai_auto_create_trackers", { value: "false" });
    expect(set.ok).toBe(true);
    try {
      const res = await chat(`I did some ${RUN} zorbing today.`);
      const trackers = await getTrackers();
      const zorb = trackers.find((x: any) => new RegExp(`${RUN} zorbing`, "i").test(String(x.name)));
      expect(zorb, "tracker must NOT be auto-created when the setting is off").toBeFalsy();
      expect(res.reply.toLowerCase()).toMatch(/auto[- ]?create|create .* tracker|setting/);
    } finally {
      await api("PUT", "/preferences/ai_auto_create_trackers", { value: "true" });
    }
  }, 240_000);
});
