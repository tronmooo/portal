// ── Overview semantics (2026-08-26) ──────────────────────────────────────────
// The layer that answers "what IS this, and what does each thing we know about
// it mean?" — before anything is laid out. Pure, no I/O, no per-type templates.
//
// The rule this module exists to enforce: nothing here may key off a specific
// product ("if it's a house, show the address"). It reasons about SHAPE —
// what the field key means, what the value looks like, what family of thing
// the entity belongs to — so an entity nobody designed for (a boat, a patent,
// a solar install, a racehorse) gets the same quality of reasoning as a car.
//
// Pinned by tests/overview-compose.test.ts.

import { canonicalFieldKey } from "./profile-field-canon";
import { humanizeFieldName } from "./field-label";
import { isAssetTabProfile, isLiabilityTabProfile } from "./asset-value";
import type { DateMeaning, DisplayType, Importance } from "./overview-spec";

// ── Field roles ──────────────────────────────────────────────────────────────

export type FieldRole =
  | "identity"        // what this individual thing is: make, model, VIN, serial
  | "descriptive"     // characteristics: color, size, beds/baths, capacity
  | "specification"   // technical detail: engine, storage, voltage
  | "financial"       // money and rates
  | "date"            // anything temporal
  | "status"          // lifecycle / condition / state
  | "ownership"       // who holds it and how much
  | "location"        // where it is
  | "contact"         // who to call about it
  | "coverage"        // insurance-ish terms: limits, deductibles, carrier
  | "usage"           // odometer, hours, cycles, occupancy
  | "note"            // free text
  | "administrative"; // internal bookkeeping — never Overview material

export interface FieldSemantics {
  key: string;            // canonical key
  label: string;
  role: FieldRole;
  displayType: DisplayType;
  importance: Importance;
  dateMeaning?: DateMeaning;
  /** Title of the group this field belongs in, when grouped. */
  group: string;
}

/** Keys the app writes for itself. These are administrative by definition —
 *  they describe our processing, not the entity. */
const ADMIN_KEY_RE = /^(_|id$|userId|createdAt|updatedAt|deletedAt|sourceDocument|extractedFrom|extraction|importBatch|syncedAt|lastSync|schemaVersion|aiGenerated|embedding|searchText|slug$)/i;
const ADMIN_EXACT = new Set([
  "ownerProfileId", "owner_profile_id", "parentProfileId", "linkedObligationId",
  "assetSubtype", "asset_subtype", "typeKey", "type_key",
  "valuationMethod", "valuationDate", "valuationConfidence", "valuationRange",
  "valuation_method", "valuation_date", "valuation_confidence", "valuation_range",
  "previousValue", "previous_value", "includeInNetWorth", "countTowardOwner",
  "balanceHistory", "balance_history", "currency",
  // Financial-asset DATA (shared/financial-assets.ts): observations, positions,
  // activity, provenance and the source connection. The account's own overview
  // renders them; as generic fields they would be arrays of objects.
  "balanceSnapshots", "balance_snapshots", "holdings", "investmentActivity", "investment_activity",
  "fieldSources", "field_sources", "connection", "possibleDuplicateOf", "performanceHistory", "performance_history",
]);

