// ─── Reading a nutrition label from a picture, and products by barcode ───────
//
// A model READS the picture (the one thing arithmetic cannot do); what it
// returns passes `sanitizeScannedLabel` (shared/nutrition-scan.ts) or is
// refused. Scanning writes nothing. Logging a scanned label is a separate,
// explicit step (`logScannedLabel`): the entry's figures are the label's own
// per-serving values times the servings the user ate, computed on the server.
//
// A picture may also be of a BARCODE: the digits printed under the bars are
// read, checked (GTIN check digit) and looked up in the product databases.
//
// Pinned by tests/nutrition-scan.test.ts (the reader is injected there).

import type { IStorage } from "./storage";
import {
  consumedFromScan, sanitizeScannedLabel, scaledScanValues, scanItemName,
  type ScannedLabel, type ScanConsumption,
} from "@shared/nutrition-scan";
import { ENTRY_VALUE_NUTRIENTS } from "@shared/nutrition-enrichment";
import { barcodeLookup, isValidGtin, type SourceCandidate, type SourceDeps } from "./nutrition-sources";
import { getAnthropicClient } from "./anthropic-client";
import { logger } from "./logger";

const SCAN_PROMPT = `You are reading a photo for a nutrition tracker. Return ONLY JSON, no prose, no code fence.

If the photo shows a Nutrition Facts / nutrition information panel, return:
{"kind":"label","productName":string|null,"brand":string|null,"barcode":string|null,
 "serving":{"text":string,"grams":number|null,"ml":number|null,"householdAmount":number|null,"householdUnit":string|null},
 "servingsPerContainer":number|null,
 "perServing":{"calories":number,"fat":number,"saturatedFat":number,"transFat":number,"polyFat":number,"monoFat":number,"cholesterol":number,"sodium":number,"carbs":number,"fiber":number,"sugar":number,"addedSugar":number,"sugarAlcohol":number,"allulose":number,"protein":number,"vitaminD":number,"calcium":number,"iron":number,"potassium":number, ...any other nutrient printed, by its common name},
 "perContainer":{...same keys} or null,
 "dailyValues":{"fat":number,...} }

If it shows a product barcode and no nutrition panel, return {"kind":"barcode","barcode":"<the digits printed under the bars>"}.
If it shows neither, return {"kind":"none","reason":"<what the photo shows>"}.

Rules:
- Copy the numbers exactly as printed. Never estimate, never calculate, never fill in a value that is not printed. Leave out any nutrient that is not on the label.
- "perServing" is the per-serving column. If the label has a second column (per container / per package / as prepared), put it in "perContainer"; otherwise null.
- A value printed as "<1 g", "less than 1g", "trace" or that you cannot read with certainty: LEAVE IT OUT. Do not write 0 for it. Write 0 only where the label prints 0.
- Units are fixed: calories in kcal; fat, carbs, fiber, sugars, protein in g; cholesterol, sodium, calcium, iron, potassium, magnesium, zinc, vitamin C in mg; vitamin D, vitamin A, vitamin B12, folate, vitamin K in mcg. If the label prints only kJ, convert to kcal (÷ 4.184) for "calories".
- "serving.text" is the serving size exactly as printed ("2/3 cup (55g)"). grams / ml are the metric amount in it. householdAmount / householdUnit are the household part (0.667 and "cup"; 2 and "cookies").
- "dailyValues" are the % Daily Value figures as printed, per serving, without the % sign.
- productName and brand only if they are visible in the photo. barcode only if its digits are visible.`;

export type ScanResult =
  | { kind: "label"; label: ScannedLabel }
  | { kind: "barcode"; barcode: string; label: ScannedLabel | null }
  | { kind: "none"; reason: string };

export interface ScanDeps extends SourceDeps {
  /** The model's reading of the picture, as text. Injected in tests. */
  read?: (base64: string, mediaType: string) => Promise<string>;
}

async function defaultRead(base64: string, mediaType: string): Promise<string> {
  const client = getAnthropicClient("standard");
  const resp = await client.messages.create(
    {
      model: process.env.NUTRITION_SCAN_MODEL || "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: mediaType as any, data: base64 } }, { type: "text", text: SCAN_PROMPT }] }],
    },
    { timeout: 45_000, maxRetries: 0 },
  );
  return resp.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
}

/** A database product, in the shape of a scanned label. Null when the record states no usable values. */
export function labelFromCandidate(c: SourceCandidate): ScannedLabel | null {
  const useServing = !!c.perServing && !!c.serving;
  const perServing = useServing ? c.perServing! : c.per100;
  if (!perServing) return null;
  const unit = c.per100Unit || "g";
  const serving = useServing
    ? { text: c.serving!.label, ...(c.serving!.grams ? { grams: c.serving!.grams } : {}), ...(c.serving!.ml ? { ml: c.serving!.ml } : {}) }
    : { text: `100 ${unit}`, ...(unit === "ml" ? { ml: 100 } : { grams: 100 }) };
  const pkg = unit === "ml" ? c.package?.ml : c.package?.grams;
  const per = unit === "ml" ? serving.ml : serving.grams;
  return sanitizeScannedLabel({
    productName: c.name, brand: c.brand, barcode: c.barcode || c.id, serving,
    servingsPerContainer: pkg && per ? Math.round((pkg / per) * 100) / 100 : null,
    perServing,
    sourceName: c.provider === "off" ? `Open Food Facts product ${c.id}` : `USDA FoodData Central Branded #${c.id}`,
  }, "barcode");
}

