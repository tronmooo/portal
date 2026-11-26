// ─── Lifecycle assumptions: the AI's one question per asset ──────────────────
// During the value-tracking run the model is asked how THIS asset ages: does
// it lose value, gain it or hold it; its useful life; the yearly rate; what
// it is worth (or costs to get rid of) at the end; what a new equivalent
// costs; its yearly upkeep and how fast that rises (the inputs of the Optimal
// Disposal Point). Its answer is bounded by `sanitizeLifecycleAssumptions` and stored;
// every figure the app shows is then calculated by the deterministic engine
// (shared/asset-lifecycle.ts). Runs beside the market research, so it adds no
// wait to a refresh. No model, or a refused answer: null, and the engine uses
// the category's typical figures, labelled as such.

import { getAnthropicClient } from "../anthropic-client";
import { selectModel, callModel } from "../model-router";
import { logger } from "../logger";
import type { ValuationContext } from "@shared/valuation/types";
import { sanitizeLifecycleAssumptions, type LifecycleAssumptions } from "@shared/asset-lifecycle";

const SYSTEM_PROMPT = `You choose the valuation ASSUMPTIONS for one owned asset, for a personal-finance app. A separate calculator does all the arithmetic; you only choose the assumptions, from what is given and from general knowledge of how this kind of thing ages.

Return ONLY a JSON object (no markdown):
{
  "valueModel": "depreciating" | "appreciating" | "stable",
  "usefulLifeYears": number | null,      // years from new until it is worn out or obsolete; null unless depreciating
  "annualChangePct": number | null,      // typical yearly value change as a decimal: -0.15 loses 15%/yr, 0.03 gains 3%/yr, 0 holds
  "salvageValue": number | null,         // US dollars at the end of its useful life (scrap, parts, as-is resale). NEGATIVE when getting rid of it costs money (haul-away, hazardous disposal). null unless depreciating
  "disposal": "resell" | "scrap" | "recycle" | "dispose" | "none",
  "replacementCost": number | null,      // today's price of a comparable NEW item, only if you genuinely know its typical price class; else null
  "annualUpkeep": number | null,         // typical US dollars a year to keep THIS one running at its current age and condition: repairs + maintenance (not fuel, insurance or loan payments); null unless depreciating or when you cannot judge
  "upkeepGrowthPct": number | null,      // how fast that upkeep rises each year it ages, as a decimal: 0.12 = +12%/yr (cars ~0.08-0.15, electronics ~0.2-0.35 as batteries and parts fail, furniture ~0.03-0.08); null unless depreciating
  "majorRepairCost": number | null,      // US dollars for ONE major failure of this kind of thing (transmission, compressor, logic board, roof); null when unsure
  "majorFailureChancePct": number | null,// chance of such a failure in the coming year at its current age, mileage and condition, as a decimal (0.05 = 5%)
  "majorFailureChanceGrowthPct": number | null, // how fast that chance rises each year it ages, as a decimal
  "carryingCostPct": number | null,      // insurance, property tax, registration that scale with its value, as a yearly share of its value (cars ~0.03-0.07; most household goods 0); 0 when none
  "sellingCostPct": number | null,       // what selling it costs as a share of the sale price: platform/dealer fees, listing, cleaning/prep, the trade-in discount (cars ~0.05-0.15, electronics ~0.08-0.15)
  "newEfficiencySavings": number | null, // US dollars a year a NEW equivalent would save in running costs (energy, fuel efficiency); 0 when none
  "confidence": "high" | "medium" | "low",
  "basis": "one sentence: what kind of asset this is and how it ages",
  "assumptions": ["short plain-language assumption", "..."]   // 2-5, e.g. "15-year useful life for a compact sedan"
}

Rules:
- Use asset-specific behaviour, not one universal rate: cars, electronics, appliances, furniture, tools, boats, property, art, jewelry, collectibles and instruments all age differently. Condition, usage (mileage, hours), repair history and age matter.
- Property and land usually appreciate; art, collectibles, precious metals and quality instruments are usually stable or appreciating; most everyday goods depreciate.
- Never invent market data, listings, prices you do not know, or facts that were not given. When unsure, use "low" confidence and leave figures null.
- salvageValue is never more than the asset cost or is worth now.
- annualUpkeep includes the extra running cost an aging item has (lost efficiency, more energy), not fuel or insurance.
- Every figure above feeds the Optimal Disposal Point; use THIS asset's facts (age, usage, condition, repair history, make and model reliability, warranty), not a generic average.
- annualUpkeep and upkeepGrowthPct decide the Optimal Disposal Point (when owning it starts costing more each year than selling or replacing it). Recorded upkeep, mileage and condition matter: high recorded repairs or heavy use mean higher upkeep. You do not compute the point; the calculator does.`;

