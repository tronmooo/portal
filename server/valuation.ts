// ─── Asset valuation dossier ────────────────────────────────────────────────
// Builds the complete "everything we know about this asset" context that the
// valuation LLM calls (Perplexity primary, Anthropic fallback) receive, and
// parses their JSON responses into a normalized valuation record.
//
// Two invariants this module enforces:
//
// 1. COMPLETENESS — every relevant piece of the asset profile is included:
//    all stored fields (nested objects/arrays serialized, not dropped),
//    related expenses split into upgrades / repairs & maintenance / other,
//    linked documents with their extracted data, owner notes, recent
//    timeline activity, and the AI-generated summary.
//
// 2. NO ANCHORING — the output of a *previous* valuation must never be fed
//    back into the next one. Before this module existed, `currentValue`,
//    `valuationRange`, `previousValue`, etc. were included in the prompt, so
//    after the first lookup the model would anchor on its own prior answer
//    and keep returning the same number even after mileage/condition/location
//    changed. Those keys are stripped here (purchase price/date are kept —
//    those are real inputs, not prior model output).

export interface AssetValuationContext {
  /** Free-form notes stored on the profile. */
  notes?: string | null;
  /** The AI-generated profile summary text, if one exists. */
  aiSummary?: string | null;
  /** Expenses linked to this asset (source of upgrades/repairs/maintenance). */
  expenses?: Array<{
    description?: string | null;
    amount?: number | string | null;
    category?: string | null;
    date?: string | null;
  }>;
  /** Documents linked to this asset (titles, service records, etc). */
  documents?: Array<{
    name?: string | null;
    type?: string | null;
    extractedData?: Record<string, any> | null;
  }>;
  /** Recent activity entries for the asset. */
  timeline?: Array<{ type?: string; title?: string; timestamp?: string }>;
}

export interface AssetValuation {
  /** Recommended midpoint estimate in USD. */
  estimatedValue: number;
  /** Low end of the estimated range (0 when the model didn't provide one). */
  lowValue: number;
  /** High end of the estimated range (0 when the model didn't provide one). */
  highValue: number;
  confidence: string;
  method: string;
  /** Human-readable range string, e.g. "$19,250 - $25,199" (legacy shape). */
  details: string;
  /** Which asset details actually influenced this estimate. */
  factorsConsidered: string[];
  /** Missing information that would improve the estimate. */
  missingInfo: string[];
  /** ISO timestamp of when this valuation was computed. */
  valuationDate: string;
}

// Outputs of prior valuations. NEVER included in a new valuation prompt —
// feeding them back anchors the model on its own previous answer (the
// "same number every time" bug). Keys are matched case-insensitively.
const PRIOR_VALUATION_KEYS = new Set([
  "currentvalue",
  "previousvalue",
  "estimatedvalue",
  "valuationmethod",
  "valuationconfidence",
  "valuationrange",
  "valuationdate",
  "valuationlow",
  "valuationhigh",
  "valuationfactors",
  "valuationmissinginfo",
  "lastvaluedat",
]);

