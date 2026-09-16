// ─── Freshness + cache invalidation rules ───────────────────────────────────
//
// Answers, cheaply and deterministically, "is the stored valuation still the
// best available estimate?" — without any provider or model call, so it can
// run inside the profile-open request.
//
// A stored record is stale when:
//   · the material inputs changed (fingerprint mismatch),
//   · the engine version changed,
//   · its market evidence is older than the plan allowed for this asset,
//   · its own schedule says so (nextRefreshAt), or
//   · it errored and the retry backoff has elapsed.
//
// Freshness windows are per record: a listed instrument re-prices in hours, a
// house in weeks, a purchase-price trajectory only when its inputs move.
// There is no global TTL.

import { MS_PER_DAY } from "../obligation-windows";
import type { FreshnessVerdict, ValuationPlan, ValuationRecord, ValuationStatus } from "./types";
import { VALUATION_MODEL_VERSION } from "./types";
import { MS_PER_HOUR } from "./planner";

/** How long a record with no external evidence stays scheduled before a re-check. */
export const INTERNAL_ONLY_REFRESH_MS = 30 * MS_PER_DAY;
/** An "insufficient data" answer is re-tried this often even with no input change. */
export const INSUFFICIENT_RETRY_MS = 7 * MS_PER_DAY;
export const UNSUPPORTED_RETRY_MS = 30 * MS_PER_DAY;
export const ERROR_BACKOFF_BASE_MS = 1 * MS_PER_HOUR;
export const ERROR_BACKOFF_MAX_MS = 24 * MS_PER_HOUR;

const EXTERNAL_KINDS = new Set(["market_quote", "live_market_search", "comparable", "model_estimate"]);

/** When the next scheduled refresh should happen for a freshly written record. */
export function scheduleNextRefresh(
  status: ValuationStatus,
  plan: Pick<ValuationPlan, "needsExternal" | "marketFreshnessMs">,
  errorCount: number,
  now: Date,
  usedExternal: boolean,
): string {
  let delta: number;
  if (status === "error") delta = Math.min(ERROR_BACKOFF_MAX_MS, ERROR_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, errorCount - 1)));
  else if (status === "unsupported") delta = UNSUPPORTED_RETRY_MS;
  else if (status === "insufficient_data") delta = INSUFFICIENT_RETRY_MS;
  else if (usedExternal || plan.needsExternal) delta = plan.marketFreshnessMs;
  else delta = INTERNAL_ONLY_REFRESH_MS;
  return new Date(now.getTime() + delta).toISOString();
}

/** Newest external observation in the record, or null. */
export function marketEvidenceAge(record: ValuationRecord, now: Date): number | null {
  const times = record.evidence
    .filter(e => EXTERNAL_KINDS.has(e.kind))
    .map(e => new Date(e.observedAt).getTime())
    .filter(t => Number.isFinite(t));
  if (times.length === 0) return record.marketDataAsOf ? now.getTime() - new Date(record.marketDataAsOf).getTime() : null;
  return now.getTime() - Math.max(...times);
}

export function assessFreshness(
  record: ValuationRecord | null,
  currentFingerprint: string,
  now: Date = new Date(),
  modelVersion: string = VALUATION_MODEL_VERSION,
): FreshnessVerdict {
  if (!record) return { fresh: false, reason: "first_valuation", detail: "No valuation stored yet" };
  if (record.modelVersion !== modelVersion) {
    return { fresh: false, reason: "model_version", detail: `Stored with ${record.modelVersion}, engine is ${modelVersion}` };
  }
  if (record.inputFingerprint !== currentFingerprint) {
    return { fresh: false, reason: "inputs_changed", detail: "Material asset information changed since the last valuation" };
  }
  const next = new Date(record.nextRefreshAt).getTime();
  if (record.status === "error") {
    return now.getTime() >= next
      ? { fresh: false, reason: "retry_after_error", detail: `Last refresh failed (${record.error || "unknown"}); retrying` }
      : { fresh: true, reason: null, detail: "Last refresh failed; waiting out the retry backoff" };
  }
  const marketAge = marketEvidenceAge(record, now);
  if (record.status === "valued" && marketAge != null && marketAge > record.marketFreshnessMs) {
    return { fresh: false, reason: "market_evidence_stale", detail: `Market evidence is ${Math.round(marketAge / MS_PER_HOUR)}h old (limit ${Math.round(record.marketFreshnessMs / MS_PER_HOUR)}h)` };
  }
  if (Number.isFinite(next) && now.getTime() >= next) {
    return { fresh: false, reason: "scheduled", detail: "Scheduled re-check is due" };
  }
  return { fresh: true, reason: null, detail: "Inputs unchanged and evidence within its freshness window" };
}
