// ─── Itemized market research provider ──────────────────────────────────────
//
// Why a person gets a good number from ChatGPT: they give it the full
// description, and it runs SEVERAL searches across the sources that price
// that kind of thing, reads the actual figures (a pricing guide's private-
// party value, sold listings, instant offers, asking prices), notices which
// are asking prices vs sale prices, and reasons over them. The old live-search
// path asked one model for one number in one shot and took it as the answer.
//
// This provider does the research the same way and stops short of the answer:
// the model writes down every concrete price it read, with what kind of price
// it is and how closely it matches. The pricing — restating each one as fair
// market value, setting aside outliers, the median and the band — is
// deterministic code (shared/valuation/comparables.ts + engine.ts) that shows
// its work in the record.
//
// It is asset-agnostic: the model is told which kinds of sources a
// professional appraiser uses for each kind of thing and picks the right ones
// for THIS asset. Two independent researchers run when configured — Claude
// with web search (ANTHROPIC_API_KEY) and OpenAI's web-search Responses API
// (OPENAI_API_KEY, the same search ChatGPT uses) — and their observations are
// pooled, so one bad read cannot set the value.

import type { ValuationContext, ValuationEvidence } from "@shared/valuation/types";
import { DEFAULT_CURRENCY } from "@shared/valuation/types";
import { MS_PER_DAY } from "@shared/obligation-windows";
import { excludeNewUnits, isAssetNew, normalizeResearch, observationsToEvidence, type ResearchResult } from "@shared/valuation/comparables";
import { getAnthropicClient } from "../../anthropic-client";
import { logger } from "../../logger";
import { decodeVin, findVin } from "../vin-decode";
import type { EvidenceProvider, ProviderRun } from "./types";

/** Specs research may write into EMPTY profile fields (never over a user's value). */
const FILLABLE_SPECS = new Set([
  "year", "make", "model", "trim", "bodyStyle", "drivetrain", "fuelType", "transmission", "engineCylinders", "engineLiters",
  "sqft", "bedrooms", "bathrooms", "lotSize", "yearBuilt", "storage", "screenSize", "metal", "karat", "caratWeight",
]);

export const RESEARCH_SYSTEM = `You are the market-research step of a professional appraisal. You have web search. Your job is to FIND AND RECORD real market prices for the asset described — not to decide its value. A separate, deterministic step prices it from what you record.

How to research (do all of it):
1. Pin down exactly what the item is from the details given (year, make, model, trim/spec, size, condition, usage such as mileage or hours, location).
2. Choose the sources a professional appraiser uses for THIS kind of thing. Examples:
   - Vehicles: KBB / Edmunds / J.D. Power (NADA) private-party and trade-in values for the exact trim and mileage; instant offers (Carvana, CarMax, Peddle); listings with similar mileage on CarGurus / Autotrader / Cars.com; Bring a Trailer or Cars & Bids results for enthusiast cars.
   - Homes / land: Zillow, Redfin, Realtor.com estimates for the exact address; recent sales of comparable nearby properties; county assessor records.
   - Phones, laptops, electronics, cameras: eBay SOLD listings for the exact model and storage/spec; Swappa; Back Market; trade-in programs.
   - Watches: Chrono24 and eBay sold prices for the exact reference. Jewelry / bullion: current metal price × weight (melt) plus resale comps.
   - Collectibles, cards, coins, art: eBay sold, PriceCharting, PSA/PCGS price guides, Heritage / auction results.
   - Boats, RVs, motorcycles, powersports: J.D. Power / NADA guides, YachtWorld, RV Trader, Cycle Trader.
   - Equipment and tools: Machinery Trader, IronPlanet / auction results, eBay sold. Instruments: Reverb price guide and sold listings. Bikes: Bicycle Blue Book.
   - Furniture, appliances, household goods: eBay sold, Facebook Marketplace / Craigslist asking prices, and the current new price.
3. Run several searches across DIFFERENT source types (a guide or estimate, completed sales, instant offers, current listings). Prefer completed sales and pricing guides over asking prices. Prefer the exact spec, nearby location and recent dates.
4. Mark every price with "itemCondition": is the priced unit new, used or refurbished? A store selling the model brand-new is "new" — record it (it tells us the price new) but look for USED prices for a used asset. For metals and bullion, record the current melt value (spot × metal weight) as type "melt".
5. Record every concrete price you actually read on a page. Never invent, interpolate or estimate a price yourself. If a guide gives several values (trade-in, private party, dealer retail), record each separately with its basis.

Respond with ONLY one JSON object, no markdown:
{
  "identity": "<one line: what this item exactly is>",
  "observations": [
    {"price": <number USD>, "type": "sold|listing|guide|avm|offer|appraisal|melt", "basis": "fair_market|private_party|dealer_retail|trade_in|wholesale", "source": "<site or publisher>", "url": "<page url>", "date": "<YYYY-MM-DD if shown, else null>", "itemCondition": "new|used|refurbished", "similarity": <0..1 how closely the priced item matches THIS one: exact spec+condition+usage = 1, same model different spec/usage ≈ 0.6, merely similar ≈ 0.3>, "details": "<the priced item's spec, mileage/usage, condition, location>"}
  ],
  "newPrice": <price of this exact item new (MSRP/retail) if you found it, else null>,
  "depreciates": <true if this kind of item loses value with age and use (vehicles, electronics, appliances), false if it typically holds or gains value (real estate, gold, many collectibles), null if unsure>,
  "specs": {"<canonical key: trim|bodyStyle|drivetrain|sqft|bedrooms|bathrooms|lotSize|yearBuilt|storage|...>": <value stated on a page about THIS exact item>},
  "missing": ["<detail the owner could add that would tighten the price, e.g. 'trim level', 'condition'>"]
}
Record 4–12 observations when the market has them; fewer is fine for rare items. An empty "observations" array is an honest answer when nothing comparable exists.`;