export function isPriorValuationKey(key: string): boolean {
  return PRIOR_VALUATION_KEYS.has(key.toLowerCase());
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

function fmtValue(v: any, max = 300): string {
  if (v == null) return "";
  if (typeof v === "object") {
    try { return clip(JSON.stringify(v), max); } catch { return ""; }
  }
  return clip(String(v), max);
}

const UPGRADE_RE = /upgrade|install|new (tires?|wheels?|roof|hvac|engine|transmission|battery|windows?|kitchen|bath)|remodel|renovat|addition|improvement|lift kit|tint|stereo|solar/i;
const REPAIR_RE = /repair|maintenance|service|oil change|brake|fix|replac|tune[- ]?up|inspection|alignment|rotat|flush|filter|spark plug|timing belt|detail/i;

/**
 * Build the full-context prompt block describing everything known about the
 * asset. Deterministic for a given input so tests can assert on inclusion.
 */
export function buildValuationDossier(
  profile: { type: string; name: string; fields: Record<string, any> },
  context?: AssetValuationContext,
): string {
  const lines: string[] = [];
  lines.push(`ASSET PROFILE — analyze every relevant detail below before estimating.`);
  lines.push(`Name: ${profile.name}`);
  lines.push(`Type: ${profile.type}`);

  // ── Stored fields (specs, condition, mileage, location, purchase info…) ──
  const fieldLines: string[] = [];
  for (const [k, v] of Object.entries(profile.fields || {})) {
    if (v == null || v === "") continue;
    if (k.startsWith("_")) continue;
    if (isPriorValuationKey(k)) continue; // no anchoring on prior estimates
    const rendered = fmtValue(v);
    if (!rendered) continue;
    fieldLines.push(`- ${k}: ${rendered}`);
  }
  if (fieldLines.length) {
    lines.push(`Details:`);
    lines.push(...fieldLines);
  }

  // ── Related expenses → upgrades / repairs & maintenance / other ──
  const expenses = (context?.expenses || []).filter(e => e && (e.description || e.amount));
  if (expenses.length) {
    const upgrades: string[] = [];
    const repairs: string[] = [];
    const other: string[] = [];
    for (const e of expenses.slice(-40)) {
      const desc = String(e.description || "expense");
      const amt = Number(e.amount);
      const when = e.date ? String(e.date).slice(0, 10) : "";
      const line = `- ${when ? when + ": " : ""}${clip(desc, 120)}${Number.isFinite(amt) && amt > 0 ? ` ($${amt.toLocaleString()})` : ""}`;
      const hay = `${desc} ${e.category || ""}`;
      if (UPGRADE_RE.test(hay)) upgrades.push(line);
      else if (REPAIR_RE.test(hay)) repairs.push(line);
      else other.push(line);
    }
    if (upgrades.length) {
      lines.push(`Upgrades & improvements (add value):`);
      lines.push(...upgrades.slice(-15));
    }
    if (repairs.length) {
      lines.push(`Repairs & maintenance history (indicates condition/upkeep):`);
      lines.push(...repairs.slice(-15));
    }
    if (other.length) {
      lines.push(`Other related expenses:`);
      lines.push(...other.slice(-10));
    }
  }

  // ── Linked documents (titles, service records, appraisals…) ──
  const docs = (context?.documents || []).filter(d => d && (d.name || d.extractedData));
  if (docs.length) {
    lines.push(`Linked documents:`);
    for (const d of docs.slice(0, 12)) {
      const extracted = d.extractedData && Object.keys(d.extractedData).length
        ? ` — ${fmtValue(d.extractedData, 400)}`
        : "";
      lines.push(`- ${clip(String(d.name || "document"), 80)}${d.type ? ` (${d.type})` : ""}${extracted}`);
    }
  }

  // ── Owner notes ──
  const notes = (context?.notes || "").trim();
  if (notes) {
    lines.push(`Owner notes: ${clip(notes, 800)}`);
  }

  // ── AI profile summary ──
  const summary = (context?.aiSummary || "").trim();
  if (summary) {
    lines.push(`AI profile summary: ${clip(summary, 800)}`);
  }

  // ── Recent activity ──
  const timeline = (context?.timeline || []).filter(t => t && t.title);
  if (timeline.length) {
    lines.push(`Recent activity:`);
    for (const t of timeline.slice(-10)) {
      const when = t.timestamp ? String(t.timestamp).slice(0, 10) : "";
      lines.push(`- ${when ? when + ": " : ""}${clip(String(t.title), 100)}${t.type ? ` [${t.type}]` : ""}`);
    }
  }

  return lines.join("\n");
}

/** The JSON response contract shared by both valuation model paths. */
export const VALUATION_RESPONSE_SPEC = `Respond with ONLY a JSON object (no markdown, no prose):
{"value": <number — recommended midpoint estimate in USD>, "low": <number — low end of range>, "high": <number — high end of range>, "confidence": "high|medium|low", "method": "<brief sources/method, e.g. KBB, Zillow, eBay comps>", "factors": ["<specific asset detail that influenced this estimate, e.g. '80,000 miles reduces value ~$2,000'>", ...], "missing": ["<missing detail that would improve accuracy, e.g. 'trim level', 'condition', 'service records'>", ...]}

Valuation rules (CRITICAL):
- Recompute the value from scratch using ONLY the asset details above plus current market data. Do NOT reuse or repeat any previous estimate.
- Adjust for every relevant provided detail: year, make/model/trim, mileage, condition, location/region, upgrades, repairs and maintenance history, purchase info, and specifications. Meaningfully different details MUST produce a different estimate.
- ALWAYS return a positive number for "value" — never 0. If exact data is unavailable, give your best informed estimate from comparable items.
- "low"/"high" must be a sensible band around "value" (low < value < high).
- "factors" must list the concrete details from the profile you actually used (2-6 items).
- "missing" must list information absent from the profile that would tighten the estimate (0-5 items; empty array if nothing meaningful is missing).
- confidence: "high" only with an exact market match, "medium" for similar comps, "low" for rough estimates.`;

/**
 * Parse a model response (Perplexity or Anthropic) into a normalized
 * AssetValuation. Returns null when no JSON object or positive value is found
 * (unless allowZero, used by the resilient fallback path).
 */
export function parseValuationResponse(
  text: string,
  opts?: { defaultMethod?: string; methodPrefix?: string; allowZero?: boolean },
): AssetValuation | null {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: any;
  try { parsed = JSON.parse(m[0]); } catch { return null; }

  const num = (x: any) => {
    const n = Number(typeof x === "string" ? x.replace(/[$,]/g, "") : x);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const value = num(parsed.value);
  if (value <= 0 && !opts?.allowZero) return null;

  let low = num(parsed.low);
  let high = num(parsed.high);
  // Some responses give "range": "$X - $Y" instead of low/high.
  if ((!low || !high) && typeof parsed.range === "string") {
    const nums = parsed.range.match(/[\d][\d,.]*/g);
    if (nums && nums.length >= 2) {
      low = low || num(nums[0]);
      high = high || num(nums[nums.length - 1]);
    }
  }
  if (low && high && low > high) [low, high] = [high, low];

  const details = low && high
    ? `$${low.toLocaleString()} - $${high.toLocaleString()}`
    : (typeof parsed.range === "string" ? parsed.range : "");

  const strArr = (x: any): string[] =>
    Array.isArray(x) ? x.filter((s: any) => typeof s === "string" && s.trim()).map((s: string) => clip(s.trim(), 200)).slice(0, 8) : [];

  const rawMethod = typeof parsed.method === "string" && parsed.method.trim()
    ? parsed.method.trim()
    : (opts?.defaultMethod || "AI estimate");

  return {
    estimatedValue: value,
    lowValue: low,
    highValue: high,
    confidence: typeof parsed.confidence === "string" && parsed.confidence ? parsed.confidence : "medium",
    method: opts?.methodPrefix ? `${opts.methodPrefix}${rawMethod}` : rawMethod,
    details,
    factorsConsidered: strArr(parsed.factors),
    missingInfo: strArr(parsed.missing),
    valuationDate: new Date().toISOString(),
  };
}
