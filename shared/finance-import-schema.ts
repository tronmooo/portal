// shared/finance-import-schema.ts
//
// The STRICT contract for the "Import from ChatGPT" feature. This is the single
// source of truth for:
//   - what JSON ChatGPT must return (the prompt is generated from this shape),
//   - how Portol validates a pasted payload (detailed, field-level errors),
//   - how records are de-duplicated (a stable transaction hash),
//   - how external categories normalize into Portol's internal taxonomy.
//
// Design notes
// ------------
// * Pure module (no I/O, no server imports) so it runs identically in the
//   browser (paste-time validation) and on the server (authoritative re-check)
//   and can be unit-tested without a DB.
// * Forgiving at the TOP level (unknown sections are ignored, not rejected) but
//   STRICT inside each known record shape — that's where bad data causes silent
//   corruption, so that's where we refuse and report exactly what's wrong.
// * "Source" entities only. Portol computes net worth / cash flow / dashboards /
//   AI insights from expenses, obligations, incomes, budgets and asset/liability
//   profiles — so the importer writes those and everything else recomputes.
// * Built behind a generic shape so future sources (CSV, Plaid, PDF) can produce
//   the same internal records without changing the dashboard.

import { z } from "zod";
import { canonicalIncomeFrequency } from "./obligation-windows";

export const FINANCE_IMPORT_SCHEMA_VERSION = "1.0";
export const FINANCE_IMPORT_SOURCE = "chatgpt_import";

// ── Field primitives ────────────────────────────────────────────────────────
const money = z
  .number({ invalid_type_error: "amount must be a number" })
  .finite("amount must be a finite number");
// A real calendar day, not merely the shape of one: "2026-02-30" passed the
// regex, was planned as "create", and then blew up the commit halfway
// through the writes ("Invalid date or time value") with the rows already
// written and no batch record to undo them with.
const realDay = (v: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, "date must be in YYYY-MM-DD format")
  .refine(realDay, "date must be a real calendar day");
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO code, e.g. USD");
const confidence = z
  .number()
  .min(0, "confidence must be between 0 and 1")
  .max(1, "confidence must be between 0 and 1");

// ── Record shapes ───────────────────────────────────────────────────────────
// Every transactional record carries the common envelope the spec requires:
// unique_id, date, amount, currency, merchant, category, confidence, notes,
// source. `.strict()` rejects typo'd / unexpected keys so malformed rows surface
// instead of being silently dropped.

export const importTransactionSchema = z
  .object({
    unique_id: z.string().min(1, "unique_id is required"),
    date: isoDate,
    amount: money.refine((n) => n >= 0, "amount must be >= 0 (use `type` for direction)"),
    currency: currency.default("USD"),
    merchant: z.string().min(1, "merchant is required"),
    category: z.string().default("general"),
    account: z.string().optional().default(""),
    type: z.enum(["expense", "income", "transfer"]).default("expense"),
    confidence: confidence.optional().default(0.8),
    notes: z.string().optional().default(""),
    source: z.string().optional().default(FINANCE_IMPORT_SOURCE),
  })
  .strict();

/**
 * A cadence spelled the way people write it ("fortnightly", "every 2 weeks",
 * "bi-weekly") folds onto the import's enum through the app's one cadence
 * canon; a spelling the canon does not know still fails with the enum's
 * message naming the field.
 */
const IMPORT_CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "yearly", "once"] as const;
const importCadence = z.preprocess(
  (v) => (typeof v === "string" ? (canonicalIncomeFrequency(v) ?? v) : v),
  z.enum(IMPORT_CADENCES),
).default("monthly");

export const importAccountSchema = z
  .object({
    unique_id: z.string().min(1, "unique_id is required"),
    name: z.string().min(1, "account name is required"),
    type: z.enum(["checking", "savings", "credit_card", "cash", "brokerage", "other"]).default("other"),
    balance: money.default(0),
    currency: currency.default("USD"),
    confidence: confidence.optional().default(0.8),
    notes: z.string().optional().default(""),
  })
  .strict();

const recurringBase = {
  unique_id: z.string().min(1, "unique_id is required"),
  name: z.string().min(1, "name is required"),
  amount: money.refine((n) => n >= 0, "amount must be >= 0"),
  currency: currency.default("USD"),
  frequency: importCadence,
  category: z.string().default("general"),
  next_due_date: isoDate.optional(),
  account: z.string().optional().default(""),
  confidence: confidence.optional().default(0.8),
  notes: z.string().optional().default(""),
};
export const importSubscriptionSchema = z.object(recurringBase).strict();
export const importRecurringBillSchema = z.object(recurringBase).strict();

