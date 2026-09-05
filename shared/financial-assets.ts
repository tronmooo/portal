// ── Financial assets: the universal layer over money-holding accounts ────────
//
// THE PRINCIPLE (the top line of the implementation spec):
//
//   Any account whose primary purpose is to hold, preserve, or invest monetary
//   value represents an ASSET and receives a canonical Asset Profile. Income
//   describes money ENTERING the user's financial system; it is not itself an
//   asset. Each asset subtype may define its own data capabilities, history
//   model, and adaptive interface while remaining part of the same global
//   asset and net-worth system.
//
// So: a checking account, savings account, brokerage, IRA, 401(k), crypto
// wallet, cash, CD, HSA, money market or 529 is an asset profile. Salary,
// wages, dividends and reimbursements are income (money flowing IN). A credit
// card, loan or mortgage is a liability. A deposit, a stock purchase, a
// dividend or a statement is ACTIVITY INSIDE an asset — never a new asset.
//
// This module is pure (no I/O, no React, no DB) and owns:
//   1. classification — which kind an account is, inferred from CONTEXT (name,
//      institution, description) when nobody said so outright;
//   2. capabilities — which data each kind carries, so a checking account is
//      never asked to render holdings and a brokerage never shows a credit limit;
//   3. balance snapshots — timestamped observations of value, first-class and
//      never overwritten, so "$10,000 → $10,500" keeps both points;
//   4. holdings + investment activity — the investment dashboard's data;
//   5. provenance — where each field came from and who wins on disagreement;
//   6. the money-mention ontology the AI chat follows (income vs. asset vs.
//      transfer vs. activity).
//
// The account profile's `fields` gain these keys (all optional, all owned here):
//   balanceSnapshots    BalanceSnapshot[]       value observations, oldest first
//   holdings            Holding[]               current positions (investment/crypto)
//   investmentActivity  InvestmentActivity[]    contributions, buys, dividends…
//   fieldSources        Record<field, FieldSource>  provenance per field
//   connection          AccountConnection        the API/source link, when any
//
// Pinned by tests/financial-assets.test.ts.

import {
  ACCOUNT_KINDS, accountKindMeta, accountKindOf, isDebtAccountKind, normalizeAccountKind,
  type AccountKind, type FinancialLayout,
} from "./account-kinds";
export type { AccountKind, FinancialLayout };
import { isAccountProfile, resolveAccountBalance, balanceHistory, type BalanceAdjustment } from "./finance-accounts";

export const FINANCIAL_ASSET_PRINCIPLE =
  "Any account whose primary purpose is to hold, preserve, or invest monetary value represents an asset " +
  "and receives a canonical Asset Profile. Income describes money entering the user's financial system; " +
  "it is not itself an asset. Each asset subtype may define its own data capabilities, history model, " +
  "and adaptive interface while remaining part of the same global asset and net-worth system.";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function fieldsOf(input: any): Record<string, any> {
  if (!input || typeof input !== "object") return {};
  if ("fields" in input && input.fields && typeof input.fields === "object") return input.fields;
  return input;
}

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── 1. Classification ───────────────────────────────────────────────────────

/** True when the profile is a money-HOLDING account: an asset, never a debt. */
export function isFinancialAssetProfile(p: any): boolean {
  return isAccountProfile(p) && !isDebtAccountKind(accountKindOf(p));
}

export type ClassificationConfidence = "high" | "medium" | "low" | "none";

export interface AccountKindClassification {
  kind: AccountKind;
  confidence: ClassificationConfidence;
  /** What the decision rested on, for the confirmation prompt when confidence is low. */
  reason: string;
}

export interface AccountContext {
  /** An explicit kind/subtype from the caller (AI argument, form select, registry type_key). */
  hint?: string | null;
  name?: string | null;
  institution?: string | null;
  /** Free text: a statement's heading, the user's sentence, a document summary. */
  description?: string | null;
  /** Provider-side category words, e.g. Stripe's category/subcategory. */
  providerCategory?: string | null;
  providerSubcategory?: string | null;
}

// Institutions whose NAME alone says what the account is. Order matters only
// for readability; every match is the same confidence.
const INSTITUTION_KINDS: Array<{ re: RegExp; kind: AccountKind }> = [
  { re: /\b(coinbase|kraken|binance|gemini|crypto\.com|bitstamp|ledger|metamask|phantom|trezor|exodus|uniswap|blockfi)\b/i, kind: "crypto" },
  { re: /\b(fidelity|schwab|vanguard|robinhood|e\*?trade|etrade|merrill|td ameritrade|ameritrade|interactive brokers|ibkr|webull|wealthfront|betterment|m1 finance|public\.com|tastytrade|acorns|stash)\b/i, kind: "brokerage" },
  { re: /\b(empower|voya|tiaa|principal financial|transamerica|john hancock|nationwide retirement|guideline|human interest)\b/i, kind: "retirement" },
  { re: /\b(hsa bank|healthequity|lively|optum bank|fidelity hsa)\b/i, kind: "hsa" },
];

