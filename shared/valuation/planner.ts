// ─── Valuation Strategy Planner ──────────────────────────────────────────────
//
// Given a normalized ValuationContext, decide HOW to value the asset: which
// methodologies apply, how much each should count, which evidence providers
// to run, and how fresh market evidence has to be.
//
// Every rule below is keyed on what the asset can OFFER as evidence:
//   · a tradable symbol           → price the underlying instrument
//   · a user-entered value        → a verified value, decaying with age
//   · an appraisal in a document  → an appraisal, decaying with age
//   · a purchase price + date     → a transaction (recent) or a trajectory (old)
//   · income it produces          → an income capitalization cross-check
//   · a description specific enough to search for → live comparable pricing
//   · two or more prior valuations → the historical trend
//
// There is deliberately no `switch (assetType)` here. A kind of asset the app
// has never seen gets whichever of these its data supports.

import { MS_PER_DAY } from "../obligation-windows";
import type { MethodologyId, PlannedMethod, ValuationContext, ValuationPlan } from "./types";
import { historyDrift } from "./internal-evidence";

export const MS_PER_HOUR = 3_600_000;
export const DEFAULT_MARKET_FRESHNESS_MS = 30 * MS_PER_DAY;

/** Words that make a name too generic to search the market for on its own. */
const GENERIC_NAME_RE = /^(my|the|our|new|old|main|primary|home|house|car|truck|phone|laptop|computer|tv|watch|bike|savings|checking|account|cash|wallet|misc|other|stuff|asset|item|thing|investment|stock|fund)s?$/i;

function ageDays(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (isNaN(d.getTime())) return null;
  return Math.max(0, (now.getTime() - d.getTime()) / MS_PER_DAY);
}

/** Is the description specific enough that a live market search could find
 *  THIS thing (or its close comparables), rather than a category average? */
export function isSearchable(ctx: ValuationContext): boolean {
  if (ctx.understanding && ctx.understanding.searchable === false) return false;
  if (ctx.understanding?.searchable && ctx.understanding.searchQuery) return true;
  if (ctx.identifiers.address || ctx.identifiers.vin) return true;
  const a = ctx.attributes;
  const hasIdentity = ["make", "brand", "manufacturer", "model", "trim", "artist", "edition", "modelNumber", "year", "modelYear"]
    .filter(k => a[k] != null).length;
  if (hasIdentity >= 2) return true;
  // A bank/cash balance is its own value; searching the market for "Savings" is meaningless.
  if (ctx.userValue && /balance/i.test(ctx.userValue.key) && Object.keys(a).length < 2) return false;
  const tokens = ctx.description.split(/\s+/).filter(t => t.length > 1 && !GENERIC_NAME_RE.test(t));
  if (tokens.length >= 2 && (hasIdentity >= 1 || ctx.classification.confidence !== "low")) return true;
  return tokens.length >= 3;
}

function volatilityFreshnessMs(ctx: ValuationContext): number {
  const v = ctx.understanding?.volatility;
  if (v === "high") return 7 * MS_PER_DAY;
  if (v === "low") return 90 * MS_PER_DAY;
  return DEFAULT_MARKET_FRESHNESS_MS;
}