export const importIncomeSchema = z
  .object({
    unique_id: z.string().min(1, "unique_id is required"),
    source_name: z.string().min(1, "source_name is required"),
    amount: money.refine((n) => n >= 0, "amount must be >= 0"),
    currency: currency.default("USD"),
    frequency: importCadence,
    category: z.string().default("salary"),
    date: isoDate.optional(),
    confidence: confidence.optional().default(0.8),
    notes: z.string().optional().default(""),
  })
  .strict();

const holdingBase = {
  unique_id: z.string().min(1, "unique_id is required"),
  name: z.string().min(1, "name is required"),
  value: money,
  currency: currency.default("USD"),
  category: z.string().optional().default("general"),
  confidence: confidence.optional().default(0.8),
  notes: z.string().optional().default(""),
};
export const importAssetSchema = z.object(holdingBase).strict();
export const importLiabilitySchema = z.object({ ...holdingBase, value: money.refine((n) => n >= 0, "liability value must be >= 0") }).strict();
export const importInvestmentSchema = z
  .object({ ...holdingBase, symbol: z.string().optional().default("") })
  .strict();

export const importBudgetSchema = z
  .object({
    unique_id: z.string().min(1, "unique_id is required"),
    category: z.string().min(1, "category is required"),
    amount: money.refine((n) => n >= 0, "budget amount must be >= 0"),
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/, "month must be in YYYY-MM format")
      .optional(),
    currency: currency.default("USD"),
    notes: z.string().optional().default(""),
  })
  .strict();

// ── Top-level payload ───────────────────────────────────────────────────────
// Top level is intentionally non-strict: extra advisory sections ChatGPT may add
// (cash_flow, monthly_summary, ai_insights, categories, merchant_information)
// are accepted and stored for reference but Portol recomputes its own — they are
// never written as authoritative finance rows.
export const financeImportSchema = z.object({
  version: z.string().optional(),
  generated_at: z.string().optional(),
  base_currency: currency.optional(),
  accounts: z.array(importAccountSchema).optional().default([]),
  transactions: z.array(importTransactionSchema).optional().default([]),
  subscriptions: z.array(importSubscriptionSchema).optional().default([]),
  recurring_bills: z.array(importRecurringBillSchema).optional().default([]),
  income: z.array(importIncomeSchema).optional().default([]),
  assets: z.array(importAssetSchema).optional().default([]),
  liabilities: z.array(importLiabilitySchema).optional().default([]),
  investments: z.array(importInvestmentSchema).optional().default([]),
  budgets: z.array(importBudgetSchema).optional().default([]),
  // Advisory / informational — accepted, not written as authoritative rows.
  cash_flow: z.any().optional(),
  categories: z.any().optional(),
  merchant_information: z.any().optional(),
  monthly_summary: z.any().optional(),
  ai_insights: z.any().optional(),
});

export type FinanceImportPayload = z.infer<typeof financeImportSchema>;
export type ImportTransaction = z.infer<typeof importTransactionSchema>;
export type ImportAccount = z.infer<typeof importAccountSchema>;
export type ImportSubscription = z.infer<typeof importSubscriptionSchema>;
export type ImportRecurringBill = z.infer<typeof importRecurringBillSchema>;
export type ImportIncome = z.infer<typeof importIncomeSchema>;
export type ImportAsset = z.infer<typeof importAssetSchema>;
export type ImportLiability = z.infer<typeof importLiabilitySchema>;
export type ImportInvestment = z.infer<typeof importInvestmentSchema>;
export type ImportBudget = z.infer<typeof importBudgetSchema>;

export interface ImportValidationError {
  /** Dotted path to the offending field, e.g. "transactions[3].amount". */
  path: string;
  message: string;
}

export interface ImportValidationResult {
  ok: boolean;
  data?: FinanceImportPayload;
  errors: ImportValidationError[];
  /** Total count of importable records across all known sections. */
  recordCount: number;
}

/** Strip ```json fences / leading prose ChatGPT sometimes adds despite being
 *  told not to, and return the first balanced JSON object. Returns the raw
 *  string unchanged if no fence/object boundary is found. */
export function extractJsonBlock(text: string): string {
  if (!text) return "";
  let s = text.trim();
  // Remove a leading ```json or ``` fence and trailing fence.
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  // If there is still prose around it, grab the outermost {...}.
  if (s[0] !== "{") {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
  }
  return s;
}

function zodIssuesToErrors(issues: z.ZodIssue[]): ImportValidationError[] {
  return issues.map((i) => ({
    path: i.path
      .map((p, idx) => (typeof p === "number" ? `[${p}]` : idx === 0 ? p : `.${p}`))
      .join(""),
    message: i.message,
  }));
}

function countRecords(d: FinanceImportPayload): number {
  return (
    d.accounts.length +
    d.transactions.length +
    d.subscriptions.length +
    d.recurring_bills.length +
    d.income.length +
    d.assets.length +
    d.liabilities.length +
    d.investments.length +
    d.budgets.length
  );
}

