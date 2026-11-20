// Auto Pay: the rules every surface shares.
//
// A liability with Auto Pay ON is paid by somebody else's system (the lender's
// debit, the card on file). Portol does not move the money; it keeps the books:
// on the due day it records the scheduled payment so the user does not have to
// tap "Mark paid" every month. That recorded payment is an ASSUMPTION until the
// user or a bank transaction confirms it, and the difference is never hidden:
//
//   scheduled       expected, not yet due
//   assumed_paid    recorded on the due day because Auto Pay is on
//   confirmed_paid  the user recorded / confirmed it, or a bank transaction matched
//   missed          the user said it did not happen (the assumed payment is reversed)
//   delayed         this one occurrence was moved to another day
//   partial         less than the scheduled amount was paid
//
// State lives in ONE place: the occurrence stamp on the liability
// (`fields.occurrences[<anchor day>]`), next to the `paymentId` of the single
// ledger row that payment is. Nothing here is a second copy of a payment.
//
// Pure and dependency-light, so the client, the server and the tests agree.

import { addMonthsISO } from "./date-math";
import { normalizeDateString } from "./extraction-normalize";
import { readMonthlyPayment, readStoredDueDate } from "./liability-fields";
import { currentBillDueDate, effectiveDueDate, isEndedBillFields, isPausedBillFields } from "./liability-recurrence";
import { isWithinOverdueGrace } from "./liability-status";
import { isRecurringBill, liabilityFamily } from "./liability-types";
import { lastPaymentCoversCycle, loanDueDay } from "./loan-facts";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const clip = (v: unknown) => String(v ?? "").slice(0, 10);

// ─── The setting ─────────────────────────────────────────────────────────────

/** Is Auto Pay on for this liability? THE reader — two spellings were stored. */
export function isAutoPayOn(fields: Record<string, any> | null | undefined): boolean {
  const f = fields || {};
  const on = (v: unknown) => v === true || String(v ?? "").trim().toLowerCase() === "true";
  return on(f.autopay) || on(f.autoPay);
}

/**
 * Does the user still want due-date reminders for an Auto Pay liability?
 * Off unless they asked: the point of Auto Pay is that nothing needs doing.
 */
export function autoPayRemindersOn(fields: Record<string, any> | null | undefined): boolean {
  return (fields || {}).autopayReminders === true;
}

/** Should this liability raise due-date reminders at all? */
export function wantsDueReminders(fields: Record<string, any> | null | undefined): boolean {
  return !isAutoPayOn(fields) || autoPayRemindersOn(fields);
}

/**
 * Is this upcoming bill one Auto Pay handles without the user? Then it stays
 * out of "needs attention" lists and raises no due-soon alert. An OVERDUE
 * Auto Pay bill is not quiet: the payment was not recorded, which is exactly
 * the exception the user needs to see.
 */
export function isQuietAutoPayBill(bill: { autopay?: unknown; autopayReminders?: unknown } | null | undefined, daysUntil: number | null | undefined): boolean {
  if (!bill || bill.autopay !== true || bill.autopayReminders === true) return false;
  return daysUntil == null || daysUntil >= 0;
}

/** The day Auto Pay was switched on (YYYY-MM-DD), or "" for a legacy flag with no date. */
export function autoPaySince(fields: Record<string, any> | null | undefined): string {
  const d = clip((fields || {}).autoRecordSince);
  return ISO_DAY.test(d) ? d : "";
}

/** The account profile Auto Pay draws from, when the user named one. */
export function autoPayAccountId(fields: Record<string, any> | null | undefined): string | null {
  const id = (fields || {}).autopayAccountId;
  return typeof id === "string" && id ? id : null;
}

/**
 * The field patch for switching Auto Pay on or off — every door writes THIS,
 * so both stored spellings move together and "on since" is stamped once.
 * Turning it off touches nothing else: history and the schedule stay.
 */
export function autoPaySettingPatch(
  fields: Record<string, any> | null | undefined,
  enabled: boolean,
  todayISO: string,
): Record<string, any> {
  const patch: Record<string, any> = { autopay: enabled, autoPay: enabled };
  if (enabled && !(isAutoPayOn(fields) && autoPaySince(fields))) patch.autoRecordSince = clip(todayISO);
  return patch;
}

/**
 * The storage layer's guarantee for every door (a form, chat, an import, a
 * script): a write that switches Auto Pay ON also records the day it was
 * switched on. Without the day, Auto Pay cannot tell a payment that came due
 * before the switch from one it is responsible for. Returns the incoming
 * fields, with the day added when this write is the switch.
 */
