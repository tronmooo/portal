// Structural guard for the AI-write → UI synchronization pipeline.
//
// WHY THIS EXISTS: the recurring "the AI said it saved it but the page doesn't
// show it until I refresh" bug had one structural cause — nothing connected
// what the SERVER wrote to the cache keys the CLIENT reads. shared/entity-domains.ts
// is that connection. A tool added without a mapping silently falls back to
// blanket invalidation (safe but slow), and a mapping that names a domain the
// cache bus doesn't know would invalidate NOTHING (not safe at all).
//
// These tests pin both halves so the wiring can't rot.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  ENTITY_DOMAINS,
  ENTITY_ENDPOINT,
  ACTION_TYPE_DOMAINS,
  READ_ONLY_ACTION_TYPES,
  domainsForEntity,
  domainsForActionTypes,
  endpointForEntity,
  type Domain,
} from "@shared/entity-domains";
import { mappedToolNames, entityTypeForTool } from "../server/ai-envelope";

/** The domains the client bus can actually expand, read from its source. */
function busDomains(): Set<string> {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../client/src/lib/cache-bus.ts"),
    "utf8",
  );
  const body = src.slice(
    src.indexOf("const DOMAIN_KEYS"),
    src.indexOf("// ─── Nested key predicates"),
  );
  const found = new Set<string>();
  for (const m of body.matchAll(/^\s{2}(\w+):\s*\[/gm)) found.add(m[1]);
  return found;
}

describe("entity → domain vocabulary", () => {
  it("every entity type maps to at least one domain and a defined endpoint", () => {
    for (const [entity, domains] of Object.entries(ENTITY_DOMAINS)) {
      expect(domains.length, `${entity} has no domains`).toBeGreaterThan(0);
      // null is a legitimate answer ("no patchable list"), undefined is a gap.
      expect(ENTITY_ENDPOINT[entity as keyof typeof ENTITY_ENDPOINT], `${entity} missing endpoint entry`).toBeDefined();
    }
  });

  it("every domain named here is one the cache bus can expand", () => {
    const known = busDomains();
    // "everything" is handled by predicate rather than a DOMAIN_KEYS list.
    known.add("everything");
    for (const [entity, domains] of Object.entries(ENTITY_DOMAINS)) {
      for (const d of domains) {
        expect(known.has(d), `${entity} → unknown domain "${d}"`).toBe(true);
      }
    }
  });

  it("every patchable endpoint is an /api path", () => {
    for (const endpoint of Object.values(ENTITY_ENDPOINT)) {
      if (endpoint === null) continue;
      expect(endpoint.startsWith("/api/")).toBe(true);
    }
  });
});

describe("tool → entity coverage", () => {
  it("every mapped AI tool resolves to real domains and a known endpoint slot", () => {
    const unmapped: string[] = [];
    for (const tool of mappedToolNames()) {
      const entity = entityTypeForTool(tool);
      const domains = domainsForEntity(entity);
      // A mapped tool must never degrade to the nuclear fallback — that would
      // mean its entity type isn't in ENTITY_DOMAINS.
      if (domains.length === 1 && domains[0] === "everything") unmapped.push(tool);
      // endpointForEntity may legitimately be null (tracker entries).
      expect(endpointForEntity(entity)).not.toBeUndefined();
    }
    expect(unmapped, `tools falling back to "everything": ${unmapped.join(", ")}`).toEqual([]);
  });

  it("an unknown tool degrades to the safe blanket fallback", () => {
    const domains: Domain[] = domainsForEntity("not_a_real_entity");
    expect(domains).toEqual(["everything"]);
    expect(endpointForEntity("not_a_real_entity")).toBeNull();
  });
});

describe("action-type fallback — writes outside the tool loop still name their domains", () => {
  it("every action-type mapping names domains the bus can expand", () => {
    const known = busDomains();
    known.add("everything");
    for (const [type, domains] of Object.entries(ACTION_TYPE_DOMAINS)) {
      expect(domains.length, `${type} has no domains`).toBeGreaterThan(0);
      for (const d of domains) {
        expect(known.has(d), `${type} → unknown domain "${d}"`).toBe(true);
      }
    }
  });

  it("read-only action types trigger no invalidation at all", () => {
    expect(domainsForActionTypes([...READ_ONLY_ACTION_TYPES])).toEqual([]);
  });

  it("a write with no mapping degrades to the blanket refresh, never to nothing", () => {
    expect(domainsForActionTypes(["some_future_write"])).toEqual(["everything"]);
    // ...even when it is mixed in with types we DO understand.
    expect(domainsForActionTypes(["create_task", "some_future_write"])).toEqual(["everything"]);
  });

  it("unions the domains of a multi-action turn", () => {
    const domains = domainsForActionTypes(["create_task", "log_expense", "retrieve"]);
    expect(domains).toContain("tasks");
    expect(domains).toContain("expenses");
    expect(domains).not.toContain("everything");
  });

  it("every ParsedAction write type in the schema has a mapping", () => {
    // Read the union straight from shared/schema.ts so a new action type added
    // there fails here instead of silently costing users a full cache refresh.
    const schema = fs.readFileSync(path.resolve(__dirname, "../shared/schema.ts"), "utf8");
    const block = schema.slice(
      schema.indexOf("export interface ParsedAction"),
      schema.indexOf("  category: string;", schema.indexOf("export interface ParsedAction")),
    );
    const types = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(types.length).toBeGreaterThan(20); // sanity: we actually parsed the union
    const missing = types.filter(
      (t) => !READ_ONLY_ACTION_TYPES.has(t) && !ACTION_TYPE_DOMAINS[t],
    );
    // These are deliberately unmapped: they touch too many domains to name.
    const INTENTIONALLY_BLANKET = ["update_entity", "delete_entity", "link_entities", "manage_domain"];
    expect(missing.filter((t) => !INTENTIONALLY_BLANKET.includes(t))).toEqual([]);
  });
});
