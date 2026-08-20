// Occurrence schedule for a recurring-bill liability.
//
// Recurring bills are stored as ONE liability profile (no per-occurrence rows).
// Their individual payment occurrences are *derived* on the fly from the
// profile's recurrence fields, then adjusted by a small map of per-occurrence
// exceptions kept on the profile itself — so "skip August", "move this month to
// the 18th", "mark it paid", or "pause until January" need no new table and no
// migration. This module is the single, pure source of truth for that schedule;
// the calendar, the dashboard bills, and the liability detail page all read it.
//
// fields.occurrences is keyed by the canonical (unshifted) YYYY-MM-DD date:
//   { "2026-08-15": { status?: "paid"|"skipped", amount?, movedTo?, notes?, paymentId? } }
// fields.paused / fields.pausedUntil suppress generation while paused.

import { freqToUnit, advance, type RecurrenceRule } from "./recurrence";
import { normalizeDateString } from "./extraction-normalize";
import { liabilityBillStatus, type BillStatus } from "./liability-status";
import { liabilityFamily } from "./liability-types";
import {
  resolveBillingModel, resolveOccurrenceAmount,
  type BillingModel, type OccurrenceCharge, type OccurrenceOverride,
} from "./liability-billing";

export type OccurrenceStatus = BillStatus | "skipped";

export interface ScheduleOccurrence {
  /** Canonical series date (the unshifted due date) — the override key. */
  date: string;
  /** Date after any per-occurrence reschedule (`movedTo`); equals `date` otherwise. */
  effectiveDate: string;
  /** The number to display and to sum: actual if posted, else base + charges. */
  amount: number;
  status: OccurrenceStatus;
  notes?: string;
  /** Stable synthetic id: `<liabilityId>:<date>` — no occurrence table needed. */
  occurrenceId: string;
  /** liability_payments row id when this occurrence has been paid. */
  paymentId?: string;
  /** True when a per-occurrence exception was applied (skipped/moved/amount/notes). */
  overridden: boolean;

  // ── Variable / usage-based billing (shared/liability-billing.ts) ──
  /** The billing model this occurrence was priced under. */
  billingModel: BillingModel;
  /** The base/expected portion of `amount`, before charges. */
  baseAmount: number;
  /** What we expect this period to cost, while it has not posted. */
  estimatedAmount: number | null;
  /** What actually posted. Once set, this period is frozen history. */
  actualAmount: number | null;
  /** Charge line items filed against THIS period only. */
  charges: OccurrenceCharge[];
  /** Sum of `charges` (discounts subtract). */
  chargeTotal: number;
  /** True while `amount` is still a forecast. */
  isEstimate: boolean;
  /** "Estimated" | "Current" | "Actual" — the word to render beside `amount`. */
  amountLabel: "Estimated" | "Current" | "Actual";
  /** Account the payment came from, when recorded. */
  accountId?: string;
}

export interface Liabilityish {
  id: string;
  fields?: Record<string, any> | null;
}

export interface Paymentish {
  id?: string;
  paymentDate?: string | null;
  payment_date?: string | null;
  amount?: number | null;
}

export interface ScheduleOptions {
  /** Caller's tz-local today, YYYY-MM-DD. Drives overdue/due-today/upcoming. */
  todayISO: string;
  /** Inclusive window start (YYYY-MM-DD). Default: today. */
  windowStart?: string;
  /** Inclusive window end (YYYY-MM-DD). Default: today + `months`. */
  windowEnd?: string;
  /** Window length in months when windowEnd is omitted. Default 12. */
  months?: number;
  /** Hard safety cap on generated occurrences. Default 500. */
  cap?: number;
  /**
   * Billing model override. Normally resolved from the liability itself; pass
   * it when the caller already normalized the fields (deriveScheduleFields
   * strips the type_key the resolver would otherwise read).
   */
  billingModel?: BillingModel;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}/;
const clip = (d: any): string => String(d ?? "").slice(0, 10);

// Month arithmetic comes from the canonical, month-end-clamping helper.
import { addMonthsISO } from "./date-math";

/**
 * Normalize ANY liability into the fields the schedule generator understands,
 * so loans, credit cards, and one-time debts get a payment schedule too — not
 * just recurring bills. Recurring bills pass through unchanged; amortizing /
 * revolving / one-time debts derive a monthly payment series from their
 * monthly payment, due day, and remaining term.
 */
/**
 * THE next-payment date on a liability's fields.
 *
 * Two readers used to answer this separately and could disagree about the same
 * row: the schedule card put `nextPaymentDate` first, the calendar adapter put
 * `nextDueDate` first, and neither normalized — so a legacy "07/18/2026" fell
 * through to today on one surface and rendered correctly on the other.
 *
 * Precedence is most-deliberate first: `nextPaymentDate` and `nextPayment` are
 * what the Payments tab writes when the user edits "Next Due", and that edit
 * must not be shadowed by the `dueDate` written when the liability was created.
 */
