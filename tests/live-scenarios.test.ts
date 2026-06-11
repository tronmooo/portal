// Live end-to-end scenario suite — runs against the DEPLOYED app (portol.me)
// with the repo's existing smoke account. Executes the full Bob/Jane/Mike
// scenario matrix (user-specified, 2026-06-10): profiles, assets,
// liabilities, documents, trackers, budgets, events, tasks, deletion
// cascades, fractional ownership, ownership moves, nested assets, AI chat
// writes — asserting after EVERY mutation that the very next read reflects
// it (the "updates instantly without refresh" guarantee: the client always
// refetches after mutations, so server-side read-your-writes === no-refresh
// UI updates), that the right profile filter shows it, that the wrong
// profile filter does NOT, and that dashboard totals move by the right
// amounts. Latency is logged for every call and asserted within bounds.
//
// Run via .github/workflows/live-e2e.yml (workflow_dispatch) or locally:
//   npx vitest run --config vitest.live.config.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const BASE = process.env.E2E_BASE_URL || "https://portol.me/api";
const EMAIL = process.env.E2E_EMAIL || "tron@aol.com";
const PASSWORD = process.env.E2E_PASSWORD || "password";
const RUN = `E2E${Date.now().toString(36)}`;

let TOKEN = "";
const timings: Array<{ label: string; ms: number }> = [];
const createdProfileIds: string[] = [];

async function api(method: string, path: string, body?: any, label?: string) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Timezone": "America/Los_Angeles",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - t0;
  const tag = label || `${method} ${path.split("?")[0]}`;
  timings.push({ label: tag, ms });
  console.log(`[timing] ${tag}: ${ms}ms (${r.status})`);
  const data = await r.json().catch(() => null);
  return { status: r.status, ok: r.ok, data, ms };
}

const byName = (arr: any[], name: string) =>
  (arr || []).find((p: any) => p?.name === name);