function money(n: number): string { return `$${Math.round(n).toLocaleString()}`; }

/** Strip long numbers (policy, account, phone) from free text before it leaves the app. */
function scrub(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const s = text.replace(/\b\d{7,}\b/g, "[redacted]").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

export function researchBrief(ctx: ValuationContext, decoded: Record<string, string | number>): string {
  const a = ctx.attributes;
  const attrs = Object.entries({ ...a, ...decoded })
    .filter(([k]) => !/^(vin|serial|imei)$/i.test(k))
    .map(([k, v]) => `  ${k}: ${String(v).slice(0, 120)}`).join("\n") || "  (none given)";
  const location = [a.city, a.state, a.zip ?? a.zipCode, a.location].filter(v => v != null && String(v).trim()).join(", ");
  const usage = Object.entries(ctx.usage).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(", ");
  const lines = [
    `Asset: ${ctx.name}`,
    `What the app thinks it is: ${ctx.understanding?.kind || ctx.classification.entityLabel}`,
    `Details:`,
    attrs,
    ctx.identifiers.address ? `Address: ${ctx.identifiers.address}` : null,
    Object.keys(decoded).length ? `(Year/make/model/trim/body/drivetrain above were decoded from the VIN — treat them as exact.)` : null,
    usage ? `Usage: ${usage}` : null,
    `Condition: ${ctx.condition || (ctx.notesSignals.length ? ctx.notesSignals.join(", ") : "not stated (assume average for its age)")}`,
    location ? `Location: ${location}` : `Location: United States`,
    ctx.ageYears != null ? `Age: ${ctx.ageYears} years` : null,
    ctx.purchase.price ? `Bought for ${money(ctx.purchase.price)}${ctx.purchase.date ? ` on ${ctx.purchase.date}` : ""}` : null,
    ctx.improvements.upgradesTotal > 0 ? `Upgrades: ${money(ctx.improvements.upgradesTotal)}` : null,
    scrub(ctx.dossier.notes, 600) ? `Owner notes: ${scrub(ctx.dossier.notes, 600)}` : null,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** The last JSON object in a model's text. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  // A model that wrote prose around several objects: take the largest parseable span from the first "{".
  for (let e = end; e > start; e = text.lastIndexOf("}", e - 1)) {
    try { return JSON.parse(text.slice(start, e + 1)); } catch { /* keep shrinking */ }
  }
  return null;
}

// ── Researchers ─────────────────────────────────────────────────────────────

/** Once one researcher has answered, the others get this long to finish. */
export const RESEARCH_GRACE_MS = Number(process.env.VALUATION_RESEARCH_GRACE_MS) || 40_000;

interface ResearcherRun { name: string; ms: number; text: string | null; error: string | null }

/**
 * Run every researcher in parallel, each on its own abort signal. The first
 * success starts a grace window; whoever has not answered by its end is
 * abandoned (recorded as timed out), so one slow source cannot hold the
 * whole valuation to the provider's full budget.
 */
export async function runResearchers(
  researchers: Array<[string, Researcher]>,
  brief: string,
  opts: { signal: AbortSignal; region: string | null; graceMs: number },
): Promise<ResearcherRun[]> {
  const started = Date.now();
  const controllers = researchers.map(() => new AbortController());
  const onParentAbort = () => controllers.forEach(c => c.abort());
  opts.signal.addEventListener("abort", onParentAbort, { once: true });
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const out = await Promise.all(researchers.map(async ([name, r], i) => {
    const c = controllers[i];
    const aborted = new Promise<never>((_, reject) => c.signal.addEventListener("abort", () => reject(new Error(
      opts.signal.aborted ? "timed out (provider budget)" : `timed out (${Math.round(opts.graceMs / 1000)}s after another researcher answered)`,
    )), { once: true }));
    try {
      const text = await Promise.race([r(brief, { signal: c.signal, region: opts.region }), aborted]);
      if (!graceTimer) {
        graceTimer = setTimeout(() => controllers.forEach((o, j) => j !== i && o.abort()), opts.graceMs);
        (graceTimer as any).unref?.();
      }
      return { name, ms: Date.now() - started, text, error: null };
    } catch (err: any) {
      return { name, ms: Date.now() - started, text: null, error: String(err?.message || err).slice(0, 160) };
    }
  }));
  if (graceTimer) clearTimeout(graceTimer);
  opts.signal.removeEventListener("abort", onParentAbort);
  return out;
}

export type Researcher = (brief: string, opts: { signal: AbortSignal; region: string | null }) => Promise<string>;

const claudeResearcher: Researcher = async (brief, { signal, region }) => {
  const client = getAnthropicClient("extended");
  const model = process.env.VALUATION_RESEARCH_MODEL || process.env.ANTHROPIC_REASONER_MODEL || "claude-sonnet-4-6";
  const tool: any = {
    type: "web_search_20250305", name: "web_search",
    max_uses: Number(process.env.VALUATION_RESEARCH_MAX_SEARCHES) || 6,
    user_location: { type: "approximate", country: "US", ...(region ? { region } : {}) },
  };
  const messages: any[] = [{ role: "user", content: brief }];
  let text = "";
  // A long research turn can pause mid-way (stop_reason "pause_turn"); hand
  // it back to continue, a bounded number of times.
  for (let turn = 0; turn < 3; turn++) {
    const resp: any = await client.messages.create(
      { model, max_tokens: 4000, system: RESEARCH_SYSTEM, tools: [tool], messages },
      { signal },
    );
    text = (resp.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    if (resp.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: resp.content });
  }
  return text;
};

const openAiResearcher: Researcher = async (brief, { signal, region }) => {
  const model = process.env.VALUATION_RESEARCH_OPENAI_MODEL || "gpt-5";
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: RESEARCH_SYSTEM,
      input: brief,
      // Research is search-and-transcribe, not deep reasoning: low effort keeps
      // it inside the window (at the default it never answered in time).
      reasoning: { effort: process.env.VALUATION_RESEARCH_OPENAI_EFFORT || "low" },
      tools: [{ type: "web_search", user_location: { type: "approximate", country: "US", ...(region ? { region } : {}) } }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI research ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const json: any = await res.json();
  const text = openAiText(json);
  if (extractJson(text) || !json.id) return text;
  // Live check: on a gold coin it answered in prose after its searches. Ask
  // the same conversation (no new searches) for the JSON it was told to give.
  const again = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model, previous_response_id: json.id, reasoning: { effort: "low" },
      input: "Now return ONLY the JSON object in the required shape, with every price you found. No prose.",
    }),
  });
  if (!again.ok) return text;
  return openAiText(await again.json()) || text;
};

