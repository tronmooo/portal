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
//
// BNPL / financing plans belong here: "$60/month until the $1,200 is paid off"
// is an installment schedule, not a one-off balance. They were missing, so
// every Affirm/Klarna/store-financing row fell through to `one_time` and got a
// SINGLE payment date instead of a monthly series — which is why a financing
// plan showed up on the calendar as one lone bill with no recurring rule
// behind it (`isRecurringRule` sees "once" and drops it from Recurring Dates).
const AMORTIZING = new Set([
  "mortgage", "auto_loan", "car_loan", "heloc", "student_loan",
  "personal_loan", "business_loan", "boat_loan", "rv_loan", "loan",
  "bnpl", "financing", "installment", "installment_plan", "installment_loan",
]);

// Revolving credit: balance vs limit, utilization, minimum + statement.
const REVOLVING = new Set(["credit_card", "line_of_credit", "credit_line"]);

// One-time debt paid down over time, no fixed amortization schedule.
const ONE_TIME = new Set(["medical_debt", "medical", "tax_debt", "collection", "judgment"]);

// Recurring service bills — a monthly amount + a due date, no permanent balance.
const RECURRING = new Set([
  "utility", "utility_plan", "phone_plan", "internet", "streaming", "software",
  "gym_membership", "parking", "storage_unit", "cloud_storage", "meal_kit",
  "box_subscription", "professional_membership", "bill", "subscription",
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