export function withAutoPaySince(
  existing: Record<string, any> | null | undefined,
  incoming: Record<string, any>,
  todayISO: string,
): Record<string, any> {
  if (!isAutoPayOn(incoming) || isAutoPayOn(existing)) return incoming;
  if (autoPaySince(incoming)) return incoming;
  return { ...incoming, autoRecordSince: clip(todayISO) };
}

// ─── Per-payment status ──────────────────────────────────────────────────────

export type PaymentVerification = "assumed" | "confirmed";

export type OccurrencePaymentStatus =
  | "scheduled" | "due" | "overdue"
  | "assumed_paid" | "confirmed_paid"
  | "missed" | "delayed" | "partial" | "skipped";

export const PAYMENT_STATUS_META: Record<OccurrencePaymentStatus, { label: string; tone: "red" | "amber" | "green" | "muted" | "blue"; hint: string }> = {
  scheduled: { label: "Scheduled", tone: "muted", hint: "Expected, not yet due" },
  due: { label: "Due today", tone: "amber", hint: "Due today" },
  overdue: { label: "Overdue", tone: "red", hint: "Past due and not recorded" },
  assumed_paid: { label: "Assumed paid", tone: "blue", hint: "Recorded automatically because Auto Pay is on. Not yet confirmed." },
  confirmed_paid: { label: "Paid", tone: "green", hint: "Confirmed" },
  missed: { label: "Missed", tone: "red", hint: "This payment did not happen" },
  delayed: { label: "Delayed", tone: "amber", hint: "Moved to another day" },
  partial: { label: "Partial", tone: "amber", hint: "Less than the scheduled amount was paid" },
  skipped: { label: "Skipped", tone: "muted", hint: "Skipped" },
};

/** The verification of a PAID occurrence: assumed only when the stamp says so. */
export function verificationOfStamp(stamp: Record<string, any> | null | undefined): PaymentVerification {
  return stamp && stamp.verification === "assumed" ? "assumed" : "confirmed";
}

/**
 * The one status of one occurrence, from its stamp and its (effective) day.
 * `effectiveDate` is the day it falls on after any reschedule.
 */
export function occurrencePaymentStatus(
  stamp: Record<string, any> | null | undefined,
  effectiveDate: string,
  todayISO: string,
  opts: { paid?: boolean } = {},
): OccurrencePaymentStatus {
  const st = String(stamp?.status ?? "").toLowerCase();
  if (st === "paid" || opts.paid) {
    if (stamp?.partial === true) return "partial";
    return verificationOfStamp(stamp) === "assumed" ? "assumed_paid" : "confirmed_paid";
  }
  if (st === "missed") return "missed";
  if (st === "skipped") return "skipped";
  if (ISO_DAY.test(clip(stamp?.movedTo))) return "delayed";
  const day = clip(effectiveDate);
  const today = clip(todayISO);
  if (day < today) return "overdue";
  if (day === today) return "due";
  return "scheduled";
}

/** Occurrence states that close a cycle without (or with) money: nothing left for Auto Pay to do. */
export function isClosedOccurrenceStamp(stamp: Record<string, any> | null | undefined): boolean {
  const st = String(stamp?.status ?? "").toLowerCase();
  return st === "paid" || st === "skipped" || st === "missed";
}

/** The stamp (and its anchor day) that names this payment row, or null. */
export function stampOfPayment(
  fields: Record<string, any> | null | undefined,
  paymentId: string | null | undefined,
): { date: string; stamp: Record<string, any> } | null {
  const occ = (fields || {}).occurrences;
  if (!paymentId || !occ || typeof occ !== "object") return null;
  for (const [date, stamp] of Object.entries(occ as Record<string, any>)) {
    if (stamp && typeof stamp === "object" && stamp.paymentId === paymentId) return { date, stamp };
  }
  return null;
}

export interface MissedPayment { date: string; amount: number | null }

/**
 * Payments the user marked missed that are still recent enough to need a
 * decision (pay it late, or let it go). These are the ONE Auto Pay exception
 * the dashboard raises; everything else Auto Pay handles stays quiet.
 */
