// Recurrence for recurring-bill liabilities (utility, phone plan, streaming, …).
//
// A recurring liability is not a balance you pay down — it is a monthly (or
// yearly/weekly) service charge with a rolling due date. Instead of an
// amortization schedule it stores a single "next due date" in `fields.dueDate`
// and a cadence in `fields.frequency`; logging a payment advances that date by
// one cycle. This mirrors how tasks recur (shared/recurrence.ts) but reads the
// cadence off the liability profile's own fields rather than tag strings.
//
// Pure + dependency-free (only imports the shared recurrence primitives), so
// client, server, and tests share one definition.

import { freqToUnit, advance, type RecurrenceRule } from "./recurrence";

/** Normalize a user/registry frequency label to a recurrence freq token. */
export function normalizeBillFrequency(input?: string | null): string {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return "monthly"; // bills default to monthly
  if (["monthly", "month", "every month", "mo", "/mo"].includes(s)) return "monthly";
  if (["yearly", "annual", "annually", "year", "/yr", "per year"].includes(s)) return "yearly";
  if (["weekly", "week", "/wk"].includes(s)) return "weekly";
  if (["biweekly", "every 2 weeks", "fortnightly"].includes(s)) return "every-2-weeks";
  if (["daily", "day"].includes(s)) return "daily";
  if (["quarterly", "quarter"].includes(s)) return "every-3-months";
  // Already a recur token (e.g. "every-2-weeks")? pass through.
  return s;
}

/** Build a one-shot recurrence rule from a bill frequency (no end condition). */
export function billRecurrenceRule(frequency?: string | null): RecurrenceRule {
  const freq = normalizeBillFrequency(frequency);
  // freqToUnit doesn't know "every-3-months"; map it here.
  const q = freq.match(/^every-(\d+)-months?$/);
  if (q) {
    return { freq, interval: Math.max(1, +q[1]), unit: "month", until: undefined, count: undefined, done: 0, paused: false };
  }
  const { unit, interval } = freqToUnit(freq);
  return { freq, interval, unit, until: undefined, count: undefined, done: 0, paused: false };
}

/** Read the current next-due date from a liability's fields (YYYY-MM-DD or ""). */
export function readDueDate(fields: any): string {
  const f = fields || {};
  return String(f.dueDate ?? f.due_date ?? f.nextDueDate ?? f.next_due_date ?? f.renewalDate ?? f.renewal_date ?? "").slice(0, 10);
}

/**
 * Advance a recurring liability's due date by one cycle.
 * `todayISO` is the caller's local YYYY-MM-DD; when the stored due date is
 * missing or already in the past we roll forward from today so the next due
 * date is always in the future.
 */
export function advanceLiabilityDueDate(fields: any, todayISO: string): string {
  const rule = billRecurrenceRule((fields || {}).frequency ?? (fields || {}).billingFrequency);
  const current = readDueDate(fields);
  const base = current && current >= todayISO ? current : (current || todayISO);
  let next = advance(base, rule);
  // If advancing one cycle from a stale past date still lands in the past,
  // keep rolling until the next due date is today or later.
  let guard = 0;
  while (next < todayISO && guard < 240) {
    next = advance(next, rule);
    guard++;
  }
  return next;
}