// Role patterns. Order matters — first match wins, so the narrow patterns
// (a date that is also a money word, e.g. "paymentDueDate") come first.
const ROLE_PATTERNS: Array<{ re: RegExp; role: FieldRole }> = [
  { re: /(date|expires?|expiration|expiry|renew|due|maturit|issued|anniversar|deadline|since|until|term(start|end)|start(ed)?$|end(s|ed)?$)/i, role: "date" },
  { re: /(status|state$|condition|stage|phase|active|closed|lifecycle|disposition)/i, role: "status" },
  { re: /(owner|ownership|share|stake|equity(percent|share)|beneficiar|titleholder|cosigner|co_signer)/i, role: "ownership" },
  { re: /(deductible|coveragelimit|coverage|premium|policylimit|liabilitylimit|carrier|insurer|underwriter)/i, role: "coverage" },
  { re: /(value|price|cost|balance|payment|amount|principal|rate|apr|interest|fee|tax|escrow|income|rent|revenue|payoff|down|loan|debt|assess)/i, role: "financial" },
  { re: /(address|street|city|state|zip|postal|county|country|region|location|coordinates|lat$|lng$|parcel|lot$|garage|storage(location)?)/i, role: "location" },
  { re: /(phone|email|contact|website|url|agent|representative|support)/i, role: "contact" },
  { re: /(vin|serial|imei|plate|licens|account(number|no)?$|policynumber|policyno|number$|identifier|sku|isbn|registration(number)?|parcelnumber|tagnumber)/i, role: "identity" },
  { re: /(make|manufacturer|brand|model|year|trim|make_model|variant|edition|breed|species|issuer|lender|servicer|provider|institution)/i, role: "identity" },
  { re: /(mileage|odometer|hours|cycles|usage|occupanc|utilization|readings?$|milesdriven)/i, role: "usage" },
  { re: /(engine|transmission|drivetrain|cpu|processor|memory|storage|capacity|voltage|wattage|horsepower|displacement|resolution|spec|dimensions|weight|material|size)/i, role: "specification" },
  { re: /(color|colour|style|type$|category|class|finish|beds?|baths?|bedrooms|bathrooms|sqft|squarefeet|squarefootage|acres|floors|stories|rooms|features|amenities)/i, role: "descriptive" },
  { re: /(notes?|description|comments?|summary|about|bio|details)/i, role: "note" },
];

const DATE_MEANING_PATTERNS: Array<{ re: RegExp; meaning: DateMeaning }> = [
  { re: /warrant/i, meaning: "warranty" },
  { re: /registration|registered|tag(expiration|renewal)/i, meaning: "registration" },
  { re: /renew/i, meaning: "renewal" },
  { re: /expir|expires|validthrough|goodthrough/i, meaning: "expiration" },
  { re: /(payment|due|bill)/i, meaning: "payment" },
  { re: /maturit|payoff/i, meaning: "maturity" },
  { re: /lease(end|expiration|termination)|tenanc/i, meaning: "lease_end" },
  { re: /inspect/i, meaning: "inspection" },
  { re: /(service|maintenance|oilchange|tuneup)/i, meaning: "maintenance" },
  { re: /tax/i, meaning: "tax" },
  { re: /purchase|acquired|bought|closing/i, meaning: "purchase" },
  { re: /start|begin|effective|issued|opened/i, meaning: "start" },
];

/** Dates whose meaning is forward-looking — these can drive attention items. */
export const ACTIONABLE_DATE_MEANINGS = new Set<DateMeaning>([
  "expiration", "renewal", "payment", "warranty", "registration",
  "maturity", "lease_end", "inspection", "maintenance", "tax",
]);

const MONEY_KEY_RE = /(value|price|cost|balance|payment|amount|principal|premium|deductible|fee|escrow|income|rent|payoff|down|limit|assessed|worth|salary|revenue)/i;
const RATE_KEY_RE = /(rate|apr|apy|yield|percent|pct|ratio|ltv)/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T|$)/;
const LOOSE_DATE_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4}|[A-Z][a-z]{2,8} \d{1,2},? \d{4})$/;

/** Group title for a role — the semantic bucket a field lands in when the
 *  Overview needs grouped details. Titles are generic on purpose. */
const ROLE_GROUP: Record<FieldRole, string> = {
  identity: "Identity",
  descriptive: "Characteristics",
  specification: "Specifications",
  financial: "Financial",
  date: "Dates",
  status: "Status",
  ownership: "Ownership",
  location: "Location",
  contact: "Contacts",
  coverage: "Coverage",
  usage: "Usage",
  note: "Notes",
  administrative: "Administrative",
};

export function isAdministrativeKey(key: string): boolean {
  return ADMIN_KEY_RE.test(key) || ADMIN_EXACT.has(key);
}

