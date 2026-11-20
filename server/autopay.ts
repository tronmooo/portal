// ─── Auto Pay: recording, correcting and confirming scheduled payments ───────
//
// The rules are in shared/autopay.ts; the money moves through the ONE pay
// operation and its inverse (server/liability-payments.ts). This module only
// decides WHEN to call them:
//
//   runAutopayForLiability   the daily job: record the payment that is due
//   setOccurrenceStatus      the user's correction of ONE occurrence
//                            (missed / delayed / partial / confirmed / scheduled)
//   reconcileBankTransaction a bank transaction that IS an assumed payment
//                            confirms it instead of becoming a second expense
//
// Nothing here writes a payment row or an expense of its own, so a payment
// stays one ledger row however many times it is corrected.
import {
  ASSUMED_EXPENSE_TAG, DEBT_COST_TAG_PREFIX,
  assumedPaymentsOf, autoPayAccountId, autoPaySettingPatch, autopayDueOccurrence, isAutoPayOn, matchAssumedPayment, occurrencePaymentStatus, stampOfPayment,
  type AssumedPaymentCandidate, type BankTransactionish,
} from "@shared/autopay";
import { resolveLiabilityBalance } from "@shared/asset-value";
import { resolveAnnualRate } from "@shared/liability-calc";
import { readMonthlyPayment, readOriginalBalance } from "@shared/liability-fields";
import { advanceLiabilityDueDatePatch, readDueDate, resolveOccurrenceKey } from "@shared/liability-recurrence";
import { isRecurringBillProfile } from "@shared/liability-types";
import { DEFAULT_TIMEZONE, getUserToday } from "@shared/timezone";
import {
  PAYMENT_TAG_PREFIX, closeBillReminderTasksWhere, payBillOccurrence, repriceBillPayment, rescheduleBillOccurrence, unpayBillOccurrence,
  type PayBillResult,
} from "./liability-payments";
import type { IStorage } from "./storage";

type Logger = Pick<Console, "warn" | "error">;
const quiet: Logger = { warn: () => {}, error: () => {} };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const isLiability = (p: any) => !!p && (p.type === "liability" || p.type === "loan");

// ─── The setting ─────────────────────────────────────────────────────────────

export interface AutoPaySettingInput {
  enabled?: boolean;
  /** Account profile id the payment is drawn from; null clears it. */
  accountId?: string | null;
  /** Keep due-date reminders even though Auto Pay is on. */
  reminders?: boolean;
}

/**
 * Switch Auto Pay on or off (and set its source / reminders). Turning it ON
 * retires the open "Bill due" reminders — nothing needs doing any more.
 * Turning it OFF only stops future recording: payments already recorded, the
 * schedule and the liability itself are untouched.
 */
export async function setAutoPay(
  storage: IStorage, liabilityId: string, input: AutoPaySettingInput,
  timezone: string = DEFAULT_TIMEZONE, logger: Logger = quiet,
): Promise<any | null> {
  const liability: any = await storage.getProfile(liabilityId);
  if (!isLiability(liability)) return null;
  const f = liability.fields || {};
  const patch: Record<string, any> = {};
  if (typeof input.enabled === "boolean") Object.assign(patch, autoPaySettingPatch(f, input.enabled, getUserToday(timezone)));
  if (input.accountId !== undefined) patch.autopayAccountId = input.accountId || null;
  if (typeof input.reminders === "boolean") patch.autopayReminders = input.reminders;
  if (Object.keys(patch).length === 0) return liability;
  const updated = await storage.updateProfile(liabilityId, { fields: patch } as any);
  const after = { ...f, ...patch };
  if (isAutoPayOn(after) && after.autopayReminders !== true) {
    await closeBillReminderTasksWhere(storage, liabilityId, () => true, logger).catch(() => 0);
  }
  return updated ?? liability;
}

// ─── The daily job ───────────────────────────────────────────────────────────

/**
 * Record the payment Auto Pay owes for this liability today, if any.
 * Idempotent by construction: the occurrence is claimed before the ledger row
 * is written (payBillOccurrence), and a claimed, skipped or missed occurrence
 * is never "due" again (autopayDueOccurrence). Re-running the job, a retry
 * and two overlapping runs all leave ONE payment.
 */
