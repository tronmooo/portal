// shared/investments.ts — investment accounts and their holdings, one model.
//
// An investment ACCOUNT is a profile of type "investment" (Roth IRA, 401k,
// brokerage, crypto wallet, HSA…). Its POSITIONS — stocks, ETFs, crypto,
// bonds, cash — live in `fields.holdings` as the array modelled here. Every
// write recomputes the account's `fields.currentValue` / `fields.totalInvested`
// via these helpers, so all the surfaces that already read those fields (net
// worth, asset rollups, get_financial_overview, the Assets tab) reflect
// holdings without knowing they exist.
//
// Pure, dependency-free. Pinned by tests/investments.test.ts.

export const ASSET_CLASSES = ["stock", "etf", "crypto", "bond", "cash", "other"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export interface Holding {
  /** Ticker or coin symbol, uppercased: AAPL, VOO, BTC, ETH. */
  symbol: string;
  /** Optional display name: "Apple", "Bitcoin". */
  name?: string;
  /** Shares / coins. Fractional is normal (0.05 BTC). */
  quantity: number;
  assetClass: AssetClass;
  /** TOTAL amount paid for this position (not per-unit). */
  costBasis: number;
  /** Latest per-unit price (user-stated or estimated). */
  currentPrice: number;
  /** When currentPrice was last set (ISO). */
  lastPricedAt?: string;
}

export const INVESTMENT_ACCOUNT_TYPES = [
  "roth_ira", "traditional_ira", "401k", "403b", "hsa", "brokerage",
  "crypto_wallet", "529", "pension", "other",
] as const;
export type InvestmentAccountType = (typeof INVESTMENT_ACCOUNT_TYPES)[number];

/** Human labels for account types. */
export const ACCOUNT_TYPE_LABELS: Record<InvestmentAccountType, string> = {
  roth_ira: "Roth IRA",
  traditional_ira: "Traditional IRA",
  "401k": "401(k)",
  "403b": "403(b)",
  hsa: "HSA",
  brokerage: "Brokerage",
  crypto_wallet: "Crypto Wallet",
  "529": "529 Plan",
  pension: "Pension",
  other: "Investment",
};

/** Infer the account type from how the user names it ("my Roth IRA"). */
export function detectAccountType(name: unknown): InvestmentAccountType {
  const n = String(name ?? "").toLowerCase();
  if (/\broth\b/.test(n)) return "roth_ira";
  if (/\btraditional\s*ira\b|\btrad\s*ira\b/.test(n)) return "traditional_ira";
  if (/\bira\b/.test(n)) return "traditional_ira";
  if (/401\s*\(?k\)?/.test(n)) return "401k";
  if (/403\s*\(?b\)?/.test(n)) return "403b";
  if (/\bhsa\b|health\s*savings/.test(n)) return "hsa";
  if (/\b529\b|college\s*savings/.test(n)) return "529";
  if (/pension/.test(n)) return "pension";
  if (/crypto|coinbase|binance|kraken|wallet|ledger|metamask/.test(n)) return "crypto_wallet";
  if (/brokerage|robinhood|fidelity|schwab|vanguard|etrade|e\*trade|webull|stocks?\b/.test(n)) return "brokerage";
  return "other";
}

const CRYPTO_SYMBOLS = new Set([
  "BTC", "ETH", "SOL", "ADA", "DOGE", "XRP", "DOT", "LTC", "AVAX", "MATIC",
  "LINK", "UNI", "SHIB", "BCH", "XLM", "ATOM", "USDC", "USDT",
]);

/** Best-effort asset class when the user doesn't say ("I bought 0.1 BTC"). */
export function detectAssetClass(symbol: unknown, hint?: unknown): AssetClass {
  const h = String(hint ?? "").toLowerCase();
  if ((ASSET_CLASSES as readonly string[]).includes(h)) return h as AssetClass;
  const s = String(symbol ?? "").toUpperCase().trim();
  if (CRYPTO_SYMBOLS.has(s)) return "crypto";
  if (/^(VOO|VTI|SPY|QQQ|IVV|VEA|VWO|BND|AGG|SCHD|VIG|IWM|DIA|ARKK)$/.test(s)) return "etf";
  return "stock";
}

/** Parse + clean one holding from loosely-typed input. Throws on junk. */
export function normalizeHolding(input: {
  symbol: unknown; quantity: unknown; assetClass?: unknown;
  price?: unknown; costBasis?: unknown; name?: unknown; lastPricedAt?: string;
}): Holding {
  const symbol = String(input.symbol ?? "").toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, "");
  if (!symbol) throw new Error("A holding needs a symbol (AAPL, VOO, BTC…)");
  const quantity = Number(input.quantity);
  if (!isFinite(quantity) || quantity <= 0) throw new Error(`Invalid quantity for ${symbol}: ${input.quantity}`);
  const price = input.price != null ? Number(input.price) : NaN;
  const costBasis = input.costBasis != null ? Number(input.costBasis)
    : isFinite(price) ? price * quantity : 0;
  if (!isFinite(costBasis) || costBasis < 0) throw new Error(`Invalid cost basis for ${symbol}`);
  const currentPrice = isFinite(price) && price > 0 ? price
    : quantity > 0 && costBasis > 0 ? costBasis / quantity : 0;
  return {
    symbol,
    name: input.name ? String(input.name) : undefined,
    quantity,
    assetClass: detectAssetClass(symbol, input.assetClass),
    costBasis: Math.round(costBasis * 100) / 100,
    currentPrice: Math.round(currentPrice * 10000) / 10000,
    lastPricedAt: input.lastPricedAt ?? new Date().toISOString(),
  };
}

