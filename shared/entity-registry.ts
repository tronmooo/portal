// shared/entity-registry.ts — ONE place that describes every entity type.
//
// Rule 39 (2026-09-22). The app already knew most of this, in pieces:
//   · shared/entity-domains     — cache domains + list endpoint
//   · shared/ownership          — which table holds the row, how it is owned
//   · shared/search-match       — which fields search reads
//   · shared/entity-routes      — where a record lives (Rules 23/24)
//   · shared/icon-vocabulary    — the concept → icon contract
//   · server/ai-envelope        — which deletes are soft (SOFT_DELETE_TYPES)
// They disagreed on the type list, and nothing said, for a given type, "is it
// on the calendar? does it count in finance? what makes two rows duplicates?"
//
// This module COMPOSES those facets rather than re-typing them: the domains,
// endpoint, table and searchable fields are read from their owning modules,
// so a change there shows up here and tests/entity-registry.test.ts catches
// any drift between the facets. Consumers are not rewired to it wholesale —
// the deliverable is one description per type, pinned by tests.
//
// Pure: shared/ only. `deletion` mirrors server/ai-envelope SOFT_DELETE_TYPES
// (asserted equal by the test, since the server module cannot be imported
// here).

import { ENTITY_DOMAINS, ENTITY_ENDPOINT, isEntityType, type Domain } from "./entity-domains";
import { OWNERSHIP_TABLES, type OwnedEntityType } from "./ownership";
import { SEARCH_FIELDS } from "./search-match";
import {
  routeForEntity, listRouteForEntity, ROUTABLE_ENTITY_TYPES, normalizeEntityType,
  type RoutableEntityType, type RouteContext,
} from "./entity-routes";
import type { ConceptIcon } from "./icon-vocabulary";

export type OwnerModel = "linked_profiles" | "parent_profile" | "none" | "junction";
export type LedgerSide = "expense" | "income" | "liability" | "asset" | "none";
export type DeletionBehavior = "soft" | "hard" | "cascade";

export interface EntityDefinition {
  type: RoutableEntityType;
  displayName: string;
  pluralName: string;
  /** Concept from shared/icon-vocabulary — the client resolves it via conceptIcon(). */
  iconConcept: ConceptIcon;
  /** True when a row must always resolve to at least one owner (default: Self). */
  ownerRequired: boolean;
  ownerModel: OwnerModel;
  /** The type this record hangs off, if any (a tracker entry → its tracker). */
  parentType: RoutableEntityType | null;
  /** The field on the row that names the parent. */
  childOf?: string;
  canonicalRoute: (id?: string | number | null, ctx?: RouteContext) => string;
  listRoute: string;
  /** Fields that, matching together, make two rows the same record. */
  duplicateStrategy: string[];
  searchableFields: string[];
  calendar: { participates: boolean; dateFields: string[] };
  finance: { includedInTotals: boolean; ledgerSide: LedgerSide };
  deletion: DeletionBehavior;
  cacheDomains: Domain[];
  endpoint: string | null;
  /** Postgres table (from shared/ownership) when the type has its own. */
  table: string | null;
}

/** The entity-domains vocabulary name for a routable type, when it has one. */
const DOMAIN_KEY: Partial<Record<RoutableEntityType, string>> = {
  person: "profile", profile: "profile", asset: "profile", liability: "profile", account: "profile",
  expense: "expense", income: "income", paycheck: "paycheck", document: "document",
  tracker: "tracker", trackerEntry: "trackerEntry", habit: "habit", task: "task",
  event: "event", obligation: "obligation", goal: "goal", journal: "journal",
  artifact: "artifact", note: "artifact", memory: "memory",
};

/** The shared/ownership table key for a routable type, when it has one. */
const OWNERSHIP_KEY: Partial<Record<RoutableEntityType, OwnedEntityType>> = {
  expense: "expense", tracker: "tracker", task: "task", event: "event",
  obligation: "obligation", habit: "habit", goal: "goal", artifact: "artifact",
  note: "artifact", document: "document", income: "income", journal: "journal_entry",
};

/** The shared/search-match key for a routable type. */
const SEARCH_KEY: Partial<Record<RoutableEntityType, string>> = {
  person: "profile", profile: "profile", asset: "profile", liability: "profile", account: "profile",
  tracker: "tracker", task: "task", expense: "expense", habit: "habit", obligation: "obligation",
  artifact: "artifact", note: "artifact", journal: "journal", memory: "memory", event: "event",
  document: "document", income: "income", goal: "goal",
};

/**
 * Mirror of server/ai-envelope SOFT_DELETE_TYPES — the set is a PROMISE shown
 * to the user ("recoverable delete"). tests/entity-registry.test.ts asserts
 * the two agree, so this cannot drift silently.
 */
const SOFT_DELETED = new Set<RoutableEntityType>(["task", "habit", "expense", "income", "event", "document", "goal"]);