function inferDisplayType(key: string, value: unknown, role: FieldRole): DisplayType {
  if (role === "date") return "date";
  if (RATE_KEY_RE.test(key)) return "percent";
  if (role === "financial" || role === "coverage") {
    if (MONEY_KEY_RE.test(key)) {
      return /monthly|permonth|\/mo/i.test(key) ? "moneyPerMonth" : "money";
    }
    if (typeof value === "number") return "number";
  }
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") {
    if (ISO_DATE_RE.test(value) || LOOSE_DATE_RE.test(value)) return "date";
    if (/^https?:\/\//i.test(value)) return "url";
    if (value.length > 140) return "longText";
  }
  if (role === "identity" && /(vin|serial|number|imei|plate|policy|account)/i.test(key)) return "identifier";
  if (role === "status") return "badge";
  if (typeof value === "number") return "number";
  return "text";
}

export function dateMeaningFor(key: string): DateMeaning {
  for (const { re, meaning } of DATE_MEANING_PATTERNS) if (re.test(key)) return meaning;
  return "generic";
}

/** Financial keys that carry the entity's headline number, in preference
 *  order. Generic across families: assets lead with worth, debts with what's
 *  owed, policies with what they cost. */
const HEADLINE_FINANCIAL_KEYS = [
  "currentValue", "balance", "estimatedValue", "premium", "monthlyPayment",
  "purchasePrice", "principal", "amount",
];

function baseImportance(key: string, role: FieldRole, value: unknown): Importance {
  if (isAdministrativeKey(key)) return "administrative";
  switch (role) {
    case "financial":
      return HEADLINE_FINANCIAL_KEYS.includes(canonicalFieldKey(key)) || MONEY_KEY_RE.test(key) || RATE_KEY_RE.test(key)
        ? "primary" : "secondary";
    case "status":
      return "primary";
    case "date":
      return ACTIONABLE_DATE_MEANINGS.has(dateMeaningFor(key)) ? "primary" : "secondary";
    case "identity":
      // A brand/model/lender names the thing; a VIN/serial identifies it for
      // paperwork. Both matter, only the first is at-a-glance material.
      return /(make|manufacturer|brand|model|year|lender|issuer|provider|carrier|institution)/i.test(key)
        ? "primary" : "secondary";
    case "ownership":
      return "primary";
    case "location":
      return /^(address|streetAddress|addressLine1|location)$/i.test(key) ? "primary" : "secondary";
    case "coverage":
      return "secondary";
    case "usage":
      return "secondary";
    case "descriptive":
      return "secondary";
    case "specification":
      return "detailed";
    case "contact":
      return "detailed";
    case "note":
      return typeof value === "string" && value.length > 400 ? "detailed" : "secondary";
    default:
      return "secondary";
  }
}

/** Classify one stored field. `key` may be any spelling — it is canonicalized
 *  first so "current_value", "marketValue" and "currentValue" agree. */
export function fieldSemantics(rawKey: string, value: unknown): FieldSemantics {
  const key = canonicalFieldKey(rawKey);
  let role: FieldRole = "descriptive";
  if (isAdministrativeKey(rawKey)) {
    role = "administrative";
  } else {
    for (const { re, role: r } of ROLE_PATTERNS) {
      if (re.test(key)) { role = r; break; }
    }
    // Value shape can override an unhelpful key: an unknown key holding an ISO
    // date is a date, whatever it's called.
    if (role === "descriptive" && typeof value === "string" && (ISO_DATE_RE.test(value) || LOOSE_DATE_RE.test(value))) {
      role = "date";
    }
  }
  const displayType = inferDisplayType(key, value, role);
  const semantics: FieldSemantics = {
    key,
    label: humanizeFieldName(key),
    role,
    displayType,
    importance: baseImportance(key, role, value),
    group: ROLE_GROUP[role],
  };
  if (role === "date") semantics.dateMeaning = dateMeaningFor(key);
  return semantics;
}

// ── Entity classification ────────────────────────────────────────────────────

export type EntityClass = "asset" | "liability" | "other";