/**
 * Validate raw pasted text against the strict schema. Never throws — returns a
 * structured result with exact, field-level errors so the UI can show the user
 * precisely what ChatGPT got wrong and refuse the import.
 */
export function validateFinanceImport(rawText: string): ImportValidationResult {
  const cleaned = extractJsonBlock(rawText);
  if (!cleaned) {
    return { ok: false, errors: [{ path: "", message: "Nothing to import — paste the JSON ChatGPT returned." }], recordCount: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e: any) {
    return {
      ok: false,
      errors: [{ path: "", message: `Not valid JSON: ${e?.message || "parse error"}. Make sure you pasted the entire response with no extra text.` }],
      recordCount: 0,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: [{ path: "", message: "Top level must be a JSON object with sections like \"transactions\"." }], recordCount: 0 };
  }
  const result = financeImportSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, errors: zodIssuesToErrors(result.error.issues), recordCount: 0 };
  }
  // Cross-record check: duplicate unique_ids WITHIN the payload are a hard error
  // (they make idempotency/dedup ambiguous).
  const dupErrors = findDuplicateUniqueIds(result.data);
  if (dupErrors.length > 0) {
    return { ok: false, data: result.data, errors: dupErrors, recordCount: countRecords(result.data) };
  }
  return { ok: true, data: result.data, errors: [], recordCount: countRecords(result.data) };
}

function findDuplicateUniqueIds(d: FinanceImportPayload): ImportValidationError[] {
  const errors: ImportValidationError[] = [];
  const sections: Array<[string, Array<{ unique_id: string }>]> = [
    ["accounts", d.accounts],
    ["transactions", d.transactions],
    ["subscriptions", d.subscriptions],
    ["recurring_bills", d.recurring_bills],
    ["income", d.income],
    ["assets", d.assets],
    ["liabilities", d.liabilities],
    ["investments", d.investments],
    ["budgets", d.budgets],
  ];
  for (const [name, rows] of sections) {
    const seen = new Set<string>();
    rows.forEach((r, idx) => {
      if (seen.has(r.unique_id)) {
        errors.push({ path: `${name}[${idx}].unique_id`, message: `Duplicate unique_id "${r.unique_id}" within ${name}.` });
      }
      seen.add(r.unique_id);
    });
  }
  return errors;
}

// ── Dedup hashing ───────────────────────────────────────────────────────────
/** Normalize a merchant/string for hashing & matching: lowercase, collapse
 *  whitespace, strip punctuation noise. */
export function normalizeMerchant(s: string | undefined | null): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable transaction fingerprint used for duplicate detection:
 *  date + normalized merchant + amount + account. Two transactions with the
 *  same fingerprint are considered the same charge. */
export function transactionHash(t: {
  date: string;
  merchant: string;
  amount: number;
  account?: string;
}): string {
  const date = (t.date || "").slice(0, 10);
  const merchant = normalizeMerchant(t.merchant);
  const amount = Math.round(Number(t.amount) * 100); // cents, avoids float drift
  const account = normalizeMerchant(t.account || "");
  return `${date}|${merchant}|${amount}|${account}`;
}

// ── Category normalization ──────────────────────────────────────────────────
// Map ChatGPT's free-form / spec categories onto Portol's internal
// ExpenseCategory taxonomy so downstream budgets/charts stay consistent.
const CATEGORY_MAP: Record<string, string> = {
  food: "food", "food & drink": "food", dining: "food", groceries: "food", restaurant: "food", restaurants: "food",
  housing: "housing", rent: "housing", mortgage: "housing", home: "housing",
  utilities: "utilities", utility: "utilities", electric: "utilities", electricity: "utilities", water: "utilities", gas_bill: "utilities", internet: "utilities",
  transport: "transport", transportation: "transport", gas: "transport", fuel: "transport", rideshare: "transport", parking: "transport", transit: "transport",
  automotive: "automotive", auto: "automotive", car: "automotive", vehicle: "vehicle",
  insurance: "insurance",
  medical: "health", health: "health", healthcare: "health", pharmacy: "health",
  entertainment: "entertainment", streaming: "entertainment", games: "entertainment",
  shopping: "shopping", retail: "shopping", clothing: "shopping",
  subscription: "subscription", subscriptions: "subscription",
  education: "education", tuition: "education",
  travel: "travel", flights: "travel", hotel: "travel", hotels: "travel",
  pet: "pet", pets: "pet",
  taxes: "general", tax: "general", transfers: "general", transfer: "general",
  investments: "general", investment: "general", income: "general",
  personal: "personal", unknown: "general", other: "general", general: "general",
};

/** Normalize an arbitrary category string to a Portol ExpenseCategory. Unknown
 *  values fall back to "general" so nothing is ever dropped on a bad label. */
export function normalizeCategory(raw: string | undefined | null): string {
  const key = (raw || "").trim().toLowerCase();
  return CATEGORY_MAP[key] || "general";
}
