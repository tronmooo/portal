// shared/domain/entity-types.ts — ONE vocabulary for "what kind of thing is this?"
//
// The app carried five overlapping profile-type lists (profile-rename.ts,
// supabase-storage createProfile, ai-engine validTypes, routes childTypes,
// asset-value type sets) and three orthogonal taxonomies (EntityFamily,
// EntityType for cache domains, SemanticEntityKind for extraction). None of
// them answered the product question — "is this a person, an asset, a
// liability, a payment, an event…?" — so a vehicle profile rendered under
// People in search, and a payment could be filed as a second liability.
//
// This module is the canonical answer. Every surface that needs to label,
// group or icon a record (search, chat, notifications, dashboard) resolves
// the record through `canonicalEntityType` and reads `ENTITY_TYPE_META`.
//
// Pure, dependency-light. Pinned by tests/consistency-layer-entities.test.ts.

import { looksLikeObjectPhrase, suggestObjectProfileType } from "../entity-naming";
import { looksLikeAssetName } from "../entity-classify";
import { isDebtAccountKind, accountKindOf } from "../account-kinds";
import { isRecurringBillProfile } from "../liability-types";

export const CANONICAL_ENTITY_TYPES = [
  "person", "pet", "asset", "liability", "account", "subscription",
  "expense", "income", "payment", "event", "task", "reminder", "habit",
  "tracker", "document", "artifact", "note", "journal_entry", "health_record",
  "contact_info", "recurring_rule",
] as const;
export type CanonicalEntityType = (typeof CANONICAL_ENTITY_TYPES)[number];

export function isCanonicalEntityType(v: unknown): v is CanonicalEntityType {
  return typeof v === "string" && (CANONICAL_ENTITY_TYPES as readonly string[]).includes(v);
}

/** The search / navigation group a type belongs to. Never "People" for a thing. */
export type EntityGroup =
  | "People" | "Pets" | "Assets" | "Liabilities" | "Accounts" | "Subscriptions"
  | "Money" | "Calendar" | "Tasks" | "Habits" | "Trackers" | "Documents"
  | "Artifacts" | "Notes" | "Health" | "Contacts";

export interface EntityTypeMeta {
  label: string;
  plural: string;
  group: EntityGroup;
  /** lucide-react icon NAME (the client maps names to components). */
  icon: string;
  /** True when this type represents a human being. */
  isPerson: boolean;
}

export const ENTITY_TYPE_META: Record<CanonicalEntityType, EntityTypeMeta> = {
  person:         { label: "Person",         plural: "People",          group: "People",        icon: "User",          isPerson: true },
  pet:            { label: "Pet",            plural: "Pets",            group: "Pets",          icon: "PawPrint",      isPerson: false },
  asset:          { label: "Asset",          plural: "Assets",          group: "Assets",        icon: "Package",       isPerson: false },
  liability:      { label: "Liability",      plural: "Liabilities",     group: "Liabilities",   icon: "TrendingDown",  isPerson: false },
  account:        { label: "Account",        plural: "Accounts",        group: "Accounts",      icon: "Landmark",      isPerson: false },
  subscription:   { label: "Subscription",   plural: "Subscriptions",   group: "Subscriptions", icon: "Repeat",        isPerson: false },
  expense:        { label: "Expense",        plural: "Expenses",        group: "Money",         icon: "Receipt",       isPerson: false },
  income:         { label: "Income",         plural: "Income",          group: "Money",         icon: "Banknote",      isPerson: false },
  payment:        { label: "Payment",        plural: "Payments",        group: "Money",         icon: "CreditCard",    isPerson: false },
  event:          { label: "Event",          plural: "Events",          group: "Calendar",      icon: "CalendarDays",  isPerson: false },
  task:           { label: "Task",           plural: "Tasks",           group: "Tasks",         icon: "CheckCircle2",  isPerson: false },
  reminder:       { label: "Reminder",       plural: "Reminders",       group: "Tasks",         icon: "Bell",          isPerson: false },
  habit:          { label: "Habit",          plural: "Habits",          group: "Habits",        icon: "Flame",         isPerson: false },
  tracker:        { label: "Tracker",        plural: "Trackers",        group: "Trackers",      icon: "Activity",      isPerson: false },
  document:       { label: "Document",       plural: "Documents",       group: "Documents",     icon: "FileText",      isPerson: false },
  artifact:       { label: "Artifact",       plural: "Artifacts",       group: "Artifacts",     icon: "Sparkles",      isPerson: false },
  note:           { label: "Note",           plural: "Notes",           group: "Notes",         icon: "StickyNote",    isPerson: false },
  journal_entry:  { label: "Journal entry",  plural: "Journal entries", group: "Notes",         icon: "BookOpen",      isPerson: false },
  health_record:  { label: "Health record",  plural: "Health records",  group: "Health",        icon: "HeartPulse",    isPerson: false },
  contact_info:   { label: "Contact",        plural: "Contacts",        group: "Contacts",      icon: "Contact",       isPerson: false },
  recurring_rule: { label: "Recurring rule", plural: "Recurring rules", group: "Calendar",      icon: "RefreshCw",     isPerson: false },
};

