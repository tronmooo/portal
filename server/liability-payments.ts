// ─── Recording a liability payment: one implementation ──────────────────────
//
// There were two. The REST route (POST /api/liabilities/:id/payments) owned the
// principal/interest split via the shared `allocatePayment`, mirrored the new
// balance onto all three field names the rest of the app reads, and knew that a
// recurring service bill has no balance to pay down — paying it logs the charge
// and rolls the due date forward. The AI tool (`log_liability_payment`) did its
// own monthly-rate arithmetic, wrote `currentBalance` only, never advanced a
// recurring bill's due date, and computed "today" in a hardcoded timezone.
//
// So the same sentence — "record a $200 payment on the car loan" — produced
// different rows depending on whether you typed it into a form or into chat.
// That is not a synchronization bug, but it is the same disease: two code paths
// answering one question. Both callers now land here.
import { allocatePayment, resolveAnnualRate } from "@shared/liability-calc";
import { isRecurringBill, isRecurringBillProfile } from "@shared/liability-types";
import { advanceLiabilityDueDate, advanceLiabilityDueDatePatch, readDueDate, resolveOccurrenceKey, lastSeriesOccurrence } from "@shared/liability-recurrence";
import { resolveLiabilityBalance } from "@shared/asset-value";
import { resolveBillingModel, resolveOccurrenceAmount } from "@shared/liability-billing";
import { deriveScheduleFields, liabilityAmount } from "@shared/liability-schedule";
import { isAccountProfile, isDebtAccount } from "@shared/finance-accounts";
import { getUserToday, DEFAULT_TIMEZONE } from "@shared/timezone";
import { BILL_PAYMENT_TAG, PAYMENT_TAG_PREFIX } from "@shared/bill-payment-expense";
import type { IStorage } from "./storage";
import { randomUUID } from "crypto";

type PaymentLogger = Pick<Console, "warn" | "error">;

/** How a payment behaves against the balance. */
export type LiabilityPaymentType =
  | "standard" | "partial" | "custom" | "extra_principal"
  | "payoff" | "skipped" | "deferred" | "reversal";

export interface LiabilityPaymentInput {
  amount: number;
  /** Preset ledger row id (lets a caller stamp the occurrence before inserting the row). */
  id?: string | null;
  paymentDate?: string | null;
  /** Explicit split. Omit to let the canonical amortization math decide. */
  principal?: number | null;
  interest?: number | null;
  escrow?: number | null;
  fees?: number | null;
  paymentType?: LiabilityPaymentType | null;
  notes?: string | null;
  sourceAccount?: string | null;
}

export interface LiabilityPaymentResult {
  /** Money paid beyond the balance and this period's interest on a payoff (D271). */
  overpayment?: number;
  /** Balance written off on a payoff that paid less than was owed (a settlement). */
  forgiven?: number;
  payment: any;
  /** The liability profile as it stands after the payment. */
  liability: any;
  newBalance: number;
  principal: number;
  interest: number;
  /** True when this was a recurring bill: a charge logged, no balance moved. */
  recurring: boolean;
}

/** A row's principal with its direction: a reversal put money back, everything else took it off. */
/**
 * A settlement payoff (paid less than the balance, D272) notes the part of
 * the balance the lender let go. The row is the only record of that figure,
 * so an undo reads it back here: putting only the cash paid back on the
 * balance left a settled $3,100 card showing $200 owed (D273).
 */
export function settlementNote(forgiven: number): string {
  return `Settled: $${forgiven.toFixed(2)} of the balance written off`;
}
/**
 * The ledger appends its own segment to a row's notes (an overpayment, a
 * settlement). Re-recording a payment (an amount edit) fed the stored notes
 * back in, so the segment stacked up ("… — Settled: $2900 — Settled: $2850")
 * and an undo read the stale first figure (D274). The user's text and the
 * ledger's segment are kept apart here.
 */
const LEDGER_NOTE_RE = /(?:^|\s—\s)(?:Overpaid by \$[\d,]+(?:\.\d+)?\s\(owed back by the lender\)|Settled: \$[\d,]+(?:\.\d+)?\sof the balance written off)/g;
export function stripLedgerNotes(notes: string | null | undefined): string | null {
  const out = String(notes || "").replace(LEDGER_NOTE_RE, "").replace(/^\s*—\s*/, "").trim();
  return out || null;
}
export function ledgerNoteOf(notes: string | null | undefined): string | null {
  const m = String(notes || "").match(LEDGER_NOTE_RE);
  return m ? m[m.length - 1].replace(/^\s—\s/, "") : null;
}
export function withLedgerNote(userNotes: string | null | undefined, ledger: string | null | undefined): string | null {
  const user = stripLedgerNotes(userNotes);
  if (!ledger) return user;
  return user ? `${user} — ${ledger}` : ledger;
}

export function writtenOffOf(row: { notes?: string | null; paymentType?: string | null } | null | undefined): number {
  if (row?.paymentType !== "payoff") return 0;
  const m = /Settled: \$([\d,]+(?:\.\d+)?) of the balance written off/.exec(String(row?.notes || ""));
  return m ? Number(m[1].replace(/,/g, "")) || 0 : 0;
}

export function signedPrincipal(row: { principalPortion?: number | null; paymentType?: string | null } | null | undefined): number {
  const magnitude = Math.abs(Number(row?.principalPortion) || 0);
  return row?.paymentType === "reversal" ? -magnitude : magnitude;
}

/**
 * Classify a payment when the caller didn't. Mirrors what the AI tool inferred,
 * kept so a chat-recorded payment still lands in the right bucket.
 */
function inferPaymentType(
  amount: number, balance: number, principal: number, interest: number,
  monthlyPayment: number, explicitPrincipal: boolean,
): LiabilityPaymentType {
  if (explicitPrincipal && interest === 0 && principal > 0) return "extra_principal";
  // A loan with no tracked balance cannot be "paid off": nothing is known to
  // clear, so the payment stays a standard one (whole amount principal). It
  // used to infer payoff and book the entire payment as interest, then (with
  // the D271 overpayment split) as nothing at all.
  if (balance > 0 && Math.max(0, balance - principal) === 0 && amount > 0) return "payoff";
  if (monthlyPayment > 0 && Math.abs(amount - monthlyPayment) < 1) return "standard";
  if (monthlyPayment > 0 && amount < monthlyPayment && amount > 0) return "partial";
  if (monthlyPayment > 0 && amount > monthlyPayment) return "custom";
  return "standard";
}