export async function runAutopayForLiability(
  storage: IStorage, liability: any, todayISO: string,
  timezone: string = DEFAULT_TIMEZONE, logger: Logger = quiet,
): Promise<PayBillResult | null> {
  if (!isLiability(liability)) return null;
  const due = autopayDueOccurrence(liability, todayISO);
  if (!due) return null;
  const f = liability.fields || {};
  let amount: number | null = null;
  if (!isRecurringBillProfile(liability)) {
    const balance = resolveLiabilityBalance(liability);
    // A paid-off loan has nothing left to pay (a loan whose balance was never
    // tracked keeps recording its payment).
    if (balance <= 0 && readOriginalBalance(f) > 0) return null;
    // The last payment of a loan is what is left plus this month's interest,
    // not a full instalment (which would record an overpayment).
    const scheduled = Number((f.occurrences || {})[due.occurrenceKey]?.amount) || readMonthlyPayment(f);
    const payoff = round2(balance * (1 + resolveAnnualRate(f) / 12));
    if (balance > 0 && scheduled > payoff) amount = payoff;
  }
  return payBillOccurrence(storage, liability.id, {
    occurrenceDate: due.occurrenceKey,
    amount,
    // The debit posts on the due day. A catch-up run records it on that day,
    // so the expense lands in the month it belongs to.
    paymentDate: due.effectiveDate < todayISO ? due.effectiveDate : todayISO,
    accountId: autoPayAccountId(f),
    notes: "Auto Pay",
    source: "autopay",
  }, timezone, logger);
}

// ─── One occurrence, corrected by the user ───────────────────────────────────

export type OccurrenceStatusChange =
  | { status: "missed" }
  | { status: "scheduled" }
  | { status: "confirmed"; amount?: number | null; via?: "manual" | "bank"; bankTransactionId?: string | null }
  | { status: "delayed"; movedTo: string }
  | { status: "partial"; amount: number };

export interface OccurrenceStatusResult {
  ok: boolean;
  reason?: "not_found" | "not_paid" | "invalid" | "reversal_failed" | "payment_failed";
  occurrenceDate: string;
  /** The payment that now stands for this occurrence, when one does. */
  paymentId?: string | null;
  /** A recorded payment was taken back (expense, balance and account restored). */
  reversed: boolean;
}

/**
 * Change ONE occurrence's status. The recurring schedule is never touched:
 * the amount, the due day and the Auto Pay setting of the liability stay, and
 * the next cycle is recorded as usual.
 *
 *   missed     a recorded payment is reversed (expense deleted, balance and
 *              account restored); the occurrence is stamped missed and the
 *              series moves on
 *   scheduled  undo of missed / skipped / a recorded payment: the occurrence
 *              is open again
 *   delayed    this occurrence moves to another day (a recorded payment is
 *              reversed; Auto Pay records it on the new day)
 *   partial    the payment is re-recorded at the amount actually paid
 *   confirmed  an assumed payment is confirmed (optionally at the amount the
 *              bank posted)
 */