function domainsOf(type: RoutableEntityType): Domain[] {
  const key = DOMAIN_KEY[type];
  return key && isEntityType(key) ? [...ENTITY_DOMAINS[key]] : ["everything"];
}
function endpointOf(type: RoutableEntityType): string | null {
  const key = DOMAIN_KEY[type];
  return key && isEntityType(key) ? ENTITY_ENDPOINT[key] : null;
}
function tableOf(type: RoutableEntityType): string | null {
  const key = OWNERSHIP_KEY[type];
  return key ? OWNERSHIP_TABLES[key].entityTable : type === "memory" ? "memories" : type === "budget" ? "budgets" : (DOMAIN_KEY[type] === "profile" ? "profiles" : null);
}
function ownerModelOf(type: RoutableEntityType): OwnerModel {
  const key = OWNERSHIP_KEY[type];
  if (key) return OWNERSHIP_TABLES[key].junctionTable ? "junction" : "linked_profiles";
  if (type === "asset" || type === "liability" || type === "account") return "parent_profile";
  // A paycheck is owned through the income series it belongs to.
  if (type === "paycheck") return "parent_profile";
  return "none";
}
function searchFieldsOf(type: RoutableEntityType): string[] {
  const key = SEARCH_KEY[type];
  return key ? [...(SEARCH_FIELDS[key] || [])] : [];
}

interface Facets {
  displayName: string;
  pluralName: string;
  iconConcept: ConceptIcon;
  ownerRequired: boolean;
  parentType?: RoutableEntityType | null;
  childOf?: string;
  duplicateStrategy: string[];
  calendar: EntityDefinition["calendar"];
  finance: EntityDefinition["finance"];
  deletion?: DeletionBehavior;
}

const NO_CAL = { participates: false, dateFields: [] as string[] };
const NO_FIN = { includedInTotals: false, ledgerSide: "none" as const };

// The facts no other module holds: names, icon concept, ownership rule,
// parent, duplicate key, calendar and finance participation.
const FACETS: Record<RoutableEntityType, Facets> = {
  person:       { displayName: "Person", pluralName: "People", iconConcept: "people", ownerRequired: false,
                  duplicateStrategy: ["name", "type"], calendar: { participates: true, dateFields: ["fields.birthday", "fields.anniversary"] }, finance: NO_FIN, deletion: "cascade" },
  profile:      { displayName: "Profile", pluralName: "Profiles", iconConcept: "people", ownerRequired: false,
                  duplicateStrategy: ["name", "type"], calendar: { participates: true, dateFields: ["fields.*Date", "fields.*Expiration"] }, finance: NO_FIN, deletion: "cascade" },
  asset:        { displayName: "Asset", pluralName: "Assets", iconConcept: "assets", ownerRequired: true, parentType: "person", childOf: "parentProfileId",
                  duplicateStrategy: ["name", "type", "parentProfileId"], calendar: { participates: true, dateFields: ["fields.registrationExpiration", "fields.insuranceRenewal", "fields.warrantyExpiration"] },
                  finance: { includedInTotals: true, ledgerSide: "asset" }, deletion: "cascade" },
  liability:    { displayName: "Liability", pluralName: "Liabilities", iconConcept: "liabilities", ownerRequired: true, parentType: "person", childOf: "parentProfileId",
                  duplicateStrategy: ["name", "type", "parentProfileId"], calendar: { participates: true, dateFields: ["fields.nextDueDate", "fields.dueDay"] },
                  finance: { includedInTotals: true, ledgerSide: "liability" }, deletion: "cascade" },
  account:      { displayName: "Account", pluralName: "Accounts", iconConcept: "finance", ownerRequired: true, parentType: "person", childOf: "parentProfileId",
                  duplicateStrategy: ["name", "fields.institution", "fields.last4"], calendar: NO_CAL,
                  finance: { includedInTotals: true, ledgerSide: "asset" }, deletion: "cascade" },
  expense:      { displayName: "Expense", pluralName: "Expenses", iconConcept: "finance", ownerRequired: true,
                  duplicateStrategy: ["description", "amount", "date"], calendar: NO_CAL, finance: { includedInTotals: true, ledgerSide: "expense" } },
  income:       { displayName: "Income", pluralName: "Income sources", iconConcept: "finance", ownerRequired: true,
                  duplicateStrategy: ["description", "amount", "frequency"], calendar: { participates: true, dateFields: ["date"] }, finance: { includedInTotals: true, ledgerSide: "income" } },
  paycheck:     { displayName: "Paycheck", pluralName: "Paychecks", iconConcept: "finance", ownerRequired: true, parentType: "income", childOf: "incomeId",
                  duplicateStrategy: ["source", "amount", "date"], calendar: NO_CAL, finance: { includedInTotals: true, ledgerSide: "income" }, deletion: "hard" },
  document:     { displayName: "Document", pluralName: "Documents", iconConcept: "documents", ownerRequired: true,
                  duplicateStrategy: ["name", "fileHash"], calendar: { participates: true, dateFields: ["expirationDate", "extractedFields.*Date"] }, finance: NO_FIN },
  tracker:      { displayName: "Tracker", pluralName: "Trackers", iconConcept: "trackers", ownerRequired: true,
                  duplicateStrategy: ["name", "linkedProfiles"], calendar: NO_CAL, finance: NO_FIN, deletion: "cascade" },
  trackerEntry: { displayName: "Tracker entry", pluralName: "Tracker entries", iconConcept: "trackers", ownerRequired: false, parentType: "tracker", childOf: "trackerId",
                  duplicateStrategy: ["trackerId", "timestamp", "values"], calendar: NO_CAL, finance: NO_FIN, deletion: "hard" },
  habit:        { displayName: "Habit", pluralName: "Habits", iconConcept: "habits", ownerRequired: true,
                  duplicateStrategy: ["name", "linkedProfiles"], calendar: { participates: true, dateFields: ["schedule"] }, finance: NO_FIN },
  task:         { displayName: "Task", pluralName: "Tasks", iconConcept: "tasks", ownerRequired: true,
                  duplicateStrategy: ["title", "dueDate"], calendar: { participates: true, dateFields: ["dueDate", "dueTime"] }, finance: NO_FIN },
  event:        { displayName: "Event", pluralName: "Events", iconConcept: "dates", ownerRequired: true,
                  duplicateStrategy: ["title", "date", "time"], calendar: { participates: true, dateFields: ["date", "time", "endTime"] }, finance: NO_FIN },
  obligation:   { displayName: "Bill", pluralName: "Bills", iconConcept: "liabilities", ownerRequired: true, parentType: "liability", childOf: "linkedLiabilityId",
                  duplicateStrategy: ["name", "amount", "frequency"], calendar: { participates: true, dateFields: ["nextDueDate", "dueDate"] }, finance: { includedInTotals: true, ledgerSide: "expense" }, deletion: "hard" },
  goal:         { displayName: "Goal", pluralName: "Goals", iconConcept: "goals", ownerRequired: true,
                  duplicateStrategy: ["title", "type"], calendar: { participates: true, dateFields: ["deadline"] }, finance: NO_FIN },
  journal:      { displayName: "Journal entry", pluralName: "Journal entries", iconConcept: "journal", ownerRequired: true,
                  duplicateStrategy: ["content", "createdAt"], calendar: NO_CAL, finance: NO_FIN, deletion: "hard" },
  artifact:     { displayName: "Artifact", pluralName: "Artifacts", iconConcept: "documents", ownerRequired: true,
                  duplicateStrategy: ["title", "type"], calendar: NO_CAL, finance: NO_FIN, deletion: "hard" },
  note:         { displayName: "Note", pluralName: "Notes", iconConcept: "documents", ownerRequired: true,
                  duplicateStrategy: ["title"], calendar: NO_CAL, finance: NO_FIN, deletion: "hard" },
  memory:       { displayName: "Memory", pluralName: "Memories", iconConcept: "insights", ownerRequired: false,
                  duplicateStrategy: ["key"], calendar: NO_CAL, finance: NO_FIN, deletion: "hard" },
  budget:       { displayName: "Budget", pluralName: "Budgets", iconConcept: "finance", ownerRequired: false,
                  duplicateStrategy: ["category", "month"], calendar: NO_CAL, finance: { includedInTotals: false, ledgerSide: "expense" }, deletion: "hard" },
};