/** Everything a debt payment derives from the liability's CURRENT balance. */
interface DebtPaymentPlan {
  balanceBefore: number; principal: number; interest: number; fees: number;
  /** Money paid beyond the balance and this period's interest on a payoff (owed back by the lender). */
  overpayment: number;
  /** On a payoff for less than the balance, the part of the balance the lender let go. */
  forgiven: number;
  paymentType: LiabilityPaymentType; newBalance: number;
  /** Whether this payment moves the tracked balance at all. */
  moves: boolean;
}
function planDebtPayment(liability: any, input: LiabilityPaymentInput): DebtPaymentPlan {
  const fields = liability.fields || {};
  const amount = Number(input.amount) || 0;
  const escrow = Number(input.escrow) || 0;
  const balanceBefore = resolveLiabilityBalance(liability);
  const annualRate = resolveAnnualRate(fields);
  const explicitPrincipal = input.principal != null && Number.isFinite(Number(input.principal));
  const explicitInterest = input.interest != null && Number.isFinite(Number(input.interest));
  const cashTowardLoan = amount - escrow - (Number(input.fees) || 0);

  let principal: number;
  let interest: number;
  let fees = Number(input.fees) || 0;

  if (explicitPrincipal || explicitInterest) {
    // The caller (or the model) split it. Honor that, filling in the other half.
    principal = explicitPrincipal ? Number(input.principal) : Math.max(0, cashTowardLoan - Number(input.interest || 0));
    interest = explicitInterest ? Number(input.interest) : Math.max(0, cashTowardLoan - principal);
  } else if (input.paymentType === "extra_principal") {
    // "An extra $100 toward the principal" is principal by definition. The
    // canonical split below charges a period's interest on every payment, so
    // an extra payment used to lose a month of interest ($39.70 of $100 on an
    // $8,000 loan) and the balance dropped by less than the money sent.
    principal = Math.max(0, cashTowardLoan);
    interest = 0;
  } else if (balanceBefore > 0) {
    // The canonical split — the same function the amortization schedule uses,
    // so a payment and the schedule that predicted it agree.
    const split = allocatePayment(amount - escrow, balanceBefore, annualRate, fees);
    principal = split.principal;
    interest = split.interest;
    fees = split.fees;
  } else {
    // No tracked balance: the whole payment is principal, no interest.
    principal = amount;
    interest = 0;
  }

  const monthlyPayment = Number(fields.monthlyPayment) || 0;
  const paymentType: LiabilityPaymentType =
    input.paymentType || inferPaymentType(amount, balanceBefore, principal, interest, monthlyPayment, explicitPrincipal);

  let newBalance: number;
  let overpayment = 0;
  let forgiven = 0;
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  if (paymentType === "skipped" || paymentType === "deferred") {
    newBalance = balanceBefore;
    principal = 0;
    interest = 0;
  } else if (paymentType === "reversal") {
    // A reversal puts the money back: all of it is principal (there is no
    // period's interest to charge on money coming back), and the row's
    // principal is exactly what the balance moves by, so an undo of the
    // reversal takes the same figure off again.
    principal = Math.max(0, cashTowardLoan);
    interest = 0;
    newBalance = balanceBefore + principal;
  } else if (paymentType === "payoff") {
    // A payoff clears the balance and this period's accrued interest — no
    // more. Anything paid beyond that is an overpayment the lender owes back;
    // it used to be booked as interest, so a $10,000 payment on a $4,000
    // loan recorded $6,000 of "interest" and the cost-of-borrowing figures
    // followed (D271).
    if (balanceBefore > 0 && cashTowardLoan < balanceBefore) {
      // A payoff for less than the balance is a settlement: the cash paid is
      // principal and the rest of the balance is written off. The row used to
      // book the whole balance as principal — a $200 "payoff" on a $3,100
      // card recorded $3,100 of principal paid (D272).
      principal = Math.max(0, cashTowardLoan);
      interest = 0;
      forgiven = round2(balanceBefore - principal);
    } else if (balanceBefore > 0) {
      const accrued = allocatePayment(cashTowardLoan, balanceBefore, annualRate, 0).interest;
      principal = balanceBefore;
      interest = Math.min(accrued, Math.max(0, cashTowardLoan - balanceBefore));
      overpayment = Math.max(0, round2(cashTowardLoan - balanceBefore - interest));
    } else {
      // An explicit payoff on a loan whose balance was never tracked: the
      // money paid is what was owed, all principal, nothing to owe back.
      principal = Math.max(0, cashTowardLoan);
      interest = 0;
    }
    newBalance = 0;
  } else {
    newBalance = Math.max(0, balanceBefore - principal);
    // Rounding noise (an AI-supplied split, a $0.17 payment) must not leave a
    // loan sitting at $0.004 forever.
    if (newBalance > 0 && newBalance < 1) {
      principal += newBalance;
      newBalance = 0;
    }
  }

  // Cents in, cents out: a balance of 5314.889999999999 was stored and
  // exported after an ordinary payment because the split was rounded and the
  // subtraction was not (D284).
  principal = round2(principal);
  interest = round2(interest);
  fees = round2(fees);
  newBalance = round2(newBalance);
  return {
    balanceBefore, principal, interest, fees, paymentType, newBalance, overpayment, forgiven,
    // A reversal puts money back even on a paid-off debt (balance 0): the
    // "balance above zero" gate is for payments that take money off.
    moves: paymentType !== "skipped" && paymentType !== "deferred" && (balanceBefore > 0 || paymentType === "reversal"),
  };
}

/**
 * Record a payment against a liability and bring the liability itself up to
 * date, in one place.
 *
 * The liability profile write is deliberately part of this function rather than
 * left to the caller: a payment that moves a balance without updating the
 * liability is exactly the shape of "the payment saved but the balance didn't
 * change", and the write journal can only report a change that actually
 * happened.
 */
export async function applyLiabilityPayment(
  storage: IStorage,
  liability: any,
  input: LiabilityPaymentInput,
  timezone: string = DEFAULT_TIMEZONE,
): Promise<LiabilityPaymentResult> {
  const fields = liability.fields || {};
  const todayISO = getUserToday(timezone);
  const paymentDate = input.paymentDate || todayISO;
  const amount = Number(input.amount) || 0;
  const escrow = Number(input.escrow) || 0;

  // ── Recurring service bill: no permanent balance ────────────────────────
  // A phone or utility bill isn't debt; paying it records the charge and moves
  // the next due date on by one cycle. Reducing a "balance" here would invent
  // a number, which is what the AI path used to do.
  // `type_key ?? typeKey` is the canonical way this app names a liability's
  // family — shared/asset-value.ts decides what counts toward net worth the
  // same way. Reading `fields.subtype` here instead would let this function
  // call something a recurring bill while net worth still counted it as debt.
  if (isRecurringBillProfile(liability as any)) {
    const payment = await storage.createLiabilityPayment({
      ...(input.id ? { id: input.id } : {}),
      liabilityProfileId: liability.id,
      paymentDate,
      amount,
      principalPortion: amount,
      interestPortion: 0,
      fees: Number(input.fees) || 0,
      paymentType: input.paymentType || "standard",
      sourceAccount: input.sourceAccount || null,
      notes: input.notes || null,
    } as any);
    // Series state (dueDate advance, lastPaidDate, occurrence stamp) is owned
    // by payBillOccurrence, the one entry-point-facing operation. This function
    // is the ledger core: it records the row, nothing else. It used to advance
    // the due date here too — unconditionally, anchored on today — which is how
    // a late catch-up payment skipped a month while the occurrence path
    // advanced from the occurrence date. One policy now, in one place.
    return { payment, liability, newBalance: 0, principal: amount, interest: 0, recurring: true };
  }

  // ── Amortizing / revolving / one-time debt ──────────────────────────────
  // The split and the balance after are planned against the balance AS IT IS
  // WHEN THE WRITE LANDS (mutateProfileFields re-plans on a collision), and the
  // write names only the balance keys. It used to spread the liability's whole
  // field map, read before the occurrence claim, back over the row — which put
  // the un-advanced due date back after every payment (so the next payment
  // targeted the same, already-paid occurrence and was swallowed) — and two
  // payments in flight together each planned from the same balance, so the
  // debt dropped by one of them.
  let plan = planDebtPayment(liability, input);
  const balancePatch = (pl: DebtPaymentPlan) => ({
    currentBalance: pl.newBalance, remainingBalance: pl.newBalance, loanBalance: pl.newBalance, lastPaidDate: paymentDate,
  });
  const mutate = (storage as any).mutateProfileFields as
    | ((id: string, fn: (fresh: any) => any) => Promise<any>) | undefined;
  let updated = liability;
  if (plan.moves) {
    if (typeof mutate === "function") {
      updated = (await mutate.call(storage, liability.id, (fresh: any) => {
        plan = planDebtPayment(fresh, input);
        return plan.moves ? { fields: balancePatch(plan) } : null;
      })) ?? liability;
    } else {
      updated = (await storage.updateProfile(liability.id, { fields: balancePatch(plan) } as any)) ?? liability;
    }
  }
  const { balanceBefore, principal, interest, fees, paymentType, newBalance } = plan;

  let payment;
  try {
    payment = await storage.createLiabilityPayment({
      ...(input.id ? { id: input.id } : {}),
      liabilityProfileId: liability.id,
      paymentDate,
      amount,
      // The ledger row stores MAGNITUDES (the table refuses a negative
      // principal or interest); payment_type = 'reversal' carries the
      // direction. Readers that sum principal apply the sign by type.
      principalPortion: Math.abs(principal),
      interestPortion: Math.abs(interest),
      fees: fees + escrow,
      remainingBalanceAfter: plan.moves ? newBalance : undefined,
      paymentType,
      sourceAccount: input.sourceAccount || null,
      notes: withLedgerNote(input.notes,
        plan.overpayment > 0 ? `Overpaid by $${plan.overpayment.toFixed(2)} (owed back by the lender)`
        : plan.forgiven > 0 ? settlementNote(plan.forgiven)
        : null),
    } as any);
  } catch (e) {
    // The balance moved for a row that never landed: put the money back
    // (against the current balance, best effort) and surface the failure.
    if (plan.moves && newBalance !== balanceBefore) {
      const give = balanceBefore - newBalance;
      try {
        if (typeof mutate === "function") {
          await mutate.call(storage, liability.id, (fresh: any) => {
            const back = Math.max(0, resolveLiabilityBalance(fresh) + give);
            return { fields: { currentBalance: back, remainingBalance: back, loanBalance: back } };
          });
        } else {
          await storage.updateProfile(liability.id, { fields: { currentBalance: balanceBefore, remainingBalance: balanceBefore, loanBalance: balanceBefore } } as any);
        }
      } catch { /* the ledger failure is the error worth reporting */ }
    }
    throw e;
  }

  return { payment, liability: updated, newBalance, principal, interest, recurring: false, overpayment: plan.overpayment, forgiven: plan.forgiven };
}

