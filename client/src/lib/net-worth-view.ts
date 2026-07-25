// client/src/lib/net-worth-view.ts
//
// The ONE client-side derivation of the displayed balance sheet.
//
// Every Net Worth surface — the Hero KPI tile, the Net Worth popup, the
// Finance card — must call `netWorthView` and render nothing but what it
// returns. The invariant it enforces is simple and non-negotiable:
//
//     the headline total is the sum of the rows the user can see.
//
// QA report 2026-07-25: "KPI header: $1,398,804 / Net Worth pop-up:
// $1,398,954 — a $150 difference on the same screen." Two surfaces were
// applying the synthetic-test-data filter differently: the popup dropped the
// hidden rows and re-summed, the KPI tile kept the server's total, which still
// counted them. Neither was "wrong" in isolation; having two derivations at
// all was the bug.

import { isTestEntity } from "@shared/test-data";
import { balanceSheetFromSnapshot, type BalanceSheet } from "@shared/net-worth";

export type { BalanceSheet };

/**
 * Derive the balance sheet from a server `financeSnapshot`.
 *
 * @param snapshot      `enhanced.financeSnapshot`, or undefined while loading.
 * @param showTestData  the user's synthetic-test-data preference.
 * @param fallback      optional pre-resolve rows so a popup isn't blank on the
 *                      first tick. Only consulted when `snapshot` is absent —
 *                      never mixed with server rows.
 *
 * Returns all-zero totals when nothing has loaded. Callers MUST distinguish
 * that from a real $0 (see `isNetWorthLoaded`) and show a loading state, so a
 * placeholder is never mistaken for a final financial total.
 */
export function netWorthView(
  snapshot: any,
  showTestData: boolean,
  fallback?: { assets: any[]; liabilities: any[] },
): BalanceSheet {
  const isHidden = showTestData ? undefined : (row: any) => isTestEntity(row);
  if (snapshot) return balanceSheetFromSnapshot(snapshot, isHidden);
  if (!fallback) return balanceSheetFromSnapshot(null, isHidden);
  // Pre-resolve tick: run the fallback rows through the identical filter +
  // re-sum path so the shape and the invariant hold either way.
  return balanceSheetFromSnapshot(
    { assetBreakdown: fallback.assets, liabilityBreakdown: fallback.liabilities },
    isHidden,
  );
}

/** True once the server snapshot has actually landed. */
export function isNetWorthLoaded(snapshot: any): boolean {
  return !!snapshot && (snapshot.assetBreakdown != null || snapshot.totalAssetValue != null);
}
