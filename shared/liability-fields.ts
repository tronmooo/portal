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

/**
 * The marker that says the stored rate IS a percent. Without it a stored rate
 * has to be guessed (`normalizeAnnualRate`: 1 or less is a decimal), and the
 * guess cannot represent a rate under 1%: a 0.9% promo APR typed into the
 * loan-terms form was stored as 90 and the header read "APR 90.00%"
 * (2026-11-20). Every writer that knows its unit stamps this key beside the
 * rate (`storedRateFields`); the storage layer stamps it on any liability
 * rate that arrives without it (`stampRateUnit`), so rows converge on one
 * unit as they are written. `_`-prefixed, so no surface lists it as a field.
 */
export const RATE_UNIT_KEY = "_interestRateUnit";

const parseRate = (r: unknown): number => {
  const n = typeof r === "string" ? parseFloat(r.replace("%", "").trim()) : Number(r);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

/** True when the record states its rate is stored as a percent. */
export function rateIsMarkedPercent(input: Fields | { fields?: Fields }): boolean {
  return fieldsOf(input)[RATE_UNIT_KEY] === "percent";
}

/** The annual rate as a DECIMAL (0.065) — what the amortization engine takes. */
export function readAnnualRate(input: Fields | { fields?: Fields }): number {
  const raw = readInterestRateRaw(input);
  if (rateIsMarkedPercent(input)) {
    const n = parseRate(raw);
    return Number.isFinite(n) ? n / 100 : 0;
  }
  return normalizeAnnualRate(raw);
}

/**
 * The fields a writer stores for a rate it knows is a PERCENT — what a "%"
 * form field holds, exactly as typed: 0.9 is 0.9%, 7 is 7%. `{}` when the
 * input is not a rate.
 */
export function storedRateFields(pct: string | number | null | undefined): Record<string, any> {
  if (pct == null || String(pct).trim() === "") return {};
  const n = parseRate(pct);
  if (!Number.isFinite(n)) return {};
  return { interestRate: Math.round(n * 1e6) / 1e6, [RATE_UNIT_KEY]: "percent" };
}

/**
 * The PERCENT a chat tool's rate means. The model may pass a percent (5.5) or
 * a fraction (0.055), so a value of 1 or less is read as a fraction — unless
 * the user's own message states that very number as a percentage ("0.9%",
 * "0.9 percent"), in which case it is the percent they typed. NaN when the
 * input is not a rate.
 */
export function chatRatePct(value: unknown, userMessage?: unknown): number {
  const n = parseRate(value);
  if (!Number.isFinite(n)) return NaN;
  if (n > 1) return Math.round(n * 1e6) / 1e6;
  const stated = Array.from(String(userMessage ?? "").matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi)).map((m) => Number(m[1]));
  if (n > 0 && stated.includes(n)) return n;
  return Math.round(n * 100 * 1e6) / 1e6;
}

/**
 * A liability's fields with the rate's unit made explicit. A rate that
 * arrives WITHOUT the marker (a chat tool passing 0.065, an old row being
 * rewritten, an import) gets the legacy guess once — 1 or less is a decimal —
 * and is stored as a percent with the marker, so it is never guessed again.
 * A rate that already carries the marker is left exactly as written.
 */
export function stampRateUnit<T extends Record<string, any>>(fields: T): T {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return fields;
  if (fields[RATE_UNIT_KEY] === "percent") return fields;
  if (isBlank(fields.interestRate)) return fields;
  const n = parseRate(fields.interestRate);
  if (!Number.isFinite(n)) return fields;
  return { ...fields, interestRate: Math.round(normalizeAnnualRate(n) * 100 * 1e6) / 1e6, [RATE_UNIT_KEY]: "percent" };
}

/** The annual rate as a PERCENT (6.5) — the canonical stored form and the display form. */
export function readInterestRatePct(input: Fields | { fields?: Fields }): number {
  return Math.round(readAnnualRate(input) * 100 * 1e6) / 1e6;
}

/**
 * What a rate typed into a "%" field means, as the PERCENT that is stored:
 * "6.25" → 6.25, "0.9" → 0.9. Store it with `storedRateFields` so the unit
 * marker goes with it. null when the input is not a rate.
 */
export function rateInputToStoredPct(input: string | number | null | undefined): number | null {
  // A "%" field holds a percent, exactly as typed. This used to run the
  // "1 or less is a fraction" guess, which turned a typed 0.9 into 90.
  const stored = storedRateFields(input);
  return typeof stored.interestRate === "number" ? stored.interestRate : null;
}

/** The stored rate as the text a "%" field shows: "6.25" for 6.25% however it was stored; "" when none. */
export function rateInputValue(input: Fields | { fields?: Fields }): string {
  const pct = readInterestRatePct(input);
  return pct > 0 ? String(pct) : "";
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

/**
 * What a chat debt tool was asked to save, under the keys the record stores
 * them by — the "requested" side of the save receipt (shared/field-receipt).
 * The confirmation for a loan used to be the model's own prose, which is how
 * a 22.9% APR was reported as 22.99%: the receipt is read back from the
 * record instead, so the reply can only say what was stored.
 */
export function liabilityReceiptFields(
  tool: "create_liability" | "update_liability",
  input: Record<string, any> | null | undefined,
): Record<string, any> {
  const src: Record<string, any> = tool === "update_liability" ? (input?.changes || {}) : (input || {});
  const out: Record<string, any> = {};
  const set = (key: string, value: unknown) => { if (value !== undefined && value !== null && value !== "") out[key] = value; };
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };
  set("balance", num(src.currentBalance ?? src.balance));
  set("originalBalance", num(src.originalBalance));
  for (const k of ["annualRate", "annualInterestRate", "interestRate", "apr"]) {
    if (src[k] == null) continue;
    const pct = chatRatePct(src[k], input?.__userMessage);
    if (Number.isFinite(pct)) set("interestRate", pct);
    break;
  }
  for (const k of ["monthlyPayment", "minimumPayment", "creditLimit", "remainingTermMonths", "termMonths", "dueDay"]) set(k, num(src[k]));
  for (const k of ["lender", "firstPaymentDate"]) set(k, typeof src[k] === "string" ? src[k].trim() : undefined);
  return out;
}
