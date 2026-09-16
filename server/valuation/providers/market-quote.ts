// ─── Market quote provider ──────────────────────────────────────────────────
// Prices a tradable symbol (equity, ETF, fund, crypto pair) from a public
// quote endpoint and multiplies by the units held. Key-free by default (Yahoo
// Finance's chart endpoint); the base URL is overridable so a paid feed can
// be swapped in without touching the pipeline.

import type { ValuationEvidence } from "@shared/valuation/types";
import { DEFAULT_CURRENCY } from "@shared/valuation/types";
import { MS_PER_HOUR } from "@shared/valuation/planner";
import type { EvidenceProvider, ProviderRun } from "./types";

const DEFAULT_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";

interface Quote { symbol: string; price: number; currency: string; observedAt: string }

async function fetchQuote(symbol: string, signal: AbortSignal): Promise<Quote | null> {
  const base = process.env.MARKET_QUOTE_BASE_URL || DEFAULT_BASE;
  const url = `${base}${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const res = await fetch(url, { signal, headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (portol-valuation)" } });
  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  const meta = json?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!meta || !Number.isFinite(price) || price <= 0) return null;
  const t = Number(meta.regularMarketTime);
  return {
    symbol: String(meta.symbol || symbol),
    price,
    currency: String(meta.currency || DEFAULT_CURRENCY),
    observedAt: Number.isFinite(t) && t > 0 ? new Date(t * 1000).toISOString() : new Date().toISOString(),
  };
}

export const marketQuoteProvider: EvidenceProvider = {
  id: "market-quote",
  supports(ctx, plan) {
    return !!ctx.identifiers.symbol && plan.providers.includes("market-quote");
  },
  async fetch(run: ProviderRun): Promise<ValuationEvidence[]> {
    const symbol = run.ctx.identifiers.symbol!;
    let quote = await fetchQuote(symbol, run.signal);
    // A bare crypto ticker ("BTC") is quoted as a USD pair.
    if (!quote && /^[A-Z0-9]{2,6}$/.test(symbol)) quote = await fetchQuote(`${symbol}-USD`, run.signal);
    if (!quote) throw new Error(`No quote available for ${symbol}`);
    const units = run.ctx.quantity;
    const total = quote.price * (units ?? 1);
    return [{
      id: `quote:${quote.symbol}`,
      kind: "market_quote",
      source: `Market quote (${quote.symbol})`,
      provider: this.id,
      observedAt: quote.observedAt,
      fetchedAt: run.now.toISOString(),
      value: total,
      low: total * 0.995,
      high: total * 1.005,
      currency: quote.currency,
      reliability: 0.95,
      // Without a unit count the quote is a price, not a position value.
      relevance: units != null ? 1 : 0.6,
      halfLifeMs: 12 * MS_PER_HOUR,
      reference: quote.symbol,
      note: units != null
        ? `${units} × ${quote.currency} ${quote.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}`
        : `${quote.currency} ${quote.price.toLocaleString(undefined, { maximumFractionDigits: 4 })} per unit (units held unknown)`,
      raw: { price: quote.price, units, missing: units == null ? ["number of units held"] : [] },
    }];
  },
};
