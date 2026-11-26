// ─── The Optimal Disposal Point: an economic decision model ─────────────────
//
// Owner, 2026-11-26: "Rebuild the optimal disposal calculation as an
// independent, intelligent AI-powered economic decision model. It must not
// copy, reuse, or default to the salvage value … compare the projected
// financial cost of continuing ownership against selling or replacing the
// asset at different future intervals … determine the most economically
// advantageous time to dispose of the asset, the estimated market value at
// that time, and whether the owner should sell now or continue ownership."
//
// How the work is split (LC1): the AI, during the value-tracking run, studies
// THIS asset — its market, condition, usage, repair history, reliability —
// and chooses the inputs: the resale values it expects at future intervals
// (`resaleRetention`, a curve of its own, never the salvage value), the
// repairs it anticipates, upkeep and failure risk, carrying and selling
// costs, market demand, a replacement's price and a plain explanation. This
// module is the arithmetic that decides, month by month:
//
//   * the MARKET VALUE path is the AI's curve, scaled to today's value, so a
//     new valuation re-prices the plan without asking the AI again;
//   * the cost of KEEPING it one more year from month m is what its resale
//     value drops (net of selling costs) plus every running cost that year;
//   * the cost of the alternative is a replacement's equivalent annual cost,
//     priced the same way (its own depreciation, upkeep, failure risk after
//     its warranty, insurance, the money in it, selling it at the end, less
//     the running cost it saves);
//   * the point is the first month keeping it costs more than replacing it;
//     with no replacement in view, the month its average yearly cost is
//     lowest. Either way it is bounded by its ECONOMIC end — the month a
//     year of owning it would cost more than it would still sell for above
//     scrap — and it is never a month whose value is at or near the salvage
//     value (`salvageGuard`): a disposal value is always a market value
//     above it.
//
// The answer carries a range (the same model under a pessimistic and an
// optimistic reading of its inputs, wider when less is known), a confidence
// built from what is on file, and the information that would sharpen it.
// Nothing here calls a model or reads storage; it is recomputed on every read
// from the records (Rule 5), so a new repair, mileage, condition or valuation
// moves it at once.

const DAY = 86_400_000;
const YEAR = 365.25 * DAY;

/** A yearly return the money in the asset could earn instead (cost of capital). */
export const OPPORTUNITY_RATE = 0.05;
/** Share of routine repairs a warranty covers (maintenance is still yours); a major failure is covered whole. */
export const WARRANTY_REPAIR_COVER = 0.6;

export type Confidence = "high" | "medium" | "low";
export type MarketDemand = "high" | "normal" | "low";
export type DisposalReason = "sell_now" | "cheaper_to_replace" | "costs_rise" | "economic_end" | "horizon";
export type DisposalFactorKey = "depreciation" | "upkeep" | "anticipated" | "major_failure" | "carrying" | "capital" | "selling" | "efficiency";

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

export interface ResalePoint { years: number; ratio: number }
export interface AnticipatedRepair { item: string; inYears: number; cost: number }

export interface OptimalDisposal {
  /** Recommended disposal day (today when selling now; else the first of the month). */
  date: string;
  monthsFromNow: number;
  reason: DisposalReason;
  /** Sell now, or keep it until `date`. */
  decision: "sell_now" | "keep";
  /** The market value expected at the point — always above the salvage value. */
  valueAt: number;
  /** What selling then leaves after fees, listing and prep. */
  netProceeds: number;
  currentValue: number;
  /** Years of ECONOMIC life left: until the point. */
  remainingEconomicLifeYears: number;
  /** What it is expected to lose from today until the point. */
  projectedDepreciation: number;
  /** Average yearly cost of keeping it until the point (lost resale value + every running cost). */
  avgAnnualCost: number;
  /** What a year of keeping it would cost right after the point. */
  costAfter: number | null;
  /** A replacement's equivalent annual cost, all-in, when a replacement price is known or estimated. */
  newAnnualCost: number | null;
  replacementCost: number | null;
  replacementSource: "ai" | "inflated_purchase" | "estimated" | "none";
  /** The same model under a pessimistic and an optimistic reading of its inputs. */
  range: { dateLow: string; dateHigh: string; valueLow: number; valueHigh: number };
  confidence: Confidence;
  /** 0–100, from what is on file. */
  confidenceScore: number;
  /** True when too little is known for one figure: screens show the range first. */
  estimated: boolean;
  /** What would sharpen it, in plain words. */
  missing: string[];
  /** Where the market-value path came from. */
  curveSource: "ai" | "category";
  marketDemand: MarketDemand | null;
  /** The AI's explanation of this asset's situation (no figures of its own), and the model's plain summary. */
  explanation: { ai: string | null; summary: string };
  /** Selling at each future interval, compared: its value then and the yearly cost of keeping it until then. */
  schedule: Array<{ years: number; value: number; keepCostPerYear: number }>;
  upkeepNow: number;
  upkeepGrowthPct: number;
  upkeepSource: "ai" | "repairs" | "typical";
  factors: DisposalFactor[];
  notes: string[];
}