function define(type: RoutableEntityType): EntityDefinition {
  const f = FACETS[type];
  return {
    type,
    displayName: f.displayName,
    pluralName: f.pluralName,
    iconConcept: f.iconConcept,
    ownerRequired: f.ownerRequired,
    ownerModel: ownerModelOf(type),
    parentType: f.parentType ?? null,
    ...(f.childOf ? { childOf: f.childOf } : {}),
    canonicalRoute: (id, ctx) => routeForEntity(type, id, ctx),
    listRoute: listRouteForEntity(type),
    duplicateStrategy: [...f.duplicateStrategy],
    searchableFields: searchFieldsOf(type),
    calendar: { participates: f.calendar.participates, dateFields: [...f.calendar.dateFields] },
    finance: { ...f.finance },
    deletion: f.deletion ?? (SOFT_DELETED.has(type) ? "soft" : "hard"),
    cacheDomains: domainsOf(type),
    endpoint: endpointOf(type),
    table: tableOf(type),
  };
}

export const ENTITY_REGISTRY: Record<RoutableEntityType, EntityDefinition> = Object.fromEntries(
  ROUTABLE_ENTITY_TYPES.map((t) => [t, define(t)]),
) as Record<RoutableEntityType, EntityDefinition>;

/** The definition for a type or any of its aliases (`_type`, SourceSystem, notification type…). */
export function getEntityDefinition(type: RoutableEntityType | string): EntityDefinition | null {
  const t = normalizeEntityType(type);
  return t ? ENTITY_REGISTRY[t] : null;
}

/** Display name for a type, falling back to the raw string. */
export function entityDisplayName(type: string, plural = false): string {
  const def = getEntityDefinition(type);
  if (!def) return type;
  return plural ? def.pluralName : def.displayName;
}
