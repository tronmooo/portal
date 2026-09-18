// Behavioral classification of liability subtypes (profile.type_key).
//
// The DB registry (profile_type_definitions) already defines the FIELDS for each
// liability type; this file adds the BEHAVIOR the detail page, calculations,
// payment logic, and net-worth rollup branch on. A mortgage amortizes, a credit
// card revolves, a phone bill just recurs — they must not share one layout/calc.
//
// Pure + dependency-free so client, server, and tests share one definition.

export type LiabilityFamily = "amortizing" | "revolving" | "one_time" | "recurring";

// Long-term installment debt: fixed payment, APR, payoff schedule, linked asset.
const AMORTIZING = new Set([
  "mortgage", "auto_loan", "car_loan", "heloc", "student_loan",
  "personal_loan", "business_loan", "boat_loan", "rv_loan", "loan",
]);

// Revolving credit: balance vs limit, utilization, minimum + statement.
const REVOLVING = new Set(["credit_card", "line_of_credit", "credit_line"]);

// One-time debt paid down over time, no fixed amortization schedule.
const ONE_TIME = new Set(["medical_debt", "medical", "tax_debt", "collection", "judgment"]);

// Recurring service bills — a monthly amount + a due date, no permanent balance.
const RECURRING = new Set([
  "utility", "phone_plan", "internet", "streaming", "software",
  "gym_membership", "parking", "storage_unit", "cloud_storage", "meal_kit",
  "box_subscription", "professional_membership", "bill", "subscription",
  // Premiums, rent and dues are recurring service bills: a monthly amount and a
  // due date, no balance to pay down. They used to fall through to "one_time",
  // which meant paying one moved a fictional balance and — because only
  // recurring bills log an expense (server/liability-payments.ts §4) — wrote no
  // expense at all. That is why an Auto Insurance payment existed with no
  // matching expense while a streaming payment had one, and monthly spend
  // depended on which kind of bill you happened to pay.
  "insurance", "insurance_premium", "auto_insurance", "car_insurance",
  "home_insurance", "homeowners_insurance", "renters_insurance",
  "health_insurance", "dental_insurance", "life_insurance", "pet_insurance",
  "umbrella_insurance", "rent", "hoa", "hoa_dues", "childcare", "tuition_plan",
]);

/**
 * Classify a liability by its registry `type_key`. Unknown / missing keys default
 * to "amortizing" only when there's clear loan intent; otherwise treat generic
 * liabilities as one_time (they still count toward net worth but don't fabricate
 * an amortization schedule — this is what fixed the $0.17/360-month bug).
 */
export function liabilityFamily(typeKey?: string | null): LiabilityFamily {
  const k = String(typeKey || "").toLowerCase();
  if (AMORTIZING.has(k)) return "amortizing";
  if (REVOLVING.has(k)) return "revolving";
  if (RECURRING.has(k)) return "recurring";
  if (ONE_TIME.has(k)) return "one_time";
  // Unknown subtype: a plain "liability" with no loan signals is treated as a
  // one-time balance, NOT amortized over a fabricated 360-month term.
  return "one_time";
}

/** Families whose current balance is real balance-sheet debt (counts in Net Worth). */
export const NET_WORTH_LIABILITY_FAMILIES: ReadonlySet<LiabilityFamily> = new Set([
  "amortizing", "revolving", "one_time",
] as LiabilityFamily[]);

/** True when this liability's balance should count toward the Net Worth debt total. */
export function countsTowardNetWorth(typeKey?: string | null): boolean {
  return NET_WORTH_LIABILITY_FAMILIES.has(liabilityFamily(typeKey));
}

/** Only amortizing/revolving families run the amortization payoff schedule. */
export function isAmortizable(typeKey?: string | null): boolean {
  const fam = liabilityFamily(typeKey);
  return fam === "amortizing" || fam === "revolving";
}