export async function setOccurrenceStatus(
  storage: IStorage, liabilityId: string,
  target: { occurrenceDate?: string | null; paymentId?: string | null },
  change: OccurrenceStatusChange,
  timezone: string = DEFAULT_TIMEZONE, logger: Logger = quiet,
): Promise<OccurrenceStatusResult> {
  const liability: any = await storage.getProfile(liabilityId);
  const fail = (reason: OccurrenceStatusResult["reason"], occurrenceDate = ""): OccurrenceStatusResult =>
    ({ ok: false, reason, occurrenceDate, reversed: false });
  if (!isLiability(liability)) return fail("not_found");
  const f = liability.fields || {};
  const byPayment = stampOfPayment(f, target.paymentId);
  let key = byPayment?.date || (target.occurrenceDate ? resolveOccurrenceKey(f, String(target.occurrenceDate).slice(0, 10)) : "");
  let legacyRow: any = null;
  if (!key && target.paymentId) {
    // A payment recorded before occurrences were stamped: it stands for the day it was paid.
    legacyRow = await storage.getLiabilityPayment(target.paymentId).catch(() => null);
    if (legacyRow && String(legacyRow.liabilityProfileId) === liabilityId) key = String(legacyRow.paymentDate || "").slice(0, 10);
  }
  if (!ISO_DAY.test(key)) return fail("invalid");
  const stamp: Record<string, any> = (f.occurrences && typeof f.occurrences === "object" && f.occurrences[key]) || {};
  const paidId: string | null = stamp.status === "paid" && stamp.paymentId ? String(stamp.paymentId) : (legacyRow ? String(legacyRow.id) : null);
  // What this occurrence was SUPPOSED to cost: remembered across a partial.
  const expected = Number(stamp.expectedAmount) > 0 ? Number(stamp.expectedAmount)
    : Number(stamp.amount) > 0 ? Number(stamp.amount)
    : readMonthlyPayment(f) || Number(legacyRow?.amount) || 0;

  /** Take the recorded payment back; false when the reversal did not complete. */
  const reverse = async (): Promise<boolean> => {
    if (!paidId) return true;
    const undone = await unpayBillOccurrence(storage, liabilityId, { paymentId: paidId, source: "route" }, timezone, logger);
    // A half-finished reversal followed by a new record could move a balance
    // twice. Stop and say so.
    return undone.ok && !undone.steps.some((s) => !s.ok);
  };
  /** A partial payment re-priced the occurrence; taking it back restores what was scheduled. */
  const restoreAmount: Record<string, any> = stamp.partial === true && expected > 0 ? { amount: expected, actualAmount: expected } : {};

  if (change.status === "missed") {
    if (!(await reverse())) return fail("reversal_failed", key);
    await storage.updateOccurrenceOverride(liabilityId, key, {
      ...restoreAmount, status: "missed", missedAt: new Date().toISOString(), paymentId: null, movedTo: null,
      expectedAmount: expected > 0 ? expected : null,
    });
    // The series carries on: when this was the current due occurrence, the
    // next cycle becomes due (the same move a skip makes).
    const fresh: any = await storage.getProfile(liabilityId);
    if (fresh && readDueDate(fresh.fields) === key && isRecurringBillProfile(fresh)) {
      await storage.updateProfile(liabilityId, { fields: advanceLiabilityDueDatePatch(fresh.fields, key) } as any);
    }
    return { ok: true, occurrenceDate: key, paymentId: null, reversed: !!paidId };
  }

  if (change.status === "scheduled") {
    if (!(await reverse())) return fail("reversal_failed", key);
    await storage.updateOccurrenceOverride(liabilityId, key, { ...restoreAmount, status: null, missedAt: null, expectedAmount: null });
    return { ok: true, occurrenceDate: key, paymentId: null, reversed: !!paidId };
  }

  if (change.status === "delayed") {
    const movedTo = String(change.movedTo || "").slice(0, 10);
    if (!ISO_DAY.test(movedTo)) return fail("invalid", key);
    if (!(await reverse())) return fail("reversal_failed", key);
    await storage.updateOccurrenceOverride(liabilityId, key, { ...restoreAmount, status: null, missedAt: null, expectedAmount: null });
    await rescheduleBillOccurrence(storage, liabilityId, key, movedTo, logger);
    return { ok: true, occurrenceDate: key, paymentId: null, reversed: !!paidId };
  }

  if (change.status === "partial") {
    const amount = round2(Number(change.amount));
    if (!(amount > 0)) return fail("invalid", key);
    const paymentDate = String(stamp.paymentDate || legacyRow?.paymentDate || "").slice(0, 10) || getUserToday(timezone);
    if (!(await reverse())) return fail("reversal_failed", key);
    const paid = await payBillOccurrence(storage, liabilityId, {
      occurrenceDate: key, amount, paymentDate, accountId: stamp.accountId || null,
      // "partial" only when it really is less than what was scheduled.
      paymentType: expected > 0 && amount < expected ? "partial" : null,
      notes: stamp.autopay ? "Auto Pay" : null,
      verification: "confirmed", source: "occurrence_route",
    }, timezone, logger);
    if (!paid.ok) return fail("payment_failed", key);
    if (expected > amount) await storage.updateOccurrenceOverride(liabilityId, key, { partial: true, expectedAmount: expected });
    return { ok: true, occurrenceDate: key, paymentId: paid.payment?.id ?? null, reversed: !!paidId };
  }

  // confirmed
  if (!paidId) return fail("not_paid", key);
  let paymentId = paidId;
  const confirmedAmount = change.amount != null ? round2(Number(change.amount)) : null;
  const recorded = Number(stamp.paidAmount ?? stamp.amount ?? legacyRow?.amount) || 0;
  if (confirmedAmount != null && confirmedAmount > 0 && Math.abs(confirmedAmount - recorded) >= 0.005) {
    // The bank posted a different figure: the ONE payment is re-priced, never
    // joined by a second one.
    if (isRecurringBillProfile(liability)) {
      const repriced = await repriceBillPayment(storage, paidId, { amount: confirmedAmount }, { expense: "sync" }, logger);
      if (!repriced.ok) return fail("payment_failed", key);
    } else {
      if (!(await reverse())) return fail("reversal_failed", key);
      const paid = await payBillOccurrence(storage, liabilityId, {
        occurrenceDate: key, amount: confirmedAmount,
        paymentDate: String(stamp.paymentDate || "").slice(0, 10) || getUserToday(timezone),
        accountId: stamp.accountId || null, notes: stamp.autopay ? "Auto Pay" : null,
        verification: "confirmed", source: "occurrence_route",
      }, timezone, logger);
      if (!paid.ok) return fail("payment_failed", key);
      paymentId = String(paid.payment?.id || paidId);
    }
  }
  if (!legacyRow) {
    await storage.updateOccurrenceOverride(liabilityId, key, {
      verification: "confirmed", confirmedAt: new Date().toISOString(), confirmedVia: change.via || "manual",
      ...(change.bankTransactionId ? { bankTransactionId: String(change.bankTransactionId) } : {}),
    });
  }
  await clearAssumedExpenseTag(storage, paymentId, logger);
  return { ok: true, occurrenceDate: key, paymentId, reversed: false };
}

