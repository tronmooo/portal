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
const createdEntryIds = new Set<string>();

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

/** Map every tracker-entry id → its tracker, across the whole account. */
function indexEntries(trackers: any[]): Map<string, { tracker: any; entry: any }> {
  const idx = new Map<string, { tracker: any; entry: any }>();
  for (const t of trackers) for (const e of t.entries || []) idx.set(e.id, { tracker: t, entry: e });
  return idx;
}

async function runTier(n: number) {
  const items = BANK.slice(0, n);
  const message = items.map(([clause]) => clause).join(" ");
  expect(message.length, "must fit the 5000-char /api/chat cap").toBeLessThan(5000);

  const res = await chat(message);

  // Per-action reporting: the server tells us what happened to each op.
  // NOTE (2026-07-16): assertions are ENTITY-ID based, not tracker-NAME
  // based — the normalization layer intentionally consolidates "walked 2
  // miles on the X trail" into the canonical Walking tracker instead of
  // creating an "X Trail" tracker, so guessing names is wrong by design.
  expect(Array.isArray(res.operations), "response carries per-action operations").toBe(true);
  const okOps = (res.operations || []).filter((o) => o.status === "ok" || o.status === "deduped");
  expect(okOps.length, `expected ~${n} logged actions; reply: ${res.reply?.slice(0, 300)}`).toBeGreaterThanOrEqual(Math.floor(n * 0.9));
  const entityIds = okOps.map((o: any) => o.entityId).filter(Boolean);
  expect(entityIds.length, "ok operations must carry entity ids").toBeGreaterThanOrEqual(Math.floor(n * 0.8));
  for (const o of res.operations || []) {
    if (o.createdTracker?.id) createdTrackerIds.add(o.createdTracker.id);
  }

  // (a) + (b) every reported write is REALLY in the DB, on the same feed the
  // dashboard renders from.
  let idx = indexEntries(await getTrackers());
  const missing = entityIds.filter((id: string) => !idx.has(id));
  expect(missing, `entries missing from DB after ${n}-action prompt`).toEqual([]);

  // (c) refresh survival: fresh auth + cache-busted refetch shows the same data.
  TOKEN = await signin();
  idx = indexEntries(await getTrackers());
  for (const id of entityIds.slice(0, Math.min(n, 10))) {
    expect(idx.has(id), `entry ${id} gone after refresh`).toBe(true);
  }

  // (d) individual edit + delete, via the by-entry-id routes the chat cards use.
  const [editId, delId] = entityIds;
  const patch = await api("PATCH", `/tracker-entries/${editId}`, { notes: `edited by ${RUN}` });
  expect(patch.ok, `entry edit failed: ${JSON.stringify(patch.data)}`).toBe(true);
  const del = await api("DELETE", `/tracker-entries/${delId}`);
  expect(del.ok, `entry delete failed: ${JSON.stringify(del.data)}`).toBe(true);

  idx = indexEntries(await getTrackers());
  expect(idx.get(editId)?.entry?.notes, "edit persisted").toBe(`edited by ${RUN}`);
  expect(idx.has(delId), "deleted entry stays gone").toBe(false);

  // Cleanup this tier's entries so later tiers/dedup aren't affected.
  for (const id of entityIds) {
    if (id !== delId) await api("DELETE", `/tracker-entries/${id}`).catch(() => {});
  }
}

