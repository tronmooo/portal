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
 * True when a profile row is REAL DEBT — an explicit debt subtype, or a
 * liability carrying loan terms (a balance owed, an APR, an original amount).
 *
 * The guard that keeps a loan a loan. Creating a recurring bill upserts by
 * normalized name, and that normalization drops a trailing "payment" — so the
 * calendar entry for a loan ("… Auto Loan payment") resolves to the loan
 * itself. Without this check that upsert rewrote the row's type_key to "bill",
 * which moved it into the recurring family: the detail page swapped the loan
 * layout for the bill layout (principal, original amount, APR, term and the
 * amortization schedule all disappeared) and net worth stopped counting the
 * balance. The terms were still in the row the whole time — nothing could read
 * them. Callers use this to patch such a row's schedule WITHOUT touching its
 * subtype or its terms.
 *
 * Fields are inspected as well as the subtype because a debt created before
 * subtypes existed (or one the AI left as a generic "liability") is still debt.
 */
export function isDebtLiability(profile: {
  type?: string | null;
  type_key?: string | null;
  typeKey?: string | null;
  fields?: Record<string, any> | null;
} | null | undefined): boolean {
  if (!profile) return false;
  const type = String(profile.type || "").toLowerCase();
  if (type && type !== "liability" && type !== "loan") return false;
  const key = String(profile.type_key ?? profile.typeKey ?? "").toLowerCase();
  // An explicit recurring subtype is a bill, full stop — a $20 streaming plan
  // with a stray "balance" must not be promoted into a loan.
  if (RECURRING.has(key)) return false;
  // Any other subtype the registry knows (mortgage, credit_card, medical_debt…)
  // is debt by definition. Note liabilityFamily() answers "one_time" for keys
  // it does NOT know, so an unknown key has to fall through to the fields.
  if (AMORTIZING.has(key) || REVOLVING.has(key) || ONE_TIME.has(key)) return true;
  const f = profile.fields || {};
  const num = (v: any) => {
    const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.\-]/g, "")) : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return (
    num(f.currentBalance ?? f.current_balance) > 0 ||
    num(f.originalBalance ?? f.original_balance ?? f.originalAmount ?? f.principal) > 0 ||
    num(f.annualInterestRate ?? f.annual_interest_rate ?? f.interestRate ?? f.apr) > 0 ||
    num(f.creditLimit ?? f.credit_limit) > 0
  );
}

// ─── Recovering a loan that was already written as a bill ────────────────────
//
// The demotion above ran in production before it was guarded, so rows exist
// whose `type_key` says "bill" while their fields plainly describe a loan. The
// guard stops NEW damage; it can't repair what is already stored. Those rows
// render the bill layout — no principal, no original amount, no APR, no term,
// no amortization — and drop out of net worth, and they stay that way until
// something rewrites them.
//
// So the read path recovers them. The evidence below is deliberately narrow:
// an APR, an original loan amount, a contract term, or a payoff date. A phone
// plan, a streaming subscription or a utility bill has none of these — it has a
// monthly amount and a due date and nothing else. Requiring loan-only evidence
// (rather than, say, a non-zero balance) is what keeps a genuine bill a bill.

/** Loan-only evidence: things a recurring service bill never carries. */
function hasLoanTerms(fields: Record<string, any> | null | undefined): boolean {
  const f = fields || {};
  const num = (v: any) => {
    const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.\-]/g, "")) : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return (
    num(f.annualInterestRate ?? f.annual_interest_rate ?? f.interestRate ?? f.apr) > 0 ||
    num(f.originalBalance ?? f.original_balance ?? f.originalAmount ?? f.principal) > 0 ||
    num(f.termMonths ?? f.term_months ?? f.loanTermMonths ?? f.remainingTermMonths) > 0 ||
    num(f.creditLimit ?? f.credit_limit) > 0 ||
    !!f.payoffDate || !!f.payoff_date || !!f.maturityDate || !!f.loanStartDate
  );
}

/** Name/field patterns → the debt subtype they imply. Ordered: first match wins. */
const SUBTYPE_HINTS: Array<[RegExp, string]> = [
  [/\bheloc\b|home equity/, "heloc"],
  [/\bmortgage\b|home loan|house loan/, "mortgage"],
  [/\b(auto|car|truck|vehicle|motorcycle|boat|rv|camper)\s*loan\b|\bauto\s*financ/, "auto_loan"],
  [/\bstudent\s*loan|sallie mae|nelnet|navient|mohela|fedloan/, "student_loan"],
  [/credit card|\bvisa\b|mastercard|\bamex\b|american express|discover/, "credit_card"],
  [/\bmedical\b|hospital|dental|surgery/, "medical_debt"],
  [/\birs\b|tax debt|back taxes/, "tax_debt"],
  [/affirm|klarna|afterpay|sezzle/, "bnpl"],
  [/\bbusiness\s*loan|\bsba\b/, "business_loan"],
  [/personal\s*loan/, "personal_loan"],
];

/**
 * The debt subtype a demoted row should be read as, or null when the row is a
 * genuine recurring bill and must be left alone.
 *
 * Read-only: this does NOT write. It lets the detail page draw the loan the
 * user entered, and lets net worth count the balance again, while the stored
 * `type_key` stays whatever it is until a real save corrects it.
 */
export function recoveredDebtSubtype(profile: {
  name?: string | null;
  type?: string | null;
  type_key?: string | null;
  typeKey?: string | null;
  fields?: Record<string, any> | null;
} | null | undefined): string | null {
  if (!profile) return null;
  const type = String(profile.type || "").toLowerCase();
  if (type !== "liability" && type !== "loan") return null;
  const key = String(profile.type_key ?? profile.typeKey ?? "").toLowerCase();
  // Only rows currently classified as recurring are candidates — everything
  // else is already being read correctly.
  if (!RECURRING.has(key)) return null;
  if (!hasLoanTerms(profile.fields)) return null;

  const f = profile.fields || {};
  // A subtype stashed in the fields blob is the most direct evidence.
  const stashed = String(f.subtype ?? f.type_key ?? f.liabilityType ?? "").toLowerCase();
  if (AMORTIZING.has(stashed) || REVOLVING.has(stashed) || ONE_TIME.has(stashed)) return stashed;

  // The NAME is matched on its own first. Folding the lender in alongside it
  // let "Capital Auto Finance" turn a row named "Sallie Mae Student Loan" into
  // an auto loan — the lender is a weaker signal and only gets consulted when
  // the name says nothing at all.
  const name = String(profile.name || "").toLowerCase();
  for (const [re, subtype] of SUBTYPE_HINTS) if (re.test(name)) return subtype;
  const lender = String(f.lender || "").toLowerCase();
  if (lender) for (const [re, subtype] of SUBTYPE_HINTS) if (re.test(lender)) return subtype;

  // No name signal: a credit limit means revolving, otherwise treat it as a
  // plain installment loan — both are honest, and both beat "bill".
  const limit = Number(f.creditLimit ?? f.credit_limit);
  return Number.isFinite(limit) && limit > 0 ? "credit_card" : "loan";
}

/** The subtype a liability should be READ as — recovering a demoted loan. */
export function effectiveLiabilitySubtype(profile: {
  name?: string | null;
  type?: string | null;
  type_key?: string | null;
  typeKey?: string | null;
  fields?: Record<string, any> | null;
} | null | undefined): string {
  return recoveredDebtSubtype(profile)
    ?? String(profile?.type_key ?? profile?.typeKey ?? "");
}
