// ─── Asset Lifecycle Intelligence ────────────────────────────────────────────
//
// Owner, 2026-11-24: "Remove mandatory manual salvage value, useful life and
// depreciation inputs. Automatically determine these values … The AI should
// gather relevant evidence and determine appropriate valuation assumptions. A
// deterministic calculation engine should perform the financial calculations."
//
// Two halves, kept apart on purpose:
//
//   ASSUMPTIONS — what kind of asset this is and how it ages: value model
//     (depreciating / appreciating / stable), useful life, the yearly rate,
//     salvage value (negative = it costs money to get rid of), replacement
//     cost. Chosen by the AI during the value-tracking run
//     (server/valuation/lifecycle-ai.ts) and stored on the profile
//     (`lifecycleAssumptions`), or — with no AI answer yet — the TYPICAL
//     figures for the asset's category below, always labelled as typical and
//     low confidence. The AI's answer passes `sanitizeLifecycleAssumptions`
//     or is refused; it never writes a number the engine did not bound.
//
//   ENGINE — `computeAssetLifecycle`: pure arithmetic over the assumptions
//     and the asset's real records (current value, purchase, attributed
//     repair costs, warranty). Projection, accumulated and future
//     depreciation, remaining useful life, selling window, replacement cost
//     and date, repair-versus-replace, and ONE recommendation with its
//     reasons. Nothing here calls a model or reads storage; the server's
//     lifecycle service and every screen read the same result (Rule 1).
//
// Nothing is stored that can be derived: the recommendation, the window and
// the dates are computed on read (Rule 5). Nested assets are separate
// records: a parent's lifecycle uses its OWN value, and an expense linked to
// several assets of one tree is counted once (`attributeAssetExpenses`).

import { classifyOverviewEntity } from "./overview-semantics";
import type { AttentionItem } from "./attention";

const DAY = 86_400_000;
const YEAR = 365.25 * DAY;

export type LifecycleValueModel = "depreciating" | "appreciating" | "stable";
export type LifecycleConfidence = "high" | "medium" | "low";
export type DisposalRoute = "resell" | "scrap" | "recycle" | "dispose" | "none";
export type LifecycleAction = "keep" | "monitor" | "consider_selling" | "replace" | "dispose";

export const LIFECYCLE_ACTION_LABEL: Record<LifecycleAction, string> = {
  keep: "Keep",
  monitor: "Monitor",
  consider_selling: "Consider Selling",
  replace: "Replace",
  dispose: "Dispose / Recycle",
};

/** Actions significant enough to raise in Needs Attention. */
export const SIGNIFICANT_ACTIONS: ReadonlySet<LifecycleAction> = new Set(["consider_selling", "replace", "dispose"]);

/** The stored field holding the AI's assumptions (a valuation OUTPUT, never an input). */
export const LIFECYCLE_ASSUMPTIONS_KEY = "lifecycleAssumptions";
/** The newest assumption key; a stored answer without it predates the full set of disposal factors. */
export const DISPOSAL_FACTOR_KEYS = ["annualUpkeep", "upkeepGrowthPct", "majorRepairCost", "majorFailureChancePct", "majorFailureChanceGrowthPct", "carryingCostPct", "sellingCostPct", "newEfficiencySavings"] as const;
const DISPOSAL_FACTOR_MARKER = "sellingCostPct";
/** An AI answer is re-asked at most this often when nothing it used changed. */
export const LIFECYCLE_MAX_AGE_MS = 180 * DAY;

export interface LifecycleAssumptions {
  source: "ai" | "typical";
  valueModel: LifecycleValueModel;
  /** Years from new to the end of its useful life; null when it has none. */
  usefulLifeYears: number | null;
  /** Typical yearly change as a decimal (−0.15 loses 15 %/yr, 0.03 gains 3 %/yr). */
  annualChangePct: number | null;
  /** End-of-life value in dollars. Negative = a net cost to dispose of it. Null when not meaningful. */
  salvageValue: number | null;
  disposal: DisposalRoute;
  /** What an equivalent new one costs today; null when unknown. */
  replacementCost: number | null;
  /**
   * Typical yearly upkeep (repairs + maintenance, no fuel or insurance) in
   * dollars at its CURRENT age; null when unknown. Feeds the optimal disposal
   * point (`optimalDisposalPoint`).
   */
  annualUpkeep?: number | null;
  /** How fast that upkeep rises each year it ages, as a decimal (0.12 = +12 %/yr); null when unknown. */
  upkeepGrowthPct?: number | null;
  /** What one MAJOR failure costs to fix (engine, compressor, logic board), in dollars; null when unknown. */
  majorRepairCost?: number | null;
  /** The chance of such a failure in the coming year, as a decimal (0.05 = 5 %). */
  majorFailureChancePct?: number | null;
  /** How fast that chance rises each year it ages, as a decimal. */
  majorFailureChanceGrowthPct?: number | null;
  /** Insurance, property tax, registration that scale with its value, a yearly share of the value (0.04 = 4 %). */
  carryingCostPct?: number | null;
  /** What selling or getting rid of it costs (fees, listing, prep, haul-away), a share of the price it fetches. */
  sellingCostPct?: number | null;
  /** Yearly running cost a NEW one would save (energy, fuel efficiency), in dollars; 0 when none. */
  newEfficiencySavings?: number | null;
  confidence: LifecycleConfidence;
  /** One sentence on why. */
  basis: string;
  /** The assumptions in plain words, at most five. */
  assumptions: string[];
  /** The facts these were chosen from (the valuation input fingerprint). */
  inputsKey?: string | null;
  asOf?: string | null;
}

// ── Assumptions: the AI's answer, checked ────────────────────────────────────

function finite(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) { const n = Number(v.replace(/[$,\s%]/g, "")); return Number.isFinite(n) ? n : null; }
  return null;
}

/**
 * The model's answer, bounded. Anything out of bounds is dropped (null), not
 * clamped into a plausible-looking number: a salvage value above what the
 * thing is worth, a disposal cost larger than a quarter of its price, a
 * replacement cost twenty times the price. A missing value model refuses the
 * whole answer.
 */
