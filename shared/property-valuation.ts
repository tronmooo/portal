// shared/property-valuation.ts — Deterministic canonical value estimator.
//
// PURPOSE. Given a set of per-source point estimates (Zillow $1,987,600,
// Redfin $1,760,648, CoreLogic $1,524,300, Collateral Analytics $1,182,000, …)
// this module computes exactly ONE canonical current value in code — never in
// LLM prose. The language model's only job upstream is to EXTRACT the source
// point estimates; all selection/aggregation math lives here so that:
//
//   • identical normalized evidence always yields an identical number
//     (order-invariant, temperature-invariant, model-invariant), and
//   • we never blend/average a headline value in free-form text, and never
//     surface a min–max vendor spread as a competing answer.
//
// The old bug: the valuation prompt asked the model for a final `value` plus a
// `low`/`high` range. The model freely chose/averaged the headline (so refreshes
// drifted: $1.9M one run, $1.55M the next) and the min–max spread was persisted
// and shown as an alternative answer. This module removes that non-determinism.
//
// Pure: no I/O, no LLM, no React. Pinned by tests/property-valuation.test.ts.

import { parseMoney } from "./asset-value";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RawSourceEstimate {
  /** Vendor/source name as extracted, e.g. "Zillow", "CoreLogic". */
  source?: string | null;
  /** Point estimate — number or money-like string ("$1,987,600"). */
  value?: number | string | null;
  /** As-of date for the estimate, if the source reported one. */
  asOf?: string | null;
}

export interface AcceptedSource {
  /** Canonicalized display name. */
  source: string;
  value: number;
  asOf: string | null;
  /** Source-quality weight used in the weighted median. */
  weight: number;
}

export interface RejectedSource {
  source: string;
  value: number;
  reason: "invalid" | "stale" | "duplicate" | "outlier";
}

export interface CanonicalValuation {
  /** The single canonical current value. Use this everywhere. */
  value: number;
  confidence: "high" | "medium" | "low";
  /** Deterministic method description (labeled, not a competing range). */
  method: string;
  /** Accepted, labeled input estimates — supporting detail only. */
  accepted: AcceptedSource[];
  rejected: RejectedSource[];
  /** Min/max of accepted inputs — the INPUT spread, clearly not the answer. */
  spreadLow: number;
  spreadHigh: number;
  /** Most recent as-of across accepted sources, if any. */
  asOf: string | null;
}

export interface CanonicalOptions {
  /** Reference "now" for staleness — injectable for deterministic tests. */
  now?: Date;
  /** Estimates older than this many months are rejected as stale. */
  maxAgeMonths?: number;
}

// ─── Source-quality weights ─────────────────────────────────────────────────
// Deterministic tiers. Institutional AVMs (used by lenders) weigh more than
// consumer portals, which weigh more than thin aggregators. Unknown sources get
// a small non-zero weight so a lone unrecognized comp still counts.

const SOURCE_WEIGHTS: Array<{ match: RegExp; weight: number; name: string }> = [
  { match: /corelogic/i, weight: 1.5, name: "CoreLogic" },
  { match: /collateral\s*analytics/i, weight: 1.5, name: "Collateral Analytics" },
  { match: /quantarium/i, weight: 1.5, name: "Quantarium" },
  { match: /house\s*canary|housecanary/i, weight: 1.5, name: "HouseCanary" },
  { match: /black\s*knight/i, weight: 1.5, name: "Black Knight" },
  { match: /first\s*american/i, weight: 1.5, name: "First American" },
  { match: /zillow|zestimate/i, weight: 1.0, name: "Zillow" },
  { match: /redfin/i, weight: 1.0, name: "Redfin" },
  { match: /realtor\.?com|realtor/i, weight: 1.0, name: "Realtor.com" },
  { match: /kelley|kbb|blue\s*book/i, weight: 1.0, name: "Kelley Blue Book" },
  { match: /edmunds/i, weight: 1.0, name: "Edmunds" },
  { match: /homes\.?com/i, weight: 0.7, name: "Homes.com" },
  { match: /trulia/i, weight: 0.7, name: "Trulia" },
  { match: /chase/i, weight: 0.7, name: "Chase" },
  { match: /bank\s*of\s*america|bofa/i, weight: 0.7, name: "Bank of America" },
  { match: /ownerly/i, weight: 0.7, name: "Ownerly" },
  { match: /eppraisal|epropertywatch/i, weight: 0.7, name: "Eppraisal" },
];

