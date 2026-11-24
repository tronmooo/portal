// shared/debt-payments-timeline.ts — a loan's or card's payments in Bills &
// Payments, from the series the Calendar draws.
//
// QA 2026-11-24 (second pass): the Executive Money card and Bills & Payments
// both said "Nothing due in the next 30 days" while the Calendar listed the
// demo auto loan's payment on December 20, 26 days away. Bills & Payments
// was built from the recurring BILLS only (shared/bills-timeline); the
// Calendar puts EVERY liability's payment dates on the grid (a loan or card
// derives its series from its terms: deriveScheduleFields → generateSchedule).
// This module reads the debt through those same two functions, so the panel
// and the Calendar cannot name different days (Rule 1).
//
// What a debt adds:
//   upcoming  its next payment on or after today that is still to pay (not
//             paid, skipped or missed), inside the same window as the bills
//   past      every payment recorded in the last PAST_BILL_WINDOW_DAYS
// A loan instalment is never ASSUMED paid (that rule is the recurring bills'
// alone, A7): a missed one stays on the debt's own page, where it is late.
//
// A debt that a "<name> payment" bill services is left out — the bill is in
// the list already and carries its payments (L1, legacy pairs).
//
// Pure. Both storages call it from getDashboardEnhanced.

import { deriveScheduleFields, generateSchedule, liabilityFrequency } from "./liability-schedule";
import { billsServicingDebt, isRecurringBillProfile, liabilityFamily } from "./liability-types";
import { isAutoPayOn } from "./autopay";
import { PAST_BILL_WINDOW_DAYS, type BillTimelineRow, type BillsTimeline } from "./bills-timeline";
import { UPCOMING_BILL_WINDOW_DAYS } from "./obligation-windows";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayDiff(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T12:00:00Z`) - Date.parse(`${fromISO}T12:00:00Z`)) / 86_400_000);
}

export interface DebtProfileLike {
  id: string;
  name: string;
  type?: string | null;
  type_key?: string | null;
  typeKey?: string | null;
  fields?: Record<string, any> | null;
}

export interface DebtPaymentLike {
  id?: string;
  /** YYYY-MM-DD (liability_payments.payment_date). */
  paymentDate?: string | null;
  amount?: number | null;
}

/** A liability the Calendar draws as a debt (not a recurring bill). */
export function isCalendarDebtProfile(p: DebtProfileLike | null | undefined): boolean {
  if (!p) return false;
  if (p.type !== "liability" && p.type !== "loan") return false;
  if (isRecurringBillProfile(p as any)) return false;
  return liabilityFamily(p.type_key ?? p.typeKey ?? null) !== "recurring";
}

/** "auto_loan" → "Auto loan" — what kind of debt, for the row's subtitle. */
function debtKindLabel(typeKey: string | null | undefined): string {
  const t = String(typeKey || "loan").replace(/[-_]+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "Loan";
}

/**
 * The rows `debts` add to Bills & Payments. `profiles` is every profile the
 * caller can see (to find a payment bill that already lists the debt);
 * `paymentsByDebt` the recorded payments per debt id.
 */
export function debtPaymentRows(
  debts: readonly DebtProfileLike[],
  profiles: readonly DebtProfileLike[],
  paymentsByDebt: ReadonlyMap<string, readonly DebtPaymentLike[]>,
  todayISO: string,
  opts: { upcomingDays?: number; pastDays?: number } = {},
): BillsTimeline {
  const today = String(todayISO || "").slice(0, 10);
  const upcoming: BillTimelineRow[] = [];
  const past: BillTimelineRow[] = [];
  if (!DAY.test(today)) return { upcoming, past };
  const horizon = addDays(today, opts.upcomingDays ?? UPCOMING_BILL_WINDOW_DAYS);
  const since = addDays(today, -(opts.pastDays ?? PAST_BILL_WINDOW_DAYS));
  const bills = profiles.filter((p) => isRecurringBillProfile(p as any));

  for (const p of debts) {
    if (!p?.id || !isCalendarDebtProfile(p)) continue;
    if (billsServicingDebt(bills as any[], p as any).length > 0) continue;
    const typeKey = p.type_key ?? p.typeKey ?? null;
    const fields = p.fields || {};
    const payments = paymentsByDebt.get(p.id) || [];
    const sf = deriveScheduleFields(fields, typeKey, today);
    const frequency = liabilityFrequency({ id: p.id, fields: sf } as any);
    const row = (date: string, state: BillTimelineRow["state"], amount: number, keyTail = ""): BillTimelineRow => ({
      key: `${p.id}:${date}:${state}${keyTail}`,
      billId: p.id, name: p.name, amount, date,
      daysUntil: dayDiff(today, date),
      frequency, category: debtKindLabel(typeKey), kind: "payment",
      autopay: isAutoPayOn(fields),
      linkedLiabilityId: p.id,
      state,
    });

    for (const pay of payments) {
      const d = String(pay?.paymentDate || "").slice(0, 10);
      if (DAY.test(d) && d >= since && d <= today) past.push(row(d, "paid", Number(pay.amount) || 0, `:${pay.id ?? past.length}`));
    }

    // The Calendar's own call (getCalendarTimeline), over the window.
    const occ = generateSchedule(
      { id: p.id, fields: sf } as any,
      payments.map((x) => ({ paymentDate: x.paymentDate ?? undefined, id: x.id })) as any,
      { todayISO: today, windowStart: today, windowEnd: horizon },
    );
    const next = occ
      .filter((o) => o.effectiveDate >= today && o.effectiveDate <= horizon)
      .filter((o) => o.status !== "paid" && o.status !== "skipped" && o.status !== "missed")
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))[0];
    if (next && (Number(next.amount) || 0) > 0) upcoming.push(row(next.effectiveDate, "upcoming", Number(next.amount) || 0));
  }
  return { upcoming, past };
}

/** `base` with `extra` folded in, each list in the order the view shows it. */
export function mergeBillsTimelines(base: BillsTimeline, extra: BillsTimeline): BillsTimeline {
  if (extra.upcoming.length === 0 && extra.past.length === 0) return base;
  const upcoming = [...base.upcoming, ...extra.upcoming]
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  const past = [...base.past, ...extra.past]
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  return { upcoming, past };
}
