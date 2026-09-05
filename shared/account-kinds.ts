// Financial account KINDS — the classification half of the accounts model.
//
// Deliberately tiny and dependency-free: `shared/asset-value.ts` imports it to
// decide whether a `type: "account"` profile is an asset or a debt, and
// `shared/finance-accounts.ts` imports it for everything else. Keeping the
// classification here is what breaks the cycle between those two modules.
//
// WHY THE ASSET/DEBT SPLIT MATTERS: an account profile stores its balance in
// `fields.balance`, and BOTH resolveAssetValue and resolveLiabilityBalance read
// that key. Without a kind-aware split, one credit card with a $2,000 balance
// would add $2,000 to assets AND $2,000 to debts — a $4,000 net-worth error
// from a single row.

export type AccountKind =
  | "checking"
  | "savings"
  | "money_market"
  | "cd"
  | "cash"
  | "credit_card"
  | "investment"
  | "brokerage"
  | "retirement"
  | "crypto"
  | "hsa"
  | "education"
  | "loan"
  | "line_of_credit"
  | "other";

/**
 * Which Asset Profile LAYOUT a kind gets. A kind's layout decides what its
 * profile page and dashboard card emphasize:
 *   bank        balance, deposits/withdrawals, balance history
 *   investment  portfolio value, performance over periods, holdings, allocation
 *   crypto      positions, token pricing, transfers
 *   cash        balance only — physical cash has no institution and no history worth charting
 *   debt        amount owed, credit limit, utilization (the liabilities side)
 */
export type FinancialLayout = "bank" | "investment" | "crypto" | "cash" | "debt";

export interface AccountKindMeta {
  key: AccountKind;
  label: string;
  /** Balance-sheet side. Debt kinds subtract from net worth. */
  side: "asset" | "debt";
  /** Rolled-up bucket for the Accounts summary row. */
  group: "cash" | "investment" | "credit" | "loan" | "other";
  /** Kinds where an "available balance" is a real, distinct number. */
  supportsAvailable: boolean;
  /** Kinds where a credit limit (and therefore utilization) applies. */
  supportsCreditLimit: boolean;
  /** Kinds that hold spendable cash — the Cash on hand figure. */
  isLiquid: boolean;
  icon: string;
  /** Which adaptive Asset Profile layout this kind renders with. */
  layout: FinancialLayout;
}

export const ACCOUNT_KINDS: ReadonlyArray<AccountKindMeta> = [
  // ── Money held: bank-style containers ──────────────────────────────────────
  { key: "checking",       label: "Checking",               side: "asset", group: "cash",       supportsAvailable: true,  supportsCreditLimit: false, isLiquid: true,  icon: "wallet",             layout: "bank" },
  { key: "savings",        label: "Savings",                side: "asset", group: "cash",       supportsAvailable: true,  supportsCreditLimit: false, isLiquid: true,  icon: "piggy-bank",         layout: "bank" },
  { key: "money_market",   label: "Money market",           side: "asset", group: "cash",       supportsAvailable: true,  supportsCreditLimit: false, isLiquid: true,  icon: "piggy-bank",         layout: "bank" },
  // A CD is cash that is locked up: it counts as cash on the balance sheet but
  // is not spendable until maturity, so it is not liquid.
  { key: "cd",             label: "Certificate of deposit", side: "asset", group: "cash",       supportsAvailable: false, supportsCreditLimit: false, isLiquid: false, icon: "landmark",           layout: "bank" },
  { key: "cash",           label: "Cash",                   side: "asset", group: "cash",       supportsAvailable: false, supportsCreditLimit: false, isLiquid: true,  icon: "banknote",           layout: "cash" },
  // ── Money held: invested containers ────────────────────────────────────────
  { key: "investment",     label: "Investment",             side: "asset", group: "investment", supportsAvailable: true,  supportsCreditLimit: false, isLiquid: false, icon: "trending-up",        layout: "investment" },
  { key: "brokerage",      label: "Brokerage",              side: "asset", group: "investment", supportsAvailable: true,  supportsCreditLimit: false, isLiquid: false, icon: "trending-up",        layout: "investment" },
  { key: "retirement",     label: "Retirement",             side: "asset", group: "investment", supportsAvailable: false, supportsCreditLimit: false, isLiquid: false, icon: "trending-up",        layout: "investment" },
  { key: "crypto",         label: "Crypto",                 side: "asset", group: "investment", supportsAvailable: false, supportsCreditLimit: false, isLiquid: false, icon: "bitcoin",            layout: "crypto" },
  { key: "hsa",            label: "Health savings (HSA)",   side: "asset", group: "investment", supportsAvailable: true,  supportsCreditLimit: false, isLiquid: false, icon: "heart-pulse",        layout: "investment" },
  { key: "education",      label: "Education savings",      side: "asset", group: "investment", supportsAvailable: false, supportsCreditLimit: false, isLiquid: false, icon: "graduation-cap",     layout: "investment" },
  // ── Money owed ─────────────────────────────────────────────────────────────
  { key: "credit_card",    label: "Credit card",            side: "debt",  group: "credit",     supportsAvailable: true,  supportsCreditLimit: true,  isLiquid: false, icon: "credit-card",        layout: "debt" },
  { key: "line_of_credit", label: "Line of credit",         side: "debt",  group: "credit",     supportsAvailable: true,  supportsCreditLimit: true,  isLiquid: false, icon: "credit-card",        layout: "debt" },
  { key: "loan",           label: "Loan account",           side: "debt",  group: "loan",       supportsAvailable: false, supportsCreditLimit: false, isLiquid: false, icon: "landmark",           layout: "debt" },
  { key: "other",          label: "Other",                  side: "asset", group: "other",      supportsAvailable: false, supportsCreditLimit: false, isLiquid: false, icon: "circle-dollar-sign", layout: "bank" },
];