/** Recurring service bills advance a due date on payment instead of reducing a balance. */
export function isRecurringBill(typeKey?: string | null): boolean {
  return liabilityFamily(typeKey) === "recurring";
}

/**
 * The profile-level test every bills reader uses. A `subscription`-typed
 * profile saved by an older door carries no subtype at all; classifying by
 * the subtype alone left those rows off the bills list, the bell and the
 * daily cron while the calendar (which reads the type) still showed them
 * (D268). No subtype on a subscription means "a subscription".
 */
export function isRecurringBillProfile(p: { type?: string | null; type_key?: string | null; typeKey?: string | null } | null | undefined): boolean {
  if (!p) return false;
  const key = (p as any).type_key ?? (p as any).typeKey;
  if (key) return isRecurringBill(key);
  return String(p.type || "").toLowerCase() === "subscription";
}

/**
 * The bill/loan pairing name rule: "Car Loan payment" and "Car Loan" are the
 * same debt under two records. Used by the storage upsert (so a bill created
 * beside a loan records which one it pays) and by the payment path (so a bill
 * whose link was never written can still be paired to its loan).
 */
export function normalizeLiabilityName(n: string): string {
  return String(n || "").toLowerCase().replace(/\s+(bill\s+)?payments?$/i, "").replace(/\s+/g, " ").trim();
}

/** True for a name spelled as a debt's payment bill ("… payment", "… bill payment"). */
export function isPaymentBillName(n: string): boolean {
  return /\s+(bill\s+)?payments?$/i.test(String(n || ""));
}

type Pairable = { id?: string; name?: string | null; type?: string | null; type_key?: string | null; typeKey?: string | null; parentProfileId?: string | null; fields?: any };

/**
 * True when `bill` is the payment bill OF `debt`: a recurring bill that
 * records the loan/card in `fields.linkedLiabilityId`, or — for the bills the
 * older doors wrote with no link — one named "<debt name> payment". The same
 * two signals the pay path resolves the serviced debt from (server/
 * liability-payments resolveServicedDebt), so a bill and a loan are paired
 * the same way whether money is moving or a list is being drawn.
 */
export function isPaymentBillOf(bill: Pairable | null | undefined, debt: Pairable | null | undefined): boolean {
  if (!bill || !debt || !bill.id || !debt.id || bill.id === debt.id) return false;
  const billType = String(bill.type || "").toLowerCase();
  if (billType !== "liability" && billType !== "loan" && billType !== "subscription") return false;
  // A record that names its subtype must be a recurring bill; a lite row
  // (id/name/type only, as the profiles index lists) is judged by name.
  const billKey = (bill as any).type_key ?? (bill as any).typeKey;
  if (billKey && !isRecurringBill(billKey)) return false;
  if (debt.type !== "liability" && debt.type !== "loan") return false;
  if (isRecurringBillProfile(debt)) return false;
  const linked = bill.fields?.linkedLiabilityId;
  if (typeof linked === "string" && linked) return linked === debt.id;
  if (!isPaymentBillName(String(bill.name || ""))) return false;
  const target = normalizeLiabilityName(String(bill.name || ""));
  return !!target && normalizeLiabilityName(String(debt.name || "")) === target;
}

/** The recurring bills that pay `debt` — its payment history lives on them. */
export function billsServicingDebt<T extends Pairable>(profiles: readonly T[] | null | undefined, debt: Pairable | null | undefined): T[] {
  return (profiles || []).filter((p) => isPaymentBillOf(p, debt));
}

/**
 * True when `bill` is the payment bill of a debt that is itself in `profiles`
 * — the case where a list of liabilities would show the same loan twice.
 */
export function isPaymentBillOfListedDebt(bill: Pairable | null | undefined, profiles: readonly Pairable[] | null | undefined): boolean {
  if (!bill) return false;
  return (profiles || []).some((p) => isPaymentBillOf(bill, p));
}
