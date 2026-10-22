// ─── Valuation Engine + Confidence / Range Engine ───────────────────────────
//
// Deterministic. Takes the plan and every piece of evidence (internal and
// external) and produces one ValuationRecord:
//
//   weight_i  = methodWeight(kind_i) × reliability_i × relevance_i × decay(age_i)
//   value     = Σ weight_i · value_i / Σ weight_i
//   range     = weighted evidence bands, widened by disagreement and by low confidence
//   confidence= f(total weight, agreement between sources, freshness, diversity)
//
// When the evidence cannot support a defensible number the record says so
// (status "insufficient_data", value null) instead of inventing one.

import type {
  EvidenceKind, MethodologyId, PlannedMethod, RefreshReason,
  ValuationContext, ValuationEvidence, ValuationPlan, ValuationRecord,
} from "./types";
import { DEFAULT_CURRENCY, VALUATION_MODEL_VERSION } from "./types";
import { COMPARABLE_OUTLIER_SPREAD, poolComparables } from "./comparables";

/** Below this total weight no number is defensible. */
export const MIN_TOTAL_WEIGHT = 0.08;
/** Dispersion (weighted CV) above which sources are "in conflict". */
export const CONFLICT_CV = 0.25;
const EXTERNAL_KINDS = new Set<EvidenceKind>(["market_quote", "live_market_search", "comparable", "model_estimate"]);
const WEAK_ALONE = new Set<EvidenceKind>(["trajectory", "income_based", "model_estimate", "prior_valuation"]);