export function resolveLiabilityDueDate(f: Record<string, any> | null | undefined): string | null {
  const fields = f || {};
  // The first spelling that PARSES, not the first that is merely present.
  // Coalescing with `??` first meant an empty-string `nextPayment` — which `??`
  // does not skip — short-circuited the chain and returned null, and the
  // liability then emitted no series at all: it left the calendar entirely.
  for (const v of [
    fields.nextPaymentDate, fields.nextPayment, fields.next_payment,
    fields.nextDueDate, fields.next_due_date,
    fields.dueDate, fields.due_date,
    fields.firstPaymentDate,
  ]) {
    const iso = normalizeDateString(v);
    if (iso) return iso;
  }
  return null;
}

/**
 * THE date a liability's payments stop, or null.
 *
 * Same trap as `resolveLiabilityDueDate`, same fix: coalescing the spelling
 * chain with `??` first meant a blank `payoffDate` — which `??` does not skip —
 * short-circuited past a real `endDate`, and the series then had no end at all
 * and generated payments past payoff.
 */
export function resolveLiabilityEndDate(f: Record<string, any> | null | undefined): string | null {
  const fields = f || {};
  for (const v of [
    fields.payoffDate, fields.payoff_date,
    fields.endDate, fields.end_date, fields.recurrenceEnd,
  ]) {
    const iso = normalizeDateString(v);
    if (iso) return iso;
  }
  return null;
}

export function deriveScheduleFields(
  fields: Record<string, any> | null | undefined,
  typeKey: string | null | undefined,
  todayISO: string,
): Record<string, any> {
  const f = fields || {};
  const fam = liabilityFamily(typeKey);
  if (fam === "recurring") return f;

  const amount = Number(f.monthlyPayment ?? f.minimumPayment ?? f.amount ?? f.monthlyAmount ?? 0) || 0;
  // Next payment date: an explicit date, else the due day this/next month.
  // `nextPayment` included for the same reason as in shared/calendar-adapters:
  // it is a spelling the profile writer produces, and without it this falls
  // through to `todayISO` — putting a payment on the wrong day rather than
  // none at all, which is worse.
  let due = clip(resolveLiabilityDueDate(f) ?? "");
  if (!ISO_RE.test(due)) {
    const day = parseInt(String(f.dueDay ?? ""), 10);
    if (day >= 1 && day <= 31) {
      const d = new Date(todayISO + "T00:00:00");
      let mo = d.getMonth() + (d.getDate() > day ? 1 : 0);
      const yr = d.getFullYear() + (mo > 11 ? 1 : 0);
      mo = ((mo % 12) + 12) % 12;
      const last = new Date(yr, mo + 1, 0).getDate();
      due = new Date(yr, mo, Math.min(day, last)).toLocaleDateString("en-CA");
    }
  }
  if (!ISO_RE.test(due)) due = todayISO;

  let count: number | null = null;
  if (fam === "one_time") count = 1;
  else if (fam === "amortizing") {
    const rt = parseInt(String(f.remainingTermMonths ?? f.termMonths ?? ""), 10);
    if (rt > 0) count = rt;
    else {
      const bal = Number(f.currentBalance ?? f.originalBalance ?? 0);
      if (amount > 0 && bal > 0) count = Math.min(600, Math.ceil(bal / amount));
    }
  }
  // revolving (credit card / line of credit) → open-ended monthly minimum.
  return {
    ...f,
    frequency: fam === "one_time" ? "once" : "monthly",
    monthlyAmount: amount, amount,
    dueDate: due, nextDueDate: due,
    firstPaymentDate: ISO_RE.test(clip(f.firstPaymentDate)) ? clip(f.firstPaymentDate) : due,
    ...(count != null ? { count } : {}),
  };
}

/** The recurrence frequency token for a liability, from either field alias. */
export function liabilityFrequency(liability: Liabilityish): string {
  const f = liability.fields || {};
  return String(f.frequency ?? f.billingFrequency ?? "monthly").toLowerCase().trim() || "monthly";
}

/** The base per-occurrence amount (before per-occurrence overrides). */
export function liabilityAmount(liability: Liabilityish): number {
  const f = liability.fields || {};
  return Number(f.monthlyAmount ?? f.amount ?? f.cost ?? 0) || 0;
}

/** Anchor date the series is generated from. */
function seriesAnchor(liability: Liabilityish): string | null {
  const f = liability.fields || {};
  const a = clip(f.firstPaymentDate ?? f.dueDate ?? f.nextDueDate ?? f.due_date ?? f.next_due_date ?? f.renewalDate);
  return ISO_RE.test(a) ? a : null;
}

