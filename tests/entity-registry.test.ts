// Rule 39 (2026-09-22): ONE registry describes every entity type, composed
// from the facet modules that already existed. This test is the drift guard
// between them.
import { describe, it, expect } from "vitest";
import { ENTITY_REGISTRY, getEntityDefinition, entityDisplayName } from "../shared/entity-registry";
import { routeForEntity, listRouteForEntity, ROUTABLE_ENTITY_TYPES, normalizeEntityType } from "../shared/entity-routes";
import { ENTITY_DOMAINS, ENTITY_ENDPOINT, type EntityType } from "../shared/entity-domains";
import { OWNERSHIP_TABLES } from "../shared/ownership";
import { SEARCH_FIELDS } from "../shared/search-match";
import { ICON_VOCABULARY } from "../shared/icon-vocabulary";
import { SOFT_DELETE_TYPES } from "../server/ai-envelope";

// server/routes.ts KNOWN_ENTITY_TYPES (module-private; duplicated here on purpose
// so a new entry there must be routable, or this test names it).
const KNOWN_ENTITY_TYPES = [
  "expense", "task", "document", "event", "tracker", "habit", "goal", "obligation",
  "artifact", "profile", "journal", "domain", "memory",
];

const ENTITY_DOMAIN_TYPES = Object.keys(ENTITY_DOMAINS) as EntityType[];

describe("ENTITY_REGISTRY — coverage", () => {
  it("has exactly one entry per routable type", () => {
    expect(Object.keys(ENTITY_REGISTRY).sort()).toEqual([...ROUTABLE_ENTITY_TYPES].sort());
    for (const t of ROUTABLE_ENTITY_TYPES) expect(ENTITY_REGISTRY[t].type).toBe(t);
  });

  it("every shared/entity-domains EntityType with a route exists in the registry", () => {
    for (const t of ENTITY_DOMAIN_TYPES) {
      const def = getEntityDefinition(t);
      expect(def, t).not.toBeNull();
      // The registry's cache domains ARE entity-domains' (composed, not retyped).
      expect(def!.cacheDomains, t).toEqual(ENTITY_DOMAINS[t]);
      expect(def!.endpoint, t).toBe(ENTITY_ENDPOINT[t]);
    }
  });

  it("every KNOWN_ENTITY_TYPES entry (server/routes.ts) maps to a registry type", () => {
    for (const t of KNOWN_ENTITY_TYPES) {
      const def = getEntityDefinition(t);
      expect(def, t).not.toBeNull();
      expect(normalizeEntityType(t), t).toBe(def!.type);
    }
  });

  it("every shared/ownership table maps to a registry entry with that table", () => {
    for (const [key, spec] of Object.entries(OWNERSHIP_TABLES)) {
      const def = getEntityDefinition(key);
      expect(def, key).not.toBeNull();
      expect(def!.table, key).toBe(spec.entityTable);
      expect(def!.ownerModel, key).toBe(spec.junctionTable ? "junction" : "linked_profiles");
    }
  });
});

describe("ENTITY_REGISTRY — every entry is complete and consistent", () => {
  for (const t of ROUTABLE_ENTITY_TYPES) {
    const def = ENTITY_REGISTRY[t];
    it(`${t}: names, icon concept, route, deletion`, () => {
      expect(def.displayName.trim().length).toBeGreaterThan(0);
      expect(def.pluralName.trim().length).toBeGreaterThan(0);
      expect(def.iconConcept in ICON_VOCABULARY, `${t} icon concept "${def.iconConcept}" is in the vocabulary`).toBe(true);
      expect(def.canonicalRoute("id-1")).toBe(routeForEntity(t, "id-1"));
      expect(def.canonicalRoute()).toBe(routeForEntity(t));
      expect(def.canonicalRoute("id-1", { hash: true })).toBe(routeForEntity(t, "id-1", { hash: true }));
      expect(def.listRoute).toBe(listRouteForEntity(t));
      expect(["soft", "hard", "cascade"]).toContain(def.deletion);
      expect(["linked_profiles", "parent_profile", "none", "junction"]).toContain(def.ownerModel);
      expect(Array.isArray(def.duplicateStrategy) && def.duplicateStrategy.length > 0, "duplicate strategy").toBe(true);
      expect(def.cacheDomains.length).toBeGreaterThan(0);
      if (def.parentType) expect(ROUTABLE_ENTITY_TYPES).toContain(def.parentType);
      if (def.calendar.participates) expect(def.calendar.dateFields.length, "calendar date fields").toBeGreaterThan(0);
      if (def.finance.includedInTotals) expect(def.finance.ledgerSide).not.toBe("none");
    });
  }

  it("searchable fields are search-match's own, for every searchable type", () => {
    for (const [key, fields] of Object.entries(SEARCH_FIELDS)) {
      const def = getEntityDefinition(key);
      expect(def, key).not.toBeNull();
      expect(def!.searchableFields, key).toEqual([...fields]);
    }
    expect(ENTITY_REGISTRY.income.searchableFields.length).toBeGreaterThan(0);
    expect(ENTITY_REGISTRY.goal.searchableFields.length).toBeGreaterThan(0);
  });

  it("soft deletion mirrors server/ai-envelope SOFT_DELETE_TYPES exactly", () => {
    for (const t of ROUTABLE_ENTITY_TYPES) {
      const promised = SOFT_DELETE_TYPES.has(t);
      expect(ENTITY_REGISTRY[t].deletion === "soft", `${t} soft?`).toBe(promised);
    }
    for (const t of SOFT_DELETE_TYPES) expect(getEntityDefinition(t)?.deletion, t).toBe("soft");
  });

  it("owner-required types have an ownership model", () => {
    for (const t of ROUTABLE_ENTITY_TYPES) {
      if (ENTITY_REGISTRY[t].ownerRequired) expect(ENTITY_REGISTRY[t].ownerModel, t).not.toBe("none");
    }
  });

  it("children name their parent field", () => {
    expect(ENTITY_REGISTRY.trackerEntry).toMatchObject({ parentType: "tracker", childOf: "trackerId" });
    expect(ENTITY_REGISTRY.paycheck).toMatchObject({ parentType: "income" });
    expect(ENTITY_REGISTRY.asset).toMatchObject({ parentType: "person", childOf: "parentProfileId" });
  });
});

describe("getEntityDefinition / entityDisplayName", () => {
  it("resolves aliases and returns null for unknown types", () => {
    expect(getEntityDefinition("bill")?.type).toBe("obligation");
    expect(getEntityDefinition("journal_entry")?.type).toBe("journal");
    expect(getEntityDefinition("domain")?.type).toBe("asset");
    expect(getEntityDefinition("wormhole")).toBeNull();
    expect(entityDisplayName("obligation")).toBe("Bill");
    expect(entityDisplayName("obligation", true)).toBe("Bills");
    expect(entityDisplayName("wormhole")).toBe("wormhole");
  });
});
