// ─── Live market search provider ────────────────────────────────────────────
// Wraps the existing live-search appraiser (server/ai-engine estimateAssetValue:
// Perplexity with web search, Anthropic fallback) and normalizes its answer
// into evidence. The dossier it sends is built from the full asset record
// with prior estimates stripped, exactly as the "Look up value" button did.

import type { ValuationEvidence } from "@shared/valuation/types";
import { DEFAULT_CURRENCY } from "@shared/valuation/types";
import type { EvidenceProvider, ProviderRun } from "./types";

type Engine = typeof import("../../ai-engine");
let engineMod: Promise<Engine> | null = null;
function engine(): Promise<Engine> {
  if (!engineMod) engineMod = import("../../ai-engine");
  return engineMod;
}

/** Test seam: replace the appraiser without loading the whole AI engine. */
let appraiserOverride: Engine["estimateAssetValue"] | null = null;
export function setLiveSearchAppraiserForTest(fn: Engine["estimateAssetValue"] | null): void { appraiserOverride = fn; }

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("live search timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(v => { signal.removeEventListener("abort", onAbort); resolve(v); },
      e => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

export const liveSearchProvider: EvidenceProvider = {
  id: "live-search",
  supports(_ctx, plan) {
    return plan.providers.includes("live-search");
  },
  async fetch(run: ProviderRun): Promise<ValuationEvidence[]> {
    const { ctx } = run;
    const estimate = appraiserOverride ?? (await engine()).estimateAssetValue;
    const result = await abortable(estimate(
      { type: ctx.dossier.type, name: ctx.name, fields: ctx.dossier.fields },
      {
        notes: ctx.dossier.notes,
        aiSummary: ctx.dossier.aiSummary,
        expenses: ctx.dossier.expenses,
        documents: ctx.dossier.documents,
        timeline: ctx.dossier.timeline,
      },
      { trustedAsset: true },
    ), run.signal);
    if (!result) throw new Error("live search returned nothing");
    const live = /^live search/i.test(result.method);
    const nowIso = run.now.toISOString();
    const confidence = String(result.confidence || "medium").toLowerCase();
    const relevance = confidence === "high" ? 1 : confidence === "low" ? 0.65 : 0.85;
    if (!(result.estimatedValue > 0)) {
      // "No data" is an honest answer, recorded as qualitative evidence so
      // the engine can say "insufficient" instead of inventing a number.
      return [{
        id: "live-search:none", kind: live ? "live_market_search" : "model_estimate",
        source: live ? "Live market search" : "Appraiser model",
        provider: this.id, observedAt: nowIso, fetchedAt: nowIso,
        value: null, currency: DEFAULT_CURRENCY, reliability: 0, relevance: 0,
        halfLifeMs: run.plan.marketFreshnessMs,
        note: result.method || "No market data found",
        raw: { missing: result.missingInfo || [] },
      }];
    }
    const sources = (result.sources || []).filter(s => /^https?:\/\//.test(s));
    return [{
      id: live ? "live-search:blend" : "live-search:model",
      kind: live ? "live_market_search" : "model_estimate",
      source: live ? result.method.replace(/^live search:\s*/i, "").trim() || "Live market search" : "Appraiser model (no live data)",
      provider: this.id,
      observedAt: nowIso,
      fetchedAt: nowIso,
      value: result.estimatedValue,
      low: result.lowValue || null,
      high: result.highValue || null,
      currency: DEFAULT_CURRENCY,
      reliability: live ? 0.8 : 0.45,
      relevance,
      halfLifeMs: run.plan.marketFreshnessMs,
      geographic: typeof ctx.attributes.location === "string" ? ctx.attributes.location
        : typeof ctx.attributes.city === "string" ? String(ctx.attributes.city) : null,
      reference: sources[0] || null,
      note: (result.factorsConsidered || []).slice(0, 3).join("; ") || undefined,
      raw: {
        factors: result.factorsConsidered || [],
        missing: result.missingInfo || [],
        specs: result.specs || {},
        sources,
        method: result.method,
        confidence,
      },
    }];
  },
};