// ── The AI's curve and repairs, checked ──────────────────────────────────────

function finite(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) { const n = Number(v.replace(/[$,\s%]/g, "")); return Number.isFinite(n) ? n : null; }
  return null;
}

/**
 * The AI's resale curve as RATIOS of today's value. It arrives either as
 * dollars (`resaleCurve: [{years, value}]`, from the model, converted against
 * the value it was given) or already as ratios (`resaleRetention`, read back
 * from storage). Points out of bounds are dropped, a point that RISES more
 * than 5 % above the one before is dropped for something that depreciates,
 * and fewer than two usable points refuse the curve (null).
 */
export function sanitizeResaleCurve(
  raw: { resaleCurve?: unknown; resaleRetention?: unknown },
  base: number | null,
  depreciating: boolean,
): ResalePoint[] | null {
  let pts: ResalePoint[] = [];
  if (Array.isArray(raw.resaleRetention)) {
    for (const p of raw.resaleRetention as any[]) {
      const years = finite(p?.years), ratio = finite(p?.ratio);
      if (years != null && ratio != null) pts.push({ years, ratio });
    }
  } else if (Array.isArray(raw.resaleCurve) && base && base > 0) {
    for (const p of raw.resaleCurve as any[]) {
      const years = finite(p?.years ?? p?.inYears), value = finite(p?.value);
      if (years != null && value != null) pts.push({ years, ratio: value / base });
    }
  }
  pts = pts.filter((p) => p.years >= 0.25 && p.years <= 30 && p.ratio >= 0 && p.ratio <= 1.5).sort((a, b) => a.years - b.years);
  const out: ResalePoint[] = [];
  let prev = 1;
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1].years - p.years) < 0.05) continue;
    if (depreciating && p.ratio > prev * 1.05) continue;
    out.push({ years: Math.round(p.years * 100) / 100, ratio: Math.round(p.ratio * 10000) / 10000 });
    prev = p.ratio;
    if (out.length >= 12) break;
  }
  return out.length >= 2 ? out : null;
}