// Words INSIDE a name/description that name the kind. Checked most-specific
// first: "Roth IRA brokerage" is a retirement account, "crypto savings" is crypto.
const CONTEXT_KINDS: Array<{ re: RegExp; kind: AccountKind; strength: "high" | "medium" }> = [
  { re: /\b(401\s?\(?k\)?|403\s?\(?b\)?|457\s?\(?b\)?|roth|ira\b|sep[- ]ira|simple ira|rollover|pension|retirement|tsp|rrsp|superannuation|annuity)\b/i, kind: "retirement", strength: "high" },
  { re: /\b(529|coverdell|college (fund|savings)|education savings|utma|ugma|custodial)\b/i, kind: "education", strength: "high" },
  { re: /\b(hsa|health savings|fsa|flexible spending)\b/i, kind: "hsa", strength: "high" },
  { re: /\b(crypto|cryptocurrency|bitcoin|btc|ethereum|eth|solana|sol\b|dogecoin|token|wallet|defi|stablecoin|usdc|usdt)\b/i, kind: "crypto", strength: "high" },
  { re: /\b(certificate of deposit|\bcd\b|time deposit|term deposit|gic)\b/i, kind: "cd", strength: "high" },
  { re: /\b(money market|mma)\b/i, kind: "money_market", strength: "high" },
  { re: /\b(brokerage|trading|stocks?|equities|securities|taxable investment)\b/i, kind: "brokerage", strength: "high" },
  { re: /\b(credit card|visa|mastercard|amex|american express|discover card|charge card)\b/i, kind: "credit_card", strength: "high" },
  { re: /\b(heloc|line of credit|credit line)\b/i, kind: "line_of_credit", strength: "high" },
  { re: /\b(mortgage|auto loan|car loan|student loan|personal loan|loan)\b/i, kind: "loan", strength: "high" },
  { re: /\b(checking|chequing|current account|debit|spending account|everyday)\b/i, kind: "checking", strength: "high" },
  { re: /\b(savings|hysa|high[- ]yield|emergency fund|rainy day)\b/i, kind: "savings", strength: "high" },
  { re: /\b(investment|portfolio|index fund|mutual fund|etf|bonds?)\b/i, kind: "investment", strength: "medium" },
  { re: /\b(cash|petty cash|cash on hand)\b/i, kind: "cash", strength: "medium" },
];

// A plain bank with no other clue is most likely a checking account.
const BANK_RE = /\b(chase|bank of america|bofa|wells fargo|citi|citibank|capital one|ally|marcus|sofi|us bank|pnc|truist|td bank|regions|fifth third|huntington|discover bank|synchrony|navy federal|usaa|credit union|bank)\b/i;

/**
 * Decide an account's kind from CONTEXT, not only from an explicit label.
 *
 * Ladder (first hit wins, confidence attached so the caller can confirm when
 * it is low):
 *   1. an explicit hint that normalizes to a real kind            → high
 *   2. a kind word in the name or description ("Roth IRA")          → high/medium
 *   3. an institution whose business is one kind ("Coinbase")       → medium
 *   4. a provider category (Stripe's cash/investment/credit)        → medium
 *   5. a bank name with nothing else                                → low (checking)
 *   6. nothing                                                      → none ("other")
 *
 * Never guesses a DEBT kind from a bank name alone: an unknown account at a
 * bank is money held until something says otherwise.
 */
export function classifyAccountKind(ctx: AccountContext): AccountKindClassification {
  const hint = String(ctx.hint ?? "").trim();
  if (hint) {
    const k = normalizeAccountKind(hint);
    if (k !== "other") return { kind: k, confidence: "high", reason: `type "${hint}"` };
  }
  const text = [ctx.name, ctx.description].filter(Boolean).join(" · ");
  if (text) {
    for (const rule of CONTEXT_KINDS) {
      const m = rule.re.exec(text);
      if (m) return { kind: rule.kind, confidence: rule.strength, reason: `"${m[0]}" in the name` };
    }
  }
  const inst = String(ctx.institution ?? "").trim();
  const instText = [inst, ctx.name].filter(Boolean).join(" ");
  if (instText) {
    for (const rule of INSTITUTION_KINDS) {
      const m = rule.re.exec(instText);
      if (m) return { kind: rule.kind, confidence: "medium", reason: `${m[0]} is a ${accountKindMeta(rule.kind).label.toLowerCase()} provider` };
    }
  }
  const cat = String(ctx.providerCategory ?? "").toLowerCase();
  const sub = String(ctx.providerSubcategory ?? "").toLowerCase();
  if (sub) {
    const k = normalizeAccountKind(sub);
    if (k !== "other") return { kind: k, confidence: "medium", reason: `provider reports ${sub}` };
  }
  if (cat === "investment") return { kind: "investment", confidence: "medium", reason: "provider reports an investment account" };
  if (cat === "credit") return { kind: "credit_card", confidence: "medium", reason: "provider reports a credit account" };
  if (cat === "cash") return { kind: "checking", confidence: "low", reason: "provider reports a cash account" };
  if (instText && BANK_RE.test(instText)) return { kind: "checking", confidence: "low", reason: `${inst || ctx.name} is a bank` };
  if (hint) return { kind: "other", confidence: "low", reason: `unrecognized type "${hint}"` };
  return { kind: "other", confidence: "none", reason: "nothing in the name or institution says what kind of account this is" };
}

// ─── 2. Capabilities per kind ────────────────────────────────────────────────

export type FinancialCapability =
  | "balance"          // every kind
  | "balanceHistory"   // timestamped snapshots worth charting
  | "cashFlow"         // deposits / withdrawals as the activity model
  | "transactions"     // line-item transactions (bank, card)
  | "holdings"         // positions with quantity and price
  | "allocation"       // asset-class breakdown of the holdings
  | "performance"      // gains/losses against cost basis
  | "contributions"    // contributions / withdrawals (and employer match)
  | "dividends"        // dividend / interest income inside the asset
  | "tokenPricing"     // crypto: price per token, positions
  | "transfers"        // crypto: on-chain transfers in/out
  | "interestRate"     // APY on cash-like accounts
  | "maturity"         // CDs: term and maturity date
  | "creditLimit"      // debt: limit + utilization
  | "employerMatch"    // retirement
  | "beneficiaries";   // retirement / education / HSA

const LAYOUT_CAPABILITIES: Record<FinancialLayout, FinancialCapability[]> = {
  bank: ["balance", "balanceHistory", "cashFlow", "transactions", "interestRate"],
  cash: ["balance", "balanceHistory", "cashFlow"],
  investment: ["balance", "balanceHistory", "holdings", "allocation", "performance", "contributions", "dividends", "transactions"],
  crypto: ["balance", "balanceHistory", "holdings", "allocation", "performance", "tokenPricing", "transfers"],
  debt: ["balance", "balanceHistory", "transactions", "creditLimit"],
};

