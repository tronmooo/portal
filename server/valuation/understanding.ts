// ─── Semantic asset understanding ───────────────────────────────────────────
// The one place the model is asked "what IS this thing and what drives its
// value?" It runs only in the background refresh, only when the deterministic
// planner could not make a confident plan, and its answer is cached by the
// asset's STRUCTURAL signature (keys and identifiers, not values) so an
// unchanged shape never pays for the call twice. Its output is hints —
// volatility, drift, drivers, a search query, a symbol — never a value.

import type { IStorage } from "../storage";
import { getAnthropicClient } from "../anthropic-client";
import { selectModel, callModel } from "../model-router";
import { logger } from "../logger";
import type { AssetUnderstanding, MethodologyId, ValuationContext } from "@shared/valuation/types";
import { MS_PER_DAY } from "@shared/obligation-windows";

const MAX_AGE_MS = 30 * MS_PER_DAY;
const METHODS: MethodologyId[] = [
  "direct_market_pricing", "underlying_security_pricing", "comparable_market_analysis", "recent_transaction",
  "value_trajectory", "replacement_value", "income_based", "user_verified_value", "document_appraisal",
  "historical_trend", "external_pricing", "model_estimate",
];

const SYSTEM_PROMPT = `You are the asset-understanding step of a valuation engine. You are shown one owned asset: its name, the app's rough classification, its material characteristics, and what is known about its purchase. Decide what the thing actually is and what determines its current market value.

Return ONLY a JSON object (no markdown) with:
{
  "kind": "short plain-language description of what this is",
  "valueDrivers": ["characteristic that moves its value", "..."],   // 2-6, most important first, only ones that apply to THIS asset
  "volatility": "low" | "medium" | "high",                            // how fast its market price moves
  "expectedAnnualChangePct": number | null,                           // typical yearly change as a decimal (-0.15 = loses 15%/yr, 0.04 = gains 4%/yr); null if you genuinely don't know
  "usefulLifeYears": number | null,                                   // for wear-driven items; null otherwise
  "searchable": boolean,                                              // could a web search of listings/comps/AVMs price THIS specific item?
  "searchQuery": string | null,                                       // the best query for that search, or null
  "tradableSymbol": string | null,                                    // ticker or crypto symbol if this is (or holds) a listed instrument, else null
  "methodologyHints": ["comparable_market_analysis", ...],           // from: ${METHODS.join(", ")}
  "missingInfo": ["fact that would tighten the estimate", "..."]      // 0-5
}
Never invent a value or a price. Never assume a characteristic that was not given.`;


function normalize(raw: unknown, signature: string, now: Date): AssetUnderstanding | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const str = (v: unknown, max = 120) => typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null;
  const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null;
  const list = (v: unknown, max: number) => Array.isArray(v) ? v.filter(s => typeof s === "string" && s.trim()).map(s => s.trim().slice(0, 120)).slice(0, max) : [];
  const kind = str(r.kind, 80);
  if (!kind) return null;
  const vol = r.volatility === "low" || r.volatility === "high" ? r.volatility : "medium";
  const symbol = str(r.tradableSymbol, 12);
  return {
    source: "ai",
    kind,
    valueDrivers: list(r.valueDrivers, 6),
    volatility: vol,
    expectedAnnualChangePct: num(r.expectedAnnualChangePct, -0.6, 0.6),
    usefulLifeYears: num(r.usefulLifeYears, 0.5, 200),
    searchable: r.searchable === true,
    searchQuery: r.searchable === true ? str(r.searchQuery, 200) : null,
    tradableSymbol: symbol && /^[A-Z0-9.\-\/]{1,12}$/i.test(symbol) ? symbol.toUpperCase() : null,
    methodologyHints: list(r.methodologyHints, 6).filter((m): m is MethodologyId => (METHODS as string[]).includes(m)),
    missingInfo: list(r.missingInfo, 5),
    signature,
    generatedAt: now.toISOString(),
  };
}

function buildPrompt(ctx: ValuationContext): string {
  const attrs = Object.entries(ctx.attributes).map(([k, v]) => `  ${k}: ${String(v).slice(0, 120)}`).join("\n") || "  (none)";
  return [
    `Name: ${ctx.name}`,
    `App classification: ${ctx.classification.entityLabel} (${ctx.classification.semanticCategory}, ${ctx.classification.confidence} confidence)`,
    `Characteristics:`,
    attrs,
    `Identifiers present: ${Object.keys(ctx.identifiers).join(", ") || "none"}`,
    `Units held: ${ctx.quantity ?? "unknown"}`,
    `Purchase: ${ctx.purchase.price ? `$${ctx.purchase.price.toLocaleString()}` : "unknown price"}${ctx.purchase.date ? ` on ${ctx.purchase.date}` : ""}`,
    `Condition: ${ctx.condition || (ctx.notesSignals.length ? ctx.notesSignals.join(", ") : "unknown")}`,
    `Age: ${ctx.ageYears != null ? `${ctx.ageYears} years` : "unknown"}`,
    `Produces income: ${ctx.income ? `~$${ctx.income.monthly}/month` : "no"}`,
  ].join("\n");
}

export async function loadCachedUnderstanding(storage: IStorage, profileId: string, signature: string, now: Date = new Date()): Promise<AssetUnderstanding | null> {
  try {
    const parsed = await storage.getValuationUnderstanding(profileId);
    if (!parsed || parsed.signature !== signature) return null;
    if (now.getTime() - new Date(parsed.generatedAt).getTime() > MAX_AGE_MS) return null;
    return parsed;
  } catch { return null; }
}

/**
 * The cached understanding for this asset's current shape, or a fresh one from
 * the model when allowed. Returns null when no model is configured or the
 * call fails — the pipeline is deterministic without it.
 */
export async function resolveUnderstanding(
  storage: IStorage,
  ctx: ValuationContext,
  opts: { allowModel: boolean; timeoutMs?: number; now?: Date } ,
): Promise<AssetUnderstanding | null> {
  const now = opts.now ?? new Date();
  const cached = await loadCachedUnderstanding(storage, ctx.profileId, ctx.signature, now);
  if (cached) return cached;
  if (!opts.allowModel) return null;
  let spec;
  try { spec = selectModel("fast"); } catch { return null; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  (timer as any).unref?.();
  try {
    const text = await Promise.race([
      callModel({
        spec, system: SYSTEM_PROMPT, user: buildPrompt(ctx), maxTokens: 500, signal: controller.signal,
        anthropicClient: spec.provider === "anthropic" ? getAnthropicClient("standard") : undefined,
      }),
      new Promise<string>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("understanding timed out")), { once: true })),
    ]);
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    const understanding = normalize(parsed, ctx.signature, now);
    if (!understanding) return null;
    // A cache write, not a user-data write: cacheValuationUnderstanding is
    // deliberately outside the write journal so a background refresh that
    // only learned what the asset IS does not invalidate the dashboard.
    try { await storage.cacheValuationUnderstanding(ctx.profileId, understanding); } catch { /* cache is best-effort */ }
    return understanding;
  } catch (err: any) {
    logger.warn("valuation", `understanding step failed for ${ctx.profileId}: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
