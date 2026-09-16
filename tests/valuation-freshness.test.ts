// Freshness rules: per-record windows, fingerprint invalidation, error backoff.
import { describe, it, expect } from "vitest";
import { assessFreshness, scheduleNextRefresh, INSUFFICIENT_RETRY_MS, INTERNAL_ONLY_REFRESH_MS, ERROR_BACKOFF_BASE_MS, ERROR_BACKOFF_MAX_MS } from "@shared/valuation/freshness";
import { VALUATION_MODEL_VERSION, type ValuationRecord } from "@shared/valuation/types";

const NOW = new Date("2026-09-16T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function record(over: Partial<ValuationRecord> = {}): ValuationRecord {
  return {
    schemaVersion: 1, modelVersion: VALUATION_MODEL_VERSION, profileId: "p", status: "valued", currency: "USD",
    value: 100, low: 90, high: 110, confidence: 0.7, confidenceLabel: "medium", methodology: ["comparable_market_analysis"],
    methodSummary: "x", evidence: [], materialInputs: {}, inputFingerprint: "fp1", marketDataAsOf: null,
    marketFreshnessMs: 30 * DAY, valuedAt: NOW.toISOString(), checkedAt: NOW.toISOString(),
    nextRefreshAt: new Date(NOW.getTime() + 30 * DAY).toISOString(), refreshReason: "scheduled",
    factors: [], missingInfo: [], understanding: null, errorCount: 0, error: null, ...over,
  };
}

describe("assessFreshness", () => {
  it("no record → first valuation", () => {
    expect(assessFreshness(null, "fp1", NOW)).toMatchObject({ fresh: false, reason: "first_valuation" });
  });
  it("unchanged inputs within the window → fresh", () => {
    expect(assessFreshness(record(), "fp1", NOW).fresh).toBe(true);
  });
  it("changed material inputs → inputs_changed", () => {
    expect(assessFreshness(record(), "fp2", NOW)).toMatchObject({ fresh: false, reason: "inputs_changed" });
  });
  it("a new engine version re-values", () => {
    expect(assessFreshness(record({ modelVersion: "valuation-v0" }), "fp1", NOW)).toMatchObject({ fresh: false, reason: "model_version" });
  });
  it("market evidence older than the record's own window → market_evidence_stale", () => {
    const rec = record({
      marketFreshnessMs: 6 * HOUR,
      evidence: [{ id: "q", kind: "market_quote", source: "s", provider: "market-quote", observedAt: new Date(NOW.getTime() - 7 * HOUR).toISOString(), fetchedAt: NOW.toISOString(), value: 1, currency: "USD", reliability: 1, relevance: 1, halfLifeMs: HOUR }],
    });
    expect(assessFreshness(rec, "fp1", NOW)).toMatchObject({ fresh: false, reason: "market_evidence_stale" });
    // A 30-day window on the same evidence is still fresh: freshness is per record, not global.
    expect(assessFreshness({ ...rec, marketFreshnessMs: 30 * DAY }, "fp1", NOW).fresh).toBe(true);
  });
  it("the schedule alone can make it due", () => {
    expect(assessFreshness(record({ nextRefreshAt: new Date(NOW.getTime() - 1).toISOString() }), "fp1", NOW)).toMatchObject({ fresh: false, reason: "scheduled" });
  });
  it("an errored record waits out its backoff, then retries", () => {
    const soon = record({ status: "error", error: "boom", nextRefreshAt: new Date(NOW.getTime() + HOUR).toISOString() });
    expect(assessFreshness(soon, "fp1", NOW).fresh).toBe(true);
    const due = record({ status: "error", error: "boom", nextRefreshAt: new Date(NOW.getTime() - 1).toISOString() });
    expect(assessFreshness(due, "fp1", NOW)).toMatchObject({ fresh: false, reason: "retry_after_error" });
    // …but changed inputs override the backoff.
    expect(assessFreshness(soon, "fp2", NOW).reason).toBe("inputs_changed");
  });
});

describe("scheduleNextRefresh", () => {
  const plan = { needsExternal: true, marketFreshnessMs: 7 * DAY };
  const at = (iso: string) => new Date(iso).getTime() - NOW.getTime();
  it("uses the plan's market window when external evidence was used", () => {
    expect(at(scheduleNextRefresh("valued", plan, 0, NOW, true))).toBe(7 * DAY);
  });
  it("internal-only records re-check on the long internal cadence", () => {
    expect(at(scheduleNextRefresh("valued", { needsExternal: false, marketFreshnessMs: 7 * DAY }, 0, NOW, false))).toBe(INTERNAL_ONLY_REFRESH_MS);
  });
  it("insufficient data retries on its own cadence", () => {
    expect(at(scheduleNextRefresh("insufficient_data", plan, 0, NOW, false))).toBe(INSUFFICIENT_RETRY_MS);
  });
  it("errors back off exponentially and cap", () => {
    expect(at(scheduleNextRefresh("error", plan, 1, NOW, false))).toBe(ERROR_BACKOFF_BASE_MS);
    expect(at(scheduleNextRefresh("error", plan, 3, NOW, false))).toBe(4 * ERROR_BACKOFF_BASE_MS);
    expect(at(scheduleNextRefresh("error", plan, 20, NOW, false))).toBe(ERROR_BACKOFF_MAX_MS);
  });
});
