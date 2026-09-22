// ── The "Financial Snapshot" line in the AI's context ───────────────────────
// One rule for net worth: `computeNetWorth` (shared/net-worth), the model the
// Net Worth tile, the assets page and the net-worth history all read. The
// chat context used to carry its own arithmetic — direct children of Self
// only, a fixed type list, one value-field chain, no ownership shares, and a
// hard-coded Los Angeles month for "this month's spend" — so the AI answered
// "what's my net worth?" with a figure the dashboard never showed.
import { computeNetWorth, type OwnershipTables } from "@shared/net-worth";
import { toMonthlyAmount } from "@shared/obligation-windows";
import { getUserCurrentMonth } from "@shared/timezone";
import { monthlySpend, LEDGER_MANUAL, type LedgerSource } from "@shared/expense-ledger";
import { excludeTestData } from "@shared/test-data";

export interface FinancialSnapshotInput {
  /** EVERY profile — the net-worth model scopes by `selectedIds` itself. */
  allProfiles: readonly any[];
  /** The active scope (profile filter ids); empty means everyone. */
  selectedIds?: readonly string[];
  ownership?: OwnershipTables;
  obligations: readonly any[];
  expenses: readonly any[];
  timezone: string;
  /**
   * Rule 27: synthetic QA rows (shared/test-data name patterns) never enter
   * a total unless the caller opted in — the same switch as
   * `?includeTestData=1` on the dashboard. Default off.
   */
  includeTestData?: boolean;
}

export function financialSnapshot(input: FinancialSnapshotInput) {
  const selectedIds = [...(input.selectedIds || [])];
  const nw = computeNetWorth([...input.allProfiles], {
    mode: selectedIds.length > 0 ? "selected" : "everyone",
    selectedIds,
    ownership: input.ownership,
  });
  const monthlySubs = excludeTestData(input.obligations as any[], input.includeTestData)
    .filter((o: any) => o?.status !== "cancelled")
    .reduce((s: number, o: any) => s + toMonthlyAmount(Number(o.amount || 0), o.frequency), 0);
  const month = getUserCurrentMonth(input.timezone);
  // Rule 15: the MANUAL expenses ledger, summed by the one shared calc
  // (shared/expense-ledger). The payload says which ledger it is so a
  // connected-account spend figure (server/finance-routes buildSummary,
  // `ledger: "connected"`) is never read as the same number.
  const thisMonthSpend = monthlySpend(excludeTestData(input.expenses as any[], input.includeTestData), month);
  const ledger: LedgerSource = LEDGER_MANUAL;
  return { netWorth: nw.netWorth, assets: nw.assets, liabilities: nw.liabilities, monthlySubs, thisMonthSpend, month, ledger };
}

export function financialSnapshotLine(input: FinancialSnapshotInput): string {
  const s = financialSnapshot(input);
  const money = (n: number) => Math.round(n).toLocaleString();
  return `Financial Snapshot: Net Worth ~$${money(s.netWorth)}, Assets $${money(s.assets)}, Liabilities $${money(s.liabilities)}, Monthly Obligations $${money(s.monthlySubs)}, This Month Spend (${s.month}, ${s.ledger} ledger) $${money(s.thisMonthSpend)}`;
}
