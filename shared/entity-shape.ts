// shared/entity-shape.ts — what KIND of thing is this, and what does information
// about it mean?
// =============================================================================
//
// Why this file exists (screenshot, 2026-08-26):
//
//   A homeowners insurance policy, filed under a house, offered every extracted
//   field the same six choices:
//
//       Profile data · Allergies · Medications · Medical history · Notes · Ignore
//
//   The agent's phone number, eight coverage lines and the annual premium were
//   all sitting on "Profile data", and the only alternatives a person was given
//   for their house were medical.
//
// The cause is one line: `destinationOptionsFor` added allergy, medication and
// medical_history unconditionally, because the destination vocabulary grew out
// of a clinic report. Every document since has been offered a patient's chart.
//
// THE FIX IS NOT A BIGGER SCHEMA. "An asset has these twenty fields" is the
// other failure mode — it turns every new kind of thing into a code change, and
// it cannot describe a boat, a domain name or a storage unit without someone
// first anticipating them. What this module does instead is answer three
// questions about whatever entity is actually in front of us:
//
//   1. What FAMILY of thing is it?   (a house, a car, a debt, a person…)
//   2. What can information about that kind of thing MEAN?
//        → which destinations are even coherent, and which sections it has
//   3. Is this concept one we already have a name for?
//        → so "Square Feet", "Living Area" and "Building Size" become ONE field
//          instead of three, across three documents, forever
//
// Question 3 is what keeps a dynamic shape from becoming schema soup. It is
// deliberately a SYNONYM map, not an allowlist: a field it has never heard of
// still routes and still saves, it just does not get canonicalised. Nothing
// here decides whether a field is permitted — only whether it is a concept we
// already know a name for.
//
// Pure, dependency-light. Pinned by tests/entity-shape.test.ts.
// =============================================================================

import type { ExtractionDestination } from "./extraction-destinations";

// ─── Families ────────────────────────────────────────────────────────────────

/**
 * The kinds of thing this app keeps, at the granularity where information means
 * different things.
 *
 * Coarser than the type registry on purpose. A house and a condo are both
 * `property` — square footage means the same thing to both — while a house and
 * a car are not, because "mileage" is meaningless for one and "year built" for
 * the other. The registry's own `type_key` stays available for finer decisions;
 * this is the level at which ROUTING differs.
 */
export type EntityFamily =
  | "person"
  | "pet"
  | "property"
  | "vehicle"
  | "device"
  | "financial_account"
  | "liability"
  | "subscription"
  | "business"
  | "generic";

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Which family does this record belong to?
 *
 * Reads the registry's `type_key` first, because it is the more specific of the
 * two — a profile typed `asset` with `type_key: "boat"` is a vehicle, and
 * `type` alone would call it generic.
 */
export function entityFamily(profileType?: string | null, typeKey?: string | null): EntityFamily {
  const k = norm(typeKey);
  const t = norm(profileType);

  const match = (s: string, re: RegExp) => s && re.test(s);
  for (const s of [k, t]) {
    if (!s) continue;
    if (match(s, /^(self|person|people|contact|spouse|child|parent|dependent)/)) return "person";
    if (match(s, /^(pet|dog|cat|animal)/)) return "pet";
    if (match(s, /(property|realestate|house|home|condo|apartment|land|rental|building)/)) return "property";
    if (match(s, /(vehicle|car|truck|auto|motorcycle|boat|rv|trailer|vessel|aircraft)/)) return "vehicle";
    if (match(s, /(device|electronics|computer|laptop|phone|appliance|equipment)/)) return "device";
    if (match(s, /(mortgage|loan|liability|debt|creditcard|lineofcredit|bnpl|financing)/)) return "liability";
    if (match(s, /(subscription|membership|streaming|plan)/)) return "subscription";
    if (match(s, /(bankaccount|account|investment|brokerage|retirement|savings|checking)/)) return "financial_account";
    if (match(s, /(business|company|llc|corporation)/)) return "business";
  }
  if (t === "asset") return "generic";
  return "generic";
}