/**
 * Where a record came from. This is the "table" a row was read from — the
 * discriminator every existing corpus already carries (search `_type`, the
 * cache-domain `EntityType`, the write manifest).
 */
export type RecordSource =
  | "profile" | "task" | "expense" | "income" | "event" | "habit" | "tracker"
  | "tracker_entry" | "document" | "artifact" | "obligation" | "journal"
  | "memory" | "goal" | "note" | "payment" | "date_rule" | "reminder";

const PROFILE_TYPE_TO_CANONICAL: Record<string, CanonicalEntityType> = {
  self: "person",
  person: "person",
  pet: "pet",
  vehicle: "asset",
  property: "asset",
  asset: "asset",
  investment: "asset",
  account: "account",
  loan: "liability",
  liability: "liability",
  subscription: "subscription",
  medical: "health_record",
  insurance: "liability",
};

/**
 * The canonical entity type of a PROFILE row. A profile's stored `type` is a
 * storage discriminator; this is the product meaning. An `account` is an
 * account unless its kind is a debt (credit card) — then it is a liability.
 * A `liability` whose subtype is a recurring service bill is a subscription.
 */
export function canonicalTypeOfProfile(
  p: { type?: string | null; type_key?: string | null; typeKey?: string | null; fields?: any } | null | undefined,
): CanonicalEntityType {
  if (!p) return "asset";
  const t = String(p.type || "").trim().toLowerCase();
  if (t === "account") return isDebtAccountKind(accountKindOf(p)) ? "liability" : "account";
  if (t === "liability" || t === "loan") return isRecurringBillProfile(p) ? "subscription" : "liability";
  return PROFILE_TYPE_TO_CANONICAL[t] ?? "asset";
}

/**
 * The canonical entity type of ANY record, given the source it was read from.
 * A `profile` resolves through its stored type; an `obligation` is a
 * subscription when it recurs as a service and a liability otherwise; an
 * artifact of type "note" is a note.
 */
export function canonicalEntityType(source: RecordSource | string, row?: any): CanonicalEntityType {
  switch (source) {
    case "profile": return canonicalTypeOfProfile(row);
    case "task": {
      const tags: unknown[] = Array.isArray(row?.tags) ? row.tags : [];
      return tags.some((t) => /^reminder\b|^kind:reminder$/i.test(String(t))) ? "reminder" : "task";
    }
    case "reminder": return "reminder";
    case "expense": return "expense";
    case "income": return "income";
    case "payment": return "payment";
    case "event": return "event";
    case "date_rule": return "recurring_rule";
    case "habit": return "habit";
    case "tracker": return "tracker";
    case "tracker_entry": return "health_record";
    case "document": return "document";
    case "artifact": return String(row?.type || "") === "note" ? "note" : "artifact";
    case "note": return "note";
    case "journal": return "journal_entry";
    case "obligation": {
      const kind = String(row?.kind || "");
      if (kind === "subscription") return "subscription";
      if (kind === "loan_payment") return "payment";
      return "liability";
    }
    case "memory": return "note";
    case "goal": return "task";
    default:
      return isCanonicalEntityType(source) ? source : "note";
  }
}

export function entityTypeMeta(type: CanonicalEntityType): EntityTypeMeta {
  return ENTITY_TYPE_META[type];
}

export function isPersonEntity(type: CanonicalEntityType): boolean {
  return ENTITY_TYPE_META[type].isPerson;
}

/** The search group a record belongs to — a vehicle is never under People. */
export function searchGroupFor(source: RecordSource | string, row?: any): EntityGroup {
  return ENTITY_TYPE_META[canonicalEntityType(source, row)].group;
}