export interface OverviewEntityClassification {
  entityClass: EntityClass;
  /** Open vocabulary. Known families get a name; anything else is "generic",
   *  which is a first-class outcome — composition works either way. */
  semanticCategory: string;
  subtype?: string;
  entityLabel: string;
  confidence: "high" | "medium" | "low";
}

/** Signals for common families. These do NOT drive layout — layout comes from
 *  the fields the entity actually has. They only set a label, a sensible
 *  ordering bias, and which derived metrics are worth attempting. */
const CATEGORY_SIGNALS: Array<{ category: string; label: string; keys: RegExp; words: RegExp }> = [
  { category: "real_estate", label: "Property",
    keys: /^(address|streetAddress|squareFootage|sqft|bedrooms|bathrooms|lotSize|yearBuilt|parcelNumber|propertyTax|hoa)/i,
    words: /\b(house|home|property|condo|apartment|duplex|land|acreage|cabin|townhouse|real estate)\b/i },
  { category: "vehicle", label: "Vehicle",
    keys: /^(vin|licensePlate|mileage|odometer|make|model|trim|engineType)/i,
    words: /\b(car|truck|suv|vehicle|motorcycle|van|sedan|coupe|rv|trailer|boat|atv)\b/i },
  { category: "electronics", label: "Device",
    keys: /^(serialNumber|imei|storageCapacity|processor|screenSize)/i,
    words: /\b(phone|laptop|computer|tv|television|tablet|console|camera|monitor|headphones|watch)\b/i },
  { category: "financial_account", label: "Account",
    keys: /^(accountNumber|institution|apy|availableBalance|creditLimit)/i,
    words: /\b(account|savings|checking|brokerage|401k|ira|hsa|cd)\b/i },
  { category: "investment", label: "Investment",
    keys: /^(shares|costBasis|ticker|symbol|dividend)/i,
    words: /\b(stock|shares|fund|etf|crypto|bitcoin|portfolio|equity stake)\b/i },
  { category: "insurance", label: "Policy",
    keys: /^(policyNumber|premium|deductible|coverageLimit|carrier|insurer)/i,
    words: /\b(insurance|policy|coverage|warranty plan)\b/i },
  { category: "mortgage", label: "Mortgage",
    keys: /^(escrow|principal|originalPrincipal|loanTerm)/i,
    words: /\b(mortgage|heloc|home loan|second lien)\b/i },
  { category: "loan", label: "Loan",
    keys: /^(principal|loanTerm|lender|monthlyPayment|interestRate)/i,
    words: /\b(loan|financing|note|lease|installment)\b/i },
  { category: "credit_line", label: "Credit line",
    keys: /^(creditLimit|minimumPayment|statementBalance|utilization)/i,
    words: /\b(credit card|line of credit|revolving|visa|mastercard|amex)\b/i },
  { category: "recurring_bill", label: "Recurring bill",
    keys: /^(frequency|nextDueDate|autopay|billingCycle)/i,
    words: /\b(subscription|membership|bill|utility|internet|streaming|plan)\b/i },
  { category: "collectible", label: "Collectible",
    keys: /^(appraisedValue|grade|edition|provenance|artist|mintage)/i,
    words: /\b(collectible|art|painting|coin|card|antique|guitar|watch collection|memorabilia|jewelry)\b/i },
  { category: "equipment", label: "Equipment",
    keys: /^(hoursUsed|serviceInterval|capacity|horsepower)/i,
    words: /\b(equipment|machine|tractor|generator|mower|tool|hvac|solar|panel|system)\b/i },
  { category: "intangible", label: "Intangible asset",
    keys: /^(registrationNumber|filingDate|jurisdiction|renewalFee|domain)/i,
    words: /\b(patent|trademark|copyright|domain|license|royalt|business interest|llc|shares of)\b/i },
];

export interface ClassifiableEntity {
  type?: string | null;
  type_key?: string | null;
  typeKey?: string | null;
  name?: string | null;
  tags?: string[] | null;
  fields?: Record<string, any> | null;
}