export function sanitizeLifecycleAssumptions(
  raw: unknown,
  bounds: { purchasePrice?: number | null; currentValue?: number | null },
): LifecycleAssumptions | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const valueModel = r.valueModel === "depreciating" || r.valueModel === "appreciating" || r.valueModel === "stable" ? r.valueModel : null;
  if (!valueModel) return null;
  const ceiling = Math.max(finite(bounds.purchasePrice) ?? 0, finite(bounds.currentValue) ?? 0);

  let life = finite(r.usefulLifeYears);
  if (life != null && (life < 0.5 || life > 150)) life = null;
  if (valueModel !== "depreciating") life = null;

  let rate = finite(r.annualChangePct);
  if (rate != null && Math.abs(rate) > 1) rate = rate / 100; // "15" meant 15 %
  if (rate != null && (rate < -0.7 || rate > 0.5)) rate = null;
  if (rate != null && valueModel === "depreciating" && rate > 0) rate = -rate;
  if (rate != null && valueModel === "appreciating" && rate < 0) rate = null;
  if (valueModel === "stable") rate = 0;

  let salvage = r.salvageValue === null ? null : finite(r.salvageValue);
  if (salvage != null) {
    if (ceiling > 0 && salvage > ceiling) salvage = null;
    else if (salvage < 0 && -salvage > Math.max(500, ceiling * 0.25)) salvage = null;
    else salvage = Math.round(salvage);
  }
  if (valueModel !== "depreciating") salvage = null;

  let replacement = finite(r.replacementCost);
  if (replacement != null && (replacement <= 0 || (ceiling > 0 && replacement > ceiling * 20))) replacement = null;
  if (replacement != null) replacement = Math.round(replacement);

  let upkeep = r.annualUpkeep === null ? null : finite(r.annualUpkeep);
  if (upkeep != null && (upkeep < 0 || (ceiling > 0 && upkeep > ceiling * 0.5) || upkeep > 100_000)) upkeep = null;
  if (upkeep != null) upkeep = Math.round(upkeep);
  let growth = finite(r.upkeepGrowthPct);
  if (growth != null && Math.abs(growth) > 1) growth = growth / 100;
  if (growth != null && (growth < 0 || growth > 0.6)) growth = null;
  const pct = (v: unknown, max: number) => { let n = finite(v); if (n != null && Math.abs(n) > 1) n = n / 100; return n != null && n >= 0 && n <= max ? Math.round(n * 1000) / 1000 : null; };
  const dollars = (v: unknown, max: number) => { const n = v === null ? null : finite(v); return n != null && n >= 0 && n <= max ? Math.round(n) : null; };
  const ceil = ceiling > 0 ? ceiling : 1_000_000;
  const majorRepairCost = dollars(r.majorRepairCost, Math.max(ceil * 1.5, 500));
  const majorFailureChancePct = pct(r.majorFailureChancePct, 0.9);
  const majorFailureChanceGrowthPct = pct(r.majorFailureChanceGrowthPct, 1);
  const carryingCostPct = pct(r.carryingCostPct, 0.25);
  const sellingCostPct = pct(r.sellingCostPct, 0.5);
  const newEfficiencySavings = dollars(r.newEfficiencySavings, Math.max(ceil * 0.5, 200));

  const disposal: DisposalRoute = (["resell", "scrap", "recycle", "dispose", "none"] as const).find((d) => d === r.disposal) ?? (valueModel === "depreciating" ? "resell" : "none");
  const confidence: LifecycleConfidence = r.confidence === "high" || r.confidence === "low" ? r.confidence : "medium";
  const text = (v: unknown, max: number) => typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";
  const list = Array.isArray(r.assumptions) ? r.assumptions.map((s) => text(s, 160)).filter(Boolean).slice(0, 5) : [];
  return {
    source: "ai", valueModel, usefulLifeYears: life, annualChangePct: rate, salvageValue: salvage, disposal,
    replacementCost: replacement, annualUpkeep: upkeep, upkeepGrowthPct: growth,
    majorRepairCost, majorFailureChancePct, majorFailureChanceGrowthPct, carryingCostPct, sellingCostPct, newEfficiencySavings,
    confidence, basis: text(r.basis, 240), assumptions: list,
  };
}

/** A stored assumptions object read back (or null when absent or malformed). */
export function readStoredAssumptions(fields: Record<string, any> | null | undefined): LifecycleAssumptions | null {
  const v = fields?.[LIFECYCLE_ASSUMPTIONS_KEY];
  if (!v || typeof v !== "object") return null;
  const clean = sanitizeLifecycleAssumptions(v, {});
  if (!clean) return null;
  return { ...clean, source: "ai", inputsKey: typeof v.inputsKey === "string" ? v.inputsKey : null, asOf: typeof v.asOf === "string" ? v.asOf : null };
}

/** Should the AI be asked (again) for this asset's assumptions? */
export function lifecycleNeedsEstimate(fields: Record<string, any> | null | undefined, inputsKey: string, now: Date): boolean {
  const stored = readStoredAssumptions(fields);
  if (!stored) return true;
  if ((stored.inputsKey || "") !== inputsKey) return true;
  // An answer from before every disposal factor was asked for: ask once more.
  if (stored.valueModel === "depreciating" && !(DISPOSAL_FACTOR_MARKER in (fields?.[LIFECYCLE_ASSUMPTIONS_KEY] ?? {}))) return true;
  const at = Date.parse(String(stored.asOf || ""));
  return !Number.isFinite(at) || now.getTime() - at >= LIFECYCLE_MAX_AGE_MS;
}

// ── Typical assumptions, by category (no AI answer yet) ──────────────────────

interface Typical {
  model: LifecycleValueModel; life: number | null; rate: number; salvageShare: number | null; disposal: DisposalRoute; label: string;
  /** Yearly upkeep when new, as a share of the price, and how fast it rises with age. */
  upkeepShare?: number; upkeepGrowth?: number;
  /** A major failure: its cost as a share of the price, its chance this year when new, how fast that rises. */
  majorShare?: number; failChance?: number; failGrowth?: number;
  /** Insurance/tax/registration share of value a year; selling cost share; a new one's yearly running saving as a share of the price. */
  carrying?: number; selling?: number; savingsShare?: number;
}

const APPLIANCE_RE = /\b(fridge|refrigerator|freezer|washer|dryer|dishwasher|oven|stove|range|microwave|appliance|furnace|water heater|air conditioner|hvac|ac unit)\b/i;
const FURNITURE_RE = /\b(sofa|couch|table|chair|bed|desk|dresser|mattress|furniture|bookshelf|cabinet|recliner)\b/i;
const JEWELRY_RE = /\b(gold|silver|jewelry|jewellery|ring|necklace|bracelet|diamond|bullion)\b/i;
const NO_LIFECYCLE = new Set(["financial_account", "investment", "intangible", "insurance", "mortgage", "loan", "credit_line", "recurring_bill"]);

/** The category this engine reasons with: the app's classification, refined. */
export function lifecycleCategory(entity: { name?: string | null; type?: string | null; type_key?: string | null; tags?: string[] | null; fields?: Record<string, any> | null }): string {
  const hay = `${entity.name || ""} ${(entity.tags || []).join(" ")}`;
  const base = classifyOverviewEntity(entity as any).semanticCategory;
  if (base === "real_estate" || base === "vehicle" || NO_LIFECYCLE.has(base)) return base;
  if (APPLIANCE_RE.test(hay)) return "appliance";
  if (JEWELRY_RE.test(hay)) return "jewelry";
  if (FURNITURE_RE.test(hay)) return "furniture";
  if (String(entity.type || "").toLowerCase() === "vehicle") return "vehicle";
  if (String(entity.type || "").toLowerCase() === "property") return "real_estate";
  return base;
}