const KIND_EXTRA_CAPABILITIES: Partial<Record<AccountKind, FinancialCapability[]>> = {
  cd: ["maturity"],
  retirement: ["employerMatch", "beneficiaries"],
  education: ["beneficiaries"],
  hsa: ["beneficiaries"],
};

/** Every capability a kind carries. The UI shows a section only when its capability is present. */
export function capabilitiesForKind(kind: AccountKind): ReadonlySet<FinancialCapability> {
  const meta = accountKindMeta(kind);
  return new Set([...LAYOUT_CAPABILITIES[meta.layout], ...(KIND_EXTRA_CAPABILITIES[kind] ?? [])]);
}

export function hasCapability(profileOrKind: any, cap: FinancialCapability): boolean {
  const kind: AccountKind = typeof profileOrKind === "string"
    ? normalizeAccountKind(profileOrKind)
    : accountKindOf(profileOrKind);
  return capabilitiesForKind(kind).has(cap);
}

/** The kinds the UI offers as money-holding asset types (no debt kinds). */
export const FINANCIAL_ASSET_KINDS: ReadonlyArray<AccountKind> =
  ACCOUNT_KINDS.filter((k) => k.side === "asset").map((k) => k.key);

// ─── 3. Balance snapshots ────────────────────────────────────────────────────

// The snapshot primitives live in a leaf module so finance-accounts.ts can
// append one without importing this file. Re-exported here: this IS the API.
import {
  appendBalanceSnapshot, balanceSnapshots, thinSnapshots, MAX_BALANCE_SNAPSHOTS,
  type BalanceSnapshot, type FinanceDataSource, type SnapshotInput,
} from "./balance-snapshots";
export {
  appendBalanceSnapshot, balanceSnapshots, thinSnapshots, MAX_BALANCE_SNAPSHOTS,
  type BalanceSnapshot, type FinanceDataSource, type SnapshotInput,
};

export interface BalancePoint {
  date: string;
  balance: number;
  source: FinanceDataSource | "adjustment" | "legacy";
}

/**
 * The value series for charting: one point per day, latest observation of the
 * day wins. Merges the three places a value has ever been recorded so a row
 * written before snapshots existed still graphs:
 *   - balanceSnapshots (this module)
 *   - balanceHistory   (the adjustment ledger — each adjustment's newBalance)
 *   - performanceHistory [{date,value}] (legacy investment rows)
 * and finishes with the current balance as of `balanceAsOf` (or today) so the
 * line always ends where the headline number is.
 */
export function balanceSeries(profile: any, todayISO?: string): BalancePoint[] {
  const f = fieldsOf(profile);
  const byDate = new Map<string, { at: string; point: BalancePoint }>();
  const put = (date: string, balance: number, at: string, source: BalancePoint["source"]) => {
    if (!isDay(date) || !Number.isFinite(balance)) return;
    const cur = byDate.get(date);
    if (!cur || at >= cur.at) byDate.set(date, { at, point: { date, balance: round2(Math.abs(balance)), source } });
  };
  const legacy = Array.isArray(f.performanceHistory) ? f.performanceHistory : [];
  for (const p of legacy) {
    const d = String(p?.date ?? "").slice(0, 10);
    put(d, Number(p?.value ?? p?.balance), `${d}T00:00:00.000Z`, "legacy");
  }
  for (const a of balanceHistory(profile)) {
    put(a.date, a.newBalance, a.createdAt || `${a.date}T00:00:01.000Z`, "adjustment");
    // The FIRST adjustment also tells us what the balance was before it.
  }
  // The first adjustment also knows the balance BEFORE it — worth a point only
  // when nothing earlier is recorded, so the line has somewhere to start.
  const adjustments = balanceHistory(profile);
  if (adjustments.length > 0) {
    const first = adjustments[0];
    const before = dayBefore(first.date);
    const earlier = [...byDate.keys()].some((d) => d < first.date);
    if (before && !earlier) put(before, first.previousBalance, `${before}T00:00:00.000Z`, "adjustment");
  }
  for (const s of balanceSnapshots(profile)) put(s.date, s.balance, s.at, s.source);

  const current = resolveAccountBalance(profile);
  const asOfRaw = String(f.balanceAsOf ?? "").slice(0, 10);
  const endDate = isDay(asOfRaw) ? asOfRaw : (todayISO ?? new Date().toISOString().slice(0, 10));
  if (byDate.size > 0 || current > 0) {
    const latest = [...byDate.keys()].sort().pop();
    if (!latest || latest <= endDate) put(endDate, current, "9999-12-31T23:59:59.999Z", "system");
  }
  return [...byDate.values()].map((v) => v.point).sort((a, b) => a.date.localeCompare(b.date));
}

function dayBefore(date: string): string | null {
  if (!isDay(date)) return null;
  const t = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(t.getTime())) return null;
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

export const HISTORY_PERIODS = ["1W", "1M", "3M", "YTD", "1Y", "ALL"] as const;
export type HistoryPeriod = (typeof HISTORY_PERIODS)[number];

export function isHistoryPeriod(v: unknown): v is HistoryPeriod {
  return typeof v === "string" && (HISTORY_PERIODS as readonly string[]).includes(v);
}

/** First day (inclusive) of a period ending on `todayISO`; null for ALL. */
export function periodStart(period: HistoryPeriod, todayISO: string): string | null {
  const t = new Date(`${todayISO}T00:00:00.000Z`);
  if (Number.isNaN(t.getTime())) return null;
  switch (period) {
    case "1W": t.setUTCDate(t.getUTCDate() - 7); break;
    case "1M": t.setUTCMonth(t.getUTCMonth() - 1); break;
    case "3M": t.setUTCMonth(t.getUTCMonth() - 3); break;
    case "1Y": t.setUTCFullYear(t.getUTCFullYear() - 1); break;
    case "YTD": return `${todayISO.slice(0, 4)}-01-01`;
    case "ALL": return null;
  }
  return t.toISOString().slice(0, 10);
}