function buildPrompt(ctx: ValuationContext, extra: { currentValue: number | null; category: string }): string {
  const attrs = Object.entries(ctx.attributes).slice(0, 25).map(([k, v]) => `  ${k}: ${String(v).slice(0, 120)}`).join("\n") || "  (none)";
  const usage = Object.entries(ctx.usage).map(([k, v]) => `${k} ${v}`).join(", ");
  const imp = ctx.improvements;
  return [
    `Name: ${ctx.name}`,
    `Category: ${extra.category} (${ctx.understanding?.kind || ctx.classification.entityLabel})`,
    `Characteristics:`,
    attrs,
    `Purchase: ${ctx.purchase.price ? `$${ctx.purchase.price.toLocaleString()}` : "unknown price"}${ctx.purchase.date ? ` on ${ctx.purchase.date}` : ""}`,
    `Current value: ${extra.currentValue ? `$${Math.round(extra.currentValue).toLocaleString()}` : "unknown"}`,
    `Age: ${ctx.ageYears != null ? `${ctx.ageYears} years` : "unknown"}`,
    `Condition: ${ctx.condition || (ctx.notesSignals.length ? ctx.notesSignals.join(", ") : "unknown")}`,
    usage ? `Usage: ${usage}` : "",
    imp.count ? `Recorded upkeep: $${Math.round(imp.repairsTotal).toLocaleString()} repairs, $${Math.round(imp.upgradesTotal).toLocaleString()} upgrades${imp.lastServiceDate ? `, last service ${imp.lastServiceDate}` : ""}` : "",
    ctx.appraisals.length ? `Appraisals on file: ${ctx.appraisals.map((a) => `$${Math.round(a.value).toLocaleString()}${a.date ? ` (${a.date})` : ""}`).join(", ")}` : "",
    ctx.income ? `Produces income: ~$${Math.round(ctx.income.monthly)}/month` : "",
    ctx.understanding?.usefulLifeYears ? `Earlier analysis: useful life about ${ctx.understanding.usefulLifeYears} years` : "",
  ].filter(Boolean).join("\n");
}

/** The AI's lifecycle assumptions for this asset, or null. Never throws. */
export async function estimateLifecycleAssumptions(
  ctx: ValuationContext,
  opts: { currentValue: number | null; category: string; timeoutMs?: number },
): Promise<LifecycleAssumptions | null> {
  let spec;
  try { spec = selectModel("fast"); } catch { return null; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25_000);
  (timer as any).unref?.();
  try {
    const text = await Promise.race([
      callModel({
        spec, system: SYSTEM_PROMPT, user: buildPrompt(ctx, opts), maxTokens: 900, signal: controller.signal,
        anthropicClient: spec.provider === "anthropic" ? getAnthropicClient("standard") : undefined,
      }),
      new Promise<string>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("lifecycle assumptions timed out")), { once: true })),
    ]);
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    return sanitizeLifecycleAssumptions(parsed, { purchasePrice: ctx.purchase.price, currentValue: opts.currentValue });
  } catch (err: any) {
    logger.warn("valuation", `lifecycle assumptions failed for ${ctx.profileId}: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
