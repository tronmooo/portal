// ─── Valuation Context Builder ───────────────────────────────────────────────
//
// Turns everything the app knows about an asset (the AssetDataBundle the
// server resolves) into ONE normalized ValuationContext: which facts
// materially affect market value, what identifiers the market could look up,
// what the user has said the thing is worth, what it cost, what documents
// appraised it at, and a deterministic fingerprint over exactly those facts.
//
// Relevance is decided by SEMANTIC ROLE of each field (shared/overview-
// semantics), not by a per-asset-type field list: identity, specification,
// usage, location and condition facts are material; contacts, coverage,
// ownership plumbing, administrative keys and — critically — the outputs of
// prior valuations are not. Changing an irrelevant field therefore leaves the
// fingerprint alone, and a stored valuation stays valid.
//
// Pure: no I/O, no Date.now() except through `now`.

import { parseMoney } from "../asset-value";
import { toMonthlyAmount } from "../obligation-windows";
import { classifyOverviewEntity, fieldSemantics, isAdministrativeKey } from "../overview-semantics";
import { PROFILE_FIELD_GROUPS } from "../profile-field-identity";
import type {
  AssetDataBundle,
  ValuationContext,
  ValuationHistoryEntry,
} from "./types";

// ── Prior-valuation outputs ────────────────────────────────────────────────
// Written by the estimator. They are never inputs: feeding them back would
// anchor the next estimate on the last one (and re-fingerprinting them would
// make every refresh invalidate itself).
const PRIOR_VALUATION_KEYS = new Set([
  "currentvalue", "previousvalue", "estimatedvalue", "estimatedcurrentvalue",
  "valuationmethod", "valuationconfidence", "valuationrange", "valuationdate",
  "valuationlow", "valuationhigh", "valuationfactors", "valuationmissinginfo",
  "valuationsources", "lastvaluedat", "currentvaluesource",
]);
export function isPriorValuationKey(key: string): boolean {
  return PRIOR_VALUATION_KEYS.has(String(key || "").toLowerCase());
}

/** Keys that never leave the app in a valuation prompt and never affect value. */
const SENSITIVE_KEY_RE = /(ssn|social.?security|passport|driver.?s?.?licen[cs]e|licen[cs]e.?(no|num|number)|policy.?(no|num|number)|account.?(no|num|number)|routing|card.?(no|num|number)|cvv|\bpin\b|password|secret|token|date.?of.?birth|\bdob\b|birth.?date|phone|email|\bavatar\b|photo|image)/i;

/** Value keys a user types a worth into. First hit wins. */
const USER_VALUE_KEYS = ["currentValue", "current_value", "marketValue", "market_value", "value", "estimatedValue", "estimated_value", "balance", "accountBalance", "account_balance"];
const APPRAISAL_KEYS: Array<{ key: string; dateKeys: string[]; label: string }> = [
  { key: "appraisedValue", dateKeys: ["appraisalDate", "lastAppraisedDate", "appraisedAt"], label: "Appraised value" },
  { key: "assessedValue", dateKeys: ["assessmentDate", "assessedAt", "taxYear"], label: "Assessed value" },
  { key: "insuredValue", dateKeys: ["policyStartDate", "insuredAt"], label: "Insured value" },
];
const PURCHASE_PRICE_KEYS = ["purchasePrice", "purchase_price", "costBasis", "cost_basis", "originalPrice", "original_price", "pricePaid", "cost"];
const PURCHASE_DATE_KEYS = ["purchaseDate", "purchase_date", "acquiredDate", "acquired", "dateAcquired", "boughtOn", "purchasedOn"];
const QUANTITY_KEYS = ["shares", "quantity", "units", "qty", "coins", "holdings", "sharesHeld", "unitsHeld", "amountHeld"];
const SYMBOL_KEYS = ["ticker", "symbol", "tickerSymbol", "ticker_symbol", "pair", "cryptoSymbol", "coin"];
const CONDITION_KEYS = ["condition", "conditionGrade", "grade", "wear", "state"];
const USAGE_KEYS = ["mileage", "odometer", "miles", "hours", "hoursUsed", "engineHours", "cycles", "usage"];