/** The balance in force on `date`: the latest point on or before it, else the first point. */
export function balanceOn(series: BalancePoint[], date: string): number | null {
  if (series.length === 0) return null;
  let found: BalancePoint | null = null;
  for (const p of series) {
    if (p.date <= date) found = p; else break;
  }
  return (found ?? series[0]).balance;
}

export interface PeriodChange {
  period: HistoryPeriod;
  start: string | null;
  from: number | null;
  to: number | null;
  change: number | null;
  changePct: number | null;
  points: BalancePoint[];
}

/**
 * The series windowed to a period, with the change over it. The window keeps
 * one point BEFORE the start so the line enters the chart at the right height.
 */
export function seriesForPeriod(series: BalancePoint[], period: HistoryPeriod, todayISO: string): PeriodChange {
  const start = periodStart(period, todayISO);
  const to = series.length ? series[series.length - 1].balance : null;
  if (!start) {
    const from = series.length ? series[0].balance : null;
    return { period, start, from, to, ...delta(from, to), points: series };
  }
  const from = balanceOn(series, start);
  const before = [...series].reverse().find((p) => p.date < start);
  const inside = series.filter((p) => p.date >= start);
  const points = before && from != null ? [{ date: start, balance: from, source: before.source }, ...inside] : inside;
  return { period, start, from, to, ...delta(from, to), points };
}

function delta(from: number | null, to: number | null): { change: number | null; changePct: number | null } {
  if (from == null || to == null) return { change: null, changePct: null };
  const change = round2(to - from);
  const changePct = from > 0 ? round2((change / from) * 100) : null;
  return { change, changePct };
}

/** "How much has my Fidelity account increased since January?" */
export function changeSince(profile: any, sinceDate: string, todayISO?: string): { from: number | null; to: number | null; change: number | null; changePct: number | null } {
  const series = balanceSeries(profile, todayISO);
  const from = balanceOn(series, sinceDate);
  const to = series.length ? series[series.length - 1].balance : null;
  return { from, to, ...delta(from, to) };
}

/** Enough history to draw a line at all. */
export function hasChartableHistory(profile: any, todayISO?: string): boolean {
  const s = balanceSeries(profile, todayISO);
  return s.length >= 2 && new Set(s.map((p) => p.balance)).size >= 1;
}

// ─── 4. Holdings and investment activity ─────────────────────────────────────

export type AssetClass = "equity" | "etf" | "fund" | "bond" | "crypto" | "cash" | "real_estate" | "commodity" | "other";

export interface Holding {
  id: string;
  /** Ticker or token symbol, upper-cased ("AAPL", "BTC"). */
  symbol?: string;
  name: string;
  quantity?: number;
  /** Price per unit at `asOf`. */
  price?: number;
  /** Current market value. Required — it is what allocation sums. */
  value: number;
  /** Total amount paid for the position, when known. */
  costBasis?: number;
  assetClass: AssetClass;
  asOf?: string;
  source: FinanceDataSource;
}

export function holdings(input: any): Holding[] {
  const raw = fieldsOf(input).holdings;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h: any) => h && typeof h === "object" && (h.name || h.symbol))
    .map((h: any, i: number) => normalizeHolding(h, i));
}

export function normalizeHolding(h: any, i = 0): Holding {
  const quantity = h.quantity != null && Number.isFinite(Number(h.quantity)) ? Number(h.quantity) : undefined;
  const price = h.price != null && Number.isFinite(Number(h.price)) ? Number(h.price) : undefined;
  const explicit = h.value != null && Number.isFinite(Number(h.value)) ? Number(h.value) : undefined;
  const value = explicit ?? (quantity != null && price != null ? round2(quantity * price) : 0);
  const symbol = h.symbol ? String(h.symbol).trim().toUpperCase() : undefined;
  return {
    id: String(h.id ?? `hold-${i}`),
    ...(symbol ? { symbol } : {}),
    name: String(h.name ?? symbol ?? "Holding"),
    ...(quantity != null ? { quantity } : {}),
    ...(price != null ? { price } : {}),
    value: round2(Math.abs(value)),
    ...(h.costBasis != null && Number.isFinite(Number(h.costBasis)) ? { costBasis: round2(Math.abs(Number(h.costBasis))) } : {}),
    assetClass: normalizeAssetClass(h.assetClass ?? h.class ?? h.type, symbol),
    ...(isDay(String(h.asOf ?? "").slice(0, 10)) ? { asOf: String(h.asOf).slice(0, 10) } : {}),
    source: (h.source ?? "user") as FinanceDataSource,
  };
}

const CRYPTO_SYMBOLS = new Set(["BTC", "ETH", "SOL", "ADA", "DOGE", "XRP", "USDC", "USDT", "LTC", "DOT", "AVAX", "MATIC", "LINK", "BNB"]);

export function normalizeAssetClass(raw: unknown, symbol?: string): AssetClass {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["equity", "etf", "fund", "bond", "crypto", "cash", "real_estate", "commodity", "other"].includes(s)) return s as AssetClass;
  if (["stock", "stocks", "share", "shares", "equities"].includes(s)) return "equity";
  if (["mutual_fund", "index_fund", "funds"].includes(s)) return "fund";
  if (["bonds", "fixed_income", "treasury", "treasuries"].includes(s)) return "bond";
  if (["cryptocurrency", "token", "coin"].includes(s)) return "crypto";
  if (["money_market", "sweep", "cash_equivalent"].includes(s)) return "cash";
  if (["reit", "property"].includes(s)) return "real_estate";
  if (["gold", "silver", "metal", "metals", "oil"].includes(s)) return "commodity";
  if (symbol && CRYPTO_SYMBOLS.has(symbol)) return "crypto";
  return "other";
}

export interface HoldingInput {
  symbol?: string | null;
  name?: string | null;
  quantity?: number | null;
  price?: number | null;
  value?: number | null;
  costBasis?: number | null;
  assetClass?: string | null;
  asOf?: string | null;
  source?: FinanceDataSource;
}

/**
 * Upsert one holding by symbol (or name when there is no symbol). Returns the
 * new array. Setting a position is a REPLACEMENT of that position's figures,
 * not a second row for the same ticker.
 */