export const FAMILY_LABEL: Record<EntityFamily, string> = {
  person: "person",
  pet: "pet",
  property: "property",
  vehicle: "vehicle",
  device: "device",
  financial_account: "account",
  liability: "liability",
  subscription: "subscription",
  business: "business",
  generic: "record",
};

// ─── What can information about this kind of thing mean? ─────────────────────

/**
 * Destinations that are coherent for EVERY family. A note, a reference row and
 * ignoring something are always sensible answers, whatever the entity.
 */
const UNIVERSAL: ExtractionDestination[] = ["note", "reference", "ignore"];

/**
 * Destinations that make sense for a living thing's health. Offered ONLY to a
 * person or a pet — which is the whole point of this module.
 */
const MEDICAL: ExtractionDestination[] = ["allergy", "medication", "medical_history"];

/** Money, dates and things to do apply to anything that can cost or expire. */
const COMMITMENT: ExtractionDestination[] = [
  "obligation", "liability_payment", "expense", "income", "calendar", "task",
];

const RECORD_FIELDS: ExtractionDestination[] = [
  "entity_field", "entity_record", "structured_append",
];

/**
 * The destinations a field on this kind of entity may be routed to.
 *
 * A house is never offered Allergies. A person is never offered a vehicle's
 * service log. Anything can become a note, and anything can be ignored.
 */
export function destinationsForFamily(family: EntityFamily): ExtractionDestination[] {
  const base: ExtractionDestination[] = [
    ...RECORD_FIELDS, "tracker", "relationship_link", "document_attach", ...COMMITMENT,
  ];
  switch (family) {
    case "person":
      return dedupe([
        "profile", "profile_tracker", ...MEDICAL, ...base, ...UNIVERSAL,
      ]);
    case "pet":
      return dedupe([
        "profile", "profile_tracker", ...MEDICAL, ...base, ...UNIVERSAL,
      ]);
    case "liability":
      // A debt's whole life is money and dates.
      return dedupe([...RECORD_FIELDS, ...COMMITMENT, "tracker", "relationship_link", "document_attach", ...UNIVERSAL]);
    case "property":
    case "vehicle":
    case "device":
    case "financial_account":
    case "subscription":
    case "business":
    case "generic":
    default:
      return dedupe([...base, "profile", ...UNIVERSAL]);
  }
}

/** True when this destination is even offered for this family. */
export function destinationAllowed(family: EntityFamily, d: ExtractionDestination): boolean {
  return destinationsForFamily(family).includes(d);
}

function dedupe<T>(xs: T[]): T[] {
  const out: T[] = [];
  for (const x of xs) if (!out.includes(x)) out.push(x);
  return out;
}

// ─── Sections ────────────────────────────────────────────────────────────────

/**
 * The named groups inside `profile.fields` that this kind of entity can carry.
 *
 * Every value here is one of `PROFILE_FIELD_GROUPS`
 * (shared/profile-field-identity), because those are the groups the profile UI
 * promotes for display and the ones `shared/date-rules` keys its rule ids on by
 * dotted path. Inventing a group name outside that set would produce data that
 * renders nowhere.
 */
export const SECTIONS_BY_FAMILY: Record<EntityFamily, string[]> = {
  person: ["identity", "contact", "health", "emergency", "personal", "finance"],
  pet: ["identity", "health", "contact"],
  property: ["housing", "insurance", "loan", "finance", "utilities"],
  vehicle: ["vehicle", "insurance", "loan", "finance"],
  device: ["other", "insurance", "finance"],
  financial_account: ["finance", "identity"],
  liability: ["loan", "finance", "insurance"],
  subscription: ["subscriptions", "finance"],
  business: ["identity", "finance", "contact"],
  generic: ["other", "finance", "insurance"],
};

/** Is `group` a section this family actually has? */
export function sectionAllowed(family: EntityFamily, group: string): boolean {
  return SECTIONS_BY_FAMILY[family].includes(norm(group) === "" ? group : group);
}

