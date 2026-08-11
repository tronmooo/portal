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
  | "cash"
  | "credit_card"
  | "investment"
  | "loan"
  | "line_of_credit"
  | "other";

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
}

export const ACCOUNT_KINDS: ReadonlyArray<AccountKindMeta> = [
  { key: "checking",       label: "Checking",           side: "asset", group: "cash",       supportsAvailable: true,  supportsCreditLimit: false, isLiquid: true,  icon: "wallet" },
  { key: "savings",        label: "Savings",            side: "asset", group: "cash",       supportsAvailable: true,  supportsCreditLimit: false, isLiquid: true,  icon: "piggy-bank" },
  { key: "cash",           label: "Cash",               side: "asset", group: "cash",       supportsAvailable: false, supportsCreditLimit: false, isLiquid: true,  icon: "banknote" },
  { key: "investment",     label: "Investment / brokerage", side: "asset", group: "investment", supportsAvailable: true, supportsCreditLimit: false, isLiquid: false, icon: "trending-up" },
  { key: "credit_card",    label: "Credit card",        side: "debt",  group: "credit",     supportsAvailable: true,  supportsCreditLimit: true,  isLiquid: false, icon: "credit-card" },
  { key: "line_of_credit", label: "Line of credit",     side: "debt",  group: "credit",     supportsAvailable: true,  supportsCreditLimit: true,  isLiquid: false, icon: "credit-card" },
  { key: "loan",           label: "Loan account",       side: "debt",  group: "loan",       supportsAvailable: false, supportsCreditLimit: false, isLiquid: false, icon: "landmark" },
  { key: "other",          label: "Other",              side: "asset", group: "other",      supportsAvailable: false, supportsCreditLimit: false, isLiquid: false, icon: "circle-dollar-sign" },
];

const BY_KEY = new Map<string, AccountKindMeta>(ACCOUNT_KINDS.map((k) => [k.key, k]));

export function accountKindMeta(kind: AccountKind): AccountKindMeta {
  return BY_KEY.get(kind) ?? BY_KEY.get("other")!;
}

/** Free-text (registry type_key, AI input, import label) → a canonical kind. */
export function normalizeAccountKind(input?: string | null): AccountKind {
  const s = String(input ?? "").trim().toLowerCase().replace(/[\s\-/]+/g, "_");
  if (!s) return "other";
  if (BY_KEY.has(s)) return s as AccountKind;
  if (["chequing", "current", "debit", "bank", "bank_account", "depository"].includes(s)) return "checking";
  if (["saving", "hysa", "high_yield_savings", "money_market", "cd", "emergency_fund"].includes(s)) return "savings";
  if (["wallet", "petty_cash", "physical_cash", "cash_on_hand"].includes(s)) return "cash";
  if (["credit", "card", "visa", "mastercard", "amex", "charge_card"].includes(s)) return "credit_card";
  if (["brokerage", "investments", "retirement", "401k", "ira", "roth_ira", "hsa", "crypto", "securities"].includes(s)) return "investment";
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
  return normalizeAccountKind(raw);
}

/** True when this account's balance is money OWED rather than money HELD. */
export function isDebtAccountKind(kind: AccountKind): boolean {
  return accountKindMeta(kind).side === "debt";
}

/** True when the profile is an account whose balance is debt. */
export function isDebtAccount(profile: any): boolean {
  return isDebtAccountKind(accountKindOf(profile));
}