function openAiText(json: any): string {
  if (typeof json?.output_text === "string" && json.output_text) return json.output_text;
  return (json?.output || [])
    .filter((o: any) => o.type === "message")
    .flatMap((o: any) => (o.content || []).filter((c: any) => c.type === "output_text").map((c: any) => c.text))
    .join("\n");
}

/** The researchers configured in this environment, by name. */
export function configuredResearchers(): Array<[string, Researcher]> {
  if (researchersOverride) return researchersOverride;
  const out: Array<[string, Researcher]> = [];
  if (process.env.ANTHROPIC_API_KEY && process.env.VALUATION_RESEARCH_CLAUDE !== "0") out.push(["Claude web research", claudeResearcher]);
  if (process.env.OPENAI_API_KEY && process.env.VALUATION_RESEARCH_OPENAI !== "0") out.push(["OpenAI web research", openAiResearcher]);
  return out;
}

let researchersOverride: Array<[string, Researcher]> | null = null;
/** Test seam: replace the researchers (null restores the configured ones). */
export function setResearchersForTest(list: Array<[string, Researcher]> | null): void { researchersOverride = list; }

const US_STATE_RE = /^[A-Z]{2}$/;
function regionOf(ctx: ValuationContext): string | null {
  const s = ctx.attributes.state;
  if (typeof s === "string" && s.trim()) return US_STATE_RE.test(s.trim()) ? s.trim() : s.trim().slice(0, 40);
  return null;
}

