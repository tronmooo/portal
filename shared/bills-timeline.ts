// shared/bills-timeline.ts — the Finance tab's "Bills & Payments" view.
//
// Owner request 2026-11-21: the Finance Bills card and the Bills popup listed
// every subscription as OVERDUE with a red Pay button ("Spotify · 235d
// overdue") because the stored due date of a recurring bill never moved when
// the money left the account on its own. The owner's rule for this view: a
// recurring bill whose due date has passed is ASSUMED PAID. The view rolls it
// forward to its next date and lists the elapsed dates under "Past".
//
// Two lists, both derived from the obligations (no stored state, Rule 5):
//   upcoming  each active bill's next date on or after today, within
//             UPCOMING_BILL_WINDOW_DAYS — elapsed cycles are skipped as paid
//   past      what was paid in the last PAST_BILL_WINDOW_DAYS: every recorded
//             payment (`paid`), plus each elapsed cycle nobody recorded
//             (`assumed` — Auto Pay's word, A2: an assumed payment is never
//             labelled "Paid"; the view says "Past")
//
// Nothing here writes a payment. Paying still goes through the bill's own page.

import { billRecurrenceRule, isOneTimeFrequency } from "./liability-recurrence";
import { advance } from "./recurrence";
import { UPCOMING_BILL_WINDOW_DAYS, isActiveObligation } from "./obligation-windows";

export const PAST_BILL_WINDOW_DAYS = 90;

export interface BillsTimelineObligation {
  id: string;
  name: string;
  amount: number;
  frequency?: string | null;
  category?: string | null;
  kind?: string | null;
  nextDueDate?: string | null;
  status?: string | null;
  recurrenceEnd?: string | null;
  autopay?: boolean;
  linkedLiabilityId?: string | null;
  payments?: Array<{ id?: string; amount?: number; date?: string | null }> | null;
}

export interface BillTimelineRow {
  /** Unique per row: `<bill id>:<date>` (a bill appears once per date). */
  key: string;
  billId: string;
  name: string;
  amount: number;
  /** YYYY-MM-DD */
  date: string;
  /** Whole calendar days from today (negative = in the past). */
  daysUntil: number;
  frequency: string;
  category: string;
  kind: string;
  autopay: boolean;
  linkedLiabilityId: string | null;
  /** upcoming: still to come · paid: a recorded payment · assumed: an elapsed date assumed paid */
  state: "upcoming" | "paid" | "assumed";
}