const TYPICAL: Record<string, Typical> = {
  vehicle: { model: "depreciating", life: 15, rate: -0.15, salvageShare: 0.06, disposal: "scrap", label: "vehicles", upkeepShare: 0.03, upkeepGrowth: 0.12, majorShare: 0.1, failChance: 0.03, failGrowth: 0.15, carrying: 0.05, selling: 0.08, savingsShare: 0.01 },
  electronics: { model: "depreciating", life: 5, rate: -0.3, salvageShare: 0.03, disposal: "recycle", label: "electronics", upkeepShare: 0.02, upkeepGrowth: 0.3, majorShare: 0.35, failChance: 0.04, failGrowth: 0.35, carrying: 0.01, selling: 0.1, savingsShare: 0 },
  appliance: { model: "depreciating", life: 12, rate: -0.15, salvageShare: 0, disposal: "recycle", label: "household appliances", upkeepShare: 0.02, upkeepGrowth: 0.18, majorShare: 0.3, failChance: 0.03, failGrowth: 0.2, carrying: 0, selling: 0.05, savingsShare: 0.03 },
  furniture: { model: "depreciating", life: 10, rate: -0.18, salvageShare: 0.03, disposal: "dispose", label: "furniture", upkeepShare: 0.005, upkeepGrowth: 0.06, majorShare: 0.15, failChance: 0.01, failGrowth: 0.08, carrying: 0, selling: 0.15, savingsShare: 0 },
  equipment: { model: "depreciating", life: 10, rate: -0.12, salvageShare: 0.08, disposal: "resell", label: "equipment and tools", upkeepShare: 0.03, upkeepGrowth: 0.12, majorShare: 0.2, failChance: 0.03, failGrowth: 0.15, carrying: 0.01, selling: 0.1, savingsShare: 0 },
  real_estate: { model: "appreciating", life: null, rate: 0.03, salvageShare: null, disposal: "none", label: "property" },
  collectible: { model: "stable", life: null, rate: 0, salvageShare: null, disposal: "none", label: "collectibles" },
  jewelry: { model: "stable", life: null, rate: 0, salvageShare: null, disposal: "none", label: "jewelry and precious metals" },
  generic: { model: "depreciating", life: 8, rate: -0.15, salvageShare: 0.03, disposal: "dispose", label: "household items", upkeepShare: 0.01, upkeepGrowth: 0.12, majorShare: 0.2, failChance: 0.02, failGrowth: 0.12, carrying: 0, selling: 0.1, savingsShare: 0 },
};

/** The category's typical upkeep: a share of the price per year when new, and its yearly growth. */
export function typicalUpkeep(category: string): { share: number; growth: number } {
  const t = TYPICAL[category] ?? TYPICAL.generic;
  return { share: t.upkeepShare ?? 0.01, growth: t.upkeepGrowth ?? 0.1 };
}

/** The category's typical figures for every other disposal factor (shares of the price where a price is needed). */
export function typicalDisposalFactors(category: string) {
  const t = TYPICAL[category] ?? TYPICAL.generic;
  return {
    majorShare: t.majorShare ?? 0.2, failChance: t.failChance ?? 0.02, failGrowth: t.failGrowth ?? 0.12,
    carrying: t.carrying ?? 0, selling: t.selling ?? 0.1, savingsShare: t.savingsShare ?? 0,
  };
}

/** The category's typical assumptions — labelled typical, low confidence. Null where a lifecycle does not apply. */
export function typicalAssumptions(category: string, purchasePrice: number | null): LifecycleAssumptions | null {
  if (NO_LIFECYCLE.has(category)) return null;
  const t = TYPICAL[category] ?? TYPICAL.generic;
  const salvage = t.salvageShare != null && purchasePrice && purchasePrice > 0 ? Math.round(purchasePrice * t.salvageShare) : (t.salvageShare === 0 ? 0 : null);
  const lines: string[] = [];
  if (t.model === "depreciating") lines.push(`Typical useful life for ${t.label}: about ${t.life} years`, `Loses about ${Math.round(-t.rate * 100)}% of its value a year`);
  else if (t.model === "appreciating") lines.push(`Typical for ${t.label}: gains about ${Math.round(t.rate * 100)}% a year`);
  else lines.push(`Typical for ${t.label}: holds its value`);
  return {
    source: "typical", valueModel: t.model, usefulLifeYears: t.life, annualChangePct: t.rate, salvageValue: t.model === "depreciating" ? salvage : null,
    disposal: t.disposal, replacementCost: null, confidence: "low",
    // Upkeep in dollars needs a price; the engine scales the share itself when it has none.
    annualUpkeep: null, upkeepGrowthPct: t.model === "depreciating" ? t.upkeepGrowth ?? null : null,
    basis: `Typical figures for ${t.label}; Portol has not analysed this asset yet.`, assumptions: lines,
  };
}

// ── Nested assets: an expense counts once ────────────────────────────────────

export interface AttributedExpense { id: string; amount: number; share: number; date: string | null; description: string; category: string; tags: string[] }

/**
 * Who an expense belongs to, for lifecycle costs. An expense linked to several
 * assets of one tree (the house AND its furnace) belongs to the DEEPEST one,
 * the most specific; a tie splits it evenly. So adding a parent's and its
 * children's costs never counts a dollar twice.
 */
export function attributeAssetExpenses(
  expenses: ReadonlyArray<{ id?: string; amount?: number | string | null; linkedProfiles?: string[] | null; date?: string | null; description?: string | null; category?: string | null; tags?: string[] | null }>,
  assets: ReadonlyArray<{ id: string; parentProfileId?: string | null }>,
): Map<string, AttributedExpense[]> {
  const parent = new Map(assets.map((a) => [a.id, a.parentProfileId || null]));
  const depth = (id: string): number => {
    let d = 0, cur = parent.get(id) || null;
    const seen = new Set([id]);
    while (cur && parent.has(cur) && !seen.has(cur) && d < 50) { seen.add(cur); d++; cur = parent.get(cur) || null; }
    return d;
  };
  const out = new Map<string, AttributedExpense[]>();
  expenses.forEach((e, i) => {
    const linked = [...new Set((e.linkedProfiles || []).filter((id) => parent.has(id)))];
    if (!linked.length) return;
    const amount = finite(e.amount) ?? 0;
    if (!(amount > 0)) return;
    const depths = linked.map(depth);
    const max = Math.max(...depths);
    const owners = linked.filter((_, j) => depths[j] === max);
    for (const id of owners) {
      const list = out.get(id) || [];
      list.push({ id: e.id || `expense-${i}`, amount, share: amount / owners.length, date: e.date || null, description: e.description || "", category: e.category || "", tags: e.tags || [] });
      out.set(id, list);
    }
  });
  return out;
}

const REPAIR_RE = /repair|maint|service|oil change|brake|fix|replac|tune[- ]?up|inspection|alignment|rotat|flush|filter|spark plug|timing belt|tires?\b|parts?\b|upkeep|battery/i;
/** Loan payments are financing, not upkeep (A4); never repair-vs-replace input. */
const FINANCING_TAG = /^(payment|payment-cost):/;

/** Repair and maintenance spending in the last twelve months, and in total. */
export function repairCosts(expenses: ReadonlyArray<AttributedExpense>, now: Date): { last12m: number; total: number; count: number } {
  const from = new Date(now.getTime() - YEAR).toISOString().slice(0, 10);
  let last12m = 0, total = 0, count = 0;
  for (const e of expenses) {
    if (e.tags.some((t) => FINANCING_TAG.test(t))) continue;
    if (!REPAIR_RE.test(`${e.description} ${e.category}`)) continue;
    total += e.share; count++;
    if (e.date && e.date.slice(0, 10) >= from) last12m += e.share;
  }
  return { last12m: Math.round(last12m), total: Math.round(total), count };
}

// ── The engine ───────────────────────────────────────────────────────────────

export interface LifecycleInput {
  now: Date;
  category: string;
  purchasePrice: number | null;
  purchaseDate: string | null;
  /** From the model year when there is no purchase date. */
  ageYears: number | null;
  currentValue: number | null;
  currentValueSource: "estimate" | "user" | "none";
  valuation?: { valuedAt: string | null; confidenceLabel: string | null; sources: string[] } | null;
  /** The AI's stored assumptions; typical ones are used when absent. */
  assumptions: LifecycleAssumptions | null;
  /** A salvage value the user typed (overrides the assumption). */
  userSalvage?: number | null;
  repairs12m?: number;
  /** Day the warranty ends, when on file. */
  warrantyEnds?: string | null;
  /** A loan secured by it (a linked liability): what is owed and its yearly rate as a percent. */
  loan?: { balance: number; ratePct: number | null; name?: string | null } | null;
}