/**
 * Generate the payment occurrences for a recurring liability within a window,
 * applying per-occurrence overrides, payment history, and pause state. Pure.
 */
export function generateSchedule(
  liability: Liabilityish,
  payments: Paymentish[] = [],
  opts: ScheduleOptions,
): ScheduleOccurrence[] {
  const f = liability.fields || {};
  const billingModel = opts.billingModel ?? resolveBillingModel(liability as any);
  const anchor = seriesAnchor(liability);
  if (!anchor) return [];

  const today = opts.todayISO;
  const windowStart = opts.windowStart ?? today;
  const windowEnd = opts.windowEnd ?? addMonthsISO(today, opts.months ?? 12);
  const cap = opts.cap ?? 500;

  const { unit, interval } = freqToUnit(liabilityFrequency(liability));
  // Pin monthly/yearly bills to the anchor's day-of-month. Without this the
  // walk below steps off each previous occurrence, so a bill due on the 31st
  // overflows through a short month and silently becomes a bill due on the 1st.
  const anchorDate = new Date(anchor + "T00:00:00");
  const anchorDay = Number.isNaN(anchorDate.getTime()) ? undefined : anchorDate.getDate();
  const rule: RecurrenceRule = { freq: "x", interval, unit, done: 0, paused: false, anchorDay };
  const recurs = unit !== "";

  const overrides: Record<string, any> = (f.occurrences && typeof f.occurrences === "object") ? f.occurrences : {};
  const baseAmount = liabilityAmount(liability);

  // Dates that carry a real payment (source of truth for "paid").
  const paidByDate = new Map<string, string | undefined>();
  for (const p of payments) {
    const d = clip(p.paymentDate ?? p.payment_date);
    if (ISO_RE.test(d)) paidByDate.set(d, p.id);
  }

  const paused = f.paused === true;
  const pausedUntil = ISO_RE.test(clip(f.pausedUntil)) ? clip(f.pausedUntil) : null;
  const inPausedSpan = (dISO: string) =>
    paused && dISO >= today && (!pausedUntil || dISO < pausedUntil);

  // Finite term: a fixed number of payments and/or a hard end date. Series
  // occurrences past either bound are not generated.
  const seriesEnd = ISO_RE.test(clip(f.recurrenceEnd)) ? clip(f.recurrenceEnd) : null;
  const maxCount = f.count != null ? Math.max(1, parseInt(String(f.count), 10) || 0) : null;

  const out: ScheduleOccurrence[] = [];
  let cur = anchor;
  let seriesIndex = 0; // occurrences counted from the anchor (for maxCount)
  // Extend the walk backward to the earliest overridden date so a paid or
  // skipped past occurrence stays visible even after `dueDate` advanced past
  // it (the anchor moves forward as bills are paid; overrides do not). Override
  // keys are canonical on-grid dates, so this keeps cadence alignment.
  for (const d of Object.keys(overrides)) {
    if (ISO_RE.test(d) && d < cur) cur = d;
  }
  let guard = 0;
  const maxIter = Math.max(cap * 3, 1500);

  while (guard++ < maxIter) {
    if (cur > windowEnd) break;
    // Stop at the finite bounds (count of payments and/or hard end date).
    if (seriesEnd && cur > seriesEnd) break;
    if (maxCount != null && cur >= anchor && seriesIndex >= maxCount) break;
    if (cur >= anchor) seriesIndex++;

    const ov = overrides[cur] || null;
    const effectiveDate = ov && ISO_RE.test(clip(ov.movedTo)) ? clip(ov.movedTo) : cur;
    // Include when EITHER the canonical or the shifted date lands in-window.
    const inWindow = (cur >= windowStart && cur <= windowEnd) ||
      (effectiveDate >= windowStart && effectiveDate <= windowEnd);

    if (inWindow && !inPausedSpan(effectiveDate)) {
      const paymentId = ov?.paymentId ?? paidByDate.get(cur) ?? paidByDate.get(effectiveDate);
      const isPaid = ov?.status === "paid" || paymentId != null;
      const isSkipped = ov?.status === "skipped";
      const status: OccurrenceStatus = isSkipped
        ? "skipped"
        : liabilityBillStatus(effectiveDate, today, isPaid);
      // The per-occurrence money model. `amount` is whatever THIS period costs —
      // the definition's amount is only the starting point, never the answer.
      const money = resolveOccurrenceAmount(baseAmount, ov as OccurrenceOverride | null, billingModel);
      out.push({
        date: cur,
        effectiveDate,
        amount: money.current,
        status,
        notes: ov?.notes || undefined,
        occurrenceId: `${liability.id}:${cur}`,
        paymentId,
        overridden: !!ov,
        billingModel,
        baseAmount: money.base,
        estimatedAmount: money.estimated,
        actualAmount: money.actual,
        charges: money.charges,
        chargeTotal: money.chargeTotal,
        // A paid occurrence is history even before an actual is stamped on it.
        isEstimate: money.isEstimate && !isPaid,
        amountLabel: isPaid ? "Actual" : money.label,
        accountId: ov?.accountId || undefined,
      });
      if (out.length >= cap) break;
    }

    if (!recurs) break;
    const next = advance(cur, rule);
    if (next <= cur) break; // guard against a non-advancing rule
    cur = next;
  }

  return out;
}