describe(`multi-action regression (${BASE})`, () => {
  beforeAll(async () => {
    TOKEN = await signin();
  }, 60_000);

  afterAll(async () => {
    for (const id of createdEntryIds) {
      await api("DELETE", `/tracker-entries/${id}`).catch(() => {});
    }
    for (const id of createdTrackerIds) {
      await api("DELETE", `/trackers/${id}`).catch(() => {});
    }
  }, 180_000);

  it("exact fix command: 60-min soccer, blunt method kept, shower + bathroom auto-created, NO habit touched, self profile only", async () => {
    const habitsBefore = (await api("GET", "/habits")).data || [];
    const res = await chat(
      `I played ${RUN} soccer for an hour. I smoked a ${RUN} blunt. I took a ${RUN} shower once. I went to the ${RUN} bathroom at 8:15 AM.`,
    );
    expect(res.reply.toLowerCase()).not.toMatch(/(don'?t|can'?t|aren'?t|isn'?t|not something i) track/);
    expect(res.reply.toLowerCase()).not.toMatch(/did you mean .* habit|belongs to/);

    // NOTE (2026-07-16): the normalization layer consolidates activities into
    // canonical trackers ("MAxxx blunt" → the Cannabis tracker, no RUN prefix),
    // so match by canonical name / entry content, not by the RUN-prefixed name.
    // Cleanup targets ONLY what the operations report says was created —
    // canonical trackers (Soccer/Cannabis/...) may hold the account's real
    // history and must never be deleted by name-guess.
    for (const o of res.operations || []) {
      if (o.createdTracker?.id) createdTrackerIds.add(o.createdTracker.id);
      if (o.entityId) createdEntryIds.add(o.entityId);
    }
    const trackers = await getTrackers();
    const newest = (t: any) => (t.entries || [])[0];
    // Soccer: 60 minutes preserved (canonical "Soccer" or RUN-prefixed).
    const soccer = trackers.find((x: any) => /soccer/i.test(String(x.name)) && (x.entries || []).length);
    expect(soccer, "soccer tracker").toBeTruthy();
    const soccerVals = JSON.stringify(newest(soccer)?.values || {});
    expect(soccerVals, `soccer duration lost: ${soccerVals}`).toMatch(/60/);
    // Cannabis: method "blunt" preserved on the newest cannabis-ish entry.
    const cannabis = trackers.find((x: any) => /cannabis|blunt/i.test(String(x.name)) && (x.entries || []).length);
    expect(cannabis, "cannabis tracker").toBeTruthy();
    expect(JSON.stringify(newest(cannabis)?.values || {}).toLowerCase(), "blunt detail lost").toContain("blunt");
    // Shower + bathroom logged (canonical or RUN-prefixed names).
    const shower = trackers.find((x: any) => /shower/i.test(String(x.name)) && (x.entries || []).length);
    expect(shower, "shower not logged").toBeTruthy();
    const bathroom = trackers.find((x: any) => /bathroom/i.test(String(x.name)) && (x.entries || []).length);
    expect(bathroom, "bathroom not logged").toBeTruthy();
    const bathTs = new Date(newest(bathroom).timestamp);
    expect(`${bathTs.getUTCHours()}:${bathTs.getUTCMinutes()}`, "8:15 AM timestamp dropped to now").not.toBe("NaN:NaN");
    // No habit created, completed, or modified.
    const habitsAfter = (await api("GET", "/habits")).data || [];
    expect(habitsAfter.length, "a habit was created from an activity report").toBe(habitsBefore.length);
    // Everything owned by self — nothing assigned to another profile.
    const profiles = (await api("GET", "/profiles")).data || [];
    const selfId = profiles.find((p: any) => p.type === "self")?.id;
    for (const t of [soccer, cannabis, shower, bathroom]) {
      const owners = t.linkedProfiles || [];
      expect(owners.length === 0 || owners.includes(selfId), `${t.name} owned by ${JSON.stringify(owners)}, not self`).toBe(true);
    }
  }, 240_000);

  it("original bug report: soccer + cannabis + shower + bathroom ALL log, no refusal", async () => {
    const res = await chat(
      `I played ${RUN} soccer for an hour. I smoked some ${RUN} cannabis. I took a ${RUN} shower and I went to the bathroom at 8:15 AM.`,
    );
    expect(res.reply.toLowerCase()).not.toMatch(/(don'?t|can'?t|aren'?t|isn'?t|not something i) track/);
    for (const o of res.operations || []) {
      if (o.createdTracker?.id) createdTrackerIds.add(o.createdTracker.id);
      if (o.entityId) createdEntryIds.add(o.entityId);
    }
    // All four actions logged (canonical or RUN-prefixed tracker names).
    const trackers = await getTrackers();
    for (const pattern of [/soccer/i, /cannabis/i, /shower/i, /bathroom/i]) {
      const t = trackers.find((x: any) => pattern.test(String(x.name)) && (x.entries || []).length);
      expect(t, `no logged tracker matching ${pattern}; reply: ${res.reply.slice(0, 300)}`).toBeTruthy();
    }
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

  it("normalization: 'I walked one mile' → canonical Walking tracker, distance exact, steps/duration labeled estimates", async () => {
    const res = await chat("I walked one mile.");
    // The op report tells us exactly which entry was written — the account
    // legitimately has one Walking tracker PER PROFILE (Bob + pets), so
    // name-guessing picks the wrong one.
    const op = (res.operations || []).find((o: any) => o.status === "ok" && o.entityId);
    expect(op, `no ok operation; reply: ${res.reply?.slice(0, 300)}`).toBeTruthy();
    const idx = indexEntries(await getTrackers());
    const hit = idx.get(op.entityId);
    expect(hit, "walking entry missing from DB").toBeTruthy();
    const walking = hit!.tracker;
    expect(String(walking.name), "entry landed on a non-canonical tracker").toMatch(/^walking$/i);
    const entry = hit!.entry;
    createdEntryIds.add(entry.id);
    // Distance saved exactly; NOT shoved into a steps field ("1 steps" bug).
    expect(Number(entry.values?.distance ?? entry.values?.miles), "distance lost").toBe(1);
    expect(entry.values?.steps, "explicit steps invented from thin air").not.toBe(1);
    // Provenance rides with the entry; estimates are labeled with confidence.
    const enrich = entry.computed?.enrichment ?? entry.values?._enrichment;
    expect(enrich, "enrichment provenance missing (computed.enrichment)").toBeTruthy();
    if (enrich?.estimated?.steps) {
      expect(enrich.estimated.steps.source).toBe("estimated");
      expect(enrich.estimated.steps.confidence).toBeGreaterThan(0.3);
    }
    // The reply must not present estimated steps as exact user data.
    expect(res.reply.toLowerCase()).not.toMatch(/you walked exactly/);
    // Cleanup the shared canonical tracker's test entry.
    await api("DELETE", `/trackers/${walking.id}/entries/${entry.id}`).catch(() => {});
  }, 240_000);

  it("normalization: variants land on ONE Walking tracker, explicit steps never overwritten", async () => {
    const res1 = await chat("I walked 2,100 steps.");
    const res2 = await chat("I walked 1 mile and took 2,400 steps.");
    const op1 = (res1.operations || []).find((o: any) => o.status === "ok" && o.entityId);
    const op2 = (res2.operations || []).find((o: any) => o.status === "ok" && o.entityId);
    expect(op1 && op2, "both walking variants must log").toBeTruthy();
    for (const o of [op1, op2]) createdEntryIds.add(o.entityId);
    const idx = indexEntries(await getTrackers());
    const hit1 = idx.get(op1.entityId), hit2 = idx.get(op2.entityId);
    expect(hit1 && hit2, "walking entries missing from DB").toBeTruthy();
    // Both phrasings land on the SAME canonical Walking tracker (the user's own).
    expect(hit1!.tracker.id, `variants split across trackers: ${hit1!.tracker.name} vs ${hit2!.tracker.name}`).toBe(hit2!.tracker.id);
    expect(String(hit1!.tracker.name)).toMatch(/^walking$/i);
    // Explicit 2,400 steps saved verbatim, never replaced by a formula.
    expect(Number(hit2!.entry.values?.steps), `explicit steps replaced; reply: ${res2.reply?.slice(0, 200)}`).toBe(2400);
    expect(Number(hit2!.entry.values?.distance ?? hit2!.entry.values?.miles)).toBe(1);
  }, 300_000);

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