export function upsertHolding(existing: any, input: HoldingInput, todayISO?: string): Holding[] {
  const list = Array.isArray(existing) ? existing.map((h: any, i: number) => normalizeHolding(h, i)) : holdings(existing);
  const symbol = input.symbol ? String(input.symbol).trim().toUpperCase() : undefined;
  const name = String(input.name ?? symbol ?? "").trim();
  if (!symbol && !name) return list;
  const idx = list.findIndex((h) => (symbol && h.symbol === symbol) || (!symbol && h.name.toLowerCase() === name.toLowerCase()));
  const prev = idx >= 0 ? list[idx] : null;
  const next = normalizeHolding({
    id: prev?.id ?? newId("hold"),
    symbol: symbol ?? prev?.symbol,
    name: name || prev?.name || symbol,
    quantity: input.quantity ?? prev?.quantity,
    price: input.price ?? prev?.price,
    value: input.value ?? (input.quantity != null || input.price != null ? undefined : prev?.value),
    costBasis: input.costBasis ?? prev?.costBasis,
    assetClass: input.assetClass ?? prev?.assetClass,
    asOf: input.asOf ?? todayISO ?? prev?.asOf,
    source: input.source ?? prev?.source ?? "user",
  });
  const out = [...list];
  if (idx >= 0) out[idx] = next; else out.push(next);
  return out;
}

export function removeHolding(existing: any, idOrSymbol: string): Holding[] {
  const list = Array.isArray(existing) ? existing.map((h: any, i: number) => normalizeHolding(h, i)) : holdings(existing);
  const key = String(idOrSymbol).trim();
  return list.filter((h) => h.id !== key && h.symbol !== key.toUpperCase() && h.name.toLowerCase() !== key.toLowerCase());
}

export interface AllocationSlice { assetClass: AssetClass; value: number; pct: number; count: number }

export function allocationOf(list: Holding[]): AllocationSlice[] {
  const total = list.reduce((s, h) => s + h.value, 0);
  const by = new Map<AssetClass, AllocationSlice>();
  for (const h of list) {
    const cur = by.get(h.assetClass) ?? { assetClass: h.assetClass, value: 0, pct: 0, count: 0 };
    cur.value = round2(cur.value + h.value);
    cur.count += 1;
    by.set(h.assetClass, cur);
  }
  return [...by.values()]
    .map((s) => ({ ...s, pct: total > 0 ? round2((s.value / total) * 100) : 0 }))
    .sort((a, b) => b.value - a.value);
}

export interface GainLoss { value: number; costBasis: number | null; gain: number | null; gainPct: number | null }

/** Unrealized gain across the holdings that HAVE a cost basis. */
export function gainLossOf(list: Holding[]): GainLoss {
  const value = round2(list.reduce((s, h) => s + h.value, 0));
  const withBasis = list.filter((h) => h.costBasis != null);
  if (withBasis.length === 0) return { value, costBasis: null, gain: null, gainPct: null };
  const basis = round2(withBasis.reduce((s, h) => s + (h.costBasis ?? 0), 0));
  const valueWithBasis = round2(withBasis.reduce((s, h) => s + h.value, 0));
  const gain = round2(valueWithBasis - basis);
  return { value, costBasis: basis, gain, gainPct: basis > 0 ? round2((gain / basis) * 100) : null };
}

export function biggestPositions(list: Holding[], n = 5): Array<Holding & { pct: number }> {
  const total = list.reduce((s, h) => s + h.value, 0);
  return [...list].sort((a, b) => b.value - a.value).slice(0, n)
    .map((h) => ({ ...h, pct: total > 0 ? round2((h.value / total) * 100) : 0 }));
}

export type InvestmentActivityKind =
  | "contribution" | "withdrawal"
  | "buy" | "sell"
  | "dividend" | "interest"
  | "fee"
  | "transfer_in" | "transfer_out";

export interface InvestmentActivity {
  id: string;
  date: string;
  kind: InvestmentActivityKind;
  /** Always a positive magnitude; `kind` carries the direction. */
  amount: number;
  symbol?: string;
  quantity?: number;
  note?: string;
  /** The other account of a transfer, or the payment/expense a fee came from. */
  linkedProfileId?: string;
  source: FinanceDataSource;
  createdAt: string;
}

export const ACTIVITY_KINDS: ReadonlyArray<InvestmentActivityKind> = [
  "contribution", "withdrawal", "buy", "sell", "dividend", "interest", "fee", "transfer_in", "transfer_out",
];

export function normalizeActivityKind(raw: unknown): InvestmentActivityKind | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((ACTIVITY_KINDS as readonly string[]).includes(s)) return s as InvestmentActivityKind;
  if (["deposit", "contribute", "contributed", "added", "add", "put_in", "invest", "invested"].includes(s)) return "contribution";
  if (["withdraw", "withdrew", "took_out", "cash_out", "distribution", "redemption"].includes(s)) return "withdrawal";
  if (["bought", "purchase", "purchased"].includes(s)) return "buy";
  if (["sold", "sale"].includes(s)) return "sell";
  if (["dividends", "div", "distribution_dividend"].includes(s)) return "dividend";
  if (["yield", "apy", "interest_earned"].includes(s)) return "interest";
  if (["fees", "expense_ratio", "commission", "charge"].includes(s)) return "fee";
  if (["received", "incoming", "transfer_from"].includes(s)) return "transfer_in";
  if (["sent", "outgoing", "transfer_to"].includes(s)) return "transfer_out";
  return null;
}

/**
 * How a kind of activity moves the account's TOTAL value:
 *   +1  money entered the asset (contribution, dividend paid in, transfer in)
 *   -1  money left it (withdrawal, fee, transfer out)
 *    0  composition changed, total did not (buy, sell: cash became shares)
 */
export function activityBalanceEffect(kind: InvestmentActivityKind): 1 | -1 | 0 {
  switch (kind) {
    case "contribution": case "dividend": case "interest": case "transfer_in": return 1;
    case "withdrawal": case "fee": case "transfer_out": return -1;
    default: return 0;
  }
}