const UNKNOWN_WEIGHT = 0.5;

/** Canonicalize a source name + resolve its quality weight. */
export function resolveSourceWeight(rawName: string): { name: string; weight: number } {
  const name = (rawName || "").trim();
  for (const s of SOURCE_WEIGHTS) {
    if (s.match.test(name)) return { name: s.name, weight: s.weight };
  }
  return { name: name || "Unknown", weight: UNKNOWN_WEIGHT };
}

// ─── Stable rounding rule ────────────────────────────────────────────────────
// Magnitude-based, deterministic. The SAME rule is used for the stored current
// value, the summary text, the card, and any net-worth aggregation so a value
// never renders differently in two places.

export function roundCanonicalValue(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  const step = v >= 100_000 ? 1_000 : v >= 10_000 ? 100 : v >= 1_000 ? 10 : 1;
  return Math.round(v / step) * step;
}

// ─── As-of parsing (for staleness + provenance) ─────────────────────────────

/** Parse "2026-07", "2026-07-15", "July 2026", "2025" → epoch ms (month start), or null. */
function parseAsOf(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const iso = s.match(/(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (iso) {
    const y = +iso[1], m = +iso[2] - 1, d = iso[3] ? +iso[3] : 1;
    const t = Date.UTC(y, Math.max(0, Math.min(11, m)), d);
    return Number.isFinite(t) ? t : null;
  }
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const named = s.toLowerCase().match(/([a-z]{3,})\.?\s+(\d{4})/);
  if (named) {
    const mi = MONTHS.indexOf(named[1].slice(0, 3));
    if (mi >= 0) return Date.UTC(+named[2], mi, 1);
  }
  const yearOnly = s.match(/^(\d{4})$/);
  if (yearOnly) return Date.UTC(+yearOnly[1], 0, 1);
  return null;
}

function monthsBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / (1000 * 60 * 60 * 24 * 30.4375);
}

// ─── Weighted median ─────────────────────────────────────────────────────────
// Order-invariant: sorts by value (tie-break by source name) before reducing.
// This is what guarantees the canonical value is independent of the order the
// LLM happened to list the sources in.

function weightedMedian(items: Array<{ value: number; weight: number; source: string }>): number {
  const sorted = [...items].sort((a, b) => a.value - b.value || a.source.localeCompare(b.source));
  const total = sorted.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)].value : 0;
  const half = total / 2;
  let cum = 0;
  for (let i = 0; i < sorted.length; i++) {
    cum += sorted[i].weight;
    if (cum > half) return sorted[i].value;
    if (cum === half) {
      const next = sorted[i + 1];
      return next ? (sorted[i].value + next.value) / 2 : sorted[i].value;
    }
  }
  return sorted[sorted.length - 1].value;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Compute the single canonical value from a set of per-source point estimates.
 *
 * Pipeline (all deterministic):
 *   1. Normalize: parse money, canonicalize source names + weights, parse asOf.
 *   2. Reject invalid (≤0 / non-numeric).
 *   3. Reject stale (asOf older than maxAgeMonths; missing asOf is NOT stale).
 *   4. Dedupe: collapse identical rounded values (keep highest-weight source)
 *      and collapse repeats of the same source (keep freshest asOf).
 *   5. Reject outliers vs. the median (ratio rule: <0.5× or >2× the median),
 *      applied only when ≥3 candidates remain so a small sample isn't gutted.
 *   6. Weighted median of survivors → round with the stable rule.
 *
 * Returns null when there is not a single valid source (caller falls back to a
 * single model-provided value in that case).
 */