const UPGRADE_RE = /upgrade|install|new (tires?|wheels?|roof|hvac|engine|transmission|battery|windows?|kitchen|bath)|remodel|renovat|addition|improvement|lift kit|tint|stereo|solar|restor/i;
const REPAIR_RE = /repair|maintenance|service|oil change|brake|fix|replac|tune[- ]?up|inspection|alignment|rotat|flush|filter|spark plug|timing belt|detail/i;
const NOTES_SIGNAL_RE = /\b(mint|excellent|good|fair|poor|damaged?|dent|scratch|rust|cracked|broken|leak|salvage|rebuilt|restored|original|garage[- ]kept|one[- ]owner|accident|flood|renovated|remodeled|upgraded|new (roof|tires|engine)|needs work|as[- ]is|totaled|sold)\b/gi;

// ── Small pure helpers ──────────────────────────────────────────────────────

export function flattenFieldGroups(raw: Record<string, any> | null | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  if (!raw || typeof raw !== "object") return out;
  const groups = PROFILE_FIELD_GROUPS as readonly string[];
  for (const g of groups) {
    const nested = raw[g];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const [k, v] of Object.entries(nested)) if (v != null && v !== "") out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(raw)) {
    if (groups.includes(k)) continue;
    if (v != null && v !== "") out[k] = v;
  }
  return out;
}