export function sanitizeAnticipatedRepairs(raw: unknown, ceiling: number): AnticipatedRepair[] | null {
  if (raw === null) return null;
  if (!Array.isArray(raw)) return null;
  const max = Math.max(ceiling * 1.5, 1_000);
  const out: AnticipatedRepair[] = [];
  for (const r of raw as any[]) {
    const inYears = finite(r?.inYears ?? r?.years), cost = finite(r?.cost);
    const item = typeof r?.item === "string" ? r.item.trim().replace(/\s+/g, " ").slice(0, 60) : "";
    if (!item || inYears == null || cost == null || inYears < 0 || inYears > 25 || cost <= 0 || cost > max) continue;
    out.push({ item, inYears: Math.round(inYears * 100) / 100, cost: Math.round(cost) });
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * The AI's explanation, kept to words: a sentence that states any number of
 * its own (a price, a year, "within 1–2 years") is dropped, so the text can
 * never disagree with the date and figures the model computed (Rule 1).
 */
export function sanitizeDisposalReasoning(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return null;
  const kept = (text.match(/[^.!?]+[.!?]*/g) || [text])
    .map((s) => s.trim())
    // Any number at all (a price, a year, "within 1–2 years") is the model's to state.
    .filter((s) => s && !/\d/.test(s));
  const out = kept.join(" ").slice(0, 500).trim();
  return out || null;
}

/** Today's value along the AI's curve: log-linear between its points, its last segment's pace beyond them. */
export function curveFromRetention(points: ResalePoint[], value: number): (years: number) => number {
  const pts = [{ years: 0, ratio: 1 }, ...points];
  return (t: number) => {
    if (t <= 0) return value;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (t <= b.years) {
        const f = (t - a.years) / (b.years - a.years);
        if (a.ratio > 0 && b.ratio > 0) return value * a.ratio * Math.pow(b.ratio / a.ratio, f);
        return value * (a.ratio + (b.ratio - a.ratio) * f);
      }
    }
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    const span = b.years - a.years;
    const pace = a.ratio > 0 && b.ratio > 0 && span > 0 ? Math.min(1, Math.pow(b.ratio / a.ratio, 1 / span)) : 1;
    return value * b.ratio * Math.pow(pace, t - b.years);
  };
}

// ── The decision ─────────────────────────────────────────────────────────────

export interface DisposalModelInput {
  now: number;
  currentValue: number;
  /** For the guard only: the disposal value is always a market value above it. */
  salvage: number | null;
  /** The market-value path from today (dollars at `years` from now). */
  curve: (years: number) => number;
  curveSource: "ai" | "category";
  remainingYears: number | null;
  ageYears: number | null;
  lifeYears: number | null;
  upkeep: { now: number; growth: number; source: OptimalDisposal["upkeepSource"] };
  major: { cost: number; chance: number; growth: number; source: "ai" | "typical" };
  carrying: { pct: number; source: "ai" | "typical" };
  selling: { pct: number; disposalCost: number; source: "ai" | "typical" };
  efficiency: { savings: number; source: "ai" | "typical" };
  anticipated: AnticipatedRepair[];
  warrantyYears: number;
  loan: { balance: number; rate: number } | null;
  replacement: { cost: number | null; source: OptimalDisposal["replacementSource"]; lifeYears: number | null; yearlyChange: number; endShare: number };
  marketDemand: MarketDemand | null;
  aiReasoning: string | null;
  confidence: {
    assumptions: "ai" | "typical";
    aiConfidence: Confidence;
    valueSource: "estimate" | "user" | "none";
    valueConfidence: string | null;
    hasAge: boolean;
    hasPurchasePrice: boolean;
    usageExpected: boolean;
    hasUsage: boolean;
    hasCondition: boolean;
    maintenanceExpected: boolean;
    maintenanceRecords: number;
  };
}

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const monthDate = (now: number, months: number) => {
  if (months <= 0) return iso(now);
  const d = new Date(now + (months / 12) * YEAR);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
};
const monthYear = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const span = (months: number) => (months < 12 ? `${Math.max(1, months)} month${months === 1 ? "" : "s"}` : `${Math.round((months / 12) * 10) / 10} years`);

/** The lowest value a disposal point may have: comfortably above the salvage value (never at it). */
export function salvageGuard(salvage: number | null, currentValue: number): number {
  return Math.max(0, salvage ?? 0) + Math.max(0.05 * currentValue, 25);
}

type Parts = Record<"depreciation" | "upkeep" | "anticipated" | "major_failure" | "carrying" | "capital", number>;

interface Solved {
  months: number;
  reason: DisposalReason;
  valueAt: number;
  avg: number;
  after: number | null;
  newAnnualCost: number | null;
  parts: Parts[];
  monthly: number[];
  value: (m: number) => number;
  sellCostAt: (m: number) => number;
  keepCostTo: (m: number) => number;
}

function solve(inp: DisposalModelInput, curveExp: number, costScale: number): Solved {
  const { now, currentValue: V0, upkeep, major, carrying, selling, efficiency, warrantyYears, loan } = inp;
  const s = Math.min(0.5, Math.max(0, selling.pct));
  const value = (m: number) => {
    const v = Math.max(0, inp.curve(m / 12));
    return curveExp === 1 || V0 <= 0 ? v : V0 * Math.pow(Math.max(0, v / V0), curveExp);
  };
  const H = Math.max(24, Math.min(240, Math.round(Math.max(inp.remainingYears ?? 8, 2) * 12) + 12));
  const capitalRate = (v: number) => {
    if (!(v > 0)) return 0;
    if (!loan || !(loan.balance > 0)) return OPPORTUNITY_RATE;
    const financed = Math.min(v, loan.balance);
    return (financed * Math.max(loan.rate, OPPORTUNITY_RATE) + (v - financed) * OPPORTUNITY_RATE) / v;
  };
  const parts: Parts[] = [];
  const monthly: number[] = [];
  for (let m = 1; m <= H + 12; m++) {
    const t0 = (m - 1) / 12;
    const v0 = value(m - 1), v1 = value(m);
    const covered = t0 < warrantyYears;
    const anticipated = inp.anticipated.reduce((a, r) => a + (Math.max(1, Math.ceil(r.inYears * 12)) === m ? r.cost : 0), 0);
    const p: Parts = {
      depreciation: Math.max(0, v0 - v1),
      upkeep: costScale * (upkeep.now / 12) * Math.pow(1 + upkeep.growth, t0) * (covered ? 1 - WARRANTY_REPAIR_COVER : 1),
      anticipated: costScale * anticipated * (covered ? 1 - WARRANTY_REPAIR_COVER : 1),
      major_failure: covered ? 0 : costScale * (Math.min(0.9, major.chance * Math.pow(1 + major.growth, t0)) * major.cost) / 12,
      carrying: (carrying.pct * v0) / 12,
      capital: (capitalRate(v0) * v0) / 12,
    };
    parts.push(p);
    // Running costs only: the drop in resale value is counted net of selling costs below.
    monthly.push(p.upkeep + p.anticipated + p.major_failure + p.carrying + p.capital);
  }
  const sum = (from: number, to: number) => { let t = 0; for (let m = from; m < to; m++) t += monthly[m] ?? 0; return t; };
  const sellCostAt = (m: number) => { const v = value(m); return v > 0 ? s * v : selling.disposalCost; };
  // Cost of keeping it from now to month t, then selling: the resale value it
  // gives up (net of selling costs) plus every running cost in between.
  const keepCostTo = (t: number) => (V0 - value(t)) * (1 - s) + sum(0, t);
  // A year of keeping it from month m.
  const marginal = (m: number) => (value(m) - value(m + 12)) * (1 - s) + sum(m, m + 12);

  // Never a point at or near the salvage value.
  const guard = salvageGuard(inp.salvage, V0);
  let lastValid = 0;
  for (let m = 1; m <= H; m++) { if (value(m) > guard) lastValid = m; else break; }
  // Its economic end: a year of owning it would cost more than it would still sell for above scrap.
  let economicEnd: number | null = null;
  for (let m = 0; m <= lastValid; m++) {
    if (sum(m, m + 12) >= (value(m) - Math.max(0, inp.salvage ?? 0)) * (1 - s)) { economicEnd = m; break; }
  }
  const bound = Math.min(lastValid, economicEnd ?? lastValid);

  // The alternative: a replacement, priced the same way.
  let newAnnualCost: number | null = null;
  const R = inp.replacement.cost;
  if (R && R > 0) {
    const L = Math.max(1, Math.round(inp.replacement.lifeYears ?? 8));
    const endValue = Math.max(0, inp.replacement.endShare) * R;
    const ageNow = Math.max(0, inp.ageYears ?? 0);
    const upkeepNew = upkeep.now / Math.pow(1 + upkeep.growth, ageNow);
    const chanceNew = major.chance / Math.pow(1 + major.growth, ageNow);
    let running = 0;
    for (let y = 0; y < L; y++) {
      const covered = y < 1; // a new one comes with at least a year's cover
      running += costScale * upkeepNew * Math.pow(1 + upkeep.growth, y) * (covered ? 1 - WARRANTY_REPAIR_COVER : 1);
      running += covered ? 0 : costScale * Math.min(0.9, chanceNew * Math.pow(1 + major.growth, y)) * major.cost;
    }
    const avgValue = (R + endValue) / 2;
    newAnnualCost = Math.round(
      (R - endValue * (1 - s)) / L + running / L + carrying.pct * avgValue + OPPORTUNITY_RATE * avgValue - efficiency.savings,
    );
  }

  let months: number;
  let reason: DisposalReason;
  if (V0 <= guard || bound === 0) {
    months = 0; reason = "sell_now";
  } else if (newAnnualCost != null) {
    // Keep it while a year of keeping it costs less than a replacement does.
    let cheapest = 0;
    for (let m = 1; m < bound; m++) if (marginal(m) < marginal(cheapest)) cheapest = m;
    if (marginal(cheapest) > newAnnualCost) { months = 0; reason = "sell_now"; }
    else {
      let at: number | null = null;
      for (let m = cheapest; m < bound; m++) if (marginal(m) > newAnnualCost) { at = m; break; }
      if (at != null) { months = at; reason = at === 0 ? "sell_now" : "cheaper_to_replace"; }
      else { months = bound; reason = economicEnd != null && bound === economicEnd ? "economic_end" : bound < H ? "economic_end" : "horizon"; }
    }
  } else {
    // No replacement in view: the month its average yearly cost is lowest.
    let best = Infinity, bestM = bound;
    for (let t = 1; t <= bound; t++) { const avg = keepCostTo(t) / (t / 12); if (avg < best - 1e-9) { best = avg; bestM = t; } }
    months = bestM;
    reason = bestM < bound ? "costs_rise" : bound < H ? "economic_end" : "horizon";
  }
  if (months <= 2 && reason !== "sell_now") { reason = "sell_now"; months = 0; }
  const avg = months > 0 ? keepCostTo(months) / (months / 12) : marginal(0);
  return {
    months, reason, valueAt: Math.round(value(months)), avg: Math.round(avg),
    after: Math.round(marginal(months)), newAnnualCost, parts, monthly, value, sellCostAt, keepCostTo,
  };
}

/** Confidence from what is on file, and what would sharpen it. */
export function disposalConfidence(c: DisposalModelInput["confidence"], curveSource: "ai" | "category", hasReplacement: boolean): { score: number; level: Confidence; missing: string[] } {
  let score = 100;
  const missing: string[] = [];
  if (c.assumptions === "typical") { score -= 25; missing.push("Portol's AI analysis of this asset (it runs with the next valuation)"); }
  else if (c.aiConfidence === "low") score -= 15;
  else if (c.aiConfidence === "medium") score -= 5;
  if (curveSource === "category" && c.assumptions === "ai") score -= 10;
  if (c.valueSource === "none") { score -= 25; missing.push("a current value"); }
  else if (c.valueSource === "estimate" && c.valueConfidence !== "high") score -= c.valueConfidence === "medium" ? 5 : 12;
  if (!c.hasAge) { score -= 15; missing.push("the purchase date or model year"); }
  if (!c.hasPurchasePrice) { score -= 5; missing.push("the purchase price"); }
  if (c.usageExpected && !c.hasUsage) { score -= 10; missing.push("its usage (mileage or hours)"); }
  if (!c.hasCondition) { score -= 8; missing.push("its condition"); }
  if (c.maintenanceExpected && c.maintenanceRecords === 0) { score -= 7; missing.push("maintenance and repair records"); }
  if (!hasReplacement) { score -= 5; missing.push("what a replacement would cost"); }
  score = Math.max(5, Math.min(100, score));
  return { score, level: score >= 75 ? "high" : score >= 50 ? "medium" : "low", missing };
}

/** The decision: when to let it go, for how much, and why. Pure. */
export function decideDisposal(inp: DisposalModelInput): OptimalDisposal | null {
  const V0 = inp.currentValue;
  if (!(V0 > 0)) return null;
  const conf = disposalConfidence(inp.confidence, inp.curveSource, !!inp.replacement.cost);
  // The range: the same model read pessimistically and optimistically; wider when less is known.
  const k = conf.level === "low" ? 1 : conf.level === "medium" ? 0.5 : 0.25;
  const base = solve(inp, 1, 1);
  const pess = solve(inp, 1 + 0.3 * k, 1 + 0.3 * k);
  const opt = solve(inp, Math.max(0.5, 1 - 0.2 * k), Math.max(0.5, 1 - 0.25 * k));
  const monthsAll = [base.months, pess.months, opt.months];
  const valuesAll = [base.valueAt, pess.valueAt, opt.valueAt];
  const range = {
    dateLow: monthDate(inp.now, Math.min(...monthsAll)), dateHigh: monthDate(inp.now, Math.max(...monthsAll)),
    valueLow: Math.min(...valuesAll), valueHigh: Math.max(...valuesAll),
  };
  const months = base.months;
  const date = monthDate(inp.now, months);
  const s = Math.min(0.5, Math.max(0, inp.selling.pct));
  const valueAt = base.valueAt;
  const netProceeds = Math.round(valueAt * (1 - s));

  // Selling at each future interval, compared.
  const schedule: OptimalDisposal["schedule"] = [];
  for (let y = 1; y <= 10; y++) {
    const m = y * 12;
    const v = Math.round(base.value(m));
    if (v <= salvageGuard(inp.salvage, V0) && schedule.length >= 2) break;
    schedule.push({ years: y, value: v, keepCostPerYear: Math.round(base.keepCostTo(m) / y) });
    if (m > Math.max(months, 12) + 36) break;
  }

  // Every factor, as yearly figures: the next twelve months, and the twelve before the point.
  const yearly = (key: keyof Parts, from: number) => {
    const w = base.parts.slice(Math.max(0, from), Math.max(0, from) + 12);
    return w.length ? Math.round((w.reduce((a, p) => a + p[key], 0) / w.length) * 12) : 0;
  };
  const pre = Math.max(0, months - 12);
  const upkeepWord = (inp.upkeep.source === "repairs" ? "recorded" : inp.upkeep.source) as DisposalFactor["source"];
  const factors: DisposalFactor[] = [
    { key: "depreciation", label: "Lost resale value", now: yearly("depreciation", 0), atPoint: yearly("depreciation", pre), source: inp.curveSource === "ai" ? "ai" : "typical",
      detail: inp.curveSource === "ai" ? "The resale values Portol's AI expects for this asset at each interval, scaled to today's value." : "Its category's typical pace of value loss, until Portol's AI analyses it." },
    { key: "upkeep", label: "Repairs & maintenance", now: yearly("upkeep", 0), atPoint: yearly("upkeep", pre), source: upkeepWord,
      detail: `About ${money(inp.upkeep.now)} a year now, rising ${Math.round(inp.upkeep.growth * 100)}% a year as it ages${inp.warrantyYears > 0 ? `; the warranty covers about ${Math.round(WARRANTY_REPAIR_COVER * 100)}% of repairs until it ends` : ""}.` },
  ];
  if (inp.anticipated.length) {
    factors.push({ key: "anticipated", label: "Anticipated repairs", now: yearly("anticipated", 0), atPoint: yearly("anticipated", pre), source: "ai",
      detail: inp.anticipated.map((r) => `${r.item} (~${money(r.cost)}, in ${r.inYears < 1 ? `${Math.max(1, Math.round(r.inYears * 12))} mo` : `${Math.round(r.inYears * 10) / 10} yrs`})`).join("; ") + "." });
  }
  factors.push(
    { key: "major_failure", label: "Risk of a major failure", now: yearly("major_failure", 0), atPoint: yearly("major_failure", pre), source: inp.major.source,
      detail: `A ${Math.round(inp.major.chance * 100)}% chance this year of a ${money(inp.major.cost)} repair, rising ${Math.round(inp.major.growth * 100)}% a year${inp.warrantyYears > 0 ? "; covered while under warranty" : ""}.` },
    { key: "carrying", label: "Insurance, tax & registration", now: yearly("carrying", 0), atPoint: yearly("carrying", pre), source: inp.carrying.source,
      detail: inp.carrying.pct > 0 ? `About ${Math.round(inp.carrying.pct * 1000) / 10}% of its value a year — falls as it loses value.` : "None that scale with its value." },
    { key: "capital", label: "Money tied up in it", now: yearly("capital", 0), atPoint: yearly("capital", pre), source: inp.loan ? "on_file" : "calculated",
      detail: inp.loan ? `The loan on it charges ${Math.round(inp.loan.rate * 1000) / 10}% on the ${money(inp.loan.balance)} owed; ${Math.round(OPPORTUNITY_RATE * 100)}% on the rest.` : `What its value could earn elsewhere, ${Math.round(OPPORTUNITY_RATE * 100)}% a year.` },
    { key: "selling", label: "Cost of selling it", now: Math.round(base.sellCostAt(0)), atPoint: Math.round(base.sellCostAt(months)), source: inp.selling.source,
      detail: `About ${Math.round(s * 100)}% of the sale price in fees, listing and prep${inp.marketDemand === "low" ? " (demand is low, so expect to wait or discount)" : ""} — once, when you sell.` },
  );
  if (inp.efficiency.savings > 0) factors.push({ key: "efficiency", label: "Running cost a new one saves", now: Math.round(inp.efficiency.savings), atPoint: Math.round(inp.efficiency.savings), source: inp.efficiency.source, detail: "Energy or fuel a newer model would save each year — counted in the replacement's favour." });

  const notes: string[] = [];
  if (inp.warrantyYears > 0) notes.push(`Warranty runs until ${monthYear(iso(inp.now + inp.warrantyYears * YEAR))}; repairs cost more after that.`);
  if (inp.loan && inp.loan.balance > 0) {
    notes.push(inp.loan.balance > V0
      ? `${money(inp.loan.balance)} is owed on it — more than it is worth today (${money(V0)}). Selling before the loan is paid down below its value means covering the difference.`
      : `${money(inp.loan.balance)} is owed on it; selling pays that off and stops the interest${inp.loan.rate > 0 ? ` (${Math.round(inp.loan.rate * 1000) / 10}%)` : ""}.`);
  }

  // The model's own summary, from its figures.
  const when = monthYear(date);
  const R = base.newAnnualCost;
  const summary = base.reason === "sell_now"
    ? `Selling now is the cheapest course: it should fetch about ${money(valueAt)} (${money(netProceeds)} after selling costs). Keeping it another year would cost about ${money(base.after ?? 0)}${R != null ? `, more than a replacement's ${money(R)} a year` : ""}.`
    : base.reason === "cheaper_to_replace"
      ? `Keep it until ${when}, then sell for about ${money(valueAt)}. Until then owning it averages about ${money(base.avg)} a year${R != null ? `, less than a replacement's ${money(R)}` : ""}; after that a year of keeping it (about ${money(base.after ?? 0)}) costs more than replacing it.`
      : base.reason === "costs_rise"
        ? `Keep it until ${when}, then sell for about ${money(valueAt)}: owning it averages about ${money(base.avg)} a year until then, and more each year after.`
        : base.reason === "economic_end"
          ? `Keep it until ${when}, then sell for about ${money(valueAt)}. After that a year of owning it would cost more than it would still sell for above scrap, so its economic life ends there.`
          : `Keeping it stays cheaper than replacing it through the end of its expected useful life (about ${money(base.avg)} a year${R != null ? ` against a replacement's ${money(R)}` : ""}); plan to sell around ${when}, for about ${money(valueAt)}.`;

  return {
    date, monthsFromNow: months, reason: base.reason, decision: base.reason === "sell_now" ? "sell_now" : "keep",
    valueAt, netProceeds, currentValue: Math.round(V0),
    remainingEconomicLifeYears: Math.round((months / 12) * 10) / 10,
    projectedDepreciation: Math.max(0, Math.round(V0 - valueAt)),
    avgAnnualCost: base.avg, costAfter: base.after, newAnnualCost: base.newAnnualCost,
    replacementCost: inp.replacement.cost != null ? Math.round(inp.replacement.cost) : null, replacementSource: inp.replacement.source,
    range, confidence: conf.level, confidenceScore: conf.score, estimated: conf.level === "low", missing: conf.missing,
    curveSource: inp.curveSource, marketDemand: inp.marketDemand,
    explanation: { ai: inp.aiReasoning, summary },
    schedule,
    upkeepNow: Math.round(inp.upkeep.now), upkeepGrowthPct: Math.round(inp.upkeep.growth * 1000) / 1000, upkeepSource: inp.upkeep.source,
    factors, notes,
  };
}

/** One plain sentence for the point, for the recommendation's reasons. */
export function optimalDisposalSentence(od: OptimalDisposal): string {
  if (od.decision === "sell_now") return `Optimal disposal: sell now, for about ${money(od.valueAt)}.`;
  return `Optimal disposal: ${monthYear(od.date)}, for about ${money(od.valueAt)} (${span(od.monthsFromNow)} of economic life left).`;
}
