// ─── Market observations → comparable evidence ──────────────────────────────
//
// The market-research provider (server/valuation/providers/market-research.ts)
// does what a person does in ChatGPT: it searches the places an appraiser
// would look for THIS kind of thing and writes down every price it actually
// read — a sold listing, a pricing-guide figure, an AVM, an instant offer, an
// active listing. It does NOT pick the answer. This module turns those
// observations into evidence the engine can weigh:
//
//   · every price is restated on ONE basis — fair market value, what the
//     thing would actually sell for today between a willing private buyer and
//     seller. An asking price is not a sale price, a dealer's retail sticker
//     is not what an owner gets, and a trade-in offer is a wholesale price.
//   · how much an observation counts depends on what KIND of observation it
//     is (a completed sale beats an asking price) and how closely it matches
//     the asset (same trim and mileage vs "a similar one").
//
// Pure: no I/O.

import type { ValuationEvidence } from "./types";
import { DEFAULT_CURRENCY } from "./types";

/** What the observation IS. */
export type ObservationType =
  | "sold"        // a completed sale of a comparable item (eBay sold, recorded home sale, auction result)
  | "listing"     // an active asking price
  | "guide"       // a pricing guide's figure for this exact spec (KBB, Edmunds, NADA, Reverb, PriceCharting…)
  | "avm"         // an automated valuation for this exact item (Zestimate, Redfin Estimate)
  | "offer"       // an instant cash offer (Carvana, CarMax, Gazelle, Opendoor)
  | "appraisal"   // a published appraisal / auction estimate
  | "melt";       // intrinsic material value (gold, silver)

/** Which price the observation is quoted on. */
export type ValueBasis =
  | "fair_market"     // a sale between private parties / the market value
  | "private_party"
  | "dealer_retail"   // what a dealer / store asks
  | "trade_in"        // what a dealer pays
  | "wholesale"       // auction / dealer-to-dealer
  | "new_retail";     // price new — never a comparable, a ceiling

export interface MarketObservation {
  price: number;
  type: ObservationType;
  basis: ValueBasis;
  source: string;
  url: string | null;
  /** ISO date the price is from, when the page said. */
  date: string | null;
  /** 0..1 — how closely the observed item matches THIS asset. */
  similarity: number;
  /** "2021 CR-V EX AWD, 71k mi, Tampa FL — listed by dealer". */
  details: string;
}

const TYPES: ObservationType[] = ["sold", "listing", "guide", "avm", "offer", "appraisal", "melt"];
const BASES: ValueBasis[] = ["fair_market", "private_party", "dealer_retail", "trade_in", "wholesale", "new_retail"];

/** How trustworthy each kind of observation is as a statement of value. */
export const OBSERVATION_RELIABILITY: Record<ObservationType, number> = {
  sold: 0.9,
  guide: 0.85,
  avm: 0.8,
  offer: 0.8,
  appraisal: 0.8,
  melt: 0.9,
  listing: 0.65,
};

/**
 * Multiply an observed price by this to restate it as fair market value.
 * Industry rules of thumb: dealers ask ~10–12% over private-party; trade-in
 * and wholesale run ~15–20% under it; an asking price typically closes ~5%
 * below the ask. These are deliberately modest — a wrong adjustment of a few
 * percent is far less harmful than treating a sticker price as a sale.
 */
export const BASIS_TO_FAIR_MARKET: Record<Exclude<ValueBasis, "new_retail">, number> = {
  fair_market: 1,
  private_party: 1,
  dealer_retail: 0.9,
  trade_in: 1.15,
  wholesale: 1.12,
};
/** An asking price is not a sale: listings close below the ask. */
export const LISTING_TO_SALE = 0.95;

export interface ResearchResult {
  observations: MarketObservation[];
  /** Price of this item new (MSRP / retail), when found. A ceiling for wear-driven things. */
  newPrice: number | null;
  /** Specs of THIS exact item the research confirmed (trim, sqft…). */
  specs: Record<string, string | number>;
  /** One line: what the research concluded the item is. */
  identity: string | null;
  /** Loses value with age and use (true), holds or gains it (false), unknown (null). */
  depreciates: boolean | null;
  missing: string[];
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null;
}

/**
 * Validate the research model's JSON. Anything malformed is dropped rather
 * than guessed at: an observation without a positive price, a known type and
 * a source never reaches the engine.
 */
export function normalizeResearch(raw: unknown): ResearchResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const observations: MarketObservation[] = [];
  for (const o of Array.isArray(r.observations) ? r.observations.slice(0, 30) : []) {
    if (!o || typeof o !== "object") continue;
    const price = num(o.price);
    const type = TYPES.includes(o.type) ? o.type as ObservationType : null;
    const basis = BASES.includes(o.basis) ? o.basis as ValueBasis : "fair_market";
    const source = str(o.source, 80);
    if (!(price && price > 0) || !type || !source) continue;
    const url = typeof o.url === "string" && /^https?:\/\//.test(o.url.trim()) ? o.url.trim().slice(0, 500) : null;
    const date = typeof o.date === "string" && !isNaN(Date.parse(o.date)) ? o.date.slice(0, 10) : null;
    const sim = num(o.similarity);
    observations.push({
      price, type, basis, source, url, date,
      similarity: sim == null ? 0.6 : Math.max(0, Math.min(1, sim)),
      details: str(o.details, 200) || "",
    });
  }
  const specs: Record<string, string | number> = {};
  if (r.specs && typeof r.specs === "object") {
    for (const [k, v] of Object.entries(r.specs)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(k)) continue;
      if (typeof v === "number" && Number.isFinite(v)) specs[k] = v;
      else if (typeof v === "string" && v.trim() && v.trim().length <= 60 && !/^(unknown|n\/?a|tbd)$/i.test(v.trim())) specs[k] = v.trim();
    }
  }
  const newPrice = num(r.newPrice);
  return {
    observations,
    newPrice: newPrice && newPrice > 0 ? newPrice : null,
    specs,
    identity: str(r.identity, 160),
    depreciates: r.depreciates === true ? true : r.depreciates === false ? false : null,
    missing: Array.isArray(r.missing) ? r.missing.filter((s: unknown) => typeof s === "string" && s.trim()).map((s: string) => s.trim().slice(0, 100)).slice(0, 5) : [],
  };
}

