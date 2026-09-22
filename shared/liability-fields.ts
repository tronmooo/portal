// shared/liability-fields.ts — THE readers for a liability's money fields.
//
// Rule 11 (2026-09-22): one field has one canonical source. A loan's APR was
// 6% on the detail page and 0.1% in chat because each surface probed the
// alias spellings in its own order (`annualInterestRate ?? apr ?? interestRate`
// on one page, `interestRate || rate || apr` on another) and a record that
// carried two spellings answered differently depending on who asked.
//
// Canonical spellings (see shared/profile-field-canon header):
//   interestRate (percent)  balance  monthlyPayment  originalBalance  dueDate
//
// Every reader below starts from the canonical key, then walks the aliases
// the writers still produce (legacy rows, nested `finance` / `loan` groups
// the AI used to write) in ONE fixed order. Nothing else in client/ or shared/
// may spell out these chains — tests/no-inline-liability-field-chains.test.ts
// scans for them.
//
// Pure, dependency-light (asset-value for the balance walk, extraction-
// normalize for dates). Returns plain values; no logging, no I/O.

import { parseMoney, resolveLiabilityBalance } from "./asset-value";
import { normalizeDateString } from "./extraction-normalize";

type Fields = Record<string, any> | null | undefined;

/** A profile row or a bare fields object — every reader accepts both. */
function fieldsOf(input: any): Record<string, any> {
  if (!input || typeof input !== "object") return {};
  if ("fields" in input && input.fields && typeof input.fields === "object") return input.fields;
  return input;
}

const groupsOf = (f: Record<string, any>) => ({
  finance: f.finance && typeof f.finance === "object" ? f.finance : {},
  loan: f.loan && typeof f.loan === "object" ? f.loan : {},
  other: f.other && typeof f.other === "object" ? f.other : {},
});

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/**
 * Normalize an APR-ish input to a DECIMAL rate (0.065). Accepts 6.5, "6.5%",
 * 0.065. Values above 1 are read as percent. This is the one converter; the
 * amortization engine (shared/liability-calc) imports it from here.
 */
export function normalizeAnnualRate(r: number | string | undefined | null): number {
  if (r == null || r === "") return 0;
  const n = typeof r === "string" ? parseFloat(r.replace("%", "").trim()) : Number(r);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? n / 100 : n;
}

/** The precedence every rate reader walks — canonical spelling first. */
export const INTEREST_RATE_KEYS: readonly string[] = [
  "interestRate", "interest_rate",
  "annualInterestRate", "annual_interest_rate", "annualRate", "annual_rate",
  "loanRate", "loan_rate", "annualInterest", "annual_interest", "noteRate", "note_rate",
  "apr", "rate",
];

/**
 * The stored rate value exactly as written (number or string), or null. The
 * top-level canonical key wins; nested `finance.*` / `loan.*` are legacy.
 */
export function readInterestRateRaw(input: Fields | { fields?: Fields }): number | string | null {
  const f = fieldsOf(input);
  const { finance, loan } = groupsOf(f);
  for (const src of [f, finance, loan]) {
    for (const k of INTEREST_RATE_KEYS) {
      const v = src[k];
      if (isBlank(v)) continue;
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && /\d/.test(v)) return v;
    }
  }
  return null;
}

/** The annual rate as a DECIMAL (0.065) — what the amortization engine takes. */
export function readAnnualRate(input: Fields | { fields?: Fields }): number {
  return normalizeAnnualRate(readInterestRateRaw(input));
}

/** The annual rate as a PERCENT (6.5) — the canonical stored form and the display form. */
export function readInterestRatePct(input: Fields | { fields?: Fields }): number {
  return Math.round(readAnnualRate(input) * 100 * 1e6) / 1e6;
}

/**
 * Amount still owed. Delegates to shared/asset-value `resolveLiabilityBalance`
 * (the walk the net-worth model, the chat and the detail page already share),
 * which accepts a profile or a fields object.
 */
export function readBalance(input: Fields | { fields?: Fields }): number {
  return resolveLiabilityBalance(input);
}

/** The precedence every payment reader walks — canonical spelling first. */
export const MONTHLY_PAYMENT_KEYS: readonly string[] = [
  "monthlyPayment", "monthly_payment",
  "monthlyAmount", "monthly_amount",
  "paymentAmount", "payment_amount", "regularPayment", "scheduledPayment", "installmentAmount",
  "amount", "monthlyCost", "monthly_cost", "cost",
  "minimumPayment", "minimum_payment", "min_payment",
];

/**
 * The scheduled per-period payment: `monthlyPayment`, then `monthlyAmount`
 * (the spelling the registry fold used to produce), then the bill spellings
 * (`amount`, `cost`), then the card minimum. 0 when nothing names one.
 */
export function readMonthlyPayment(input: Fields | { fields?: Fields }): number {
  const f = fieldsOf(input);
  const { finance, loan, other } = groupsOf(f);
  for (const src of [f, finance, loan, other]) {
    for (const k of MONTHLY_PAYMENT_KEYS) {
      const v = src[k];
      if (isBlank(v)) continue;
      const n = parseMoney(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return 0;
}

/** The original / opening debt, or 0. */
export function readOriginalBalance(input: Fields | { fields?: Fields }): number {
  const f = fieldsOf(input);
  const { finance, loan } = groupsOf(f);
  for (const src of [f, finance, loan]) {
    for (const k of ["originalBalance", "original_balance", "originalAmount", "original_amount", "originalPrincipal", "loanAmount", "originalLoanAmount", "principal"]) {
      const v = src[k];
      if (isBlank(v)) continue;
      const n = parseMoney(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return 0;
}

/**
 * The precedence for the STORED due date — most deliberate first. This is
 * what shared/liability-schedule `resolveLiabilityDueDate` and the Tier-1 chat
 * answer read. The bill series anchor (`readDueDate` in liability-recurrence)
 * keeps `dueDate` first because the pay path advances that key; the two agree
 * whenever the record is consistent, and shared/entity-integrity reports a
 * `schedule_conflict` when it is not.
 */
export const STORED_DUE_DATE_KEYS: readonly string[] = [
  "nextPaymentDate", "next_payment_date", "nextPayment", "next_payment",
  "nextDueDate", "next_due_date",
  "dueDate", "due_date",
  "firstPaymentDate", "first_payment_date",
  "renewalDate", "renewal_date",
];

/** The first stored due-date spelling that PARSES, as YYYY-MM-DD, or null. */
export function readStoredDueDate(input: Fields | { fields?: Fields }): string | null {
  const f = fieldsOf(input);
  for (const k of STORED_DUE_DATE_KEYS) {
    const iso = normalizeDateString(f[k]);
    if (iso) return iso;
  }
  return null;
}

/** Which stored key `readStoredDueDate` answered from, or null. */
export function storedDueDateKey(input: Fields | { fields?: Fields }): string | null {
  const f = fieldsOf(input);
  for (const k of STORED_DUE_DATE_KEYS) {
    if (normalizeDateString(f[k])) return k;
  }
  return null;
}
