// ASSET VALUATION REGRESSION (user report 2026-10-09: "the asset values didn't
// change … the asset value is not being fetched with the Honda CR-V").
//
// Server half. One revaluation must land in the ONE canonical value every
// reader uses, and an older run must never put an older number back:
//   asset profile        getProfileDetail().fields  + the valuation snapshot
//   assets overview      getProfiles()               → resolveAssetValue
//   dashboard / net worth computeNetWorth (shared/net-worth)
//   AI context           financialSnapshot (server/ai-financial-snapshot)
//   search               storage.search
//   the value card       currentAssetValue (newest of row and estimate)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemStorage } from "../server/storage";
import { refreshValuation, getValuationSnapshot } from "../server/valuation/service";
import { setEvidenceProvidersForTest } from "../server/valuation/providers/registry";
import type { EvidenceProvider } from "../server/valuation/providers/types";
import type { ValuationEvidence } from "@shared/valuation/types";
import { resolveAssetValue } from "@shared/asset-value";
import { computeNetWorth } from "@shared/net-worth";
import { currentAssetValue } from "@shared/valuation/context";
import { financialSnapshot } from "../server/ai-financial-snapshot";
import { isOlderRow } from "../client/src/lib/cache-patch";
import { isSnapshotNewerOrEqual } from "../client/src/hooks/useAssetValuation";

const DAY = 86_400_000;
const T1 = new Date("2026-10-09T18:57:47Z");
const T2 = new Date("2026-10-09T18:58:09Z");

function live(value: number, now: Date): ValuationEvidence {
  return {
    id: "live-search:blend", kind: "live_market_search", source: "KBB / Edmunds", provider: "live-search",
    observedAt: now.toISOString(), fetchedAt: now.toISOString(), value, low: value * 0.93, high: value * 1.07,
    currency: "USD", reliability: 0.8, relevance: 0.85, halfLifeMs: 30 * DAY, raw: { specs: {} },
  };
}
function provider(impl: (run: any) => Promise<ValuationEvidence[]>): EvidenceProvider {
  return { id: "live-search", supports: (_c: any, plan: any) => plan.providers.includes("live-search"), fetch: impl } as any;
}

async function everyReader(storage: MemStorage, id: string) {
  const profiles = await storage.getProfiles();
  const row = profiles.find(p => p.id === id)!;
  const detail = await storage.getProfileDetail(id);
  const snap = await getValuationSnapshot(storage, id);
  const nw = computeNetWorth(profiles as any[], { mode: "everyone", selectedIds: [] });
  const ai = financialSnapshot({ allProfiles: profiles, obligations: [], expenses: [], timezone: "America/Los_Angeles" });
  const hits = await storage.search("Honda");
  const hit = hits.find((h: any) => h.id === id);
  return {
    overview: resolveAssetValue(row),
    profile: resolveAssetValue(detail),
    card: currentAssetValue((detail as any).fields, snap?.record ?? null, resolveAssetValue).value,
    netWorth: nw.assets,
    ai: ai.assets,
    searchFound: !!hit,
    searchValue: hit ? resolveAssetValue(hit) : null,
  };
}

