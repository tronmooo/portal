// Registry-driven forms (profile_type_definitions.field_schema) render every
// numeric field as an <input type="number"> whose change event carries a
// STRING. The dialog used to save that string as the field value, so a
// vehicle's year or mileage was stored as "12500" while the same field edited
// elsewhere was stored as 12500 (D264). Coerce by the schema, at submit.

import { isRecurringBill } from "./liability-types";
import { advanceLiabilityDueDate } from "./liability-recurrence";

export interface RegistryFieldDef { key: string; type?: string }

const NUMERIC_TYPES = new Set(["number", "currency", "percentage"]);

/** A number for a numeric field whose value parses (money punctuation tolerated); the raw value otherwise. */
export function coerceRegistryFieldValue(type: string | undefined, raw: unknown): unknown {
  if (!type || !NUMERIC_TYPES.has(type)) return raw;
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (trimmed === "") return raw;
  // "$12.99/mo", "12.99 per month", "120/yr": the cadence suffix is not part
  // of the number (the field's own frequency carries the cadence).
  const bare = trimmed.replace(/\s*(\/|per\s+)\s*(mo|month|monthly|yr|year|yearly|wk|week|weekly|day|daily)\.?$/i, "");
  const n = Number(bare.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : raw;
}

/** The submitted field map with every numeric schema field coerced (unknown keys untouched). */
export function coerceRegistryFields(schema: RegistryFieldDef[] | null | undefined, fields: Record<string, unknown>): Record<string, unknown> {
  const byKey = new Map((schema || []).map((f) => [f.key, f.type] as const));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = coerceRegistryFieldValue(byKey.get(k), v);
  return out;
}

/**
 * Registry schemas name their fields in snake_case (monthly_payment,
 * current_balance, due_date_day…) while the liability, asset and calendar
 * model reads camelCase keys (monthlyAmount, balance, dueDay…). A loan created
 * through the registry dialog therefore had no payment schedule, no calendar
 * rows and a blank "next payment" (D265). Fold the registry spelling into the
 * model's key at write time; the model key wins when both are present, and
 * the snake_case copy is dropped so later edits cannot diverge.
 */
export const REGISTRY_KEY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["monthly_payment", "monthlyAmount"],
  ["minimum_payment", "minimumPayment"],
  ["current_balance", "balance"],
  ["loan_balance", "balance"],
  ["original_balance", "originalAmount"],
  ["original_amount", "originalAmount"],
  ["interest_rate", "interestRate"],
  ["loan_term_months", "termMonths"],
  ["due_date_day", "dueDay"],
  ["credit_limit", "creditLimit"],
  ["extra_payment", "extraPayment"],
  ["current_value", "value"],
  ["estimated_value", "value"],
  ["appraised_value", "value"],
  ["current_market_value", "value"],
  ["purchase_price", "purchasePrice"],
  ["purchase_date", "purchaseDate"],
  ["next_billing_date", "dueDate"],
  ["renewal_date", "renewalDate"],
  ["date_of_birth", "birthday"],
];

const isBlank = (v: unknown) => v === undefined || v === null || v === "";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const hasDueDate = (f: Record<string, any>) =>
  [f.dueDate, f.nextDueDate, f.firstPaymentDate, f.renewalDate, f.due_date, f.next_due_date].some((v) => ISO_DAY.test(String(v || "").slice(0, 10)))
  || Number.isFinite(parseInt(String(f.dueDay ?? ""), 10));

/**
 * The field map with every registry alias folded into the model key (see
 * REGISTRY_KEY_ALIASES). With `ctx`, a recurring bill whose registry form gave
 * a billing start date but no due date (the registry's utility, membership and
 * subscription schemas have `start_date` and `frequency` only) is anchored on
 * that start date and rolled to its first occurrence on or after today, so
 * the schedule, the calendar and the bills list see the same date the classic
 * form would have stored (D266).
 */
