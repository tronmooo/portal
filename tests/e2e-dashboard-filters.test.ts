/**
 * Part E — live end-to-end coverage for the dashboard profile filter / scope rule.
 *
 * This is the integration counterpart to the source-grep contract guards in
 * tests/dashboard-card-consistency.test.ts (Part A) and the unit test in
 * tests/auto-ownership-hook.test.ts (Part B). It exercises the real production
 * API at https://portol.me the same way api-e2e.test.ts does (signin → bearer
 * token → fetch), seeds a known three-person tree, then asserts the dashboard
 * surfaces agree per filter.
 *
 * The bug this pins: filtering the dashboard to one person used to show hero
 * Net Worth $0 while the Finance card / Net Worth popup showed the real number.
 * The scope rule (docs/dashboard-scope-contract.md) is that EVERY net-worth
 * surface reads financeSnapshot from /api/dashboard-enhanced. Here we verify
 * the snapshot itself partitions correctly by filter:
 *
 *   Self "Me"  : no assets/liabilities of its own            → net worth 0
 *   Jane Doe   : property 600k + mortgage 400k + 2 expenses  → net worth 200k
 *   Bob        : vehicle 30k + auto loan 10k + 1 expense     → net worth 20k
 *   Everyone   : sum of the above                            → 220k
 *
 * Because it talks to production it is NOT in vitest.config.ts's gating
 * `include` list — it runs via `npm run test:e2e` / explicit path, never on the
 * pre-push hook. Everything it creates is tagged with a per-run marker and torn
 * down in afterAll, so a failed assertion never leaves orphaned seed data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE = "https://portol.me/api";
let TOKEN = "";

// Unique per-run marker so concurrent runs / leftover rows never collide and
// cleanup only ever touches what THIS run created.
const RUN = `E2EFILTER_${Date.now().toString(36)}`;

async function api(method: string, path: string, body?: any) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, ok: r.ok, data: await r.json().catch(() => null) };
}

async function createProfile(p: {
  name: string;
  type: string;
  parentProfileId?: string;
  fields?: Record<string, any>;
}) {
  const r = await api("POST", "/profiles", { ...p, skipDupCheck: true });
  expect(r.status, `create profile ${p.name}: ${JSON.stringify(r.data)}`).toBe(201);
  expect(r.data?.id).toBeTruthy();
  return r.data.id as string;
}

async function createExpense(description: string, amount: number, linkedProfiles: string[]) {
  const r = await api("POST", "/expenses", {
    description: `${RUN} ${description}`,
    amount,
    category: "general",
    linkedProfiles,
  });
  expect(r.status, `create expense ${description}: ${JSON.stringify(r.data)}`).toBe(201);
  return r.data.id as string;
}

// Read the canonical net-worth pieces the way every UI surface now does.
async function snapshotFor(profileIds?: string[]) {
  const q = profileIds && profileIds.length ? `?profileIds=${profileIds.join(",")}` : "";
  const r = await api("GET", `/dashboard-enhanced${q}`);
  expect(r.status, `dashboard-enhanced${q}`).toBe(200);
  const snap = r.data?.financeSnapshot;
  expect(snap, "financeSnapshot missing on dashboard-enhanced response").toBeTruthy();
  return {
    assets: Number(snap.totalAssetValue) || 0,
    liabilities: Number(snap.totalLiabilities) || 0,
    netWorth: (Number(snap.totalAssetValue) || 0) - (Number(snap.totalLiabilities) || 0),
    raw: r.data,
  };
}

// Track everything we create so afterAll can delete it even on failure.
const createdProfiles: string[] = [];
const createdExpenses: string[] = [];

let SELF_ID = "";
let JANE_ID = "";
let BOB_ID = "";

const JANE_ASSET = 600_000;
const JANE_DEBT = 400_000;
const BOB_ASSET = 30_000;
const BOB_DEBT = 10_000;

describe("Part E — dashboard filter scope (live)", () => {
  beforeAll(async () => {
    const auth = await api("POST", "/auth/signin", { email: "tron@aol.com", password: "password" });
    expect(auth.ok, `signin failed: ${JSON.stringify(auth.data)}`).toBe(true);
    TOKEN = auth.data?.session?.access_token;
    expect(TOKEN).toBeTruthy();

    // The self profile already exists for this account; find it (do not create
    // a second self). Net worth filtered to Self alone must be 0 because we
    // attach nothing to it.
    const profs = await api("GET", "/profiles");
    expect(profs.status).toBe(200);
    const self = (profs.data as any[]).find((p) => p.type === "self");
    expect(self, "account has no self profile").toBeTruthy();
    SELF_ID = self.id;

    // Jane Doe (person) with a house + mortgage hung under her, and 2 expenses.
    JANE_ID = await createProfile({ name: `${RUN} Jane Doe`, type: "person" });
    createdProfiles.push(JANE_ID);
    createdProfiles.push(
      await createProfile({
        name: `${RUN} Jane House`,
        type: "property",
        parentProfileId: JANE_ID,
        fields: { currentValue: JANE_ASSET },
      }),
    );
    createdProfiles.push(
      await createProfile({
        name: `${RUN} Jane Mortgage`,
        type: "liability",
        parentProfileId: JANE_ID,
        fields: { currentBalance: JANE_DEBT },
      }),
    );
    createdExpenses.push(await createExpense("Jane groceries", 120, [JANE_ID]));
    createdExpenses.push(await createExpense("Jane utilities", 80, [JANE_ID]));

    // Bob (person) with a financed vehicle + auto loan, and 1 expense.
    BOB_ID = await createProfile({ name: `${RUN} Bob`, type: "person" });
    createdProfiles.push(BOB_ID);
    createdProfiles.push(
      await createProfile({
        name: `${RUN} Bob Car`,
        type: "vehicle",
        parentProfileId: BOB_ID,
        fields: { currentValue: BOB_ASSET },
      }),
    );
    createdProfiles.push(
      await createProfile({
        name: `${RUN} Bob Auto Loan`,
        type: "liability",
        parentProfileId: BOB_ID,
        fields: { currentBalance: BOB_DEBT },
      }),
    );
    createdExpenses.push(await createExpense("Bob gas", 60, [BOB_ID]));
  }, 60_000);

  afterAll(async () => {
    // Best-effort teardown; delete is idempotent so re-runs are safe.
    for (const id of createdExpenses) await api("DELETE", `/expenses/${id}`).catch(() => {});
    // Delete children before persons where possible; order is not strictly
    // required (soft-delete), but reversing keeps parents last.
    for (const id of [...createdProfiles].reverse()) await api("DELETE", `/profiles/${id}`).catch(() => {});
  }, 60_000);

  it("Jane filter: net worth = asset - debt (200k), not 0", async () => {
    const t0 = Date.now();
    const s = await snapshotFor([JANE_ID]);
    expect(Date.now() - t0, "Jane snapshot under 2s").toBeLessThan(2000);
    expect(s.assets).toBe(JANE_ASSET);
    expect(s.liabilities).toBe(JANE_DEBT);
    expect(s.netWorth).toBe(JANE_ASSET - JANE_DEBT);
  });

  it("Bob filter: net worth = 20k and excludes Jane's items", async () => {
    const t0 = Date.now();
    const s = await snapshotFor([BOB_ID]);
    expect(Date.now() - t0, "Bob snapshot under 2s").toBeLessThan(2000);
    expect(s.assets).toBe(BOB_ASSET);
    expect(s.liabilities).toBe(BOB_DEBT);
    expect(s.netWorth).toBe(BOB_ASSET - BOB_DEBT);
    // Bob must not pick up Jane's 600k/400k.
    expect(s.assets).not.toBe(JANE_ASSET);
    expect(s.assets).toBeLessThan(JANE_ASSET);
  });

  it("Everyone (no filter): net worth sums both people", async () => {
    const t0 = Date.now();
    const s = await snapshotFor();
    expect(Date.now() - t0, "Everyone snapshot under 2s").toBeLessThan(2000);
    // Account may carry pre-existing data, so assert our seed is fully included
    // rather than an exact total.
    expect(s.assets).toBeGreaterThanOrEqual(JANE_ASSET + BOB_ASSET);
    expect(s.liabilities).toBeGreaterThanOrEqual(JANE_DEBT + BOB_DEBT);
  });

  it("Self filter: net worth is 0 (nothing attached to self)", async () => {
    const t0 = Date.now();
    const s = await snapshotFor([SELF_ID]);
    expect(Date.now() - t0, "Self snapshot under 2s").toBeLessThan(2000);
    expect(s.assets).toBe(0);
    expect(s.liabilities).toBe(0);
    expect(s.netWorth).toBe(0);
  });

  it("expenses endpoint partitions by filter (Bob filter excludes Jane's expenses)", async () => {
    const jane = await api("GET", `/expenses?profileIds=${JANE_ID}`);
    expect(jane.status).toBe(200);
    const janeItems = Array.isArray(jane.data) ? jane.data : jane.data?.items || [];
    const janeMine = janeItems.filter((e: any) => String(e.description).startsWith(RUN));
    expect(janeMine.length).toBe(2);

    const bob = await api("GET", `/expenses?profileIds=${BOB_ID}`);
    expect(bob.status).toBe(200);
    const bobItems = Array.isArray(bob.data) ? bob.data : bob.data?.items || [];
    const bobMine = bobItems.filter((e: any) => String(e.description).startsWith(RUN));
    expect(bobMine.length).toBe(1);
    // No cross-contamination: none of Bob's results mention Jane.
    expect(bobMine.some((e: any) => String(e.description).includes("Jane"))).toBe(false);
  });

  it("stats endpoint responds 200 for each filter (no scope crash)", async () => {
    for (const ids of [[JANE_ID], [BOB_ID], [SELF_ID]]) {
      const r = await api("GET", `/stats?profileIds=${ids.join(",")}`);
      expect(r.status, `stats for ${ids.join(",")}`).toBe(200);
    }
  });

  it("empty/childless person returns $0 net worth with no error", async () => {
    const emptyId = await createProfile({ name: `${RUN} Empty Person`, type: "person" });
    createdProfiles.push(emptyId);
    const s = await snapshotFor([emptyId]);
    expect(s.assets).toBe(0);
    expect(s.liabilities).toBe(0);
    expect(s.netWorth).toBe(0);
  });
});
