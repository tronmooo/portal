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
import { isRecurringBill } from "@shared/liability-types";
import { advanceLiabilityDueDate } from "@shared/liability-recurrence";
import { resolveLiabilityBalance } from "@shared/asset-value";
import { getUserToday, DEFAULT_TIMEZONE } from "@shared/timezone";
import type { IStorage } from "./storage";

/** How a payment behaves against the balance. */
export type LiabilityPaymentType =
  | "standard" | "partial" | "custom" | "extra_principal"
  | "payoff" | "skipped" | "deferred" | "reversal";

export interface LiabilityPaymentInput {
  amount: number;
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
  payment: any;
  /** The liability profile as it stands after the payment. */
  liability: any;
  newBalance: number;
  principal: number;
  interest: number;
  /** True when this was a recurring bill: a charge logged, no balance moved. */
  recurring: boolean;
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
  if (Math.max(0, balance - principal) === 0 && amount > 0) return "payoff";
  if (monthlyPayment > 0 && Math.abs(amount - monthlyPayment) < 1) return "standard";
  if (monthlyPayment > 0 && amount < monthlyPayment && amount > 0) return "partial";
  if (monthlyPayment > 0 && amount > monthlyPayment) return "custom";
  return "standard";
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
  if (isRecurringBill(fields.subtype ?? (liability as any).type_key ?? (liability as any).typeKey)) {
    const payment = await storage.createLiabilityPayment({
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
    const nextDue = advanceLiabilityDueDate(fields, todayISO);
    const updated = await storage.updateProfile(liability.id, {
      fields: {
        ...fields,
        dueDate: nextDue,
        nextDueDate: nextDue,
        lastPaidDate: paymentDate,
        status: "upcoming",
      },
    } as any);
    return { payment, liability: updated ?? liability, newBalance: 0, principal: amount, interest: 0, recurring: true };
  }

  // ── Amortizing / revolving / one-time debt ──────────────────────────────
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
  if (paymentType === "skipped" || paymentType === "deferred") {
    newBalance = balanceBefore;
    principal = 0;
    interest = 0;
  } else if (paymentType === "reversal") {
    newBalance = balanceBefore + amount;
    principal = -principal;
    interest = -interest;
  } else if (paymentType === "payoff") {
    principal = balanceBefore;
    interest = Math.max(0, cashTowardLoan - balanceBefore);
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

  const payment = await storage.createLiabilityPayment({
    liabilityProfileId: liability.id,
    paymentDate,
    amount,
    principalPortion: principal,
    interestPortion: interest,
    fees: fees + escrow,
    remainingBalanceAfter: balanceBefore > 0 ? newBalance : undefined,
    paymentType,
    sourceAccount: input.sourceAccount || null,
    notes: input.notes || null,
  } as any);

  // Persist the new balance under EVERY name the app reads it by. Writing only
  // `currentBalance` (what the AI path did) left the liability card, the
  // dashboard and net worth reading a different field — and therefore a
  // different, pre-payment number.
  let updated = liability;
  if (balanceBefore > 0 && paymentType !== "skipped" && paymentType !== "deferred") {
    updated = (await storage.updateProfile(liability.id, {
      fields: {
        ...fields,
        currentBalance: newBalance,
        remainingBalance: newBalance,
        loanBalance: newBalance,
        lastPaidDate: paymentDate,
      },
    } as any)) ?? liability;
  }

  return { payment, liability: updated, newBalance, principal, interest, recurring: false };
}