/**
 * What family does this entity belong to, and is it an asset or a liability?
 * Scores name / tags / type keys / field-key shape. An unrecognized entity
 * scores nothing and comes back "generic" with low confidence — which is a
 * usable answer, not a failure: composition falls back to reasoning purely
 * from the fields present.
 */
export function classifyOverviewEntity(entity: ClassifiableEntity): OverviewEntityClassification {
  const typeKey = String(entity.type_key || entity.typeKey || "").toLowerCase();
  const type = String(entity.type || "").toLowerCase();
  const name = String(entity.name || "");
  const tags = (entity.tags || []).join(" ");
  const fieldKeys = Object.keys(entity.fields || {});
  const haystack = `${name} ${tags} ${typeKey} ${type}`;

  const scores = new Map<string, number>();
  for (const sig of CATEGORY_SIGNALS) {
    let score = 0;
    if (sig.words.test(haystack)) score += 3;
    if (typeKey && sig.category.startsWith(typeKey)) score += 3;
    if (typeKey && sig.words.test(typeKey)) score += 2;
    for (const k of fieldKeys) if (sig.keys.test(k)) score += 1;
    if (score > 0) scores.set(sig.category, score);
  }

  let best: { category: string; score: number } | null = null;
  for (const [category, score] of scores) {
    if (!best || score > best.score) best = { category, score };
  }

  // The tab predicates are the app's single "which side is this on" answer:
  // exactly one of them claims any row (a mortgaged house is an asset with a
  // liability attached, not both). Using the net-worth sets here instead would
  // call every property a liability, since those sets deliberately overlap.
  const entityClass: EntityClass = isLiabilityTabProfile(entity as any)
    ? "liability"
    : isAssetTabProfile(entity as any)
      ? "asset"
      : "other";

  if (!best) {
    return {
      entityClass,
      semanticCategory: "generic",
      subtype: typeKey || undefined,
      entityLabel: typeKey ? humanizeFieldName(typeKey) : entityClass === "liability" ? "Liability" : "Asset",
      confidence: "low",
    };
  }

  const signal = CATEGORY_SIGNALS.find(s => s.category === best!.category)!;
  return {
    entityClass,
    semanticCategory: signal.category,
    subtype: typeKey || undefined,
    entityLabel: signal.label,
    confidence: best.score >= 4 ? "high" : best.score >= 2 ? "medium" : "low",
  };
}

/** Category-level ordering bias for grouped sections. A property leads with
 *  where it is; a loan leads with what it costs. Unknown categories fall back
 *  to a sensible universal order. */
const CATEGORY_GROUP_ORDER: Record<string, string[]> = {
  real_estate: ["Status", "Location", "Financial", "Ownership", "Characteristics", "Dates", "Coverage", "Usage", "Identity"],
  vehicle: ["Status", "Identity", "Financial", "Usage", "Ownership", "Dates", "Coverage", "Specifications"],
  electronics: ["Status", "Identity", "Financial", "Specifications", "Dates", "Coverage"],
  insurance: ["Status", "Coverage", "Financial", "Dates", "Identity", "Ownership"],
  mortgage: ["Status", "Financial", "Dates", "Ownership", "Identity"],
  loan: ["Status", "Financial", "Dates", "Ownership", "Identity"],
  credit_line: ["Status", "Financial", "Dates", "Identity"],
  recurring_bill: ["Status", "Financial", "Dates", "Identity"],
};

const DEFAULT_GROUP_ORDER = [
  "Status", "Identity", "Financial", "Ownership", "Location",
  "Characteristics", "Usage", "Coverage", "Dates", "Specifications",
  "Contacts", "Notes", "Administrative",
];

export function groupOrderFor(semanticCategory: string): string[] {
  const specific = CATEGORY_GROUP_ORDER[semanticCategory];
  if (!specific) return DEFAULT_GROUP_ORDER;
  // Anything the category doesn't name keeps the universal order after it.
  return [...specific, ...DEFAULT_GROUP_ORDER.filter(g => !specific.includes(g))];
}