export const marketResearchProvider: EvidenceProvider = {
  id: "market-research",
  supports(_ctx, plan) {
    return plan.providers.includes("market-research") && configuredResearchers().length > 0;
  },
  async fetch(run: ProviderRun): Promise<ValuationEvidence[]> {
    const { ctx, now } = run;
    const vin = ctx.identifiers.vin && ctx.identifiers.vin.length === 17 ? ctx.identifiers.vin : findVin(ctx.dossier.notes);
    const decoded = vin ? await decodeVin(vin, run.signal) : {};
    const brief = researchBrief(ctx, decoded);
    const region = regionOf(ctx);

    const researchers = configuredResearchers();
    const runs = await runResearchers(researchers, brief, { signal: run.signal, region, graceMs: RESEARCH_GRACE_MS });
    const results: Array<{ name: string; result: ResearchResult }> = [];
    const errors: string[] = [];
    const assetIsNew = isAssetNew(ctx.condition, ctx.ageYears);
    for (const r of runs) {
      if (r.error != null) { errors.push(`${r.name}: ${r.error}`); continue; }
      const parsed = extractJson(r.text!);
      if (!parsed) { errors.push(`${r.name}: no JSON in response`); r.error = "no JSON in response"; continue; }
      const result = normalizeResearch(parsed);
      result.observations = excludeNewUnits(result.observations, assetIsNew);
      // A new unit's price the model did not put in newPrice still tells us the price new.
      if (result.newPrice == null) {
        const news = result.observations.filter(o => o.basis === "new_retail").map(o => o.price).sort((a, b) => a - b);
        if (news.length) result.newPrice = news[Math.floor(news.length / 2)];
      }
      results.push({ name: r.name, result });
    }
    if (results.length === 0) throw new Error(errors.join("; ") || "market research returned nothing");
    if (errors.length) logger.warn("valuation", `market research partial for ${ctx.profileId}: ${errors.join("; ")}`);

    // Comparables age far slower than the market window that schedules
    // refreshes: a sale three months ago still says a lot about today.
    const halfLifeMs = Math.max(90 * MS_PER_DAY, run.plan.marketFreshnessMs * 6);
    const evidence: ValuationEvidence[] = [];
    results.forEach(({ result }, k) => {
      evidence.push(...observationsToEvidence(result.observations, { now, halfLifeMs, provider: `${this.id}-${k}`, geographic: region })
        .map(e => ({ ...e, provider: this.id })));
    });

    // Specs: the VIN decode is authoritative; research fills what it didn't.
    const specs: Record<string, string | number> = {};
    for (const { result } of results) for (const [k, v] of Object.entries(result.specs)) if (FILLABLE_SPECS.has(k) && !(k in specs)) specs[k] = v;
    for (const [k, v] of Object.entries(decoded)) if (FILLABLE_SPECS.has(k)) specs[k] = v;

    const newPrices = results.map(r => r.result.newPrice).filter((n): n is number => n != null).sort((a, b) => a - b);
    // The ceiling applies only when research agrees the thing wears out.
    const depreciates = results.some(r => r.result.depreciates === true) && !results.some(r => r.result.depreciates === false);
    const total = results.reduce((s, r) => s + r.result.observations.length, 0);
    const nowIso = now.toISOString();
    // One qualitative record carries what research learned beyond prices:
    // specs to fill, the price new (a ceiling for things that wear out),
    // sources, and what the owner could add.
    evidence.push({
      id: "market-research:summary",
      kind: "model_estimate",
      source: results.map(r => r.name).join(" + "),
      provider: this.id,
      observedAt: nowIso, fetchedAt: nowIso,
      value: null, currency: DEFAULT_CURRENCY, reliability: 0, relevance: 0, halfLifeMs,
      note: `${total} market price${total === 1 ? "" : "s"} found${results[0]?.result.identity ? ` for ${results[0].result.identity}` : ""}${Object.keys(decoded).length ? " (VIN decoded)" : ""}`,
      raw: {
        specs,
        newPrice: newPrices.length ? newPrices[Math.floor(newPrices.length / 2)] : null,
        depreciates,
        missing: [...new Set(results.flatMap(r => r.result.missing))].slice(0, 5),
        sources: [...new Set(results.flatMap(r => r.result.observations.map(o => o.url).filter((u): u is string => !!u)))].slice(0, 8),
        vinDecoded: Object.keys(decoded).length > 0,
        // How each researcher did — the record shows it without log access.
        researchers: runs.map(r => ({ name: r.name, ms: r.ms, ok: r.error == null, error: r.error, prices: results.find(x => x.name === r.name)?.result.observations.length ?? 0 })),
      },
    });
    return evidence;
  },
};