const BY_KEY = new Map<string, AccountKindMeta>(ACCOUNT_KINDS.map((k) => [k.key, k]));

export function accountKindMeta(kind: AccountKind): AccountKindMeta {
  return BY_KEY.get(kind) ?? BY_KEY.get("other")!;
}

/**
 * Free-text (registry type_key, AI input, import label, a statement's own
 * wording) → a canonical kind.
 *
 * This is the exact-label half of classification: "roth_ira" IS a retirement
 * account, no inference needed. Reading a kind out of a NAME or an institution
 * ("Fidelity Brokerage", "Coinbase") is `classifyAccountKind` in
 * shared/financial-assets.ts, which calls this first and only then reasons
 * from context.
 */
export function normalizeAccountKind(input?: string | null): AccountKind {
  const s = String(input ?? "").trim().toLowerCase().replace(/[\s\-/]+/g, "_");
  if (!s) return "other";
  if (BY_KEY.has(s)) return s as AccountKind;
  if (["chequing", "current", "debit", "bank", "bank_account", "depository", "checking_account"].includes(s)) return "checking";
  if (["saving", "hysa", "high_yield_savings", "savings_account", "emergency_fund"].includes(s)) return "savings";
  if (["mma", "money_market_account", "money_market_fund"].includes(s)) return "money_market";
  if (["certificate_of_deposit", "cds", "time_deposit", "term_deposit", "gic"].includes(s)) return "cd";
  if (["wallet", "petty_cash", "physical_cash", "cash_on_hand"].includes(s)) return "cash";
  if (["credit", "card", "visa", "mastercard", "amex", "charge_card"].includes(s)) return "credit_card";
  if (["brokerage_account", "taxable_brokerage", "stocks", "stock_account", "securities", "trading", "trading_account"].includes(s)) return "brokerage";
  if (["401k", "401_k", "403b", "403_b", "457", "457b", "ira", "roth", "roth_ira", "traditional_ira", "sep_ira", "simple_ira", "rollover_ira", "retirement_401k", "retirement_account", "pension", "tsp", "rrsp", "superannuation", "annuity"].includes(s)) return "retirement";
  if (["cryptocurrency", "crypto_wallet", "bitcoin", "btc", "ethereum", "eth", "coin", "coins", "token", "tokens", "digital_asset", "digital_assets", "defi"].includes(s)) return "crypto";
  if (["health_savings", "health_savings_account", "fsa", "hra"].includes(s)) return "hsa";
  if (["529", "529_plan", "five29_plan", "college_fund", "college_savings", "coverdell", "esa", "utma", "ugma", "custodial", "education_savings"].includes(s)) return "education";
  if (["investments", "investment_account", "portfolio", "fund", "mutual_fund", "index_fund", "etf", "bond", "bonds", "angel_investment"].includes(s)) return "investment";
  if (["heloc", "credit_line", "loc", "revolving_credit"].includes(s)) return "line_of_credit";
  if (["mortgage", "auto_loan", "car_loan", "student_loan", "personal_loan", "loan_account", "installment_loan"].includes(s)) return "loan";
  return "other";
}

/** The account kind of a `type: "account"` profile (or of a bare fields object). */
export function accountKindOf(input: any): AccountKind {
  if (!input) return "other";
  const fields = (typeof input === "object" && "fields" in input && input.fields) ? input.fields : input;
  const raw =
    fields?.accountKind ?? fields?.account_kind ??
    fields?.accountType ?? fields?.account_type ??
    input?.type_key ?? input?.typeKey ??
    fields?.subtype ?? fields?.kind;
  const resolved = normalizeAccountKind(raw);
  // A `type: "investment"` profile IS an investment account, whatever its
  // fields say. "Roth IRA" in accountType normalizes to "other" on its own —
  // the profile TYPE is the more reliable signal, so it wins over a miss.
  if (resolved === "other" && String(input?.type ?? "") === "investment") return "investment";
  return resolved;
}

/** The adaptive layout an account profile renders with. */
export function accountLayoutOf(input: any): FinancialLayout {
  return accountKindMeta(accountKindOf(input)).layout;
}

/** True when this account's balance is money OWED rather than money HELD. */
export function isDebtAccountKind(kind: AccountKind): boolean {
  return accountKindMeta(kind).side === "debt";
}

/** True when the profile is an account whose balance is debt. */
export function isDebtAccount(profile: any): boolean {
  return isDebtAccountKind(accountKindOf(profile));
}
