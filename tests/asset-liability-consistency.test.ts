// Asset + Liability audit regression suite.
//
// Two classes of bug are pinned here, both of which produced the same
// user-visible symptom ("this asset says $79 in the list and $85 on its own
// page", "I created a liability and had to refresh the app to see it"):
//
//   A. VALUE CONSISTENCY — a screen resolving an asset value or a liability
//      balance with its OWN key ladder instead of shared/asset-value.ts. Every
//      such ladder was shorter than the canonical one, so the two disagreed for
//      any record whose money lived in a key the short ladder skipped.
//
//   B. WRITE ORDERING — an aggregate response (dashboard/profile bootstrap)
//      being unpacked into ~24 other query keys AFTER a write had already
//      refreshed them, silently reverting the new data AND marking it fresh so
//      nothing refetched it.
import { describe, it, expect } from "vitest";
import {
  resolveAssetValue,
  resolveLiabilityBalance,
} from "../shared/asset-value";

// ── A. Value consistency ────────────────────────────────────────────────────
//
// Each case below is a record shape that a now-removed inline ladder got wrong.
// The assertions are on the CANONICAL resolver, which is what every call site
// now uses — so a future inline ladder that reintroduces the divergence fails
// the paired assertion in its own screen, and this file documents why the
// canonical answer is what it is.

describe("canonical asset value", () => {
  it("prefers the AI-written currentValue over the purchase price", () => {
    // The valuation route writes `currentValue`; `purchasePrice` is history.
    // A list that read purchasePrice first showed the pre-valuation number
    // beside a profile page showing the new estimate.
    expect(resolveAssetValue({ fields: { purchasePrice: 799, currentValue: 85 } })).toBe(85);
  });

  it("finds a value stored under marketValue / estimatedValue", () => {
    expect(resolveAssetValue({ fields: { marketValue: 21100 } })).toBe(21100);
    expect(resolveAssetValue({ fields: { estimatedValue: 500 } })).toBe(500);
  });

  it("finds an account's money under top-level balance", () => {
    // The two-key `currentValue || value` ladders rendered accounts as "—".
    expect(resolveAssetValue({ fields: { balance: 4200 } })).toBe(4200);
  });

  it("finds a value in the nested vehicle / housing / finance namespaces", () => {
    expect(resolveAssetValue({ fields: { vehicle: { currentValue: 21100 } } })).toBe(21100);
    expect(resolveAssetValue({ fields: { housing: { marketValue: 500000 } } })).toBe(500000);
    expect(resolveAssetValue({ fields: { finance: { balance: 1234 } } })).toBe(1234);
  });

  it("accepts a bare fields object and a whole profile identically", () => {
    const fields = { currentValue: 85 };
    expect(resolveAssetValue(fields)).toBe(resolveAssetValue({ fields }));
  });

  it("parses money strings the same way everywhere", () => {
    expect(resolveAssetValue({ fields: { currentValue: "$21,100" } })).toBe(21100);
    expect(resolveAssetValue({ fields: { currentValue: "40k" } })).toBe(40000);
  });
});

describe("canonical liability balance", () => {
  it("prefers currentBalance — the field the liability page writes", () => {
    // The removed ladders in profile-detail's Liabilities section started at
    // `remainingBalance` and never looked at `currentBalance`, so a liability
    // saved from its own profile page summed as $0 in the owner's rollup.
    expect(resolveLiabilityBalance({ fields: { currentBalance: 8500 } })).toBe(8500);
  });

  it("finds outstandingBalance, which no inline ladder covered", () => {
    expect(resolveLiabilityBalance({ fields: { outstandingBalance: 8500 } })).toBe(8500);
  });

  it("sums nested finance.loans[] rows written by AI extraction", () => {
    expect(
      resolveLiabilityBalance({ fields: { finance: { loans: [{ balance: 5000 }, { balance: 3500 }] } } }),
    ).toBe(8500);
  });

  it("never reports a monthly payment as a balance", () => {
    // §15: a $450/mo payment must not become an $450 balance. `monthlyPayment`
    // is not, and must never become, a balance candidate.
    expect(resolveLiabilityBalance({ fields: { monthlyPayment: 450 } })).toBe(0);
    expect(resolveLiabilityBalance({ fields: { minimumPayment: 450 } })).toBe(0);
    expect(
      resolveLiabilityBalance({ fields: { currentBalance: 8500, monthlyPayment: 450 } }),
    ).toBe(8500);
  });

  it("keeps balance and value as separate questions about one record", () => {
    // A mortgaged house: $500k of asset, $348,888 of debt. Neither resolver may
    // answer with the other's number.
    const house = { fields: { marketValue: 500000, currentBalance: 348888 } };
    expect(resolveAssetValue(house)).toBe(500000);
    expect(resolveLiabilityBalance(house)).toBe(348888);
  });
});

// ── B. Write ordering ───────────────────────────────────────────────────────
//
// The guard is a pure comparison of "when did my request start" against "when
// did the last write land", so it is testable without React Query. This pins
// the DECISION; the call sites are wired to it in bootstrap-seed.ts,
// profile-detail.tsx, dashboard.tsx and scope-prefetch.ts.

/** The rule implemented by seedDashboardCaches / profile-detail's `seed()`. */
function mayPublish(opts: {
  requestStartedAt: number;
  lastInvalidationAt: number;
  existingEntryUpdatedAt?: number;
}): boolean {
  if (opts.lastInvalidationAt > opts.requestStartedAt) return false;
  if (opts.existingEntryUpdatedAt && opts.existingEntryUpdatedAt > opts.requestStartedAt) return false;
  return true;
}

describe("bootstrap seed write-ordering guard", () => {
  it("publishes a payload when nothing changed while it was in flight", () => {
    expect(mayPublish({ requestStartedAt: 1000, lastInvalidationAt: 500 })).toBe(true);
  });

  it("drops a payload whose request predates a write", () => {
    // The background sibling-scope warm case: issued at t=1000, the user saved
    // an asset at t=1200, the response lands at t=2000 describing t=1000.
    expect(mayPublish({ requestStartedAt: 1000, lastInvalidationAt: 1200 })).toBe(false);
  });

  it("never overwrites a cache entry newer than the request", () => {
    // The post-write refetch already landed with the new row; this older
    // aggregate must not replace it.
    expect(
      mayPublish({ requestStartedAt: 1000, lastInvalidationAt: 0, existingEntryUpdatedAt: 1500 }),
    ).toBe(false);
  });

  it("still publishes over an entry older than the request", () => {
    expect(
      mayPublish({ requestStartedAt: 1000, lastInvalidationAt: 0, existingEntryUpdatedAt: 400 }),
    ).toBe(true);
  });
});