export function canonicalizeRegistryFields<T extends Record<string, any>>(fields: T, ctx?: { typeKey?: string | null; todayISO?: string }): T {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return fields;
  const out: Record<string, any> = { ...fields };
  const startDate = String(out.start_date ?? out.startDate ?? "").slice(0, 10);
  if (ctx?.typeKey && ctx.todayISO && isRecurringBill(ctx.typeKey) && ISO_DAY.test(startDate) && !hasDueDate(out)) {
    const anchored = { ...out, firstPaymentDate: startDate, dueDate: startDate };
    const next = advanceLiabilityDueDate(anchored, ctx.todayISO);
    const due = startDate >= ctx.todayISO ? startDate : next;
    out.firstPaymentDate = startDate;
    out.dueDate = due;
    out.nextDueDate = due;
  }
  for (const [alias, canonical] of REGISTRY_KEY_ALIASES) {
    if (!(alias in out)) continue;
    const v = out[alias];
    delete out[alias];
    if (isBlank(v)) continue;
    if (isBlank(out[canonical])) out[canonical] = v;
  }
  // A bill's due date is also its next due date when nothing else says so.
  if (!isBlank(out.dueDate) && isBlank(out.nextDueDate) && "next_billing_date" in fields) out.nextDueDate = out.dueDate;
  return out as T;
}

const NUMERIC_MODEL_KEYS = new Set([
  "value", "balance", "originalAmount", "monthlyAmount", "minimumPayment", "interestRate", "termMonths", "dueDay",
  "creditLimit", "extraPayment", "purchasePrice", "amount", "monthlyPayment", "currentBalance", "originalBalance",
]);
// Money keys are cents: a balance typed as 1000.004 was stored as typed and
// every reader carried the third decimal (D286). Rates and counts stay as is.
const MONEY_MODEL_KEYS = new Set([
  "value", "balance", "originalAmount", "monthlyAmount", "minimumPayment", "creditLimit", "extraPayment",
  "purchasePrice", "amount", "monthlyPayment", "currentBalance", "originalBalance",
]);
// Round half up on the decimal digits the user typed: 555.555 → 555.56 (the
// binary value sits just below .555, so a plain Math.round went down).
const toCents = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Number(`${Math.round(Number(`${n}e2`))}e-2`) : n);

/**
 * Every door a profile comes through — the routes, a backup restore, the chat
 * tools, a script — ends in the storage layer, so this is where a profile's
 * fields take their one stored form: registry aliases folded into the model
 * keys (D265), a recurring bill anchored on its start date (D266), and the
 * model's numeric keys stored as numbers even when a form or an old backup
 * sent numerals in strings (D264/D267). Unparseable text is left as typed
 * for the validators to refuse.
 */
export function prepareProfileFields<T extends Record<string, any>>(fields: T, ctx?: { typeKey?: string | null; todayISO?: string }): T {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return fields;
  const out: Record<string, any> = canonicalizeRegistryFields(liftLegacySubscriptionGroup(fields), ctx);
  for (const k of Object.keys(out)) {
    if (NUMERIC_MODEL_KEYS.has(k)) out[k] = coerceRegistryFieldValue("number", out[k]);
    if (MONEY_MODEL_KEYS.has(k)) out[k] = toCents(out[k]);
  }
  return out as T;
}


/**
 * An older subscription form stored its facts under a nested `subscriptions`
 * group; the bills projection reads the top level. Lift the group's known
 * keys to the model keys the top level lacks (the group itself is kept for
 * the profile page's nested renderer). D268, legacy shape.
 */
export function liftLegacySubscriptionGroup<T extends Record<string, any>>(fields: T): T {
  const g = (fields as any)?.subscriptions;
  if (!g || typeof g !== "object" || Array.isArray(g)) return fields;
  const out: Record<string, any> = { ...fields };
  const blank = (v: unknown) => v === undefined || v === null || v === "";
  if (blank(out.amount) && blank(out.monthlyAmount) && !blank(g.cost)) out.amount = coerceRegistryFieldValue("currency", g.cost);
  if (blank(out.frequency) && !blank(g.frequency)) out.frequency = g.frequency;
  if (blank(out.renewalDate) && blank(out.dueDate) && !blank(g.renewalDate)) out.renewalDate = g.renewalDate;
  if (blank(out.dueDate) && blank(out.renewalDate) && !blank(g.nextBillingDate)) { out.dueDate = g.nextBillingDate; out.nextDueDate = g.nextBillingDate; }
  for (const k of ["provider", "plan"]) if (blank(out[k]) && !blank(g[k])) out[k] = g[k];
  return out as T;
}