export const holdingValue = (h: Holding): number =>
  Math.round(h.quantity * h.currentPrice * 100) / 100;

export function holdingsValue(holdings: readonly Holding[] | undefined): number {
  return Math.round((holdings || []).reduce((s, h) => s + h.quantity * h.currentPrice, 0) * 100) / 100;
}

export function holdingsInvested(holdings: readonly Holding[] | undefined): number {
  return Math.round((holdings || []).reduce((s, h) => s + (h.costBasis || 0), 0) * 100) / 100;
}

export function allocationByClass(holdings: readonly Holding[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of holdings || []) {
    out[h.assetClass] = Math.round(((out[h.assetClass] || 0) + h.quantity * h.currentPrice) * 100) / 100;
  }
  return out;
}

/** Read the holdings array off a profile row, tolerating absent/junk data. */
export function holdingsOf(profile: any): Holding[] {
  const raw = profile?.fields?.holdings;
  if (!Array.isArray(raw)) return [];
  return raw.filter((h: any) => h && typeof h.symbol === "string" && isFinite(Number(h.quantity)));
}

/**
 * Merge a purchase into an existing position list: same symbol adds quantity
 * and cost basis and refreshes the price; a new symbol appends.
 */
export function mergeHolding(holdings: readonly Holding[], incoming: Holding): Holding[] {
  const idx = holdings.findIndex((h) => h.symbol === incoming.symbol);
  if (idx === -1) return [...holdings, incoming];
  const cur = holdings[idx];
  const merged: Holding = {
    ...cur,
    name: incoming.name || cur.name,
    quantity: Math.round((cur.quantity + incoming.quantity) * 1e8) / 1e8,
    costBasis: Math.round((cur.costBasis + incoming.costBasis) * 100) / 100,
    currentPrice: incoming.currentPrice || cur.currentPrice,
    lastPricedAt: incoming.lastPricedAt ?? cur.lastPricedAt,
    assetClass: cur.assetClass,
  };
  return holdings.map((h, i) => (i === idx ? merged : h));
}

/** The fields patch that keeps an account's rollups true to its holdings. */
export function accountFieldsPatch(holdings: readonly Holding[]): Record<string, any> {
  return {
    holdings,
    currentValue: holdingsValue(holdings),
    totalInvested: holdingsInvested(holdings),
    holdingsCount: holdings.length,
    holdingsUpdatedAt: new Date().toISOString(),
  };
}