/** The icon name a record renders with — a vehicle never wears the People icon. */
export function iconNameFor(source: RecordSource | string, row?: any): string {
  const type = canonicalEntityType(source, row);
  if (source === "profile") {
    const t = String(row?.type || "").toLowerCase();
    if (t === "vehicle") return "Car";
    if (t === "property") return "Home";
    if (t === "investment") return "TrendingUp";
  }
  return ENTITY_TYPE_META[type].icon;
}

// ─── Field routing ──────────────────────────────────────────────────────────

const OBLIGATION_FIELD_KEY = /^(?:due_?date|date_?due|payment_?due(?:_?date)?|amount_?due|balance_?due|total_?due|minimum_?due|fine(?:_?amount)?|penalty(?:_?amount)?|citation(?:_?number)?|ticket(?:_?number)?|violation(?:_?code|_?number)?|invoice(?:_?number)?|statement(?:_?date|_?balance)|billing_?period|late_?fee|payoff_?amount)$/i;

/**
 * A key that describes an OBLIGATION (a ticket's due date, an invoice
 * number, an amount due). It belongs on the bill, ticket or liability record
 * — never in a person's generic Info fields. A person's own dates (passport
 * expiration, date of birth) are not obligations and stay on the person.
 */
export function isObligationFieldKey(key: unknown): boolean {
  return OBLIGATION_FIELD_KEY.test(String(key ?? "").trim());
}

// ─── Natural-language classification ────────────────────────────────────────

export interface DescriptionClassification {
  /** What the phrase describes. Never "person" for an object phrase. */
  type: CanonicalEntityType;
  /** The profile `type` a create call should use, when a profile is the right record. */
  profileType: "person" | "pet" | "vehicle" | "property" | "asset" | "liability" | "subscription" | "account" | null;
  confidence: "high" | "medium" | "low";
  /** Cleaned short name for the record ("Tires"). */
  name: string;
  /** True when the phrase names a part/accessory of something else. */
  isComponent: boolean;
  /** The thing a component belongs to ("Dodge Ram"), when the phrase says so. */
  associatedEntityName: string | null;
  reason: string;
}

const COMPONENT_WORDS = /\b(tires?|tyres?|wheels?|brakes?|battery|batteries|bumper|windshield|engine|transmission|oil change|filter|roof|furnace|water heater|hvac|fence|deck|garage door|charger|case|keyboard|mouse|screen|lens|strap|band)\b/i;
const VEHICLE_WORDS = /\b(car|truck|suv|van|sedan|pickup|motorcycle|boat|trailer|rv|camper|jeep|dodge|ram|ford|chevy|chevrolet|gmc|toyota|honda|nissan|subaru|mazda|hyundai|kia|tesla|bmw|audi|mercedes|lexus|volvo|volkswagen|porsche|f-?\d{3}|silverado|tacoma|tundra|civic|accord|camry|corolla|mustang|wrangler|4runner)\b/i;
const PROPERTY_WORDS = /\b(house|home|condo|apartment|cabin|property|land|lot|rental|duplex)\b/i;
const LIABILITY_WORDS = /\b(loan|mortgage|financ\w*|debt|credit card|line of credit|heloc|balance owed|owe)\b/i;
const PAYMENT_WORDS = /\b(payment|paid|pay|installment|instalment)\b/i;
const SUBSCRIPTION_WORDS = /\b(subscription|netflix|spotify|hulu|membership|plan|streaming)\b/i;
const ACCOUNT_WORDS = /\b(checking|savings|brokerage|401k|ira|bank account|account)\b/i;
const PET_WORDS = /\b(dog|cat|puppy|kitten|pet|bird|hamster|rabbit|fish|reptile|horse)\b/i;
const EXPENSE_WORDS = /\b(bought|spent|purchase|receipt|dinner|lunch|groceries|gas station|coffee|uber|lyft)\b/i;
const OWNED_BY_RE = /\b(?:for|on|of|in|from)\s+(?:my|our|the|his|her|their)\s+(.+?)\s*$/i;

