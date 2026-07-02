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
import { liabilityBillStatus, type BillStatus } from "./liability-status";

export type OccurrenceStatus = BillStatus | "skipped";

export interface ScheduleOccurrence {
  /** Canonical series date (the unshifted due date) — the override key. */
  date: string;
  /** Date after any per-occurrence reschedule (`movedTo`); equals `date` otherwise. */
  effectiveDate: string;
  amount: number;
  status: OccurrenceStatus;
  notes?: string;
  /** Stable synthetic id: `<liabilityId>:<date>` — no occurrence table needed. */
  occurrenceId: string;
  /** liability_payments row id when this occurrence has been paid. */
  paymentId?: string;
  /** True when a per-occurrence exception was applied (skipped/moved/amount/notes). */
  overridden: boolean;
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
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}/;
const clip = (d: any): string => String(d ?? "").slice(0, 10);

function addMonthsISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setMonth(d.getMonth() + n);
  return d.toLocaleDateString("en-CA");
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
  const anchor = seriesAnchor(liability);
  if (!anchor) return [];

  const today = opts.todayISO;
  const windowStart = opts.windowStart ?? today;
  const windowEnd = opts.windowEnd ?? addMonthsISO(today, opts.months ?? 12);
  const cap = opts.cap ?? 500;

  const { unit, interval } = freqToUnit(liabilityFrequency(liability));
  const rule: RecurrenceRule = { freq: "x", interval, unit, done: 0, paused: false };
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

  const out: ScheduleOccurrence[] = [];
  let cur = anchor;
  let guard = 0;
  const maxIter = Math.max(cap * 3, 1500);

  while (guard++ < maxIter) {
    if (cur > windowEnd) break;

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
      out.push({
        date: cur,
        effectiveDate,
        amount: ov && ov.amount != null ? Number(ov.amount) : baseAmount,
        status,
        notes: ov?.notes || undefined,
        occurrenceId: `${liability.id}:${cur}`,
        paymentId,
        overridden: !!ov,
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
): ScheduleOccurrence | null {
  const sched = generateSchedule(liability, payments, { todayISO, windowStart: todayISO, months: 18 });
  for (const o of sched) {
    if (o.status !== "paid" && o.status !== "skipped") return o;
  }
  return null;
}

/** Number of billing periods per year for the annual-total question. */
export function periodsPerYear(liability: Liabilityish): number {
  const { unit, interval } = freqToUnit(liabilityFrequency(liability));
  const perYear: Record<string, number> = { day: 365, week: 52, weekday: 260, month: 12, year: 1 };
  const base = perYear[unit] ?? 12;
  return interval > 0 ? base / interval : base;
}