describe("asset valuation propagates to every reader", () => {
  let storage: MemStorage;
  beforeEach(() => { storage = new MemStorage(); delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { setEvidenceProvidersForTest(null); });

  it("initial value → recalculated value: every surface reads the new number, none the old", async () => {
    const honda = await storage.createProfile({
      name: "Honda CR-V 2021", type: "vehicle",
      fields: { year: 2021, make: "Honda", model: "CR-V", mileage: 69063, condition: "good" }, tags: [], notes: "",
    } as any);

    setEvidenceProvidersForTest([provider(async (run) => [live(22500, run.now)])]);
    await refreshValuation(storage, honda.id, { reason: "first_valuation", now: T1 });
    const first = await everyReader(storage, honda.id);
    const v1 = first.overview;
    expect(v1).toBeGreaterThan(0);
    expect(first).toMatchObject({ profile: v1, card: v1, netWorth: v1, ai: v1, searchFound: true });

    setEvidenceProvidersForTest([provider(async (run) => [live(20000, run.now)])]);
    const out = await refreshValuation(storage, honda.id, { reason: "user_requested", force: true, now: T2 });
    expect(out.changed).toBe(true);
    const second = await everyReader(storage, honda.id);
    const v2 = second.overview;
    expect(v2).not.toBe(v1);
    // One number, everywhere.
    expect(second).toMatchObject({ profile: v2, card: v2, netWorth: v2, ai: v2, searchFound: true });
    if (second.searchValue != null && second.searchValue > 0) expect(second.searchValue).toBe(v2);
  });

  it("an OLDER run that finishes last cannot restore the previous value (stale async result)", async () => {
    const honda = await storage.createProfile({
      name: "Honda CR-V 2021", type: "vehicle",
      fields: { year: 2021, make: "Honda", model: "CR-V", mileage: 69063, condition: "good" }, tags: [], notes: "",
    } as any);

    // Run A starts at T1 and stalls in its provider...
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => { releaseA = r; });
    setEvidenceProvidersForTest([provider(async (run) => { await gate; return [live(30000, run.now)]; })]);
    const runA = refreshValuation(storage, honda.id, { reason: "scheduled", force: true, now: T1 });

    // ...while a newer run (started at T2, after A's lock expired) lands first.
    await new Promise((r) => setTimeout(r, 5));
    await (storage as any).releaseUserLock(`valuation:${honda.id}`); // simulate the lock TTL lapsing
    setEvidenceProvidersForTest([provider(async (run) => [live(21000, run.now)])]);
    const runB = await refreshValuation(storage, honda.id, { reason: "user_requested", force: true, now: T2 });
    expect(runB.changed).toBe(true);
    const newest = (await everyReader(storage, honda.id)).overview;

    releaseA();
    const a = await runA;
    expect(a.wrote).toBe(false); // discarded
    const after = await everyReader(storage, honda.id);
    expect(after.overview).toBe(newest);
    expect(after.card).toBe(newest);
    expect(after.netWorth).toBe(newest);
    expect((await storage.getAssetValuation(honda.id))?.valuedAt).toBe(T2.toISOString());
  });
});

describe("client stale-result guards", () => {
  it("a row patch older than the cached row is rejected; a newer or unstamped one applies", () => {
    const cached = { id: "x", updatedAt: "2026-10-09T18:58:13Z", fields: { currentValue: 22000 } };
    expect(isOlderRow({ id: "x", updatedAt: "2026-10-09T18:57:53Z" }, cached)).toBe(true);
    expect(isOlderRow({ id: "x", updatedAt: "2026-10-09T18:59:00Z" }, cached)).toBe(false);
    expect(isOlderRow({ id: "x" }, cached)).toBe(false);
  });

  it("an older valuation snapshot never replaces a newer cached one", () => {
    const newer = { record: { valuedAt: T2.toISOString(), value: 22000 } } as any;
    const older = { record: { valuedAt: T1.toISOString(), value: 22500 } } as any;
    expect(isSnapshotNewerOrEqual(older, newer)).toBe(false);
    expect(isSnapshotNewerOrEqual(newer, older)).toBe(true);
    expect(isSnapshotNewerOrEqual(newer, undefined)).toBe(true);
  });

  it("the value card shows the NEWEST of the row's value and the estimate", () => {
    const record = { status: "valued", value: 22000, valuedAt: T1.toISOString() };
    // The user typed a value after the estimate: the row wins, as it does in net worth.
    expect(currentAssetValue({ currentValue: 25000, currentValueSource: "user", currentValueAsOf: T2.toISOString() }, record, resolveAssetValue))
      .toEqual({ value: 25000, source: "stored" });
    // A newer estimate than the row's: the estimate wins.
    expect(currentAssetValue({ currentValue: 23800, currentValueSource: "estimate", currentValueAsOf: "2026-09-19T21:40:03Z" }, record, resolveAssetValue))
      .toEqual({ value: 22000, source: "estimate" });
    // Nothing on the row: the estimate.
    expect(currentAssetValue({}, record, resolveAssetValue)).toEqual({ value: 22000, source: "estimate" });
  });
});