function titleCase(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Classify a free-text description into a canonical entity type.
 *
 *   "tires for my Dodge Ram"  → asset, component of "Dodge Ram", never a person
 *   "Auto loan payment $912"  → payment
 *   "Netflix"                 → subscription
 *   "Dana"                    → person (medium — a bare name is all we have)
 *
 * Ownership/association is derived structurally ("for my X" → X); a person is
 * only ever the answer when nothing about the phrase says "thing".
 */
export function classifyEntityDescription(input: unknown): DescriptionClassification {
  const raw = String(input ?? "").replace(/\s+/g, " ").trim();
  const lc = raw.toLowerCase();
  const base = (partial: Partial<DescriptionClassification>): DescriptionClassification => ({
    type: "asset", profileType: "asset", confidence: "low", name: titleCase(raw), isComponent: false,
    associatedEntityName: null, reason: "", ...partial,
  });
  if (!raw) return base({ type: "note", profileType: null, name: "", reason: "empty" });

  const owned = OWNED_BY_RE.exec(raw);
  const associated = owned ? titleCase(owned[1]) : null;
  const head = owned ? raw.slice(0, owned.index).replace(/^(?:my|our|the|a|an|new|old|some)\s+/i, "").trim() : raw;
  const isComponent = COMPONENT_WORDS.test(head) && (!!associated || VEHICLE_WORDS.test(lc) || PROPERTY_WORDS.test(lc));

  if (isComponent) {
    return base({
      type: "asset", profileType: "asset", confidence: "high", name: titleCase(head),
      isComponent: true, associatedEntityName: associated, reason: "component of an owned thing",
    });
  }
  if (PAYMENT_WORDS.test(lc) && (LIABILITY_WORDS.test(lc) || /\$\s?\d/.test(lc))) {
    return base({ type: "payment", profileType: null, confidence: "high", associatedEntityName: associated, reason: "payment against an obligation" });
  }
  if (LIABILITY_WORDS.test(lc)) {
    return base({ type: "liability", profileType: "liability", confidence: "high", associatedEntityName: associated, reason: "debt vocabulary" });
  }
  if (SUBSCRIPTION_WORDS.test(lc)) {
    return base({ type: "subscription", profileType: "subscription", confidence: "high", reason: "subscription vocabulary" });
  }
  if (ACCOUNT_WORDS.test(lc)) {
    return base({ type: "account", profileType: "account", confidence: "medium", reason: "account vocabulary" });
  }
  if (VEHICLE_WORDS.test(lc)) {
    return base({ type: "asset", profileType: "vehicle", confidence: "high", associatedEntityName: associated, reason: "vehicle vocabulary" });
  }
  if (PROPERTY_WORDS.test(lc)) {
    return base({ type: "asset", profileType: "property", confidence: "high", associatedEntityName: associated, reason: "property vocabulary" });
  }
  if (EXPENSE_WORDS.test(lc) || /\$\s?\d/.test(lc)) {
    return base({ type: "expense", profileType: null, confidence: "medium", reason: "spending vocabulary" });
  }
  if (PET_WORDS.test(lc) && raw.split(" ").length <= 4) {
    return base({ type: "pet", profileType: "pet", confidence: "medium", reason: "pet vocabulary" });
  }
  if (looksLikeObjectPhrase(raw) || looksLikeAssetName(raw)) {
    const pt = suggestObjectProfileType(raw);
    return base({
      type: pt === "liability" ? "liability" : pt === "subscription" ? "subscription" : "asset",
      profileType: pt, confidence: "medium", associatedEntityName: associated, reason: "object-shaped phrase",
    });
  }
  // A short capitalised phrase with no object vocabulary is the only shape a
  // person's name takes.
  return base({ type: "person", profileType: "person", confidence: raw.split(" ").length <= 3 ? "medium" : "low", reason: "bare name" });
}

/**
 * The profile `type` a create call must use. Explicit non-person types are
 * kept; a person/pet request survives only when the name can be a person's;
 * an unknown type resolves through classification — and NEVER to "person" as
 * a fallback. This is what every profile-create door calls.
 */
export function resolveProfileTypeForCreate(name: unknown, requested: unknown): string {
  const type = String(requested ?? "").trim().toLowerCase();
  const KNOWN = new Set(["self", "person", "pet", "vehicle", "asset", "subscription", "loan", "liability", "investment", "property", "account", "insurance", "medical"]);
  const personish = type === "person" || type === "self" || type === "pet";
  if (KNOWN.has(type) && !personish) return type;
  const c = classifyEntityDescription(name);
  if (personish) {
    if (c.type === "person" || (type === "pet" && c.type === "pet")) return type;
    return c.profileType && c.profileType !== "person" && c.profileType !== "pet" ? c.profileType : "asset";
  }
  // Unknown or absent type: a thing, never a person.
  if (c.profileType && c.profileType !== "person" && c.profileType !== "pet") return c.profileType;
  return c.type === "pet" ? "pet" : "asset";
}