// ─── Concepts: the schema-soup guard ─────────────────────────────────────────

/**
 * One concept, and the many ways documents spell it.
 *
 * `canonical` is the field key that gets written; `aliases` are matched after
 * normalisation, so only genuinely different WORDS need listing — case, spaces,
 * underscores and hyphens are already handled.
 *
 * This table is intentionally SMALL and will stay small. It exists to stop the
 * same fact arriving under three names across three documents, not to enumerate
 * what a property is allowed to have. A concept missing from it costs nothing:
 * the field routes and saves under its own name.
 */
export interface EntityConcept {
  canonical: string;
  aliases: string[];
  /** The section it belongs in, when it belongs in one. */
  group?: string;
  /** True when this value identifies the entity — used for conflict checks. */
  identifying?: boolean;
}

const COMMON_CONCEPTS: EntityConcept[] = [
  { canonical: "purchaseDate", aliases: ["dateacquired", "acquireddate", "boughton", "dateofpurchase"] },
  { canonical: "purchasePrice", aliases: ["pricepaid", "acquisitioncost", "originalprice"] },
  { canonical: "currentValue", aliases: ["estimatedvalue", "marketvalue", "appraisedvalue", "value", "fairmarketvalue"] },
  { canonical: "serialNumber", aliases: ["serialno", "serial"], identifying: true },
];

const CONCEPTS_BY_FAMILY: Record<EntityFamily, EntityConcept[]> = {
  property: [
    { canonical: "address", aliases: ["propertyaddress", "streetaddress", "situsaddress", "locationaddress", "premisesaddress"], group: "housing", identifying: true },
    { canonical: "squareFeet", aliases: ["squarefootage", "livingarea", "buildingsize", "sqft", "totalsqft", "grosslivingarea", "floorarea"], group: "housing" },
    { canonical: "yearBuilt", aliases: ["constructionyear", "builtin", "yearconstructed"], group: "housing" },
    { canonical: "propertyType", aliases: ["dwellingtype", "structuretype", "residencetype"], group: "housing" },
    { canonical: "roofType", aliases: ["roofmaterial", "roofcovering"], group: "housing" },
    { canonical: "constructionType", aliases: ["construction", "framingtype", "exteriorwalls"], group: "housing" },
    { canonical: "occupancy", aliases: ["occupancytype", "occupiedby", "usetype"], group: "housing" },
    { canonical: "stories", aliases: ["numberofstories", "storiescount", "floors"], group: "housing" },
    { canonical: "parcelNumber", aliases: ["apn", "assessorparcelnumber", "taxparcelid"], group: "housing", identifying: true },
    { canonical: "propertyTaxes", aliases: ["annualpropertytax", "taxamount", "realestatetaxes"], group: "finance" },
  ],
  vehicle: [
    { canonical: "vin", aliases: ["vehicleidentificationnumber", "chassisnumber"], group: "vehicle", identifying: true },
    { canonical: "make", aliases: ["manufacturer", "vehiclemake"], group: "vehicle" },
    { canonical: "model", aliases: ["vehiclemodel"], group: "vehicle" },
    { canonical: "year", aliases: ["modelyear", "vehicleyear"], group: "vehicle" },
    { canonical: "mileage", aliases: ["odometer", "odometerreading", "currentmileage", "milesdriven"], group: "vehicle" },
    { canonical: "licensePlate", aliases: ["plate", "platenumber", "registrationplate", "tagnumber"], group: "vehicle", identifying: true },
    { canonical: "registrationExpiration", aliases: ["regexpires", "tagexpiration", "registrationexpires"], group: "vehicle" },
  ],
  liability: [
    { canonical: "currentBalance", aliases: ["principalbalance", "outstandingbalance", "unpaidbalance", "remainingbalance", "payoffbalance", "balance"], group: "loan" },
    { canonical: "annualRate", aliases: ["interestrate", "apr", "rate", "noterate"], group: "loan" },
    { canonical: "monthlyPayment", aliases: ["paymentamount", "regularpayment", "scheduledpayment", "installmentamount"], group: "loan" },
    { canonical: "minimumPayment", aliases: ["minpayment", "minimumamountdue"], group: "loan" },
    { canonical: "lender", aliases: ["creditor", "servicer", "lienholder", "mortgagee", "financialinstitution"], group: "loan" },
    { canonical: "loanNumber", aliases: ["accountnumber", "loanaccountnumber", "loanid"], group: "loan", identifying: true },
    { canonical: "maturityDate", aliases: ["payoffdate", "finalpaymentdate", "loanenddate", "termenddate"], group: "loan" },
    { canonical: "originalBalance", aliases: ["originalloanamount", "principalamount", "loanamount"], group: "loan" },
    { canonical: "escrowMonthly", aliases: ["escrowpayment", "escrowamount"], group: "loan" },
  ],
  financial_account: [
    { canonical: "accountNumber", aliases: ["acctnumber", "accountno"], group: "finance", identifying: true },
    { canonical: "institution", aliases: ["bank", "bankname", "custodian", "brokerage"], group: "finance" },
    { canonical: "currentValue", aliases: ["balance", "accountbalance", "marketvalue"], group: "finance" },
  ],
  subscription: [
    { canonical: "billingFrequency", aliases: ["billingcycle", "renewalfrequency", "planinterval"], group: "subscriptions" },
    { canonical: "monthlyAmount", aliases: ["subscriptionprice", "planprice", "recurringamount"], group: "subscriptions" },
  ],
  person: [
    { canonical: "dateOfBirth", aliases: ["dob", "birthday", "birthdate"], group: "identity", identifying: true },
    { canonical: "bloodType", aliases: ["bloodgroup"], group: "health" },
    { canonical: "phone", aliases: ["phonenumber", "mobile", "cellphone", "telephone"], group: "contact" },
    { canonical: "email", aliases: ["emailaddress"], group: "contact" },
    { canonical: "address", aliases: ["mailingaddress", "streetaddress", "homeaddress"], group: "contact" },
  ],
  pet: [
    { canonical: "species", aliases: ["animaltype"], group: "identity" },
    { canonical: "breed", aliases: [], group: "identity" },
    { canonical: "microchipNumber", aliases: ["microchip", "chipnumber"], group: "identity", identifying: true },
  ],
  device: [],
  business: [
    { canonical: "ein", aliases: ["taxid", "employeridentificationnumber"], group: "identity", identifying: true },
  ],
  generic: [],
};