export function planValuation(ctx: ValuationContext, now: Date = new Date()): ValuationPlan {
  const methods: PlannedMethod[] = [];
  const rationale: string[] = [];
  const providers: string[] = [];
  // Freshness is per plan: hours for a quoted instrument, days-to-months for a
  // searched market depending on how fast it moves. Only a plan with no
  // external evidence at all falls back to the default window.
  let marketFreshnessMs: number | null = null;

  if (ctx.entityClass !== "asset") {
    return {
      methods: [], providers: [], needsExternal: false, needsAi: false, searchable: false,
      marketFreshnessMs: DEFAULT_MARKET_FRESHNESS_MS, rationale: ["Not an owned asset — nothing to value"],
      unsupportedReason: "This profile is not an owned asset.",
    };
  }

  // 1 — a listed instrument: the underlying market price is the value.
  if (ctx.identifiers.symbol) {
    methods.push({
      id: "underlying_security_pricing", weight: 1,
      rationale: `Priced from the live quote for ${ctx.identifiers.symbol}${ctx.quantity ? ` × ${ctx.quantity} units` : ""}`,
      providers: ["market-quote"], evidenceKinds: ["market_quote"],
    });
    providers.push("market-quote");
    marketFreshnessMs = Math.min(marketFreshnessMs ?? Infinity, 6 * MS_PER_HOUR);
    rationale.push("Tradable symbol present — direct market pricing applies");
  }

  // 2 — what the user says it is worth, weighted by how recent that is.
  if (ctx.userValue) {
    const age = ageDays(ctx.userValue.asOf, now);
    const weight = age == null ? 0.45 : age <= 30 ? 0.9 : age <= 180 ? 0.65 : age <= 365 ? 0.45 : 0.3;
    methods.push({
      id: "user_verified_value", weight,
      rationale: age == null ? "User-entered value of unknown age" : `User-entered value from ${Math.round(age)} days ago`,
      providers: [], evidenceKinds: ["user_value"],
    });
    rationale.push("User-entered value available");
  }

  // 3 — appraisals and assessments the user has on file.
  if (ctx.appraisals.length > 0) {
    methods.push({
      id: "document_appraisal", weight: 0.8,
      rationale: `${ctx.appraisals.length} appraisal/assessment figure(s) on file`,
      providers: [], evidenceKinds: ["document_appraisal"],
    });
    rationale.push("Appraisal evidence on file");
  }

  // 4 — the purchase: a recent one IS the market; an old one projects along a drift.
  if (ctx.purchase.price) {
    const age = ageDays(ctx.purchase.date, now);
    if (age != null && age <= 90) {
      methods.push({
        id: "recent_transaction", weight: 0.85,
        rationale: `Purchased ${Math.round(age)} days ago — the transaction price is current`,
        providers: [], evidenceKinds: ["transaction"],
      });
    } else {
      const driftKnown = ctx.understanding?.expectedAnnualChangePct != null || historyDrift(ctx) != null;
      methods.push({
        id: "value_trajectory", weight: age == null ? 0.2 : driftKnown ? 0.5 : 0.35,
        rationale: age == null
          ? "Purchase price known but not when — weak trajectory anchor"
          : `Purchase price projected ${Math.round(age / 365.25 * 10) / 10} years forward${driftKnown ? " along a known drift" : " with an uncertain drift"}`,
        providers: [], evidenceKinds: ["trajectory"],
      });
    }
    rationale.push("Purchase price available");
  }

  // 5 — the asset's own valuation history.
  if (ctx.history.filter(h => h.status === "valued" && h.value).length >= 2) {
    methods.push({
      id: "historical_trend", weight: 0.5,
      rationale: "Two or more prior valuations — trend extrapolation as a cross-check",
      providers: [], evidenceKinds: ["prior_valuation"],
    });
  }

  // 6 — income capitalization when the asset earns something.
  if (ctx.income && ctx.income.monthly > 0) {
    methods.push({
      id: "income_based", weight: 0.3,
      rationale: `Produces ~$${ctx.income.monthly.toLocaleString()}/month — capitalized as a cross-check`,
      providers: [], evidenceKinds: ["income_based"],
    });
  }

  // 7 — live market evidence when the description is specific enough.
  const searchable = !ctx.identifiers.symbol && isSearchable(ctx);
  if (searchable) {
    methods.push({
      id: "comparable_market_analysis", weight: 0.9,
      rationale: ctx.identifiers.address ? "Specific address — AVMs and nearby sales"
        : ctx.identifiers.vin ? "VIN present — exact-vehicle pricing"
        : "Description specific enough for live listing/comparable search",
      providers: ["live-search"], evidenceKinds: ["live_market_search", "comparable", "model_estimate"],
    });
    providers.push("live-search");
    marketFreshnessMs = Math.min(marketFreshnessMs ?? Infinity, volatilityFreshnessMs(ctx));
    rationale.push("Live market search applies");
  }

  // Deterministic understanding is enough when the market can price the thing
  // directly. The model is worth a (cached, background) call when the asset is
  // unfamiliar, sparse, or we could not decide whether it is searchable.
  const needsAi = !ctx.understanding && !ctx.identifiers.symbol
    && (ctx.classification.confidence === "low" || ctx.sparse || !searchable);

  if (methods.length === 0) {
    return {
      methods: [], providers: [], needsExternal: false, needsAi, searchable,
      marketFreshnessMs: DEFAULT_MARKET_FRESHNESS_MS, rationale: ["No value evidence: no market identifier, user value, purchase, appraisal, income or searchable description"],
      unsupportedReason: "Not enough information to value this asset yet.",
    };
  }

  const order: MethodologyId[] = [
    "underlying_security_pricing", "comparable_market_analysis", "recent_transaction",
    "user_verified_value", "document_appraisal", "value_trajectory", "historical_trend", "income_based",
  ];
  methods.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  return {
    methods,
    providers: [...new Set(providers)],
    needsExternal: providers.length > 0,
    needsAi,
    marketFreshnessMs: marketFreshnessMs ?? DEFAULT_MARKET_FRESHNESS_MS,
    searchable,
    rationale,
  };
}