export function missedPayments(fields: Record<string, any> | null | undefined, todayISO: string): MissedPayment[] {
  const occ = (fields || {}).occurrences;
  if (!occ || typeof occ !== "object") return [];
  const out: MissedPayment[] = [];
  for (const [date, stamp] of Object.entries(occ as Record<string, any>)) {
    if (!ISO_DAY.test(date) || String(stamp?.status ?? "").toLowerCase() !== "missed") continue;
    if (!isWithinOverdueGrace(date, todayISO) && date !== clip(todayISO)) continue;
    const amount = Number(stamp?.expectedAmount ?? stamp?.amount);
    out.push({ date, amount: Number.isFinite(amount) && amount > 0 ? amount : null });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── What Auto Pay records today ─────────────────────────────────────────────

export interface AutopayDue {
  /** The occurrence's anchor day: the key of its stamp. */
  occurrenceKey: string;
  /** The day it actually falls on (after a one-time reschedule). */
  effectiveDate: string;
}

function dayInMonth(ym: string, day: number): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const last = new Date(y, m, 0).getDate();
  return `${ym}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/**
 * The occurrence Auto Pay should record NOW, or null.
 *
 *   • never before its due day: a payment is recorded on the day it is due (or,
 *     when a run was missed, within the overdue grace window after it);
 *   • never for a day before Auto Pay was switched on: turning it on does not
 *     back-fill a bill that was already overdue;
 *   • never for an occurrence that is paid, skipped or marked missed — a missed
 *     payment stays missed and the NEXT cycle carries on;
 *   • a one-time reschedule moves that one occurrence only.
 *
 * Pure: the daily job, a retry and a manual trigger all get the same answer,
 * and the answer for a recorded occurrence is null.
 */
export function autopayDueOccurrence(
  liability: { fields?: Record<string, any> | null; type_key?: string | null; typeKey?: string | null },
  todayISO: string,
): AutopayDue | null {
  const f = liability.fields || {};
  const today = clip(todayISO);
  if (!ISO_DAY.test(today) || !isAutoPayOn(f)) return null;
  if (isPausedBillFields(f)) return null;
  const since = autoPaySince(f);
  const occ: Record<string, any> = (f.occurrences && typeof f.occurrences === "object") ? f.occurrences : {};
  const eligible = (key: string): AutopayDue | null => {
    if (!ISO_DAY.test(key) || isClosedOccurrenceStamp(occ[key])) return null;
    const effective = effectiveDueDate(f, key);
    if (effective > today) return null;
    if (effective < today && !isWithinOverdueGrace(effective, today)) return null;
    if (since && effective < since) return null;
    return { occurrenceKey: key, effectiveDate: effective };
  };

  // An occurrence the user moved to another day is owed on THAT day, whatever
  // the series has done since.
  const moved = Object.keys(occ)
    .filter((k) => ISO_DAY.test(clip(occ[k]?.movedTo)))
    .sort()
    .map(eligible)
    .find((x): x is AutopayDue => !!x);
  if (moved) return moved;

  const typeKey = liability.type_key ?? liability.typeKey ?? null;
  if (isRecurringBill(typeKey)) {
    if (isEndedBillFields(f)) return null;
    return eligible(currentBillDueDate(f, today));
  }

  // A loan, card or one-time debt (one record: its payment day is a field on it).
  if (!(readMonthlyPayment(f) > 0)) return null;
  if (liabilityFamily(typeKey) === "one_time") {
    // A one-time debt has ONE payment. Once any occurrence is paid there is
    // nothing left to record, whatever date the record carries afterwards.
    if (Object.values(occ).some((st) => st && st.status === "paid")) return null;
    const stored = readStoredDueDate(f);
    return stored ? eligible(stored) : null;
  }
  const day = loanDueDay(f);
  if (day == null) return null;
  let key = dayInMonth(today.slice(0, 7), day);
  if (key > today) key = dayInMonth(addMonthsISO(today.slice(0, 7) + "-01", -1).slice(0, 7), day);
  // A payment made after the previous due day already covers this cycle (the
  // same rule nextLoanDueDate applies), so there is nothing to assume.
  const previous = dayInMonth(addMonthsISO(key.slice(0, 7) + "-01", -1).slice(0, 7), day);
  const lastPaid = normalizeDateString(f.lastPaidDate ?? f.last_paid_date);
  if (lastPaymentCoversCycle(f, lastPaid, previous)) return null;
  return eligible(key);
}

// ─── What a debt payment costs ───────────────────────────────────────────────

/**
 * The part of a loan / card payment that is spending: interest and fees.
 * Principal moves money from cash to equity (the balance falls); it is not an
 * expense. The full amount still shows in the payment history and cash flow.
 */
export function debtPaymentExpenseAmount(row: { interestPortion?: unknown; fees?: unknown; paymentType?: unknown } | null | undefined): number {
  if (!row || row.paymentType === "reversal" || row.paymentType === "skipped" || row.paymentType === "deferred") return 0;
  const cost = (Number(row.interestPortion) || 0) + (Number(row.fees) || 0);
  return cost > 0 ? Math.round((cost + Number.EPSILON) * 100) / 100 : 0;
}

/** Tag on the expense a debt payment's interest and fees logged (the retraction key). */
export const DEBT_COST_TAG_PREFIX = "payment-cost:";
/** Tag carried by an expense whose payment is still an Auto Pay assumption. */
export const ASSUMED_EXPENSE_TAG = "autopay:assumed";

export function isAssumedExpense(expense: { tags?: unknown } | null | undefined): boolean {
  return Array.isArray(expense?.tags) && (expense!.tags as unknown[]).includes(ASSUMED_EXPENSE_TAG);
}

// ─── Matching a bank transaction to an assumed payment ───────────────────────

export interface AssumedPaymentCandidate {
  paymentId: string;
  liabilityId: string;
  liabilityName: string;
  occurrenceDate: string;
  amount: number;
  paymentDate: string;
}

export interface BankTransactionish {
  id?: string | null;
  amount: number;
  date: string;
  description?: string | null;
}

const STOP_WORDS = new Set(["the", "and", "payment", "pmt", "autopay", "auto", "pay", "bill", "loan", "inc", "llc", "co", "card", "ach", "debit", "online", "recurring"]);
const nameTokens = (s: unknown): string[] =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length >= 3 && !STOP_WORDS.has(t));

function daysApart(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);
}

/** Days a bank posting may sit from the day Portol assumed the payment. */
export const RECONCILE_WINDOW_DAYS = 5;

/**
 * The assumed payment a bank transaction IS, or null.
 *
 * A match needs the date within the posting window and either the same amount
 * to the cent, or a description that names the liability with the amount
 * within 10% (a bill that posted a little differently). When two different
 * liabilities fit equally well and the description names neither, nothing is
 * matched: confirming the wrong debt is worse than leaving one assumed.
 */
export function matchAssumedPayment(
  candidates: readonly AssumedPaymentCandidate[],
  txn: BankTransactionish,
): AssumedPaymentCandidate | null {
  const amount = Math.abs(Number(txn.amount));
  const date = clip(txn.date);
  if (!(amount > 0) || !ISO_DAY.test(date)) return null;
  const words = new Set(nameTokens(txn.description));
  const scored = candidates.map((c) => {
    if (!ISO_DAY.test(clip(c.paymentDate))) return null;
    const gap = daysApart(clip(c.paymentDate), date);
    if (gap > RECONCILE_WINDOW_DAYS) return null;
    const exact = Math.abs(c.amount - amount) < 0.005;
    const named = nameTokens(c.liabilityName).some((t) => words.has(t));
    const near = c.amount > 0 && Math.abs(c.amount - amount) / c.amount <= 0.1;
    if (!exact && !(named && near)) return null;
    return { c, score: (exact ? 100 : 0) + (named ? 50 : 0) - gap };
  }).filter((x): x is { c: AssumedPaymentCandidate; score: number } => !!x)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const [best, second] = scored;
  if (second && second.score === best.score && second.c.liabilityId !== best.c.liabilityId) return null;
  return best.c;
}

/** Every payment on this liability that is still an Auto Pay assumption. */
export function assumedPaymentsOf(liability: { id: string; name?: string | null; fields?: Record<string, any> | null }): AssumedPaymentCandidate[] {
  const occ = (liability.fields || {}).occurrences;
  if (!occ || typeof occ !== "object") return [];
  const out: AssumedPaymentCandidate[] = [];
  for (const [date, stamp] of Object.entries(occ as Record<string, any>)) {
    if (!stamp || stamp.status !== "paid" || stamp.verification !== "assumed" || !stamp.paymentId) continue;
    out.push({
      paymentId: String(stamp.paymentId), liabilityId: liability.id, liabilityName: String(liability.name || ""),
      occurrenceDate: date, amount: Number(stamp.paidAmount ?? stamp.amount) || 0,
      paymentDate: clip(stamp.paymentDate) || date,
    });
  }
  return out;
}