/**
 * Concepts that describe an insurance RELATIONSHIP rather than the thing
 * insured. They live in the `insurance` section of whatever they cover, which
 * is how an agent's phone number stays attached to the policy instead of
 * becoming the house's phone number.
 */
const INSURANCE_CONCEPTS: EntityConcept[] = [
  { canonical: "policyNumber", aliases: ["policyno", "policyid"], group: "insurance", identifying: true },
  { canonical: "carrier", aliases: ["insurer", "insurancecompany", "underwriter", "companyname"], group: "insurance" },
  { canonical: "agentName", aliases: ["agentagencyname", "agencyname", "producername"], group: "insurance" },
  { canonical: "agentPhone", aliases: ["agencyphone", "producerphone"], group: "insurance" },
  { canonical: "agentEmail", aliases: ["agencyemail"], group: "insurance" },
  { canonical: "agentAddress", aliases: ["agencyaddress"], group: "insurance" },
  { canonical: "annualPremium", aliases: ["premium", "totalpremium", "policypremium", "totalpolicypremium"], group: "insurance" },
  { canonical: "deductible", aliases: ["policydeductible"], group: "insurance" },
  { canonical: "effectiveDate", aliases: ["policyeffectivedate", "coveragestart", "policystart"], group: "insurance" },
  { canonical: "expirationDate", aliases: ["policyexpiration", "coverageend", "policyend"], group: "insurance" },
  { canonical: "namedInsured", aliases: ["policyholder", "insuredname"], group: "insurance" },
];