export interface BillsTimeline {
  upcoming: BillTimelineRow[];
  past: BillTimelineRow[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayDiff(fromISO: string, toISO: string): number {
  return Math.round((Date.parse(`${toISO}T12:00:00Z`) - Date.parse(`${fromISO}T12:00:00Z`)) / 86_400_000);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Build the Upcoming / Past lists. `todayISO` is the user's local day.
 */
export function buildBillsTimeline(
  obligations: readonly BillsTimelineObligation[] | null | undefined,
  todayISO: string,
  opts: { upcomingDays?: number; pastDays?: number } = {},
): BillsTimeline {
  const today = String(todayISO || "").slice(0, 10);
  const upcoming: BillTimelineRow[] = [];
  const past: BillTimelineRow[] = [];
  if (!DAY.test(today)) return { upcoming, past };
  const horizon = addDays(today, opts.upcomingDays ?? UPCOMING_BILL_WINDOW_DAYS);
  const since = addDays(today, -(opts.pastDays ?? PAST_BILL_WINDOW_DAYS));

  for (const o of obligations || []) {
    if (!o || !o.id) continue;
    const frequency = String(o.frequency || "monthly");
    const row = (date: string, state: BillTimelineRow["state"], amount = Number(o.amount) || 0): BillTimelineRow => ({
      key: `${o.id}:${date}:${state}`,
      billId: o.id, name: o.name, amount, date,
      daysUntil: dayDiff(today, date),
      frequency, category: String(o.category || "general"), kind: String(o.kind || "bill"),
      autopay: o.autopay === true,
      linkedLiabilityId: o.linkedLiabilityId || null,
      state,
    });

    // Recorded payments are history whatever the bill's status is now: a
    // subscription cancelled last week was still paid last month.
    for (const p of o.payments || []) {
      const d = String(p?.date || "").slice(0, 10);
      if (DAY.test(d) && d >= since && d <= today) past.push({ ...row(d, "paid", Number(p.amount) || 0), key: `${o.id}:${d}:paid:${p.id ?? past.length}` });
    }

    // A paused, cancelled or ended bill has nothing coming and nothing to assume.
    if (!isActiveObligation(o as any)) continue;
    const stored = String(o.nextDueDate || "").slice(0, 10);
    if (!DAY.test(stored)) continue;
    const end = DAY.test(String(o.recurrenceEnd || "").slice(0, 10)) ? String(o.recurrenceEnd).slice(0, 10) : "";

    if (isOneTimeFrequency(frequency)) {
      if (stored >= today) { if (stored <= horizon) upcoming.push(row(stored, "upcoming")); }
      else if (stored >= since) past.push(row(stored, "assumed"));
      continue;
    }

    const rule = billRecurrenceRule(frequency);
    if (!rule.unit) continue;
    rule.anchorDay = Number(stored.slice(8, 10));
    let cur = stored;
    // Every elapsed cycle is assumed paid; the walk stops at the first date on
    // or after today. Bounded: ten years of weekly cycles.
    for (let guard = 0; guard < 600 && cur < today; guard++) {
      if (end && cur > end) break;
      if (cur >= since) past.push(row(cur, "assumed"));
      const next = advance(cur, rule);
      if (!DAY.test(next) || next <= cur) { cur = ""; break; }
      cur = next;
    }
    if (cur && cur >= today && cur <= horizon && !(end && cur > end)) upcoming.push(row(cur, "upcoming"));
  }

  upcoming.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  past.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  return { upcoming, past };
}

/**
 * The next date a bill falls on, on or after `todayISO` — the same walk the
 * timeline makes, for the surfaces that list bills without a Past section
 * (the dashboard Money card, the bell, the month's still-to-pay total).
 * Elapsed cycles are assumed paid. Null when nothing is coming: a one-time
 * bill whose day has passed, or a series past its end.
 */
export function nextBillDate(
  o: Pick<BillsTimelineObligation, "frequency" | "nextDueDate" | "recurrenceEnd"> | null | undefined,
  todayISO: string,
): string | null {
  const today = String(todayISO || "").slice(0, 10);
  const stored = String(o?.nextDueDate || "").slice(0, 10);
  if (!DAY.test(today) || !DAY.test(stored)) return null;
  const end = DAY.test(String(o?.recurrenceEnd || "").slice(0, 10)) ? String(o!.recurrenceEnd).slice(0, 10) : "";
  if (stored >= today) return end && stored > end ? null : stored;
  const frequency = String(o?.frequency || "monthly");
  if (isOneTimeFrequency(frequency)) return null;
  const rule = billRecurrenceRule(frequency);
  if (!rule.unit) return null;
  rule.anchorDay = Number(stored.slice(8, 10));
  let cur = stored;
  for (let guard = 0; guard < 600 && cur < today; guard++) {
    const next = advance(cur, rule);
    if (!DAY.test(next) || next <= cur) return null;
    cur = next;
  }
  if (cur < today || (end && cur > end)) return null;
  return cur;
}

/**
 * Every ACTIVE bill with its due date rolled to its next date (owner rule
 * 2026-11-21, applied to the dashboard 2026-11-22: "show the next scheduled
 * payments, not an accumulating backlog of old bill occurrences"). A bill with
 * nothing coming is left out. Paused, cancelled and ended bills pass through
 * untouched — every reader already skips them by status.
 *
 * This is a READ rule. The stored date still moves only when an occurrence is
 * paid, skipped or marked missed, and a payment marked missed keeps its own
 * alert (Auto Pay rule A3).
 */
export function rollBillsForward<T extends { frequency?: string | null; nextDueDate?: any; status?: string | null; recurrenceEnd?: string | null }>(
  obligations: readonly T[] | null | undefined,
  todayISO: string,
): T[] {
  const out: T[] = [];
  for (const o of obligations || []) {
    if (!o) continue;
    if (!isActiveObligation(o as any)) { out.push(o); continue; }
    const stored = typeof o.nextDueDate === "string" ? o.nextDueDate.slice(0, 10) : "";
    if (!DAY.test(stored)) { out.push(o); continue; }
    const next = nextBillDate(o as any, todayISO);
    if (!next) continue;
    out.push(next === stored ? o : { ...o, nextDueDate: next });
  }
  return out;
}