/** The product a barcode names, as a label. Null when no database knows it. */
export async function labelFromBarcode(code: string, deps: SourceDeps = {}): Promise<ScannedLabel | null> {
  const c = await barcodeLookup(code, deps);
  return c ? labelFromCandidate(c) : null;
}

/** Read one picture. Writes nothing. */
export async function scanNutritionLabel(base64Image: string, mimeType: string, deps: ScanDeps = {}): Promise<ScanResult> {
  let clean = String(base64Image || "");
  if (clean.includes(",")) clean = clean.split(",").pop() || clean;
  clean = clean.replace(/\s/g, "");
  const mediaType = /^image\/(jpeg|png|gif|webp)$/.test(mimeType) ? mimeType : "image/jpeg";
  let parsed: any = null;
  try {
    const text = await (deps.read || defaultRead)(clean, mediaType);
    const m = text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch (e: any) {
    logger.warn("nutrition-scan", `reader failed: ${e?.message || e}`);
    throw new Error("The picture could not be read. Nothing was logged.");
  }
  if (!parsed || typeof parsed !== "object") return { kind: "none", reason: "the picture could not be read" };
  if (parsed.kind === "barcode") {
    const digits = String(parsed.barcode || "").replace(/\D/g, "");
    if (!isValidGtin(digits)) return { kind: "none", reason: "a barcode whose digits could not be read reliably" };
    return { kind: "barcode", barcode: digits, label: await labelFromBarcode(digits, deps) };
  }
  if (parsed.kind === "label") {
    const label = sanitizeScannedLabel(parsed, "photo");
    if (label) {
      if (label.barcode && !isValidGtin(label.barcode)) delete label.barcode;
      return { kind: "label", label };
    }
  }
  return { kind: "none", reason: String(parsed.reason || "no nutrition label was found in the picture").slice(0, 160) };
}

export interface LoggedScan {
  entry: any;
  trackerName: string;
  consumption: ScanConsumption;
  values: Record<string, number>;
  recap: string;
}

/**
 * Log a scanned label as a Nutrition entry for the amount the user ate. Goes
 * through the same door as a food said in chat (`log_tracker_entry`), so the
 * person's own Nutrition tracker is found or created the same way; the
 * figures are the label's (the tool's enrichment step is told so through
 * `__scan` and looks nothing up).
 */
export async function logScannedLabel(
  _storage: IStorage,
  opts: { label: ScannedLabel; quantity?: string; forProfile?: string; at?: string; mealType?: string; userMessage?: string },
): Promise<LoggedScan | { error: string }> {
  const label = sanitizeScannedLabel(opts.label, opts.label?.origin === "barcode" ? "barcode" : "photo");
  if (!label) return { error: "That label has no nutrition values to log." };
  if (opts.label?.sourceName) label.sourceName = String(opts.label.sourceName).slice(0, 120);
  const consumption = consumedFromScan(label, opts.quantity);
  if (!(consumption.servings > 0) || consumption.servings > 200) return { error: "That amount could not be read against the label's serving." };
  const all = scaledScanValues(label, consumption.servings);
  const values: Record<string, any> = { item: scanItemName(label) };
  for (const k of ENTRY_VALUE_NUTRIENTS) if (typeof all[k] === "number") values[k] = all[k];
  if (opts.mealType && /^(breakfast|lunch|dinner|snack)$/.test(opts.mealType)) values.mealType = opts.mealType;
  const { executeTool, validateToolInput } = await import("./ai-engine");
  const input: Record<string, any> = {
    trackerName: "Nutrition", values, category: "nutrition",
    ...(opts.forProfile ? { forProfile: opts.forProfile } : {}),
    ...(opts.at ? { at: opts.at } : {}),
    __userMessage: String(opts.userMessage || opts.quantity || ""),
    __scan: { label, quantity: opts.quantity || "" },
  };
  const checked = validateToolInput("log_tracker_entry", input);
  if (!checked.valid) return { error: checked.errors.join(" ") };
  const result = await executeTool("log_tracker_entry", checked.normalized);
  if (!result || result.error || !result.id) return { error: String(result?.error || "The entry could not be saved.") };
  return {
    entry: result,
    trackerName: String(result.trackerName || result.__trackerName || "Nutrition"),
    consumption,
    values: Object.fromEntries(Object.entries(result.values || values).filter(([, v]) => typeof v === "number")) as Record<string, number>,
    recap: String(result._recapDetail || ""),
  };
}
