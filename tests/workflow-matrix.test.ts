// The workflow inventory stays complete (owner, 2026-11-24: "list every single
// workflow … make sure every one of those works"). docs/WORKFLOW_MATRIX.md is
// generated from the code by scripts/gen-workflow-matrix.ts; this suite fails
// when a door into the app is added without being placed in the inventory.
import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "../server/ai-engine";
import {
  DOMAINS, apiRefs, buildInventory, domainOfRoute, domainOfTool, extractApiRoutes, extractScreens, matchPattern,
} from "../scripts/workflow-inventory";

const toolNames: string[] = TOOL_DEFINITIONS.map((t: any) => t.name);

describe("workflow inventory", () => {
  const routes = extractApiRoutes();

  it("reads the server's routes, the chat tools and the screens", () => {
    // A regex that silently stops matching would report "no gaps" for an
    // empty list, so the reading itself is pinned to routes known to exist.
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(keys).toContain("POST /api/tasks/:id/occurrence");
    expect(keys).toContain("POST /api/finance/webhook"); // path on the line after app.post(
    expect(keys).toContain("POST /api/workspace/journal/reflect"); // registered from a constant
    expect(keys).toContain("GET /api/details/report"); // a route file other than routes.ts
    expect(routes.length).toBeGreaterThan(300);
    expect(toolNames.length).toBeGreaterThan(140);
    expect(extractScreens().map((s) => s.path)).toContain("/workspace/fill");
  });

  it("every API route belongs to a domain", () => {
    const unplaced = routes.filter((r) => !domainOfRoute(r.path)).map((r) => `${r.method} ${r.path}`);
    expect(unplaced, "add the first path segment to SEGMENT_DOMAIN in scripts/workflow-inventory.ts").toEqual([]);
  });

  it("every chat tool belongs to a domain", () => {
    const unplaced = toolNames.filter((n) => !domainOfTool(n));
    expect(unplaced, "add a rule to TOOL_DOMAIN_RULES in scripts/workflow-inventory.ts").toEqual([]);
  });

  it("a reference means the most specific route, with the method named beside it", () => {
    const pick = (p: string, m: string) => matchPattern(p, routes.filter((r) => r.method === m))?.path;
    expect(pick("/api/tasks/${task.id}/occurrence", "POST")).toBe("/api/tasks/:id/occurrence");
    expect(pick("/api/details/report", "GET")).toBe("/api/details/report"); // not /:entityType/:entityId
    expect(pick("/api/no-such-thing", "GET")).toBeUndefined();

    expect(apiRefs('await api("POST", `/api/tasks/${id}/occurrence`, body)')).toEqual([
      { path: "/api/tasks/${id}/occurrence", method: "POST" },
    ]);
    expect(apiRefs('queryKey: ["/api/tasks"]')).toEqual([{ path: "/api/tasks", method: null }]);
    // The live checks call through a base that already ends in /api.
    expect(apiRefs('await post("/autopay/run");', { bare: true })).toEqual([{ path: "/api/autopay/run", method: "POST" }]);
    // … and a bare path with no method beside it is a screen, not a call.
    expect(apiRefs('await page.goto("/tasks");', { bare: true })).toEqual([]);
  });

  it("builds a matrix that finds the tests which are there", () => {
    const inv = buildInventory(toolNames);
    const row = (key: string) => {
      const r = inv.routes.find((x) => `${x.method} ${x.path}` === key);
      if (!r) throw new Error(`no row for ${key}`);
      return r;
    };
    // Known-covered doors: a route test, a live check, a screen that calls it.
    expect(row("POST /api/tasks/:id/occurrence").tests.local.length).toBeGreaterThan(0);
    expect(row("POST /api/autopay/run").tests.live.length).toBeGreaterThan(0);
    expect(row("POST /api/notes").ui.length).toBeGreaterThan(0);
    expect(new Set(inv.routes.map((r) => r.domain)).size).toBeGreaterThan(15);
    for (const r of inv.routes) expect(DOMAINS).toContain(r.domain);
    const pay = inv.tools.find((t) => t.name === "add_liability_payment");
    expect(pay?.write).toBe(true);
    expect(pay?.tests.local.length).toBeGreaterThan(0);
  });
});