/** Dividends and interest are INCOME associated with the asset, not new assets. */
export function activityIsIncome(kind: InvestmentActivityKind): boolean {
  return kind === "dividend" || kind === "interest";
}

export function investmentActivity(input: any): InvestmentActivity[] {
  const raw = fieldsOf(input).investmentActivity;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a: any) => a && typeof a === "object" && normalizeActivityKind(a.kind) && Number.isFinite(Number(a.amount)))
    .map((a: any, i: number) => ({
      id: String(a.id ?? `act-${i}`),
      date: isDay(String(a.date ?? "").slice(0, 10)) ? String(a.date).slice(0, 10) : String(a.createdAt ?? "").slice(0, 10),
      kind: normalizeActivityKind(a.kind)!,
      amount: round2(Math.abs(Number(a.amount))),
      ...(a.symbol ? { symbol: String(a.symbol).toUpperCase() } : {}),
      ...(a.quantity != null && Number.isFinite(Number(a.quantity)) ? { quantity: Number(a.quantity) } : {}),
      ...(a.note ? { note: String(a.note) } : {}),
      ...(a.linkedProfileId ? { linkedProfileId: String(a.linkedProfileId) } : {}),
      source: (a.source ?? "user") as FinanceDataSource,
      createdAt: String(a.createdAt ?? `${String(a.date ?? "").slice(0, 10)}T00:00:00.000Z`),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
}

export interface ActivityInput {
  kind: InvestmentActivityKind | string;
  amount: number;
  date?: string | null;
  symbol?: string | null;
  quantity?: number | null;
  note?: string | null;
  linkedProfileId?: string | null;
  source?: FinanceDataSource;
}

export const MAX_ACTIVITY_ROWS = 2000;

export function appendActivity(existing: any, input: ActivityInput, todayISO: string, nowISO?: string): { list: InvestmentActivity[]; entry: InvestmentActivity | null } {
  const list = Array.isArray(existing) ? investmentActivity({ investmentActivity: existing }) : investmentActivity(existing);
  const kind = normalizeActivityKind(input.kind);
  const amount = round2(Math.abs(Number(input.amount) || 0));
  if (!kind || amount <= 0) return { list, entry: null };
  const entry: InvestmentActivity = {
    id: newId("act"),
    date: isDay(String(input.date ?? "").slice(0, 10)) ? String(input.date).slice(0, 10) : todayISO,
    kind, amount,
    ...(input.symbol ? { symbol: String(input.symbol).trim().toUpperCase() } : {}),
    ...(input.quantity != null && Number.isFinite(Number(input.quantity)) ? { quantity: Number(input.quantity) } : {}),
    ...(input.note ? { note: String(input.note) } : {}),
    ...(input.linkedProfileId ? { linkedProfileId: String(input.linkedProfileId) } : {}),
    source: input.source ?? "user",
    createdAt: nowISO ?? new Date().toISOString(),
  };
  const out = [...list, entry].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  return { list: out.slice(-MAX_ACTIVITY_ROWS), entry };
}

export interface ActivitySummary {
  contributions: number;
  withdrawals: number;
  dividends: number;
  fees: number;
  buys: number;
  sells: number;
  transfersIn: number;
  transfersOut: number;
  /** contributions + transfersIn − withdrawals − transfersOut. */
  netFlow: number;
  count: number;
}

export function summarizeActivity(list: InvestmentActivity[], start?: string | null, end?: string | null): ActivitySummary {
  const out: ActivitySummary = { contributions: 0, withdrawals: 0, dividends: 0, fees: 0, buys: 0, sells: 0, transfersIn: 0, transfersOut: 0, netFlow: 0, count: 0 };
  for (const a of list) {
    if (start && a.date < start) continue;
    if (end && a.date > end) continue;
    out.count += 1;
    switch (a.kind) {
      case "contribution": out.contributions += a.amount; break;
      case "withdrawal": out.withdrawals += a.amount; break;
      case "dividend": case "interest": out.dividends += a.amount; break;
      case "fee": out.fees += a.amount; break;
      case "buy": out.buys += a.amount; break;
      case "sell": out.sells += a.amount; break;
      case "transfer_in": out.transfersIn += a.amount; break;
      case "transfer_out": out.transfersOut += a.amount; break;
    }
  }
  for (const k of Object.keys(out) as Array<keyof ActivitySummary>) out[k] = round2(out[k]);
  out.netFlow = round2(out.contributions + out.transfersIn - out.withdrawals - out.transfersOut);
  return out;
}

/**
 * Cash flow for a BANK-style account, from the adjustment ledger and activity:
 * money in vs money out over a window. Adjustments with a positive delta are
 * deposits, negative are withdrawals.
 */
export function cashFlowOf(profile: any, start?: string | null, end?: string | null): { deposits: number; withdrawals: number; net: number; count: number; rows: Array<{ date: string; amount: number; label: string; source: string }> } {
  const rows: Array<{ date: string; amount: number; label: string; source: string }> = [];
  for (const a of balanceHistory(profile)) {
    if (start && a.date < start) continue;
    if (end && a.date > end) continue;
    if (a.delta === 0) continue;
    rows.push({ date: a.date, amount: a.delta, label: a.reason || (a.delta > 0 ? "Deposit" : "Withdrawal"), source: a.source ?? "user" });
  }
  for (const a of investmentActivity(profile)) {
    if (start && a.date < start) continue;
    if (end && a.date > end) continue;
    const eff = activityBalanceEffect(a.kind);
    if (eff === 0) continue;
    rows.push({ date: a.date, amount: eff * a.amount, label: a.note || a.kind.replace(/_/g, " "), source: a.source });
  }
  rows.sort((a, b) => b.date.localeCompare(a.date));
  const deposits = round2(rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0));
  const withdrawals = round2(rows.filter((r) => r.amount < 0).reduce((s, r) => s + -r.amount, 0));
  return { deposits, withdrawals, net: round2(deposits - withdrawals), count: rows.length, rows };
}

// ─── 5. Provenance ───────────────────────────────────────────────────────────

export interface FieldSource {
  source: FinanceDataSource;
  at: string;
  ref?: string;
}

/**
 * Authority when sources disagree about a field. Connected data is live and
 * machine-read, so it wins over a statement the user uploaded, which wins over
 * a spreadsheet import, which wins over what the AI inferred from a sentence.
 * A user's own typing sits below the AI here only for API-OWNED keys — see
 * `sourceMayOverwrite`; for everything else the latest write wins regardless.
 */
export const SOURCE_PRIORITY: Record<FinanceDataSource, number> = {
  api: 5, document: 4, import: 3, payment: 3, ai: 2, user: 2, system: 1,
};

/** Fields a live connection OWNS while it is active. */
export const API_OWNED_FIELDS: ReadonlySet<string> = new Set([
  "balance", "currentBalance", "currentValue", "availableBalance", "balanceAsOf", "holdings",
]);

export function fieldSources(input: any): Record<string, FieldSource> {
  const raw = fieldsOf(input).fieldSources;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, FieldSource> = {};
  for (const [k, v] of Object.entries(raw as Record<string, any>)) {
    if (v && typeof v === "object" && v.source) out[k] = { source: v.source, at: String(v.at ?? ""), ...(v.ref ? { ref: String(v.ref) } : {}) };
  }
  return out;
}

/** The `fieldSources` map with these keys stamped as coming from `source` now. */
export function recordFieldSources(existing: any, keys: readonly string[], source: FinanceDataSource, nowISO: string, ref?: string | null): Record<string, FieldSource> {
  const out = { ...fieldSources(existing) };
  for (const k of keys) out[k] = { source, at: nowISO, ...(ref ? { ref: String(ref) } : {}) };
  return out;
}

/**
 * May a write from `incoming` replace field `key`?
 *
 * For API-owned keys on an account with a LIVE connection, only the API (or
 * a deliberate user correction) may write: a document extracted last month
 * must not roll a live balance back. Everything else: yes — the latest write
 * wins and provenance records who it was.
 */
export function sourceMayOverwrite(profile: any, key: string, incoming: FinanceDataSource): boolean {
  if (!API_OWNED_FIELDS.has(key)) return true;
  const conn = accountConnection(profile);
  if (!conn || conn.status !== "active") return true;
  return incoming === "api" || incoming === "user" || incoming === "payment";
}

// ─── Connection metadata ─────────────────────────────────────────────────────

export type ConnectionProvider = "stripe_financial_connections" | "plaid" | "brokerage_api" | "csv" | "chatgpt_import" | "manual";

export interface AccountConnection {
  provider: ConnectionProvider;
  /** The provider's account row id in our store (financial_accounts.id). */
  financialAccountId?: string;
  connectionId?: string;
  status: "active" | "disconnected" | "action_required";
  linkedAt?: string;
  lastSyncAt?: string;
  disconnectedAt?: string;
}

export function accountConnection(input: any): AccountConnection | null {
  const raw = fieldsOf(input).connection;
  if (!raw || typeof raw !== "object" || !raw.provider) return null;
  return {
    provider: raw.provider,
    ...(raw.financialAccountId ? { financialAccountId: String(raw.financialAccountId) } : {}),
    ...(raw.connectionId ? { connectionId: String(raw.connectionId) } : {}),
    status: raw.status === "disconnected" || raw.status === "action_required" ? raw.status : "active",
    ...(raw.linkedAt ? { linkedAt: String(raw.linkedAt) } : {}),
    ...(raw.lastSyncAt ? { lastSyncAt: String(raw.lastSyncAt) } : {}),
    ...(raw.disconnectedAt ? { disconnectedAt: String(raw.disconnectedAt) } : {}),
  };
}

export function isConnectedAccount(input: any): boolean {
  return accountConnection(input)?.status === "active";
}

// ─── Bookkeeping keys ────────────────────────────────────────────────────────

/**
 * Keys this module owns on `profile.fields`. They are DATA, not display fields:
 * the financial overview renders them; the generic field list, the Overview
 * composer and the field-delete sweep must skip them. Every list that hides
 * `balanceHistory` today should hide these too.
 */
export const FINANCIAL_DATA_KEYS: ReadonlySet<string> = new Set([
  "balanceSnapshots", "balance_snapshots",
  "holdings",
  "investmentActivity", "investment_activity",
  "fieldSources", "field_sources",
  "connection",
  "performanceHistory", "performance_history",
]);

// ─── 6. The money-mention ontology ───────────────────────────────────────────

export type MoneyMention =
  | "income"          // money entering the system: salary, paycheck, freelance, refund from a stranger
  | "asset_balance"   // an account IS worth X / has X in it → find-or-create the asset, snapshot X
  | "transfer"        // money moved between two owned accounts → both balances move, no income/expense
  | "asset_activity"  // a buy/sell/dividend inside an asset → activity on the existing asset
  | "expense"         // money spent on something outside the system
  | "liability"       // money owed
  | "unknown";

export interface MoneyMentionClassification {
  kind: MoneyMention;
  confidence: ClassificationConfidence;
  reason: string;
}

const INCOME_RE = /\b(earned|paycheck|pay ?check|salary|wages?|got paid|was paid|received (?:my|a) (?:paycheck|salary|bonus)|bonus|commission|freelance|side ?gig|reimburs|refund(?:ed)? (?:from|by)|tips?\b|income|payday|direct deposit from)\b/i;
const TRANSFER_RE = /\b(moved?|transferr?(?:ed|ing)?|put|deposit(?:ed)?|sent|wired?|contribut(?:ed|ion)|rolled? over|swept)\b[^.]{0,40}\b(into|to|from|between|over to)\b/i;
const ACTIVITY_RE = /\b(bought|buy|purchased|sold|sell|dividend|reinvest(?:ed)?|shares? of|stock in|interest (?:earned|paid|posted))\b/i;
const BALANCE_RE = /\b(balance|has|have|is at|is worth|worth|sitting at|down to|up to|dropped to|rose to|grew to|now at|holds?|contains?|in (?:my|the|our|his|her|their)\b)/i;
const LIABILITY_RE = /\b(owe|owed|debt|balance owed|loan|mortgage|credit card balance|i'?m behind|payoff)\b/i;
const EXPENSE_RE = /\b(spent|paid for|bought (?!shares|stock|bitcoin|eth|crypto)|purchase[ds]? (?!shares|stock)|cost me|charged)\b/i;
const ACCOUNT_WORD_RE = /\b(account|checking|savings|brokerage|ira|401\s?k|roth|hsa|wallet|fidelity|schwab|vanguard|robinhood|coinbase|chase|bank|cd\b|money market|529|portfolio|fund)\b/i;

/**
 * Which money concept a sentence is about. This is the ontology the AI chat
 * follows; the classifier is deterministic so its rules can be pinned by tests
 * and quoted in the prompt:
 *   "I earned $2,000 from work"            → income (never an asset)
 *   "My Schwab account has $34,000"        → asset_balance (find/create + snapshot)
 *   "Put $500 into Schwab"                 → transfer (no new asset, no income)
 *   "My Bitcoin wallet is worth $8,400"    → asset_balance (crypto)
 *   "My Fidelity balance dropped to $18k"  → asset_balance (append history)
 *   "Bought 10 shares of Apple in Fidelity"→ asset_activity
 */
export function classifyMoneyMention(text: string): MoneyMentionClassification {
  const t = String(text ?? "").trim();
  if (!t) return { kind: "unknown", confidence: "none", reason: "empty" };
  const mentionsAccount = ACCOUNT_WORD_RE.test(t);
  if (ACTIVITY_RE.test(t) && (mentionsAccount || /\b(shares?|stock|dividend|etf|crypto|bitcoin|eth)\b/i.test(t))) {
    return { kind: "asset_activity", confidence: "high", reason: "a buy/sell/dividend inside an asset" };
  }
  if (TRANSFER_RE.test(t) && mentionsAccount && !INCOME_RE.test(t)) {
    return { kind: "transfer", confidence: "high", reason: "money moved between owned accounts" };
  }
  if (INCOME_RE.test(t)) {
    return { kind: "income", confidence: "high", reason: "money earned or received — income, not an asset" };
  }
  if (LIABILITY_RE.test(t) && !/\b(checking|savings|brokerage|ira|401\s?k|wallet)\b/i.test(t)) {
    return { kind: "liability", confidence: "medium", reason: "money owed" };
  }
  if (mentionsAccount && BALANCE_RE.test(t)) {
    return { kind: "asset_balance", confidence: "high", reason: "an account's current value" };
  }
  if (EXPENSE_RE.test(t)) return { kind: "expense", confidence: "medium", reason: "money spent" };
  if (mentionsAccount) return { kind: "asset_balance", confidence: "low", reason: "an account is named" };
  return { kind: "unknown", confidence: "none", reason: "no money concept recognized" };
}

/** The prompt block that teaches the assistant this ontology. Kept next to the code it describes. */
export const FINANCIAL_ONTOLOGY_GUIDANCE = `
*** FINANCIAL ASSETS — THE ONTOLOGY ***
${FINANCIAL_ASSET_PRINCIPLE}

Money-HOLDING accounts are ASSETS with one Asset Profile each: checking, savings, money market, CD, cash, brokerage, IRA / 401(k) / retirement, crypto wallet, HSA, 529 / education. Credit cards, lines of credit, loans and mortgages are LIABILITIES. Salary, wages, paychecks, bonuses, freelance income, reimbursements and dividends are INCOME — money entering the system — and are NEVER an asset.
Separate the ASSET from ACTIVITY INSIDE it. "Fidelity Brokerage" is the asset. Its $24,830 is its current value. Buying Apple stock is activity. A $500 deposit is a contribution. A dividend is income tied to that asset. NEVER create a new account for a balance, a transaction, a holding, or a statement.
- "My Schwab account has $34,000" → create_account(name:"Schwab", accountKind:"brokerage", balance:34000) if none exists, else update_account_balance(name:"Schwab", newBalance:34000). Either way it APPENDS a dated balance observation; the old figure is kept as history.
- "My Fidelity balance dropped to $18,000" → update_account_balance(name:"Fidelity", newBalance:18000). Never delete or recreate the asset.
- "My Bitcoin wallet is worth $8,400" → a crypto asset: create_account(accountKind:"crypto") or update_account_balance — never an expense, never income.
- "I earned $2,000 from work" / "got paid" → log_income. Not an account, not an asset.
- "Put $500 into Schwab" / "moved $1,000 from checking to brokerage" → transfer_between_accounts(from:"checking", to:"Schwab", amount:…). Both balances move; NOTHING is logged as income or spending; net worth does not change. If only one side is named, it is record_account_activity(kind:"contribution") on that asset.
- "Bought 10 shares of AAPL in Fidelity" → record_account_activity(account:"Fidelity", kind:"buy", amount:…, symbol:"AAPL", quantity:10). The total value does not change (cash became shares).
- "Got a $120 dividend in my brokerage" → record_account_activity(kind:"dividend", amount:120). It is income associated with the asset; the account balance goes up by $120.
- "My Fidelity account holds 50 shares of VTI worth $12,000" → set_holding(account:"Fidelity", symbol:"VTI", quantity:50, value:12000). Holdings live INSIDE the asset.
When the account kind is not stated, infer it from context: Fidelity / Schwab / Vanguard / Robinhood → brokerage; Coinbase / "wallet" / BTC / ETH → crypto; "Roth", "IRA", "401k" → retirement; HSA → hsa; "529" → education; a plain bank name → checking (ask if it matters). Never create "Fidelity", "Fidelity Brokerage" and "Fidelity Account 2" for one account — reuse the existing one when the institution and kind match.
`;