function firstKey(fields: Record<string, any>, keys: string[]): string | null {
  for (const k of keys) {
    const v = fields[k];
    if (v != null && v !== "") return k;
  }
  return null;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseMoney(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function isoDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && v > 1900 && v < 2200) return `${v}-07-01`; // a bare year
  const s = String(v).trim();
  if (/^\d{4}$/.test(s)) return `${s}-07-01`;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function yearsBetween(fromIso: string | null, now: Date): number | null {
  if (!fromIso) return null;
  const from = new Date(fromIso.length === 10 ? `${fromIso}T12:00:00Z` : fromIso);
  if (isNaN(from.getTime())) return null;
  const years = (now.getTime() - from.getTime()) / (365.25 * 86_400_000);
  return years < 0 ? 0 : Math.round(years * 100) / 100;
}

/** FNV-1a over a string, two lanes, hex — stable in Node and browsers. */
export function stableHash(text: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x7f4a7c15;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c; h2 = Math.imul(h2, 0x01000193 + 2 * (i & 7)) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(",")}}`;
}

function normalizeScalar(v: unknown): string | number | boolean | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().replace(/\s+/g, " ");
    if (!s) return null;
    // A numeric string is the same fact as the number.
    if (/^-?\$?[\d,]+(\.\d+)?$/.test(s)) { const n = parseMoney(s); if (Number.isFinite(n)) return n; }
    return s.length > 160 ? s.slice(0, 160) : s;
  }
  return null;
}

/** Is `fields.currentValue` owned by the estimator (mirrored from a prior run)? */
export function isEstimatorOwnedValue(fields: Record<string, any>): boolean {
  const src = fields?.currentValueSource ?? fields?.current_value_source;
  if (src === "estimate") return true;
  if (src === "user") return false;
  // Legacy: before provenance existed the only writer of these keys was the
  // lookup-value route, which wrote currentValue in the same patch.
  return !!(fields?.valuationMethod || fields?.valuationRange || fields?.valuationDate
    || fields?.valuation_method || fields?.valuation_range || fields?.valuation_date);
}

// ── The builder ─────────────────────────────────────────────────────────────

export function buildValuationContext(bundle: AssetDataBundle, now: Date = new Date()): ValuationContext {
  const p = bundle.profile;
  const raw = p.fields || {};
  const fields = flattenFieldGroups(raw);
  const classification = classifyOverviewEntity({
    type: p.type, type_key: p.type_key, name: p.name, tags: p.tags, fields,
  });

  // ── Material attributes, chosen by semantic role ──
  const attributes: Record<string, string | number | boolean> = {};
  const usage: Record<string, number> = {};
  let condition: string | null = null;
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("_")) continue;
    if (isPriorValuationKey(key) || isAdministrativeKey(key)) continue;
    if (SENSITIVE_KEY_RE.test(key)) continue;
    const scalar = normalizeScalar(value);
    if (scalar === null) continue;
    const sem = fieldSemantics(key, value);
    switch (sem.role) {
      case "contact": case "coverage": case "ownership": case "administrative": case "note":
        continue;
      case "date":
        // Only dates that describe the asset's age matter (purchase, build year); the
        // rest (expirations, renewals, inspections) are operational, not valuation.
        if (!/(purchase|acquir|built|manufactur|model|vintage|mint|issue|release)/i.test(key)) continue;
        break;
      case "financial":
        // Money facts about what it costs to OWN it (tax, HOA, premium, payment)
        // are not what it is worth. Purchase/appraisal/income keys are handled below.
        if (!/(purchase|cost|paid|basis|apprais|assess|rent|income|revenue|replace|msrp|list|retail|insured)/i.test(key)) continue;
        break;
      default:
        break;
    }
    if (USAGE_KEYS.includes(key) && typeof scalar === "number") usage[key] = scalar;
    if (CONDITION_KEYS.includes(key) && typeof scalar === "string") condition = condition || scalar;
    attributes[key] = scalar;
  }

  // ── Identifiers the market can look up ──
  const identifiers: ValuationContext["identifiers"] = {};
  const symbolKey = firstKey(fields, SYMBOL_KEYS);
  if (symbolKey) {
    const s = String(fields[symbolKey]).trim().toUpperCase();
    if (/^[A-Z0-9.\-\/]{1,12}$/.test(s)) identifiers.symbol = s;
  }
  // The model may recognise a tradable instrument the fields don't name. That
  // is applied AFTER the material inputs are captured below: the fingerprint
  // must depend only on stored facts, or a cached understanding loaded on one
  // path and not another would make every freshness check say "changed".
  const aiSymbol = !identifiers.symbol && bundle.understanding?.tradableSymbol
    ? bundle.understanding.tradableSymbol.toUpperCase() : null;
  const vinKey = firstKey(fields, ["vin", "VIN", "vehicleIdentificationNumber"]);
  if (vinKey && /^[A-HJ-NPR-Z0-9]{11,17}$/i.test(String(fields[vinKey]).trim())) identifiers.vin = String(fields[vinKey]).trim().toUpperCase();
  const addressKey = firstKey(fields, ["address", "streetAddress", "propertyAddress", "fullAddress"]);
  if (addressKey) {
    const parts = [fields[addressKey], fields.city, fields.state, fields.zip ?? fields.zipCode ?? fields.postalCode]
      .filter(v => v != null && String(v).trim() !== "").map(v => String(v).trim());
    identifiers.address = parts.join(", ");
  }
  const serialKey = firstKey(fields, ["serialNumber", "serial", "serial_number", "imei"]);
  if (serialKey) identifiers.serial = String(fields[serialKey]).trim();
  const modelNumberKey = firstKey(fields, ["modelNumber", "model_number", "partNumber", "sku"]);
  if (modelNumberKey) identifiers.modelNumber = String(fields[modelNumberKey]).trim();

  // ── Quantity (for instruments and bulk holdings) ──
  const quantityKey = firstKey(fields, QUANTITY_KEYS);
  const quantity = quantityKey ? num(fields[quantityKey]) : null;

  // ── What the user says it's worth vs what the estimator last wrote ──
  const estimatorOwned = isEstimatorOwnedValue(fields);
  let userValue: ValuationContext["userValue"] = null;
  let estimatorValue: number | null = null;
  const valueKey = firstKey(fields, USER_VALUE_KEYS);
  if (valueKey) {
    const v = num(fields[valueKey]);
    if (v != null && v > 0) {
      const isMirrorKey = /^(currentValue|current_value)$/.test(valueKey);
      if (isMirrorKey && estimatorOwned) estimatorValue = v;
      else userValue = {
        value: v,
        asOf: isoDate(fields.currentValueAsOf ?? fields.valueAsOf ?? fields.balanceAsOf ?? fields.balance_as_of ?? fields.lastAppraisedDate ?? null) ?? isoDate(p.updatedAt) ?? null,
        key: valueKey,
      };
    }
  }

  // ── Purchase ──
  const purchasePriceKey = firstKey(fields, PURCHASE_PRICE_KEYS);
  const purchaseDateKey = firstKey(fields, PURCHASE_DATE_KEYS);
  const purchase = {
    price: purchasePriceKey ? num(fields[purchasePriceKey]) : null,
    date: purchaseDateKey ? isoDate(fields[purchaseDateKey]) : null,
  };

  // ── Appraisals: fields first, then anything a linked document extracted ──
  const appraisals: ValuationContext["appraisals"] = [];
  for (const a of APPRAISAL_KEYS) {
    const v = num(fields[a.key]);
    if (v == null || v <= 0) continue;
    const dk = firstKey(fields, a.dateKeys);
    appraisals.push({ value: v, date: dk ? isoDate(fields[dk]) : null, source: `field:${a.key}`, label: a.label });
  }
  for (const d of bundle.documents || []) {
    const ex = d.extractedData;
    if (!ex || typeof ex !== "object") continue;
    const flat = flattenFieldGroups(ex);
    for (const [k, v] of Object.entries(flat)) {
      if (!/(apprais|assess|market.?value|estimated.?value|fair.?value|replacement.?cost|insured.?value)/i.test(k)) continue;
      const n = num(v);
      if (n == null || n <= 0) continue;
      const dateKey = Object.keys(flat).find(x => /(apprais|assess|effective|report|valuation).*date|date.*(apprais|assess)/i.test(x));
      appraisals.push({
        value: n,
        date: (dateKey ? isoDate(flat[dateKey]) : null) ?? isoDate(d.createdAt) ?? null,
        source: `document:${d.id}`,
        label: `${d.name || "Document"} · ${k}`,
      });
    }
  }

  // ── Improvements and upkeep from linked expenses ──
  let upgradesTotal = 0, repairsTotal = 0, count = 0, lastServiceDate: string | null = null;
  for (const e of bundle.expenses || []) {
    const amt = parseMoney(e.amount);
    const hay = `${e.description || ""} ${e.category || ""}`;
    if (UPGRADE_RE.test(hay)) { upgradesTotal += amt; count++; }
    else if (REPAIR_RE.test(hay)) {
      repairsTotal += amt; count++;
      const d = isoDate(e.date);
      if (d && (!lastServiceDate || d > lastServiceDate)) lastServiceDate = d;
    }
  }

  // ── Income the asset produces (rent, royalties, dividends) ──
  // Cadence → monthly goes through the one canonical helper (a one-off
  // amount is not recurring income and contributes nothing).
  let monthlyIncome = 0;
  for (const inc of bundle.incomes || []) {
    const amt = parseMoney(inc.amount);
    if (!(amt > 0)) continue;
    const f = String(inc.frequency || "monthly").toLowerCase();
    if (f === "once" || f === "one-time" || f === "one_time") continue;
    monthlyIncome += toMonthlyAmount(amt, f);
  }
  for (const [k, v] of Object.entries(fields)) {
    if (/^(monthlyRent|rentalIncome|monthlyIncome|rent)$/i.test(k)) { const n = num(v); if (n) monthlyIncome = Math.max(monthlyIncome, n); }
    if (/^(annualRent|annualIncome|yearlyRent)$/i.test(k)) { const n = num(v); if (n) monthlyIncome = Math.max(monthlyIncome, toMonthlyAmount(n, "yearly")); }
  }

  // ── Age ──
  const yearKey = firstKey(fields, ["year", "modelYear", "yearBuilt", "manufactureYear", "vintage", "releaseYear"]);
  const yearVal = yearKey ? Number(String(fields[yearKey]).replace(/\D/g, "")) : NaN;
  const ageYears = yearsBetween(purchase.date, now) ?? (yearVal > 1800 && yearVal <= now.getUTCFullYear() + 1 ? Math.max(0, now.getUTCFullYear() - yearVal) : null);

  // ── Notes: only condition/history words are material, never the prose ──
  const notesText = String(p.notes || "");
  const notesSignals = [...new Set((notesText.match(NOTES_SIGNAL_RE) || []).map(s => s.toLowerCase()))].sort();

  // ── Search-friendly description ──
  const descParts: string[] = [];
  for (const k of ["year", "modelYear", "make", "brand", "manufacturer", "model", "trim", "edition", "variant"]) {
    const v = fields[k]; if (v != null && String(v).trim()) descParts.push(String(v).trim());
  }
  const description = [...new Set([p.name.trim(), ...descParts].filter(Boolean))].join(" ");

  // ── Material inputs + fingerprint ──
  const materialInputs: Record<string, unknown> = {
    name: p.name.trim(),
    entityClass: classification.entityClass,
    category: classification.semanticCategory,
    attributes,
    identifiers,
    quantity,
    userValue: userValue ? { value: userValue.value, asOf: userValue.asOf } : null,
    purchase,
    appraisals: appraisals.map(a => ({ value: a.value, date: a.date, source: a.source })),
    improvements: { upgradesTotal: Math.round(upgradesTotal), repairsTotal: Math.round(repairsTotal), count, lastServiceDate },
    incomeMonthly: monthlyIncome > 0 ? Math.round(monthlyIncome) : null,
    condition,
    notesSignals,
  };
  const inputFingerprint = stableHash(stableStringify(materialInputs));
  if (aiSymbol) identifiers.symbol = aiSymbol;

  const signature = stableHash(stableStringify({
    type: p.type, typeKey: p.type_key || null, category: classification.semanticCategory,
    keys: Object.keys(attributes).sort(), identifiers: Object.keys(identifiers).sort(),
    hasPurchase: purchase.price != null, hasUserValue: !!userValue, hasIncome: monthlyIncome > 0,
    hasAppraisal: appraisals.length > 0, hasQuantity: quantity != null,
  }));

  // ── Data quality ──
  let quality = 0;
  quality += Math.min(0.4, Object.keys(attributes).length * 0.08);
  // Identity facts (who made it, which model, what year) are what the market
  // prices; three of them describe a thing well enough to search for.
  if (["make", "brand", "manufacturer", "model", "year", "modelYear", "artist", "edition"].some(k => attributes[k] != null)) quality += 0.15;
  if (identifiers.symbol || identifiers.vin || identifiers.address) quality += 0.25;
  if (purchase.price) quality += 0.1;
  if (purchase.date) quality += 0.05;
  if (userValue) quality += 0.1;
  if (appraisals.length) quality += 0.1;
  if (condition) quality += 0.05;
  quality = Math.min(1, quality);

  const history: ValuationHistoryEntry[] = [...(bundle.history || [])].sort((a, b) => a.valuedAt.localeCompare(b.valuedAt));

  return {
    profileId: p.id,
    name: p.name,
    entityClass: classification.entityClass,
    classification: {
      semanticCategory: classification.semanticCategory,
      entityLabel: classification.entityLabel,
      confidence: classification.confidence,
    },
    attributes,
    identifiers,
    quantity,
    userValue,
    estimatorValue,
    purchase,
    appraisals,
    improvements: { upgradesTotal: Math.round(upgradesTotal), repairsTotal: Math.round(repairsTotal), count, lastServiceDate },
    income: monthlyIncome > 0 ? { monthly: Math.round(monthlyIncome) } : null,
    condition,
    ageYears,
    usage,
    description,
    notesSignals,
    history,
    understanding: bundle.understanding || null,
    materialInputs,
    inputFingerprint,
    signature,
    dataQuality: quality,
    sparse: quality < 0.2,
    dossier: {
      notes: notesText || null,
      aiSummary: bundle.aiSummary || null,
      expenses: (bundle.expenses || []).map(e => ({ description: e.description, amount: e.amount, category: e.category, date: e.date })),
      documents: (bundle.documents || []).map(d => ({ name: d.name, type: d.type, extractedData: d.extractedData })),
      timeline: (bundle.timeline || []).slice(-10),
      fields: raw,
      type: p.type,
    },
  };
}