/** The expense a confirmed payment logged stops saying "assumed". */
async function clearAssumedExpenseTag(storage: IStorage, paymentId: string, logger: Logger): Promise<void> {
  try {
    const keys = [`${PAYMENT_TAG_PREFIX}${paymentId}`, `${DEBT_COST_TAG_PREFIX}${paymentId}`];
    const expenses: any[] = (await storage.getExpenses()) || [];
    for (const e of expenses) {
      const tags: string[] = Array.isArray(e.tags) ? e.tags : [];
      if (!tags.includes(ASSUMED_EXPENSE_TAG) || !keys.some((k) => tags.includes(k))) continue;
      await storage.updateExpense(e.id, { tags: tags.filter((t) => t !== ASSUMED_EXPENSE_TAG) } as any);
    }
  } catch (e: any) {
    logger.warn(`[autopay] could not clear the assumed tag for payment ${paymentId}:`, e?.message || e);
  }
}

// ─── Payment rows, as every door returns them ────────────────────────────────

/**
 * Payment rows with their Auto Pay status (assumed / confirmed / partial),
 * read from the occurrence stamp that names each one — the one place that
 * state lives. Every route that returns a liability's payments answers
 * through this: the standalone payments endpoint and the profile bundle the
 * detail page is seeded from must not disagree about whether a payment is
 * confirmed. A row with no stamp is a payment a person recorded: confirmed.
 */
export async function withPaymentStatuses(storage: IStorage, rows: any[], todayISO: string): Promise<any[]> {
  const owners = new Map<string, any>();
  for (const id of new Set((rows || []).map((r: any) => String(r.liabilityProfileId)))) {
    owners.set(id, await storage.getProfile(id).catch(() => undefined));
  }
  return (rows || []).map((r: any) => {
    const hit = stampOfPayment(owners.get(String(r.liabilityProfileId))?.fields, r.id);
    return {
      ...r,
      occurrenceDate: hit?.date ?? null,
      status: occurrencePaymentStatus(hit?.stamp ?? null, hit?.date ?? String(r.paymentDate || ""), todayISO, { paid: true }),
      autopay: hit?.stamp?.autopay === true,
      expectedAmount: hit?.stamp?.partial === true ? Number(hit.stamp.expectedAmount) || null : null,
    };
  });
}

// ─── Bank reconciliation ─────────────────────────────────────────────────────

export interface ReconcileResult {
  matched: boolean;
  /** This transaction was matched before; nothing was written this time. */
  alreadyMatched?: boolean;
  paymentId?: string;
  liabilityId?: string;
  liabilityName?: string;
  occurrenceDate?: string;
}

/**
 * A bank transaction arrives (a sync, a statement import, the user pasting
 * one). If it IS a payment Auto Pay already recorded, that payment is
 * confirmed — at the bank's amount — and the caller must NOT create an
 * expense for the transaction: the payment already has one.
 *
 * A transaction id that was matched before answers with the same payment and
 * writes nothing, so a replayed sync cannot confirm two payments with one
 * debit.
 */
export async function reconcileBankTransaction(
  storage: IStorage, txn: BankTransactionish,
  timezone: string = DEFAULT_TIMEZONE, logger: Logger = quiet,
): Promise<ReconcileResult> {
  const profiles: any[] = ((await storage.getProfiles()) || []).filter(isLiability);
  const txnId = txn.id ? String(txn.id) : "";
  if (txnId) {
    for (const p of profiles) {
      const occ = p.fields?.occurrences;
      if (!occ || typeof occ !== "object") continue;
      for (const [date, stamp] of Object.entries(occ as Record<string, any>)) {
        if (stamp && stamp.bankTransactionId === txnId && stamp.paymentId) {
          return { matched: true, alreadyMatched: true, paymentId: String(stamp.paymentId), liabilityId: p.id, liabilityName: p.name, occurrenceDate: date };
        }
      }
    }
  }
  const candidates: AssumedPaymentCandidate[] = profiles.flatMap((p) => assumedPaymentsOf(p));
  const hit = matchAssumedPayment(candidates, txn);
  if (!hit) return { matched: false };
  const done = await setOccurrenceStatus(storage, hit.liabilityId, { paymentId: hit.paymentId }, {
    status: "confirmed", amount: Math.abs(Number(txn.amount)), via: "bank", bankTransactionId: txnId || null,
  }, timezone, logger);
  if (!done.ok) return { matched: false };
  return {
    matched: true, paymentId: done.paymentId || hit.paymentId, liabilityId: hit.liabilityId,
    liabilityName: hit.liabilityName, occurrenceDate: hit.occurrenceDate,
  };
}
