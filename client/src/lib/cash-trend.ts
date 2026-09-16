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
import { sumMonthIncome, type ReceivedPaycheckInput } from "@shared/obligation-windows";

export interface CashTrendPoint { month: string; inflow: number; outflow: number; net: number }

/** "YYYY-MM" of the month `back` months before `todayISO`'s month. */
export function monthKeyBack(todayISO: string, back: number): string {
  const y = Number(todayISO.slice(0, 4));
  const m = Number(todayISO.slice(5, 7));
  const idx = y * 12 + (m - 1) - back;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export interface CashTrendOptions {
  months?: number;
  /** Confirmed paychecks — realized income, counted in the month they landed. */
  paychecks?: ReadonlyArray<ReceivedPaycheckInput> | null;
  /**
   * Bill money still owed in the CURRENT month. The card above the chart reads
   * OUT as `spend + unpaid bills`, while the chart's last bar summed expenses
   * alone — so the card said -$1,421 and the chart drew about -$115 for the
   * same month. Adding it to the current month's bar makes the two agree.
   */
  pendingOutflowThisMonth?: number;
}

export function buildCashTrend(
  expenses: ReadonlyArray<any> | null | undefined,
  incomes: ReadonlyArray<{ amount?: number | string | null; frequency?: string | null; date?: string | null }> | null | undefined,
  todayISO: string,
  timeZone: string,
  options: CashTrendOptions | number = {},
): CashTrendPoint[] {
  // `months` used to be the fifth positional argument; keep that call shape
  // working rather than breaking every caller for one new option.
  const opts: CashTrendOptions = typeof options === "number" ? { months: options } : (options || {});
  const months = opts.months ?? 6;
  const thisMonthKey = todayISO.slice(0, 7);
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
    const inflow = Math.round(sumMonthIncome(incomes, opts.paychecks, key));
    const pending = key === thisMonthKey ? Number(opts.pendingOutflowThisMonth) || 0 : 0;
    const outflow = Math.round((outByMonth[key] || 0) + pending);
    out.push({ month: label, inflow, outflow, net: inflow - outflow });
  }
  return out;
}