describe("live scenarios: Bob / Jane / Mike", () => {
  let bob: any, jane: any, mike: any;
  let car: any, house: any, loan: any, pc: any, mouse: any;

  beforeAll(async () => {
    const res = await api("POST", "/auth/signin", { email: EMAIL, password: PASSWORD }, "signin");
    expect(res.ok, `signin failed: ${JSON.stringify(res.data)}`).toBe(true);
    TOKEN = res.data?.session?.access_token;
    expect(TOKEN).toBeTruthy();
  }, 60_000);

  afterAll(async () => {
    // Cleanup is itself the deletion-cascade test for whatever survived.
    for (const id of createdProfileIds.reverse()) {
      await api("DELETE", `/api/profiles/${id}`.replace("/api", ""), undefined, `cleanup ${id.slice(0, 8)}`).catch(() => {});
    }
    const slow = timings.filter((t) => t.ms > 3000);
    console.log(`[timing] total calls: ${timings.length}; >3s: ${slow.length}`);
    console.log(`[timing] slowest:`, timings.slice().sort((a, b) => b.ms - a.ms).slice(0, 5));
  }, 120_000);

  // ── 1. Profiles ──────────────────────────────────────────────────────
  it("1. creates Bob, Jane, Mike — and they appear on the very next read", async () => {
    for (const name of [`Bob ${RUN}`, `Jane ${RUN}`, `Mike ${RUN}`]) {
      const r = await api("POST", "/profiles", { name, type: "person", fields: {}, tags: [], notes: "", skipDupCheck: true });
      expect(r.ok, `create ${name}: ${JSON.stringify(r.data)}`).toBe(true);
      createdProfileIds.push(r.data.id);
    }
    const list = await api("GET", "/profiles", undefined, "profiles after create");
    bob = byName(list.data, `Bob ${RUN}`);
    jane = byName(list.data, `Jane ${RUN}`);
    mike = byName(list.data, `Mike ${RUN}`);
    expect(bob, "Bob visible immediately").toBeTruthy();
    expect(jane, "Jane visible immediately").toBeTruthy();
    expect(mike, "Mike visible immediately").toBeTruthy();
  }, 60_000);

  // ── 2-3. Assets ──────────────────────────────────────────────────────
  it("2. adds Bob's $20,000 car — dashboard for Bob gains exactly $20,000", async () => {
    const before = await api("GET", `/dashboard-enhanced?profileIds=${bob.id}`, undefined, "enhanced(bob) before car");
    const beforeAssets = Number(before.data?.financeSnapshot?.totalAssetValue ?? 0);
    const r = await api("POST", "/profiles", {
      name: `Car ${RUN}`, type: "vehicle",
      fields: { currentValue: 20000, make: "Test", model: "Car" },
      parentProfileId: bob.id, tags: [], notes: "", skipDupCheck: true,
    });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    car = r.data; createdProfileIds.push(car.id);
    const after = await api("GET", `/dashboard-enhanced?profileIds=${bob.id}`, undefined, "enhanced(bob) after car");
    const afterAssets = Number(after.data?.financeSnapshot?.totalAssetValue ?? 0);
    expect(afterAssets - beforeAssets, "Bob's assets +$20k instantly, no refresh").toBe(20000);
  }, 60_000);

  it("3. adds Jane's $400,000 house — Jane gains it; Bob does NOT", async () => {
    const bobBefore = await api("GET", `/dashboard-enhanced?profileIds=${bob.id}`);
    const r = await api("POST", "/profiles", {
      name: `House ${RUN}`, type: "property",
      fields: { currentValue: 400000 }, parentProfileId: jane.id, tags: [], notes: "", skipDupCheck: true,
    });
    expect(r.ok).toBe(true); house = r.data; createdProfileIds.push(house.id);
    const jview = await api("GET", `/dashboard-enhanced?profileIds=${jane.id}`, undefined, "enhanced(jane) after house");
    const janeHasHouse = (jview.data?.assetBreakdown || []).some((a: any) => a.id === house.id);
    expect(janeHasHouse, "house in Jane's breakdown immediately").toBe(true);
    const bobAfter = await api("GET", `/dashboard-enhanced?profileIds=${bob.id}`);
    expect(
      Number(bobAfter.data?.financeSnapshot?.totalAssetValue) - Number(bobBefore.data?.financeSnapshot?.totalAssetValue),
      "Bob's totals unchanged by Jane's house (isolation)",
    ).toBe(0);
  }, 60_000);

  // ── 4-5. Liabilities ─────────────────────────────────────────────────
  it("4. adds Bob's $10,000 loan — Bob's liabilities +$10k; Jane's unchanged", async () => {
    const before = await api("GET", `/dashboard-enhanced?profileIds=${bob.id}`);
    const r = await api("POST", "/profiles", {
      name: `Loan ${RUN}`, type: "liability",
      fields: { currentBalance: 10000 }, parentProfileId: bob.id, tags: [], notes: "", skipDupCheck: true,
    });
    expect(r.ok).toBe(true); loan = r.data; createdProfileIds.push(loan.id);
    // Explicit ownership link so the move test (13) has a junction row to move.
    await api("POST", "/liability-profile-links", {
      liabilityProfileId: loan.id, partyProfileId: bob.id, ownershipPercentage: 100, role: "owner",
    }, "link loan->bob");
    const after = await api("GET", `/dashboard-enhanced?profileIds=${bob.id}`, undefined, "enhanced(bob) after loan");
    expect(
      Number(after.data?.financeSnapshot?.totalLiabilities) - Number(before.data?.financeSnapshot?.totalLiabilities),
      "Bob's liabilities +$10k instantly",
    ).toBe(10000);
  }, 60_000);

  it("5. adds Mike's $50/month subscription — appears under Mike's filter only", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await api("POST", "/obligations", {
      name: `Streamflix ${RUN}`, amount: 50, frequency: "monthly",
      nextDueDate: today, category: "subscription", linkedProfiles: [mike.id],
    });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    const mikeView = await api("GET", `/obligations?profileIds=${mike.id}`, undefined, "obligations(mike)");
    expect(byName(mikeView.data, `Streamflix ${RUN}`), "subscription under Mike immediately").toBeTruthy();
    const bobView = await api("GET", `/obligations?profileIds=${bob.id}`, undefined, "obligations(bob)");
    expect(byName(bobView.data, `Streamflix ${RUN}`), "NOT under Bob").toBeFalsy();
  }, 60_000);

  // ── 6-10. Document / tracker / budget / event / task ─────────────────
  it("6. adds Bob's driver's license document — filter isolation holds", async () => {
    const r = await api("POST", "/documents", {
      name: `Drivers License ${RUN}`, type: "identity", linkedProfiles: [bob.id],
    });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    const bobDocs = await api("GET", `/documents?profileIds=${bob.id}`);
    expect(byName(bobDocs.data, `Drivers License ${RUN}`), "doc under Bob").toBeTruthy();
    const janeDocs = await api("GET", `/documents?profileIds=${jane.id}`);
    expect(byName(janeDocs.data, `Drivers License ${RUN}`), "doc NOT under Jane").toBeFalsy();
  }, 60_000);

  it("7. adds Jane's workout tracker — visible under Jane, not Mike", async () => {
    const r = await api("POST", "/trackers", {
      name: `Workouts ${RUN}`, category: "fitness", linkedProfiles: [jane.id], fields: [{ name: "minutes", type: "number" }],
    });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    const janeT = await api("GET", `/trackers?profileIds=${jane.id}`);
    expect(byName(janeT.data, `Workouts ${RUN}`), "tracker under Jane").toBeTruthy();
    const mikeT = await api("GET", `/trackers?profileIds=${mike.id}`);
    expect(byName(mikeT.data, `Workouts ${RUN}`), "tracker NOT under Mike").toBeFalsy();
  }, 60_000);

  it("8. adds Mike's budget — budget summary reflects it immediately", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const r = await api("POST", "/budgets", { month, category: `groceries-${RUN}`, amount: 300, profileId: mike.id });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    const budgets = await api("GET", `/budgets?month=${month}`, undefined, "budgets after create");
    const mine = (budgets.data || []).find((b: any) => b.category === `groceries-${RUN}`);
    expect(mine, "budget row visible immediately").toBeTruthy();
    expect(Number(mine.amount)).toBe(300);
  }, 60_000);

  it("9. adds Bob's calendar event — calendar shows it; Jane's filter doesn't", async () => {
    const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const r = await api("POST", "/events", {
      title: `Dentist ${RUN}`, date, category: "health", linkedProfiles: [bob.id],
    });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    const bobEv = await api("GET", `/events?profileIds=${bob.id}`);
    expect((bobEv.data || []).some((e: any) => e.title === `Dentist ${RUN}`), "event under Bob").toBe(true);
    const janeEv = await api("GET", `/events?profileIds=${jane.id}`);
    expect((janeEv.data || []).some((e: any) => e.title === `Dentist ${RUN}`), "event NOT under Jane").toBe(false);
  }, 60_000);

  it("10. adds Jane's task — everyone-filter shows it, Bob's filter doesn't", async () => {
    const r = await api("POST", "/tasks", {
      title: `File taxes ${RUN}`, priority: "medium", status: "todo", linkedProfiles: [jane.id],
    });
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    const everyone = await api("GET", "/tasks", undefined, "tasks(everyone)");
    expect((everyone.data || []).some((t: any) => t.title === `File taxes ${RUN}`), "task in everyone view").toBe(true);
    const bobT = await api("GET", `/tasks?profileIds=${bob.id}`);
    expect((bobT.data || []).some((t: any) => t.title === `File taxes ${RUN}`), "task NOT under Bob").toBe(false);
  }, 60_000);

  // ── 11. Delete cascade ───────────────────────────────────────────────
  it("11. deletes Bob's car — it disappears from profiles, breakdown, and totals instantly", async () => {
    const before = await api("GET", `/dashboard-enhanced?profileIds=${bob.id}`);
    const del = await api("DELETE", `/profiles/${car.id}`, undefined, "delete car");
    expect(del.ok, JSON.stringify(del.data)).toBe(true);
    const profiles = await api("GET", "/profiles", undefined, "profiles after car delete");
    expect(byName(profiles.data, `Car ${RUN}`), "car gone from profile list immediately").toBeFalsy();
    const after = await api("GET", `/dashboard-enhanced?profileIds=${bob.id}`, undefined, "enhanced(bob) after car delete");
    expect((after.data?.assetBreakdown || []).some((a: any) => a.id === car.id), "car gone from breakdown").toBe(false);
    expect(
      Number(before.data?.financeSnapshot?.totalAssetValue) - Number(after.data?.financeSnapshot?.totalAssetValue),
      "Bob's totals dropped by exactly the car's $20k — no stale cache",
    ).toBe(20000);
    createdProfileIds.splice(createdProfileIds.indexOf(car.id), 1);
  }, 60_000);

  // ── 12. Fractional ownership ─────────────────────────────────────────
  it("12. sets the house to 50% Jane / 50% Bob — both dashboards show $200k shares", async () => {
    const r = await api("PUT", `/profiles/${house.id}/owners`, {
      owners: [
        { partyProfileId: jane.id, ownershipPercentage: 50 },
        { partyProfileId: bob.id, ownershipPercentage: 50 },
      ],
    }, "set 50/50 owners");
    expect(r.ok, JSON.stringify(r.data)).toBe(true);
    const jview = await api("GET", `/dashboard-enhanced?profileIds=${jane.id}`, undefined, "enhanced(jane) 50/50");
    const bview = await api("GET", `/dashboard-enhanced?profileIds=${bob.id}`, undefined, "enhanced(bob) 50/50");
    const janeHouse = (jview.data?.assetBreakdown || []).find((a: any) => a.id === house.id);
    const bobHouse = (bview.data?.assetBreakdown || []).find((a: any) => a.id === house.id);
    expect(janeHouse, "house in Jane's breakdown").toBeTruthy();
    expect(bobHouse, "house in Bob's breakdown after co-ownership").toBeTruthy();
    const shareOf = (row: any) => Number(row.value ?? row.shareValue ?? row.share ?? row.netValue ?? row.amount ?? NaN);
    console.log("[shape] jane house row:", JSON.stringify(janeHouse));
    expect(shareOf(janeHouse), "Jane's share = $200k").toBe(200000);
    expect(shareOf(bobHouse), "Bob's share = $200k").toBe(200000);
  }, 60_000);

  // ── 13. Ownership move ───────────────────────────────────────────────
  it("13. moves the loan from Bob to Mike — Bob stops seeing it, Mike starts", async () => {
    const links = await api("GET", "/liability-profile-links", undefined, "liability links");
    const loanLink = (links.data || []).find(
      (l: any) => l.liabilityProfileId === loan.id && l.partyProfileId === bob.id,
    );
    expect(loanLink, "loan->bob junction row exists").toBeTruthy();
    const del = await api("DELETE", `/liability-profile-links/${loanLink.id}`, undefined, "unlink loan from bob");
    expect(del.ok).toBe(true);
    const add = await api("POST", "/liability-profile-links", {
      liabilityProfileId: loan.id, partyProfileId: mike.id, ownershipPercentage: 100, role: "owner",
    }, "link loan to mike");
    expect(add.ok, JSON.stringify(add.data)).toBe(true);
    const mview = await api("GET", `/dashboard-enhanced?profileIds=${mike.id}`, undefined, "enhanced(mike) after move");
    expect((mview.data?.liabilityBreakdown || []).some((l: any) => l.id === loan.id), "loan now under Mike").toBe(true);
    const bview = await api("GET", `/dashboard-enhanced?profileIds=${bob.id}`, undefined, "enhanced(bob) after move");
    expect((bview.data?.liabilityBreakdown || []).some((l: any) => l.id === loan.id), "loan no longer under Bob").toBe(false);
  }, 60_000);

  // ── 14. Nested assets ────────────────────────────────────────────────
  it("14. nests mouse -> gaming PC -> house and the rollup includes both", async () => {
    const rPc = await api("POST", "/profiles", {
      name: `Gaming PC ${RUN}`, type: "asset", fields: { currentValue: 2000 }, parentProfileId: house.id, tags: [], notes: "", skipDupCheck: true,
    });
    expect(rPc.ok).toBe(true); pc = rPc.data; createdProfileIds.push(pc.id);
    const rMouse = await api("POST", "/profiles", {
      name: `Mouse ${RUN}`, type: "asset", fields: { currentValue: 80 }, parentProfileId: pc.id, tags: [], notes: "", skipDupCheck: true,
    });
    expect(rMouse.ok).toBe(true); mouse = rMouse.data; createdProfileIds.push(mouse.id);
    const detail = await api("GET", `/profiles/${house.id}`, undefined, "house detail (nested)");
    const kids = detail.data?.childProfiles || detail.data?.children || detail.data?.profile?.childProfiles || [];
    if (!kids.length) console.log("[shape] house detail keys:", Object.keys(detail.data || {}).join(","));
    const childIds = kids.map((c: any) => c.id);
    expect(childIds, "PC nested under house").toContain(pc.id);
    const pcDetail = await api("GET", `/profiles/${pc.id}`, undefined, "pc detail (nested)");
    const pcKids = pcDetail.data?.childProfiles || pcDetail.data?.children || pcDetail.data?.profile?.childProfiles || [];
    const pcChildIds = pcKids.map((c: any) => c.id);
    expect(pcChildIds, "mouse nested under PC").toContain(mouse.id);
  }, 60_000);

  // ── 15. AI chat ──────────────────────────────────────────────────────
  it("15a. AI chat adds an expense for Bob — visible under Bob within seconds, no refresh", async () => {
    const r = await api("POST", "/chat", {
      message: `add a $75 expense for birthday gift for Bob ${RUN}`, history: [],
    }, "AI chat: create expense");
    expect(r.ok, JSON.stringify(r.data).slice(0, 300)).toBe(true);
    let found: any = null;
    for (let i = 0; i < 6 && !found; i++) {
      const ex = await api("GET", `/expenses?profileIds=${bob.id}`, undefined, `expenses(bob) poll ${i}`);
      found = (ex.data || []).find((e: any) => Number(e.amount) === 75 && /birthday/i.test(e.description || ""));
      if (!found) await new Promise((res) => setTimeout(res, 1500));
    }
    expect(found, "AI-created $75 expense visible under Bob without refresh").toBeTruthy();
  }, 120_000);

  it("15b. AI chat money message NEVER creates a tracker (expense guard, live)", async () => {
    const before = await api("GET", "/trackers", undefined, "trackers before guard test");
    const r = await api("POST", "/chat", {
      message: `I spent $120 on equipment repairs for Jane ${RUN}`, history: [],
    }, "AI chat: repair expense");
    expect(r.ok).toBe(true);
    const after = await api("GET", "/trackers", undefined, "trackers after guard test");
    const newTrackers = (after.data || []).filter(
      (t: any) => !(before.data || []).some((b: any) => b.id === t.id),
    );
    const moneyTracker = newTrackers.find((t: any) => /repair|equipment|maintenance|expense/i.test(t.name));
    expect(moneyTracker, `no money-shaped tracker auto-created (got: ${newTrackers.map((t: any) => t.name).join(", ") || "none"})`).toBeFalsy();
  }, 120_000);

  // ── Latency budget over the whole run ────────────────────────────────
  it("keeps the API fast: median under 2.5s from a cross-country runner, warm max under 6.5s", () => {
    const sorted = timings.map((t) => t.ms).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`[timing] median=${median}ms p95=${sorted[Math.floor(sorted.length * 0.95)]}ms max=${sorted[sorted.length - 1]}ms`);
    // GitHub runners are us-east; the function+DB are us-west (pdx1). Budgets
    // bound pathology (cold-start storms, stale-cache recomputes), not UX —
    // real users sit closer to one coast than this round trip.
    expect(median, "median API latency").toBeLessThan(2500);
    // Exclude AI chat + signin (model/auth latency, not API performance).
    const warm = timings.filter((t) => !/chat|signin/i.test(t.label));
    const worst = warm.slice().sort((a, b) => b.ms - a.ms)[0];
    expect(worst.ms, `slowest non-AI call (${worst.label})`).toBeLessThan(6500);
  });
});