export function decayFactor(ageMs: number, halfLifeMs: number): number {
  if (!(halfLifeMs > 0)) return 1;
  if (!(ageMs > 0)) return 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

function methodFor(kind: EvidenceKind, plan: ValuationPlan): PlannedMethod | null {
  let best: PlannedMethod | null = null;
  for (const m of plan.methods) {
    if (m.evidenceKinds.includes(kind) && (!best || m.weight > best.weight)) best = m;
  }
  return best;
}

export function confidenceLabel(c: number): "high" | "medium" | "low" | "none" {
  if (!(c > 0)) return "none";
  if (c >= 0.75) return "high";
  if (c >= 0.45) return "medium";
  return "low";
}

/** Round to a precision the confidence can honestly support. */
export function roundValue(v: number): number {
  const abs = Math.abs(v);
  const step = abs >= 1_000_000 ? 1000 : abs >= 100_000 ? 500 : abs >= 10_000 ? 100 : abs >= 1_000 ? 10 : abs >= 100 ? 1 : 0.01;
  // Cents are rounded in integer cents: 78.07 / 0.01 * 0.01 is 78.07000000000001.
  return step < 1 ? Math.round(v * 100) / 100 : Math.round(v / step) * step;
}

function money(n: number): string { return `$${Math.round(n).toLocaleString()}`; }

function deterministicMissingInfo(ctx: ValuationContext): string[] {
  const out: string[] = [];
  if (!ctx.condition && !ctx.notesSignals.length) out.push("condition");
  if (!ctx.purchase.price) out.push("purchase price");
  if (ctx.purchase.price && !ctx.purchase.date) out.push("purchase date");
  if (ctx.identifiers.symbol && ctx.quantity == null) out.push("number of units held");
  return out;
}

export interface ComputeOptions {
  now?: Date;
  computeMs?: number;
  refreshReason: RefreshReason;
}

function baseRecord(ctx: ValuationContext, plan: ValuationPlan, opts: ComputeOptions): ValuationRecord {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  return {
    schemaVersion: 1,
    modelVersion: VALUATION_MODEL_VERSION,
    profileId: ctx.profileId,
    status: "insufficient_data",
    currency: DEFAULT_CURRENCY,
    value: null, low: null, high: null,
    confidence: 0, confidenceLabel: "none",
    methodology: [],
    methodSummary: "",
    evidence: [],
    materialInputs: ctx.materialInputs,
    inputFingerprint: ctx.inputFingerprint,
    profileFingerprint: ctx.profileFingerprint,
    marketDataAsOf: null,
    marketFreshnessMs: plan.marketFreshnessMs,
    valuedAt: nowIso,
    checkedAt: nowIso,
    nextRefreshAt: nowIso, // the freshness module schedules the real one
    refreshReason: opts.refreshReason,
    factors: [],
    missingInfo: [],
    understanding: ctx.understanding
      ? { kind: ctx.understanding.kind, source: ctx.understanding.source, valueDrivers: ctx.understanding.valueDrivers.slice(0, 6) }
      : null,
    errorCount: 0,
    error: null,
    computeMs: opts.computeMs,
  };
}

export function computeValuation(
  ctx: ValuationContext,
  plan: ValuationPlan,
  evidence: ValuationEvidence[],
  opts: ComputeOptions,
): ValuationRecord {
  const now = opts.now ?? new Date();
  const rec = baseRecord(ctx, plan, opts);
  rec.evidence = evidence;

  if (plan.methods.length === 0) {
    rec.status = ctx.entityClass !== "asset" ? "unsupported" : "insufficient_data";
    rec.methodSummary = plan.unsupportedReason || "Not enough information to value this asset.";
    rec.missingInfo = [...new Set([...(ctx.understanding?.missingInfo || []), ...deterministicMissingInfo(ctx)])];
    rec.factors = plan.rationale;
    return rec;
  }

  type Weighted = { e: ValuationEvidence; w: number; decay: number; method: MethodologyId; low: number; high: number };
  const usable: Weighted[] = [];
  for (const e of evidence) {
    if (e.value == null || !(e.value > 0)) continue;
    const m = methodFor(e.kind, plan);
    if (!m) continue;
    const observed = new Date(e.observedAt).getTime();
    const decay = decayFactor(Number.isFinite(observed) ? now.getTime() - observed : 0, e.halfLifeMs);
    const w = m.weight * clamp01(e.reliability) * clamp01(e.relevance) * decay;
    if (!(w > 0)) continue;
    const low = e.low != null && e.low > 0 && e.low <= e.value ? e.low : e.value * 0.92;
    const high = e.high != null && e.high >= e.value ? e.high : e.value * 1.08;
    usable.push({ e, w, decay, method: m.id, low, high });
  }

  // NO ANCHORING: the asset's own prior valuations are a fallback signal,
  // never a peer of fresh market evidence. When a current external
  // observation is on the table, drop them — otherwise every run would pull
  // toward the previous answer and the estimate would stop tracking the
  // market (the "same number every time" failure the dossier builder also
  // guards against).
  if (usable.some(u => EXTERNAL_KINDS.has(u.e.kind))) {
    for (let i = usable.length - 1; i >= 0; i--) if (usable[i].e.kind === "prior_valuation") usable.splice(i, 1);
  }

  // COMPARABLES ARE POOLED, NOT STACKED. Research returns many itemized
  // observations (sold listings, guide figures, offers). Counted one by one,
  // ten of them would drown a verified user value or an appraisal, and one
  // mislabeled listing would drag the mean. They are pooled into ONE estimate
  // the way an appraiser reads a page of comps: weighted median, outliers set
  // aside, the middle half as the band. More agreeing comps earn more weight,
  // up to a cap.
  const poolFactors: string[] = [];
  let pooledCv: number | null = null;
  let pooledTypes = 0;
  const compRows = usable.filter(u => u.e.kind === "comparable");
  if (compRows.length >= 2) {
    const pooled = poolComparables(compRows.map(u => ({ value: u.e.value!, weight: u.w })));
    if (pooled) {
      const kept = pooled.kept.map(i => compRows[i]);
      const keptW = kept.reduce((s, u) => s + u.w, 0);
      const maxW = Math.max(...kept.map(u => u.w));
      const w = Math.min(1.2, maxW * (1 + 0.15 * (kept.length - 1)));
      const decay = kept.reduce((s, u) => s + u.w * u.decay, 0) / keptW;
      pooledCv = kept.length >= 3 ? pooled.cv : null;
      pooledTypes = new Set(kept.map(u => String((u.e.raw as any)?.type ?? u.e.source))).size;
      const newest = kept.map(u => u.e.observedAt).sort().pop()!;
      for (let i = usable.length - 1; i >= 0; i--) if (usable[i].e.kind === "comparable") usable.splice(i, 1);
      usable.push({
        e: {
          id: "comparables:pooled", kind: "comparable", source: `Market comparables (${kept.length})`,
          provider: kept[0].e.provider, observedAt: newest, fetchedAt: newest,
          value: pooled.value, low: pooled.low, high: pooled.high, currency: kept[0].e.currency,
          reliability: 1, relevance: 1, halfLifeMs: kept[0].e.halfLifeMs,
          note: `median of ${kept.length}; middle half ${money(pooled.low)}–${money(pooled.high)}`,
        },
        w, decay, method: "comparable_market_analysis",
        low: Math.min(pooled.low, pooled.value * 0.97), high: Math.max(pooled.high, pooled.value * 1.03),
      });
      if (pooled.dropped.length) {
        poolFactors.push(`Set aside ${pooled.dropped.length} comparable${pooled.dropped.length === 1 ? "" : "s"} more than ${Math.round(COMPARABLE_OUTLIER_SPREAD * 100)}% from the median`);
      }
      // With three or more itemized comps on the table, a single blended
      // figure from another search is a cross-check, not a peer: it is the
      // same market read with less shown work.
      if (kept.length >= 3) for (const u of usable) if (u.e.kind === "live_market_search") u.w *= 0.5;
    }
  }

  const totalW = usable.reduce((s, u) => s + u.w, 0);
  if (usable.length === 0 || totalW < MIN_TOTAL_WEIGHT) {
    rec.status = "insufficient_data";
    rec.methodSummary = usable.length === 0
      ? "No usable value evidence was available."
      : "The available evidence is too weak or too old to support a value.";
    rec.factors = [
      ...plan.rationale,
      ...evidence.filter(e => e.value == null && e.note).map(e => e.note!),
    ].slice(0, 8);
    rec.missingInfo = [...new Set([...(ctx.understanding?.missingInfo || []), ...evidenceMissing(evidence), ...deterministicMissingInfo(ctx)])];
    return rec;
  }

  let value = usable.reduce((s, u) => s + u.w * u.e.value!, 0) / totalW;
  // Agreement is judged among the DIRECT observations (market, user, appraisal,
  // transaction). An indirect anchor — a purchase price projected with an
  // unknown drift — still nudges the blend by its small weight, but it must
  // not be able to declare a live comparable "in conflict" and drag the
  // confidence down; it is the weak signal, not the market.
  const strong = usable.filter(u => !WEAK_ALONE.has(u.e.kind));
  const agreementSet = strong.length >= 1 ? strong : usable;
  const agreementW = agreementSet.reduce((s, u) => s + u.w, 0);
  const agreementMean = agreementSet.reduce((s, u) => s + u.w * u.e.value!, 0) / agreementW;
  const variance = agreementSet.reduce((s, u) => s + u.w * Math.pow(u.e.value! - agreementMean, 2), 0) / agreementW;
  const cv = agreementMean > 0 ? Math.sqrt(variance) / agreementMean : 1;
  const agreementCount = agreementSet.length;
  const avgLow = usable.reduce((s, u) => s + u.w * u.low, 0) / totalW;
  const avgHigh = usable.reduce((s, u) => s + u.w * u.high, 0) / totalW;
  const freshness = usable.reduce((s, u) => s + u.w * u.decay, 0) / totalW;
  const kinds = new Set(usable.map(u => u.e.kind));
  const externalCount = usable.filter(u => EXTERNAL_KINDS.has(u.e.kind)).length;

  // ── Confidence ──
  const weightScore = Math.min(1, totalW / 1.2);
  // Pooled comparables carry their own agreement: three sold prices within a
  // few percent of each other ARE agreement, even with no second method.
  const agreement = agreementCount >= 2 ? Math.max(0, 1 - cv / CONFLICT_CV)
    : pooledCv != null ? Math.max(0.4, 1 - pooledCv / (2 * CONFLICT_CV)) : 0.7;
  const diversity = Math.min(1, (kinds.size + Math.max(0, pooledTypes - 1)) / 2);
  let confidence = weightScore * 0.45 + agreement * 0.3 + freshness * 0.15 + diversity * 0.1;
  const factors: string[] = [...poolFactors];
  // A thing that loses value with use is not worth more than it costs new.
  // An estimate above that ceiling means the evidence priced a different
  // (newer / higher-spec) item; cap it and say so.
  const ceiling = newPriceCeiling(evidence);
  // Intrinsic value is a floor: a gold coin is worth at least its gold.
  const melts = evidence.filter(x => x.kind === "comparable" && (x.raw as any)?.type === "melt" && (x.value ?? 0) > 0).map(x => x.value!).sort((a, b) => a - b);
  const floor = melts.length ? melts[Math.floor(melts.length / 2)] : null;
  if (floor && value < floor) {
    value = floor;
    factors.push(`Raised to its material (melt) value of ${money(floor)} — it cannot sell for less`);
  }
  if (ceiling && value > ceiling * 1.02) {
    value = ceiling;
    confidence = Math.min(confidence, 0.45);
    factors.push(`Capped at its price new (${money(ceiling)}) — the evidence priced a newer or higher-spec item`);
  }
  const onlyWeak = usable.every(u => WEAK_ALONE.has(u.e.kind));
  if (onlyWeak) { confidence = Math.min(confidence, 0.4); factors.push("Only indirect evidence (no market observation or verified value)"); }
  const conflict = agreementCount >= 2 && cv > CONFLICT_CV;
  if (conflict) { confidence = Math.min(confidence, 0.4); factors.push(`Sources disagree by ~${Math.round(cv * 100)}% — range widened`); }
  if (ctx.sparse) { confidence = Math.min(confidence, 0.5); factors.push("Sparse asset details limit precision"); }
  if (externalCount === 0 && plan.needsExternal) { confidence = Math.min(confidence, 0.55); factors.push("No current market evidence was available for this run"); }
  // Market evidence alone — however much of it agrees — is still an estimate
  // of what a buyer would pay. Only a verified figure (a live quote, the
  // owner's own number, an appraisal) earns the top of the scale.
  const verified = kinds.has("market_quote") || kinds.has("user_value") || kinds.has("document_appraisal") || kinds.has("transaction");
  if (!verified) confidence = Math.min(confidence, 0.9);
  confidence = Math.max(0.05, Math.min(0.97, confidence));

  // ── Range: evidence bands, widened by disagreement, then by low confidence ──
  let low = Math.min(avgLow, value * (1 - cv));
  let high = Math.max(avgHigh, value * (1 + cv));
  const minHalf = (1 - confidence) * 0.4;      // 0.9 → ±4%, 0.4 → ±24%
  low = Math.min(low, value * (1 - minHalf));
  high = Math.max(high, value * (1 + minHalf));
  const maxHalf = conflict ? 0.6 : 0.45;
  low = Math.max(low, value * (1 - maxHalf));
  high = Math.min(high, value * (1 + maxHalf));

  // ── Narrative ──
  const byMethod = new Map<MethodologyId, number>();
  for (const u of usable) byMethod.set(u.method, (byMethod.get(u.method) || 0) + u.w);
  const methodology = [...byMethod.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  for (const u of [...usable].sort((a, b) => b.w - a.w).slice(0, 6)) {
    const share = Math.round((u.w / totalW) * 100);
    factors.push(`${u.e.source}: ${money(u.e.value!)} (${share}% weight${u.decay < 0.6 ? ", aged" : ""})${u.e.note ? ` — ${u.e.note}` : ""}`);
  }
  const summary = methodology.map(m => METHOD_LABEL[m]).join(" + ");

  const externalObserved = usable.filter(u => EXTERNAL_KINDS.has(u.e.kind)).map(u => u.e.observedAt).sort();

  rec.status = "valued";
  rec.value = roundValue(value);
  rec.low = roundValue(low);
  rec.high = roundValue(high);
  rec.confidence = Math.round(confidence * 100) / 100;
  rec.confidenceLabel = confidenceLabel(rec.confidence);
  rec.methodology = methodology;
  rec.methodSummary = `${summary} · ${usable.length} source${usable.length === 1 ? "" : "s"}`;
  rec.factors = factors.slice(0, 10);
  rec.missingInfo = [...new Set([...evidenceMissing(evidence), ...(ctx.understanding?.missingInfo || []), ...deterministicMissingInfo(ctx)])].slice(0, 8);
  rec.marketDataAsOf = externalObserved.length ? externalObserved[externalObserved.length - 1] : null;
  return rec;
}

/** Price new of a depreciating item, from research evidence that flagged it as one. */
function newPriceCeiling(evidence: ValuationEvidence[]): number | null {
  for (const e of evidence) {
    const raw = e.raw as any;
    if (raw && raw.depreciates === true && typeof raw.newPrice === "number" && raw.newPrice > 0) return raw.newPrice;
  }
  return null;
}

function evidenceMissing(evidence: ValuationEvidence[]): string[] {
  const out: string[] = [];
  for (const e of evidence) {
    const m = (e.raw as any)?.missing;
    if (Array.isArray(m)) for (const s of m) if (typeof s === "string" && s.trim()) out.push(s.trim());
  }
  return out;
}

function clamp01(n: number): number { return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }

export const METHOD_LABEL: Record<MethodologyId, string> = {
  direct_market_pricing: "Direct market pricing",
  underlying_security_pricing: "Underlying market price",
  comparable_market_analysis: "Comparable market analysis",
  recent_transaction: "Recent purchase",
  value_trajectory: "Purchase-price trajectory",
  replacement_value: "Replacement value",
  income_based: "Income capitalization",
  user_verified_value: "Your entered value",
  document_appraisal: "Appraisal on file",
  historical_trend: "Valuation history trend",
  external_pricing: "External pricing source",
  model_estimate: "Appraiser-model estimate",
};

/** A record for a run that failed before producing evidence. */
export function errorRecord(
  ctx: ValuationContext,
  plan: ValuationPlan,
  message: string,
  previous: ValuationRecord | null,
  opts: ComputeOptions,
): ValuationRecord {
  const rec = baseRecord(ctx, plan, opts);
  rec.status = "error";
  rec.error = message.slice(0, 300);
  rec.errorCount = (previous?.errorCount || 0) + 1;
  rec.methodSummary = "The last refresh failed; the previous estimate is kept.";
  // Keep the last good numbers visible — a failed refresh must not blank the UI.
  if (previous && previous.status === "valued") {
    rec.value = previous.value; rec.low = previous.low; rec.high = previous.high;
    rec.confidence = previous.confidence; rec.confidenceLabel = previous.confidenceLabel;
    rec.methodology = previous.methodology; rec.evidence = previous.evidence;
    rec.factors = previous.factors; rec.missingInfo = previous.missingInfo;
    rec.marketDataAsOf = previous.marketDataAsOf; rec.valuedAt = previous.valuedAt;
    rec.materialInputs = previous.materialInputs; rec.inputFingerprint = previous.inputFingerprint;
    rec.profileFingerprint = previous.profileFingerprint;
  }
  return rec;
}