export interface ConceptMatch {
  canonical: string;
  group?: string;
  identifying: boolean;
}

/**
 * Is this field a concept we already have a name for?
 *
 * Returns null when it is not — and that is a perfectly good outcome. An
 * unrecognised field keeps its own key and routes normally; all this decides is
 * whether we already know that "Living Area" and "Square Feet" are the same
 * fact about a house.
 *
 * `context` widens the search: a field on a document that is ABOUT insurance
 * also considers the insurance concepts, so an agent's phone lands in the
 * policy section of the house rather than on the house itself.
 */
export function matchConcept(
  family: EntityFamily,
  keyOrLabel: string,
  context?: { insurance?: boolean },
): ConceptMatch | null {
  const n = norm(keyOrLabel);
  if (!n) return null;

  const pools: EntityConcept[][] = [];
  if (context?.insurance) pools.push(INSURANCE_CONCEPTS);
  pools.push(CONCEPTS_BY_FAMILY[family] ?? []);
  pools.push(COMMON_CONCEPTS);

  for (const pool of pools) {
    for (const c of pool) {
      if (norm(c.canonical) === n || c.aliases.some((a) => norm(a) === n)) {
        return { canonical: c.canonical, group: c.group, identifying: c.identifying === true };
      }
    }
  }
  return null;
}

/**
 * The canonical key for a field, or the key itself when the concept is new.
 *
 * This is the whole schema-soup guard in one call: three documents spelling the
 * same fact three ways converge on one field, and a genuinely new fact is left
 * alone rather than being forced into the nearest existing one.
 */
export function canonicalFieldName(
  family: EntityFamily,
  keyOrLabel: string,
  context?: { insurance?: boolean },
): string {
  return matchConcept(family, keyOrLabel, context)?.canonical ?? keyOrLabel;
}

// ─── Identity ────────────────────────────────────────────────────────────────

/**
 * Values that say WHICH entity a document is about.
 *
 * Compared against the record the document was filed under, so a policy for a
 * different address, or a statement for a different VIN, becomes a warning
 * instead of quietly overwriting the wrong house.
 */
export function identifyingConcepts(family: EntityFamily): string[] {
  return [...(CONCEPTS_BY_FAMILY[family] ?? []), ...COMMON_CONCEPTS]
    .filter((c) => c.identifying)
    .map((c) => c.canonical);
}

/**
 * Street-type abbreviations, so a stored "123 Evergreen Ln" and a printed
 * "123 Evergreen Lane, Springfield, CO 80501" are recognised as the same place.
 *
 * Without this the comparison is not merely imprecise, it is backwards: it
 * reports a conflict on the single most common way an address legitimately
 * differs between a record and a document, and a warning that cries wolf on
 * every correctly-filed policy is worse than no warning at all.
 */
const STREET_SUFFIXES: Record<string, string> = {
  ln: "lane", st: "street", ave: "avenue", av: "avenue", rd: "road",
  dr: "drive", ct: "court", blvd: "boulevard", cir: "circle", pl: "place",
  ter: "terrace", pkwy: "parkway", hwy: "highway", sq: "square", trl: "trail",
  apt: "apartment", ste: "suite", n: "north", s: "south", e: "east", w: "west",
};

/** Words, lowercased, with street abbreviations spelled out. */
function addressTokens(v: unknown): string[] {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => STREET_SUFFIXES[t] ?? t);
}

/** Loose equality for identifiers: case, spacing and punctuation never matter. */
export function identifiersAgree(a: unknown, b: unknown): boolean {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return true;              // nothing to disagree about
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  // Addresses: the shorter one's words must all appear in the longer one, with
  // abbreviations expanded. "123 Evergreen Ln" ⊂ "123 Evergreen Lane,
  // Springfield, CO 80501" agrees; "14 Oak Street" does not.
  const ta = addressTokens(a), tb = addressTokens(b);
  if (ta.length > 1 && tb.length > 1) {
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    const longSet = new Set(long);
    if (short.every((t) => longSet.has(t))) return true;
  }
  return false;
}
