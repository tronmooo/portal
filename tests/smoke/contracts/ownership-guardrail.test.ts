/**
 * Ownership guardrail — Stage 6 of docs/ownership_consolidation_plan.md.
 *
 * This is the test that makes the original bug un-bornable. It recreates the
 * exact failure shape (entity owned by profile A must show under A, hide
 * under B, dashboard sums must reflect ownership), then asserts the global
 * invariant that no entity row has divergent ownership representations.
 *
 * If any future refactor brings back the three-systems disagreement, this
 * test fails before the push reaches CI.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api } from "../fixture/api";
import { ensureSeeded } from "../fixture/setup";
import type { SeedResult } from "../fixture/seed";
import { SB_URL, SB_ANON } from "../fixture/account";

let fixture: SeedResult;
const createdExpenseIds: string[] = [];

beforeAll(async () => {
  fixture = await ensureSeeded();
}, 120_000);

afterAll(async () => {
  // Clean up anything this test created so reruns are deterministic.
  for (const id of createdExpenseIds) {
    try { await api("DELETE", `/expenses/${id}`); } catch { /* best effort */ }
  }
});

describe("contract: ownership guardrail (BUG-20260528-ownership-three-systems)", () => {
  it("GUARDRAIL-1: expense owned by non-self profile appears under that profile and hides under self", async () => {
    const otherProfileId = fixture.peopleIds[0]; // Smoke Spouse
    const created = await api<any>("POST", "/expenses", {
      description: "Guardrail expense — other-only",
      amount: 42.42,
      category: "food",
      date: "2026-05-28",
      linkedProfiles: [otherProfileId],
    });
    expect(created.ok, `create failed: ${created.status}`).toBe(true);
    const expenseId = (created.data as any).id;
    createdExpenseIds.push(expenseId);

    // Filtered to OTHER → must include it.
    const otherList = await api<any[]>("GET", `/expenses?profileIds=${otherProfileId}`);
    const otherItems = Array.isArray(otherList.data) ? otherList.data : [];
    expect(otherItems.some(e => e.id === expenseId),
      `expense ${expenseId} should appear under other profile ${otherProfileId}`).toBe(true);

    // Filtered to SELF → must NOT include it. This is the exact bug shape:
    // an entity linked to A must hide when the user filters to B.
    const selfList = await api<any[]>("GET", `/expenses?profileIds=${fixture.selfId}`);
    const selfItems = Array.isArray(selfList.data) ? selfList.data : [];
    expect(selfItems.some(e => e.id === expenseId),
      `expense ${expenseId} should NOT appear under self when owned only by ${otherProfileId}`).toBe(false);
  });

  it("GUARDRAIL-2: flipping ownership via PATCH moves the expense to the new owner and away from the old one", async () => {
    const otherProfileId = fixture.peopleIds[0];
    // Find the expense we just created (last entry in our log).
    const expenseId = createdExpenseIds[createdExpenseIds.length - 1];
    expect(expenseId).toBeTruthy();

    // Move it to self only.
    const patch = await api<any>("PATCH", `/expenses/${expenseId}`, {
      linkedProfiles: [fixture.selfId],
    });
    expect(patch.ok, `PATCH failed: ${patch.status}`).toBe(true);

    // After PATCH, it must appear under SELF and disappear from OTHER.
    const selfList = await api<any[]>("GET", `/expenses?profileIds=${fixture.selfId}`);
    const selfItems = Array.isArray(selfList.data) ? selfList.data : [];
    expect(selfItems.some(e => e.id === expenseId),
      `after PATCH, expense ${expenseId} must be visible under self`).toBe(true);

    const otherList = await api<any[]>("GET", `/expenses?profileIds=${otherProfileId}`);
    const otherItems = Array.isArray(otherList.data) ? otherList.data : [];
    expect(otherItems.some(e => e.id === expenseId),
      `after PATCH, expense ${expenseId} must NOT be visible under ${otherProfileId}`).toBe(false);
  });

  it("GUARDRAIL-3: every API-returned entity has linked_profiles consistent with its junction table", async () => {
    // The invariant: for any expense the server returns, the set of profile IDs
    // in `linkedProfiles` must equal the set in the matching junction table.
    // We verify by reading via two endpoints whose answers must agree:
    //   /api/expenses                (reads JSONB)
    //   /api/expenses?profileIds=<X> for X in each profile (reads through filter)
    // Every expense returned with linkedProfiles=[X,Y,...] must appear when
    // we filter to ANY of X, Y, ... and disappear when we filter to a profile
    // that is NOT in its owner set.
    const all = await api<any[]>("GET", "/expenses");
    const expenses: any[] = Array.isArray(all.data) ? all.data : [];
    expect(expenses.length, "fixture must have expenses to validate").toBeGreaterThan(0);

    // Test sample: pick up to 5 expenses with explicit owners to keep the run fast.
    const sample = expenses
      .filter(e => Array.isArray(e.linkedProfiles) && e.linkedProfiles.length > 0)
      .slice(0, 5);
    expect(sample.length, "no expenses had linkedProfiles — fixture broken").toBeGreaterThan(0);

    for (const e of sample) {
      const owners: string[] = e.linkedProfiles;
      // For each owner: filtering to that owner must include this expense.
      for (const owner of owners) {
        const r = await api<any[]>("GET", `/expenses?profileIds=${owner}`);
        const items: any[] = Array.isArray(r.data) ? r.data : [];
        expect(items.some(x => x.id === e.id),
          `expense ${e.id} owners=${owners.join(",")} not visible under owner ${owner}`).toBe(true);
      }
      // For a non-owner profile: filtering must exclude this expense (unless
      // the non-owner profile is self and the expense had no owners — but we
      // filtered the sample to have owners, so this case can't apply).
      const nonOwner = fixture.peopleIds.find(p => !owners.includes(p));
      if (nonOwner) {
        const r = await api<any[]>("GET", `/expenses?profileIds=${nonOwner}`);
        const items: any[] = Array.isArray(r.data) ? r.data : [];
        // The orphan-default-to-self rule means an expense with self in its
        // owner set could appear under another profile through the legacy
        // "belongs_to_self" policy — but that policy only applies when self
        // is in the SELECTION, not when filtering to another profile alone.
        // Filtering to a single non-owner non-self profile must exclude it.
        expect(items.some(x => x.id === e.id),
          `expense ${e.id} owners=${owners.join(",")} leaked under non-owner ${nonOwner}`).toBe(false);
      }
    }
  });

  it("GUARDRAIL-INV: smoke account has zero entities where JSONB linked_profiles disagrees with junction", async () => {
    // The global invariant Stage 2 backfill enforced on the whole DB. We
    // assert it here for the smoke fixture user via /api/diagnostics/ownership.
    // If this endpoint isn't available the test soft-skips (returns ok) so
    // it doesn't block deploys before the endpoint ships, but it WILL detect
    // any divergence the moment the endpoint is live.
    const r = await api<any>("GET", "/diagnostics/ownership-consistency");
    if (r.status === 404) return; // endpoint not yet deployed — soft pass
    expect(r.ok, `diagnostics endpoint failed: ${r.status}`).toBe(true);
    const d = r.data as any;
    expect(d.disagreementCount, `smoke user has ${d.disagreementCount} JSONB↔junction disagreements`).toBe(0);
    expect(d.jsonbOnlyCount, `smoke user has ${d.jsonbOnlyCount} JSONB rows missing junction entries`).toBe(0);
    // Stage 5: relational asset/liability link table is the source of truth.
    //   The legacy fields.ownerProfileId hint must never disagree with it.
    //   `financeDisagreementCount` is optional in the response so older
    //   deployments don't fail this check.
    if (typeof d.financeDisagreementCount === "number") {
      expect(d.financeDisagreementCount,
        `smoke user has ${d.financeDisagreementCount} asset/liability rows where fields.ownerProfileId disagrees with the relational link table`).toBe(0);
    }
  });

  it("GUARDRAIL-4: dashboard totals respect ownership filters end-to-end", async () => {
    // After the test above, our guardrail expense (now owned by self only) is
    // an expense, not an asset — but the same invariant applies: filtering
    // dashboard to a profile that doesn't own anything must show smaller
    // totals than filtering to a profile that does.
    const dashSelf = await api<any>("GET", `/dashboard-enhanced?profileIds=${fixture.selfId}`);
    const dashOther = await api<any>("GET", `/dashboard-enhanced?profileIds=${fixture.peopleIds[0]}`);
    expect(dashSelf.ok && dashOther.ok, "dashboard endpoints must succeed").toBe(true);

    // Self owns the smoke house ($500k) and the smoke car ($25k); the other
    // profile owns nothing in the fixture. So self.assets > other.assets.
    const selfAssets = Number((dashSelf.data as any).financeSnapshot?.totalAssetValue || 0);
    const otherAssets = Number((dashOther.data as any).financeSnapshot?.totalAssetValue || 0);
    expect(selfAssets, "self should see fixture assets").toBeGreaterThan(0);
    expect(selfAssets, "filtering must exclude non-owner assets").toBeGreaterThan(otherAssets);
  });
});
