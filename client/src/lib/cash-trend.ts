// Six-month in/out/net series shared by the Money overview cards AND the Cash
// Flow Overview popup, so both surfaces plot identical numbers.
//
// Outflow is summed per calendar month from real expenses, bucketed by the
// expense's own YYYY-MM (an expense dated "2026-09-01" is September — parsing
// it with `new Date()` made it UTC midnight, which is Aug 31 for every US
// user, so first-of-month spending slid into the previous bar). Inflow is
// the income that existed in that month (shared/obligation-windows), not
// today's income painted across all six.
import { localDayOf } from "@shared/timezone";
import { sumMonthlyIncomeForMonth } from "@shared/obligation-windows";

export interface CashTrendPoint { month: string; inflow: number; outflow: number; net: number }

/** "YYYY-MM" of the month `back` months before `todayISO`'s month. */
export function monthKeyBack(todayISO: string, back: number): string {
  const y = Number(todayISO.slice(0, 4));
  const m = Number(todayISO.slice(5, 7));
  const idx = y * 12 + (m - 1) - back;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function buildCashTrend(
  expenses: ReadonlyArray<any> | null | undefined,
  incomes: ReadonlyArray<{ amount?: number | string | null; frequency?: string | null; date?: string | null }> | null | undefined,
  todayISO: string,
  timeZone: string,
  months = 6,
): CashTrendPoint[] {
  const outByMonth: Record<string, number> = {};
  for (const e of (Array.isArray(expenses) ? expenses : [])) {
    const date: string | undefined = typeof e?.date === "string" && /^\d{4}-\d{2}/.test(e.date) ? e.date : (e?.createdAt ? localDayOf(e.createdAt, timeZone) ?? undefined : undefined);
    if (!date) continue;
    const k = date.slice(0, 7);
    outByMonth[k] = (outByMonth[k] || 0) + (Number(e?.amount) || 0);
  }
  const out: CashTrendPoint[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const key = monthKeyBack(todayISO, i);
    const label = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 15)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    const inflow = Math.round(sumMonthlyIncomeForMonth(incomes, key));
    const outflow = Math.round(outByMonth[key] || 0);
    out.push({ month: label, inflow, outflow, net: inflow - outflow });
  }
  return out;
}