// ─── The one entry-point-facing pay operation ────────────────────────────────
//
// Before this existed there were SIX implementations of "this bill/loan got
// paid": payOccurrence (payment row + occurrence stamp + conditional advance +
// account debit, no balance move), payObligation (payment row dated today +
// unconditional advance anchored on today, caller's chosen date silently
// dropped), applyLiabilityPayment called directly (balance move, no occurrence
// stamp), markLoanPayment (a boolean nobody reads), the autopay cron (a
// hand-rolled copy with its own amount resolver), and an AI tool that routed
// nondeterministically between two of them. Which side effects happened
// depended on which button you pressed. Every entry point — REST routes, AI
// tools, document extraction, the autopay cron — now lands here, and the
// inverse (unpayBillOccurrence) retracts exactly what this wrote.

export type PayBillSource = "route" | "occurrence_route" | "shim" | "ai" | "extraction" | "autopay";

export interface PayBillInput {
  /** YYYY-MM-DD occurrence being settled. Default: the current due date. */
  occurrenceDate?: string | null;
  /** Payment amount. Default: this occurrence's real total (base + charges / posted actual). */
  amount?: number | null;
  /** YYYY-MM-DD the money moved. Default: the occurrence date. */
  paymentDate?: string | null;
  /** Source account PROFILE id — its balance is debited when given. */
  accountId?: string | null;
  method?: string | null;
  notes?: string | null;
  confirmationNumber?: string | null;
  /** Explicit split / classification, passed through to the ledger core. */
  principal?: number | null;
  interest?: number | null;
  escrow?: number | null;
  fees?: number | null;
  paymentType?: LiabilityPaymentType | null;
  /** Override the per-liability autoLogExpense flag for this payment. */
  logExpense?: boolean;
  source: PayBillSource;
}

export interface PayBillStep {
  step: "ledger" | "series_state" | "account" | "expense" | "reminder_tasks";
  ok: boolean;
  error?: string;
}

export interface PayBillResult {
  ok: boolean;
  /** Another request settled this occurrence first; `payment` is THAT row. */
  deduped?: boolean;
  /** A second payment on an occurrence that was already settled: recorded, series state untouched. */
  additional?: boolean;
  reason?: "not_found" | "not_liability" | "payment_failed" | "ended";
  payment?: any;
  liability?: any;
  occurrenceDate: string;
  amount: number;
  recurring: boolean;
  newBalance?: number;
  principal?: number;
  interest?: number;
  /** Money paid beyond a payoff's balance and accrued interest (owed back by the lender). */
  overpayment?: number;
  /** Balance written off by a settlement payoff. */
  forgiven?: number;
  dueDateAdvanced: boolean;
  nextDueDate?: string | null;
  accountAdjusted: boolean;
  expenseId?: string | null;
  /** Ordered per-step outcomes. Steps after "ledger" are best-effort and reported, never silent. */
  steps: PayBillStep[];
}

const noopLogger: PaymentLogger = { warn: () => {}, error: () => {} };

/**
 * Pay one occurrence of a liability — recurring bill, loan, credit card or
 * one-time debt — with every side effect that "paid" means, in one place:
 *
 *   1. ledger        — liability_payments row via applyLiabilityPayment; for
 *                      debt this is also the principal/interest split and the
 *                      balance move (mirrored to every field name readers use).
 *                      Failure here aborts: nothing else has happened yet.
 *   2. series_state  — occurrence override stamped {status:"paid", paymentId,…}
 *                      so the paid state survives payment-row edits; the due
 *                      date advances ONLY when this occurrence IS the current
 *                      due one, anchored on the occurrence date (paying August
 *                      late must not skip September, and must not move the
 *                      cadence's day-of-month); lastPaidDate updates.
 *   3. account       — the source account's balance moves, linked to the
 *                      payment row so the inverse can find it.
 *   4. expense       — recurring bills only: the payment is real spending, so
 *                      budgets and monthly spend see it. Honors
 *                      fields.autoLogExpense !== false. Loan principal is NOT
 *                      consumption and logs no expense.
 *
 * Steps 2–4 are individually guarded and reported in `result.steps` — a partial
 * failure is visible, never silent. There are no DB transactions available
 * here; the order is most-important-first so an interrupted pay leaves the
 * ledger (the source of truth the balance derives from) correct.
 */
/**
 * The winner's ledger row may not be visible for a few hundred ms after its
 * occurrence stamp (stamp first, row second). Poll briefly so a deduped
 * caller gets a real payment (id, date, amount) rather than nothing.
 */
/**
 * The account whose balance history holds the debit for this payment, or
 * null. Skips an account whose history already carries the reversal, so a
 * repeated undo never credits twice.
 */
export async function accountThatPaid(storage: IStorage, paymentId: string): Promise<string | null> {
  if (!paymentId) return null;
  try {
    const profiles: any[] = (await storage.getProfiles()) || [];
    for (const p of profiles) {
      if (!isAccountProfile(p)) continue;
      const history: any[] = Array.isArray(p?.fields?.balanceHistory) ? p.fields.balanceHistory : [];
      const linked = history.filter((a) => a && String(a.linkedRecordId || "") === String(paymentId));
      if (linked.length === 0) continue;
      const reversed = linked.some((a) => /^Reversed payment/.test(String(a.reason || "")));
      return reversed ? null : p.id;
    }
  } catch { /* best effort — no account, no credit */ }
  return null;
}

/** Prefix of the reminder tasks the liability due-scan creates (server/routes.ts). */
export const BILL_REMINDER_TASK_PREFIX = "Bill due: ";

/**
 * Marks done every open "Bill due" reminder task linked to this bill and due
 * on or before the occurrence just paid. Best effort: a storage without
 * tasks (some doubles) or a failed read never fails the payment.
 */
export async function closeBillReminderTasks(storage: IStorage, liabilityId: string, occurrenceDate: string, logger: PaymentLogger = noopLogger): Promise<number> {
  return closeBillReminderTasksWhere(storage, liabilityId, (due) => !due || due <= occurrenceDate, logger);
}

/**
 * Move one occurrence to another day AND retire the reminder task that was
 * raised for its old day. One entry point for the two REST routes and the
 * AI tool: each used to call the storage move alone, so the "Bill due" task
 * for the old day stayed open on the dashboard until the nightly scan.
 */
export async function rescheduleBillOccurrence(
  storage: IStorage,
  liabilityId: string,
  occurrenceDate: string,
  newDate: string,
  logger: PaymentLogger = noopLogger,
): Promise<any> {
  const result = await storage.rescheduleOccurrence(liabilityId, occurrenceDate, newDate);
  if (!result) return result;
  const moved = String(newDate).slice(0, 10);
  await closeBillReminderTasksWhere(storage, liabilityId, (day) => !!day && day < moved, logger).catch(() => 0);
  return result;
}

/**
 * Ids of the surplus copies among open "Bill due" reminders that share a title
 * and due day. Two due-scan runs that overlap (a scheduled run beside a retry
 * or a manual trigger) each read "no reminder yet" and each create one; both
 * runs then collapse the pair the same way — the earliest-created copy (ties
 * broken by id) survives on both sides, so nothing is lost and nothing is
 * left doubled. Pure: exported for tests.
 */