export interface LifecycleRecommendation {
  action: LifecycleAction;
  label: string;
  /** One line: the decision and its money reason. */
  headline: string;
  reasons: string[];
}

export interface AssetLifecycle {
  applicable: boolean;
  notApplicableReason?: string;
  category: string;
  valueModel: LifecycleValueModel | null;
  currentValue: number | null;
  currentValueSource: LifecycleInput["currentValueSource"];
  purchasePrice: number | null;
  ageYears: number | null;
  /** Purchase price minus current value: positive = lost, negative = gained. */
  accumulatedDepreciation: number | null;
  /** Projected loss over the next twelve months (negative = gain). */
  depreciationNext12m: number | null;
  valueIn12m: number | null;
  salvage: { value: number | null; source: "user" | "ai" | "typical" | "none"; disposalCost: boolean };
  usefulLifeYears: number | null;
  remainingLifeYears: number | null;
  endOfLifeDate: string | null;
  sellingWindow: { start: string; end: string; status: "ahead" | "open" | "passed" } | null;
  replacementCost: { value: number | null; source: "ai" | "inflated_purchase" | "none" };
  recommendedReplacementDate: string | null;
  /**
   * The Optimal Disposal Point: the month from which owning it costs more,
   * per year, than it did on average up to then — selling (or replacing) then
   * is cheapest. Computed by `optimalDisposalPoint` from the AI's assumptions;
   * null when it gains or holds value, or a figure it needs is missing.
   */
  optimalDisposal: OptimalDisposal | null;
  repairVsReplace: { annualKeepCost: number; annualReplaceCost: number; favors: "keep" | "replace" } | null;
  recommendation: LifecycleRecommendation | null;
  confidence: LifecycleConfidence;
  assumptions: { source: "ai" | "typical"; basis: string; items: string[]; asOf: string | null; disposal: DisposalRoute };
  sources: string[];
  lastUpdated: { value: string | null; assumptions: string | null };
  /** Monthly projected values from today (the graph's dashed line). */
  projection: Array<{ at: string; value: number }>;
  missing: string[];
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

// ── The Optimal Disposal Point ───────────────────────────────────────────────
//
// "The point at which it makes more financial sense to sell or replace an
// asset than to continue owning it." (Owner, 2026-11-26.) The classic
// economic-life rule, month by month from today: the cost of keeping it one
// more month is the value it loses that month, its upkeep (rising as it
// ages), and what the money tied up in it could earn elsewhere
// (`OPPORTUNITY_RATE`). The average cost per year of keeping it N more months
// first falls (depreciation slows) and then rises (upkeep climbs); its lowest
// point is the optimal disposal point — keeping it past then costs more each
// year than it did on average. The AI chooses the inputs (rate, life,
// salvage, upkeep and its growth); this arithmetic chooses the date (LC1).

/** A yearly return the money in the asset could earn instead (cost of capital). */
export const OPPORTUNITY_RATE = 0.05;

export interface OptimalDisposal {
  /** The calendar day (first of the month it falls in). */
  date: string;
  /** Months from today (0 = now). */
  monthsFromNow: number;
  /** Why this date: the cost of owning starts rising, it reaches the end of its useful life, or it is already past its best. */
  reason: "cost_rises" | "cheaper_to_replace" | "end_of_life" | "now";
  /** What it should still fetch then. */
  valueAt: number;
  /** Average cost per year of owning it from now until then (lost value + upkeep + money tied up). */
  avgAnnualCost: number;
  /** What a year of owning it would cost just after that point. */
  costAfter: number | null;
  /** A new one's all-in cost per year (lost value, its own upkeep, money tied up), when a replacement price and life are known. */
  newAnnualCost: number | null;
  /** The upkeep figures used, per year now, and their source. */
  upkeepNow: number;
  upkeepGrowthPct: number;
  upkeepSource: "ai" | "repairs" | "typical";
  /** Every factor weighed, with its yearly cost now and in the year before the point, and where its figure came from. */
  factors: DisposalFactor[];
  /** Facts that shaped the point without being a yearly cost (warranty end, the loan gap, selling costs). */
  notes: string[];
}

export type DisposalFactorKey = "depreciation" | "upkeep" | "major_failure" | "carrying" | "capital" | "selling" | "efficiency";
export interface DisposalFactor {
  key: DisposalFactorKey;
  label: string;
  /** Yearly cost over the next twelve months. */
  now: number;
  /** Yearly cost over the twelve months before the point (equal to `now` when the point is within a year). */
  atPoint: number;
  source: "ai" | "typical" | "recorded" | "calculated" | "on_file";
  detail: string;
}

/** Share of routine repairs a warranty covers (maintenance is still yours); a major failure is covered whole. */
export const WARRANTY_REPAIR_COVER = 0.6;

/** One plain sentence for the point, for reasons and summaries. */
export function optimalDisposalSentence(od: OptimalDisposal): string {
  if (od.reason === "now") return `Optimal disposal point: now — owning it costs about ${money(od.costAfter ?? od.avgAnnualCost)} a year from here${od.newAnnualCost != null ? ` (a new one, all-in, about ${money(od.newAnnualCost)})` : ""}; it should fetch about ${money(od.valueAt)}.`;
  const when = monthYear(od.date);
  if (od.reason === "cheaper_to_replace") return `Optimal disposal point: ${when} — from then a year of owning it costs about ${money(od.costAfter ?? 0)}, more than a new one all-in (about ${money(od.newAnnualCost ?? 0)} a year); it should still fetch about ${money(od.valueAt)}.`;
  if (od.reason === "end_of_life") return `Optimal disposal point: ${when}, the end of its useful life — owning it gets cheaper each year until then; expect about ${money(od.valueAt)}.`;
  return `Optimal disposal point: ${when} — owning it averages about ${money(od.avgAnnualCost)} a year until then${od.costAfter != null ? ` and about ${money(od.costAfter)} a year after` : ""}; it should still fetch about ${money(od.valueAt)}.`;
}

export interface DisposalInputs {
  now: number;
  at: (years: number) => number;
  remainingYears: number | null;
  ageYears: number | null;
  upkeepNow: number;
  upkeepGrowth: number;
  upkeepSource: OptimalDisposal["upkeepSource"];
  /** A replacement's price, its useful life and end value — to price a new one ALL-IN, like this one. */
  replacement: number | null;
  lifeYears: number | null;
  newFloor: number;
  /** Major failure: cost, chance this year, yearly growth of the chance. */
  major: { cost: number; chance: number; growth: number; source: "ai" | "typical" };
  /** Insurance / tax / registration as a yearly share of value. */
  carrying: { pct: number; source: "ai" | "typical" };
  /** Selling / disposal cost as a share of the sale price; plus a flat disposal cost when it is worth nothing. */
  selling: { pct: number; disposalCost: number; source: "ai" | "typical" };
  /** Running cost a new one saves a year. */
  efficiency: { savings: number; source: "ai" | "typical" };
  /** Years from now the warranty runs (0 when none or ended). */
  warrantyYears: number;
  /** A secured loan: owed now and its yearly rate (decimal). */
  loan: { balance: number; rate: number } | null;
}

export function optimalDisposalPoint(args: DisposalInputs): OptimalDisposal | null {
  const { now, at, upkeepNow, upkeepGrowth, major, carrying, selling, efficiency, warrantyYears, loan } = args;
  const horizon = Math.max(1, Math.min(240, Math.round((args.remainingYears ?? 10) * 12)));
  // The money tied up in it: what a loan on it charges for the part it
  // finances, the opportunity rate for the rest.
  const capitalRate = (v: number) => {
    if (!(v > 0)) return 0;
    if (!loan || !(loan.balance > 0)) return OPPORTUNITY_RATE;
    const financed = Math.min(v, loan.balance);
    return (financed * Math.max(loan.rate, OPPORTUNITY_RATE) + (v - financed) * OPPORTUNITY_RATE) / v;
  };
  // Each month's cost, by factor.
  type Parts = Record<"depreciation" | "upkeep" | "major_failure" | "carrying" | "capital", number>;
  const parts: Parts[] = [];
  const monthly: number[] = [];
  for (let m = 1; m <= horizon; m++) {
    const t0 = (m - 1) / 12;
    const v0 = Math.max(0, at(t0)), v1 = Math.max(0, at(m / 12));
    const covered = t0 < warrantyYears;
    const p: Parts = {
      depreciation: Math.max(0, v0 - v1),
      upkeep: (upkeepNow / 12) * Math.pow(1 + upkeepGrowth, t0) * (covered ? 1 - WARRANTY_REPAIR_COVER : 1),
      major_failure: covered ? 0 : (Math.min(0.9, major.chance * Math.pow(1 + major.growth, t0)) * major.cost) / 12,
      carrying: (carrying.pct * v0) / 12,
      capital: (capitalRate(v0) * v0) / 12,
    };
    parts.push(p);
    monthly.push(p.depreciation + p.upkeep + p.major_failure + p.carrying + p.capital);
  }
  // Letting it go at month n costs the selling fees on what it fetches then
  // (or the disposal cost once it is worth nothing): part of the average.
  const sellCostAt = (m: number) => {
    const v = Math.max(0, at(m / 12));
    return v > 0 ? selling.pct * v : selling.disposalCost;
  };
  let cum = 0, best = Infinity, bestM = 0;
  for (let m = 1; m <= horizon; m++) {
    cum += monthly[m - 1];
    const avg = (cum + sellCostAt(m)) / m;
    if (avg < best - 1e-9) { best = avg; bestM = m; }
  }
  if (!Number.isFinite(best)) return null;
  const yearFrom = (m: number) => { const w = monthly.slice(m, m + 12); return w.length ? (w.reduce((a, b) => a + b, 0) / w.length) * 12 : 0; };
  let cheapest = 0;
  for (let m = 1; m < monthly.length; m++) if (monthly[m] < monthly[cheapest]) cheapest = m;
  // A new one priced the same way, every factor included: what it loses, its
  // own (lower) upkeep and failure risk after its warranty, insurance on its
  // higher value, the money in it, selling it at the end — less the running
  // cost it saves.
  let newAnnualCost: number | null = null;
  if (args.replacement && args.replacement > 0 && args.lifeYears && args.lifeYears > 0) {
    const R = args.replacement, L = Math.max(1, Math.round(args.lifeYears));
    const floorNew = Math.min(R, Math.max(0, args.newFloor));
    const ageNow = Math.max(0, args.ageYears ?? 0);
    const upkeepNew = upkeepNow / Math.pow(1 + upkeepGrowth, ageNow);
    const chanceNew = major.chance / Math.pow(1 + major.growth, ageNow);
    const majorNew = major.cost; // the same repair on the same kind of thing
    let running = 0;
    for (let y = 0; y < L; y++) {
      const newWarranty = y < 1; // a new one comes with at least a year's cover
      running += upkeepNew * Math.pow(1 + upkeepGrowth, y) * (newWarranty ? 1 - WARRANTY_REPAIR_COVER : 1);
      running += newWarranty ? 0 : Math.min(0.9, chanceNew * Math.pow(1 + major.growth, y)) * majorNew;
    }
    const avgValue = (R + floorNew) / 2;
    newAnnualCost = Math.round(
      (R - floorNew) / L + running / L + carrying.pct * avgValue + OPPORTUNITY_RATE * avgValue
      + (floorNew > 0 ? selling.pct * floorNew : selling.disposalCost) / L - efficiency.savings,
    );
  }
  let replaceM: number | null = null;
  if (newAnnualCost != null) {
    for (let m = cheapest; m < bestM; m++) if (Math.round(yearFrom(m)) > newAnnualCost) { replaceM = m; break; }
  }
  const pastLife = args.remainingYears === 0;
  const rising = pastLife || replaceM === 0 || (monthly.length > 1 && monthly[1] > monthly[0] && bestM <= 1);
  const reason: OptimalDisposal["reason"] = rising ? "now"
    : replaceM != null ? "cheaper_to_replace"
    : bestM >= horizon && args.remainingYears != null ? "end_of_life" : "cost_rises";
  const months = reason === "now" ? 0 : replaceM ?? bestM;
  const d = new Date(now + (months / 12) * YEAR);
  const date = months === 0 ? iso(now) : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const costTo = months ? (monthly.slice(0, months).reduce((a, b) => a + b, 0) / months) * 12 : monthly[0] * 12;
  const after = months < monthly.length ? yearFrom(months) : null;

  // The factors, as yearly figures: the next twelve months, and the twelve before the point.
  const yearly = (key: keyof Parts, from: number) => {
    const w = parts.slice(Math.max(0, from), Math.max(0, from) + 12);
    return w.length ? Math.round((w.reduce((a, p) => a + p[key], 0) / w.length) * 12) : 0;
  };
  const pre = Math.max(0, months - 12);
  const valueAt = Math.round(Math.max(0, at(months / 12)));
  const upkeepWord = args.upkeepSource === "repairs" ? "recorded" : args.upkeepSource;
  const factors: DisposalFactor[] = [
    { key: "depreciation", label: "Lost value", now: yearly("depreciation", 0), atPoint: yearly("depreciation", pre), source: "calculated", detail: "From the value projection (its rate, useful life and salvage value)." },
    { key: "upkeep", label: "Repairs & maintenance", now: yearly("upkeep", 0), atPoint: yearly("upkeep", pre), source: upkeepWord as DisposalFactor["source"],
      detail: `About ${money(upkeepNow)} a year now, rising ${Math.round(upkeepGrowth * 100)}% a year as it ages${warrantyYears > 0 ? `; the warranty covers about ${Math.round(WARRANTY_REPAIR_COVER * 100)}% of repairs until it ends` : ""}.` },
    { key: "major_failure", label: "Risk of a major failure", now: yearly("major_failure", 0), atPoint: yearly("major_failure", pre), source: major.source,
      detail: `A ${Math.round(major.chance * 100)}% chance this year of a ${money(major.cost)} repair, rising ${Math.round(major.growth * 100)}% a year${warrantyYears > 0 ? "; covered while under warranty" : ""}.` },
    { key: "carrying", label: "Insurance, tax & registration", now: yearly("carrying", 0), atPoint: yearly("carrying", pre), source: carrying.source,
      detail: carrying.pct > 0 ? `About ${Math.round(carrying.pct * 1000) / 10}% of its value a year — falls as it loses value.` : "None that scale with its value." },
    { key: "capital", label: "Money tied up in it", now: yearly("capital", 0), atPoint: yearly("capital", pre), source: loan ? "on_file" : "calculated",
      detail: loan ? `The loan on it charges ${Math.round(loan.rate * 1000) / 10}% on the ${money(loan.balance)} owed; ${Math.round(OPPORTUNITY_RATE * 100)}% on the rest.` : `What its value could earn elsewhere, ${Math.round(OPPORTUNITY_RATE * 100)}% a year.` },
    { key: "selling", label: "Cost of selling it", now: Math.round(sellCostAt(0)), atPoint: Math.round(sellCostAt(months)), source: selling.source,
      detail: valueAt > 0 ? `About ${Math.round(selling.pct * 100)}% of the sale price in fees, listing and prep — once, when you let it go.` : `Getting rid of it costs about ${money(selling.disposalCost)} — once.` },
  ];
  if (efficiency.savings > 0) factors.push({ key: "efficiency", label: "Running cost a new one saves", now: Math.round(efficiency.savings), atPoint: Math.round(efficiency.savings), source: efficiency.source, detail: "Energy or fuel a newer model would save each year — counted against replacing late." });

  const notes: string[] = [];
  if (warrantyYears > 0) {
    const w = new Date(now + warrantyYears * YEAR);
    notes.push(`Warranty runs until ${w.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}; repairs cost more after that.`);
  }
  if (loan && loan.balance > 0) {
    const worthNow = Math.round(Math.max(0, at(0)));
    notes.push(loan.balance > worthNow
      ? `${money(loan.balance)} is owed on it — more than it is worth today (${money(worthNow)}). Selling before the loan is paid down below its value means covering the difference.`
      : `${money(loan.balance)} is owed on it; selling pays that off and stops the interest${loan.rate > 0 ? ` (${Math.round(loan.rate * 1000) / 10}%)` : ""}.`);
  }
  return {
    date, monthsFromNow: months, reason,
    valueAt,
    avgAnnualCost: Math.round(costTo),
    costAfter: after != null ? Math.round(after) : null,
    newAnnualCost,
    upkeepNow: Math.round(upkeepNow), upkeepGrowthPct: Math.round(upkeepGrowth * 1000) / 1000, upkeepSource: args.upkeepSource,
    factors, notes,
  };
}
/** "Jan 2029" — a calendar month for sentences (never a raw ISO date). */
const monthYear = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
/** The headline without its "Action —" prefix, capitalised, for a row that already shows the action. */
export function headlineReason(headline: string): string {
  const rest = headline.replace(/^[^—]+—\s*/, "");
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}
export function money(n: number): string {
  const r = Math.round(Math.abs(n));
  return `${n < 0 ? "-" : ""}$${r.toLocaleString("en-US")}`;
}
const yrs = (n: number) => (n < 1 ? `${Math.max(1, Math.round(n * 12))} months` : `${Math.round(n * 10) / 10} years`);
const RANK: Record<LifecycleConfidence, number> = { low: 0, medium: 1, high: 2 };

function projector(model: LifecycleValueModel, V: number, floor: number, remaining: number | null, rate: number | null) {
  if (model === "appreciating") { const g = rate != null && rate > 0 ? rate : 0.03; return (t: number) => V * Math.pow(1 + g, t); }
  if (model === "stable" || V <= floor) return () => V;
  if (remaining != null && remaining <= 0) return () => V;
  if (remaining != null) {
    const q = rate != null && rate < 0 ? 1 + rate : Math.pow(0.1, 1 / remaining);
    const qR = Math.pow(q, remaining);
    if (!(qR < 1)) return (t: number) => (t >= remaining ? floor : V - (V - floor) * (t / remaining));
    return (t: number) => (t >= remaining ? floor : floor + (V - floor) * (Math.pow(q, t) - qR) / (1 - qR));
  }
  const q = rate != null && rate < 0 ? 1 + rate : 0.85;
  return (t: number) => floor + (V - floor) * Math.pow(q, t);
}

/** The lifecycle of one asset, from its assumptions and its records. Pure. */
export function computeAssetLifecycle(input: LifecycleInput): AssetLifecycle {
  const now = input.now.getTime();
  const P = input.purchasePrice && input.purchasePrice > 0 ? input.purchasePrice : null;
  const V = input.currentValue && input.currentValue > 0 ? input.currentValue : null;
  const purchaseT = input.purchaseDate && /^\d{4}-\d{2}-\d{2}/.test(input.purchaseDate) ? Date.parse(`${input.purchaseDate.slice(0, 10)}T12:00:00Z`) : NaN;
  const age = Number.isFinite(purchaseT) ? Math.max(0, (now - purchaseT) / YEAR) : input.ageYears;
  const startT = Number.isFinite(purchaseT) ? purchaseT : age != null ? now - age * YEAR : NaN;
  const typical = typicalAssumptions(input.category, P);
  const a = input.assumptions ?? typical;
  const missing: string[] = [];
  if (!P) missing.push("purchase price");
  if (age == null) missing.push("purchase date or model year");
  if (!V) missing.push("current value");

  const base: AssetLifecycle = {
    applicable: false, category: input.category, valueModel: a?.valueModel ?? null,
    currentValue: V, currentValueSource: input.currentValueSource, purchasePrice: P, ageYears: age == null ? null : Math.round(age * 10) / 10,
    accumulatedDepreciation: P && V ? Math.round(P - V) : null, depreciationNext12m: null, valueIn12m: null,
    salvage: { value: null, source: "none", disposalCost: false }, usefulLifeYears: null, remainingLifeYears: null, endOfLifeDate: null,
    sellingWindow: null, replacementCost: { value: null, source: "none" }, recommendedReplacementDate: null, optimalDisposal: null, repairVsReplace: null,
    recommendation: null, confidence: "low",
    assumptions: { source: a?.source ?? "typical", basis: a?.basis ?? "", items: a?.assumptions ?? [], asOf: a?.asOf ?? null, disposal: a?.disposal ?? "none" },
    sources: input.valuation?.sources ?? [], lastUpdated: { value: input.valuation?.valuedAt ?? null, assumptions: a?.asOf ?? null },
    projection: [], missing,
  };
  if (!a) return { ...base, notApplicableReason: "Its value is a market price or a balance, not something that wears out." };
  if (!V && !P) return { ...base, notApplicableReason: "Add a purchase price, or let Portol estimate its value, to see its lifecycle." };

  const value = V ?? P!;
  const model = a.valueModel;
  // Salvage: the user's figure, else the assumption's.
  const userSalvage = input.userSalvage != null && Number.isFinite(input.userSalvage) ? input.userSalvage : null;
  const salvageValue = model !== "depreciating" ? null : userSalvage ?? a.salvageValue;
  const salvageSource = model !== "depreciating" ? "none" : userSalvage != null ? "user" : a.salvageValue != null ? a.source : "none";
  const floor = Math.max(0, salvageValue ?? 0);
  const life = model === "depreciating" ? a.usefulLifeYears : null;
  const remaining = life != null && age != null ? Math.round((life - age) * 10) / 10 : null;
  const endT = life != null && Number.isFinite(startT) ? startT + life * YEAR : NaN;

  const at = projector(model, value, floor, remaining, a.annualChangePct);
  const horizon = model === "depreciating" ? Math.min(10, Math.max(2, Math.ceil((remaining ?? 5) + 0.5))) : 5;
  const projection: Array<{ at: string; value: number }> = [];
  for (let m = 0; m <= horizon * 12; m++) projection.push({ at: new Date(now + (m / 12) * YEAR).toISOString(), value: Math.round(at(m / 12)) });
  const in12 = Math.round(at(1));
  const dep12 = Math.round(value - in12);

  let window: AssetLifecycle["sellingWindow"] = null;
  if (model === "depreciating" && life != null && Number.isFinite(startT) && value > floor) {
    const ws = startT + 0.6 * life * YEAR, we = startT + 0.85 * life * YEAR;
    window = { start: iso(ws), end: iso(we), status: now < ws ? "ahead" : now <= we ? "open" : "passed" };
  }

  const replacement = a.replacementCost != null && a.replacementCost > 0
    ? { value: a.replacementCost, source: "ai" as const }
    : P && model === "depreciating" ? { value: Math.round(P * Math.pow(1.03, age ?? 0)), source: "inflated_purchase" as const } : { value: null, source: "none" as const };

  const repairs = Math.max(0, input.repairs12m ?? 0);
  let rvr: AssetLifecycle["repairVsReplace"] = null;
  if (model === "depreciating" && life != null && replacement.value) {
    const newFloor = P && salvageValue != null ? Math.max(0, (salvageValue / P) * replacement.value) : floor;
    const annualReplaceCost = Math.round(Math.max(0, replacement.value - newFloor) / life);
    const annualKeepCost = Math.round(repairs + Math.max(0, dep12));
    const favors = repairs > 0 && (annualKeepCost > annualReplaceCost || repairs >= 0.5 * value) ? "replace" : "keep";
    rvr = { annualKeepCost, annualReplaceCost, favors };
  }

  // The Optimal Disposal Point (depreciating things only: something that gains
  // or holds its value has no money reason to be let go).
  let optimalDisposal: OptimalDisposal | null = null;
  if (model === "depreciating" && (remaining == null || remaining > 0 || value > floor)) {
    const tu = typicalUpkeep(input.category);
    const growth = a.upkeepGrowthPct ?? tu.growth;
    const priceBase = replacement.value ?? P ?? value;
    const typicalNow = priceBase * tu.share * Math.pow(1 + growth, Math.max(0, age ?? 0));
    const upkeepSource: OptimalDisposal["upkeepSource"] = repairs > 0 && repairs >= (a.annualUpkeep ?? 0) ? "repairs" : a.annualUpkeep != null ? "ai" : "typical";
    const upkeepNow = upkeepSource === "repairs" ? repairs : upkeepSource === "ai" ? a.annualUpkeep! : typicalNow;
    const td = typicalDisposalFactors(input.category);
    const base = replacement.value ?? P ?? value;
    const src = (v: unknown) => (v != null ? "ai" : "typical") as "ai" | "typical";
    const warrantyT = input.warrantyEnds ? Date.parse(`${input.warrantyEnds.slice(0, 10)}T12:00:00Z`) : NaN;
    const loan = input.loan && input.loan.balance > 0 ? { balance: input.loan.balance, rate: Math.max(0, (input.loan.ratePct ?? 0) / 100) } : null;
    optimalDisposal = optimalDisposalPoint({
      now, at, remainingYears: remaining != null ? Math.max(0, remaining) : null, ageYears: age,
      upkeepNow, upkeepGrowth: growth, upkeepSource,
      replacement: replacement.value, lifeYears: life,
      newFloor: replacement.value && P && salvageValue != null ? (salvageValue / P) * replacement.value : floor,
      major: {
        cost: a.majorRepairCost ?? Math.round(base * td.majorShare),
        chance: a.majorFailureChancePct ?? Math.min(0.9, td.failChance * Math.pow(1 + td.failGrowth, Math.max(0, age ?? 0))),
        growth: a.majorFailureChanceGrowthPct ?? td.failGrowth,
        source: src(a.majorRepairCost ?? a.majorFailureChancePct),
      },
      carrying: { pct: a.carryingCostPct ?? td.carrying, source: src(a.carryingCostPct) },
      selling: { pct: a.sellingCostPct ?? td.selling, disposalCost: salvageValue != null && salvageValue < 0 ? -salvageValue : 0, source: src(a.sellingCostPct) },
      efficiency: { savings: a.newEfficiencySavings ?? Math.round(base * td.savingsShare), source: src(a.newEfficiencySavings) },
      warrantyYears: Number.isFinite(warrantyT) && warrantyT > now ? (warrantyT - now) / YEAR : 0,
      loan,
    });
  }

  // Confidence: the weaker of the value's and the assumptions'.
  const valConf: LifecycleConfidence = input.currentValueSource === "user" ? "medium"
    : input.valuation?.confidenceLabel === "high" ? "high" : input.valuation?.confidenceLabel === "medium" ? "medium" : "low";
  const confidence: LifecycleConfidence = !V ? "low" : RANK[valConf] < RANK[a.confidence] ? valConf : a.confidence;

  // ── The recommendation ──
  const reasons: string[] = [];
  let action: LifecycleAction = "keep";
  let headline = "";
  const salvageWords = salvageValue == null ? "" : salvageValue < 0 ? `getting rid of it costs about ${money(-salvageValue)}` : `about ${money(salvageValue)} at the end of its life`;
  const warrantyDays = input.warrantyEnds ? Math.round((Date.parse(`${input.warrantyEnds.slice(0, 10)}T12:00:00Z`) - now) / DAY) : null;
  if (model === "appreciating") {
    const g = Math.round(((a.annualChangePct ?? 0.03)) * 1000) / 10;
    action = "keep";
    headline = `Keep — expected to gain about ${g}% a year (${money(in12 - value)} over the next year).`;
    reasons.push(`Worth ${money(value)} now; projected ${money(in12)} in a year.`);
  } else if (model === "stable") {
    action = "keep";
    headline = "Keep — it tends to hold its value, so there is no cost to waiting.";
    reasons.push(`Worth ${money(value)} now, and not expected to lose value with age.`);
  } else if (remaining != null && remaining <= 0) {
    if (floor <= 0 || value <= floor) {
      action = "dispose";
      headline = `Dispose / Recycle — past its ${life}-year useful life and worth little beyond ${salvageValue != null && salvageValue < 0 ? "a disposal cost" : "scrap"}.`;
    } else {
      action = "replace";
      headline = `Replace — it has reached the end of its ${life}-year useful life.`;
    }
    reasons.push(`About ${yrs(age!)} old against a typical life of ${life} years.`);
    if (salvageWords) reasons.push(`End-of-life value: ${salvageWords}.`);
    if (replacement.value) reasons.push(`A replacement costs about ${money(replacement.value)}.`);
  } else if (rvr?.favors === "replace") {
    action = "replace";
    headline = `Replace — keeping it costs about ${money(rvr.annualKeepCost)} a year against ${money(rvr.annualReplaceCost)} a year for a new one.`;
    reasons.push(`${money(repairs)} spent on repairs and maintenance in the last 12 months.`);
    reasons.push(`It will lose about ${money(Math.max(0, dep12))} more value this year.`);
    reasons.push(`A new one costs about ${money(replacement.value!)} and lasts about ${life} years.`);
  } else if (window?.status === "open" && value - floor >= Math.max(50, 0.1 * (P ?? value))) {
    action = "consider_selling";
    headline = `Consider Selling — it is in its best selling window (until ${monthYear(window.end)}); it should still fetch about ${money(value)}.`;
    reasons.push(`Projected to lose about ${money(Math.max(0, dep12))} over the next year${salvageValue != null ? ` and fall toward ${salvageWords}` : ""}.`);
    if (remaining != null) reasons.push(`About ${yrs(remaining)} of useful life left.`);
  } else if (value <= floor && floor <= 0 && P) {
    action = "dispose";
    headline = "Dispose / Recycle — it has no resale value left.";
    reasons.push(`Worth ${money(value)} against ${money(P)} paid.`);
  } else {
    const windowSoon = window?.status === "ahead" && Date.parse(`${window.start}T12:00:00Z`) - now <= YEAR;
    const warrantySoon = warrantyDays != null && warrantyDays >= 0 && warrantyDays <= 90;
    const lifeSoon = remaining != null && remaining <= 1;
    if (windowSoon || warrantySoon || lifeSoon) {
      action = "monitor";
      headline = warrantySoon ? `Monitor — the warranty ends in ${warrantyDays} days; repairs after that are yours.`
        : lifeSoon ? `Monitor — about ${yrs(Math.max(0, remaining!))} of useful life left.`
        : `Monitor — its best selling window opens in ${monthYear(window!.start)}.`;
    } else {
      action = "keep";
      headline = remaining != null
        ? `Keep — about ${yrs(remaining)} of useful life left${dep12 > 0 ? `; it loses about ${money(dep12)} this year` : ""}.`
        : `Keep — it loses about ${money(Math.max(0, dep12))} over the next year.`;
    }
    if (remaining != null) reasons.push(`About ${yrs(age!)} old with a typical life of ${life} years.`);
    if (dep12 > 0) reasons.push(`Projected value in a year: ${money(in12)}.`);
    if (window && window.status !== "passed") reasons.push(`Best time to sell: ${monthYear(window.start)} to ${monthYear(window.end)}.`);
    // The optimal disposal point already weighs keeping against a new one, all-in.
    if (rvr && !optimalDisposal) reasons.push(`Keeping it costs about ${money(rvr.annualKeepCost)} a year; a new one about ${money(rvr.annualReplaceCost)} a year.`);
  }
  if (optimalDisposal) reasons.splice(Math.min(1, reasons.length), 0, optimalDisposalSentence(optimalDisposal));
  // Typical figures for an unrecognised item are not enough to tell anyone to sell or replace.
  if (a.source === "typical" && input.category === "generic" && SIGNIFICANT_ACTIONS.has(action)) {
    reasons.unshift(`Typical figures suggest: ${LIFECYCLE_ACTION_LABEL[action]}.`);
    action = "monitor";
    headline = "Monitor — Portol has only typical figures for this item; a closer estimate comes with its next valuation.";
  }
  if (a.source === "typical") reasons.push("Based on typical figures for its category until Portol analyses it.");

  const recommendedReplacementDate = model !== "depreciating" ? null
    : action === "replace" || action === "dispose" ? iso(now)
    : Number.isFinite(endT) ? iso(endT) : null;

  return {
    ...base,
    applicable: true,
    valueModel: model,
    depreciationNext12m: dep12,
    valueIn12m: in12,
    salvage: { value: salvageValue ?? null, source: salvageSource as any, disposalCost: (salvageValue ?? 0) < 0 },
    usefulLifeYears: life,
    remainingLifeYears: remaining,
    endOfLifeDate: Number.isFinite(endT) ? iso(endT) : null,
    sellingWindow: window,
    replacementCost: replacement,
    recommendedReplacementDate,
    optimalDisposal,
    repairVsReplace: rvr,
    recommendation: { action, label: LIFECYCLE_ACTION_LABEL[action], headline, reasons: reasons.slice(0, 5) },
    confidence,
    projection,
  };
}

/** The id a lifecycle notice is dismissed under: one per asset and recommendation. */
export function lifecycleAlertId(profileId: string, action: LifecycleAction): string {
  return `lifecycle:${profileId}:${action}`;
}

/** One asset's row in GET /api/assets/lifecycle (server/asset-lifecycle-service.ts). */
export interface LifecycleRow {
  profileId: string;
  name: string;
  parentProfileId: string | null;
  lifecycle: AssetLifecycle;
  repairs: { last12m: number; total: number; count: number };
  /** Descendants' own figures, summed once (null when it has none). */
  nested: { count: number; value: number; depreciationNext12m: number } | null;
}

/**
 * Needs Attention rows for SIGNIFICANT recommendations only (Consider
 * Selling, Replace, Dispose / Recycle), derived on read (Rule 5) — no task,
 * no stored flag, no repeated notification. A row is dismissed under
 * `lifecycleAlertId`, one id per asset AND recommendation, into the server's
 * dismissed list (Rule 8): it stays gone until restored, and a DIFFERENT
 * recommendation later is a new row. Nothing here ever sells, disposes of or
 * deletes anything — the row opens the asset.
 */
export function lifecycleAttentionItems(
  rows: ReadonlyArray<Pick<LifecycleRow, "profileId" | "name" | "lifecycle">>,
  dismissedIds: ReadonlyArray<string> | ReadonlySet<string>,
  now: Date = new Date(),
): AttentionItem[] {
  const dismissed = dismissedIds instanceof Set ? dismissedIds : new Set(dismissedIds as ReadonlyArray<string>);
  const out: AttentionItem[] = [];
  for (const r of rows) {
    const rec = r.lifecycle.applicable ? r.lifecycle.recommendation : null;
    if (!rec || !SIGNIFICANT_ACTIONS.has(rec.action)) continue;
    const id = lifecycleAlertId(r.profileId, rec.action);
    if (dismissed.has(id)) continue;
    // Advice for now, not a deadline: no date chip (a window ending in four
    // years read as a red "Jan 30" beside expirations).
    const daysUntil = 0;
    out.push({
      key: id,
      sourceKey: `lifecycle:${r.profileId}`,
      kind: "alert",
      title: `${r.name}: ${rec.label}`,
      reason: headlineReason(rec.headline),
      tier: rec.action === "consider_selling" ? "upcoming" : "soon",
      daysUntil,
      score: rec.action === "replace" ? 70 : rec.action === "dispose" ? 60 : 50,
      href: `/profiles/${r.profileId}`,
      action: { kind: "open", label: "Open" },
      dismissIds: [id],
    } as AttentionItem);
  }
  return out;
}

/**
 * The portfolio view Finance shows: what the owned assets are projected to
 * lose (or gain) over the next twelve months, and how many carry a
 * significant recommendation. Every row is ONE asset's own figures (nested
 * assets are their own rows), so the sum counts nothing twice.
 */
export function summarizeLifecycles(rows: ReadonlyArray<Pick<LifecycleRow, "profileId" | "name" | "lifecycle">>): {
  depreciationNext12m: number; appreciationNext12m: number; assets: number; significant: number;
  biggestLosers: Array<{ profileId: string; name: string; loss: number }>;
} {
  let dep = 0, gain = 0, assets = 0, significant = 0;
  const losers: Array<{ profileId: string; name: string; loss: number }> = [];
  for (const r of rows) {
    const l = r.lifecycle;
    if (!l.applicable || l.depreciationNext12m == null) continue;
    assets++;
    if (l.depreciationNext12m > 0) { dep += l.depreciationNext12m; losers.push({ profileId: r.profileId, name: r.name, loss: l.depreciationNext12m }); }
    else gain += -l.depreciationNext12m;
    if (l.recommendation && SIGNIFICANT_ACTIONS.has(l.recommendation.action)) significant++;
  }
  losers.sort((a, b) => b.loss - a.loss);
  return { depreciationNext12m: Math.round(dep), appreciationNext12m: Math.round(gain), assets, significant, biggestLosers: losers.slice(0, 3) };
}
