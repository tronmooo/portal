// ─── Salvage value estimate ─────────────────────────────────────────────────
// The model is asked one small question during the value-tracking run: what
// would this thing still fetch at the end of its useful life? The answer is
// checked (shared/asset-salvage.ts normalizeSalvageEstimate) and stored on
// the profile by refreshValuation; a figure the user typed is never replaced.
// Runs beside the market research, so it adds no wait to a refresh.

import { getAnthropicClient } from "../anthropic-client";
import { selectModel, callModel } from "../model-router";
import { logger } from "../logger";
import type { ValuationContext } from "@shared/valuation/types";
import { normalizeSalvageEstimate, type SalvageEstimate } from "@shared/asset-salvage";

const SYSTEM_PROMPT = `You estimate the SALVAGE VALUE of one owned asset: what it would realistically still fetch at the end of its useful life — sold for scrap, for parts, or as-is in worn-out condition — in US dollars, at today's prices.

Return ONLY a JSON object (no markdown):
{ "salvageValue": number | null, "basis": "one short sentence: the useful life you assumed and what the end-of-life value comes from" }

Rules:
- Base it on what the thing is, what it cost, its age, condition and usage. Typical anchors: a car's scrap/parts value, a phone or laptop's parts or recycling value, furniture or a tool's yard-sale value.
- It is never more than what the asset cost or is worth now.
- Return null for something with no meaningful end of life that tends to hold or gain value (land, a house, art, collectibles, precious metals, securities, crypto).
- Never invent facts that were not given.`;

function buildPrompt(ctx: ValuationContext, currentValue: number | null): string {
  const attrs = Object.entries(ctx.attributes).slice(0, 25).map(([k, v]) => `  ${k}: ${String(v).slice(0, 120)}`).join("\n") || "  (none)";
  const usage = Object.entries(ctx.usage).map(([k, v]) => `${k} ${v}`).join(", ");
  return [
    `Name: ${ctx.name}`,
    `What it is: ${ctx.understanding?.kind || ctx.classification.entityLabel} (${ctx.classification.semanticCategory})`,
    `Characteristics:`,
    attrs,
    `Purchase: ${ctx.purchase.price ? `$${ctx.purchase.price.toLocaleString()}` : "unknown price"}${ctx.purchase.date ? ` on ${ctx.purchase.date}` : ""}`,
    `Current value: ${currentValue ? `$${Math.round(currentValue).toLocaleString()}` : "unknown"}`,
    `Age: ${ctx.ageYears != null ? `${ctx.ageYears} years` : "unknown"}`,
    `Condition: ${ctx.condition || (ctx.notesSignals.length ? ctx.notesSignals.join(", ") : "unknown")}`,
    usage ? `Usage: ${usage}` : "",
    ctx.understanding?.usefulLifeYears ? `Typical useful life: about ${ctx.understanding.usefulLifeYears} years` : "",
  ].filter(Boolean).join("\n");
}

/**
 * The AI's salvage value for this asset, or null — no model configured, the
 * call failed, the answer was out of bounds, or the asset has no meaningful
 * salvage value. Never throws.
 */
export async function estimateSalvageValue(
  ctx: ValuationContext,
  opts: { currentValue: number | null; timeoutMs?: number },
): Promise<SalvageEstimate | null> {
  let spec;
  try { spec = selectModel("fast"); } catch { return null; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  (timer as any).unref?.();
  try {
    const text = await Promise.race([
      callModel({
        spec, system: SYSTEM_PROMPT, user: buildPrompt(ctx, opts.currentValue), maxTokens: 200, signal: controller.signal,
        anthropicClient: spec.provider === "anthropic" ? getAnthropicClient("standard") : undefined,
      }),
      new Promise<string>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("salvage estimate timed out")), { once: true })),
    ]);
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    return normalizeSalvageEstimate(parsed, { purchasePrice: ctx.purchase.price, currentValue: opts.currentValue });
  } catch (err: any) {
    logger.warn("valuation", `salvage estimate failed for ${ctx.profileId}: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