export function computeCanonicalValuation(
  raw: RawSourceEstimate[] | null | undefined,
  opts: CanonicalOptions = {},
): CanonicalValuation | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const now = opts.now ?? new Date();
  const maxAgeMonths = opts.maxAgeMonths ?? 18;
  const nowMs = now.getTime();

  const rejected: RejectedSource[] = [];

  // 1–2. Normalize + reject invalid.
  interface Cand extends AcceptedSource { asOfMs: number | null; }
  let cands: Cand[] = [];
  for (const r of raw) {
    const value = parseMoney(r?.value);
    const { name, weight } = resolveSourceWeight(String(r?.source ?? ""));
    if (!Number.isFinite(value) || value <= 0) {
      rejected.push({ source: name, value: Number.isFinite(value) ? value : 0, reason: "invalid" });
      continue;
    }
    const asOfMs = parseAsOf(r?.asOf);
    cands.push({ source: name, value, weight, asOf: r?.asOf ? String(r.asOf) : null, asOfMs });
  }
  if (cands.length === 0) return null;

  // 3. Reject stale.
  cands = cands.filter((c) => {
    if (c.asOfMs != null && monthsBetween(c.asOfMs, nowMs) > maxAgeMonths) {
      rejected.push({ source: c.source, value: c.value, reason: "stale" });
      return false;
    }
    return true;
  });
  if (cands.length === 0) return null;

  // 4a. Dedupe repeats of the same source — keep the freshest asOf (tie: higher weight).
  const bySource = new Map<string, Cand>();
  for (const c of cands) {
    const prev = bySource.get(c.source);
    if (!prev) { bySource.set(c.source, c); continue; }
    const better = (c.asOfMs ?? -Infinity) > (prev.asOfMs ?? -Infinity)
      || ((c.asOfMs ?? -Infinity) === (prev.asOfMs ?? -Infinity) && c.weight > prev.weight);
    rejected.push({ source: (better ? prev : c).source, value: (better ? prev : c).value, reason: "duplicate" });
    if (better) bySource.set(c.source, c);
  }
  cands = [...bySource.values()];

  // 4b. Dedupe identical rounded values across sources — keep highest weight
  // (tie: alphabetical source) so scraped duplicates can't double-count.
  const byValue = new Map<number, Cand>();
  for (const c of cands) {
    const key = roundCanonicalValue(c.value);
    const prev = byValue.get(key);
    if (!prev) { byValue.set(key, c); continue; }
    const keep = c.weight > prev.weight || (c.weight === prev.weight && c.source.localeCompare(prev.source) < 0) ? c : prev;
    const drop = keep === c ? prev : c;
    rejected.push({ source: drop.source, value: drop.value, reason: "duplicate" });
    byValue.set(key, keep);
  }
  cands = [...byValue.values()];

  // 5. Outlier rejection vs. median (only with ≥3 candidates).
  if (cands.length >= 3) {
    const med = median(cands.map((c) => c.value));
    if (med > 0) {
      const kept: Cand[] = [];
      for (const c of cands) {
        if (c.value < 0.5 * med || c.value > 2.0 * med) {
          rejected.push({ source: c.source, value: c.value, reason: "outlier" });
        } else {
          kept.push(c);
        }
      }
      if (kept.length > 0) cands = kept;
    }
  }

  // 6. Weighted median → stable rounding.
  const canonicalRaw = weightedMedian(cands.map((c) => ({ value: c.value, weight: c.weight, source: c.source })));
  const value = roundCanonicalValue(canonicalRaw);
  if (value <= 0) return null;

  const accepted: AcceptedSource[] = cands
    .map(({ asOfMs, ...rest }) => rest)
    .sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source));

  const values = accepted.map((a) => a.value);
  const spreadLow = Math.min(...values);
  const spreadHigh = Math.max(...values);
  const med = median(values) || value;
  const relSpread = med > 0 ? (spreadHigh - spreadLow) / med : 1;

  let confidence: CanonicalValuation["confidence"];
  if (accepted.length >= 3 && relSpread <= 0.2) confidence = "high";
  else if (relSpread <= 0.6) confidence = "medium";
  else confidence = "low";
  if (accepted.length < 3 && confidence === "high") confidence = "medium";

  const asOfMsList = cands.map((c) => c.asOfMs).filter((m): m is number => m != null);
  const latestAsOfMs = asOfMsList.length ? Math.max(...asOfMsList) : null;
  const asOf = latestAsOfMs != null
    ? (cands.find((c) => c.asOfMs === latestAsOfMs)?.asOf ?? null)
    : null;

  const method = `Weighted median of ${accepted.length} source${accepted.length === 1 ? "" : "s"}: ${accepted.map((a) => a.source).join(", ")}`;

  return { value, confidence, method, accepted, rejected, spreadLow, spreadHigh, asOf };
}