/** The next unpaid, unskipped occurrence on/after today (the "next due"). */
export function nextDueOccurrence(
  liability: Liabilityish,
  payments: Paymentish[],
  todayISO: string,
  billingModel?: BillingModel,
): ScheduleOccurrence | null {
  const sched = generateSchedule(liability, payments, { todayISO, windowStart: todayISO, months: 18, billingModel });
  for (const o of sched) {
    if (o.status !== "paid" && o.status !== "skipped") return o;
  }
  return null;
}

/** Finite-term counts: total payments (if bounded), how many are paid, and how
 *  many remain. remainingPayments is null for an open-ended bill. */
export function scheduleCounts(
  liability: Liabilityish,
  payments: Paymentish[],
  todayISO: string,
): { totalPayments: number | null; paidCount: number; remainingPayments: number | null } {
  const f = liability.fields || {};
  const maxCount = f.count != null ? Math.max(1, parseInt(String(f.count), 10) || 0) : null;
  const full = generateSchedule(liability, payments, { todayISO, windowStart: "2000-01-01", windowEnd: "2100-01-01" });
  const paidCount = full.filter((o) => o.status === "paid").length;
  return {
    totalPayments: maxCount,
    paidCount,
    remainingPayments: maxCount != null ? Math.max(0, maxCount - paidCount) : null,
  };
}

/** Number of billing periods per year for the annual-total question. */
export function periodsPerYear(liability: Liabilityish): number {
  const { unit, interval } = freqToUnit(liabilityFrequency(liability));
  const perYear: Record<string, number> = { day: 365, week: 52, weekday: 260, month: 12, year: 1 };
  const base = perYear[unit] ?? 12;
  return interval > 0 ? base / interval : base;
}

// ─── Period rollups ──────────────────────────────────────────────────────────
//
// `definitionAmount × periodsPerYear` is only true for a FIXED bill. For a
// variable or usage-based one it is fiction: the electric bill that averaged
// $82 across Jan/Feb/Mar has no single monthly amount to multiply. Every
// rollup — annual total, cash flow, monthly expenses — must sum the actual
// occurrences instead, which is what these do.

export interface PeriodTotal {
  /** YYYY-MM. */
  period: string;
  /** Sum of every occurrence amount in the period (estimates included). */
  total: number;
  /** Sum of the occurrences that have actually posted. */
  actual: number;
  /** Sum of the occurrences still forecast. */
  estimated: number;
  /** True when any part of `total` is still a forecast. */
  hasEstimate: boolean;
  count: number;
}

const round2s = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Occurrence amounts bucketed by calendar month of their EFFECTIVE date. */
export function monthlyTotals(occurrences: readonly ScheduleOccurrence[]): PeriodTotal[] {
  const byPeriod = new Map<string, PeriodTotal>();
  for (const o of occurrences || []) {
    if (o.status === "skipped") continue;
    const period = String(o.effectiveDate || o.date).slice(0, 7);
    if (!period) continue;
    const row = byPeriod.get(period) ?? {
      period, total: 0, actual: 0, estimated: 0, hasEstimate: false, count: 0,
    };
    row.total += o.amount;
    if (o.isEstimate) { row.estimated += o.amount; row.hasEstimate = true; }
    else row.actual += o.amount;
    row.count++;
    byPeriod.set(period, row);
  }
  return [...byPeriod.values()]
    .map((r) => ({ ...r, total: round2s(r.total), actual: round2s(r.actual), estimated: round2s(r.estimated) }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

/** Sum of the occurrence amounts falling inside an inclusive date window. */
export function totalForWindow(
  occurrences: readonly ScheduleOccurrence[],
  startISO: string,
  endISO: string,
): { total: number; actual: number; estimated: number; count: number } {
  let total = 0, actual = 0, estimated = 0, count = 0;
  for (const o of occurrences || []) {
    if (o.status === "skipped") continue;
    const d = o.effectiveDate || o.date;
    if (d < startISO || d > endISO) continue;
    total += o.amount;
    if (o.isEstimate) estimated += o.amount; else actual += o.amount;
    count++;
  }
  return { total: round2s(total), actual: round2s(actual), estimated: round2s(estimated), count };
}
