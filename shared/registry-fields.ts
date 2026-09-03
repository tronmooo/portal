// Registry-driven forms (profile_type_definitions.field_schema) render every
// numeric field as an <input type="number"> whose change event carries a
// STRING. The dialog used to save that string as the field value, so a
// vehicle's year or mileage was stored as "12500" while the same field edited
// elsewhere was stored as 12500 (D264). Coerce by the schema, at submit.

export interface RegistryFieldDef { key: string; type?: string }

const NUMERIC_TYPES = new Set(["number", "currency", "percentage"]);

/** A number for a numeric field whose value parses (money punctuation tolerated); the raw value otherwise. */
export function coerceRegistryFieldValue(type: string | undefined, raw: unknown): unknown {
  if (!type || !NUMERIC_TYPES.has(type)) return raw;
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (trimmed === "") return raw;
  const n = Number(trimmed.replace(/[$,%\s]/g, ""));
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

/** The field map with every registry alias folded into the model key (see REGISTRY_KEY_ALIASES). */
export function canonicalizeRegistryFields<T extends Record<string, any>>(fields: T): T {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return fields;
  const out: Record<string, any> = { ...fields };
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
