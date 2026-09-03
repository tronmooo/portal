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

export interface FinancialSnapshotInput {
  /** EVERY profile — the net-worth model scopes by `selectedIds` itself. */
  allProfiles: readonly any[];
  /** The active scope (profile filter ids); empty means everyone. */
  selectedIds?: readonly string[];
  ownership?: OwnershipTables;
  obligations: readonly any[];
  expenses: readonly any[];
  timezone: string;
}

export function financialSnapshot(input: FinancialSnapshotInput) {
  const selectedIds = [...(input.selectedIds || [])];
  const nw = computeNetWorth([...input.allProfiles], {
    mode: selectedIds.length > 0 ? "selected" : "everyone",
    selectedIds,
    ownership: input.ownership,
  });
  const monthlySubs = input.obligations
    .filter((o: any) => o?.status !== "cancelled")
    .reduce((s: number, o: any) => s + toMonthlyAmount(Number(o.amount || 0), o.frequency), 0);
  const month = getUserCurrentMonth(input.timezone);
  const thisMonthSpend = input.expenses
    .filter((e: any) => typeof e?.date === "string" && e.date.startsWith(month))
    .reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
  return { netWorth: nw.netWorth, assets: nw.assets, liabilities: nw.liabilities, monthlySubs, thisMonthSpend, month };
}

export function financialSnapshotLine(input: FinancialSnapshotInput): string {
  const s = financialSnapshot(input);
  const money = (n: number) => Math.round(n).toLocaleString();
  return `Financial Snapshot: Net Worth ~$${money(s.netWorth)}, Assets $${money(s.assets)}, Liabilities $${money(s.liabilities)}, Monthly Obligations $${money(s.monthlySubs)}, This Month Spend (${s.month}) $${money(s.thisMonthSpend)}`;
}