export function pickDuplicateBillReminders(tasks: any[]): string[] {
  const groups = new Map<string, any[]>();
  for (const t of tasks || []) {
    if (!t || t.status === "done") continue;
    if (typeof t.title !== "string" || !t.title.startsWith(BILL_REMINDER_TASK_PREFIX)) continue;
    const key = `${t.title}|${String(t.dueDate || "").slice(0, 10)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const extras: string[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) => {
      const ca = String(a.createdAt || ""), cb = String(b.createdAt || "");
      return ca < cb ? -1 : ca > cb ? 1 : String(a.id).localeCompare(String(b.id));
    });
    for (const t of sorted.slice(1)) extras.push(String(t.id));
  }
  return extras;
}

/** Deletes the surplus reminder copies (see pickDuplicateBillReminders). Returns how many went. */
export async function collapseDuplicateBillReminders(storage: IStorage, logger: PaymentLogger = noopLogger, tasks?: any[]): Promise<number> {
  if (!tasks) tasks = await storage.getTasks().catch(() => [] as any[]);
  let removed = 0;
  for (const id of pickDuplicateBillReminders(tasks as any[])) {
    try { if (await storage.deleteTask(id)) removed++; } catch (e: any) { logger.warn?.(`[bill-reminders] could not drop duplicate ${id}: ${e?.message || e}`); }
  }
  return removed;
}

/** True for an open "Bill due" reminder task that belongs to this bill. */
export function isOpenBillReminderTask(t: any, liabilityId: string): boolean {
  if (!t || t.status === "done") return false;
  if (typeof t.title !== "string" || !t.title.startsWith(BILL_REMINDER_TASK_PREFIX)) return false;
  return Array.isArray(t.linkedProfiles) && t.linkedProfiles.includes(liabilityId);
}

/**
 * Marks done the bill's open reminder tasks whose due day satisfies
 * `settled` — the pay pipeline passes "on or before the paid occurrence"; the
 * due-scan cron passes "that occurrence is paid or skipped, or the schedule
 * has already moved past it", so a reminder left behind by an older build
 * heals on the next run instead of sitting overdue forever.
 */
export async function closeBillReminderTasksWhere(
  storage: IStorage,
  liabilityId: string,
  settled: (dueDay: string) => boolean,
  logger: PaymentLogger = noopLogger,
  tasks?: any[],
): Promise<number> {
  let closed = 0;
  try {
    if (typeof (storage as any).getTasks !== "function" || typeof (storage as any).updateTask !== "function") return 0;
    const all: any[] = tasks ?? ((await storage.getTasks()) || []);
    for (const t of all) {
      if (!isOpenBillReminderTask(t, liabilityId)) continue;
      const due = String(t.dueDate || "").slice(0, 10);
      if (!settled(due)) continue;
      try {
        await storage.updateTask(t.id, { status: "done" } as any);
        closed++;
      } catch (e: any) {
        logger.warn(`[payBillOccurrence] reminder task ${t.id} not closed:`, e?.message || e);
      }
    }
  } catch (e: any) {
    logger.warn(`[payBillOccurrence] reminder tasks not read:`, e?.message || e);
  }
  return closed;
}

async function findPaymentWithRetry(storage: IStorage, liabilityId: string, paymentId: string | null | undefined): Promise<any | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const payments = await storage.getLiabilityPayments(liabilityId).catch(() => [] as any[]);
    const hit = paymentId ? payments.find((p: any) => p.id === paymentId) : payments[0];
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  return paymentId ? { id: paymentId } : null;
}

export async function payBillOccurrence(
  storage: IStorage,
  liabilityId: string,
  input: PayBillInput,
  timezone: string = DEFAULT_TIMEZONE,
  logger: PaymentLogger = noopLogger,
): Promise<PayBillResult> {
  const steps: PayBillStep[] = [];
  const fail = (reason: PayBillResult["reason"]): PayBillResult => ({
    ok: false, reason, occurrenceDate: "", amount: 0, recurring: false,
    dueDateAdvanced: false, accountAdjusted: false, steps,
  });

  const liability: any = await storage.getProfile(liabilityId);
  if (!liability) return fail("not_found");
  if (liability.type !== "liability" && liability.type !== "loan") return fail("not_liability");

  const f: any = liability.fields || {};
  const typeKey = (liability as any).type_key ?? (liability as any).typeKey;
  const recurring = isRecurringBill(typeKey);
  const todayISO = getUserToday(timezone);
  const curDue = readDueDate(f);
  let occurrenceDate =
    String(input.occurrenceDate || curDue || input.paymentDate || todayISO).slice(0, 10);
  // A payment aimed at a rescheduled occurrence's MOVED day settles the
  // occurrence under its anchor key (D221).
  if (input.occurrenceDate) occurrenceDate = resolveOccurrenceKey(f, occurrenceDate);
  // Default the payment date to the occurrence's due date only when that day
  // has arrived; paying a future bill early is money that left TODAY. The old
  // default dated "Mark paid" on a bill due next week as next week's expense.
  const paymentDate = String(input.paymentDate || (occurrenceDate > todayISO ? todayISO : occurrenceDate)).slice(0, 10);
  // An implicit "pay what's due" dated on or before the occurrence that was
  // paid last belongs to THAT occurrence: the regular payment on the 3rd
  // advanced the due date to next month, so a second amount sent the same day
  // used to be booked as next month's payment and the due date skipped a
  // month. A payment dated after the last paid occurrence is the next cycle's
  // (a catch-up on two overdue months still claims them one after another).
  if (!input.occurrenceDate && input.paymentType !== "extra_principal") {
    const paidDates = Object.entries((f.occurrences && typeof f.occurrences === "object") ? f.occurrences : {})
      .filter(([d, o]: [string, any]) => o && o.status === "paid" && /^\d{4}-\d{2}-\d{2}$/.test(d))
      .map(([d]) => d).sort();
    const lastPaid = paidDates[paidDates.length - 1];
    if (lastPaid && paymentDate <= lastPaid && occurrenceDate > lastPaid) occurrenceDate = lastPaid;
  }

  // ONE amount resolver for every entry point: the occurrence's real total —
  // base + this period's charges, or the posted actual — through the billing
  // model. A usage-based bill paid without an explicit amount settles its real
  // $42, not the definition's $20 (which is what the autopay cron and the
  // obligation route used to log).
  const defFields = deriveScheduleFields(f, typeKey, todayISO);
  const definitionAmount = liabilityAmount({ id: liability.id, fields: defFields });
  const override = (f.occurrences && typeof f.occurrences === "object") ? f.occurrences[occurrenceDate] : null;
  const money = resolveOccurrenceAmount(definitionAmount, override, resolveBillingModel(liability));
  const amount = input.amount != null ? Number(input.amount) : money.current;

  // A finite plan has no occurrence past its last instalment. Paying one
  // stamped a phantom occurrence, wrote a ledger row and moved the due date
  // further out (D277). Already-stamped days stay payable (a second payment
  // on a settled occurrence is handled below).
  if (recurring && !input.paymentType) {
    const last = lastSeriesOccurrence(f);
    const stamped = !!(f.occurrences && typeof f.occurrences === "object" && f.occurrences[occurrenceDate]);
    if (last && occurrenceDate > last && !stamped) {
      return { ok: false, reason: "ended", occurrenceDate, amount, recurring, dueDateAdvanced: false, accountAdjusted: false, expenseId: null, steps };
    }
  }

  const account: any = input.accountId ? await storage.getProfile(input.accountId) : null;
  // An extra-principal payment is not the scheduled one: it moves the balance
  // and nothing else. Claiming the occurrence for it marked the month paid and
  // advanced the due date, and when the month was already paid it was folded
  // into that payment and never recorded.
  const extraOnly = input.paymentType === "extra_principal";
  // A payment on an occurrence that is already settled: a double tap when it
  // is the same money seconds after the winner; otherwise a second payment
  // (the rest of a partial, an extra amount sent the same day) that is
  // recorded without touching the series state.
  // A repeated tap repeats the same payment: the same money, seconds later,
  // dated the same day. A request that names another payment date — a
  // back-filled month, a script replaying history — is a different payment;
  // folding those answered every one with the first row while the balance
  // moved once (D270). Stamps written before this change carry no date and
  // fold on money and time alone, as before.
  const sameTap = (stamp: any) => {
    const ageMs = stamp && typeof stamp.postedAt === "string" ? Date.now() - Date.parse(stamp.postedAt) : NaN;
    const stampDate = stamp && typeof stamp.paymentDate === "string" ? stamp.paymentDate.slice(0, 10) : "";
    const sameDay = !stampDate || stampDate === String(paymentDate || "").slice(0, 10);
    return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 8000 && Math.abs(Number(stamp.amount) - amount) < 0.005 && sameDay;
  };
  // Only an explicit form submission means "pay this again": automation
  // (autopay, a confirmed extraction, a chat tool the model may call twice)
  // keeps the old idempotent answer on a settled occurrence.
  const automated = input.source === "autopay" || input.source === "extraction" || input.source === "ai" || input.source === "shim";
  // A one-tap "Mark paid" (no amount of its own) repeated on a settled
  // occurrence is the same tap a minute later, not a second payment; only a
  // payment that names its amount can be one.
  const explicitAmount = input.amount != null && Number.isFinite(Number(input.amount));
  let additional = false;

  // ── 0a. an implicit "pay what's due" right after a payment is the same tap ─
  // The claim below stops two requests settling ONE occurrence. But a second
  // request that reads the bill after the first advanced the due date sees
  // the NEXT occurrence as current and pays it: a triple-tap on "Mark paid"
  // paid September and October. The route's in-memory 8-second window only
  // covered one instance; this is the same rule, cross-instance, keyed on
  // the stamp the winner just wrote. Only implicit pays (no occurrenceDate)
  // are folded — an explicit occurrence is an explicit intent.
  if (!input.occurrenceDate && !extraOnly) {
    const stamps = Object.values((f.occurrences && typeof f.occurrences === "object") ? f.occurrences : {}) as any[];
    const latest = stamps
      .filter((o) => o && o.status === "paid" && typeof o.postedAt === "string" && o.paymentId)
      .sort((a, b) => String(b.postedAt).localeCompare(String(a.postedAt)))[0];
    if (latest && sameTap(latest)) {
      const winner = await findPaymentWithRetry(storage, liabilityId, latest.paymentId);
      return {
        ok: true, deduped: true, payment: winner, liability, occurrenceDate: curDue || occurrenceDate,
        amount: winner?.amount ?? (Number(latest.amount) || amount), recurring, dueDateAdvanced: false, nextDueDate: null,
        accountAdjusted: false, expenseId: null, steps: [{ step: "series_state", ok: true }],
      };
    }
  }

  // ── 0. claim the occurrence (compare-and-set) ───────────────────────────
  // Two requests for the same occurrence — a double tap, two tabs, two
  // lambdas — each read the bill unpaid and each wrote a ledger row and an
  // expense (the due date advanced once, the money counted twice). The
  // occurrence stamp is now written FIRST, conditioned on the occurrence not
  // already being paid; the loser sees 0 rows and answers with the winner's
  // payment. Storages without the CAS (tests, in-memory) keep the old order.
  const paymentId = randomUUID();
  let dueDateAdvanced = false;
  let nextDueDate: string | null = null;
  let claimed = false;
  let priorOccurrences: Record<string, any> | null = null;
  const claimFn = (storage as any).claimBillOccurrence as
    | ((id: string, date: string, stamp: Record<string, any>, extra: Record<string, any>) => Promise<{ status: "claimed" | "already-paid"; occurrences: Record<string, any> }>)
    | undefined;
  if (typeof claimFn === "function" && !extraOnly) {
    const stamp = {
      status: "paid", paymentId, amount, actualAmount: amount, paidAmount: amount,
      postedAt: new Date().toISOString(), paymentDate, ...(account ? { accountId: account.id } : {}),
    };
    const extra: Record<string, any> = { lastPaidDate: paymentDate };
    let advanced: string | null = null;
    if (curDue && curDue === occurrenceDate) {
      const adv = advanceLiabilityDueDatePatch(f, occurrenceDate);
      advanced = adv.dueDate;
      Object.assign(extra, adv, { status: "upcoming" });
    }
    try {
      const claim = await claimFn.call(storage, liabilityId, occurrenceDate, stamp, extra);
      if (claim.status === "already-paid") {
        const prior = claim.occurrences?.[occurrenceDate];
        if (sameTap(prior) || automated || !explicitAmount) {
          const winner = await findPaymentWithRetry(storage, liabilityId, prior?.paymentId);
          return {
            ok: true, deduped: true, payment: winner, liability, occurrenceDate,
            amount: winner?.amount ?? amount, recurring, dueDateAdvanced: false, nextDueDate: null,
            accountAdjusted: false, expenseId: null, steps: [{ step: "series_state", ok: true }],
          };
        }
        additional = true;
      } else {
        claimed = true;
        priorOccurrences = claim.occurrences;
        dueDateAdvanced = !!advanced;
        nextDueDate = advanced;
        steps.push({ step: "series_state", ok: true });
      }
    } catch (e: any) {
      logger.warn(`[payBillOccurrence] occurrence claim failed for ${liability.name}, using legacy order:`, e?.message || e);
    }
  }

  // ── 1. ledger (+ balance for debt) ──────────────────────────────────────
  let ledger: LiabilityPaymentResult;
  try {
    ledger = await applyLiabilityPayment(storage, liability, {
      id: paymentId,
      amount,
      paymentDate,
      principal: input.principal ?? null,
      interest: input.interest ?? null,
      escrow: input.escrow ?? null,
      fees: input.fees ?? null,
      paymentType: input.paymentType ?? null,
      sourceAccount: account?.name || input.method || null,
      notes: input.notes || (input.confirmationNumber ? `Confirmation ${input.confirmationNumber}` : null),
    }, timezone);
    steps.push({ step: "ledger", ok: true });
  } catch (e: any) {
    steps.push({ step: "ledger", ok: false, error: e?.message || String(e) });
    logger.error(`[payBillOccurrence] ledger write failed for ${liability.name}:`, e?.message || e);
    if (claimed) {
      // Release the claim so the occurrence is payable again (best effort).
      try {
        await storage.updateProfile(liabilityId, { fields: {
          occurrences: priorOccurrences || {}, dueDate: curDue, nextDueDate: curDue,
          lastPaidDate: f.lastPaidDate ?? null,
        } } as any);
      } catch { /* the stamp stays; unpay can clear it */ }
    }
    return fail("payment_failed");
  }
  const payment = ledger.payment;

  // ── 2. series state: occurrence stamp + conditional advance, ONE write ──
  // (legacy order, only when the storage has no compare-and-set claim)
  if (!claimed && !additional && !extraOnly) try {
    const occ: Record<string, any> =
      (f.occurrences && typeof f.occurrences === "object") ? { ...f.occurrences } : {};
    occ[occurrenceDate] = {
      ...(occ[occurrenceDate] || {}),
      status: "paid",
      paymentId: payment?.id,
      amount,
      actualAmount: amount,
      paidAmount: amount,
      postedAt: new Date().toISOString(),
      ...(account ? { accountId: account.id } : {}),
    };
    const patch: any = { occurrences: occ, lastPaidDate: paymentDate };
    if (curDue && curDue === occurrenceDate) {
      const adv = advanceLiabilityDueDatePatch(f, occurrenceDate);
      nextDueDate = adv.dueDate;
      Object.assign(patch, adv, { status: "upcoming" });
      dueDateAdvanced = true;
    }
    await storage.updateProfile(liabilityId, { fields: patch } as any);
    steps.push({ step: "series_state", ok: true });
  } catch (e: any) {
    steps.push({ step: "series_state", ok: false, error: e?.message || String(e) });
    logger.warn(`[payBillOccurrence] occurrence stamp failed for ${liability.name}:`, e?.message || e);
  }

  // ── 3. source account debit ─────────────────────────────────────────────
  let accountAdjusted = false;
  if (account && isAccountProfile(account)) {
    try {
      await storage.adjustAccountBalance(account.id, {
        delta: isDebtAccount(account) ? amount : -amount,
        date: paymentDate,
        reason: `Payment — ${liability.name} ${occurrenceDate}`,
        source: "payment",
        linkedRecordId: payment?.id || liabilityId,
      });
      accountAdjusted = true;
      steps.push({ step: "account", ok: true });
    } catch (e: any) {
      steps.push({ step: "account", ok: false, error: e?.message || String(e) });
      logger.warn(`[payBillOccurrence] account debit failed for ${account.name}:`, e?.message || e);
    }
  }

  // ── 4. expense (recurring bills only) ───────────────────────────────────
  // A paid bill is money actually spent; without this row budgets and monthly
  // spend never see bill payments at all. Loan payments move a balance instead
  // — logging principal as spending would distort budgets.
  let expenseId: string | null = null;
  const logExpense = input.logExpense ?? (recurring && f.autoLogExpense !== false);
  if (recurring && logExpense && amount > 0) {
    try {
      // The bill's owners, as the bills list reports them (D207): its parent
      // AND everyone on it through liability_profile_links. Linked to the
      // parent alone, a co-signed rent's payments never reached the
      // co-signer's scoped spend while the bill itself showed there (D223).
      const parties = await Promise.resolve((storage as any).getLiabilityProfileLinks?.(liabilityId))
        .then((rows: any) => (Array.isArray(rows) ? rows.map((l: any) => l?.partyProfileId).filter((x: any) => typeof x === "string" && x) : []))
        .catch(() => [] as string[]);
      const owners = Array.from(new Set([(liability as any).parentProfileId || liabilityId, ...parties]));
      const expense = await storage.createExpense({
        amount,
        category: String(f.category || "bills"),
        description: `${liability.name} — ${occurrenceDate}`,
        date: paymentDate,
        linkedProfiles: owners,
        // The payment:<id> tag is the join key unpayBillOccurrence uses to
        // retract this exact expense. Not display metadata — an inverse's key.
        tags: [BILL_PAYMENT_TAG, `liability:${liabilityId}`, `${PAYMENT_TAG_PREFIX}${payment?.id}`],
      } as any);
      expenseId = expense?.id ?? null;
      steps.push({ step: "expense", ok: true });
    } catch (e: any) {
      steps.push({ step: "expense", ok: false, error: e?.message || String(e) });
      logger.warn(`[payBillOccurrence] expense log failed for ${liability.name}:`, e?.message || e);
    }
  }

  // ── 5. reminder tasks ───────────────────────────────────────────────────
  // The due-scan cron surfaces a non-autopay bill as a "Bill due: <name>"
  // task linked to the bill. Paying the occurrence is what that task asked
  // for, so it is done now — it used to stay open (and overdue) on the Tasks
  // page and the dashboard after the bill was paid.
  const remindersClosed = await closeBillReminderTasks(storage, liabilityId, occurrenceDate, logger);
  if (remindersClosed > 0) steps.push({ step: "reminder_tasks", ok: true });

  return {
    ok: true,
    ...(additional ? { additional: true } : {}),
    payment,
    liability: ledger.liability,
    occurrenceDate,
    amount,
    recurring,
    newBalance: ledger.newBalance,
    overpayment: ledger.overpayment || 0,
    forgiven: ledger.forgiven || 0,
    principal: ledger.principal,
    interest: ledger.interest,
    dueDateAdvanced,
    nextDueDate,
    accountAdjusted,
    expenseId,
    steps,
  };
}

// ─── The inverse ─────────────────────────────────────────────────────────────

export interface UnpayBillInput {
  /** Explicit payment row to retract. Wins over occurrenceDate. */
  paymentId?: string | null;
  /** Retract the payment that settled this occurrence. Default: the latest payment. */
  occurrenceDate?: string | null;
  source: "route" | "ai";
}

export interface UnpayBillStep {
  step: "delete_payment" | "schedule_unmark" | "occurrence_clear" | "series_rollback" | "balance_restore" | "account_credit" | "expense_delete";
  ok: boolean;
  error?: string;
}

export interface UnpayBillResult {
  ok: boolean;
  reason?: "not_found" | "no_payment";
  deletedPaymentId?: string;
  deletedAmount?: number;
  deletedPaymentDate?: string;
  occurrenceCleared: boolean;
  dueDateRolledBack: boolean;
  balanceRestored: boolean;
  accountCredited: boolean;
  expenseDeleted: boolean;
  steps: UnpayBillStep[];
}

/**
 * Retract a payment: the exact inverse of payBillOccurrence. Before this
 * existed, "undo" was a bare row delete — the occurrence stayed stamped paid
 * forever (with a dangling paymentId), the due date stayed advanced, the debt
 * balance stayed reduced-by-nothing... reversed by nothing, the account debit
 * survived, and one of the two undo routes reached around the storage layer
 * entirely with a raw supabase delete.
 *
 * Handles legacy payments recorded by the retired payObligation path (no
 * occurrence override): the override-clear is skipped, everything else still
 * reverses.
 */
export async function unpayBillOccurrence(
  storage: IStorage,
  liabilityId: string,
  input: UnpayBillInput,
  timezone: string = DEFAULT_TIMEZONE,
  logger: PaymentLogger = noopLogger,
): Promise<UnpayBillResult> {
  const steps: UnpayBillStep[] = [];
  const fail = (reason: UnpayBillResult["reason"]): UnpayBillResult => ({
    ok: false, reason, occurrenceCleared: false, dueDateRolledBack: false,
    balanceRestored: false, accountCredited: false, expenseDeleted: false, steps,
  });

  const liability: any = await storage.getProfile(liabilityId);
  if (!liability || (liability.type !== "liability" && liability.type !== "loan")) return fail("not_found");
  const f: any = liability.fields || {};
  const recurring = isRecurringBillProfile(liability as any);

  // Resolve the payment row to retract.
  const payments = await storage.getLiabilityPayments(liabilityId); // newest first
  if (!payments || payments.length === 0) return fail("no_payment");
  const byRecency = (a: any, b: any) =>
    String(b.createdAt || b.paymentDate || "").localeCompare(String(a.createdAt || a.paymentDate || ""));
  let target: any | undefined;
  if (input.paymentId) {
    target = payments.find((p: any) => p.id === input.paymentId);
  } else if (input.occurrenceDate) {
    const occDate = String(input.occurrenceDate).slice(0, 10);
    const ov = (f.occurrences && typeof f.occurrences === "object") ? f.occurrences[occDate] : null;
    target = (ov?.paymentId && payments.find((p: any) => p.id === ov.paymentId))
      || payments.filter((p: any) => String(p.paymentDate || "").slice(0, 10) === occDate).sort(byRecency)[0];
  } else {
    target = [...payments].sort(byRecency)[0];
  }
  if (!target) return fail("no_payment");

  // Which occurrence did this payment settle? The override that names it, or
  // (legacy rows: no override) the payment's own date — the same key the
  // schedule's date-coincidence rule credited it to.
  const occEntries: Array<[string, any]> =
    (f.occurrences && typeof f.occurrences === "object") ? Object.entries(f.occurrences) : [];
  const stamped = occEntries.find(([, ov]) => ov && ov.paymentId === target.id);
  const occurrenceDate = stamped?.[0] || String(target.paymentDate || "").slice(0, 10);
  const stampedOverride = stamped?.[1] || null;

  // ── 1. delete the payment row (abort if it isn't there) ─────────────────
  try {
    const deleted = await storage.deleteLiabilityPayment(target.id);
    if (!deleted) { steps.push({ step: "delete_payment", ok: false, error: "row not found" }); return fail("no_payment"); }
    steps.push({ step: "delete_payment", ok: true });
  } catch (e: any) {
    steps.push({ step: "delete_payment", ok: false, error: e?.message || String(e) });
    logger.error(`[unpayBillOccurrence] payment delete failed:`, e?.message || e);
    return fail("no_payment");
  }
  // ── 1b. the amortization row this payment had marked paid opens again ──
  // "Mark paid" on a schedule row records the ledger payment and flips the
  // row's flag; retracting the payment used to leave the flag set, so the
  // row could never be marked again and the projection still counted it paid
  // while the balance had gone back up.
  try {
    const numberMatch = /Amortization payment #(\d+)/.exec(String(target.notes || ""));
    const cleared = await storage.unmarkLoanPayment(liabilityId, {
      paymentNumber: numberMatch ? Number(numberMatch[1]) : null,
      paymentDate: String(target.paymentDate || "").slice(0, 10) || null,
    });
    if (cleared > 0) steps.push({ step: "schedule_unmark", ok: true });
  } catch (e: any) {
    steps.push({ step: "schedule_unmark", ok: false, error: e?.message || String(e) });
  }
  const amount = Number(target.amount) || 0;

  // ── 2. clear the occurrence's paid stamp ────────────────────────────────
  // Only the keys pay wrote get nulled; a posted actualAmount predating the
  // pay is period history and survives. Only clears when the stamp names THIS
  // payment — an occurrence paid by a different row is not ours to unmark.
  let occurrenceCleared = false;
  if (stampedOverride) {
    try {
      await storage.updateOccurrenceOverride(liabilityId, occurrenceDate, {
        status: null, paymentId: null, paidAmount: null, postedAt: null, accountId: null,
      });
      occurrenceCleared = true;
      steps.push({ step: "occurrence_clear", ok: true });
    } catch (e: any) {
      steps.push({ step: "occurrence_clear", ok: false, error: e?.message || String(e) });
      logger.warn(`[unpayBillOccurrence] occurrence clear failed:`, e?.message || e);
    }
  }

  // ── 3–4. series rollback + balance restore + lastPaidDate, ONE write ────
  let rolledBack = false;
  let restoredBalance = false;
  try {
    const patch: Record<string, any> = {};
    // Roll the due date back iff paying this occurrence is exactly what
    // advanced it: the stored due date equals one cycle from the occurrence.
    // A definition edited since the payment fails this check and the due date
    // deliberately stays put (reported via dueDateRolledBack: false).
    if (occurrenceDate && curDueEqualsAdvanceFrom(f, occurrenceDate)) {
      patch.dueDate = occurrenceDate;
      patch.nextDueDate = occurrenceDate;
      rolledBack = true;
    }
    // Debt: put the principal back, under every name readers use. A reversal-
    // type row carries negative principal, so plain addition also handles it.
    // A reversal row stores its principal as a magnitude; undoing a reversal
    // takes that money back OFF the balance.
    // A settlement payoff's written-off balance comes back too: the debt was
    // only closed because of that payment.
    const principal = signedPrincipal(target) + writtenOffOf(target);
    const restores = !recurring && principal !== 0 && target.paymentType !== "skipped" && target.paymentType !== "deferred";
    // lastPaidDate: the latest remaining payment, or gone.
    const remaining = payments.filter((p: any) => p.id !== target.id).sort(byRecency);
    patch.lastPaidDate = remaining[0]?.paymentDate ?? null;
    const withBalance = (base: any) => {
      if (!restores) return patch;
      // The principal goes back onto the balance AS IT IS when the write
      // lands, not onto the figure this call read: an undo beside another
      // payment used to put the pre-undo balance back over that payment.
      const restored = resolveLiabilityBalance(base) + principal;
      return { ...patch, currentBalance: restored, remainingBalance: restored, loanBalance: restored };
    };
    const mutate = (storage as any).mutateProfileFields as
      | ((id: string, fn: (fresh: any) => any) => Promise<any>) | undefined;
    if (restores && typeof mutate === "function") {
      await mutate.call(storage, liabilityId, (fresh: any) => ({ fields: withBalance(fresh) }));
    } else {
      await storage.updateProfile(liabilityId, { fields: withBalance(liability) } as any);
    }
    restoredBalance = restores;
    steps.push({ step: "series_rollback", ok: true });
    if (restoredBalance) steps.push({ step: "balance_restore", ok: true });
  } catch (e: any) {
    steps.push({ step: "series_rollback", ok: false, error: e?.message || String(e) });
    logger.warn(`[unpayBillOccurrence] series rollback failed:`, e?.message || e);
    rolledBack = false;
    restoredBalance = false;
  }

  // ── 5. credit the account the payment debited ───────────────────────────
  // The occurrence stamp names the account for a recurring bill. A loan or
  // card payment has no occurrence stamp, so the account that paid it is
  // found through its own balance history: the debit carries this payment's
  // id as linkedRecordId. Without this, undoing a loan payment restored the
  // debt balance but left the checking balance short by the payment.
  let accountCredited = false;
  const accountId = stampedOverride?.accountId || await accountThatPaid(storage, target.id);
  if (accountId) {
    try {
      const account: any = await storage.getProfile(accountId);
      if (account && isAccountProfile(account)) {
        await storage.adjustAccountBalance(account.id, {
          delta: isDebtAccount(account) ? -amount : amount,
          reason: `Reversed payment — ${liability.name} ${occurrenceDate}`,
          source: "payment",
          linkedRecordId: target.id,
        });
        accountCredited = true;
        steps.push({ step: "account_credit", ok: true });
      }
    } catch (e: any) {
      steps.push({ step: "account_credit", ok: false, error: e?.message || String(e) });
      logger.warn(`[unpayBillOccurrence] account credit failed:`, e?.message || e);
    }
  }

  // ── 6. retract the expense this payment logged ──────────────────────────
  let expenseDeleted = false;
  try {
    const tag = `payment:${target.id}`;
    const expenses = await storage.getExpenses();
    const logged = (expenses || []).find((e: any) => Array.isArray(e.tags) && e.tags.includes(tag));
    if (logged) {
      await storage.deleteExpense(logged.id);
      expenseDeleted = true;
      steps.push({ step: "expense_delete", ok: true });
    }
  } catch (e: any) {
    steps.push({ step: "expense_delete", ok: false, error: e?.message || String(e) });
    logger.warn(`[unpayBillOccurrence] expense retract failed:`, e?.message || e);
  }

  return {
    ok: true,
    deletedPaymentId: target.id,
    deletedAmount: amount,
    deletedPaymentDate: String(target.paymentDate || "").slice(0, 10) || undefined,
    occurrenceCleared,
    dueDateRolledBack: rolledBack,
    balanceRestored: restoredBalance,
    accountCredited,
    expenseDeleted,
    steps,
  };
}

/** Is the stored due date exactly one cycle on from `occDate` — i.e. is the
 *  advance that paying `occDate` performed still in effect, untouched? */
function curDueEqualsAdvanceFrom(fields: any, occDate: string): boolean {
  const cur = readDueDate(fields);
  if (!cur) return false;
  const expected = advanceLiabilityDueDate(
    { ...(fields || {}), dueDate: occDate, nextDueDate: occDate },
    occDate,
  );
  return expected === cur;
}

// ─── The expense a payment logged, edited afterwards ─────────────────────────
//
// payBillOccurrence logs a recurring bill's payment as an expense tagged
// `payment:<id>` — the join key unpayBillOccurrence retracts by. That made the
// expense a COPY of the payment with one inverse (delete) and no forward edge
// for an edit: correcting the amount on the Finance page ("the power bill was
// actually $45") left the bill's history, the occurrence stamp and the paying
// account at $40. Two views of one payment disagreed about how much was paid.
//
// The edit is applied in place — the ledger row, the occurrence stamp and the
// account that paid all move by the same delta — rather than by unpay + pay,
// which would delete the expense the user just edited and re-log a fresh one
// without their other changes.

// One home for the tag vocabulary: shared/bill-payment-expense.ts also reads
// these to keep bill payments out of cash flow's one-time bucket.
export { BILL_PAYMENT_TAG, PAYMENT_TAG_PREFIX };

/** The payment id an expense carries when a bill payment logged it. */
export function paymentIdOfExpense(expense: { tags?: unknown } | null | undefined): string | null {
  const tags = Array.isArray(expense?.tags) ? (expense!.tags as unknown[]) : [];
  const tag = tags.find((t) => typeof t === "string" && t.startsWith(PAYMENT_TAG_PREFIX)) as string | undefined;
  const id = tag ? tag.slice(PAYMENT_TAG_PREFIX.length).trim() : "";
  return id || null;
}

/**
 * Tags that claim an expense records a bill payment (`payment:<id>` and the
 * `bill-payment` marker) are the pipeline's to write. A client re-creating
 * a deleted expense (the Undo toast) sent them back after the payment had
 * been reversed, so a plain expense claimed a payment that no longer existed
 * and the edit path tried to reprice it (D282). Keep only the tags whose
 * payment is this user's and still there.
 */
export async function stripDanglingPaymentTags(storage: IStorage, tags: unknown): Promise<string[]> {
  const list = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
  const kept: string[] = [];
  let hasPayment = false;
  for (const t of list) {
    if (t.startsWith(PAYMENT_TAG_PREFIX)) {
      const id = t.slice(PAYMENT_TAG_PREFIX.length).trim();
      const row = id ? await storage.getLiabilityPayment(id).catch(() => null) : null;
      if (!row) continue;
      hasPayment = true;
    }
    kept.push(t);
  }
  return hasPayment ? kept : kept.filter((t) => t !== BILL_PAYMENT_TAG);
}

/**
 * Removing an expense a bill payment logged retracts that payment — the
 * expense is the payment's record of the money leaving, so deleting it alone
 * left the bill paid, the stamp set and the account debited (D279). One
 * implementation for the expense delete route and the assistant's delete,
 * full-refund and convert-to-asset tools. Returns null when the expense is
 * not a bill payment's (the caller deletes it as usual), otherwise the
 * retraction's outcome — the retraction deletes the expense itself.
 */
export async function retractPaymentOfExpense(
  storage: IStorage,
  expense: { id: string; tags?: unknown } | null | undefined,
  timezone: string = DEFAULT_TIMEZONE,
  logger: PaymentLogger = noopLogger,
): Promise<{ ok: boolean; paymentId: string; liabilityId: string | null; expenseDeleted: boolean } | null> {
  const paymentId = paymentIdOfExpense(expense);
  if (!expense || !paymentId) return null;
  const row: any = await storage.getLiabilityPayment(paymentId).catch(() => null);
  if (!row?.liabilityProfileId) return { ok: false, paymentId, liabilityId: null, expenseDeleted: false };
  const undone = await unpayBillOccurrence(storage, String(row.liabilityProfileId), { paymentId, source: "route" }, timezone, logger);
  if (undone.ok && !undone.expenseDeleted) {
    try { await storage.deleteExpense(expense.id); } catch { /* the caller's own delete follows */ }
  }
  return { ok: undone.ok, paymentId, liabilityId: String(row.liabilityProfileId), expenseDeleted: undone.ok };
}

export interface RepriceBillPaymentResult {
  ok: boolean;
  reason?: "not_found" | "unchanged";
  paymentId: string;
  previousAmount?: number;
  amount?: number;
  previousDate?: string;
  paymentDate?: string;
  stampMoved: boolean;
  accountAdjusted: boolean;
  /** The logged expense re-priced in place (never re-logged). */
  expenseUpdated: boolean;
  payment?: any;
}

/**
 * Re-price a recurring bill's payment IN PLACE: the ledger row, the paid
 * occurrence stamp, the paying account's balance and (unless the caller edited
 * it already) the expense the payment logged all move together. A bill payment
 * is all principal (see planDebtPayment: no balance → principal = amount), so
 * the split moves with it.
 *
 * This replaces "unpay + pay" for a bill's amount/date edit. That pair deleted
 * the logged expense and re-logged a fresh one, so the category and
 * description the user had given it were thrown away and the row changed id
 * under the Finance page.
 */
export async function repriceBillPayment(
  storage: IStorage,
  paymentId: string,
  change: { amount?: number | null; paymentDate?: string | null },
  opts: { expense: "sync" | "skip" } = { expense: "sync" },
  logger: PaymentLogger = noopLogger,
): Promise<RepriceBillPaymentResult> {
  const base: RepriceBillPaymentResult = { ok: false, paymentId, stampMoved: false, accountAdjusted: false, expenseUpdated: false };
  if (!paymentId) return base;
  const row: any = await Promise.resolve((storage as any).getLiabilityPayment?.(paymentId)).catch(() => undefined);
  if (!row) return { ...base, reason: "not_found" };
  const previousAmount = Number(row.amount) || 0;
  const previousDate = String(row.paymentDate || "").slice(0, 10);
  const newAmount = change.amount != null && Number.isFinite(Number(change.amount)) && Number(change.amount) > 0 ? Number(change.amount) : previousAmount;
  const newDate = change.paymentDate && /^\d{4}-\d{2}-\d{2}$/.test(String(change.paymentDate)) ? String(change.paymentDate) : previousDate;
  const amountChanged = newAmount !== previousAmount;
  const dateChanged = newDate !== previousDate;
  if (!amountChanged && !dateChanged) return { ...base, ok: true, reason: "unchanged", previousAmount, amount: newAmount, previousDate, paymentDate: newDate, payment: row };
  const delta = newAmount - previousAmount;

  const rowPatch: Record<string, any> = {};
  if (amountChanged) {
    rowPatch.amount = newAmount;
    if (Number(row.principalPortion) === previousAmount) rowPatch.principalPortion = newAmount;
  }
  if (dateChanged) rowPatch.paymentDate = newDate;
  const updatedRow = await storage.updateLiabilityPayment(paymentId, rowPatch as any);
  if (!updatedRow) return { ...base, reason: "not_found" };
  const result: RepriceBillPaymentResult = { ...base, ok: true, previousAmount, amount: newAmount, previousDate, paymentDate: newDate, payment: updatedRow };

  let accountId: string | null = null;
  try {
    const liability: any = await storage.getProfile(row.liabilityProfileId);
    const occ = liability?.fields?.occurrences;
    const hit = occ && typeof occ === "object"
      ? Object.entries(occ as Record<string, any>).find(([, ov]) => ov && ov.paymentId === paymentId) : undefined;
    const lastPaidFollows = dateChanged && String(liability?.fields?.lastPaidDate || "").slice(0, 10) === previousDate;
    if (hit || lastPaidFollows) {
      accountId = hit ? ((hit[1] as any)?.accountId || null) : null;
      const mutate = (storage as any).mutateProfileFields;
      const next = (fresh: any) => {
        const fields: Record<string, any> = {};
        if (hit && amountChanged) {
          const cur = fresh?.fields?.occurrences && typeof fresh.fields.occurrences === "object" ? { ...fresh.fields.occurrences } : {};
          const date = hit[0];
          cur[date] = { ...(cur[date] || {}), amount: newAmount, actualAmount: newAmount, paidAmount: newAmount };
          fields.occurrences = cur;
        }
        if (lastPaidFollows) fields.lastPaidDate = newDate;
        return Object.keys(fields).length > 0 ? { fields } : null;
      };
      const patch = next(liability);
      if (patch) {
        if (typeof mutate === "function") await mutate.call(storage, row.liabilityProfileId, next);
        else await storage.updateProfile(row.liabilityProfileId, patch as any);
        result.stampMoved = !!(hit && amountChanged);
      }
    }
  } catch (e: any) {
    logger.warn(`[repriceBillPayment] occurrence stamp update failed for ${paymentId}:`, e?.message || e);
  }

  if (accountId && amountChanged) {
    try {
      const account: any = await storage.getProfile(accountId);
      if (account && isAccountProfile(account)) {
        await storage.adjustAccountBalance(account.id, {
          delta: isDebtAccount(account) ? delta : -delta,
          reason: `Payment corrected — ${previousAmount} → ${newAmount}`,
          source: "payment",
          linkedRecordId: paymentId,
        });
        result.accountAdjusted = true;
      }
    } catch (e: any) {
      logger.warn(`[repriceBillPayment] account adjustment failed for ${paymentId}:`, e?.message || e);
    }
  }

  if (opts.expense === "sync") {
    try {
      const tag = `${PAYMENT_TAG_PREFIX}${paymentId}`;
      const expenses = await storage.getExpenses();
      const logged = (expenses || []).find((e: any) => Array.isArray(e.tags) && e.tags.includes(tag));
      if (logged) {
        const patch: Record<string, any> = {};
        if (amountChanged) patch.amount = newAmount;
        if (dateChanged) patch.date = newDate;
        await storage.updateExpense(logged.id, patch as any);
        result.expenseUpdated = true;
      }
    } catch (e: any) {
      logger.warn(`[repriceBillPayment] logged expense update failed for ${paymentId}:`, e?.message || e);
    }
  }
  return result;
}

/**
 * The expense side of the same edit: Finance changed a bill-payment expense's
 * amount, so the payment follows (the expense itself is already written).
 */
export async function repriceBillPaymentFromExpense(
  storage: IStorage,
  expense: { id?: string; tags?: unknown; amount?: unknown },
  newAmount: number,
  logger: PaymentLogger = noopLogger,
): Promise<RepriceBillPaymentResult> {
  const paymentId = paymentIdOfExpense(expense) || "";
  if (!paymentId || !Number.isFinite(newAmount) || newAmount <= 0) {
    return { ok: false, paymentId, stampMoved: false, accountAdjusted: false, expenseUpdated: false };
  }
  return repriceBillPayment(storage, paymentId, { amount: newAmount }, { expense: "skip" }, logger);
}