/** The observation's price restated as fair market value, or null when it is not a comparable (a new price). */
export function fairMarketEquivalent(o: MarketObservation): number | null {
  if (o.basis === "new_retail") return null;
  let v = o.price * BASIS_TO_FAIR_MARKET[o.basis];
  if (o.type === "listing") v *= LISTING_TO_SALE;
  return v;
}

/**
 * Comparable evidence, one per observation, priced on the fair-market basis.
 * The engine pools them (robust median, outliers dropped) into the
 * comparable-sales estimate; each stays visible in the record's evidence.
 */
export function observationsToEvidence(
  observations: MarketObservation[],
  opts: { now: Date; halfLifeMs: number; provider: string; geographic?: string | null },
): ValuationEvidence[] {
  const out: ValuationEvidence[] = [];
  const nowIso = opts.now.toISOString();
  observations.forEach((o, i) => {
    const value = fairMarketEquivalent(o);
    if (value == null || !(value > 0)) return;
    // A dated observation ages from its own date (a sale two years ago is old
    // news); an undated one is treated as current, as the page presented it.
    const observedAt = o.date && Date.parse(o.date) <= opts.now.getTime() ? new Date(o.date).toISOString() : nowIso;
    const adjusted = Math.round(value) !== Math.round(o.price);
    out.push({
      id: `${opts.provider}:${i}`,
      kind: "comparable",
      source: o.source,
      provider: opts.provider,
      observedAt,
      fetchedAt: nowIso,
      value,
      low: null,
      high: null,
      currency: DEFAULT_CURRENCY,
      reliability: OBSERVATION_RELIABILITY[o.type],
      relevance: Math.max(0.2, o.similarity),
      halfLifeMs: opts.halfLifeMs,
      geographic: opts.geographic ?? null,
      reference: o.url,
      note: [
        `${TYPE_LABEL[o.type]}${o.basis !== "fair_market" && o.basis !== "private_party" ? ` (${BASIS_LABEL[o.basis]})` : ""}`,
        adjusted ? `$${Math.round(o.price).toLocaleString()} → $${Math.round(value).toLocaleString()} fair market` : null,
        o.details || null,
      ].filter(Boolean).join(" · "),
      raw: { observedPrice: o.price, type: o.type, basis: o.basis, similarity: o.similarity },
    });
  });
  return out;
}

const TYPE_LABEL: Record<ObservationType, string> = {
  sold: "Sold", listing: "Asking price", guide: "Pricing guide", avm: "Automated valuation",
  offer: "Instant offer", appraisal: "Appraisal / estimate", melt: "Material value",
};
const BASIS_LABEL: Record<ValueBasis, string> = {
  fair_market: "fair market", private_party: "private party", dealer_retail: "dealer retail",
  trade_in: "trade-in", wholesale: "wholesale", new_retail: "new",
};

// ── Pooling ─────────────────────────────────────────────────────────────────

export interface WeightedPoint { value: number; weight: number }

/** Weighted quantile (q in 0..1) of points; points need not be sorted. */
export function weightedQuantile(points: WeightedPoint[], q: number): number {
  const sorted = points.filter(p => p.weight > 0).sort((a, b) => a.value - b.value);
  if (sorted.length === 0) return NaN;
  const total = sorted.reduce((s, p) => s + p.weight, 0);
  let acc = 0;
  for (const p of sorted) {
    acc += p.weight;
    if (acc / total >= q) return p.value;
  }
  return sorted[sorted.length - 1].value;
}

/** Farther than this from the pooled median, a comparable is an outlier. */
export const COMPARABLE_OUTLIER_SPREAD = 0.35;

export interface PooledComparables {
  value: number;
  low: number;
  high: number;
  /** Indexes (into the input) kept after outlier removal. */
  kept: number[];
  dropped: number[];
  /** Weighted coefficient of variation among the kept points. */
  cv: number;
}

/**
 * Pool comparables the way an appraiser reads a page of comps: take the
 * weighted median, throw out the ones that are nothing like the rest (a
 * salvage-title car, a mislabeled listing), and report the median and the
 * interquartile band of what remains.
 */
export function poolComparables(points: WeightedPoint[]): PooledComparables | null {
  const valid = points.map((p, i) => ({ ...p, i })).filter(p => p.value > 0 && p.weight > 0);
  if (valid.length === 0) return null;
  const median = weightedQuantile(valid, 0.5);
  const kept = valid.length >= 3
    ? valid.filter(p => Math.abs(p.value - median) / median <= COMPARABLE_OUTLIER_SPREAD)
    : valid;
  const use = kept.length > 0 ? kept : valid;
  const value = weightedQuantile(use, 0.5);
  const w = use.reduce((s, p) => s + p.weight, 0);
  const mean = use.reduce((s, p) => s + p.weight * p.value, 0) / w;
  const variance = use.reduce((s, p) => s + p.weight * Math.pow(p.value - mean, 2), 0) / w;
  return {
    value,
    low: weightedQuantile(use, 0.25),
    high: weightedQuantile(use, 0.75),
    kept: use.map(p => p.i),
    dropped: valid.filter(p => !use.includes(p)).map(p => p.i),
    cv: mean > 0 ? Math.sqrt(variance) / mean : 1,
  };
}
